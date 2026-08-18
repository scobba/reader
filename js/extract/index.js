import { extractPdf } from './pdf.js';
import { extractHtml } from './html.js';
import { extractEpub } from './epub.js';
import { extractDocx } from './docx.js';
import { extractText } from './text.js';

/* Format dispatch. File extensions lie often enough — especially for things
 * saved out of Safari — that we sniff the magic bytes first and only fall
 * back to the name. */

const magic = (bytes, sig) => sig.every((b, i) => bytes[i] === b);

export function sniff(bytes, name = '', mime = '') {
  const b = bytes.subarray(0, 512);

  if (magic(b, [0x25, 0x50, 0x44, 0x46])) return 'pdf';                 // %PDF
  if (magic(b, [0x50, 0x4b, 0x03, 0x04]) ||
      magic(b, [0x50, 0x4b, 0x05, 0x06])) {
    // Both EPUB and DOCX are ZIPs. An EPUB declares itself in the first
    // stored entry, which lands right after the local header.
    const head = new TextDecoder('latin1').decode(b);
    if (/mimetypeapplication\/epub\+zip/.test(head.replace(/\s/g, ''))) return 'epub';
    if (/\.epub$/i.test(name) || /epub/i.test(mime)) return 'epub';
    if (/\.docx$/i.test(name) || /wordprocessingml/i.test(mime)) return 'docx';
    return 'zip';   // resolved properly once the central directory is read
  }
  if (magic(b, [0x89, 0x50, 0x4e, 0x47]) ||                             // PNG
      magic(b, [0xff, 0xd8, 0xff])) return 'image';                     // JPEG

  const text = new TextDecoder('utf-8', { fatal: false }).decode(b).trimStart();
  if (/^<(!doctype\s+html|html|\?xml[^>]*\?>\s*<(!doctype\s+html|html))/i.test(text)) return 'html';
  if (/^<\?xml/i.test(text) && /<(body|section|article)\b/i.test(text)) return 'html';

  if (/\.(html?|xhtml)$/i.test(name) || /text\/html/i.test(mime)) return 'html';
  if (/\.pdf$/i.test(name) || /application\/pdf/i.test(mime)) return 'pdf';
  return 'text';
}

const LABEL = {
  pdf: 'PDF', epub: 'EPUB', docx: 'DOCX', html: 'WEB',
  text: 'TXT', image: 'IMG', zip: 'ZIP',
};
export const kindLabel = (k) => LABEL[k] || 'DOC';

/**
 * Extract blocks from a file.
 * @param {Blob|File} blob
 * @param {{name?:string, url?:string, onProgress?:Function, signal?:AbortSignal}} opts
 */
export async function extractFile(blob, { name = '', url = '', onProgress, signal } = {}) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let kind = sniff(bytes, name || blob.name || '', blob.type || '');

  if (kind === 'zip') {
    // Ambiguous archive: let the ZIP directory decide.
    const { ZipReader } = await import('../core/zip.js');
    const z = await ZipReader.from(buffer.slice(0));
    kind = z.has('word/document.xml') ? 'docx'
         : z.list(/\.opf$/i).length ? 'epub'
         : 'text';
  }

  const base = { kind };

  switch (kind) {
    case 'pdf': {
      const r = await extractPdf(buffer, { onProgress, signal });
      return { ...base, ...r };
    }
    case 'epub':
      return { ...base, ...await extractEpub(buffer, { onProgress, signal }) };

    case 'docx':
      return { ...base, ...await extractDocx(buffer, { onProgress, signal }) };

    case 'html': {
      const html = new TextDecoder('utf-8').decode(bytes);
      const r = extractHtml(html, url || undefined);
      return { ...base, ...r, needsOcr: false };
    }

    case 'image': {
      const { ocrImage } = await import('./ocr.js');
      return { ...base, ...await ocrImage(blob, { onProgress, signal }) };
    }

    default: {
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const r = extractText(raw, { title: name.replace(/\.[a-z0-9]+$/i, '') || null });
      return { ...base, ...r };
    }
  }
}

/** Text or HTML pasted into the app. */
export function extractPasted(raw, title) {
  const looksHtml = /<\/(p|div|section|article|h[1-6]|li)>/i.test(raw) || /^\s*</.test(raw);
  if (looksHtml) {
    const r = extractHtml(raw);
    if (r.blocks.length) {
      return { kind: 'html', ...r, meta: { ...r.meta, title: title || r.meta.title }, needsOcr: false };
    }
  }
  return { kind: 'text', ...extractText(raw, { title }) };
}
