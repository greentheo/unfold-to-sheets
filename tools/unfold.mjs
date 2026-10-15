#!/usr/bin/env node
// Run the whole pipeline from the command line.
//
//   node tools/unfold.mjs model.stl --units mm --stock ply-4x8 --material ply --scale 10
//   node tools/unfold.mjs model.stl --sweep 0.5:3:0.1
//
// The browser app is the same pipeline behind a canvas. This exists because a
// pipeline you can run headless is a pipeline you can test, diff and put in CI.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { parseModel, buildMesh } from '../js/mesh.js';
import { prepare, runScale } from '../js/pipeline.js';
import { sweep, frontier, disqualified, cliffs } from '../js/sweep.js';
import { buildSheets } from '../js/sheetview.js';
import { buildAssembly } from '../js/assembly.js';
import { buildPackage } from '../js/package.js';
import { STOCKS, MATERIALS } from '../js/materials.js';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const file = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') === false)
  || argv.find((a) => /\.(stl|obj)$/i.test(a));

if (!file || has('help')) {
  console.log(`usage: node tools/unfold.mjs <model.stl|.obj> [options]

  --units mm|in     what the file's numbers mean. There is no default and no
                    guess: an STL does not record it. (default mm)
  --stock ID        ${STOCKS.map((s) => s.id).join(', ')}
  --material ID     ${MATERIALS.map((m) => m.id).join(', ')}
  --scale K         size multiplier (default 1)
  --sweep A:B:STEP  sweep sizes and print the frontier instead
  --out DIR         write the package here
  --rotations N     nesting angles over a full turn (default 8)
`);
  process.exit(file ? 0 : 1);
}

const units = flag('units', 'mm');
const stock = flag('stock', 'sheet-1to2-420');
const material = flag('material', 'card');
const scale = Number(flag('scale', '1'));
const rotations = Number(flag('rotations', '8'));

const buf = readFileSync(file);
const raw = parseModel(basename(file), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const mesh = buildMesh(raw, { units, name: basename(file).replace(/\.[^.]+$/, '') });

console.log(`${mesh.name}: ${mesh.stats.triangles} triangles, ${mesh.stats.vertices} vertices`);
console.log(`  ${mesh.stats.manifold ? 'manifold' : 'NOT MANIFOLD'}, ${mesh.stats.closed ? 'closed' : 'open'}, `
  + `${mesh.stats.consistentWinding ? 'consistently wound' : 'INCONSISTENT WINDING'}`);
console.log(`  ${mesh.bbox.size.map((v) => v.toFixed(1)).join(' x ')} ${units}   (units as stated, not read from the file)`);
if (mesh.stats.degenerate.length) console.log(`  ${mesh.stats.degenerate.length} degenerate triangles dropped`);
if (mesh.stats.vertexesMerged) console.log(`  ${mesh.stats.vertexesMerged} duplicate vertices welded`);

const prepared = prepare(mesh, { stock, material, rotations });
console.log(`\nsegmentation: ${prepared.segmentMethod} — ${prepared.segmentNote}`);
console.log(`  ${prepared.patches.length} patches, ${prepared.seamEdgeCount} cut edges, ${prepared.foldEdgeCount} fold edges`);

const sweepArg = flag('sweep', null);
if (sweepArg) {
  const [from, to, step] = sweepArg.split(':').map(Number);
  const rows = [...sweep(prepared, { from, to, step: step || 0.1 }, { rotations })];
  console.log(`\nscale   size(${units})  pieces  sheets   util   waste  splits  missing`);
  for (const r of rows) {
    console.log(`${String(r.scale).padStart(5)}  ${r.size.toFixed(1).padStart(9)}  `
      + `${String(r.pieces).padStart(6)}  ${String(r.sheets).padStart(6)}  `
      + `${(r.utilisation * 100).toFixed(1).padStart(5)}%  ${r.wasteSheets.toFixed(2).padStart(6)}  `
      + `${String(r.splits).padStart(6)}  ${r.unplaceable ? String(r.unplaceable).padStart(7) + '  <-- disqualified' : '      0'}`);
  }
  const front = frontier(rows);
  console.log(`\nPARETO FRONTIER — nothing else is both bigger and cheaper`);
  for (const r of front) {
    console.log(`  x${String(r.scale).padEnd(5)} ${r.size.toFixed(1).padStart(8)} ${units}  on ${String(r.sheets).padStart(3)} sheet(s), ${(r.utilisation * 100).toFixed(1)}% used`);
  }
  const bad = disqualified(rows);
  if (bad.length) {
    console.log(`\n${bad.length} row(s) disqualified for missing parts (NOT a cheaper way to build it):`);
    for (const b of bad.slice(0, 8)) console.log(`  x${b.scale}: ${b.unplaceable} unplaceable — ${b.why[0]}`);
  }
  for (const c of cliffs(rows)) {
    console.log(`  cliff: x${c.at.scale} -> x${c.next.scale} costs ${c.cost} more sheet(s)`);
  }
  process.exit(0);
}

const result = runScale(prepared, scale, { rotations });
const view = buildSheets(result);
const assembly = buildAssembly(result);

console.log(`\nat scale ${scale}x:`);
console.log(`  ${result.pieces.length} pieces (${result.splits} splits), ${result.sheetCount} sheet(s), `
  + `${(result.utilisation * 100).toFixed(1)}% used`);
console.log(`  worst edge error ${result.worstEdgeError.toFixed(4)} ${units}, worst spread ${result.worstSpread.toFixed(4)} ${units}`);
console.log(`  ${result.seams.stats.seamCount} seams; every token appears exactly twice: ${result.tokenCheck.ok}`);
if (result.missing.length) {
  console.log(`  ${result.missing.length} PIECE(S) NOT PLACED:`);
  for (const m of result.missing) console.log(`    ${m.label}: ${m.why}`);
} else console.log('  nothing was dropped');
if (view.dropped.length) console.log(`  ${view.dropped.length} label(s) could not be written inside their piece`);

const out = flag('out', null);
if (out) {
  const files = buildPackage(result, view, assembly);
  for (const f of files) {
    const p = join(out, f.name);
    mkdirSync(dirname(p), { recursive: true });
    if (f.latin1) {
      const bytes = Buffer.alloc(f.text.length);
      for (let i = 0; i < f.text.length; i++) bytes[i] = f.text.charCodeAt(i) & 0xff;
      writeFileSync(p, bytes);
    } else writeFileSync(p, f.text);
  }
  console.log(`\nwrote ${files.length} files to ${out}`);
}
