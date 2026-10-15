// Where the seams go — and, more importantly, that the user can always say
// otherwise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  segment, segmentByGroups, segmentByCurvature, seamEdges, connectedComponents,
} from '../js/segment.js';
import { buildMesh, parseOBJ, parseSTL, vertexFaces } from '../js/mesh.js';
import { plate, box, cylinder, sphere, cone } from './fixtures/shapes.mjs';
import { bunny } from './fixtures/bunny.mjs';

const CURVY = { maxFoldDeg: 179, maxDefectDeg: 8, maxTotalDefectDeg: 15, maxPerimeterRatio: 2.2 };

test('a flat plate is one patch — there is nothing to cut', () => {
  const mesh = plate(100, 60, 4, 3);
  const patches = segmentByCurvature(mesh, CURVY);
  assert.equal(patches.length, 1);
  assert.equal(seamEdges(mesh, patches).cuts.length, 14, 'only the rim is a cut');
});

test('rigid stock turns every crease into a cut; foldable stock does not', () => {
  const mesh = box(40, 30, 20);
  const rigid = segmentByCurvature(mesh, { maxFoldDeg: 2, maxDefectDeg: 1, maxTotalDefectDeg: 1 });
  assert.equal(rigid.length, 6, 'plywood cannot be folded, so a box is six parts');
  const foldable = segmentByCurvature(mesh, { ...CURVY, maxPerimeterRatio: 99 });
  assert.ok(foldable.length < 6, 'card folds, so a box is fewer pieces with score lines');
});

test('OBJ groups are used in preference to guessing', () => {
  const mesh = box(40, 30, 20);
  const r = segment(mesh, CURVY);
  assert.equal(r.method, 'groups');
  assert.equal(r.patches.length, 6);
  assert.deepEqual(r.patches.map((p) => p.key), ['face 1', 'face 2', 'face 3', 'face 4', 'face 5', 'face 6']);
});

test('a group naming two disconnected regions is separated, not silently joined', () => {
  // A label is not a region: "left ear" can perfectly well name two faces at
  // opposite ends of a model, and every later stage assumes it can walk from
  // any face of a patch to any other.
  const obj = `
o both
v 0 0 0
v 1 0 0
v 0 1 0
v 50 0 0
v 51 0 0
v 50 1 0
f 1 2 3
f 4 5 6
`;
  const mesh = buildMesh(parseOBJ(obj), { units: 'mm' });
  const patches = segmentByGroups(mesh);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches.map((p) => p.key), ['both (1)', 'both (2)']);
});

test('an explicit seam wins over the heuristic', () => {
  const mesh = plate(100, 60, 2, 1);
  const before = segmentByCurvature(mesh, CURVY);
  assert.equal(before.length, 1);
  // Cut the plate down an interior edge that nothing about the geometry
  // suggests. A heuristic with no override is a trap: every one of them meets
  // input that names things differently, and guessing harder only moves it.
  const interior = mesh.edges.find((e) => e.faces.length === 2);
  const after = segmentByCurvature(mesh, { ...CURVY, forceSeam: new Set([interior.id]) });
  assert.ok(after.length > 1, 'the declared seam was honoured');
});

test('an explicit join wins too — the override includes saying "no"', () => {
  const mesh = box(40, 30, 20);
  const rigid = { maxFoldDeg: 2, maxDefectDeg: 90, maxTotalDefectDeg: 400, maxPerimeterRatio: 99 };
  const plain = segmentByCurvature(mesh, rigid);
  const creases = mesh.edges.filter((e) => e.faces.length === 2).map((e) => e.id);
  const joined = segmentByCurvature(mesh, { ...rigid, forceJoin: new Set(creases) });
  assert.ok(joined.length < plain.length, 'the declared join was honoured against the fold limit');
});

test('a pinned face is placed before anything is grown', () => {
  const mesh = plate(100, 60, 4, 3);
  const forcePatch = new Map([[0, 'keep'], [1, 'keep']]);
  const patches = segmentByCurvature(mesh, { ...CURVY, forcePatch });
  const pinned = patches.find((p) => p.key === 'keep');
  assert.ok(pinned, 'the pinned patch exists under its own name');
  assert.deepEqual(pinned.faces, [0, 1]);
  assert.equal(pinned.source, 'pinned');
});

test('every patch is a topological disc', () => {
  // Not a nicety. A patch with a slit encloses no curvature and so passes every
  // curvature test while being unflattenable in practice, and a patch with a
  // hole cannot be laid down at all.
  for (const mesh of [sphere(30, 12, 18), cylinder(20, 50, 24, 4, { closed: true }), cone(30, 40, 24)]) {
    for (const p of segmentByCurvature(mesh, CURVY)) {
      const verts = new Set(), edges = new Set();
      for (const f of p.faces) {
        for (let k = 0; k < 3; k++) { verts.add(mesh.tris[f * 3 + k]); edges.add(mesh.faceEdges[f * 3 + k]); }
      }
      assert.equal(verts.size - edges.size + p.faces.length, 1,
        `patch ${p.key} of ${mesh.name} is not a disc`);
    }
  }
});

test('patches stay compact — a developable snake is not a usable part', () => {
  const mesh = bunny();
  const patches = segmentByCurvature(mesh, CURVY);
  for (const p of patches) {
    if (p.faces.length < 4) continue;                 // a seed is allowed to be thin
    assert.ok(p.perimeterRatio <= 2.2 + 1e-9,
      `patch ${p.key} has perimeter ratio ${p.perimeterRatio}`);
  }
});

test('the curvature budget binds on a sphere, where a per-corner test would not', () => {
  const mesh = sphere(30, 12, 18);
  const patches = segmentByCurvature(mesh, CURVY);
  for (const p of patches) {
    assert.ok(p.totalDefectDeg <= 15 + 1e-6, `patch ${p.key} encloses ${p.totalDefectDeg} degrees`);
  }
  assert.ok(patches.length > 4, 'a sphere has to be cut up; there is no way around it');
});

test('every face lands in exactly one patch', () => {
  const mesh = bunny();
  for (const opts of [CURVY, { maxFoldDeg: 2, maxDefectDeg: 1, maxTotalDefectDeg: 1 }]) {
    const patches = segmentByCurvature(mesh, opts);
    const seen = new Set();
    for (const p of patches) for (const f of p.faces) {
      assert.ok(!seen.has(f), `face ${f} is in two patches`);
      seen.add(f);
    }
    assert.equal(seen.size, mesh.faceCount, 'no face was left out');
  }
});

test('a cut edge is never also a fold edge', () => {
  const mesh = bunny();
  const patches = segmentByCurvature(mesh, CURVY);
  const { cuts, folds } = seamEdges(mesh, patches);
  const cutSet = new Set(cuts);
  assert.ok(folds.every((f) => !cutSet.has(f)));
  assert.equal(cuts.length + folds.length, mesh.edges.length);
});

test('connectedComponents can be blocked at declared seams', () => {
  const mesh = plate(100, 60, 2, 1);
  const all = Array.from({ length: mesh.faceCount }, (_, i) => i);
  assert.equal(connectedComponents(mesh, all).length, 1);
  const interior = mesh.edges.filter((e) => e.faces.length === 2).map((e) => e.id);
  const blocked = connectedComponents(mesh, all, new Set(interior));
  assert.equal(blocked.length, mesh.faceCount, 'every crease blocked means every face alone');
});
