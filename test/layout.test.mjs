/* Layout regression tests.
 *
 *   node --test test/
 *
 * Node is not a runtime dependency of this app — nothing here is served — but
 * layout.js is pure geometry with no DOM in it, which makes it cheap to test
 * directly, and it is the one file where a tuning constant can quietly ruin
 * every document without throwing anything.
 *
 * Atoms are built by hand rather than parsed out of a PDF so that each case
 * states exactly the geometry it is about.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { xyCut, pageLines, linesToBlocks } from '../js/extract/layout.js';

const PAGE = { width: 567, height: 756 };

/** One text run. Give it a width when the geometry matters — a measured
 *  column, a justified line — and it falls back to a char-count estimate. */
function atom(text, x0, base, size = 10, width = text.length * size * 0.42) {
  return {
    text, x0, base, size,
    x1: x0 + width,
    top: base - size * 0.86,
    bot: base + size * 0.26,
    bold: false, italic: false,
  };
}

/** A column of justified lines, one atom each: every line fills the measure
 *  exactly, as journal text does, except the last one. */
function column(x0, firstBase, texts, { size = 10, pitch = 12, measure = 198 } = {}) {
  return texts.map((t, i) => atom(
    t, x0, firstBase + i * pitch, size,
    i === texts.length - 1 ? Math.min(measure, t.length * size * 0.42) : measure,
  ));
}

const LEFT = [
  'to carbocisteine (lower gastrointestinal bleeding',
  'that led to treatment with tranexamic acid and a',
  'blood-product transfusion). No unexpected adverse',
  'events related to a trial intervention occurred in',
  'either group, and no participant withdrew consent',
  'after randomization for reasons related to harm.',
  'Adherence to the assigned regimen was high in all',
  'four groups over the whole 28-day treatment period',
];
const RIGHT = [
  'and that could suggest which patients might derive',
  'the most benefit from treatment. Future work will',
  'need to establish whether any subgroup responds to',
  'mucoactive treatment, and by what mechanism it may',
  'act on secretion clearance during ventilation, and',
  'whether the harms seen here are dose-dependent or',
  'a class effect of the agents rather than of either',
  'agent alone, which these data cannot distinguish.',
];

const text = (region) => region.atoms
  .slice().sort((a, b) => a.base - b.base || a.x0 - b.x0)
  .map(a => a.text).join(' ');

/* ── columns ──────────────────────────────────────────────────────────── */

test('splits two columns separated by a gutter of only 0.9 em', () => {
  // NEJM's measure: 198pt columns with 9pt between them, set in 10pt type.
  // Anything keyed to a full em of clearance misses this and reads straight
  // across the page, which is the bug these tests exist for.
  const atoms = [...column(62, 63, LEFT), ...column(269, 63, RIGHT)];
  const regions = xyCut(atoms, PAGE);

  assert.equal(regions.length, 2);
  assert.match(text(regions[0]), /^to carbocisteine/);
  assert.match(text(regions[1]), /^and that could suggest/);
});

test('splits three columns, in reading order', () => {
  // A reference list: three 129pt columns with 10pt between them.
  const refs = (n) => Array.from({ length: 12 }, (_, i) => `reference line ${n}.${i} text`);
  const col = { size: 7.5, pitch: 9, measure: 129 };
  const atoms = [
    ...column(62, 389, refs(1), col),
    ...column(200, 389, refs(2), col),
    ...column(338, 389, refs(3), col),
  ];
  const regions = xyCut(atoms, PAGE);

  assert.equal(regions.length, 3);
  assert.deepEqual(regions.map(r => text(r).match(/\d\.\d/)[0][0]), ['1', '2', '3']);
});

test('reads a full-width heading before the columns beneath it', () => {
  const atoms = [
    atom('Carbocisteine or Hypertonic Saline for Acute Respiratory Failure', 65, 40, 18),
    ...column(62, 80, LEFT),
    ...column(269, 80, RIGHT),
  ];
  const regions = xyCut(atoms, PAGE);

  assert.equal(regions.length, 3);
  assert.match(text(regions[0]), /^Carbocisteine or Hypertonic/);
  assert.match(text(regions[1]), /^to carbocisteine/);
  assert.match(text(regions[2]), /^and that could suggest/);
});

test('a full-width footer does not weld the columns above it together', () => {
  // The footer covers the gutter, so no vertical cut exists for the page as a
  // whole: the horizontal cut has to peel the footer off first. The blank band
  // it leaves is 9.4pt — wider than the 12pt leading warrants, but narrower
  // than the 10pt type, which is why the threshold has to be the leading.
  const atoms = [
    ...column(62, 63, LEFT),
    ...column(269, 63, RIGHT),
    atom('The New England Journal of Medicine is produced by NEJM Group', 94, 165.9, 8),
    atom('Downloaded from nejm.org. For personal use only.', 134, 175.9, 8),
  ];
  const regions = xyCut(atoms, PAGE);

  assert.equal(regions.length, 3);
  assert.match(text(regions[0]), /^to carbocisteine/);
  assert.match(text(regions[1]), /^and that could suggest/);
  assert.match(text(regions[2]), /^The New England Journal/);
});

test('keeps a single column of ragged prose in one piece', () => {
  const lines = [
    'Mucoactive agents are used empirically to enhance',
    'airway clearance in patients who are receiving',
    'invasive mechanical ventilation and have',
    'difficult-to-clear secretions. Our findings',
    'address previous uncertainty regarding the use of',
    'two mucoactive treatments in this population.',
  ];
  const regions = xyCut(lines.map((t, i) => atom(t, 62, 63 + i * 12)), PAGE);
  assert.equal(regions.length, 1);
});

test('does not read aligned word spaces as a gutter', () => {
  // A source that emits words rather than lines can leave a whitespace
  // channel running the height of a paragraph. Word-sized is not gutter-sized,
  // and the check that tells them apart has to survive the channel being in
  // the sample it measures — in this region, most of the gaps sampled are the
  // channel itself.
  const atoms = [];
  const fill = (from, to, base, seed) => {
    // Word widths vary line to line, so no word space lines up into a channel
    // of its own; only the 7pt break at `to` runs the height of the block.
    let x = from;
    for (let k = 0; x < to - 30; k++) {
      const w = 24 + ((seed * 7 + k * 11) % 5) * 6;
      atoms.push(atom('participants', x, base, 10, Math.min(w, to - x)));
      x += w + 5;                            // 5pt word spaces
    }
    atoms.push(atom('ventilation', x, base, 10, to - x));
  };
  for (let i = 0; i < 20; i++) {
    const base = 63 + i * 12;
    fill(62, 300, base, i);
    fill(307, 505, base, i + 3);
  }
  const regions = xyCut(atoms, PAGE);
  assert.equal(regions.length, 1);
});

/* ── marginal material ────────────────────────────────────────────────── */

test('lifts a marginal note out of the column beside it', () => {
  const atoms = [
    // Set on its own leading, so its baselines drift against the column's.
    ...column(45, 130.3, ['A Quick Take', 'is available at', 'NEJM.org'],
              { size: 8, pitch: 9.5, measure: 46 }),
    ...column(100, 63, LEFT),
  ];
  const regions = xyCut(atoms, PAGE);

  assert.equal(regions.length, 2);
  assert.equal(text(regions[0]), 'A Quick Take is available at NEJM.org');
  assert.match(text(regions[1]), /^to carbocisteine/);
});

test('does not strip list markers hanging in the margin', () => {
  // These look like a narrow column, but each marker shares a baseline with
  // the line it introduces. Cutting them away would read "1. 2. 3." and then
  // the six items they number.
  const atoms = [];
  for (let i = 0; i < 6; i++) {
    const base = 63 + i * 24;
    atoms.push(atom(`${i + 1}.`, 62, base));
    atoms.push(atom('Eligible participants were 16 years of age or', 84, base));
    atoms.push(atom('older and receiving invasive ventilation.', 84, base + 12));
  }
  const regions = xyCut(atoms, PAGE);
  assert.equal(regions.length, 1);
});

/* ── drop caps ────────────────────────────────────────────────────────── */

test('puts a drop cap back at the head of its paragraph', () => {
  const body = [
    atom('cute respiratory failure is the', 130, 63),
    atom('most common cause of admission', 130, 75),
    atom('to an intensive care unit (ICU).', 130, 87),
    atom('Invasive mechanical ventilation', 130, 99),
  ];
  const cap = atom('A', 100, 87, 47.4);
  const lines = pageLines([cap, ...body], PAGE, 1);

  assert.equal(lines[0].text, 'Acute respiratory failure is the');
  assert.equal(lines[2].text, 'to an intensive care unit (ICU).');
});

test('leaves a large initial that is not a drop cap alone', () => {
  // A heading is large too, but nothing wraps around it.
  const atoms = [
    atom('A', 62, 63, 24),
    ...column(62, 87, LEFT),   // starts below the initial, not beside it
  ];
  const lines = pageLines(atoms, PAGE, 1);
  assert.equal(lines[0].text, 'A');
});

/* ── paragraph assembly ───────────────────────────────────────────────── */

test('stitches a paragraph running from one column into the next', () => {
  const atoms = [
    ...column(62, 63, [...LEFT.slice(0, 7), 'The trial was conducted at 71 sites across']),
    ...column(269, 63, ['the United Kingdom. The protocol has been published.', ...RIGHT.slice(1)]),
  ];
  const blocks = linesToBlocks(pageLines(atoms, PAGE, 1));

  assert.match(
    blocks.map(b => b.text).join('\n'),
    /across the United Kingdom\. The protocol has been published\./,
  );
});
