/* Transient messages and the blocking progress overlay. */

const host = () => document.getElementById('toast-host');

export function toast(message, { error = false, ms = 3200 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.textContent = message;
  host().appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ms);
  return el;
}

/* ═══════════════════════════════════════════════════════ busy ═════════ */

let controller = null;

const els = () => ({
  root:   document.getElementById('busy'),
  title:  document.getElementById('busy-title'),
  detail: document.getElementById('busy-detail'),
  bar:    document.getElementById('busy-bar'),
  cancel: document.getElementById('busy-cancel'),
});

/**
 * Show the progress overlay and return an AbortSignal wired to its Cancel
 * button, so any long job can be interrupted the same way.
 */
export function busyStart(title, { cancellable = true } = {}) {
  const e = els();
  controller = new AbortController();

  e.title.textContent = title;
  e.detail.textContent = '';
  e.bar.style.width = '0%';
  e.cancel.hidden = !cancellable;
  e.root.hidden = false;

  e.cancel.onclick = () => {
    controller?.abort();
    e.detail.textContent = 'Cancelling…';
  };

  return controller.signal;
}

/** Accepts the {phase, done, total, detail} shape the extractors emit. */
export function busyUpdate(p) {
  const e = els();
  if (e.root.hidden) return;
  if (p.phase) e.title.textContent = p.phase;
  if (p.detail !== undefined) e.detail.textContent = p.detail || '';
  if (p.total) {
    const pct = Math.max(0, Math.min(100, (p.done / p.total) * 100));
    e.bar.style.width = `${pct}%`;
  }
}

export function busyEnd() {
  const e = els();
  e.root.hidden = true;
  e.cancel.onclick = null;
  controller = null;
}

/** Wrap a job in the overlay. The job receives the abort signal. */
export async function withBusy(title, job, { cancellable = true } = {}) {
  const signal = busyStart(title, { cancellable });
  try {
    return await job({ signal, onProgress: busyUpdate });
  } finally {
    busyEnd();
  }
}
