import { ZipReader } from '../core/zip.js';

/* DOCX: a ZIP whose word/document.xml holds a flat run of <w:p> paragraphs.
 * We only need text plus enough style information to tell headings apart. */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const localTag = (el, name) => [...el.children].filter(c => c.localName === name);

function paragraphText(p) {
  let out = '';
  // Walk in document order so tabs and breaks land in the right places.
  const walk = (node) => {
    for (const c of node.children) {
      switch (c.localName) {
        case 't':   out += c.textContent; break;
        case 'tab': out += '\t'; break;
        case 'br':  out += ' '; break;
        case 'noBreakHyphen': out += '-'; break;
        case 'softHyphen': break;
        case 'instrText': break;            // field codes, not content
        case 'delText': break;              // tracked deletion
        default:    walk(c);
      }
    }
  };
  walk(p);
  return out.replace(/\s+/g, ' ').trim();
}

function styleOf(p) {
  const pPr = localTag(p, 'pPr')[0];
  if (!pPr) return { style: '', outline: null, listed: false };
  const style = localTag(pPr, 'pStyle')[0]?.getAttributeNS(W, 'val')
             || localTag(pPr, 'pStyle')[0]?.getAttribute('w:val') || '';
  const outlineEl = localTag(pPr, 'outlineLvl')[0];
  const outline = outlineEl
    ? Number(outlineEl.getAttributeNS(W, 'val') ?? outlineEl.getAttribute('w:val'))
    : null;
  return { style, outline, listed: !!localTag(pPr, 'numPr').length };
}

export async function extractDocx(buffer, { onProgress } = {}) {
  const zip = await ZipReader.from(buffer);
  if (!zip.has('word/document.xml')) throw new Error('Not a Word (.docx) document');

  onProgress?.({ phase: 'Reading document', done: 0, total: 1 });

  const doc = await zip.xml('word/document.xml');
  const body = doc.getElementsByTagNameNS(W, 'body')[0]
            || [...doc.getElementsByTagName('*')].find(e => e.localName === 'body');
  if (!body) throw new Error('Word document has no body');

  const blocks = [];
  const nodes = [...body.getElementsByTagName('*')].filter(e => e.localName === 'p');

  for (const p of nodes) {
    const text = paragraphText(p);
    if (!text) continue;

    const { style, outline, listed } = styleOf(p);
    const headingLvl = /^heading(\d)/i.exec(style)?.[1];

    if (/^title$/i.test(style)) {
      blocks.push({ type: 'heading', text, level: 1 });
    } else if (headingLvl) {
      blocks.push({ type: 'heading', text, level: Number(headingLvl) <= 2 ? 1 : 2 });
    } else if (outline !== null && outline < 6) {
      blocks.push({ type: 'heading', text, level: outline <= 1 ? 1 : 2 });
    } else if (/^caption$/i.test(style) || /^(fig(ure)?\.?\s*\d|table\s*\d)/i.test(text)) {
      blocks.push({ type: 'caption', text });
    } else if (listed) {
      blocks.push({ type: 'para', text: /^[•\-*–]/.test(text) ? text : `• ${text}` });
    } else {
      blocks.push({ type: 'para', text });
    }
  }

  if (!blocks.length) throw new Error('No text found in this Word document');

  const meta = {};
  if (zip.has('docProps/core.xml')) {
    try {
      const core = await zip.xml('docProps/core.xml');
      const get = (n) => [...core.getElementsByTagName('*')]
        .find(e => e.localName === n)?.textContent?.trim() || null;
      meta.title = get('title') || undefined;
      meta.author = get('creator') || undefined;
    } catch { /* core props are optional */ }
  }
  if (!meta.title) {
    const h = blocks.find(b => b.type === 'heading') || blocks[0];
    meta.title = h.text.slice(0, 160);
  }

  onProgress?.({ phase: 'Reading document', done: 1, total: 1 });
  return { blocks, meta, needsOcr: false };
}
