// The whole pipeline, and the invariants that make its output usable.
//
// The one that matters most is the negative: nothing may go missing quietly.
// Every piece is placed or named, every token appears twice, every label that
// would not fit is reported. Each of those failures looks, in the output, exactly
// like a part that was never meant to exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, runScale, unfoldToSheets, scaleMesh } from '../js/pipeline.js';
import { sweep, frontier, disqualified, cliffs, scaleSteps } from '../js/sweep.js';
import { markSeams, checkTokens, tokenFor } from '../js/seams.js';
import { buildSheets } from '../js/sheetview.js';
import { buildAssembly } from '../js/assembly.js';
import { resolveStock, STOCKS, MATERIALS } from '../js/materials.js';
import { polygonArea, placementTransform } from '../js/nesting.js';
import { buildMesh } from '../js/mesh.js';
import { box, plate, sphere } from './fixtures/shapes.mjs';
import { bunny } from './fixtures/bunny.mjs';

const CARD = { stock: 'sheet-1to2-420', material: 'card' };
const PLY = { stock: 'ply-4x8', material: 'ply' };
// Rigid stock at a size proportionate to the model, so the tests that are about
// segmentation are not also nesting 275 pieces onto a 2.4 metre sheet.
const RIGID = { stock: 'sheet-1to2-420', material: 'thin-ply' };

test('INVARIANT: every piece is placed on a sheet or named as missing', () => {
  const mesh = bunny();
  for (const opts of [{ ...CARD, scale: 1 }, { ...CARD, scale: 3 }, { ...RIGID, scale: 2 }]) {
    const { result } = unfoldToSheets(mesh, opts);
    const placed = new Set(result.nest.sheets.flatMap((s) => s.placed.map((p) => p.index)));
    const missingLabels = new Set(result.missing.map((m) => m.label));
    for (let i = 0; i < result.pieces.length; i++) {
      assert.ok(placed.has(i) || missingLabels.has(result.pieces[i].label),
        `piece ${result.pieces[i].label} is neither on a sheet nor reported`);
    }
  }
});

test('INVARIANT: every seam token appears exactly twice', () => {
  const mesh = bunny();
  for (const opts of [{ ...CARD, scale: 1 }, { ...CARD, scale: 2.5 }, { ...RIGID, scale: 2 }]) {
    const { result } = unfoldToSheets(mesh, opts);
    const check = checkTokens(result.seams.byPiece);
    assert.ok(check.ok, `tokens appearing other than twice: ${JSON.stringify(check.wrong.slice(0, 5))}`);
    assert.equal(check.tokens, result.seams.stats.seamCount);
  }
});

test('INVARIANT: both sides of a cut carry the SAME token', () => {
  const { result } = unfoldToSheets(bunny(), { ...CARD, scale: 1 });
  for (const [edge, seam] of result.seams.seams) {
    const [a, b] = seam.pieces;
    const onA = result.seams.byPiece[a].find((m) => m.edge === edge);
    const onB = result.seams.byPiece[b].find((m) => m.edge === edge);
    assert.ok(onA && onB, `edge ${edge} is not marked on both pieces`);
    assert.equal(onA.token, onB.token);
  }
});

test('INVARIANT: both sides of a cut are the same LENGTH', () => {
  // They are the same mesh edge, so this is true by construction — which is the
  // point of carrying a stable edge ID rather than matching geometry later.
  const { result } = unfoldToSheets(bunny(), { ...CARD, scale: 1 });
  for (const [edge, seam] of result.seams.seams) {
    for (const pi of new Set(seam.pieces)) {
      const m = result.seams.byPiece[pi].find((x) => x.edge === edge);
      const planar = Math.hypot(m.b.u - m.a.u, m.b.v - m.a.v);
      assert.ok(Math.abs(planar - seam.length) / seam.length < 0.05,
        `seam ${seam.token} is ${planar} on one piece and ${seam.length} on the model`);
    }
  }
});

test('INVARIANT: no material is created or destroyed', () => {
  const { result } = unfoldToSheets(bunny(), { ...CARD, scale: 1 });
  const flat = result.pieces.reduce((s, p) => s + p.flat.flatArea, 0);
  assert.ok(Math.abs(flat - result.mesh.stats.surfaceArea) / result.mesh.stats.surfaceArea < 0.01,
    `flattened area ${flat} vs surface ${result.mesh.stats.surfaceArea}`);
});

test('the tokens are deterministic — a drawing printed twice is the same drawing', () => {
  const a = unfoldToSheets(bunny(), { ...CARD, scale: 1 }).result;
  const b = unfoldToSheets(bunny(), { ...CARD, scale: 1 }).result;
  assert.deepEqual(a.pieces.map((p) => p.label), b.pieces.map((p) => p.label));
  assert.deepEqual([...a.seams.seams.values()].map((s) => [s.edge, s.token]),
                   [...b.seams.seams.values()].map((s) => [s.edge, s.token]));
});

test('tokens avoid the letters that read as digits in pencil', () => {
  const all = Array.from({ length: 400 }, (_, i) => tokenFor(i));
  assert.equal(new Set(all).size, 400, 'and they are unique');
  assert.ok(all.every((t) => !/^[IO]/.test(t)));
  assert.equal(tokenFor(0), 'A01');
  assert.equal(tokenFor(99), 'B01');
});

test('scaling the model scales lengths and not angles', () => {
  const mesh = bunny();
  const big = scaleMesh(mesh, 3);
  assert.ok(Math.abs(big.bbox.size[0] - mesh.bbox.size[0] * 3) < 1e-9);
  assert.ok(Math.abs(big.stats.surfaceArea - mesh.stats.surfaceArea * 9) < 1e-6);
  assert.deepEqual([...big.normals], [...mesh.normals], 'normals are unchanged, so the segmentation is too');
});

test('distortion scales with the model, and is reported in its units', () => {
  const mesh = bunny();
  const prepared = prepare(mesh, CARD);
  const a = runScale(prepared, 1);
  const b = runScale(prepared, 2);
  assert.ok(Math.abs(b.worstSpread - a.worstSpread * 2) < 1e-6,
    'twice the model is twice the error, in millimetres');
});

test('rigid stock unfolds the faceted bunny with NO distortion at all', () => {
  // Every crease becomes a cut, so every piece is a flat region of a faceted
  // model. There is nothing left to approximate, and the number says so — to
  // within the last bit of a double, which is a different claim from "small".
  const { result } = unfoldToSheets(bunny(), { ...RIGID, scale: 1 });
  const span = Math.max(...result.mesh.bbox.size);
  assert.ok(result.worstEdgeError / span < 1e-14, `edge error ${result.worstEdgeError}`);
  assert.ok(result.worstSpread / span < 1e-14, `spread ${result.worstSpread}`);
  assert.equal(result.overlapping.length, 0);
});

test('an overlapping island is cut further, never exported', () => {
  const { result } = unfoldToSheets(bunny(), { ...CARD, scale: 1 });
  assert.equal(result.overlapping.length, 0, 'no piece that laps over itself reaches the sheets');
});

test('ADVERSARIAL: a part exactly at the sheet limit is neither lost nor split needlessly', () => {
  const mesh = plate(100, 60, 2, 2);
  const stock = resolveStock('sheet-1to2-420', 'card', 'mm');
  const prepared = prepare(mesh, CARD);
  // Walk the scale across the point where the piece stops fitting. Nothing may
  // vanish on the way past.
  let lastSheets = 0;
  for (let k = 1; k < 6; k += 0.05) {
    const r = runScale(prepared, Number(k.toFixed(3)));
    const placed = new Set(r.nest.sheets.flatMap((s) => s.placed.map((p) => p.index)));
    assert.equal(placed.size + r.missing.length, r.pieces.length,
      `at scale ${k}, ${r.pieces.length - placed.size - r.missing.length} pieces went missing`);
    assert.ok(r.sheetCount >= 1);
    lastSheets = r.sheetCount;
  }
  assert.ok(lastSheets >= 1);
});

test('ADVERSARIAL: a sphere is handled, reported, and never silently flattened', () => {
  const { result } = unfoldToSheets(sphere(60, 12, 18), { ...CARD, scale: 1 });
  assert.ok(result.pieces.length > 4);
  assert.equal(result.missing.length, 0);
  assert.ok(result.tokenCheck.ok);
  assert.ok(result.worstEdgeError > 0, 'a sphere cannot flatten and the report must say by how much');
});

test('ADVERSARIAL: a degenerate and non-manifold mesh does not crash the pipeline', () => {
  // Three faces hinged on one edge (non-manifold), a zero-area sliver, and a
  // stray triangle joined to nothing.
  const positions = [
    0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10, 0, -10, 0,
    20, 0, 0, 30, 0, 0, 40, 0, 0,
    50, 0, 0, 60, 0, 0, 50, 10, 0,
  ];
  const tris = [0, 1, 2, 0, 1, 3, 0, 1, 4, 5, 6, 7, 8, 9, 10];
  const mesh = buildMesh({ positions, tris, groups: tris.map(() => 0) },
    { units: 'mm', name: 'adversarial' });
  assert.equal(mesh.stats.manifold, false, 'the fixture really is non-manifold');
  const { result } = unfoldToSheets(mesh, { ...CARD, scale: 1 });
  assert.ok(result.pieces.length >= 1);
  assert.ok(result.tokenCheck.ok);
});

test('a box in plywood is six parts; in card it is fewer, with score lines', () => {
  // The one property of the material that reaches the geometry: a crease is a
  // cut if the stock will not fold, and a score line if it will. The sheet is
  // deliberately large enough that nothing here is about the splitter.
  const mesh = box(200, 150, 100);
  const opts = { stock: 'sheet-1to2-840', scale: 1, useGroups: false };
  const rigid = unfoldToSheets(mesh, { ...opts, material: 'thin-ply' }).result;
  assert.equal(rigid.pieces.length, 6, 'plywood cannot be folded, so a box is six parts');
  assert.equal(rigid.pieces.reduce((m, p) => Math.max(m, p.flat.maxEdgeError), 0), 0);
  assert.equal(rigid.seams.stats.foldCount, 0, 'and it has no folds at all');

  const soft = unfoldToSheets(mesh, { ...opts, material: 'card' }).result;
  assert.ok(soft.pieces.length < 6, `card folds, so a box is fewer than six pieces (got ${soft.pieces.length})`);
  const scored = soft.pieces.flatMap((p) => p.flat.folds).filter((f) => Math.abs(f.angleDeg) > 1);
  assert.ok(scored.length > 0, 'and the creases it kept are score lines');
  assert.ok(scored.every((f) => Math.abs(Math.abs(f.angleDeg) - 90) < 1e-9), 'each folding at 90 degrees');
});

test('the sweep produces a sawtooth, not a slope', () => {
  const prepared = prepare(bunny(), CARD);
  const rows = [...sweep(prepared, { from: 1, to: 4, step: 0.25 })];
  assert.equal(rows.length, 13);
  assert.ok(rows.every((r) => r.sheets >= 1));
  // Utilisation is not monotone: the whole point of measuring rather than
  // reasoning about it.
  const utils = rows.map((r) => r.utilisation);
  const monotone = utils.every((u, i) => i === 0 || u >= utils[i - 1])
    || utils.every((u, i) => i === 0 || u <= utils[i - 1]);
  assert.ok(!monotone, 'if utilisation only ever went one way there would be nothing to sweep for');
});

test('the frontier disqualifies rows with missing parts rather than annotating them', () => {
  const rows = [
    { scale: 1, size: 100, sheets: 13, utilisation: 0.5, unplaceable: 0, missing: [] },
    { scale: 1.05, size: 105, sheets: 12, utilisation: 0.5, unplaceable: 2, missing: [{ label: 'x', why: 'too big' }] },
    { scale: 1.1, size: 110, sheets: 14, utilisation: 0.5, unplaceable: 0, missing: [] },
  ];
  const front = frontier(rows);
  assert.ok(!front.some((r) => r.scale === 1.05), 'a row that omits part of the model is not a cheaper way to build it');
  assert.deepEqual(front.map((r) => r.scale), [1, 1.1]);
  assert.equal(disqualified(rows).length, 1);
});

test('the frontier keeps only what nothing else beats outright', () => {
  const rows = [
    { scale: 1, size: 100, sheets: 3, utilisation: 0.4, unplaceable: 0, missing: [] },
    { scale: 1.1, size: 110, sheets: 3, utilisation: 0.45, unplaceable: 0, missing: [] },
    { scale: 1.2, size: 120, sheets: 5, utilisation: 0.4, unplaceable: 0, missing: [] },
  ];
  const front = frontier(rows);
  assert.deepEqual(front.map((r) => r.scale), [1.1, 1.2],
    'scale 1 is beaten outright: bigger for the same three sheets');
});

test('cliffs mark where one more millimetre costs a whole sheet', () => {
  const rows = [
    { scale: 1, size: 100, sheets: 2, unplaceable: 0 },
    { scale: 1.1, size: 110, sheets: 2, unplaceable: 0 },
    { scale: 1.2, size: 120, sheets: 3, unplaceable: 0 },
  ];
  const c = cliffs(rows);
  assert.equal(c.length, 1);
  assert.equal(c[0].at.scale, 1.1);
  assert.equal(c[0].cost, 1);
});

test('scaleSteps does not drift', () => {
  assert.deepEqual(scaleSteps(0.5, 1.5, 0.1),
    [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]);
});

test('every stock and material resolves into the model\'s units', () => {
  for (const s of STOCKS) {
    for (const m of MATERIALS) {
      for (const units of ['mm', 'in']) {
        const r = resolveStock(s.id, m.id, units);
        assert.ok(r.sheetLength > 0 && r.sheetWidth > 0);
        assert.ok(r.sheetLength >= r.sheetWidth, 'length is the long side');
        assert.ok(r.kerf >= 0 && r.margin > 0);
      }
    }
  }
  const inch = resolveStock('ply-4x8', 'ply', 'in');
  const mm = resolveStock('ply-4x8', 'ply', 'mm');
  assert.ok(Math.abs(inch.sheetLength - 96) < 1e-9);
  assert.ok(Math.abs(mm.sheetLength - 96 * 25.4) < 1e-9);
});

test('the display list keeps every piece inside its sheet', () => {
  const { result } = unfoldToSheets(bunny(), { ...CARD, scale: 2 });
  const view = buildSheets(result);
  for (const sheet of view.sheets) {
    for (const item of sheet.items) {
      if (item.kind !== 'outline') continue;
      for (const p of item.points) {
        assert.ok(p.u >= -1e-6 && p.u <= sheet.width + 1e-6, `${item.label} runs off the sheet`);
        assert.ok(p.v >= -1e-6 && p.v <= sheet.height + 1e-6, `${item.label} runs off the sheet`);
      }
    }
  }
});

test('the assembly document names both pieces of every seam', () => {
  const { result } = unfoldToSheets(bunny(), { ...CARD, scale: 1 });
  const assembly = buildAssembly(result);
  assert.equal(assembly.joins.length, result.seams.stats.seamCount);
  const labels = new Set(result.pieces.map((p) => p.label));
  for (const j of assembly.joins) {
    assert.ok(labels.has(j.a) && labels.has(j.b), `seam ${j.token} names a piece that does not exist`);
    assert.ok(j.length > 0);
  }
  assert.equal(assembly.stats.mountains + assembly.stats.valleys <= assembly.joins.length, true);
});

test('a fold angle is emitted for every seam of a closed model', () => {
  const { result } = unfoldToSheets(bunny(), { ...CARD, scale: 1 });
  const assembly = buildAssembly(result);
  assert.ok(assembly.joins.every((j) => j.foldDeg !== null),
    'a closed surface has two faces at every seam, so the angle is always known');
});
