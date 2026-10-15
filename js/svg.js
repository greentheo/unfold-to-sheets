// SVG for one sheet, for laser cutters and for looking at.
//
// Layers are real <g> elements with ids, so a laser's software can be told to
// cut CUT, score SCORE and ignore the rest. Without that separation the machine
// cuts along every fold line and through every label.

import { LAYER, LAYER_ORDER, LAYER_STYLE, LEGEND, senseNote } from './sheetview.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Margin text, in millimetres of finished sheet: about one percent of the
 *  sheet, held between legible in the hand and silly on a postcard. */
const marginTextMM = (widthMM) => Math.min(24, Math.max(4, widthMM * 0.010));

/** Greedy wrap to a width in the same units as `fs`. Helvetica averages a bit
 *  over half its point size per character, which is close enough for a note in
 *  a margin and does not require measuring a font that is not here. */
function wrapText(str, fs, width) {
  const perLine = Math.max(12, Math.floor(width / (fs * 0.52)));
  const lines = [];
  let line = '';
  for (const word of String(str).split(/\s+/)) {
    if (line && line.length + 1 + word.length > perLine) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}
const n = (v) => Number(v.toFixed(4));

import { unitFactor } from './materials.js';

// SVG has no unit for metres, so everything physical is written in millimetres
// and the viewBox carries the model's own units. One model unit then maps onto
// exactly `unitFactor` millimetres of paper, whatever the model was drawn in.

/**
 * One sheet, at its real size.
 *
 * The width and height carry a unit — `width="420mm"` — and the viewBox is in
 * model units, so one user unit is one millimetre and the file is physically
 * correct when a cutter opens it. Without the suffix an SVG user unit is a CSS
 * pixel, a 96th of an inch, and a 420 mm sheet arrives at the laser 111 mm wide
 * with nothing anywhere on it to say so. It is the same failure the scale bar
 * exists to catch, one step earlier.
 *
 * @param {object} sheet from buildSheets
 * @param {{title?, scaleBar?}} opts
 */
export function sheetSVG(sheet, opts = {}) {
  const { title = `Sheet ${sheet.index + 1}`, scaleBar = true } = opts;
  const pxPerUnit = 1;
  let mmPerUnit = 0;
  try { mmPerUnit = sheet.units ? unitFactor(sheet.units) : 0; } catch { mmPerUnit = 0; }
  const pad = sheet.width * 0.02;
  // Text in the margin is a PHYSICAL height — five millimetres of paper — like
  // everything else in this file. A floor in pixels reads as five millimetres on
  // an A4 card and as five METRES on a dome drawn in metres, which does not
  // merely look wrong: the margin is sized from the text, so the file comes out
  // sixty-five metres tall and no rasteriser will open it.
  const fs = mmPerUnit ? marginTextMM(sheet.width * mmPerUnit) / mmPerUnit : sheet.width * 0.018;
  const noteLines = wrapText(senseNote(sheet.orientation), fs, sheet.width);
  // The margin has to be tall enough for what is written in it. Sized from the
  // key rather than from a constant, so adding a line to the key cannot push it
  // off the bottom of the file where nobody would see it was missing.
  const keyTop = (sheet.height + pad * 2.9) * pxPerUnit;
  const keyH = fs * 1.6 * (LEGEND.length + noteLines.length + 1);
  const W = (sheet.width + pad * 2) * pxPerUnit;
  const H = keyTop + keyH + pad * 0.4 * pxPerUnit;

  // The whole drawing is placed once, and v is flipped so the sheet reads the
  // way it lies on the bench rather than upside down as SVG would have it.
  const open = `<g transform="translate(${n(pad * pxPerUnit)} ${n((sheet.height + pad) * pxPerUnit)}) scale(${n(pxPerUnit)} ${n(-pxPerUnit)})">`;

  const groups = new Map();
  const push = (layer, s) => {
    if (!groups.has(layer)) groups.set(layer, []);
    groups.get(layer).push(s);
  };

  for (const item of sheet.items) {
    if (item.kind === 'text') {
      // Text has to be un-flipped or it comes out mirrored.
      push(item.layer, `<text x="${n(item.at.u)}" y="${n(-item.at.v)}" font-family="Helvetica, Arial, sans-serif" `
        + `font-size="${n(item.height)}" fill="${LAYER_STYLE[item.layer].stroke}" transform="scale(1 -1)">${esc(item.text)}</text>`);
      continue;
    }
    if (item.points) {
      const d = item.points.map((p, i) => `${i ? 'L' : 'M'}${n(p.u)} ${n(p.v)}`).join(' ') + (item.closed ? ' Z' : '');
      push(item.layer, `<path d="${d}"/>`);
      continue;
    }
    if (item.a && item.b) {
      push(item.layer, `<line x1="${n(item.a.u)}" y1="${n(item.a.v)}" x2="${n(item.b.u)}" y2="${n(item.b.v)}"/>`);
    }
  }

  // Fold dashes are a real length of sheet, so `mm` on the way out and model
  // units on the way in. Left in screen pixels they collapse: the dome's sheet
  // is 2.44 model units wide, a 4-pixel dash spans most of a panel, and the two
  // patterns become one solid line — which is the whole feature gone, silently.
  // Strokes and dashes are both a real width of ink: millimetres, converted
  // once. `vector-effect="non-scaling-stroke"` was doing this job on screen and
  // failing everywhere else — it measures in device pixels, so a renderer that
  // ignores it (rsvg does) draws this sheet's cut lines 1.1 METRES wide and the
  // dashes, being physical, disappear underneath them.
  const perMM = mmPerUnit || 1;
  const body = LAYER_ORDER.filter((l) => groups.has(l)).map((l) => {
    const st = LAYER_STYLE[l];
    const dash = st.dash
      ? ` stroke-dasharray="${st.dash.map((d) => n(d / perMM)).join(' ')}"`
      : '';
    return `<g id="${l}" stroke="${st.stroke}" stroke-width="${n(st.width / perMM)}" fill="none"${dash}>\n`
      + groups.get(l).map((s) => `  ${s}`).join('\n') + '\n</g>';
  }).join('\n');

  const bar = scaleBar ? scaleBarSVG(sheet, pad, pxPerUnit, fs) : '';
  const key = legendSVG(sheet, pad, pxPerUnit, mmPerUnit, fs, keyTop, noteLines);

  const size = mmPerUnit
    ? `width="${n(W * mmPerUnit)}mm" height="${n(H * mmPerUnit)}mm"`
    : `width="${n(W)}" height="${n(H)}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${n(W)} ${n(H)}">
<title>${esc(title)}</title>
<rect width="${n(W)}" height="${n(H)}" fill="#ffffff"/>
${open}
${body}
</g>
${bar}
${key}
</svg>`;
}

/**
 * The key, drawn OUTSIDE the sheet rectangle.
 *
 * Two dash patterns on a cutting file are only half the instruction if nothing
 * on the page says which is which — and the page is where it has to say it,
 * because the sheet reaches the bench without the README. It sits beside the
 * scale bar, in the margin, on its own group id so a laser can be told to
 * ignore it along with the bar.
 */
function legendSVG(sheet, pad, pxPerUnit, mmPerUnit, fs, top, noteLines) {
  const perMM = mmPerUnit || 1;
  const sample = fs * 4;
  const x = pad * pxPerUnit;
  let y = top;
  const rows = LEGEND.map((item) => {
    const st = LAYER_STYLE[item.layer];
    const dash = st.dash ? ` stroke-dasharray="${st.dash.map((d) => n(d / perMM)).join(' ')}"` : '';
    const w = st.width / perMM;
    const row = `  <line x1="${n(x)}" y1="${n(y)}" x2="${n(x + sample)}" y2="${n(y)}" stroke="${st.stroke}" stroke-width="${n(w)}"${dash}/>`
      + `<text x="${n(x + sample + fs * 0.5)}" y="${n(y + fs * 0.35)}" fill="#111418">${esc(item.text)}</text>`;
    y += fs * 1.6;
    return row;
  }).join('\n');
  const note = noteLines.map((t) => {
    const line = `  <text x="${n(x)}" y="${n(y + fs * 0.35)}" fill="#5a6472">${esc(t)}</text>`;
    y += fs * 1.25;
    return line;
  }).join('\n');
  return `<g id="key" font-family="Helvetica, Arial, sans-serif" font-size="${n(fs)}">
${rows}
${note}
</g>`;
}

/**
 * A bar of stated length, drawn to scale.
 *
 * The one thing that can ruin a pattern without leaving any trace on it is a
 * printer quietly fitting the page. A measured bar is the only mark that reveals
 * it: if the bar is not the length it says it is, nothing else on the sheet is
 * either.
 */
function scaleBarSVG(sheet, pad, pxPerUnit, fs) {
  const nice = niceLength(sheet.width / 6);
  const y = (sheet.height + pad * 0.9) * pxPerUnit;
  const x = pad * pxPerUnit;
  const w = nice * pxPerUnit;
  const t = fs * 0.9;
  return `<g id="scalebar" font-family="Helvetica, Arial, sans-serif" font-size="${n(fs)}">
  <rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(t)}" fill="#111418"/>
  <rect x="${n(x + w / 2)}" y="${n(y)}" width="${n(w / 2)}" height="${n(t)}" fill="#ffffff" stroke="#111418" stroke-width="${n(t * 0.06)}"/>
  <text x="${n(x)}" y="${n(y + t + fs * 1.05)}" fill="#111418">${nice} ${esc(sheet.units || '')} — if this bar does not measure ${nice} ${esc(sheet.units || '')}, the page has been rescaled</text>
</g>`;
}

/** A round number near `v`: 1, 2, 5, 10, 20, 50 ... */
export function niceLength(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const r = v / p;
  return (r >= 5 ? 5 : r >= 2 ? 2 : 1) * p;
}
