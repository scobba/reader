import { PDFJS } from '../config.js';
import { pageLines, stripRunningHeads, linesToBlocks, looksScanned } from './layout.js';

let _lib = null;

async function lib() {
  if (_lib) return _lib;
  _lib = await import(/* @vite-ignore */ PDFJS.lib);
  // Same-origin because everything is vendored, so a real module worker is
  // allowed here and page parsing stays off the main thread.
  _lib.GlobalWorkerOptions.workerSrc = PDFJS.worker;
  return _lib;
}

/** pdf.js hands us an opaque font id; the real name, when it is available,
 *  is the only signal we get for weight and slant. */
function fontTraits(pdfjs, page, styles, fontName) {
  let name = '';
  const s = styles?.[fontName];
  if (s?.fontFamily) name += ' ' + s.fontFamily;
  try {
    const obj = page.commonObjs.has(fontName) ? page.commonObjs.get(fontName) : null;
    if (obj?.name) name += ' ' + obj.name;
    if (obj?.loadedName) name += ' ' + obj.loadedName;
    if (obj?.black) return { bold: true, italic: !!obj.italic };
    if (typeof obj?.bold === 'boolean') return { bold: obj.bold, italic: !!obj.italic };
  } catch { /* font not resolved yet; fall back to the name string */ }

  return {
    bold: /bold|black|heavy|semib|demib|[-_]bd\b|700|800|900/i.test(name),
    italic: /italic|oblique|[-_]it\b/i.test(name),
  };
}

/**
 * Extract structured blocks from a PDF.
 *
 * @param {ArrayBuffer} data
 * @param {object} opts
 * @param {(p:{phase:string,done:number,total:number,detail?:string})=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{blocks:Array, meta:Object, needsOcr:boolean, scannedPages:number[]}>}
 */
export async function extractPdf(data, { onProgress, signal } = {}) {
  const pdfjs = await lib();

  const task = pdfjs.getDocument({
    // pdf.js takes ownership of the buffer and detaches it, so every entry
    // point hands over its own copy. Callers keep reusing the original.
    data: data.slice(0),
    standardFontDataUrl: PDFJS.fonts,
    useSystemFonts: true,
    isEvalSupported: false,
    // Journal PDFs are frequently linearised oddly; be forgiving.
    stopAtErrors: false,
  });
  signal?.addEventListener('abort', () => task.destroy().catch(() => {}), { once: true });

  const doc = await task.promise;
  const pageCount = doc.numPages;

  let allLines = [];
  const scannedPages = [];
  const pageGeom = [];

  try {
    for (let n = 1; n <= pageCount; n++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      onProgress?.({ phase: 'Reading pages', done: n - 1, total: pageCount, detail: `Page ${n} of ${pageCount}` });

      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const geom = { width: vp.width, height: vp.height };
      pageGeom.push(geom);

      const tc = await page.getTextContent({ includeMarkedContent: false });
      const traitCache = new Map();
      const atoms = [];

      for (const item of tc.items) {
        if (!item.str || !item.transform) continue;

        const tx = pdfjs.Util.transform(vp.transform, item.transform);
        const angle = Math.atan2(tx[1], tx[0]);
        // Rotated runs are axis labels, watermarks and side stamps. Dropping
        // them is a feature: they are never part of the prose.
        if (Math.abs(angle) > 0.12) continue;

        const size = Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]) || 10;
        if (size < 1 || size > 300) continue;

        if (!traitCache.has(item.fontName)) {
          traitCache.set(item.fontName, fontTraits(pdfjs, page, tc.styles, item.fontName));
        }
        const tr = traitCache.get(item.fontName);

        const x0 = tx[4];
        const base = tx[5];
        atoms.push({
          text: item.str,
          x0,
          x1: x0 + (item.width || item.str.length * size * 0.5),
          base,
          top: base - size * 0.86,
          bot: base + size * 0.26,
          size,
          bold: tr.bold,
          italic: tr.italic,
        });
      }

      const lines = pageLines(atoms, geom, n);
      if (looksScanned(lines, geom)) scannedPages.push(n);
      allLines.push(...lines);

      page.cleanup();
    }

    onProgress?.({ phase: 'Rebuilding layout', done: pageCount, total: pageCount });

    allLines = stripRunningHeads(allLines, pageCount);
    const blocks = linesToBlocks(allLines);

    const meta = await readMeta(doc, blocks);
    meta.pages = pageCount;

    return {
      blocks,
      meta,
      // Only claim it needs OCR when most of the document came back empty;
      // a couple of image-only figure pages in a normal article are normal.
      needsOcr: scannedPages.length >= Math.max(1, Math.ceil(pageCount * 0.6)),
      scannedPages,
    };
  } finally {
    // As of pdf.js 6, destroy() lives on the loading task rather than on the
    // document proxy.
    task.destroy().catch(() => {});
  }
}

/** PDF info dictionaries frequently carry XML character references verbatim,
 *  so "Kötter" arrives as "K&#x00F6;tter". */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .normalize('NFC');
}

async function readMeta(doc, blocks) {
  const out = {};
  try {
    const { info } = await doc.getMetadata();
    if (info?.Title && info.Title.trim().length > 3) out.title = decodeEntities(info.Title).trim();
    if (info?.Author) out.author = decodeEntities(info.Author).trim();
  } catch { /* metadata is optional */ }

  // Embedded PDF titles are very often the LaTeX filename or "untitled".
  // The first real heading beats them nearly every time.
  const bad = /^(untitled|microsoft word|document\d*|manuscript|paper|\d+\.(pdf|doc)|.*\.(indd|tex|dvi|qxd))/i;
  if (!out.title || bad.test(out.title)) {
    const head = blocks.find(b =>
      (b.type === 'heading' || b.type === 'para') &&
      b.text.length > 14 && b.text.length < 220 &&
      !/^(abstract|introduction|keywords?)\b/i.test(b.text));
    if (head) out.title = head.text.replace(/\s+/g, ' ').trim();
  }
  return out;
}

/** Open a document and keep it open. The OCR path rasterises every page, and
 *  reopening the file per page would re-parse the whole xref each time.
 *  @returns {Promise<{doc:Object, close:()=>void}>} */
export async function openPdf(data) {
  const pdfjs = await lib();
  const task = pdfjs.getDocument({
    data: data.slice(0),
    standardFontDataUrl: PDFJS.fonts,
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const doc = await task.promise;
  return { doc, close: () => task.destroy().catch(() => {}) };
}

/** Rasterise one page of an already-open document, capped so a poster-sized
 *  page cannot blow past the canvas limits on an iPhone. */
export async function renderPageOf(doc, pageNo, scale = 2.2, maxPx = 14e6) {
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  let s = scale;
  if (base.width * base.height * s * s > maxPx) {
    s = Math.sqrt(maxPx / (base.width * base.height));
  }
  const vp = page.getViewport({ scale: s });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Tesseract does markedly better on white than on transparency.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
  page.cleanup();
  return { canvas, scale: s, width: base.width, height: base.height };
}
