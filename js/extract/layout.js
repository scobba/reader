/* Page layout analysis.
 *
 * A PDF stores glyphs at coordinates, not paragraphs. Concatenating pdf.js's
 * text items in their native order reads straight across a two-column journal
 * page and produces nonsense. So we recover the layout geometrically:
 *
 *   1. recursive XY-cut  -> regions in true reading order
 *   2. baseline clustering -> lines within each region
 *   3. gap / margin analysis -> paragraphs and headings
 *
 * The XY-cut prefers vertical cuts, which is what makes a full-width title
 * sitting above two columns come out right: the title blocks any full-height
 * gutter, so the page is cut horizontally first (title | body), and only then
 * is the body cut vertically into columns.
 *
 * Coordinates here are top-down (y grows downward), unlike PDF's own.
 * An atom is one pdf.js text item:
 *   { x0, x1, top, bot, base, size, text, bold, italic }
 */

/* ═══════════════════════════════════════════════════════════ tuning ═══ */

const MAX_DEPTH = 14;

// A gutter must be at least this many times the local font size to count.
const V_GAP_MIN_EMS = 1.15;
// A blank horizontal band must be at least this tall to cut on.
const H_GAP_MIN_EMS = 0.95;
// A region narrower than this fraction of the page cannot hold two columns.
const V_MIN_REGION_W = 0.34;
// Neither side of a vertical cut may be narrower than this fraction of a page.
const V_MIN_SIDE_W = 0.10;
// Header/footer band, as a fraction of page height.
const MARGIN_BAND = 0.075;

/* ═══════════════════════════════════════════════════════════ helpers ══ */

const median = (xs) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function bbox(atoms) {
  let x0 = Infinity, x1 = -Infinity, top = Infinity, bot = -Infinity;
  for (const a of atoms) {
    if (a.x0 < x0) x0 = a.x0;
    if (a.x1 > x1) x1 = a.x1;
    if (a.top < top) top = a.top;
    if (a.bot > bot) bot = a.bot;
  }
  return { x0, x1, top, bot, w: x1 - x0, h: bot - top };
}

/** Typical baseline-to-baseline distance in a group of atoms.
 *
 *  The horizontal cut threshold cannot be expressed in font sizes alone.
 *  pdf.js reports a tight font size, but OCR word boxes span ascender to
 *  descender, so the same layout yields relatively larger inter-line gaps and
 *  a font-relative threshold slices every single line into its own region.
 *  Line pitch is the source-independent measure of "how far apart is normal". */
function linePitch(atoms) {
  const rows = [...new Set(atoms.map(a => Math.round(a.base)))].sort((p, q) => p - q);
  if (rows.length < 3) return 0;
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i] - rows[i - 1];
    if (d > 0.5) gaps.push(d);
  }
  return median(gaps);
}

/** Widest uncovered interval along one axis, found by a sweep over the
 *  projected atom extents. Edges are excluded: only interior gaps split. */
function widestGap(intervals, minWidth) {
  if (intervals.length < 2) return null;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let reach = sorted[0][1];
  let best = null;

  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s > reach) {
      const width = s - reach;
      if (width >= minWidth && (!best || width > best.width)) {
        best = { at: reach + width / 2, width, before: reach, after: s };
      }
    }
    if (e > reach) reach = e;
  }
  return best;
}

/* ═══════════════════════════════════════════════════════════ XY-cut ═══ */

/**
 * Split a page's atoms into regions ordered the way a human reads them.
 * @returns {Array<{atoms:Array, box:Object}>}
 */
export function xyCut(atoms, page) {
  const out = [];
  recurse(atoms, 0);
  return out;

  function recurse(group, depth) {
    if (group.length === 0) return;
    if (group.length < 3 || depth >= MAX_DEPTH) { emit(group); return; }

    const box = bbox(group);
    const em = median(group.map(a => a.size)) || 10;

    // ── vertical cut (columns) ────────────────────────────────────────
    // Guarded hard: a false gutter scrambles reading order far more badly
    // than a missed one, and short ragged-right paragraphs can easily leave
    // a spurious column of whitespace.
    if (box.w >= V_MIN_REGION_W * page.width) {
      const gap = widestGap(
        group.map(a => [a.x0, a.x1]),
        Math.max(V_GAP_MIN_EMS * em, 0.018 * page.width),
      );
      if (gap) {
        const left  = group.filter(a => a.x1 <= gap.at);
        const right = group.filter(a => a.x1 > gap.at);
        const okSide = (s) => {
          if (s.length < 3) return false;
          const b = bbox(s);
          return b.w >= V_MIN_SIDE_W * page.width;
        };
        if (okSide(left) && okSide(right)) {
          recurse(left, depth + 1);
          recurse(right, depth + 1);
          return;
        }
      }
    }

    // ── horizontal cut (stacked blocks) ───────────────────────────────
    // Only structural breaks matter here — separating a title from the body,
    // or a figure from its column. Ordinary paragraph spacing is handled
    // later by linesToBlocks, so a conservative threshold costs nothing.
    const pitch = linePitch(group);
    const hgap = widestGap(
      group.map(a => [a.top, a.bot]),
      Math.max(H_GAP_MIN_EMS * em, 0.7 * pitch),
    );
    if (hgap) {
      const above = group.filter(a => a.bot <= hgap.at);
      const below = group.filter(a => a.bot > hgap.at);
      if (above.length && below.length) {
        recurse(above, depth + 1);
        recurse(below, depth + 1);
        return;
      }
    }

    emit(group);
  }

  function emit(group) {
    if (group.length) out.push({ atoms: group, box: bbox(group) });
  }
}

/* ═══════════════════════════════════════════════════════════ lines ════ */

/** Cluster a region's atoms into lines by baseline, then order left to right.
 *  Superscript reference markers are detected here, while we still know the
 *  surrounding line's font size — after flattening to text it is too late. */
function regionToLines(region, page, pageNum) {
  const atoms = [...region.atoms].sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const lines = [];
  let cur = null;

  for (const a of atoms) {
    if (!cur) { cur = { atoms: [a] }; continue; }
    const em = median(cur.atoms.map(x => x.size)) || a.size;
    // Superscripts sit high but belong to the line, so the tolerance is
    // generous upward.
    if (Math.abs(a.base - cur.atoms[0].base) <= 0.62 * em) {
      cur.atoms.push(a);
    } else {
      lines.push(cur);
      cur = { atoms: [a] };
    }
  }
  if (cur) lines.push(cur);

  return lines.map(l => finishLine(l, region, page, pageNum)).filter(Boolean);
}

function finishLine(line, region, page, pageNum) {
  const parts = [...line.atoms].sort((a, b) => a.x0 - b.x0);
  const bodySize = median(parts.map(p => p.size)) || 10;
  const baseline = median(parts.map(p => p.base));

  let text = '';
  let dropped = 0;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];

    // Superscript numerals / symbols = Vancouver-style citation markers.
    const raised = p.base < baseline - 0.14 * bodySize;
    const small  = p.size < 0.80 * bodySize;
    if (raised && small && /^[\d\s,;.–—*†‡-]+$/.test(p.text) && p.text.trim()) {
      p.isCitation = true;
      dropped++;
      continue;
    }

    if (text) {
      const prev = parts[i - 1];
      const gap = p.x0 - (prev ? prev.x1 : p.x0);
      const needsSpace = gap > 0.20 * bodySize;
      if (needsSpace && !/\s$/.test(text) && !/^\s/.test(p.text)) text += ' ';
    }
    text += p.text;
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const box = bbox(parts);
  const bold = parts.some(p => p.bold) &&
               parts.filter(p => p.bold).length >= parts.length / 2;

  return {
    text,
    size: bodySize,
    base: baseline,
    x0: box.x0, x1: box.x1, top: box.top, bot: box.bot,
    bold,
    page: pageNum,
    col: { left: region.box.x0, right: region.box.x1, width: region.box.w },
    inTopBand: box.top < page.height * MARGIN_BAND,
    inBotBand: box.bot > page.height * (1 - MARGIN_BAND),
    droppedCitations: dropped,
  };
}

/** Full page: atoms in, ordered lines out. */
export function pageLines(atoms, page, pageNum) {
  const usable = atoms.filter(a => a.text && a.text.trim());
  if (!usable.length) return [];
  const regions = xyCut(usable, page);
  const lines = [];
  for (const r of regions) lines.push(...regionToLines(r, page, pageNum));
  return lines;
}

/* ══════════════════════════════════════════ running heads & footers ═══ */

const FOOTER_JUNK = [
  /^\s*\d{1,4}\s*$/,                            // bare page number
  /^\s*[ivxlcdm]{1,7}\s*$/i,                    // roman page number
  /^page\s+\d+(\s+of\s+\d+)?$/i,
  /downloaded\s+from/i,
  /this\s+content\s+downloaded/i,
  /all\s+rights?\s+reserved/i,
  /^\s*(https?:\/\/|www\.)\S+\s*$/i,
  /^\s*doi:?\s*10\.\d{4,}/i,
  /©\s*\d{4}/,
  /^\s*\d{1,4}\s+[A-Z][a-z]+\s+\d{4}\s*$/,      // "12 March 2019"
  /jstor|springer nature|elsevier ltd|wolters kluwer/i,
];

/** Remove repeated running heads, footers and page numbers.
 *  A line is only dropped when it recurs across several pages in the same
 *  margin band, so a genuine one-off line near the top of a page survives. */
export function stripRunningHeads(lines, pageCount) {
  if (pageCount < 3) {
    return lines.filter(l => !(
      (l.inTopBand || l.inBotBand) && FOOTER_JUNK.some(re => re.test(l.text))
    ));
  }

  const norm = (t) => t.toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^\w#]+/g, ' ')
    .trim();

  const seen = new Map();   // key -> Set of page numbers
  for (const l of lines) {
    if (!l.inTopBand && !l.inBotBand) continue;
    const k = (l.inTopBand ? 'T:' : 'B:') + norm(l.text);
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k).add(l.page);
  }

  const threshold = Math.max(2, Math.ceil(pageCount * 0.34));
  const repeated = new Set();
  for (const [k, pages] of seen) if (pages.size >= threshold) repeated.add(k);

  return lines.filter(l => {
    if (!l.inTopBand && !l.inBotBand) return true;
    const k = (l.inTopBand ? 'T:' : 'B:') + norm(l.text);
    if (repeated.has(k)) return false;
    if (FOOTER_JUNK.some(re => re.test(l.text))) return false;
    return true;
  });
}

/* ═══════════════════════════════════════════════════════ paragraphs ═══ */

const HEADING_WORDS = /^(abstract|summary|background|introduction|objectives?|aims?|methods?|materials?\s+and\s+methods?|study\s+design|participants?|patients?\s+and\s+methods?|statistical\s+analysis|results?|findings?|discussion|conclusions?|limitations?|implications?|references?|bibliography|acknowledge?ments?|funding|conflicts?\s+of\s+interest|competing\s+interests?|author\s+contributions?|data\s+availability|supplementary(\s+\w+)*|appendix|keywords?|highlights?)\b/i;

const NUMBERED_HEADING = /^\d+(\.\d+)*\.?\s+\S/;
const LIST_MARKER = /^([•·▪◦‣–—-]|\(?[a-z]\)|\(?\d{1,2}[.)])\s+/i;

/** Rejoin a line to the previous one, repairing a hyphen break.
 *
 *  We drop the hyphen rather than keep it. Both choices are wrong sometimes
 *  ("non-inferiority" -> "noninferiority"), but keeping it is wrong in the
 *  worse direction for speech: "pre-sented" makes a synthesiser say two
 *  words. A capital or digit after the hyphen means it was a real compound
 *  ("anti-CD20", "COVID-19"), so that case keeps it.
 */
function joinWrapped(a, b) {
  if (/­$/.test(a)) return a.slice(0, -1) + b;
  if (/[\p{L}]-$/u.test(a)) {
    if (/^[\p{Lu}\d]/u.test(b)) return a + b;
    return a.slice(0, -1) + b;
  }
  return a + ' ' + b;
}

/**
 * Merge ordered lines into typed blocks.
 * @returns {Array<{type:'heading'|'para'|'caption', text:string, page:number, level?:number}>}
 */
export function linesToBlocks(lines) {
  if (!lines.length) return [];

  // Body size = the size most of the document's characters are set in.
  const weight = new Map();
  for (const l of lines) {
    const k = Math.round(l.size * 2) / 2;
    weight.set(k, (weight.get(k) || 0) + l.text.length);
  }
  let bodySize = 10, bestW = -1;
  for (const [k, w] of weight) if (w > bestW) { bestW = w; bodySize = k; }

  // Baseline-to-baseline distance for normal body leading. Measuring the step
  // between lines rather than the visual gap between their boxes makes the
  // paragraph test independent of how the source reports glyph size — pdf.js
  // gives a tight font size, OCR gives ascender-to-descender word boxes, and
  // a gap threshold in font sizes only works for one of them.
  const steps = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (a.page !== b.page || Math.abs(a.col.left - b.col.left) >= 2) continue;
    const d = b.base - a.base;
    if (d > 0 && d < bodySize * 4) steps.push(d);
  }
  const pitch = median(steps);

  const isHeading = (l, prevGap) => {
    const t = l.text.trim();
    if (t.length > 130) return false;
    const big = l.size >= bodySize * 1.13;
    const short = t.length <= 90;
    const named = HEADING_WORDS.test(t) && t.length <= 70;
    const numbered = NUMBERED_HEADING.test(t) && short;
    const allCaps = /^[^a-z]{4,}$/.test(t) && /[A-Z]{3}/.test(t) && short;
    const endsClean = !/[,;:]$/.test(t);

    if (big && short && endsClean) return true;
    if (named && (l.bold || big || allCaps || prevGap > l.size * 0.9)) return true;
    if (numbered && (l.bold || big)) return true;
    if (allCaps && prevGap > l.size * 0.8 && !/\.$/.test(t)) return true;
    if (l.bold && short && endsClean && prevGap > l.size * 0.85 && !/\.$/.test(t)) return true;
    return false;
  };

  const isCaption = (t) =>
    /^(fig(ure)?\.?\s*\d|table\s*\d|chart\s*\d|scheme\s*\d|exhibit\s*\d|box\s*\d|supplementary\s+(fig|table))/i.test(t.trim());

  const blocks = [];
  let cur = null;
  let prev = null;

  const flush = () => { if (cur && cur.text.trim()) blocks.push(cur); cur = null; };

  for (const l of lines) {
    const sameCol = prev && prev.page === l.page &&
                    Math.abs(prev.col.left - l.col.left) < 2;
    const gap = sameCol ? l.top - prev.bot : Infinity;

    if (isHeading(l, sameCol ? gap : l.size)) {
      flush();
      blocks.push({
        type: 'heading',
        text: l.text,
        page: l.page,
        level: l.size >= bodySize * 1.35 ? 1 : 2,
      });
      prev = l;
      continue;
    }

    // A line that neither closes a sentence nor is followed by a capital is
    // mid-sentence, whatever the geometry suggests. Without this veto,
    // ragged-right text breaks at every short line, and each fragment then
    // gets spoken as if it were its own sentence — full stop and all.
    const continues = prev && !/[.!?:;]["'’”)\]]?$/.test(prev.text) &&
                      /^[\p{Ll}]/u.test(l.text);

    let breakHere = !cur;
    if (!breakHere) {
      // A blank band, an indent, a short previous line, a list marker or a
      // new column each mean the previous paragraph ended.
      const step = sameCol ? l.base - prev.base : Infinity;
      if (!sameCol) {
        // In a two-column paper a paragraph runs off the bottom of the left
        // column and resumes at the top of the right one, and again across
        // every page turn. Breaking unconditionally chops roughly one
        // sentence per page in half, so an unfinished line followed by a
        // lowercase start is stitched back together.
        breakHere = !(continues && cur.type === 'para' && !isCaption(l.text));
      }
      else if (pitch > 0 ? step > pitch * 1.32 : gap > l.size * 0.78) breakHere = true;
      else if (l.x0 > prev.x0 + l.size * 1.1) breakHere = true;
      else if (prev.x1 < prev.col.right - l.size * 2.2 && !continues) breakHere = true;
      else if (LIST_MARKER.test(l.text)) breakHere = true;
      else if (isCaption(l.text)) breakHere = true;
    }

    if (breakHere) {
      flush();
      cur = {
        type: isCaption(l.text) ? 'caption' : 'para',
        text: l.text,
        page: l.page,
      };
    } else {
      cur.text = joinWrapped(cur.text, l.text);
    }
    prev = l;
  }
  flush();

  return blocks;
}

/** Heuristic for "this page had no usable text layer".
 *  A scan yields either nothing at all or a handful of stray glyphs, while
 *  even a sparse title page carries a few hundred characters. The bar is
 *  deliberately low: a figure-only page inside a normal article trips this
 *  too, which is why the caller only concludes "scanned" when most of the
 *  document's pages do. */
export function looksScanned(lines, page) {
  const chars = lines.reduce((n, l) => n + l.text.length, 0);
  const sqIn = (page.width / 72) * (page.height / 72);   // PDF units are 1/72"
  return chars < Math.max(80, 2.5 * sqIn);
}
