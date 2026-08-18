/* Article extraction from HTML.
 *
 * A small Readability-style scorer rather than the real thing: it is ~150
 * lines instead of a 100 KB dependency, and because we only need block-level
 * prose (no images, no inline formatting) the simple version does the job.
 *
 * domToBlocks() is shared with the EPUB reader.
 */

const STRIP = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
  'form', 'button', 'input', 'select', 'textarea', 'video', 'audio',
  'nav', 'aside', 'footer[role]', 'dialog',
].join(',');

const JUNK_ATTR = /(^|[\s_-])(ad|ads|advert|banner|promo|share|social|comment|disqus|related|recommend|newsletter|signup|subscribe|paywall|cookie|consent|breadcrumb|sidebar|menu|nav|masthead|skip|toolbar|metrics|altmetric|citation-tools|footnote-back)([\s_-]|$)/i;

const KEEP_ATTR = /(^|[\s_-])(article|articlebody|art-body|body|content|main|post|entry|story|text|abstract|sec|section|fulltext|full-text|tsec)([\s_-]|$)/i;

/* ═══════════════════════════════════════════════════════ scoring ══════ */

function attrText(el) {
  return `${el.id || ''} ${el.className || ''}`.toString();
}

function visibleText(el) {
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

function scoreNode(el) {
  const text = visibleText(el);
  if (text.length < 25) return 0;
  let s = Math.min(text.length / 100, 30);
  s += (text.match(/[,;]/g) || []).length * 0.4;
  s += el.querySelectorAll('p').length * 3;
  s += el.querySelectorAll('h2,h3,h4').length * 1.5;

  const a = attrText(el);
  if (KEEP_ATTR.test(a)) s += 25;
  if (JUNK_ATTR.test(a)) s -= 40;
  if (el.tagName === 'ARTICLE') s += 30;
  if (el.tagName === 'MAIN') s += 20;
  if (el.getAttribute?.('role') === 'main') s += 20;

  // Link farms are navigation, not prose.
  const linkChars = [...el.querySelectorAll('a')]
    .reduce((n, x) => n + visibleText(x).length, 0);
  const density = linkChars / Math.max(text.length, 1);
  if (density > 0.45) s -= 35;
  else if (density > 0.28) s -= 12;

  return s;
}

function pickContent(doc) {
  for (const el of doc.querySelectorAll(STRIP)) el.remove();
  for (const el of [...doc.querySelectorAll('[hidden],[aria-hidden="true"]')]) {
    if (!el.querySelector('p')) el.remove();
  }

  const candidates = [...doc.querySelectorAll('article, main, section, div, [role="main"]')];
  let best = null, bestScore = 12;

  for (const el of candidates) {
    const s = scoreNode(el);
    if (s > bestScore) { best = el; bestScore = s; }
  }

  // A parent that scores nearly as well but holds more of the article (e.g.
  // an abstract plus a body split across siblings) is the better root.
  if (best) {
    let p = best.parentElement;
    let hops = 0;
    while (p && hops < 3 && p !== doc.body) {
      const ps = scoreNode(p);
      if (ps > bestScore * 1.12) { best = p; bestScore = ps; }
      p = p.parentElement; hops++;
    }
  }

  return best || doc.body || doc.documentElement;
}

/* ═══════════════════════════════════════════════════════ walking ═════ */

const BLOCK_SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dt,dd,figcaption,caption,td,th';

const isCaptionish = (el) =>
  el.tagName === 'FIGCAPTION' || el.tagName === 'CAPTION' ||
  JUNK_ATTR.test(attrText(el)) === false && /caption|figure|table-wrap|tblwrap/i.test(attrText(el));

/**
 * Turn a DOM subtree into typed blocks.
 * @returns {Array<{type:'heading'|'para'|'caption', text:string, level?:number}>}
 */
export function domToBlocks(root) {
  const blocks = [];
  const seen = new WeakSet();

  const push = (type, text, level) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return;
    const last = blocks[blocks.length - 1];
    if (last && last.type === type && last.text === t) return;   // dedupe
    blocks.push(level ? { type, text: t, level } : { type, text: t });
  };

  for (const el of root.querySelectorAll(BLOCK_SEL)) {
    // A <li> containing <p> would otherwise emit its text twice.
    if (seen.has(el)) continue;
    if (el.querySelector('p, li, blockquote')) continue;
    for (const d of el.querySelectorAll('*')) seen.add(d);

    const text = visibleText(el);
    if (!text) continue;

    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      push('heading', text, Number(tag[1]) <= 2 ? 1 : 2);
    } else if (isCaptionish(el) || /^(fig(ure)?\.?\s*\d|table\s*\d)/i.test(text)) {
      push('caption', text);
    } else if (tag === 'LI') {
      push('para', /^[•\-*–]/.test(text) ? text : `• ${text}`);
    } else if (tag === 'TD' || tag === 'TH') {
      // Table cells only earn a block when they hold a real sentence.
      if (text.length > 45) push('para', text);
    } else if (tag === 'PRE') {
      if (text.length < 400) push('para', text);
    } else {
      push('para', text);
    }
  }

  return blocks;
}

/* ═══════════════════════════════════════════════════════ entry ═══════ */

/**
 * @param {string} html
 * @param {string} [baseUrl]
 * @returns {{blocks:Array, meta:Object}}
 */
export function extractHtml(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const meta = {};
  const pick = (sel, attr = 'content') => {
    const el = doc.querySelector(sel);
    const v = el ? (attr === 'text' ? el.textContent : el.getAttribute(attr)) : null;
    return v && v.trim() ? v.trim() : null;
  };

  meta.title =
    pick('meta[property="og:title"]') ||
    pick('meta[name="citation_title"]') ||
    pick('meta[name="dc.Title"]') ||
    pick('title', 'text') ||
    pick('h1', 'text') ||
    (baseUrl ? new URL(baseUrl).hostname : 'Web page');

  const authors = [...doc.querySelectorAll('meta[name="citation_author"]')]
    .map(m => m.getAttribute('content')).filter(Boolean);
  if (authors.length) meta.author = authors.slice(0, 6).join(', ');
  else meta.author = pick('meta[name="author"]') || undefined;

  meta.published =
    pick('meta[name="citation_publication_date"]') ||
    pick('meta[property="article:published_time"]') || undefined;
  meta.journal = pick('meta[name="citation_journal_title"]') || undefined;
  meta.doi = pick('meta[name="citation_doi"]') || undefined;
  if (baseUrl) meta.url = baseUrl;

  // Titles from <title> usually carry a site suffix.
  meta.title = meta.title.replace(/\s*[|–—-]\s*[^|–—-]{2,40}$/, '').trim() || meta.title;

  const root = pickContent(doc);
  let blocks = domToBlocks(root);

  // Some publishers put the abstract outside the body container.
  const abstract = doc.querySelector('.abstract, #abstract, [id*="abstract" i], section[aria-label*="abstract" i]');
  if (abstract && !blocks.some(b => /^abstract/i.test(b.text))) {
    const ab = domToBlocks(abstract);
    if (ab.length) blocks = [{ type: 'heading', text: 'Abstract', level: 1 }, ...ab, ...blocks];
  }

  if (blocks.length && meta.title) {
    // Drop a leading block that just repeats the title.
    const t = blocks[0].text.toLowerCase();
    if (t === meta.title.toLowerCase()) blocks.shift();
  }

  return { blocks, meta };
}

/** Plain-text fallback for when scoring finds nothing usable. */
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll(STRIP)) el.remove();
  return (doc.body?.innerText || doc.body?.textContent || '').trim();
}
