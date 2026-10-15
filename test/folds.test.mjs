// Which way does it fold?
//
// A dashed line says "crease here" and stops there. Half an instruction: on a
// dome panel the same dashes mean bend away from you at one seam and towards you
// at the next, and coroplast creases once. So there are two dash patterns, and
// everything below exists because the sense they carry is a claim about the
// physical world that can be wrong in exactly two ways — backwards for one
// crease, or backwards for all of them at once.
//
// The whole-model failure is the dangerous one. It is invisible: the pattern
// still cuts, still nests, still assembles, just inside out, and the first
// evidence is a finished shell with the tape on the wrong face.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildMesh, parseModel, dihedralDeg, foldSense } from '../js/mesh.js';
import { segment } from '../js/segment.js';
import { unfoldPatch } from '../js/unfold.js';
import { unfoldToSheets } from '../js/pipeline.js';
import { buildSheets, LAYER, LAYER_STYLE, LEGEND, senseNote } from '../js/sheetview.js';
import { buildAssembly, assemblyText } from '../js/assembly.js';
import { sheetSVG } from '../js/svg.js';
import { bunny } from './fixtures/bunny.mjs';
import { sphere } from './fixtures/shapes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sample = (f) => join(here, '..', 'sample', f);
const load = (file, units, name) => buildMesh(parseModel(file, readFileSync(file)), { units, name });
const dome = () => load(sample('dome-6m.obj'), 'm', 'dome');

const CARD = { stock: 'sheet-1to2-420', material: 'card', scale: 1 };
const CORO = { stock: 'coro-4x8', material: 'coroplast', scale: 1 };

/**
 * A ridge tent: two panels meeting along a line. Convex from above, so the ridge
 * is a mountain.
 *
 * `sign = -1` drops the ridge below the eaves and leaves the winding alone,
 * which reflects the normals with the geometry and leaves them pointing up — out
 * of the hollow. Same four triangles, same winding, opposite answer, so nothing
 * about the result can have come from the connectivity.
 */
function ridge(sign = 1) {
  const h = 20 * sign;
  const positions = [
    -50, -30, 0, -50, 30, 0,      // 0,1  left eave
    0, -30, h, 0, 30, h,          // 2,3  ridge
    50, -30, 0, 50, 30, 0,        // 4,5  right eave
  ];
  const tris = [0, 2, 3, 0, 3, 1, 2, 4, 5, 2, 5, 3];
  return buildMesh({ positions, tris, groups: tris.map(() => 0), source: 'ridge' },
    { units: 'mm', name: `ridge ${sign > 0 ? 'up' : 'down'}` });
}

/** The same mesh with every triangle wound the other way: an inside-out model. */
function insideOut(mesh) {
  const tris = [];
  for (let f = 0; f < mesh.faceCount; f++) {
    tris.push(mesh.tris[f * 3], mesh.tris[f * 3 + 2], mesh.tris[f * 3 + 1]);
  }
  return buildMesh({ positions: [...mesh.positions], tris, groups: tris.map(() => 0), source: 'flipped' },
    { units: mesh.units, name: `${mesh.name} flipped` });
}

/** The edge the two panels share. */
const ridgeEdge = (mesh) => mesh.edges.findIndex((e) => e.faces.length === 2
  && Math.abs(dihedralDeg(mesh, e.id)) > 1);

test('a convex ridge is a mountain and a concave one is a valley', () => {
  const up = ridge(1), down = ridge(-1);
  const eUp = ridgeEdge(up), eDown = ridgeEdge(down);
  assert.ok(eUp >= 0 && eDown >= 0, 'both fixtures have a crease');

  // atan(20/50) each side of flat: the surface turns through 2 * 21.8 degrees.
  const want = 2 * (Math.atan2(20, 50) * 180) / Math.PI;
  assert.ok(Math.abs(Math.abs(dihedralDeg(up, eUp)) - want) < 1e-9,
    `crease should turn through ${want} degrees`);

  assert.equal(foldSense(up, dihedralDeg(up, eUp)), 'mountain');
  assert.equal(foldSense(down, dihedralDeg(down, eDown)), 'valley');
});

test('the flat pattern is seen from OUTSIDE — no piece comes out mirrored', () => {
  // The claim the words mountain and valley rest on. Unfolding places each
  // triangle against one already down, and if it ever put one on the wrong side
  // that piece would be a mirror image: still the right shape, still the right
  // edge lengths, still nesting — and every fold on it reversed.
  for (const mesh of [dome(), bunny(), sphere(40, 12, 8)]) {
    const { patches } = segment(mesh, {});
    let checked = 0;
    for (const patch of patches.slice(0, 12)) {
      const flat = unfoldPatch(mesh, patch);
      for (const f of patch.faces) {
        const t = [0, 1, 2].map((k) => flat.xy.get(mesh.tris[f * 3 + k]));
        if (t.some((p) => !p)) continue;
        const twice = (t[1].u - t[0].u) * (t[2].v - t[0].v) - (t[2].u - t[0].u) * (t[1].v - t[0].v);
        assert.ok(twice > 0, `${mesh.name}: face ${f} came out mirrored`);
        checked++;
      }
    }
    assert.ok(checked > 20, `${mesh.name}: nothing was actually checked`);
  }
});

test('a model wound inside out still folds the same way', () => {
  // Winding is a property of the FILE; mountain and valley are properties of the
  // OBJECT. Reversing every triangle does not move a single vertex, so a model
  // exported inside out has to come back with the same creases going the same
  // way — otherwise it gets a pattern that is right in every respect except the
  // one instruction the dashes exist to give.
  // A closed model, because that is the only case where "inside out" means
  // anything: the bunny bounds a solid, so the divergence theorem answers it
  // exactly rather than by heuristic.
  const out = bunny();
  const inn = insideOut(out);
  assert.ok(out.stats.closed, 'the fixture bounds a solid');
  assert.equal(out.stats.orientation, 'outward');
  assert.equal(inn.stats.orientation, 'inward');

  // Matched by VERTEX PAIR, not by edge id: ids are handed out in the order the
  // faces walk their corners, so rewinding renumbers them and comparing id to id
  // compares two unrelated creases.
  let compared = 0, rawFlipped = 0;
  for (const e of out.edges) {
    const twin = inn.edgeOf.get(Math.min(e.a, e.b) * 4294967296 + Math.max(e.a, e.b));
    assert.notEqual(twin, undefined, `edge ${e.a}-${e.b} vanished when the file was rewound`);
    const ei = e.id;
    const da = dihedralDeg(out, e.id), db = dihedralDeg(inn, twin);
    if (da == null || db == null) continue;
    // The raw sign DOES flip — which is exactly why it cannot be used on its own.
    if (Math.sign(da) !== Math.sign(db)) rawFlipped++;
    assert.equal(foldSense(out, da), foldSense(inn, db),
      `edge ${ei} changed which way it folds when the file was rewound`);
    compared++;
  }
  assert.ok(compared > 50, 'there are creases to compare');
  assert.equal(rawFlipped, compared, 'the correction had nothing to correct — test is vacuous');
});

test('an open surface is taken as wound, and says so', () => {
  // A dish and a dome are the same triangles in the same places; only the
  // winding says which the author meant. Measuring the bulk anyway labels a dish
  // confidently inside out, and then the correction that exists to fix a
  // reversed model reverses a correct one instead — which is how this rule got
  // written. A gutter must come back a valley.
  const gutter = ridge(-1);
  assert.equal(gutter.stats.orientation, 'as-wound');
  assert.equal(foldSense(gutter, dihedralDeg(gutter, ridgeEdge(gutter))), 'valley');

  const plate = buildMesh({
    positions: [0, 0, 0, 100, 0, 0, 100, 60, 0, 0, 60, 0],
    tris: [0, 1, 2, 0, 2, 3],
    groups: [0, 0], source: 'plate',
  }, { units: 'mm', name: 'plate' });
  assert.equal(plate.stats.orientation, 'as-wound');
  assert.match(senseNote('as-wound'), /cannot be checked/i);
});

test('a convex model has no valley folds, and a lumpy one has both', () => {
  // Vacuous-test insurance. Every other assertion here would still pass if the
  // valley layer were never populated at all.
  const { result: d } = unfoldToSheets(dome(), CORO);
  const domeView = buildSheets(d);
  assert.equal(domeView.stats.valleys, 0, 'a dome is convex: nothing folds inward');
  assert.ok(domeView.stats.mountains > 20, 'and plenty folds outward');

  const { result: b } = unfoldToSheets(bunny(), CARD);
  const bunnyView = buildSheets(b);
  assert.ok(bunnyView.stats.valleys > 10, 'a bunny has hollows');
  assert.ok(bunnyView.stats.mountains > 10, 'and bumps');
});

test('every fold line on a sheet says which way it goes', () => {
  const { result } = unfoldToSheets(bunny(), CARD);
  const view = buildSheets(result);
  let folds = 0;
  for (const sheet of view.sheets) {
    for (const item of sheet.items) {
      const onFoldLayer = item.layer === LAYER.mountain || item.layer === LAYER.valley;
      if (onFoldLayer) {
        assert.ok(item.sense, `a ${item.kind} on the ${item.layer} layer with no sense`);
        assert.equal(LAYER[item.sense], item.layer, 'sense and layer disagree');
        folds++;
      } else {
        assert.ok(!item.sense, `a ${item.kind} carries a sense but is not on a fold layer`);
      }
    }
    assert.equal(sheet.mountains + sheet.valleys,
      sheet.items.filter((i) => i.sense).length, 'the counts miss lines that are drawn');
  }
  assert.ok(folds > 50, 'there were fold lines to check');
});

test('glue tabs always fold under, whatever the seam they serve does', () => {
  // The tab has to end up between the two panels, and the marked face is the
  // outside — so it goes away from the reader every time, including on the
  // valley seams where the panels go the other way.
  const { result } = unfoldToSheets(bunny(), CARD);
  const view = buildSheets(result);
  const tabs = view.sheets.flatMap((s) => s.items.filter((i) => i.kind === 'tabfold'));
  assert.ok(tabs.length > 20, 'there are tabs');
  for (const t of tabs) {
    assert.equal(t.sense, 'mountain');
    assert.equal(t.layer, LAYER.mountain);
  }
});

test('the two fold layers are drawn differently, and not only in colour', () => {
  // The regression guard. Unify these styles and the feature is gone with every
  // other test still passing, because the display list would be unchanged.
  const m = LAYER_STYLE[LAYER.mountain], v = LAYER_STYLE[LAYER.valley];
  assert.ok(Array.isArray(m.dash) && Array.isArray(v.dash), 'both are dashed');
  assert.notDeepEqual(m.dash, v.dash, 'two fold senses, one dash pattern');
  assert.notEqual(m.stroke, v.stroke);
  // Printed black and white, colour is gone and the pattern is all that is left,
  // so the two must differ in SHAPE and not just in length.
  assert.notEqual(m.dash.length, v.dash.length,
    'a longer dash of the same shape reads as the same line at a glance');
});

test('the key names both, in every place a sheet is drawn', () => {
  const words = LEGEND.map((l) => l.text).join(' ');
  assert.match(words, /mountain/i);
  assert.match(words, /valley/i);
  // And says which way each one bends, not just what it is called.
  assert.match(words, /towards you/i);
});

test('SVG: the two fold groups carry different dashes, in millimetres of sheet', () => {
  const { result } = unfoldToSheets(dome(), CORO);
  const view = buildSheets(result);
  const svg = sheetSVG(view.sheets[0]);

  const dashOf = (id) => {
    const g = svg.match(new RegExp(`<g id="${id}"[^>]*>`));
    assert.ok(g, `no ${id} group`);
    const d = g[0].match(/stroke-dasharray="([^"]+)"/);
    assert.ok(d, `${id} is not dashed`);
    return d[1].split(' ').map(Number);
  };
  const mountain = dashOf(LAYER.mountain);

  // The model is in metres. A dash written as "4" would be four metres long and
  // every fold line on the sheet would come out solid — the exact failure the
  // physical-units lesson exists for, one layer down.
  assert.ok(mountain[0] > 0.001 && mountain[0] < 0.05,
    `a dash of ${mountain[0]} m is not a dash: ${mountain}`);
  assert.ok(svg.includes('id="key"'), 'the sheet carries its own key');
  assert.match(svg, /mountain fold/);
  assert.match(svg, /valley fold/);
});

test('the seam list says the word, not just the sign', () => {
  const { result } = unfoldToSheets(bunny(), CARD);
  const assembly = buildAssembly(result);
  const withFold = assembly.joins.filter((j) => j.foldDeg != null);
  assert.ok(withFold.length > 20);
  for (const j of withFold) assert.ok(j.sense === 'mountain' || j.sense === 'valley', j);
  assert.equal(assembly.stats.mountains + assembly.stats.valleys, withFold.length);

  const text = assemblyText(result, assembly);
  assert.match(text, /mountain folds are dash-dot/);
  assert.match(text, /valley folds are plain dashed/);
});
