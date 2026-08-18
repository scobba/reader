/* Plain text and Markdown.
 *
 * Also the landing place for text pasted out of Safari, which arrives as
 * hard-wrapped lines with no paragraph markup at all — so we have to guess
 * where paragraphs end rather than trust the newlines. */

const MD_HEADING = /^(#{1,6})\s+(.*\S)\s*#*$/;
const MD_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const SETEXT = /^\s*(=|-){3,}\s*$/;
const LIST = /^\s*([-*+•]|\d{1,3}[.)])\s+/;

/** Hard-wrapped text: most lines run to a similar width and stop mid-sentence. */
function isHardWrapped(lines) {
  const solid = lines.filter(l => l.trim().length > 20);
  if (solid.length < 6) return false;
  const lens = solid.map(l => l.trimEnd().length);
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (avg > 110 || avg < 40) return false;
  const spread = lens.filter(n => Math.abs(n - avg) < avg * 0.22).length / lens.length;
  const openEnded = solid.filter(l => !/[.!?:;"')\]]\s*$/.test(l)).length / solid.length;
  return spread > 0.55 && openEnded > 0.5;
}

export function extractText(raw, { title } = {}) {
  const src = raw.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  const lines = src.split('\n');
  const wrapped = isHardWrapped(lines);

  const blocks = [];
  let buf = [];
  let bufKind = 'para';

  const flush = () => {
    if (!buf.length) return;
    let text = '';
    for (const l of buf) {
      if (!text) { text = l.trim(); continue; }
      // Repair a hyphen split across a wrapped line; see layout.js for why the
      // hyphen is dropped rather than kept.
      if (/[\p{L}]-$/u.test(text) && /^[\p{Ll}]/u.test(l.trim())) {
        text = text.slice(0, -1) + l.trim();
      } else {
        text += ' ' + l.trim();
      }
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ type: bufKind, text });
    buf = [];
    bufKind = 'para';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { flush(); continue; }
    if (MD_RULE.test(line)) { flush(); continue; }

    const md = MD_HEADING.exec(t);
    if (md) {
      flush();
      blocks.push({ type: 'heading', text: md[2], level: md[1].length <= 2 ? 1 : 2 });
      continue;
    }

    // Setext heading: the underline belongs to the line already buffered.
    if (SETEXT.test(t) && buf.length === 1) {
      const text = buf[0].trim();
      buf = [];
      blocks.push({ type: 'heading', text, level: t.startsWith('=') ? 1 : 2 });
      continue;
    }

    if (/^(fig(ure)?\.?\s*\d|table\s*\d)/i.test(t)) {
      flush();
      bufKind = 'caption';
      buf.push(t);
      flush();
      continue;
    }

    if (LIST.test(line)) {
      flush();
      buf.push(t.replace(LIST, '• '));
      // A list item can wrap; keep collecting indented continuation lines.
      while (i + 1 < lines.length && lines[i + 1].trim() && !LIST.test(lines[i + 1]) &&
             /^\s{2,}/.test(lines[i + 1])) {
        buf.push(lines[++i].trim());
      }
      flush();
      continue;
    }

    // An unadorned short line surrounded by blanks reads as a heading.
    const prevBlank = i === 0 || !lines[i - 1].trim();
    const nextBlank = i + 1 >= lines.length || !lines[i + 1].trim();
    if (prevBlank && nextBlank && t.length <= 78 && !/[.!?]$/.test(t) &&
        (/^[^a-z]{4,}$/.test(t) || /^\d+(\.\d+)*\.?\s+\S/.test(t) ||
         /^(abstract|introduction|methods?|results?|discussion|conclusions?|references?)\b/i.test(t))) {
      flush();
      blocks.push({ type: 'heading', text: t, level: 2 });
      continue;
    }

    buf.push(line);

    // In hard-wrapped text a line that ends a sentence and stops well short of
    // the running width is a paragraph end, not just a line break.
    if (wrapped && /[.!?]["')\]]?\s*$/.test(line) && line.trimEnd().length < 62) flush();
  }
  flush();

  const meta = { title: title || null };
  if (!meta.title) {
    const h = blocks.find(b => b.type === 'heading');
    meta.title = (h ? h.text : blocks[0]?.text || 'Pasted text').slice(0, 140);
  }

  return { blocks, meta, needsOcr: false };
}
