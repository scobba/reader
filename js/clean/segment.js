import { MAX_SENTENCE_CHARS } from '../config.js';

/* Sentence segmentation.
 *
 * Naive splitting on /[.!?]\s/ destroys scientific prose: "p < 0.05", "Fig. 3",
 * "Smith et al. showed", "E. coli", "approx. 40 mg" all break in the wrong
 * place, and a mid-sentence cut is instantly audible because the synthesiser
 * drops its intonation and pauses.
 *
 * This is a hand-rolled scanner rather than a regex so each rejection reason
 * stays readable, and so the "no whitespace after the period" case (very
 * common in PDFs where a space was lost) can be judged on its own.
 */

const ABBREV = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'jr', 'sr', 'rev', 'hon',
  'vs', 'etc', 'al', 'cf', 'ca', 'approx', 'viz', 'ibid', 'eg', 'ie',
  'fig', 'figs', 'tab', 'tabs', 'eq', 'eqs', 'ref', 'refs', 'no', 'nos',
  'pp', 'p', 'vol', 'ed', 'eds', 'chap', 'sect', 'sec', 'suppl', 'appx',
  'inc', 'ltd', 'co', 'corp', 'dept', 'univ', 'est', 'min', 'max',
  'i.e', 'e.g', 'et', 'mg', 'ml', 'kg', 'cm', 'mm',
]);

const OPENERS = '"\'“‘([{';
const CLOSERS = '"\'”’)]}';

/** "Figure 3", "Table 1", "Eq. 4" — matched against everything before the
 *  period, so it only fires when the label opens the block. */
const CAPTION_LABEL =
  /^\s*(fig(ure)?|table|chart|scheme|box|exhibit|panel|eq(uation)?|ref(erence)?|supplementary\s+\w+)\.?\s*\d+[a-z]?$/i;

const isUpper = (c) => c >= 'A' && c <= 'Z';
const isDigit = (c) => c >= '0' && c <= '9';
const isAlpha = (c) => /[A-Za-zÀ-ɏ]/.test(c);

/** Word immediately before position i (exclusive), lowercased, no punctuation. */
function wordBefore(text, i) {
  let j = i;
  while (j > 0 && /[A-Za-z.]/.test(text[j - 1])) j--;
  return text.slice(j, i).toLowerCase().replace(/^\.+/, '');
}

function isBoundary(text, i) {
  const c = text[i];
  const prev = text[i - 1] || '';
  const next = text[i + 1] || '';

  if (c === '!' || c === '?') return true;

  // Ellipsis: only the final dot can end a sentence.
  if (c === '.' && next === '.') return false;
  if (c === '.' && prev === '.') {
    // "..." followed by a capital does end a sentence.
    return /\s/.test(next) && startsSentence(text, i + 1);
  }

  if (c !== '.') return false;

  // 0.05 — a decimal point.
  if (isDigit(prev) && isDigit(next)) return false;

  // "J. R. Smith" and "E. coli": a lone capital before the dot.
  if (isUpper(prev) && !isAlpha(text[i - 2] || ' ')) return false;

  // Known abbreviation.
  const w = wordBefore(text, i);
  if (ABBREV.has(w)) return false;
  // "U.S." / "e.g." — the dotted form arrives here as "s"/"g" after stripping.
  if (w.length === 1 && isAlpha(prev) && text[i - 2] === '.') return false;

  // A numbered list marker or section number: "3." or "2.1."
  if (isDigit(prev) && /^\s*$/.test(text.slice(0, i).split('\n').pop().replace(/[\d.]/g, ''))) {
    return false;
  }

  // A caption label belongs to the caption it introduces. Splitting
  // "Table 1. Baseline characteristics." leaves "Table 1." alone, which then
  // reads as a fragment or gets dropped entirely — so the reader never hears
  // which table it is looking at.
  if (isDigit(prev) && CAPTION_LABEL.test(text.slice(0, i))) return false;

  return startsSentence(text, i + 1);
}

/** Does a new sentence plausibly begin at or after position j? */
function startsSentence(text, j) {
  let k = j;
  const hadSpace = /\s/.test(text[k] || ' ') || k >= text.length;
  while (k < text.length && /\s/.test(text[k])) k++;
  while (k < text.length && OPENERS.includes(text[k])) k++;

  if (k >= text.length) return true;
  const c = text[k];

  // Lowercase start means the period was not a full stop — unless a space is
  // genuinely missing, which we cannot recover from anyway.
  if (!isUpper(c) && !isDigit(c) && !'•—–'.includes(c)) return false;

  // "40 mg. 30 patients" — a digit start is ambiguous, so require a space.
  if (isDigit(c) && !hadSpace) return false;

  return true;
}

/** Break an over-long sentence at the most natural interior punctuation. */
function softSplit(s, limit) {
  if (s.length <= limit) return [s];

  const out = [];
  let rest = s;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = -1;

    for (const re of [/;\s(?=\S)/g, /:\s(?=\S)/g, /,\s(?=\S)/g, /\s(?=\S)/g]) {
      let m, last = -1;
      // Prefer a break past the halfway mark so neither half is a fragment.
      while ((m = re.exec(window)) !== null) {
        if (m.index > limit * 0.45) { last = m.index + m[0].length; break; }
        last = m.index + m[0].length;
      }
      if (last > limit * 0.35) { cut = last; break; }
    }

    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function splitSentences(text, limit = MAX_SENTENCE_CHARS) {
  const src = (text || '').replace(/\s+/g, ' ').trim();
  if (!src) return [];

  const parts = [];
  let start = 0;

  for (let i = 0; i < src.length; i++) {
    if (!'.!?…'.includes(src[i])) continue;
    if (!isBoundary(src, i)) continue;

    // Absorb trailing quotes and brackets into the sentence that owns them.
    let end = i + 1;
    while (end < src.length && CLOSERS.includes(src[end])) end++;
    // Multiple terminators: "What?!"
    while (end < src.length && '.!?'.includes(src[end])) end++;

    const piece = src.slice(start, end).trim();
    if (piece) parts.push(piece);
    start = end;
  }

  const tail = src.slice(start).trim();
  if (tail) parts.push(tail);

  const out = [];
  for (const p of parts) out.push(...softSplit(p, limit));
  return out;
}
