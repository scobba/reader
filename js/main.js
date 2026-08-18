import { docs, content, progress, persist } from './core/db.js';
import { settings } from './core/settings.js';
import { buildScript } from './clean/structure.js';
import { player } from './core/player.js';
import { bootEngine, activeEngine } from './tts/manager.js';
import { initLibrary } from './ui/library.js';
import { initReader } from './ui/reader.js';
import { initDialogs } from './ui/dialogs.js';
import { toast, withBusy } from './ui/toast.js';

/* Bootstrap and routing. Two views, no router library: the app has exactly
 * one navigable axis (library <-> a document) and history handles the back
 * gesture. */

let current = null;   // { doc, blocks, script }

const views = {
  library: document.getElementById('view-library'),
  reader:  document.getElementById('view-reader'),
};

function show(name) {
  for (const [k, el] of Object.entries(views)) el.toggleAttribute('data-active', k === name);
}

/* ═══════════════════════════════════════════════════════ wiring ═══════ */

const library = initLibrary({ onOpen: openDoc });

const reader = initReader({
  onBack: () => history.back(),
  onMenu: () => dialogs.openDocMenu(),
});

const dialogs = initDialogs({
  refreshLibrary: () => library.render(),
  openDoc,
  getCurrent: () => current,
  rebuildScript,
  deleteCurrent: () => { current = null; goLibrary(); },
});

document.getElementById('btn-import').onclick = () => dialogs.openImport();
document.getElementById('btn-settings').onclick = () => dialogs.openSettings();
document.querySelector('[data-action="import"]')?.addEventListener('click', () => dialogs.openImport());

/* ═══════════════════════════════════════════════════════ routing ══════ */

function goLibrary() {
  player.pause();
  show('library');
  library.render();
}

async function openDoc(id, { push = true } = {}) {
  const doc = await docs.get(id);
  if (!doc) { toast('That document is no longer here', { error: true }); return goLibrary(); }

  const blocks = await content.get(id);
  if (!blocks?.length) { toast('The text for this document is missing', { error: true }); return goLibrary(); }

  const script = buildScript(blocks, settings.all);
  const pos = await progress.get(id).catch(() => null);
  const start = pos && pos.index < script.sentences.length ? pos.index : 0;

  current = { doc, blocks, script };
  player.setEngine(activeEngine());
  player.load(doc, script.sentences, start);
  reader.show(doc, script);
  show('reader');

  if (push && location.hash !== `#doc=${id}`) history.pushState({ id }, '', `#doc=${id}`);
  document.getElementById('reader-scroll').scrollTop = 0;
  if (start > 0) toast('Picking up where you left off');
}

/** Re-derive the script after a cleanup setting changed. */
async function rebuildScript() {
  if (!current) return;
  const script = buildScript(current.blocks, settings.all);
  current.script = script;
  // Render before reindexing: reindex can resume playback, and playback
  // highlights spans, which have to exist for the new sentence list first.
  reader.show(current.doc, script);
  player.reindex(script.sentences);
}

window.addEventListener('popstate', (e) => {
  const id = e.state?.id || (location.hash.startsWith('#doc=') ? location.hash.slice(5) : null);
  if (id) openDoc(id, { push: false });
  else goLibrary();
});

/* ═══════════════════════════════════════════════════ player events ════ */

player.on('error', (err) => {
  console.error(err);
  toast(err.message || 'Playback stopped', { error: true, ms: 5000 });
});

player.on('end', () => {
  toast('Finished');
  player.setPlaybackState('none');
});

player.on('sleep', () => toast('Sleep timer — stopped'));

// Hardware keys and desktop convenience.
document.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (document.querySelector('dialog[open]')) return;
  if (!views.reader.hasAttribute('data-active')) return;

  switch (e.key) {
    case ' ':          e.preventDefault(); player.unlock(); player.toggle(); break;
    case 'ArrowRight': e.preventDefault(); player.next(); break;
    case 'ArrowLeft':  e.preventDefault(); player.prev(); break;
    case 'ArrowDown':  e.preventDefault(); player.section(1); break;
    case 'ArrowUp':    e.preventDefault(); player.section(-1); break;
    case 'Escape':     history.back(); break;
  }
});

/* ═══════════════════════════════════════════════════════ startup ═════ */

(async function start() {
  // Ask the browser to keep our data. Safari only grants this to an installed
  // (home-screen) app, so a "no" here is expected in a plain tab.
  persist().catch(() => {});

  await library.render();

  try {
    const { fellBack, reason } = await bootEngine();
    player.setEngine(activeEngine());
    if (fellBack) toast(`Using the device voice — ${reason}`, { ms: 6000 });
  } catch (e) {
    toast(e.message || 'No speech engine is available in this browser', { error: true, ms: 7000 });
  }

  // Deep link straight into a document.
  if (location.hash.startsWith('#doc=')) {
    await openDoc(location.hash.slice(5), { push: false });
  }

  // Text shared into the installed app (Android share target; on iOS this is
  // reachable by pasting a URL with ?text=).
  const params = new URLSearchParams(location.search);
  const shared = params.get('text') || params.get('url');
  if (shared) {
    history.replaceState(null, '', location.pathname + location.hash);
    const { importPasted, importUrl } = await import('./core/ingest.js');
    try {
      const doc = /^https?:\/\/\S+$/.test(shared.trim())
        ? await withBusy('Fetching article', ({ signal, onProgress }) =>
            importUrl(shared.trim(), { signal, onProgress }))
        : await withBusy('Adding text', () => importPasted(shared, params.get('title') || ''));
      await library.render();
      openDoc(doc.id);
    } catch (e) {
      toast(e.message || 'Could not add that', { error: true, ms: 6000 });
    }
  }

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register(
        new URL('../sw.js', import.meta.url), { scope: './' });
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('An update is ready — reopen the app to apply it', { ms: 5000 });
          }
        });
      });
    } catch (e) {
      // Only fails on file:// or an insecure origin, where offline is moot.
      console.warn('Service worker not registered:', e.message);
    }
  }
})();
