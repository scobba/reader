import { extractFile, extractPasted, kindLabel } from '../extract/index.js';
import { buildScript } from '../clean/structure.js';
import { settings } from './settings.js';
import { docs, content, files } from './db.js';

/* Import pipeline: bytes -> blocks -> a library row.
 *
 * The original file is kept alongside the extracted blocks so "re-extract
 * with OCR" never has to ask for it again, and so a future improvement to the
 * layout analyser can be applied to documents you already added.
 */

const newId = () =>
  (crypto.randomUUID?.() || `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

function summarise(blocks) {
  const { stats } = buildScript(blocks, settings.all);
  return stats;
}

function titleFrom(meta, fallback) {
  const t = (meta?.title || '').replace(/\s+/g, ' ').trim();
  if (t && t.length > 2) return t.length > 200 ? t.slice(0, 197) + '…' : t;
  return fallback;
}

/**
 * @param {File|Blob} file
 * @param {{onProgress?:Function, signal?:AbortSignal}} [opts]
 */
export async function importFile(file, { onProgress, signal } = {}) {
  const name = file.name || 'Document';
  const res = await extractFile(file, { name, onProgress, signal });

  if (!res.blocks?.length) {
    throw new Error(res.needsOcr
      ? 'No text layer found. This looks like a scan — try “Re-extract with OCR”.'
      : 'No readable text found in this file.');
  }

  const stats = summarise(res.blocks);
  const id = newId();

  const doc = {
    id,
    title: titleFrom(res.meta, name.replace(/\.[a-z0-9]+$/i, '')),
    author: res.meta?.author || null,
    kind: res.kind,
    kindLabel: kindLabel(res.kind),
    pages: res.meta?.pages || null,
    addedAt: Date.now(),
    bytes: file.size || 0,
    words: stats.words,
    minutes: stats.minutes,
    ocr: !!res.meta?.ocr,
    needsOcr: !!res.needsOcr,
    source: name,
  };

  await files.put(id, file, name, file.type);
  await content.put(id, res.blocks);
  await docs.put(doc);
  return doc;
}

/** Text or HTML pasted in by hand. */
export async function importPasted(raw, title) {
  const body = (raw || '').trim();
  if (body.length < 20) throw new Error('That is too short to read.');

  const res = extractPasted(body, title);
  if (!res.blocks?.length) throw new Error('Could not find any readable text in that.');

  const stats = summarise(res.blocks);
  const id = newId();
  const doc = {
    id,
    title: titleFrom(res.meta, title || 'Pasted text'),
    author: res.meta?.author || null,
    kind: res.kind,
    kindLabel: kindLabel(res.kind),
    pages: null,
    addedAt: Date.now(),
    bytes: body.length,
    words: stats.words,
    minutes: stats.minutes,
    ocr: false,
    needsOcr: false,
    source: 'Pasted',
  };

  await files.put(id, new Blob([body], { type: 'text/plain' }), 'pasted.txt', 'text/plain');
  await content.put(id, res.blocks);
  await docs.put(doc);
  return doc;
}

/**
 * Fetch a web page and import it.
 *
 * This works for open-access hosts and preprint servers. Most subscription
 * publishers block cross-origin reads outright, and no amount of client-side
 * cleverness fixes that — the Paste tab is the reliable route for those, so
 * the error says so rather than failing vaguely.
 */
export async function importUrl(url, { onProgress, signal } = {}) {
  let target;
  try { target = new URL(url); } catch { throw new Error('That does not look like a valid URL.'); }
  if (!/^https?:$/.test(target.protocol)) throw new Error('Only http and https addresses work here.');

  onProgress?.({ phase: 'Fetching', done: 0, total: 1, detail: target.hostname });

  let res;
  try {
    res = await fetch(target.href, { redirect: 'follow', signal, credentials: 'omit' });
  } catch {
    throw new Error(
      `${target.hostname} refused a direct request from the browser. Open the article in Safari, ` +
      `select all, copy, and use the Paste tab instead.`);
  }
  if (!res.ok) throw new Error(`${target.hostname} returned ${res.status}.`);

  const type = res.headers.get('content-type') || '';
  const blob = await res.blob();

  // Journal "article" links very often resolve straight to a PDF.
  const guessName = decodeURIComponent(target.pathname.split('/').filter(Boolean).pop() || 'page');
  const named = /pdf/i.test(type) && !/\.pdf$/i.test(guessName) ? `${guessName}.pdf` : guessName;

  const out = await extractFile(blob, { name: named, url: target.href, onProgress, signal });
  if (!out.blocks?.length) throw new Error('That page had no readable article text.');

  const stats = summarise(out.blocks);
  const id = newId();
  const doc = {
    id,
    title: titleFrom(out.meta, target.hostname),
    author: out.meta?.author || null,
    kind: out.kind,
    kindLabel: kindLabel(out.kind),
    pages: out.meta?.pages || null,
    addedAt: Date.now(),
    bytes: blob.size,
    words: stats.words,
    minutes: stats.minutes,
    ocr: false,
    needsOcr: !!out.needsOcr,
    source: target.href,
  };

  await files.put(id, blob, named, blob.type);
  await content.put(id, out.blocks);
  await docs.put(doc);
  return doc;
}

/** Re-run extraction through OCR for a document already in the library. */
export async function reextractWithOcr(docId, { onProgress, signal } = {}) {
  const doc = await docs.get(docId);
  if (!doc) throw new Error('Document not found');

  const blob = await files.get(docId);
  if (!blob) throw new Error('The original file is no longer stored for this document.');

  const buffer = await blob.arrayBuffer();
  const { ocrPdf, ocrImage } = await import('../extract/ocr.js');

  const res = doc.kind === 'pdf'
    ? await ocrPdf(buffer, { onProgress, signal })
    : await ocrImage(blob, { onProgress, signal });

  const stats = summarise(res.blocks);
  await content.put(docId, res.blocks);
  await docs.put({
    ...doc,
    title: doc.title || titleFrom(res.meta, doc.source),
    words: stats.words,
    minutes: stats.minutes,
    ocr: true,
    needsOcr: false,
  });
  return await docs.get(docId);
}
