// Flattening, checked against shapes whose flat patterns are known exactly.
//
// These are worth more than any amount of looking at the output, because they
// fail NUMERICALLY rather than plausibly. A wrong unfold looks like a plausible
// unfold; it does not look like 100.0001 where 100 was expected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unfoldPatch, unfoldAll, boundaryLoops, polygonArea } from '../js/unfold.js';
import { segmentByCurvature } from '../js/segment.js';
import { edgeLength } from '../js/mesh.js';
import { plate, cylinder, cone, box, sphere, chord } from './fixtures/shapes.mjs';

const wholeMesh = (mesh, key = 'all') => ({
  id: 0, key, label: key, seed: 0,
  faces: Array.from({ length: mesh.faceCount }, (_, i) => i),
  area: mesh.stats.surfaceArea,
});

/** The invariant the whole tool exists to deliver, asserted directly. */
function assertEdgeLengthsPreserved(mesh, flat, tol) {
  let worst = 0;
  for (const f of flat.faces) {
    for (let k = 0; k < 3; k++) {
      const a = mesh.tris[f * 3 + k], b = mesh.tris[f * 3 + ((k + 1) % 3)];
      const want = edgeLength(mesh, a, b);
      const A = flat.xy.get(a), B = flat.xy.get(b);
      worst = Math.max(worst, Math.abs(Math.hypot(A.u - B.u, A.v - B.v) - want));
    }
  }
  assert.ok(worst <= tol, `worst edge length error ${worst} exceeds ${tol}`);
  return worst;
}

test('EXACT: a flat plate unfolds to itself', () => {
  const mesh = plate(100, 60, 4, 3);
  const flat = unfoldPatch(mesh, wholeMesh(mesh, 'plate'));
  assert.ok(flat.spread < 1e-9, `spread ${flat.spread}`);
  assert.ok(flat.maxEdgeError < 1e-9);
  assert.ok(Math.abs(flat.width - 100) < 1e-9, `width ${flat.width}`);
  assert.ok(Math.abs(flat.height - 60) < 1e-9, `height ${flat.height}`);
  assert.ok(Math.abs(flat.flatArea - 6000) < 1e-9);
  assert.equal(flat.overlaps.length, 0);
  assertEdgeLengthsPreserved(mesh, flat, 1e-9);
});

test('EXACT: an open tube unfolds to a rectangle of height by CHORD circumference', () => {
  // Not pi*d. The mesh is a prism and its edges are straight lines; a pattern
  // measured to the true circle is longer than the part it has to fit.
  const segments = 24, radius = 20, height = 50;
  const mesh = cylinder(radius, height, segments, 4, { closed: false });
  const flat = unfoldPatch(mesh, wholeMesh(mesh, 'tube'));
  const expected = chord(radius, segments) * (segments - 1);
  assert.ok(flat.spread < 1e-9, `spread ${flat.spread}`);
  assert.ok(Math.abs(flat.width - expected) < 1e-9, `${flat.width} vs ${expected}`);
  assert.ok(Math.abs(flat.height - height) < 1e-9);
  assert.equal(flat.overlaps.length, 0);
  assertEdgeLengthsPreserved(mesh, flat, 1e-9);
});

test('a CLOSED tube cannot be flattened in one piece, and says so', () => {
  // It is developable everywhere and still not flattenable: an annulus is not a
  // disc. Walking round it disagrees with itself by one whole circumference,
  // and that is the number that must come out — not a rectangle that does not
  // exist.
  const mesh = cylinder(20, 50, 24, 4, { closed: true });
  const flat = unfoldPatch(mesh, wholeMesh(mesh, 'tube'));
  const circumference = chord(20, 24) * 24;
  assert.ok(Math.abs(flat.spread - circumference) < 1e-6,
    `spread ${flat.spread} should be the circumference ${circumference}`);
});

test('segmentation cuts the closed tube, and both pieces then flatten exactly', () => {
  const mesh = cylinder(20, 50, 24, 4, { closed: true });
  const patches = segmentByCurvature(mesh, { maxFoldDeg: 179, maxDefectDeg: 1, maxTotalDefectDeg: 1, maxPerimeterRatio: 99 });
  const r = unfoldAll(mesh, patches);
  assert.ok(patches.length >= 2, 'the ring has to be cut somewhere');
  assert.ok(r.worstSpread < 1e-9, `worst spread ${r.worstSpread}`);
  assert.ok(r.worstEdgeError < 1e-9);
  assert.equal(r.overlapping.length, 0);
});

test('EXACT: a cone unfolds to a sector, once its apex is not enclosed', () => {
  const radius = 30, height = 40, segments = 24;
  const mesh = cone(radius, height, segments);
  const patches = segmentByCurvature(mesh, { maxFoldDeg: 179, maxDefectDeg: 8, maxTotalDefectDeg: 15, maxPerimeterRatio: 99 });
  // The apex carries 145 degrees of curvature, so the face that would close it
  // is refused and the rest is a sector.
  const big = patches.reduce((a, b) => (a.faces.length >= b.faces.length ? a : b));
  assert.equal(big.faces.length, segments - 1);
  const flat = unfoldPatch(mesh, big);
  assert.ok(flat.spread < 1e-9, `spread ${flat.spread}`);
  assertEdgeLengthsPreserved(mesh, flat, 1e-9);

  // What a sector IS, checked directly rather than through the formula for a
  // circular one. The boundary here is 23 straight chords, not an arc, so
  // 0.5*r^2*theta overstates the area by a few parts in a thousand — the same
  // arc-versus-chord mistake the cylinder fixture exists to catch, and it is
  // just as easy to make in the test as in the code.
  const slant = Math.hypot(radius, height);
  const apex = segments;
  const apexAt = flat.xy.get(apex);
  assert.ok(apexAt, 'the apex is in the pattern');

  // Every rim vertex sits exactly one slant length from the apex.
  const rim = [...new Set(big.faces.flatMap((f) =>
    [0, 1, 2].map((k) => mesh.tris[f * 3 + k])))].filter((v) => v !== apex);
  for (const v of rim) {
    const p = flat.xy.get(v);
    assert.ok(Math.abs(Math.hypot(p.u - apexAt.u, p.v - apexAt.v) - slant) < 1e-9,
      'a cone rolls out onto a circle of its own slant height');
  }

  // The sector's opening: 23 facets, each subtending the same angle at the apex.
  const facetAngle = 2 * Math.asin(chord(radius, segments) / (2 * slant));
  const angles = rim.map((v) => {
    const p = flat.xy.get(v);
    return Math.atan2(p.v - apexAt.v, p.u - apexAt.u);
  }).sort((a, b) => a - b);
  // Measured as a full turn less the empty wedge, because the sector straddles
  // the point where atan2 wraps and min-to-max would measure the wrong side.
  let widestGap = angles[0] + Math.PI * 2 - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) widestGap = Math.max(widestGap, angles[i] - angles[i - 1]);
  const opened = Math.PI * 2 - widestGap;
  assert.ok(Math.abs(opened - facetAngle * (segments - 1)) < 1e-9,
    `sector opens ${opened} rad, expected ${facetAngle * (segments - 1)}`);

  // An isometric unfold neither creates nor destroys material.
  const surface = big.faces.reduce((s, f) => s + mesh.areas[f], 0);
  assert.ok(Math.abs(flat.flatArea - surface) / surface < 1e-9,
    `flat area ${flat.flatArea} vs surface ${surface}`);
});

test('a box unfolds with zero error, folding rather than cutting at its creases', () => {
  const mesh = box(40, 30, 20);
  const patches = segmentByCurvature(mesh, { maxFoldDeg: 179, maxDefectDeg: 1, maxTotalDefectDeg: 1, maxPerimeterRatio: 99 });
  const r = unfoldAll(mesh, patches);
  assert.ok(r.worstEdgeError < 1e-9, `edge error ${r.worstEdgeError}`);
  assert.equal(r.overlapping.length, 0);
  const flatArea = r.flats.reduce((s, f) => s + f.flatArea, 0);
  assert.ok(Math.abs(flatArea - mesh.stats.surfaceArea) < 1e-6, 'no material is created or lost');
  assert.ok(r.flats.some((f) => f.folds.length > 0), 'a box has creases, and they are folds not cuts');
});

test('a sphere is NOT flattened silently — the error is measured and reported', () => {
  const mesh = sphere(30, 12, 18);
  const flat = unfoldPatch(mesh, wholeMesh(mesh, 'sphere'));
  assert.ok(flat.spread > 1, 'a sphere does not flatten, and the number must say so');
  assert.ok(flat.maxEdgeError > 0.01);
});

test('orientation is normalised, so a piece is measured along its own length', () => {
  // The same plate, rotated in space. The pattern must come out the same size
  // either way: it is the same part, and everything downstream reads a bounding
  // box.
  const flat0 = unfoldPatch(plate(100, 60, 4, 3), wholeMesh(plate(100, 60, 4, 3)));
  const tilted = plate(100, 60, 4, 3);
  const a = 0.6, c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < tilted.positions.length; i += 3) {
    const x = tilted.positions[i], y = tilted.positions[i + 1];
    tilted.positions[i] = x * c - y * s;
    tilted.positions[i + 1] = x * s + y * c;
  }
  const flat1 = unfoldPatch(tilted, wholeMesh(tilted));
  assert.ok(Math.abs(flat1.width - flat0.width) < 1e-9, `${flat1.width} vs ${flat0.width}`);
  assert.ok(Math.abs(flat1.height - flat0.height) < 1e-9);
});

test('overlap is detected when a patch laps over itself', () => {
  // A cone flattened WITH its apex enclosed has 145 degrees of missing angle. It
  // must not be exported as though it were fine.
  const mesh = cone(30, 40, 24);
  const flat = unfoldPatch(mesh, wholeMesh(mesh, 'cone'), { relax: 0 });
  assert.ok(flat.overlaps.length > 0 || flat.spread > 1,
    'an unflattenable patch must report either overlap or spread');
});

test('the boundary of a patch comes back as one closed ring', () => {
  const mesh = plate(100, 60, 4, 3);
  const loops = boundaryLoops(mesh, Array.from({ length: mesh.faceCount }, (_, i) => i));
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 2 * (4 + 3), 'a 4x3 grid has 14 boundary edges');
});

test('an annulus reports its hole rather than swallowing it', () => {
  const mesh = cylinder(20, 50, 24, 4, { closed: true });
  const flat = unfoldPatch(mesh, wholeMesh(mesh));
  assert.equal(flat.holes.length, 1, 'a tube laid flat is a ring, and a ring has a hole');
});

test('polygon area is orientation-independent', () => {
  const sq = [{ u: 0, v: 0 }, { u: 2, v: 0 }, { u: 2, v: 2 }, { u: 0, v: 2 }];
  assert.equal(polygonArea(sq), 4);
  assert.equal(polygonArea(sq.slice().reverse()), 4);
});
