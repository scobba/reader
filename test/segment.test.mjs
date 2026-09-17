/* Sentence segmentation regression tests.
 *
 *   node --test
 *
 * Every case here is a place the reader was heard to break a sentence in two
 * and pause in the middle of it, or to run two sentences together. The first
 * failure mode is the one that matters: a neural voice drops its intonation at
 * a fragment boundary, so a wrong split is instantly audible, while a missed
 * split only costs a breath.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences } from '../js/clean/segment.js';

/** The text must come back as exactly these pieces. */
function splits(text, expected) {
  assert.deepEqual(splitSentences(text), expected);
}

/** The text must survive as one sentence, however it is punctuated. */
function whole(text) {
  assert.deepEqual(splitSentences(text), [text]);
}

test('a dotted abbreviation is not a sentence end', () => {
  whole('She earned a Ph.D. in 2010 from MIT.');
  whole('The U.S. Food and Drug Administration approved it in 2011.');
  whole('Samples were shipped c/o the U.S.D.A. laboratory in Ames.');
});

test('an acronym followed by a capital is left joined, on purpose', () => {
  // "the U.S. The pay is poor" and "the U.S. Food and Drug Administration"
  // are the same shape, and nothing short of a lexicon tells them apart. The
  // scanner takes the safe side of that: running two sentences together costs
  // a breath, whereas cutting one in half is audible as a dropped intonation
  // in the middle of a clause.
  whole('He works for the U.S. The pay is poor.');
});

test('an abbreviated month does not end a sentence', () => {
  splits('On Jan. 5 the team met. On Feb. 6 they met again.',
         ['On Jan. 5 the team met.', 'On Feb. 6 they met again.']);
  whole('Recruitment ran from Sept. 2019 to Dec. 2021 at four sites.');
});

test('abbreviated titles and places do not end a sentence', () => {
  splits('Mt. Everest is tall. So is K2.', ['Mt. Everest is tall.', 'So is K2.']);
  whole('Gen. Marshall and Sen. Vandenberg met at the Mt. Vernon estate.');
});

test('the abbreviations that were already handled still are', () => {
  whole('See Smith et al. (2019) for details.');
  whole('Growth was measured at 37 °C in E. coli cultures.');
  whole('The company, Acme Inc. of Delaware, filed suit.');
  whole('Doses of approx. 40 mg were given to Dr. Alvarez.');
});

test('real sentence ends are still found', () => {
  splits('Results were significant (p < 0.05). This held across strata.',
         ['Results were significant (p < 0.05).', 'This held across strata.']);
  splits('The trial enrolled 1,204 patients. Of these, 612 were randomised.',
         ['The trial enrolled 1,204 patients.', 'Of these, 612 were randomised.']);
  splits('What?! He asked again.', ['What?!', 'He asked again.']);
  splits('This is fine... And so is this.', ['This is fine...', 'And so is this.']);
});

test('a decimal, a version and a section number are not sentence ends', () => {
  whole('It cost $3.5 million.');
  whole('Version 2.1. of the protocol applies.');
  whole('Temperatures reached 23.5°C.');
});

test('an over-long sentence breaks at punctuation, not mid-clause', () => {
  const head = 'The investigators followed every participant for a full twelve months';
  const tail = 'and reported the results in a supplementary appendix that nobody read';
  const long = `${head}; ${tail} even once it had finally been published.`;
  assert.ok(long.length > 120);

  const out = splitSentences(long, 120);
  assert.equal(out.length, 2);
  assert.ok(out[0].endsWith(';'), `expected a break at the semicolon, got ${out[0]}`);
});

test('a forced break never lands inside a word', () => {
  // No punctuation at all, so the break has to be chosen on word boundaries.
  const long = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett ' +
               'kilo lima mike november oscar papa quebec romeo sierra tango.';
  for (const piece of splitSentences(long, 60)) {
    for (const word of piece.replace(/\.$/, '').split(' ')) {
      assert.ok(long.includes(` ${word} `) || long.startsWith(`${word} `) ||
                long.endsWith(`${word}.`),
                `"${word}" is not a whole word from the input`);
    }
  }
});

test('splitting is exhaustive: no text is lost or duplicated', () => {
  const src = 'Dr. Alvarez led the study in Jan. 2020. Prof. Chen, who holds a ' +
              'Ph.D. in statistics, reviewed it; the U.S. team then replicated ' +
              'it at 37 °C using E. coli, and published in Nature.';
  assert.equal(
    splitSentences(src).join(' ').replace(/\s+/g, ' '),
    src.replace(/\s+/g, ' '));
});
