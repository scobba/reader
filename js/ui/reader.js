import { player } from '../core/player.js';
import { settings } from '../core/settings.js';

/* The reading view: the text, the highlight that follows the voice, and the
 * transport bar. */

const RATES = [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5];

export function initReader({ onBack, onMenu }) {
  const body    = document.getElementById('reader-body');
  const scroll  = document.getElementById('reader-scroll');
  const title   = document.getElementById('reader-title');
  const seek    = document.getElementById('seek');
  const posLbl  = document.getElementById('pos-label');
  const timeLbl = document.getElementById('time-label');
  const rateLbl = document.getElementById('rate-label');

  let spans = [];
  let script = null;
  let lastIndex = -1;
  let scrubbing = false;
  let renderToken = 0;

  /* ── wiring ───────────────────────────────────────────────────── */
  document.getElementById('btn-back').onclick = onBack;
  document.getElementById('btn-doc-menu').onclick = onMenu;
  document.getElementById('btn-play').onclick = () => {
    // Must happen inside the gesture, before any await, or iOS stays silent.
    player.unlock();
    player.toggle();
  };
  document.getElementById('btn-next').onclick = () => player.next();
  document.getElementById('btn-prev').onclick = () => player.prev();
  document.getElementById('btn-prev-section').onclick = () => player.section(-1);

  document.getElementById('btn-rate').onclick = () => {
    const cur = settings.get('rate');
    const i = RATES.findIndex(r => Math.abs(r - cur) < 0.02);
    const next = RATES[(i + 1) % RATES.length] ?? 1;
    settings.set('rate', next);
    paintRate();
    // Take effect immediately rather than at the next sentence.
    if (player.playing) player.goto(player.index, { autoplay: true });
  };

  body.addEventListener('click', (e) => {
    const s = e.target.closest('.s');
    if (!s) return;
    const i = Number(s.dataset.i);
    if (Number.isNaN(i)) return;
    player.unlock();
    player.goto(i, { autoplay: true });
  });

  seek.addEventListener('input', () => {
    scrubbing = true;
    const i = indexFromSeek();
    paintPosition(i);
    highlight(i, { scroll: true, instant: true });
  });
  seek.addEventListener('change', () => {
    scrubbing = false;
    player.goto(indexFromSeek(), { autoplay: player.playing });
  });

  /* ── player events ────────────────────────────────────────────── */
  player.on('index', (i) => { if (!scrubbing) { highlight(i); paintPosition(i); } });
  player.on('state', (playing) => {
    document.body.toggleAttribute('data-playing', playing);
    document.getElementById('btn-play')
      .setAttribute('aria-label', playing ? 'Pause' : 'Play');
    player.setPlaybackState(playing ? 'playing' : 'paused');
  });

  settings.onChange((keys) => {
    if (keys.includes('rate')) paintRate();
    if (keys.includes('fontSize') || keys.includes('dyslexic')) applyType();
  });

  applyType();
  paintRate();

  return { show, rerender: () => render(script) };

  /* ── rendering ────────────────────────────────────────────────── */

  function show(doc, built) {
    script = built;
    title.textContent = doc.title || 'Document';
    render(built);
  }

  function render(built) {
    const token = ++renderToken;
    body.innerHTML = '';
    spans = new Array(built.sentences.length);
    lastIndex = -1;

    // Group sentences by their source block so paragraphs stay paragraphs.
    const byBlock = new Map();
    for (const s of built.sentences) {
      if (!byBlock.has(s.blockIdx)) byBlock.set(s.blockIdx, []);
      byBlock.get(s.blockIdx).push(s);
    }

    const blocks = built.blocks;
    let cursor = 0;
    let lastZone = 'body';

    // Long documents are rendered in slices so opening a book does not block
    // the main thread for a second and a half. The continuation is a timeout
    // rather than requestAnimationFrame: rAF is suspended whenever the tab
    // is not compositing, which would leave a backgrounded document
    // permanently half-rendered.
    const step = () => {
      if (token !== renderToken) return;
      const frag = document.createDocumentFragment();
      const end = Math.min(cursor + 250, blocks.length);

      for (; cursor < end; cursor++) {
        const b = blocks[cursor];
        const sents = byBlock.get(cursor);
        if (!sents?.length) continue;

        if (b.zone !== lastZone && b.zone !== 'body') {
          const label = document.createElement('div');
          label.className = 'sec-label';
          label.textContent = b.zone === 'references' ? 'References' : 'Back matter';
          frag.appendChild(label);
        }
        lastZone = b.zone;

        const el = document.createElement(b.type === 'heading' ? 'h2' : 'p');
        if (b.type === 'caption') el.className = 'caption';
        else if (b.zone !== 'body') el.className = 'refs';

        for (const s of sents) {
          const span = document.createElement('span');
          span.className = 's' + (s.skip ? ' muted' : '');
          span.dataset.i = String(s.i);
          span.textContent = s.text + ' ';
          spans[s.i] = span;
          el.appendChild(span);
        }
        frag.appendChild(el);
      }

      body.appendChild(frag);
      if (cursor < blocks.length) setTimeout(step, 0);
      else if (player.index > 0) highlight(player.index, { scroll: true, instant: true });
    };

    step();
    paintPosition(player.index);
  }

  /* ── highlight ────────────────────────────────────────────────── */

  function highlight(i, { scroll: doScroll = true, instant = false } = {}) {
    if (lastIndex >= 0 && spans[lastIndex]) {
      spans[lastIndex].classList.remove('on');
      spans[lastIndex].classList.add('done');
    }
    const el = spans[i];
    if (!el) { lastIndex = i; return; }

    el.classList.add('on');
    el.classList.remove('done');
    // Anything after the cursor is unread again after a jump backwards.
    if (i < lastIndex) {
      for (let k = i + 1; k <= lastIndex; k++) spans[k]?.classList.remove('done');
    }
    lastIndex = i;

    if (!doScroll || !settings.get('autoscroll')) return;

    const box = el.getBoundingClientRect();
    const view = scroll.getBoundingClientRect();
    const comfortable = box.top > view.top + view.height * 0.18 &&
                        box.bottom < view.top + view.height * 0.72;
    if (comfortable) return;

    const target = scroll.scrollTop + (box.top - view.top) - view.height * 0.34;
    scroll.scrollTo({
      top: Math.max(0, target),
      behavior: instant || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }

  /* ── labels ───────────────────────────────────────────────────── */

  function indexFromSeek() {
    const n = script?.sentences.length || 1;
    return Math.min(n - 1, Math.round((Number(seek.value) / 100) * (n - 1)));
  }

  function paintPosition(i) {
    if (!script) return;
    const n = script.sentences.length || 1;
    if (!scrubbing) seek.value = String(Math.round((i / Math.max(1, n - 1)) * 100));

    const s = script.sentences[i];
    posLbl.textContent = s?.section
      ? trim(s.section, 42)
      : `Sentence ${i + 1} of ${n}`;

    let wordsLeft = 0;
    for (let k = i; k < script.sentences.length; k++) {
      const x = script.sentences[k];
      if (!x.skip) wordsLeft += x.text.split(/\s+/).length;
    }
    const mins = Math.round(wordsLeft / (165 * (settings.get('rate') || 1)));
    timeLbl.textContent = mins > 0
      ? (mins < 60 ? `${mins} min left` : `${Math.floor(mins / 60)} h ${mins % 60} min left`)
      : 'Almost done';
  }

  function paintRate() {
    rateLbl.textContent = `${Number(settings.get('rate')).toFixed(2).replace(/0$/, '').replace(/\.$/, '')}×`;
  }

  function applyType() {
    const root = document.documentElement.style;
    root.setProperty('--reader-fs', `${settings.get('fontSize')}px`);
    const d = settings.get('dyslexic');
    root.setProperty('--reader-lh', d ? '1.95' : '1.62');
    root.setProperty('--reader-ls', d ? '.028em' : '0');
  }
}

const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
