import { TESSERACT } from '../config.js';
import { openPdf, renderPageOf } from './pdf.js';
import { pageLines, stripRunningHeads, linesToBlocks } from './layout.js';

/* OCR fallback for scanned documents.
 *
 * Tesseract does its own layout analysis, but we throw it away and feed the
 * word boxes through the same XY-cut pipeline the digital PDF path uses. That
 * keeps column handling, running-head removal and paragraph assembly
 * identical no matter where the text came from — which matters, because a
 * scanned two-column article has exactly the same reading-order problem.
 *
 * The engine and its 10 MB language model are vendored but not precached;
 * the first OCR run pulls them in and the service worker keeps them.
 */

let _tess = null;

async function loadEngine() {
  if (_tess) return _tess;
  if (globalThis.Tesseract) return (_tess = globalThis.Tesseract);

  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT.lib;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the OCR engine. Check that vendor/tesseract exists.'));
    document.head.appendChild(s);
  });

  if (!globalThis.Tesseract) throw new Error('OCR engine loaded but did not register');
  return (_tess = globalThis.Tesseract);
}

async function makeWorker(onStatus) {
  const T = await loadEngine();
  return T.createWorker('eng', 1 /* LSTM only */, {
    workerPath: TESSERACT.worker,
    corePath: TESSERACT.core,
    langPath: TESSERACT.lang,
    gzip: true,
    logger: (m) => {
      if (m.status && onStatus) onStatus(m);
    },
    errorHandler: (e) => console.warn('[ocr]', e),
  });
}

/** Tesseract word boxes -> the atom shape layout.js expects. */
function wordsToAtoms(data, scale) {
  const atoms = [];
  const push = (w) => {
    if (!w.text || !w.text.trim()) return;
    if (typeof w.confidence === 'number' && w.confidence < 40) return;
    const b = w.bbox;
    if (!b) return;
    const x0 = b.x0 / scale, x1 = b.x1 / scale;
    const top = b.y0 / scale, bot = b.y1 / scale;
    const h = bot - top;
    if (h <= 0 || x1 <= x0) return;
    atoms.push({
      text: w.text,
      x0, x1, top, bot,
      // Word boxes span ascender to descender; the baseline sits ~20% up
      // from the bottom and the visual size is ~75% of the box.
      base: bot - h * 0.20,
      size: h * 0.78,
      bold: !!w.is_bold,
      italic: !!w.is_italic,
    });
  };

  const blocks = data.blocks || [];
  for (const blk of blocks)
    for (const par of blk.paragraphs || [])
      for (const line of par.lines || [])
        for (const w of line.words || []) push(w);

  // Older/looser shapes: fall back to a flat word list.
  if (!atoms.length && Array.isArray(data.words)) data.words.forEach(push);
  return atoms;
}

/**
 * OCR a PDF end to end.
 * @param {ArrayBuffer} data
 * @param {{onProgress?:Function, signal?:AbortSignal, pages?:number[], scale?:number}} opts
 */
export async function ocrPdf(data, { onProgress, signal, pages, scale = 2.2 } = {}) {
  const { doc, close } = await openPdf(data);
  const total = doc.numPages;
  const list = pages && pages.length ? pages : Array.from({ length: total }, (_, i) => i + 1);

  onProgress?.({ phase: 'Starting OCR', done: 0, total: list.length,
                 detail: 'Loading the recognition model (first run only)' });

  let worker;
  try {
    worker = await makeWorker();
  } catch (e) {
    close();
    throw e;
  }

  const allLines = [];
  try {
    for (let i = 0; i < list.length; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const n = list[i];
      onProgress?.({ phase: 'Recognising text', done: i, total: list.length,
                     detail: `Page ${n} — this is slow on phones` });

      const { canvas, scale: used, width, height } = await renderPageOf(doc, n, scale);
      let res;
      try {
        res = await worker.recognize(canvas, {}, { blocks: true, text: true });
      } finally {
        // Free the bitmap immediately; a 14 MP canvas per page adds up fast.
        canvas.width = canvas.height = 0;
      }

      // Atoms are scaled back to unscaled page units so the layout thresholds
      // in layout.js — all expressed relative to page width — still hold.
      allLines.push(...pageLines(wordsToAtoms(res.data, used), { width, height }, n));
    }

    onProgress?.({ phase: 'Rebuilding layout', done: list.length, total: list.length });
    const cleaned = stripRunningHeads(allLines, list.length);
    const blocks = linesToBlocks(cleaned);

    if (!blocks.length) throw new Error('OCR did not find any readable text');

    const head = blocks.find(b => b.type === 'heading' && b.text.length > 12) || blocks[0];
    return {
      blocks,
      meta: { title: head?.text?.slice(0, 160), pages: total, ocr: true },
      needsOcr: false,
    };
  } finally {
    try { await worker.terminate(); } catch { /* already gone */ }
    close();
  }
}

/** OCR a single image file. */
export async function ocrImage(blob, { onProgress, signal } = {}) {
  onProgress?.({ phase: 'Starting OCR', done: 0, total: 1, detail: 'Loading the recognition model' });
  const worker = await makeWorker();
  try {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    onProgress?.({ phase: 'Recognising text', done: 0, total: 1 });
    const res = await worker.recognize(blob, {}, { blocks: true, text: true });

    const bmp = await createImageBitmap(blob).catch(() => null);
    const geom = { width: bmp?.width || 1000, height: bmp?.height || 1400 };
    bmp?.close?.();

    const atoms = wordsToAtoms(res.data, 1);
    const blocks = linesToBlocks(pageLines(atoms, geom, 1));
    if (!blocks.length) throw new Error('No readable text in this image');

    return { blocks, meta: { title: blocks[0].text.slice(0, 120), pages: 1, ocr: true }, needsOcr: false };
  } finally {
    try { await worker.terminate(); } catch { /* already gone */ }
  }
}
