// A minimal PDF writer: vector sheets, a cut list, and the assembly document.
//
// Small on purpose. The alternative is a library that brings a build step to an
// app that deliberately has none, for a file format whose subset needed here is
// a few hundred lines. Its output is checked against a foreign reader in the
// tests, because trusting your own writer is how malformed files ship — they
// open perfectly in the one viewer you happen to use by hand.
//
// EVERY PAGE THAT SHOWS A PATTERN CARRIES A MEASURED SCALE BAR, and if the
// pattern had to be reduced to fit the paper, the page says so in words at the
// top. A printer quietly fitting to page ruins a pattern in a way nothing else
// on the sheet reveals, and "1:1" printed in a corner is not evidence — a bar
// that can be put a ruler against is.

import { LAYER, LAYER_ORDER, LAYER_STYLE, LEGEND, senseNote } from './sheetview.js';
import { niceLength } from './svg.js';
import { unitFactor } from './materials.js';

const PT_PER_MM = 72 / 25.4;

export const PAGES = {
  a4: { name: 'A4', w: 595.28, h: 841.89 },
  a3: { name: 'A3', w: 841.89, h: 1190.55 },
  letter: { name: 'US Letter', w: 612, h: 792 },
};

/**
 * Fold text into WinAnsi, then escape it.
 *
 * A PDF's cross-reference table is a list of BYTE offsets, and the file is
 * written one byte per character. So a single em-dash — three bytes in UTF-8,
 * one character in JavaScript, one byte on the way out — puts every offset after
 * it out by two, and the reader lands in the middle of an object. This was
 * caught by running the output through pypdf rather than by opening it: the
 * viewer being used by hand rebuilt the table silently and showed a perfect
 * document. The fix is to make text and bytes the same length by construction,
 * which means mapping everything into the encoding the font actually declares.
 */
const WINANSI = new Map([
  ['\u2014', 0x97], ['\u2013', 0x96], ['\u2018', 0x91], ['\u2019', 0x92],
  ['\u201c', 0x93], ['\u201d', 0x94], ['\u2022', 0x95], ['\u2026', 0x85],
]);
export function toWinAnsi(str) {
  let out = '';
  for (const ch of String(str)) {
    const mapped = WINANSI.get(ch);
    if (mapped !== undefined) { out += String.fromCharCode(mapped); continue; }
    const c = ch.codePointAt(0);
    if (c <= 0xff) { out += ch; continue; }
    // Anything with no WinAnsi form is spelled out rather than mangled.
    out += ({ '\u2264': '<=', '\u2265': '>=', '\u00d7': 'x', '\u2032': "'", '\u2033': '"' })[ch] ?? '?';
  }
  return out;
}

const esc = (s) => toWinAnsi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const f2 = (v) => (Math.abs(v) < 1e-6 ? '0' : v.toFixed(3));

/** A page being drawn: content-stream operators, accumulated. */
class Page {
  constructor(w, h) { this.w = w; this.h = h; this.ops = []; this.fonts = new Set(['F1']); }

  gray(v) { this.ops.push(`${f2(v)} G`); return this; }

  rgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    this.ops.push(`${f2(r)} ${f2(g)} ${f2(b)} RG`);
    return this;
  }

  fillRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    this.ops.push(`${f2(r)} ${f2(g)} ${f2(b)} rg`);
    return this;
  }

  width(v) { this.ops.push(`${f2(v)} w`); return this; }
  /** @param {number[]|null} pattern — dash and gap lengths, in points. */
  dash(pattern) {
    this.ops.push(pattern && pattern.length ? `[${pattern.map(f2).join(' ')}] 0 d` : '[] 0 d');
    return this;
  }
  save() { this.ops.push('q'); return this; }
  restore() { this.ops.push('Q'); return this; }

  path(points, closed) {
    if (!points.length) return this;
    this.ops.push(`${f2(points[0].x)} ${f2(points[0].y)} m`);
    for (let i = 1; i < points.length; i++) this.ops.push(`${f2(points[i].x)} ${f2(points[i].y)} l`);
    if (closed) this.ops.push('h');
    return this;
  }

  stroke() { this.ops.push('S'); return this; }
  fill() { this.ops.push('f'); return this; }
  fillStroke() { this.ops.push('B'); return this; }

  line(a, b) { return this.path([a, b], false).stroke(); }

  rect(x, y, w, h) { this.ops.push(`${f2(x)} ${f2(y)} ${f2(w)} ${f2(h)} re`); return this; }

  text(str, x, y, size, { font = 'F1' } = {}) {
    this.fonts.add(font);
    this.ops.push(`BT /${font} ${f2(size)} Tf ${f2(x)} ${f2(y)} Td (${esc(str)}) Tj ET`);
    return this;
  }

  /** Text that stops at `maxWidth`, wrapped, returning the y it finished at. */
  paragraph(str, x, y, size, maxWidth, leading = 1.35) {
    const per = size * 0.5;
    const perLine = Math.max(8, Math.floor(maxWidth / per));
    let cursor = y;
    for (const raw of String(str).split('\n')) {
      const words = raw.split(/\s+/).filter(Boolean);
      let line = '';
      for (const w of words) {
        if (line && (line.length + 1 + w.length) > perLine) {
          this.text(line, x, cursor, size); cursor -= size * leading; line = w;
        } else line = line ? `${line} ${w}` : w;
      }
      this.text(line, x, cursor, size);
      cursor -= size * leading;
    }
    return cursor;
  }
}

/** Assemble the object graph into a byte-exact PDF. */
function serialise(pages, meta = {}) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };

  const catalogId = 1, pagesId = 2;
  objects.push(null, null);                            // reserved for 1 and 2

  const fontIds = {
    F1: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    F2: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
  };

  const kids = [];
  for (const p of pages) {
    const content = p.ops.join('\n');
    const streamId = add(`<< /Length ${byteLength(content)} >>\nstream\n${content}\nendstream`);
    const res = `<< /Font << /F1 ${fontIds.F1} 0 R /F2 ${fontIds.F2} 0 R >> >>`;
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${f2(p.w)} ${f2(p.h)}] `
      + `/Resources ${res} /Contents ${streamId} 0 R >>`);
    kids.push(`${pageId} 0 R`);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;

  const infoId = add(`<< /Title (${esc(meta.title || 'Unfold to sheets')}) `
    + `/Producer (unfold-to-sheets) /Creator (unfold-to-sheets) >>`);

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(byteLength(out));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefAt = byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`
       + `startxref\n${xrefAt}\n%%EOF\n`;
  return out;
}

/**
 * Byte length, which for this writer is the character count — and that is an
 * invariant, not a coincidence. Everything written has been through `esc`, so
 * nothing above 0xFF can be present. If something ever is, the file would be
 * subtly corrupt in a way that most readers repair silently, so it throws here
 * instead of shipping.
 */
function byteLength(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 255) {
      throw new Error(`PDF content has a non-Latin-1 character at ${i}: ${JSON.stringify(s.slice(i - 20, i + 20))}`);
    }
  }
  return s.length;
}

/** Points per model unit. A page is measured in points whatever the model is
 *  measured in, so this is the one place the two meet. */
const unitPt = (units) => PT_PER_MM * unitFactor(units);

/**
 * The whole package: a summary, every sheet at a stated scale, and the assembly
 * document.
 *
 * @param {object} result   from pipeline.runScale
 * @param {object} view     from sheetview.buildSheets
 * @param {object} assembly from assembly.buildAssembly
 */
export function buildPDF(result, view, assembly, opts = {}) {
  const page = PAGES[opts.page || 'a4'];
  const landscape = opts.landscape ?? true;
  const W = landscape ? page.h : page.w;
  const H = landscape ? page.w : page.h;
  const margin = 36;
  const pages = [];

  pages.push(summaryPage(result, view, assembly, W, H, margin));
  for (const sheet of view.sheets) pages.push(sheetPage(sheet, result, W, H, margin));
  pages.push(...assemblyPages(assembly, result, W, H, margin));

  return serialise(pages, { title: `${result.mesh.name} — unfolded to ${view.sheets.length} sheet(s)` });
}

function summaryPage(result, view, assembly, W, H, margin) {
  const p = new Page(W, H);
  let y = H - margin;
  p.fillRgb('#111418').text(`${result.mesh.name} — unfolded to sheets`, margin, y, 18, { font: 'F2' });
  y -= 26;
  p.text(`${view.sheets.length} sheet(s) of ${result.stock.name}, ${result.stock.materialName}`, margin, y, 11);
  y -= 24;

  const rows = [
    ['Units', `${result.units} — stated by you, not read from the file`],
    ['Scale', `${result.scale}x`],
    ['Model size', `${fmt(result.mesh.bbox.size[0])} x ${fmt(result.mesh.bbox.size[1])} x ${fmt(result.mesh.bbox.size[2])} ${result.units}`],
    ['Triangles', `${result.mesh.faceCount}`],
    ['Pieces', `${result.pieces.length} (from ${result.pieces.length - result.splits} patches, ${result.splits} split to fit)`],
    ['Seams', `${result.seams.stats.seamCount}, total ${fmt(result.seams.stats.totalSeamLength)} ${result.units}`],
    ['Sheets', `${result.sheetCount}, ${(result.utilisation * 100).toFixed(1)}% used, ${result.wasteSheets.toFixed(2)} sheets' worth of waste`],
    ['Usable area', `${fmt(result.usable.length)} x ${fmt(result.usable.width)} ${result.units} of a ${fmt(result.stock.sheetLength)} x ${fmt(result.stock.sheetWidth)} sheet`],
    ['Worst distortion', `${result.worstEdgeError.toFixed(3)} ${result.units} on any one edge (${(result.worstEdgeError / Math.max(...result.mesh.bbox.size) * 100).toFixed(2)}% of the longest dimension)`],
    ['Joints', result.stock.joint === 'tab' ? 'glue tabs — the material folds' : 'butt joints — the material does not fold'],
  ];
  for (const [k, v] of rows) {
    p.fillRgb('#5a6472').text(k, margin, y, 9);
    p.fillRgb('#111418').text(v, margin + 110, y, 9);
    y -= 14;
  }

  y -= 10;
  p.fillRgb('#111418').text('What this does not tell you', margin, y, 11, { font: 'F2' });
  y -= 16;
  p.fillRgb('#444c58');
  y = p.paragraph(
    'Every sheet here is the same thickness, so a sheet count at one scale and a sheet count at '
    + 'another compare different objects built from the same stock. As a measure of packing it is exact. '
    + 'As a comparison of cost between sizes it is not.',
    margin, y, 9, W - margin * 2);

  y -= 8;
  const bad = [...result.missing];
  if (bad.length) {
    p.fillRgb('#b42318').text(`${bad.length} piece(s) could not be placed`, margin, y, 11, { font: 'F2' });
    y -= 15;
    for (const m of bad) {
      p.fillRgb('#b42318').text(`${m.label}: ${m.why}`, margin, y, 9);
      y -= 12;
    }
  } else {
    p.fillRgb('#116149').text('Every piece was placed on a sheet.', margin, y, 10, { font: 'F2' });
    y -= 16;
  }
  if (view.dropped.length) {
    p.fillRgb('#b45309').text(`${view.dropped.length} label(s) could not be written inside their piece`, margin, y, 10, { font: 'F2' });
    y -= 13;
    for (const d of view.dropped.slice(0, 12)) {
      p.fillRgb('#b45309').text(`${d.piece}: ${d.what} — ${d.why}`, margin, y, 8);
      y -= 10;
    }
  }
  return p;
}

/**
 * One sheet, drawn as large as the paper allows.
 *
 * If it will not go on at 1:1 the reduction is applied and STATED, in words, at
 * the top of the page — next to a bar that can be measured.
 */
function sheetPage(sheet, result, W, H, margin) {
  const p = new Page(W, H);
  const per = unitPt(sheet.units);
  const top = 40, bottom = 84;   // room for the bar AND the key, both of which have to fit

  const availW = W - margin * 2;
  const availH = H - margin - top - bottom;
  const fit = Math.min(availW / (sheet.width * per), availH / (sheet.height * per));
  const scale = Math.min(1, fit);
  const k = per * scale;

  const x0 = margin, y0 = margin + bottom;
  const T = (pt) => ({ x: x0 + pt.u * k, y: y0 + pt.v * k });

  p.fillRgb('#111418').text(`Sheet ${sheet.index + 1} of ${result.sheetCount} — ${result.stock.name}`, margin, H - margin, 12, { font: 'F2' });
  p.fillRgb('#5a6472').text(`${sheet.pieces.length} pieces: ${sheet.pieces.join(', ')}`.slice(0, 160), margin, H - margin - 14, 8);
  const note = scale >= 0.999
    ? 'Printed at 1:1. Check the bar below with a ruler before cutting.'
    : `REDUCED TO ${(scale * 100).toFixed(1)}% TO FIT THIS PAGE — do not cut from this print. Check the bar below.`;
  p.fillRgb(scale >= 0.999 ? '#116149' : '#b42318').text(note, margin, H - margin - 26, 9, { font: 'F2' });

  // Dashes in POINTS, on the page, not scaled with the drawing. A sheet of
  // plywood on A4 is reduced to about a fourteenth, and a dash scaled with it
  // lands at three quarters of a point: both patterns come out as one solid
  // line and the reader is back to not knowing which way to fold.
  for (const layer of LAYER_ORDER) {
    const st = LAYER_STYLE[layer];
    p.save().rgb(st.stroke).fillRgb(st.stroke).width(st.width * 0.8).dash(st.dash);
    for (const item of sheet.items) {
      if (item.layer !== layer) continue;
      if (item.kind === 'text') { p.text(item.text, T(item.at).x, T(item.at).y, Math.max(4, item.height * k)); continue; }
      if (item.points) { p.path(item.points.map(T), item.closed).stroke(); continue; }
      if (item.a && item.b) p.line(T(item.a), T(item.b));
    }
    p.restore();
  }

  // The measured bar.
  const nice = niceLength(sheet.width / 6);
  const barY = margin + 68;
  p.save().fillRgb('#111418').rect(margin, barY, nice * k, 5).fill();
  p.fillRgb('#ffffff').rect(margin + (nice * k) / 2, barY, (nice * k) / 2, 5).fill();
  p.rgb('#111418').width(0.5).rect(margin, barY, nice * k, 5).stroke();
  p.fillRgb('#111418').text(`${nice} ${sheet.units} — if this bar is not ${nice} ${sheet.units} the page has been rescaled`, margin, barY - 11, 8);
  p.restore();

  // The key, on the page that reaches the bench.
  //
  // Two dash patterns are only half an instruction without something on the
  // same sheet of paper saying which is which, and the README does not make it
  // out to the workshop.
  let ky = margin + 48;
  for (const item of LEGEND) {
    const st = LAYER_STYLE[item.layer];
    p.save().rgb(st.stroke).width(st.width * 0.9).dash(st.dash)
      .line({ x: margin, y: ky }, { x: margin + 34, y: ky }).restore();
    p.fillRgb('#111418').text(item.text, margin + 40, ky - 2.5, 7);
    ky -= 10;
  }
  p.fillRgb('#5a6472').paragraph(senseNote(sheet.orientation), margin, margin + 6, 6.5, W - margin * 2);
  return p;
}

function assemblyPages(assembly, result, W, H, margin) {
  const pages = [];
  const perPage = Math.floor((H - margin * 2 - 60) / 12);
  const rows = assembly.joins;
  for (let i = 0; i < Math.max(1, Math.ceil(rows.length / perPage)); i++) {
    const p = new Page(W, H);
    let y = H - margin;
    p.fillRgb('#111418').text(`Assembly — seam list (${i + 1})`, margin, y, 14, { font: 'F2' });
    y -= 18;
    p.fillRgb('#5a6472');
    y = p.paragraph('Each token appears on exactly two pieces. Glue or butt those two edges together. '
      + 'The fold angle is the angle the surface turns through at that seam. On the sheets a mountain is '
      + 'drawn dash-dot and a valley plain dashed. '
      + senseNote(assembly.stats.orientation), margin, y, 8, W - margin * 2);
    y -= 8;
    p.fillRgb('#111418').text('Token', margin, y, 9, { font: 'F2' });
    p.text('Joins', margin + 60, y, 9, { font: 'F2' });
    p.text('Length', margin + 200, y, 9, { font: 'F2' });
    p.text('Fold', margin + 260, y, 9, { font: 'F2' });
    y -= 12;
    for (const r of rows.slice(i * perPage, (i + 1) * perPage)) {
      p.fillRgb('#111418').text(r.token, margin, y, 8);
      p.fillRgb('#444c58').text(`${r.a} — ${r.b}`, margin + 60, y, 8);
      p.text(`${r.length.toFixed(1)} ${result.units}`, margin + 200, y, 8);
      p.text(r.foldDeg == null ? '-' : `${Math.abs(r.foldDeg).toFixed(0)} deg ${r.sense || ''}`, margin + 260, y, 8);
      y -= 12;
    }
    pages.push(p);
  }
  return pages;
}

const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

export { Page, serialise };
