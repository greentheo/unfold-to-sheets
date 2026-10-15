// The output package, declared once.
//
// There are six kinds of file here and three places that could decide what goes
// in them. The lofting project's hardest-won structural lesson was that two
// places deciding one thing WILL drift — so a block is declared once, with its
// name and its content together, and cannot be added to the download and
// forgotten in the summary.
//
// Every file states the units and the scale, because a pattern that does not say
// what size it is is a drawing of nothing.

import { dxfDocument, polyline, line, text as dxfText, LAYERS, zipStore, ascii } from './dxf.js';
import { sheetSVG } from './svg.js';
import { buildPDF } from './pdf.js';
import { assemblySVG, assemblyText } from './assembly.js';
import { LAYER } from './sheetview.js';

const DXF_LAYER = {
  [LAYER.sheet]: LAYERS.sheet,
  [LAYER.cut]: LAYERS.cut,
  [LAYER.mountain]: LAYERS.mountain,
  [LAYER.valley]: LAYERS.valley,
  [LAYER.seam]: LAYERS.seam,
  [LAYER.label]: LAYERS.label,
};

/** One sheet as DXF R12, on separable layers. */
export function sheetDXF(sheet, opts = {}) {
  const entities = [];
  for (const item of sheet.items) {
    const layer = DXF_LAYER[item.layer] || '0';
    if (item.kind === 'text') { entities.push(dxfText(item.text, item.at, item.height, layer)); continue; }
    if (item.points) { entities.push(polyline(item.points, layer, { closed: item.closed })); continue; }
    if (item.a && item.b) entities.push(line(item.a, item.b, layer));
  }
  return dxfDocument(entities, {
    units: sheet.units || 'mm',
    layers: [LAYERS.sheet, LAYERS.cut, LAYERS.valley, LAYERS.mountain, LAYERS.seam, LAYERS.label],
    ...opts,
  });
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Everything the run produced, as a list of named files.
 *
 * @returns {Array<{name, text?, bytes?, kind, describe}>} — `describe` is what
 *   the summary says about the file, carried alongside it so the two cannot
 *   disagree.
 */
export function buildPackage(result, view, assembly, opts = {}) {
  const files = [];
  const stamp = `${result.mesh.name} at ${result.scale}x, ${result.units}, ${result.stock.name}`;

  files.push({
    name: 'README.txt',
    kind: 'summary',
    describe: 'what was made, what it cost, and what could not be done',
    text: readme(result, view, assembly),
  });

  view.sheets.forEach((sheet) => {
    const n = pad2(sheet.index + 1);
    files.push({
      name: `sheets/sheet-${n}.svg`,
      kind: 'sheet',
      describe: `sheet ${sheet.index + 1} for a laser or a plotter — layers cut / score-valley / score-mountain / seam / label`,
      text: sheetSVG(sheet, { title: `${stamp} — sheet ${sheet.index + 1}` }),
    });
    files.push({
      name: `sheets/sheet-${n}.dxf`,
      kind: 'sheet',
      describe: `sheet ${sheet.index + 1} for CAM — DXF R12, same layers`,
      text: sheetDXF(sheet),
    });
  });

  files.push({
    name: 'assembly.svg',
    kind: 'assembly',
    describe: 'which piece is which, drawn on the model from four directions',
    text: assemblySVG(result.mesh, result, assembly),
  });
  files.push({
    name: 'assembly.txt',
    kind: 'assembly',
    describe: 'the seam list: every token, the two pieces it joins, and the fold angle',
    text: assemblyText(result, assembly),
  });
  files.push({
    name: 'pattern.pdf',
    kind: 'print',
    describe: 'every sheet with a measured scale bar, plus the summary and the seam list',
    text: buildPDF(result, view, assembly, opts.pdf || {}),
    latin1: true,
  });

  if (opts.sweepRows) {
    files.push({
      name: 'scale-sweep.csv',
      kind: 'sweep',
      describe: 'sheets and waste at every size tried',
      text: sweepCSV(opts.sweepRows, result.units),
    });
  }
  return files;
}

/** The package as a .zip. */
export function packageZip(files) {
  return zipStore(files.map((f) => (f.latin1
    ? { name: f.name, bytes: latin1Bytes(f.text) }
    : { name: f.name, text: f.text })));
}

/** A PDF is bytes, not text: its xref offsets are counted in bytes, so it must
 *  not be run through a UTF-8 encoder on the way into the archive. */
export function latin1Bytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function sweepCSV(rows, units) {
  const head = `scale,size_${units},pieces,sheets,utilisation,waste_sheets,splits,unplaceable,worst_edge_error_${units}`;
  return [head, ...rows.map((r) => [
    r.scale, r.size.toFixed(3), r.pieces, r.sheets,
    r.utilisation.toFixed(4), r.wasteSheets.toFixed(3), r.splits, r.unplaceable,
    r.worstEdgeError.toFixed(4),
  ].join(','))].join('\n');
}

function readme(result, view, assembly) {
  const L = [];
  const u = result.units;
  L.push(`${result.mesh.name} — unfolded to sheets`);
  L.push('='.repeat(60));
  L.push('');
  L.push(`Units          ${u}   (an STL does not record units; this is what you told it)`);
  L.push(`Scale          ${result.scale}x`);
  L.push(`Model          ${result.mesh.bbox.size.map((v) => v.toFixed(1)).join(' x ')} ${u}, ${result.mesh.faceCount} triangles`);
  L.push(`Stock          ${result.stock.name} — ${result.stock.sheetLength.toFixed(1)} x ${result.stock.sheetWidth.toFixed(1)} ${u}`);
  L.push(`Material       ${result.stock.materialName}`);
  L.push(`Joints         ${result.stock.joint === 'tab' ? 'glue tabs (the material folds, so creases are scored)' : 'butt joints (the material does not fold, so every crease is a cut)'}`);
  L.push('');
  L.push(`Pieces         ${result.pieces.length}`);
  L.push(`Seams          ${result.seams.stats.seamCount}, ${result.seams.stats.totalSeamLength.toFixed(0)} ${u} of edge to join`);
  L.push(`Sheets         ${result.sheetCount}`);
  L.push(`Utilisation    ${(result.utilisation * 100).toFixed(1)}%  (${result.wasteSheets.toFixed(2)} sheets' worth is offcut)`);
  L.push(`Largest part   the nester can place ${result.usable.length.toFixed(1)} x ${result.usable.width.toFixed(1)} ${u} of a ${result.stock.sheetLength.toFixed(1)} x ${result.stock.sheetWidth.toFixed(1)} sheet`);
  L.push('');
  L.push('HOW MUCH THIS LIED');
  L.push('-'.repeat(60));
  L.push('Most surfaces cannot be flattened — that is a theorem, not a shortcoming.');
  L.push('These are the numbers for this model, in the units you are working in:');
  L.push('');
  L.push(`  worst edge error   ${result.worstEdgeError.toFixed(4)} ${u}`);
  L.push(`                     an edge cut to this pattern is out by at most this much`);
  L.push(`  worst spread       ${result.worstSpread.toFixed(4)} ${u}`);
  L.push(`                     how far apart the copies of one corner fell before they were reconciled`);
  L.push(`  overlapping        ${result.overlapping.length} piece(s) still lap over themselves`);
  L.push('');
  if (result.missing.length) {
    L.push('PIECES THAT COULD NOT BE PLACED');
    L.push('-'.repeat(60));
    for (const m of result.missing) {
      L.push(`  ${m.label}  ${m.width?.toFixed(1)} x ${m.height?.toFixed(1)} ${u} — ${m.why}`);
    }
    L.push('');
    L.push('  These are NOT in the sheets. The model is incomplete as cut.');
  } else {
    L.push('Every piece was placed. Nothing was dropped.');
  }
  L.push('');
  if (view.dropped.length) {
    L.push('LABELS THAT WOULD NOT FIT');
    L.push('-'.repeat(60));
    for (const d of view.dropped) L.push(`  ${d.piece}: ${d.what} — ${d.why}`);
    L.push('');
  }
  L.push('FILES');
  L.push('-'.repeat(60));
  L.push('  sheets/sheet-NN.svg   one per sheet, for a laser or plotter');
  L.push('  sheets/sheet-NN.dxf   the same, DXF R12 for CAM');
  L.push('  assembly.svg          which piece is which, on the model');
  L.push('  assembly.txt          the seam list and fold angles');
  L.push('  pattern.pdf           everything, with a measured scale bar on every page');
  L.push('');
  L.push('BEFORE YOU CUT');
  L.push('-'.repeat(60));
  L.push('Print one page and measure the scale bar. A printer set to "fit to page"');
  L.push('rescales a pattern silently, and nothing else on the sheet reveals it.');
  return L.join('\n');
}
