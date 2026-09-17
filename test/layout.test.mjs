/* Layout regression tests.
 *
 *   node --test
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

/* ── letter-spaced headings ───────────────────────────────────────────── */

test('rejoins a letter-spaced section head', () => {
  // Tracking wide enough that pdf.js reads the gaps between glyph runs as
  // spaces. All three of these are real, off one NEJM article.
  const cases = [
    ['a bs tr ac t', 'abstract'],
    ['Me thods', 'Methods'],
    ['R esult s', 'Results'],
  ];
  for (const [broken, want] of cases) {
    const lines = pageLines([atom(broken, 62, 63, 12)], PAGE, 1);
    assert.equal(lines[0].text, want);
  }
});

test('a rejoined head is a heading again, not a paragraph', () => {
  // The point of the repair: a mangled head stops matching HEADING_WORDS, so
  // it is filed as prose and vanishes from "Jump to section".
  const atoms = [
    atom('Me thods', 62, 63, 12),
    ...column(62, 87, LEFT),
  ];
  const blocks = linesToBlocks(pageLines(atoms, PAGE, 1));
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].text, 'Methods');
});

test('leaves ordinary prose alone', () => {
  const kept = [
    'the results were inconclusive',
    'no findings of harm were reported',
    'Data were collected by the trial site investigators',
    'agents and methods used in the unit',
  ];
  for (const t of kept) {
    const lines = pageLines([atom(t, 62, 63)], PAGE, 1);
    assert.equal(lines[0].text, t);
  }
});

/* ── tables and figures ───────────────────────────────────────────────── */

/** Two columns of body prose, which is what sets the document's body size and
 *  measure. Everything in this section is judged relative to them. */
const BODY = [
  ...column(62, 63, LEFT),
  ...column(269, 63, RIGHT),
];

/** A table row: a label and a value with a cell's worth of space between. */
function row(label, value, base, x0 = 49) {
  const w = label.length * 4;
  return [atom(label, x0, base, 8, w), atom(value, 160, base, 8, 40)];
}

const kinds = (blocks) => blocks.map(b => b.furniture || 'keep');

test('marks a table by the cells in its rows, and leaves its caption alone', () => {
  // Labels of differing lengths, so the space between the columns is broken
  // up rather than running the height of the table as a gutter would.
  const table = [
    atom('Table 1. Characteristics of the Participants at Baseline.', 37, 67, 8, 183),
    ...row('Age', '56.7', 110),
    ...row('Sex — no. (%)', '667 (69.1)', 124),
    ...row('Male', '298 (30.9)', 138),
    ...row('Female, and those without', '19 (2.0)', 152),
    ...row('White', '832 (86.2)', 166),
  ];
  const blocks = linesToBlocks([
    ...pageLines(BODY, PAGE, 1),
    ...pageLines(table, PAGE, 2),
  ]);

  const onPage2 = blocks.filter(b => b.page === 2);
  assert.equal(onPage2[0].type, 'caption');
  assert.equal(onPage2[0].furniture, undefined, 'the caption is how you know the table is there');
  assert.ok(onPage2.slice(1).every(b => b.furniture === 'table'), kinds(onPage2).join(','));
});

test('leaves body prose unmarked', () => {
  const blocks = linesToBlocks(pageLines(BODY, PAGE, 1));
  assert.deepEqual([...new Set(kinds(blocks))], ['keep']);
});

test('marks the boxes inside a flow diagram', () => {
  // Small type, laid out to its own width rather than the body measure, and
  // never finishing a sentence — a CONSORT diagram, box by box.
  const figure = [
    ...column(209, 88, ['5762 Patients were assessed for eligibility'], { size: 7, pitch: 8, measure: 120 }),
    ...column(349, 94, ['3806 Were excluded', '2794 Did not meet eligibility criteria',
                        '509 Declined to participate'], { size: 7, pitch: 8, measure: 122 }),
    ...column(98, 187, ['978 Were assigned to receive carbocisteine',
                        '486 Were assigned to carbocisteine alone'], { size: 7, pitch: 8, measure: 161 }),
  ];
  const blocks = linesToBlocks([
    ...pageLines(BODY, PAGE, 1),
    ...pageLines(figure, PAGE, 2),
  ]);

  const onPage2 = blocks.filter(b => b.page === 2);
  assert.ok(onPage2.length > 0);
  assert.ok(onPage2.every(b => b.furniture === 'figure'), kinds(onPage2).join(','));
});

test('keeps a figure legend, which is prose about the figure', () => {
  // Small type like the diagram, but written in sentences and set close to
  // the body measure. It is the only description a listener gets.
  const legend = column(62, 63, [
    'Figure 1 (facing page). Screening, Randomization, and Assessment.',
    'Panel A shows the flow diagram for the any carbocisteine and no',
    'carbocisteine comparison groups, and Panel B shows the flow diagram',
    'for the any hypertonic saline comparison groups.',
  ], { size: 8, pitch: 10, measure: 183 });

  const blocks = linesToBlocks([
    ...pageLines(BODY, PAGE, 1),
    ...pageLines(legend, PAGE, 2),
  ]);
  assert.ok(blocks.filter(b => b.page === 2).every(b => !b.furniture));
});

test('a heading ends a table, whatever size it is set in', () => {
  // Journals set subsection heads smaller than body text, so size alone
  // cannot tell "Safety Outcomes" from another row of the table above it.
  // Being a heading is what ends the table — here, by being bold.
  const head = atom('Safety Outcomes', 62, 150, 9, 70);
  head.bold = true;
  const page = [
    atom('Table 2. Adverse events during the trial.', 62, 67, 8, 183),
    ...row('Bleeding', '13 (1.4)', 110, 62),
    head,
    ...column(62, 170, LEFT, { size: 10 }),
  ];
  const blocks = linesToBlocks([...pageLines(BODY, PAGE, 1), ...pageLines(page, PAGE, 2)]);
  const safety = blocks.find(b => b.text.startsWith('Safety Outcomes'));

  assert.ok(safety, 'the heading survived');
  assert.equal(safety.type, 'heading');
  assert.equal(safety.furniture, undefined);
  // And the body text after it is back out of the table too.
  assert.ok(blocks.filter(b => b.page === 2 && b.text.startsWith('to carbocisteine'))
                  .every(b => !b.furniture));
});

test('a bare "Table 2." is a cross-reference, not a caption', () => {
  // The stub left where the table itself sits on the facing page. Opening a
  // table run on it would swallow the body text that follows.
  const page = [
    atom('Table 2.', 62, 67, 10, 40),
    atom('Safety Outcomes', 62, 90, 9, 70),
    ...column(62, 110, LEFT, { size: 10 }),
  ];
  const blocks = linesToBlocks([...pageLines(BODY, PAGE, 1), ...pageLines(page, PAGE, 2)]);
  assert.ok(blocks.filter(b => b.page === 2).every(b => !b.furniture), kinds(blocks).join(','));
});

test('a line is the size most of its characters are, not its median run', () => {
  // An author list carries a superscript affiliation marker after every name,
  // so by count half the runs on the line are tiny digits. The median run
  // measures 7.9pt where the line is plainly 10pt type — and line size is
  // what heading detection, the title picker and the table run all read.
  const names = ['B. Connolly,', 'N. Dickson,', 'C. Campbell,', 'J.M. Bradley,'];
  const authors = [];
  let x = 67;
  for (const n of names) {
    authors.push(atom(n, x, 174, 10, n.length * 4.2));
    x += n.length * 4.2;
    authors.push(atom('12', x, 171, 5.8, 6));     // the marker
    x += 8;
  }

  const [line] = pageLines(authors, PAGE, 2);
  assert.equal(line.size, 10);

  const blocks = linesToBlocks([...pageLines(BODY, PAGE, 1), ...pageLines(authors, PAGE, 2)]);
  assert.ok(blocks.filter(b => b.page === 2).every(b => !b.furniture), kinds(blocks).join(','));
});

test('cells alone mark a table, with no caption to go on', () => {
  // Nothing here says "Table" — the rows have to give themselves away.
  const table = [
    ...row('Age', '56.7', 110),
    ...row('Sex — no. (%)', '667 (69.1)', 124),
    ...row('Male', '298 (30.9)', 138),
    ...row('Female, and those without', '19 (2.0)', 152),
  ];
  const blocks = linesToBlocks([...pageLines(BODY, PAGE, 1), ...pageLines(table, PAGE, 2)]);
  const onPage2 = blocks.filter(b => b.page === 2);

  assert.ok(onPage2.length > 0);
  assert.ok(onPage2.every(b => b.furniture === 'table'), kinds(onPage2).join(','));
});

test('the caption carries the table over rows that have no cells in them', () => {
  // A column of row labels is just short lines, and the footnote under it is
  // an ordinary sentence. Only the caption above says what they belong to.
  const table = [
    atom('Table 3. Type of humidification.', 37, 67, 8, 183),
    atom('Heated humidification', 49, 90, 8, 80),
    atom('Heat moisture exchange', 49, 104, 8, 86),
    atom('Other', 49, 118, 8, 24),
    atom('* Plus–minus values are means ±SD.', 37, 132, 8, 140),
  ];
  const blocks = linesToBlocks([...pageLines(BODY, PAGE, 1), ...pageLines(table, PAGE, 2)]);
  const onPage2 = blocks.filter(b => b.page === 2);

  assert.equal(onPage2[0].type, 'caption');
  assert.equal(onPage2[0].furniture, undefined);
  assert.ok(onPage2.slice(1).every(b => b.furniture === 'table'), kinds(onPage2).join(','));
});

test('a bare "Table 4." does not carry off the prose beneath it', () => {
  const page = [
    atom('Table 4.', 62, 67, 10, 40),
    atom('Adherence was high in all four groups over the whole', 62, 90, 8, 150),
    atom('28-day treatment period of the trial.', 62, 104, 8, 110),
  ];
  const blocks = linesToBlocks([...pageLines(BODY, PAGE, 1), ...pageLines(page, PAGE, 2)]);
  assert.ok(blocks.filter(b => b.page === 2).every(b => !b.furniture),
            kinds(blocks.filter(b => b.page === 2)).join(','));
});

test('body-size blocks are never figure innards, however they are laid out', () => {
  // Three short, unpunctuated, off-measure regions — everything a diagram box
  // looks like except the one thing that matters, which is being small.
  // No full stops anywhere: the sentence test must not be what saves them.
  const page = [
    ...column(62, 70,  ['Trial sites and', 'investigators'], { size: 10, pitch: 13, measure: 110 }),
    ...column(62, 150, ['Recruitment by', 'region'], { size: 10, pitch: 13, measure: 105 }),
    ...column(62, 230, ['Outcomes assessed', 'centrally'], { size: 10, pitch: 13, measure: 118 }),
  ];
  const blocks = linesToBlocks([...pageLines(BODY, PAGE, 1), ...pageLines(page, PAGE, 2)]);
  assert.ok(blocks.filter(b => b.page === 2).every(b => !b.furniture),
            kinds(blocks.filter(b => b.page === 2)).join(','));
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
