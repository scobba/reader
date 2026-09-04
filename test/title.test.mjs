/* Which line of a title page is the title.
 *
 *   node --test test/
 *
 * This only runs when the PDF's own metadata is missing or junk, which is
 * most of the time — an embedded title is very often the InDesign filename.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { titleFromBlocks } from '../js/extract/pdf.js';

/** The front of a journal article, in the order the extractor emits it. */
const NEJM = [
  { type: 'heading', page: 1, size: 35.3, text: 'The new england' },
  { type: 'heading', page: 1, size: 35.3, text: 'journal of medicine' },
  { type: 'para',    page: 1, size: 8,    text: 'established in 1812 August 20/27, 2026 vol. 395 no. 8' },
  { type: 'heading', page: 1, size: 18,   text: 'Carbocisteine or Hypertonic Saline for Acute Respiratory Failure' },
  { type: 'para',    page: 1, size: 10,   text: 'B. Connolly, N. Dickson, C. Campbell, J.M. Bradley, B. O’Neill, A. Agus' },
  { type: 'heading', page: 1, size: 9,    text: 'BACKGROUND' },
  { type: 'para',    page: 1, size: 9,    text: 'Mucoactive agents are widely used in patients with acute respiratory failure.' },
];

test('takes the title, not the masthead set larger above it', () => {
  // First gives "The new england"; largest gives it too, since a masthead is
  // the biggest thing on the page. Only phrase-length-then-largest gets this
  // right.
  assert.equal(
    titleFromBlocks(NEJM),
    'Carbocisteine or Hypertonic Saline for Acute Respiratory Failure',
  );
});

test('ignores the abstract heading and the body beneath it', () => {
  const blocks = [
    { type: 'heading', page: 1, size: 20, text: 'Airway Clearance in Critical Illness' },
    { type: 'heading', page: 1, size: 11, text: 'Abstract' },
    { type: 'para', page: 1, size: 10, text: 'Summary of the evidence for mucoactive agents in patients receiving ventilation.' },
  ];
  assert.equal(titleFromBlocks(blocks), 'Airway Clearance in Critical Illness');
});

test('prefers display type over a phrase set at body size', () => {
  // The author list is longer than the title and reads like a phrase. It is
  // also the same size as the body, which is what settles it.
  const blocks = [
    { type: 'heading', page: 1, size: 22, text: 'Aspirin in ARDS' },
    { type: 'para', page: 1, size: 10, text: 'B. Connolly, N. Dickson, C. Campbell and J.M. Bradley' },
    { type: 'para', page: 1, size: 10, text: 'Mucoactive agents are widely used in acute respiratory failure.' },
  ];
  assert.equal(titleFromBlocks(blocks), 'Aspirin in ARDS');
});

test('does not wander past the opening pages', () => {
  const blocks = [
    { type: 'heading', page: 1, size: 20, text: 'Airway Clearance in Critical Illness' },
    { type: 'heading', page: 9, size: 44, text: 'A Very Large Heading Much Later On' },
  ];
  assert.equal(titleFromBlocks(blocks), 'Airway Clearance in Critical Illness');
});

test('falls back to the first real block when nothing is phrase-length', () => {
  // A short title is better than no title.
  const blocks = [
    { type: 'heading', page: 1, size: 22, text: 'Aspirin in ARDS' },
    { type: 'para', page: 1, size: 10, text: 'Somebody, Someone and Another' },
  ];
  assert.equal(titleFromBlocks(blocks), 'Aspirin in ARDS');
});

test('returns null for a document with nothing title-shaped in it', () => {
  assert.equal(titleFromBlocks([{ type: 'para', page: 1, size: 10, text: 'p. 4' }]), null);
});
