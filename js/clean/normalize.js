/* Character-level cleanup and inline citation removal.
 *
 * normalize() is unconditional and lossless-ish: it only fixes things that are
 * artefacts of the source format (ligature glyphs, soft hyphens, smart quotes).
 *
 * stripCitations() is opt-in and deliberately conservative. Removing a real
 * statistic — "(p = 0.03)", "(95% CI 1.2–3.4)" — is far worse than leaving a
 * citation in, so anything that smells quantitative is kept.
 */

const LIGATURES = [
  [/ﬀ/g, 'ff'], [/ﬁ/g, 'fi'], [/ﬂ/g, 'fl'],
  [/ﬃ/g, 'ffi'], [/ﬄ/g, 'ffl'], [/ﬅ/g, 'st'], [/ﬆ/g, 'st'],
];

/* PDFs routinely set an accented letter as the base letter followed by a
 * *spacing* diacritic glyph, so "Kötter" extracts as "Ko¨tter". Mapping those
 * to their combining forms and running NFC puts the accent back where it
 * belongs — otherwise a synthesiser reads the stray mark as a pause. */
const SPACING_DIACRITICS = {
  '¨': '̈', '´': '́', '`': '̀',
  'ˆ': '̂', '˜': '̃', '˚': '̊',
  '¸': '̧', '¯': '̄', 'ˇ': '̌',
  '˘': '̆', '˙': '̇', '˝': '̋',
};
// The accent glyph is positioned separately, so it can arrive with stray
// spacing on either side ("Ko ¨ tter"). Both are absorbed: a spacing accent
// adjacent to a letter is always a broken composition, never real spacing.
const DIACRITIC_RE = new RegExp(
  `([\\p{L}])[ \\t]?([${Object.keys(SPACING_DIACRITICS).join('')}])[ \\t]?`, 'gu');

function refitDiacritics(s) {
  DIACRITIC_RE.lastIndex = 0;
  if (!DIACRITIC_RE.test(s)) return s;
  DIACRITIC_RE.lastIndex = 0;
  return s
    .replace(DIACRITIC_RE, (_, letter, mark) => letter + SPACING_DIACRITICS[mark])
    .normalize('NFC');
}

export function normalize(s) {
  if (!s) return '';
  let t = refitDiacritics(s);

  for (const [re, rep] of LIGATURES) t = t.replace(re, rep);

  t = t
    .replace(/[­​-‍⁠﻿]/g, '')   // soft hyphen, zero-width
    .replace(/[   ]/g, ' ')               // non-breaking spaces
    .replace(/[‘’‛ʼ]/g, "'")         // curly single quotes
    .replace(/[“”„″]/g, '"')         // curly double quotes
    .replace(/…/g, '...')
    .replace(/[‐‑]/g, '-')                     // hyphen variants
    .replace(/−/g, '-')                             // minus sign
    .replace(/\s+/g, ' ')
    .trim();

  // A dash used as parenthetical punctuation should read as a pause, but a
  // dash between numbers is a range and is handled later by the unit rules.
  t = t.replace(/\s+[–—]\s+/g, ', ');

  return t;
}

/* ═════════════════════════════════════════════════ citation removal ═══ */

// Vancouver style: [12]  [12,15]  [3–7]  [1, 4-6, 9]
const BRACKET_NUM = /\[\s*\d{1,3}(?:\s*[–—,;-]\s*\d{1,3})*\s*\]/g;

// Anything quantitative inside a parenthetical means "not a citation".
const QUANTITATIVE = /\b(?:p\s*[<>=≤≥]|n\s*=|CI\b|SD\b|SEM\b|IQR|df\s*=|r\s*=|R2|χ2|chi|HR\s*[=:]|OR\s*[=:]|RR\s*[=:]|AUC|mean|median|range|SE\s*=|β|beta\s*=|%|\d+\s*(?:mg|kg|mL|ml|µg|mcg|mmol|mmHg|years?|months?|weeks?|days?|hours?|patients?|participants?)\b)/i;

// Author-ish: a capitalised surname, an "et al.", or "X & Y".
const AUTHORISH = /(?:\bet\s+al\b|\b[A-Z][a-zA-ZÀ-ɏ'’-]{2,}\s*(?:&|\band\b)\s*[A-Z]|^[A-Z][a-zA-ZÀ-ɏ'’-]{2,})/;
const YEAR = /\b(?:1[5-9]|20)\d{2}[a-z]?\b/;

// Leading connectives that appear inside citation parentheticals.
const LEAD = /^(?:e\.?g\.?|i\.?e\.?|see(?:\s+also)?|cf\.?|reviewed\s+in|adapted\s+from|data\s+from|refs?\.?|but\s+see)[,:;]?\s*/i;

function looksLikeCitation(inner) {
  const body = inner.replace(LEAD, '').trim();
  if (!body) return false;
  if (body.length > 160) return false;
  if (QUANTITATIVE.test(body)) return false;
  if (!YEAR.test(body)) return false;
  if (!AUTHORISH.test(body)) return false;
  // Real prose in parentheses tends to contain lowercase function words.
  const words = body.split(/\s+/);
  const lower = words.filter(w => /^[a-z]{3,}$/.test(w) && !/^(and|et|al|see|in|of|the)$/.test(w));
  return lower.length <= Math.max(1, words.length * 0.3);
}

export function stripCitations(s) {
  if (!s) return '';
  let t = s.replace(BRACKET_NUM, '');

  // Author–year parentheticals. No nesting in practice, so one pass over
  // balanced-free groups is enough.
  t = t.replace(/\(([^()]{2,180})\)/g, (m, inner) =>
    looksLikeCitation(inner) ? '' : m);

  // Bare trailing "Smith et al., 2019" after a comma reads as noise too, but
  // only strip it when it sits at the very end of a sentence.
  t = t.replace(/,\s*(?:see\s+)?[A-Z][\w'’-]+(?:\s+(?:et\s+al\.?|and\s+[A-Z][\w'’-]+))?,?\s*\((?:1[5-9]|20)\d{2}\)\s*(?=[.;]|$)/g, '');

  return tidy(t);
}

/** Repair the punctuation left behind after removing something inline. */
export function tidy(s) {
  return s
    .replace(/\s+([,;:.!?])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .replace(/\s+([)\]])/g, '$1')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/([,;:])\s*([,;:.])/g, '$2')
    .replace(/\.{2,}(?!\.)/g, '.')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*[,;:]\s*/, '')
    .trim();
}

/* ═══════════════════════════════════════════════════════ noise ════════ */

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const DOI_RE = /\bdoi:?\s*10\.\d{4,9}\/[^\s"'<>]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;

/** Web addresses read aloud character by character are unbearable and carry
 *  no information you can act on while your hands are busy. */
export function stripAddresses(s) {
  return tidy(s
    .replace(DOI_RE, '')
    .replace(URL_RE, '')
    .replace(EMAIL_RE, ''));
}

/* The masthead block journals stamp on the first page. None of it is the
 * paper, and all of it is unpleasant read aloud. */
const FRONT_MATTER = /^(citation|published|copyright|received|accepted|submitted|revised|editor|academic\s+editor|data\s+availability|funding|competing\s+interests?|conflicts?\s+of\s+interest|correspondence|reprints?|peer\s+review|article\s+history|keywords?|abbreviations?|orcid|how\s+to\s+cite|licen[cs]e)\s*[:.]/i;

/** True when a block is masthead, a table row, a figure label or decorative
 *  glyph runs — matter that is never worth hearing.
 *  @param {string} text
 *  @param {string} [type]  block type, so headings escape the length rule */
export function isNoiseBlock(text, type = 'para') {
  const t = text.trim();
  if (t.length < 3) return true;
  if (/^[\d\s.,;:|/–—-]+$/.test(t)) return true;                 // numbers only
  if (FRONT_MATTER.test(t)) return true;
  if (/^(this\s+article|open\s+access|creative\s+commons)\b/i.test(t) && t.length < 300) return true;

  // Decorative runs: PLOS stamps "a1111111111" down the margin, other
  // publishers use rules of repeated glyphs. No prose repeats a character
  // six times.
  if (/(.)\1{5,}/.test(t)) return true;

  // No vowel anywhere means it is not language.
  if (!/[aeiouyAEIOUY]/.test(t)) return true;

  // Axis labels and diagram callouts extracted from figures: very short, and
  // never punctuated as a sentence. Headings are exempt.
  if (type !== 'heading' && t.length < 17 && !/[.!?:]$/.test(t) && !/^[•\-–]/.test(t)) return true;

  // Mostly digits and punctuation is a table row.
  const digits = (t.match(/[\d.,%]/g) || []).length;
  if (t.length > 12 && digits / t.length > 0.55) return true;

  // Table rows survive the digit test when they mix codes and numbers
  // ("conv3 x 28×28 ×2 ×4 3×3, 128"). Prose is mostly made of actual words.
  const tokens = t.split(/\s+/).filter(Boolean);
  if (t.length > 16 && tokens.length >= 4) {
    const wordy = tokens.filter(w => /^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’-]{2,}[.,;:)]?$/.test(w)).length;
    if (wordy / tokens.length < 0.4) return true;
  }

  // Figure innards often extract as one word repeated across the diagram.
  if (tokens.length >= 3 && new Set(tokens.map(w => w.toLowerCase())).size === 1) return true;

  // A heading carrying two or more numbered tokens is a table header row
  // ("method top-1 err. top-5 err."), not a section title. One is normal —
  // "3.1 Residual Learning", "Table 2".
  if (type === 'heading' && tokens.filter(w => /\d/.test(w)).length >= 2) return true;

  return false;
}

/** A speech string can be gutted by citation and URL removal until nothing
 *  meaningful is left ("See [12]." -> "See."). Those should be passed over
 *  silently rather than spoken.
 *
 *  A single word still counts when it is long enough to be a real one, which
 *  is what keeps one-word section headings — "Methods", "Results" — audible. */
export function isSpeakable(s) {
  const words = (s.match(/[A-Za-zÀ-ɏ]{2,}/g) || []);
  if (!words.length) return false;
  if (words.join('').length < 4) return false;
  return words.length >= 2 || words[0].length >= 4;
}
