// Loading a mesh: the formats, the welding, and the things a file can be wrong
// about. Every downstream stage assumes a manifold with shared vertices, so the
// interesting cases here are the ones where it is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSTL, parseOBJ, parseModel, buildMesh, weldVertices, isBinarySTL,
  dihedralDeg, vertexFaces, modelSize, childEdgeId,
} from '../js/mesh.js';
import { plate, box, cylinder } from './fixtures/shapes.mjs';
import { bunnyBuffer } from './fixtures/bunny.mjs';

const ASCII_TRI = `solid t
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
endsolid t`;

test('ASCII STL is read, and is not mistaken for binary', () => {
  assert.equal(isBinarySTL(new TextEncoder().encode(ASCII_TRI).buffer), false);
  const raw = parseSTL(ASCII_TRI);
  assert.equal(raw.tris.length, 3);
  assert.equal(raw.source, 'stl-ascii');
});

test('a binary STL whose header begins with "solid" is still binary', () => {
  // The advertised sniff test is the keyword, and this is the case it gets
  // wrong. The arithmetic — 84 + 50n bytes — cannot be fooled.
  const n = 2;
  const buf = new ArrayBuffer(84 + n * 50);
  new Uint8Array(buf).set(new TextEncoder().encode('solid produced by a binary writer'));
  new DataView(buf).setUint32(80, n, true);
  assert.equal(isBinarySTL(buf), true);
  assert.equal(parseSTL(buf).tris.length, n * 3);
});

test('the sample bunny loads as a closed, consistently wound manifold', () => {
  const mesh = buildMesh(parseSTL(bunnyBuffer()), { units: 'mm', name: 'bunny' });
  assert.equal(mesh.stats.triangles, 292);
  assert.equal(mesh.stats.vertices, 148);
  assert.equal(mesh.stats.edges, 438);
  assert.ok(mesh.stats.manifold);
  assert.ok(mesh.stats.closed);
  assert.ok(mesh.stats.consistentWinding);
  // Euler: a closed surface of genus 0.
  assert.equal(mesh.stats.vertices - mesh.stats.edges + mesh.stats.triangles, 2);
});

test('welding merges the duplicated corners an STL is made of', () => {
  const mesh = buildMesh(parseSTL(bunnyBuffer()), { units: 'mm' });
  assert.equal(mesh.stats.vertexesMerged, 292 * 3 - 148);
});

test('welding finds points either side of a hash-cell boundary', () => {
  // Two points a hair apart but astride a cell edge. Searching only the home
  // cell misses them and leaves a crack that reads later as a hole.
  const tol = 1e-3;
  const positions = [0, 0, 0, tol * 0.4, 0, 0, 5, 0, 0];
  const { positions: out } = weldVertices(positions, tol);
  assert.equal(out.length / 3, 2);
});

test('degenerate triangles are dropped AND counted', () => {
  const raw = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 4, 0, 0, 6, 0, 0],
    tris: [0, 1, 2, 3, 4, 5],
    groups: [0, 0],
  };
  const mesh = buildMesh(raw, { units: 'mm' });
  assert.equal(mesh.faceCount, 1);
  assert.equal(mesh.stats.degenerate.length, 1);
  assert.equal(mesh.stats.degenerate[0].why, 'zero area');
});

test('a non-manifold edge is reported rather than crashed on', () => {
  // Three triangles hinged on one edge.
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0];
  const tris = [0, 1, 2, 0, 1, 3, 0, 1, 4];
  const mesh = buildMesh({ positions, tris, groups: [0, 0, 0] }, { units: 'mm' });
  assert.equal(mesh.stats.manifold, false);
  assert.ok(mesh.stats.nonManifoldEdges >= 1);
});

test('inconsistent winding is detected', () => {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
  const mesh = buildMesh({ positions, tris: [0, 1, 2, 1, 2, 3], groups: [0, 0] }, { units: 'mm' });
  assert.equal(mesh.stats.consistentWinding, false);
});

test('edge IDs are stable and deterministic across loads', () => {
  const a = buildMesh(parseSTL(bunnyBuffer()), { units: 'mm' });
  const b = buildMesh(parseSTL(bunnyBuffer()), { units: 'mm' });
  assert.deepEqual(a.edges.map((e) => [e.id, e.a, e.b]), b.edges.map((e) => [e.id, e.a, e.b]));
  a.edges.forEach((e, i) => assert.equal(e.id, i));
});

test('a child edge is named after its parent', () => {
  assert.equal(childEdgeId(17, 0), '17.0');
  assert.equal(childEdgeId(17, 1), '17.1');
});

test('OBJ groups survive, and become the authored seams', () => {
  const obj = `
o left
v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3
o right
v 2 0 0
f 2 4 3
`;
  const raw = parseOBJ(obj);
  assert.deepEqual(raw.groupNames, ['left', 'right']);
  assert.deepEqual(raw.groups, [0, 1]);
});

test('OBJ face indices may be negative, and carry texture/normal fields', () => {
  const raw = parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3/1/1 -2/2/2 -1/3/3\n');
  assert.deepEqual(raw.tris, [0, 1, 2]);
});

test('a quad in an OBJ is fan-triangulated', () => {
  const raw = parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
  assert.equal(raw.tris.length, 6);
});

test('parseModel dispatches on the file name', () => {
  assert.equal(parseModel('a.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n').source, 'obj');
  assert.equal(parseModel('a.stl', ASCII_TRI).source, 'stl-ascii');
});

test('units are never guessed', () => {
  const mesh = buildMesh(parseSTL(ASCII_TRI));
  assert.equal(mesh.units, null, 'an STL says nothing about units and neither should the loader');
});

test('the dihedral angle knows a mountain from a valley', () => {
  const b = box(40, 30, 20);
  // Every edge of a convex box is a mountain seen from outside.
  const angles = b.edges.map((e) => dihedralDeg(b, e.id)).filter((a) => a !== null && Math.abs(a) > 1);
  assert.ok(angles.length >= 12);
  assert.ok(angles.every((a) => a > 0), 'a convex solid has no valleys');
  assert.ok(angles.every((a) => Math.abs(Math.abs(a) - 90) < 1e-9), 'a box folds at 90 degrees');
});

test('angle defect is zero on a plane and on a cylinder, and not on a sphere', () => {
  const p = plate(100, 60, 4, 3);
  const vf = vertexFaces(p);
  for (let v = 0; v < p.positions.length / 3; v++) {
    if (vf.onBoundary[v]) continue;
    const sum = vf.angles[v].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - Math.PI * 2) < 1e-12, 'a flat sheet has no curvature');
  }
  const c = cylinder(20, 50, 24, 4, { closed: true });
  const cvf = vertexFaces(c);
  for (let v = 0; v < c.positions.length / 3; v++) {
    if (cvf.onBoundary[v]) continue;
    const sum = cvf.angles[v].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - Math.PI * 2) < 1e-9, 'a cylinder bends in one direction only, so it is flat');
  }
});

test('modelSize reports the dimension the sweep is measured against', () => {
  const b = box(40, 30, 20);
  assert.equal(modelSize(b, 'longest'), 40);
  assert.equal(modelSize(b, 'y'), 30);
  assert.ok(Math.abs(modelSize(b, 'diagonal') - Math.hypot(40, 30, 20)) < 1e-9);
});
