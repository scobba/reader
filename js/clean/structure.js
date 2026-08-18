import { normalize, stripCitations, stripAddresses, isNoiseBlock, isSpeakable, tidy } from './normalize.js';
import { expandForSpeech, isAcronymSoup } from './abbrev.js';
import { splitSentences } from './segment.js';

/* Blocks in, a playable script out.
 *
 * Everything downstream of extraction happens here and is re-runnable: change
 * a cleanup setting and we rebuild from the stored blocks, no re-parsing of
 * the original file. That is why the extractors deliberately keep citations
 * and reference lists rather than discarding them at parse time.
 */

const REFERENCE_HEADING =
  /^\s*(references?|reference\s+list|bibliography|literature\s+cited|works\s+cited|citations)\s*[:.]?\s*$/i;

const BACKMATTER_HEADING =
  /^\s*(acknowledge?ments?|funding(\s+(statement|sources?))?|conflicts?\s+of\s+interest|competing\s+interests?|declarations?(\s+of\s+interest)?|disclosures?|author\s+contributions?|data\s+availability(\s+statement)?|ethics(\s+(statement|approval))?|supplementary(\s+\w+)*|appendi(x|ces)|abbreviations?|orcid|about\s+the\s+authors?)\s*[:.]?\s*$/i;

/** A reference list is recognisable even without a heading: dense, numbered,
 *  full of initials and years. Used only once we are already past the body. */
function looksLikeReference(text) {
  if (text.length < 25) return false;
  const hasYear = /\b(19|20)\d{2}[a-z]?[.;)]/.test(text);
  const hasInitials = /\b[A-Z][a-z]+,?\s+[A-Z]{1,3}[.,]/.test(text);
  const hasJournal = /\b(J|Am|Br|Eur|N\s?Engl|Lancet|BMJ|JAMA|Nature|Science|Proc|Ann|Arch|Int)\b\.?\s/.test(text);
  const hasPages = /\b\d+\s*[:(]\s*\d+/.test(text) || /\b\d+[–-]\d+\b\s*\.?\s*$/.test(text);
  return (hasYear && (hasInitials || hasJournal)) || (hasInitials && hasPages);
}

/**
 * @param {Array} rawBlocks
 * @param {object} opts  the settings object
 * @returns {{blocks:Array, sentences:Array, outline:Array, stats:Object}}
 */
export function buildScript(rawBlocks, opts) {
  const {
    skipCitations = true,
    skipRefs = true,
    skipCaptions = false,
    expandAbbrev = true,
    announceHeadings = true,
  } = opts || {};

  /* ── 1. zone each block ─────────────────────────────────────────── */
  const blocks = [];
  let zone = 'body';
  let section = null;
  let sawBodyHeading = false;
  let refRun = 0;

  for (const b of rawBlocks) {
    const text = normalize(b.text);
    if (!text) continue;

    if (b.type === 'heading') {
      if (REFERENCE_HEADING.test(text)) { zone = 'references'; refRun = 0; }
      else if (BACKMATTER_HEADING.test(text)) { zone = 'backmatter'; refRun = 0; }
      else if (zone === 'body') sawBodyHeading = true;
      else {
        // A normal-looking heading after the references usually means an
        // appendix or a second article stapled to the first. Either way it is
        // not body text you want mixed back in.
        zone = 'backmatter';
      }
      section = text;
      blocks.push({ ...b, text, zone, section: text });
      continue;
    }

    // Unheaded reference list: three consecutive reference-shaped paragraphs
    // is enough evidence, and only once the body has properly started.
    if (zone === 'body' && sawBodyHeading && looksLikeReference(text)) {
      if (++refRun >= 3) {
        zone = 'references';
        // Retroactively rezone the two that tipped us off.
        for (let k = blocks.length - 1, n = 0; k >= 0 && n < 2; k--) {
          if (blocks[k].type === 'heading') break;
          blocks[k].zone = 'references';
          n++;
        }
      }
    } else if (zone === 'body') {
      refRun = 0;
    }

    blocks.push({ ...b, text, zone, section });
  }

  /* ── 2. flatten to sentences ────────────────────────────────────── */
  const sentences = [];
  const outline = [];
  let words = 0;

  blocks.forEach((b, blockIdx) => {
    b.first = sentences.length;

    const structurallySkipped =
      (b.zone === 'references' && skipRefs) ||
      (b.zone === 'backmatter' && skipRefs) ||
      (b.type === 'caption' && skipCaptions);

    const noise = isNoiseBlock(b.text, b.type) || isAcronymSoup(b.text);

    // Table rows are routinely mistaken for headings by the layout pass
    // ("method top-1 err. top-5 err."). Keeping them out of the outline is
    // what stops the section list filling up with table fragments.
    if (b.type === 'heading' && !noise) {
      outline.push({
        title: b.text,
        level: b.level || 2,
        sentenceIndex: sentences.length,
        zone: b.zone,
      });
    }

    for (const raw of splitSentences(b.text)) {
      // Display text keeps the author's wording; only `speak` is rewritten.
      let speak = stripAddresses(raw);
      if (skipCitations) speak = stripCitations(speak);
      speak = expandForSpeech(tidy(speak), expandAbbrev);

      const skip = structurallySkipped || noise || !isSpeakable(speak);

      if (!skip) words += raw.split(/\s+/).length;

      sentences.push({
        i: sentences.length,
        blockIdx,
        type: b.type,
        zone: b.zone,
        section: b.section || null,
        text: raw,
        speak,
        skip,
        pauseBefore: b.type === 'heading' && announceHeadings ? 550 : 0,
      });
    }

    b.last = sentences.length - 1;
  });

  /* ── 3. summary ─────────────────────────────────────────────────── */
  const playable = sentences.filter(s => !s.skip).length;
  const stats = {
    words,
    sentences: sentences.length,
    playable,
    // Apple's and Google's default voices land near 165 wpm at rate 1.0.
    minutes: Math.max(1, Math.round(words / 165)),
  };

  return { blocks, sentences, outline, stats };
}

/** Index of the next playable sentence at or after `from`, or -1. */
export function nextPlayable(sentences, from, dir = 1) {
  for (let i = from; i >= 0 && i < sentences.length; i += dir) {
    if (!sentences[i].skip) return i;
  }
  return -1;
}
