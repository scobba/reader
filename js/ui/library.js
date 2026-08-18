import { docs, progress } from '../core/db.js';

/* The library list. */

const fmtBytes = (n) => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

const fmtWhen = (ts) => {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const fmtLength = (doc) => {
  if (!doc.minutes) return '';
  if (doc.minutes < 60) return `${doc.minutes} min listen`;
  const h = Math.floor(doc.minutes / 60), m = doc.minutes % 60;
  return m ? `${h} h ${m} min listen` : `${h} h listen`;
};

export function initLibrary({ onOpen }) {
  const list = document.getElementById('doc-list');
  const empty = document.getElementById('library-empty');

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.doc');
    if (row?.dataset.id) onOpen(row.dataset.id);
  });

  return { render };

  async function render() {
    const all = await docs.all();
    empty.hidden = all.length > 0;
    list.innerHTML = '';

    for (const doc of all) {
      const pos = await progress.get(doc.id).catch(() => null);
      const pct = pos && pos.total ? Math.min(100, (pos.index / pos.total) * 100) : 0;

      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'doc';
      btn.dataset.id = doc.id;

      const kind = document.createElement('span');
      kind.className = 'doc-kind';
      kind.textContent = doc.kindLabel || 'DOC';

      const main = document.createElement('span');
      main.className = 'doc-main';

      const title = document.createElement('span');
      title.className = 'doc-title';
      title.textContent = doc.title;

      const sub = document.createElement('span');
      sub.className = 'doc-sub';

      const bits = [];
      if (doc.author) bits.push(doc.author.split(',')[0] + (doc.author.includes(',') ? ' et al.' : ''));
      const len = fmtLength(doc);
      if (len) bits.push(len);
      if (doc.pages) bits.push(`${doc.pages} pages`);
      bits.push(fmtWhen(doc.addedAt));
      if (doc.bytes) bits.push(fmtBytes(doc.bytes));

      bits.forEach((t, i) => {
        if (i) {
          const dot = document.createElement('span');
          dot.className = 'dot';
          dot.textContent = '·';
          sub.appendChild(dot);
        }
        const s = document.createElement('span');
        s.textContent = t;
        sub.appendChild(s);
      });

      if (doc.ocr) sub.appendChild(pill('OCR'));
      if (doc.needsOcr) sub.appendChild(pill('Scanned — needs OCR', true));

      main.append(title, sub);

      if (pct > 0.5) {
        const bar = document.createElement('span');
        bar.className = 'doc-progress';
        const fill = document.createElement('i');
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);
        main.appendChild(bar);
      }

      btn.append(kind, main);
      li.appendChild(btn);
      list.appendChild(li);
    }
  }
}

function pill(text, warn = false) {
  const el = document.createElement('span');
  el.className = 'pill' + (warn ? ' warn' : '');
  el.textContent = text;
  return el;
}
