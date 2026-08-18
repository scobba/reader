import { ZipReader } from '../core/zip.js';
import { domToBlocks } from './html.js';

/* EPUB is a ZIP of XHTML plus an OPF package document that declares the
 * reading order. We follow the spine rather than the file order, because
 * they routinely disagree. */

const resolve = (base, rel) => {
  if (/^[a-z]+:/i.test(rel)) return rel;
  const stack = base.split('/').slice(0, -1);
  for (const part of decodeURIComponent(rel).split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
};

export async function extractEpub(buffer, { onProgress, signal } = {}) {
  const zip = await ZipReader.from(buffer);

  // container.xml points at the OPF; a few broken files omit it, so fall back
  // to whatever .opf we can find.
  let opfPath = null;
  if (zip.has('META-INF/container.xml')) {
    const c = await zip.xml('META-INF/container.xml');
    opfPath = c.querySelector('rootfile')?.getAttribute('full-path') || null;
  }
  if (!opfPath) opfPath = zip.list(/\.opf$/i)[0];
  if (!opfPath) throw new Error('Not a readable EPUB (no package document)');

  const opf = await zip.xml(opfPath);

  const meta = {};
  const dc = (name) => {
    const el = [...opf.querySelectorAll('*')].find(
      e => e.localName === name && /dc/i.test(e.namespaceURI || e.prefix || 'dc'));
    return el?.textContent?.trim() || null;
  };
  meta.title = dc('title') || 'EPUB';
  meta.author = dc('creator') || undefined;
  meta.published = dc('date') || undefined;

  // manifest id -> href
  const hrefById = new Map();
  const typeById = new Map();
  for (const item of opf.querySelectorAll('manifest > item')) {
    const id = item.getAttribute('id');
    if (!id) continue;
    hrefById.set(id, resolve(opfPath, item.getAttribute('href') || ''));
    typeById.set(id, item.getAttribute('media-type') || '');
  }

  const spine = [...opf.querySelectorAll('spine > itemref')]
    .map(r => r.getAttribute('idref'))
    .filter(id => id && hrefById.has(id))
    .filter(id => /xhtml|html|xml/i.test(typeById.get(id) || 'xhtml'))
    .map(id => hrefById.get(id));

  const order = spine.length ? spine : zip.list(/\.x?html?$/i).sort();

  const blocks = [];
  for (let i = 0; i < order.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    onProgress?.({ phase: 'Reading chapters', done: i, total: order.length,
                   detail: `Section ${i + 1} of ${order.length}` });

    const path = order[i];
    if (!zip.has(path)) continue;

    let doc;
    try { doc = await zip.xml(path, 'application/xhtml+xml'); } catch { continue; }

    const body = doc.body || doc.documentElement;
    if (!body) continue;

    // The navigation document is a table of contents, not prose.
    if (body.querySelector('nav[epub\\:type="toc"], nav#toc')) continue;

    const part = domToBlocks(body);
    if (!part.length) continue;

    // Link chapters back to their file so we can order and label them.
    for (const b of part) b.src = path;
    blocks.push(...part);
  }

  if (!blocks.length) throw new Error('No readable text found in this EPUB');
  meta.pages = order.length;
  return { blocks, meta, needsOcr: false };
}
