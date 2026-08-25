import { settings, affectsText } from '../core/settings.js';
import { docs, audio as audioStore, usage, wipe } from '../core/db.js';
import { importFile, importPasted, importUrl, reextractWithOcr } from '../core/ingest.js';
import { availableEngines, activeEngine, setActiveEngine } from '../tts/manager.js';
import { player } from '../core/player.js';
import { APP_VERSION } from '../config.js';
import { toast, withBusy, busyUpdate } from './toast.js';

/* All four sheets: import, settings, document menu, outline. */

export function initDialogs({ refreshLibrary, openDoc, getCurrent, rebuildScript, deleteCurrent }) {
  const dlgImport   = document.getElementById('dlg-import');
  const dlgSettings = document.getElementById('dlg-settings');
  const dlgMenu     = document.getElementById('dlg-docmenu');
  const dlgOutline  = document.getElementById('dlg-outline');

  wireImport();
  wireSettings();
  wireDocMenu();
  wireDiag();

  return {
    openImport: () => { dlgImport.showModal(); },
    openSettings: async () => { await paintSettings(); dlgSettings.showModal(); },
    openDocMenu: () => {
      const cur = getCurrent();
      if (!cur) return;
      document.getElementById('docmenu-title').textContent = cur.doc.title;
      document.getElementById('mi-ocr').disabled = cur.doc.kind !== 'pdf' && cur.doc.kind !== 'image';
      dlgMenu.showModal();
    },
  };

  /* ════════════════════════════════════════════════════ import ═════ */

  function wireImport() {
    const tabs = dlgImport.querySelectorAll('[role="tab"]');
    tabs.forEach(t => t.onclick = () => {
      tabs.forEach(x => x.setAttribute('aria-selected', String(x === t)));
      dlgImport.querySelectorAll('.tabpanel').forEach(p => {
        p.hidden = p.dataset.panel !== t.dataset.tab;
      });
    });

    const input = document.getElementById('file-input');
    const zone = document.getElementById('dropzone');

    input.onchange = async () => {
      const list = [...input.files];
      input.value = '';
      await ingestFiles(list);
    };

    // Drag and drop, for when this is running on a desktop.
    ['dragenter', 'dragover'].forEach(ev =>
      zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev =>
      zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', e => ingestFiles([...(e.dataTransfer?.files || [])]));

    document.getElementById('btn-fetch-url').onclick = async () => {
      const url = document.getElementById('url-input').value.trim();
      if (!url) return;
      dlgImport.close();
      try {
        const doc = await withBusy('Fetching article', ({ signal, onProgress }) =>
          importUrl(url, { signal, onProgress }));
        document.getElementById('url-input').value = '';
        await refreshLibrary();
        toast(`Added “${trim(doc.title, 44)}”`);
        openDoc(doc.id);
      } catch (e) { fail(e); }
    };

    document.getElementById('btn-add-paste').onclick = async () => {
      const raw = document.getElementById('paste-body').value;
      const title = document.getElementById('paste-title').value.trim();
      if (!raw.trim()) return;
      dlgImport.close();
      try {
        const doc = await withBusy('Adding text', () => importPasted(raw, title));
        document.getElementById('paste-body').value = '';
        document.getElementById('paste-title').value = '';
        await refreshLibrary();
        toast(`Added “${trim(doc.title, 44)}”`);
        openDoc(doc.id);
      } catch (e) { fail(e); }
    };
  }

  async function ingestFiles(list) {
    if (!list.length) return;
    dlgImport.close();
    let last = null, ok = 0;

    for (const file of list) {
      try {
        last = await withBusy(`Reading ${trim(file.name, 30)}`, ({ signal, onProgress }) =>
          importFile(file, { signal, onProgress }));
        ok++;
        if (last.needsOcr) {
          toast('No text layer — open it and choose “Re-extract with OCR”.', { ms: 5200 });
        }
      } catch (e) {
        if (e?.name === 'AbortError') { toast('Cancelled'); break; }
        fail(e, `${file.name}: `);
      }
    }

    await refreshLibrary();
    if (ok === 1 && last) { toast(`Added “${trim(last.title, 44)}”`); openDoc(last.id); }
    else if (ok > 1) toast(`Added ${ok} documents`);
  }

  /* ════════════════════════════════════════════════════ settings ══ */

  function wireSettings() {
    const engineSel = document.getElementById('set-engine');
    const voiceSel  = document.getElementById('set-voice');

    engineSel.onchange = async () => {
      const id = engineSel.value;
      const wasPlaying = player.playing;
      player.pause();
      try {
        await withBusy('Loading voice', async ({ signal }) => {
          await setActiveEngine(id, (pct, label) =>
            busyUpdate({ done: pct, total: 100, detail: label }));
        });
        settings.set('engine', id);
        player.setEngine(activeEngine());
        await paintVoices();
        toast(`Using ${activeEngine().label}`);
        if (wasPlaying) player.play();
      } catch (e) {
        engineSel.value = settings.get('engine');
        fail(e);
      }
      paintEngineHint();
    };

    voiceSel.onchange = async () => {
      settings.set('voice', voiceSel.value);
      await paintVoiceState();
      if (player.playing) player.goto(player.index, { autoplay: true });
    };

    bindRange('set-rate', 'rate', 'set-rate-val', v => `${Number(v).toFixed(2).replace(/0$/, '').replace(/\.$/, '')}×`);
    bindRange('set-pitch', 'pitch', 'set-pitch-val', v => Number(v).toFixed(2));
    bindRange('set-gap', 'gapMs', 'set-gap-val', v => `${v} ms`);
    bindRange('set-fontsize', 'fontSize', 'set-fs-val', v => `${v}px`);

    bindCheck('set-skip-citations', 'skipCitations');
    bindCheck('set-skip-refs', 'skipRefs');
    bindCheck('set-skip-captions', 'skipCaptions');
    bindCheck('set-expand-abbrev', 'expandAbbrev');
    bindCheck('set-announce-headings', 'announceHeadings');
    bindCheck('set-keep-awake', 'keepAwake');
    bindCheck('set-autoscroll', 'autoscroll');
    bindCheck('set-dyslexic', 'dyslexic');

    document.getElementById('set-sleep').onchange = (e) =>
      settings.set('sleepSeconds', Number(e.target.value));

    document.getElementById('btn-clear-audio').onclick = async () => {
      await audioStore.clearAll();
      await paintStorage();
      toast('Cached audio cleared');
    };

    document.getElementById('btn-clear-all').onclick = async () => {
      if (!confirm('Delete every document, its text and all cached audio? This cannot be undone.')) return;
      player.pause();
      await wipe();
      await refreshLibrary();
      await paintStorage();
      dlgSettings.close();
      toast('Everything deleted');
    };

    // A cleanup change rebuilds the script without touching the source file.
    settings.onChange(async (keys) => {
      if (affectsText(keys)) await rebuildScript();
    });
  }

  async function paintSettings() {
    const s = settings.all;
    const engineSel = document.getElementById('set-engine');

    engineSel.innerHTML = '';
    for (const C of availableEngines()) {
      const o = document.createElement('option');
      o.value = C.id;
      o.textContent = C.label;
      engineSel.appendChild(o);
    }
    engineSel.value = s.engine;

    setVal('set-rate', s.rate, 'set-rate-val', `${Number(s.rate).toFixed(2).replace(/0$/, '').replace(/\.$/, '')}×`);
    setVal('set-pitch', s.pitch, 'set-pitch-val', Number(s.pitch).toFixed(2));
    setVal('set-gap', s.gapMs, 'set-gap-val', `${s.gapMs} ms`);
    setVal('set-fontsize', s.fontSize, 'set-fs-val', `${s.fontSize}px`);

    check('set-skip-citations', s.skipCitations);
    check('set-skip-refs', s.skipRefs);
    check('set-skip-captions', s.skipCaptions);
    check('set-expand-abbrev', s.expandAbbrev);
    check('set-announce-headings', s.announceHeadings);
    check('set-keep-awake', s.keepAwake);
    check('set-autoscroll', s.autoscroll);
    check('set-dyslexic', s.dyslexic);
    document.getElementById('set-sleep').value = String(s.sleepSeconds);

    paintEngineHint();
    await paintVoices();
    await paintStorage();

    document.getElementById('about-text').textContent =
      `Mobile Reader ${APP_VERSION}. Everything — your documents, their text and any rendered ` +
      `audio — stays on this device. Nothing is uploaded anywhere.`;
  }

  function paintEngineHint() {
    const e = activeEngine();
    document.getElementById('engine-hint').textContent = e?.description || '';
  }

  async function paintVoices() {
    const sel = document.getElementById('set-voice');
    sel.innerHTML = '';
    const e = activeEngine();
    if (!e) return;

    let list = [];
    try { list = await e.voices(); } catch { /* engine not ready */ }

    if (!list.length) {
      const o = document.createElement('option');
      o.textContent = 'No voices found';
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;

    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.id;
      // A voice the platform reports as non-local is synthesised on someone
      // else's server, which means the sentence text is sent there. That is a
      // privacy decision, so it has to be visible at the point of choosing.
      const where = v.local === false ? ' · sends text online' : '';
      // Downloadable voices state their cost and whether they are already here.
      const size = v.megabytes ? ` · ${v.downloaded ? '✓ ready' : `${v.megabytes} MB download`}` : '';
      o.textContent = (v.lang ? `${v.label} · ${v.lang}` : v.label) + size + where;
      sel.appendChild(o);
    }
    const want = settings.get('voice');
    sel.value = list.some(v => v.id === want) ? want : list[0].id;
    if (sel.value !== want) settings.set('voice', sel.value);

    await paintVoiceState(list);
  }

  /** The download controls only mean anything for an engine whose voices are
   *  fetched on demand, so they stay hidden for the platform voices. */
  async function paintVoiceState(list) {
    const box = document.getElementById('voice-manage');
    const state = document.getElementById('voice-state');
    const dl = document.getElementById('btn-voice-download');
    const rm = document.getElementById('btn-voice-remove');
    const e = activeEngine();

    if (!e?.downloadVoice) { box.hidden = true; return; }
    box.hidden = false;

    const id = settings.get('voice');
    const v = (list || await e.voices()).find(x => x.id === id);
    if (!v) { box.hidden = true; return; }

    state.className = 'voice-state' + (v.downloaded ? ' ready' : '');
    state.innerHTML = '';
    const strong = document.createElement('b');
    strong.textContent = v.downloaded ? 'On this device' : `Not downloaded yet`;
    const rest = document.createElement('span');
    rest.textContent = v.downloaded
      ? ' — works offline.'
      : ` — about ${v.megabytes} MB. Use wifi.`;
    state.append(strong, rest);

    dl.hidden = v.downloaded;
    rm.hidden = !v.downloaded;

    dl.onclick = async () => {
      const bar = document.getElementById('voice-bar');
      const fill = bar.querySelector('i');
      bar.hidden = false;
      dl.disabled = true;
      dl.textContent = 'Downloading…';
      try {
        await e.downloadVoice(id, (p) => {
          if (!p.total) return;
          fill.style.width = `${Math.round((p.loaded / p.total) * 100)}%`;
          dl.textContent = `Downloading ${(p.loaded / 1048576).toFixed(0)} of ${(p.total / 1048576).toFixed(0)} MB`;
        });
        toast('Voice ready — this now works offline');
        await paintVoices();
      } catch (err) {
        fail(err, 'Voice download failed: ');
      } finally {
        bar.hidden = true;
        fill.style.width = '0%';
        dl.disabled = false;
        dl.textContent = 'Download this voice';
      }
    };

    rm.onclick = async () => {
      if (!confirm(`Remove ${v.label} from this device? You can download it again later.`)) return;
      try {
        await e.removeVoice(id);
        toast('Voice removed');
        await paintVoices();
      } catch (err) { fail(err); }
    };
  }

  async function paintStorage() {
    document.getElementById('stat-docs').textContent = String(await docs.count().catch(() => 0));
    document.getElementById('stat-audio').textContent =
      `${await audioStore.count().catch(() => 0)} sentences`;
    const u = await usage();
    document.getElementById('stat-quota').textContent = u?.usage
      ? `${(u.usage / 1048576).toFixed(1)} MB`
      : 'Not reported';
  }

  /* ════════════════════════════════════════════════ diagnostics ══ */

  function wireDiag() {
    const dlg = document.getElementById('dlg-diag');
    const box = document.getElementById('diag-text');

    const open = () => {
      box.value = globalThis.__diag ? globalThis.__diag.report() : 'Diagnostics unavailable.';
      dlgSettings.close();
      dlg.showModal();
    };
    openDiag = open;

    document.getElementById('btn-diag').onclick = open;

    document.getElementById('btn-diag-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(box.value);
        toast('Copied');
      } catch {
        // Safari refuses the async clipboard in some contexts; selecting the
        // text and using the legacy call still works from a tap.
        box.focus();
        box.setSelectionRange(0, box.value.length);
        const ok = document.execCommand && document.execCommand('copy');
        toast(ok ? 'Copied' : 'Select the text above and copy it manually', { error: !ok });
      }
    };

    document.getElementById('btn-diag-clear').onclick = () => {
      globalThis.__diag?.clear();
      box.value = globalThis.__diag ? globalThis.__diag.report() : '';
      toast('Cleared');
    };
  }

  /* ════════════════════════════════════════════════ document menu ═ */

  function wireDocMenu() {
    document.getElementById('mi-outline').onclick = () => {
      dlgMenu.close();
      const cur = getCurrent();
      if (!cur) return;

      const list = document.getElementById('outline-list');
      list.innerHTML = '';

      if (!cur.script.outline.length) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.style.padding = '0 4px 8px';
        p.textContent = 'No headings were found in this document.';
        list.appendChild(p);
      }

      for (const h of cur.script.outline) {
        const b = document.createElement('button');
        b.className = 'menu-item';
        b.style.paddingLeft = `${14 + (h.level - 1) * 16}px`;
        const strong = document.createElement('b');
        strong.textContent = h.title;
        b.appendChild(strong);
        if (h.zone !== 'body') {
          const small = document.createElement('small');
          small.textContent = h.zone === 'references' ? 'References' : 'Back matter';
          b.appendChild(small);
        }
        b.onclick = () => { dlgOutline.close(); player.goto(h.sentenceIndex, { autoplay: player.playing }); };
        list.appendChild(b);
      }

      // Flag the section currently being read.
      const cursor = [...cur.script.outline].reverse().find(h => h.sentenceIndex <= player.index);
      if (cursor) {
        const idx = cur.script.outline.indexOf(cursor);
        list.children[idx]?.setAttribute?.('data-cur', '');
      }

      dlgOutline.showModal();
    };

    document.getElementById('mi-restart').onclick = () => {
      dlgMenu.close();
      player.goto(0, { autoplay: false });
      toast('Back to the beginning');
    };

    document.getElementById('mi-ocr').onclick = async () => {
      dlgMenu.close();
      const cur = getCurrent();
      if (!cur) return;
      if (!confirm('Run OCR over every page? This replaces the current text and is slow — several seconds per page.')) return;
      player.pause();
      try {
        const doc = await withBusy('Preparing OCR', ({ signal, onProgress }) =>
          reextractWithOcr(cur.doc.id, { signal, onProgress }));
        await refreshLibrary();
        openDoc(doc.id);
        toast('Re-extracted with OCR');
      } catch (e) { fail(e); }
    };

    document.getElementById('mi-prepare').onclick = async () => {
      dlgMenu.close();
      const cur = getCurrent();
      if (!cur) return;

      const e = activeEngine();
      // Only an engine that produces audio can be rendered ahead; the platform
      // synthesiser speaks straight to the output and hands back nothing we
      // could store.
      if (!e || typeof e.renderAll !== 'function') {
        toast('Switch to Piper in Settings first — the device voice cannot be saved as audio.', { ms: 5600 });
        return;
      }

      const texts = cur.script.sentences.filter(s => !s.skip).map(s => s.speak);
      if (!texts.length) return;

      player.pause();
      try {
        await withBusy('Rendering audio', async ({ signal, onProgress }) => {
          await e.renderAll(texts, {
            voiceId: settings.get('voice'),
            docId: cur.doc.id,
            signal,
            onProgress: (p) => onProgress({ phase: 'Rendering audio', ...p }),
          });
        });
        toast('This document is ready to play offline');
      } catch (err) {
        if (err?.name === 'AbortError') toast('Stopped — what was rendered is still cached');
        else fail(err);
      }
    };

    document.getElementById('mi-delete').onclick = async () => {
      const cur = getCurrent();
      if (!cur) return;
      if (!confirm(`Delete “${cur.doc.title}”?`)) return;
      dlgMenu.close();
      player.pause();
      await docs.remove(cur.doc.id);
      await refreshLibrary();
      deleteCurrent();
      toast('Deleted');
    };
  }
}

/* ════════════════════════════════════════════════════ helpers ═════ */

function bindRange(id, key, labelId, fmt) {
  const el = document.getElementById(id);
  el.oninput = () => {
    const v = Number(el.value);
    settings.set(key, v);
    document.getElementById(labelId).textContent = fmt(v);
  };
}

function bindCheck(id, key) {
  const el = document.getElementById(id);
  el.onchange = () => settings.set(key, el.checked);
}

function setVal(id, value, labelId, label) {
  document.getElementById(id).value = String(value);
  document.getElementById(labelId).textContent = label;
}

function check(id, on) { document.getElementById(id).checked = !!on; }

const trim = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

let openDiag = null;

function fail(e, prefix = '') {
  if (e?.name === 'AbortError') { toast('Cancelled'); return; }
  console.error(e);

  // Always capture the real error object. A caught exception never reaches
  // window.onerror, and on iOS this is the only way to see a stack at all.
  globalThis.__diag?.record('caught', e, prefix || 'import');

  // A TypeError or ReferenceError here is a bug in the app, not something the
  // reader did wrong, and its message ("undefined is not a function") is
  // useless on its own. Send those straight to the diagnostics sheet.
  const isBug = e instanceof TypeError || e instanceof ReferenceError ||
                /is not a function|undefined is not|null is not|cannot read/i.test(e?.message || '');

  if (isBug && openDiag) {
    toast('Something went wrong — opening diagnostics', { error: true, ms: 4000 });
    setTimeout(() => openDiag(), 350);
    return;
  }

  toast(prefix + (e?.message || 'Something went wrong'), { error: true, ms: 6000 });
}
