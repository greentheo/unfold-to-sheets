#!/usr/bin/env node
// Generate a geodesic dome shell with a door and windows, and write it as OBJ.
//
//   node tools/make-dome.mjs --radius 3 --frequency 4 --out sample/dome-6m.obj
//
// Exists so the dome is a FILE that goes through the same loader as anything
// else a user drops in, rather than a special case wired into the pipeline. If
// it only worked as an in-memory shortcut, it would not be testing very much.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { domeMesh, iglooPreset, meshToOBJ, domeReport } from '../js/dome.js';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const radius = Number(flag('radius', '3'));
const frequency = Number(flag('frequency', '4'));
const out = flag('out', `sample/dome-${(radius * 2).toFixed(0)}m.obj`);

const preset = iglooPreset(radius);
preset.frequency = frequency;
const mesh = domeMesh(preset);
const r = domeReport(mesh);

const header = [
  `Geodesic dome shell, ${frequency}V, ${r.span.toFixed(1)} m span, ${r.height.toFixed(1)} m high.`,
  `${r.panels} panels; struts ${r.strutMin.toFixed(2)} to ${r.strutMax.toFixed(2)} m.`,
  `Floor ${r.floorArea.toFixed(1)} m2, shell ${r.shellArea.toFixed(1)} m2.`,
  `Openings: ${r.openings.join(', ')}.`,
  'UNITS ARE METRES. An OBJ does not record that; this comment is not read back.',
].join('\n');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, meshToOBJ(mesh, header));

console.log(`${frequency}V dome, ${r.span.toFixed(1)} m span, ${r.height.toFixed(1)} m high`);
console.log(`  ${r.panels} panels, ${mesh.stats.vertices} vertices, ${r.openEdges} open edges`);
console.log(`  struts ${r.strutMin.toFixed(2)} – ${r.strutMax.toFixed(2)} m (median ${r.strutMedian.toFixed(2)})`);
console.log(`  floor ${r.floorArea.toFixed(1)} m², shell ${r.shellArea.toFixed(1)} m²`);
console.log(`  openings cut: ${JSON.stringify(r.removed)}`);
console.log(`  ${mesh.stats.manifold ? 'manifold' : 'NOT MANIFOLD'}, `
  + `${mesh.stats.consistentWinding ? 'consistently wound' : 'INCONSISTENT WINDING'}`);
console.log(`wrote ${out}`);
