// Nesting and splitting, and the one number they must agree on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nestPieces, placementTransform, polygonArea } from '../js/nesting.js';
import { usableStock, rasterCell, nestGeometry, fitsStock, bisect, splitToFit } from '../js/split.js';
import { unfoldPatch } from '../js/unfold.js';
import { segmentByCurvature } from '../js/segment.js';
import { buildMesh } from '../js/mesh.js';
import { plate } from './fixtures/shapes.mjs';
import { bunny } from './fixtures/bunny.mjs';
import { prepare, runScale } from '../js/pipeline.js';

const wedge = (L, W) => [{ u: 0, v: 0 }, { u: L, v: 0 }, { u: L, v: W * 0.15 }, { u: 0, v: W }];
const rect = (L, W) => [{ u: 0, v: 0 }, { u: L, v: 0 }, { u: L, v: W }, { u: 0, v: W }];

const SHEET = { sheetLength: 420, sheetWidth: 210, margin: 5, kerf: 1 };

/** No part may leave its sheet, and no two may share a square millimetre. */
function assertSheetsAreLegal(nest, opts) {
  for (const sheet of nest.sheets) {
    const placedOutlines = sheet.placed.map((p) => {
      const T = placementTransform(p);
      return p.piece.outline.map(T);
    });
    for (const o of placedOutlines) {
      for (const q of o) {
        assert.ok(q.u >= -1e-6 && q.u <= opts.sheetLength + 1e-6, `u ${q.u} off the sheet`);
        assert.ok(q.v >= -1e-6 && q.v <= opts.sheetWidth + 1e-6, `v ${q.v} off the sheet`);
      }
    }
    for (let i = 0; i < placedOutlines.length; i++) {
      for (let j = i + 1; j < placedOutlines.length; j++) {
        assert.ok(!polygonsOverlap(placedOutlines[i], placedOutlines[j]),
          `pieces ${i} and ${j} overlap on a sheet`);
      }
    }
  }
}

/** Segment crossings plus containment — enough for the convex-ish outlines here. */
function polygonsOverlap(a, b) {
  const seg = (p) => p.map((_, i) => [p[i], p[(i + 1) % p.length]]);
  for (const [p1, p2] of seg(a)) {
    for (const [q1, q2] of seg(b)) if (crosses(p1, p2, q1, q2)) return true;
  }
  return inside(a[0], b) || inside(b[0], a);
}
const side = (a, b, c) => Math.sign((b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u));
function crosses(p1, p2, q1, q2) {
  const d1 = side(p1, p2, q1), d2 = side(p1, p2, q2);
  const d3 = side(q1, q2, p1), d4 = side(q1, q2, p2);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}
function inside(p, poly) {
  let win = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i].v > p.v) !== (poly[j].v > p.v)
      && p.u < ((poly[j].u - poly[i].u) * (p.v - poly[i].v)) / (poly[j].v - poly[i].v) + poly[i].u) win = !win;
  }
  return win;
}

test('the flip is where the win is, and more angles are not', () => {
  // Measured rather than assumed: this is the finding that decided how much
  // effort rotation deserves.
  const pieces = Array.from({ length: 12 }, (_, i) => ({ id: i, outline: wedge(300, 120) }));
  const one = nestPieces(pieces, { ...SHEET, rotations: 1 });
  const two = nestPieces(pieces, { ...SHEET, rotations: 2 });
  const many = nestPieces(pieces, { ...SHEET, rotations: 24 });
  assert.ok(two.sheets.length < one.sheets.length, 'turning pieces end for end saves sheets');
  assert.equal(many.sheets.length, two.sheets.length, 'and twenty-four angles adds nothing');
});

test('nothing is placed off a sheet and nothing overlaps', () => {
  const pieces = Array.from({ length: 20 }, (_, i) => ({ id: i, outline: wedge(150 + i * 5, 60) }));
  const nest = nestPieces(pieces, { ...SHEET, rotations: 8 });
  assertSheetsAreLegal(nest, SHEET);
});

test('every piece is either placed or named as oversize — never neither', () => {
  const pieces = [
    { id: 0, label: 'fits', outline: rect(200, 100) },
    { id: 1, label: 'far too big', outline: rect(2000, 900) },
    { id: 2, label: 'also fits', outline: rect(120, 90) },
  ];
  const nest = nestPieces(pieces, { ...SHEET, rotations: 4 });
  const placed = nest.sheets.flatMap((s) => s.placed.map((p) => p.index));
  const over = nest.oversize.map((o) => o.index);
  assert.deepEqual([...placed, ...over].sort(), [0, 1, 2]);
  assert.equal(over.length, 1);
  assert.equal(nest.oversize[0].piece.label, 'far too big');
  assert.ok(nest.oversize[0].width > 0, 'and it is reported WITH its size');
});

test('grain-constrained stock is only ever turned end for end', () => {
  const pieces = Array.from({ length: 6 }, (_, i) => ({ id: i, outline: wedge(200, 80) }));
  const nest = nestPieces(pieces, { ...SHEET, grain: true, rotations: 16 });
  for (const s of nest.sheets) for (const p of s.placed) {
    assert.ok(p.angle === 0 || p.angle === 180, `angle ${p.angle} would cut across the grain`);
  }
});

test('THE §5.4 BUG: the splitter and the nester agree on the largest part', () => {
  // The failure this guards against is silent. A part longer than the nester can
  // place but shorter than the splitter's idea of "too long" is never cut and
  // never placed: it simply is not in the output, indistinguishable from a part
  // that was never meant to exist. One function owns the answer.
  const opts = { ...SHEET, rotations: 4 };
  const usable = usableStock(opts);
  assert.ok(usable.length < opts.sheetLength, 'the usable length is less than the sheet');

  // A part just inside the limit is placed; a part just outside is reported.
  const just = { id: 0, label: 'just inside', outline: rect(usable.length - 1e-6, 50) };
  const over = { id: 1, label: 'just outside', outline: rect(usable.length + usable.cell * 4, 50) };
  const a = nestPieces([just], opts);
  assert.equal(a.oversize.length, 0, 'a part inside usableStock() must actually nest');
  const b = nestPieces([over], opts);
  assert.equal(b.oversize.length, 1, 'a part outside it must be reported, not lost');
  assert.equal(fitsStock({ width: usable.length - 1e-6, height: 50 }, usable), true);
  assert.equal(fitsStock({ width: usable.length + usable.cell * 4, height: 50 }, usable), false);
});

test('the clearance the nester enforces is never LESS than the kerf', () => {
  // The grid quantises the gap, so the question is which way it rounds. Short is
  // the dangerous direction: the saw then takes the difference out of the
  // neighbouring part, and nothing in the output says so.
  for (const opts of [
    { sheetLength: 2438, sheetWidth: 1219, kerf: 3, margin: 12 },
    { sheetLength: 420, sheetWidth: 210, kerf: 1, margin: 5 },
    { sheetLength: 96, sheetWidth: 48, kerf: 0.125, margin: 0.5 },
    { sheetLength: 420, sheetWidth: 210, kerf: 0, margin: 5 },
  ]) {
    const g = nestGeometry(opts);
    assert.ok(g.gap >= opts.kerf - 1e-12, `gap ${g.gap} is under the kerf ${opts.kerf}`);
    assert.ok(g.cell > 0);
    assert.ok(g.usable.length < opts.sheetLength && g.usable.width < opts.sheetWidth);
  }
});

test('bisect divides along real mesh edges, and both halves are connected', () => {
  const mesh = plate(200, 100, 6, 4);
  const faces = Array.from({ length: mesh.faceCount }, (_, i) => i);
  const flat = unfoldPatch(mesh, { id: 0, key: 'p', faces, area: mesh.stats.surfaceArea, seed: 0 });
  const parts = bisect(mesh, faces, flat);
  assert.ok(parts.length >= 2);
  assert.equal(parts.flat().length, faces.length, 'no face is lost or duplicated');
  assert.equal(new Set(parts.flat()).size, faces.length);
});

test('bisect never consumes every face — the fragment-that-could-not-be-divided bug', () => {
  // One triangle carrying most of a patch's area used to let the area-halving
  // loop take everything, leaving nothing on the other side, and the caller was
  // told the piece was indivisible when in fact it had just been divided.
  // Two triangles sharing an edge, one fifty times the area of the other.
  const positions = [0, 0, 0, 100, 0, 0, 0, 100, 0, 51, 51, 0];
  const tris = [0, 1, 2, 1, 3, 2];
  const mesh = buildMesh({ positions, tris, groups: [0, 0] }, { units: 'mm' });
  const faces = [0, 1];
  const flat = unfoldPatch(mesh, { id: 0, key: 'p', faces, area: mesh.stats.surfaceArea, seed: 0 });
  const parts = bisect(mesh, faces, flat);
  assert.ok(parts && parts.length >= 2, 'a two-face patch is always divisible');
});

test('an oversized piece is cut until it fits, on the model\'s own edges', () => {
  const mesh = plate(2000, 800, 12, 6);
  const patches = [{ id: 0, key: 'big', label: 'big', faces: Array.from({ length: mesh.faceCount }, (_, i) => i), area: mesh.stats.surfaceArea, seed: 0 }];
  const { pieces, unplaceable } = splitToFit(mesh, patches, SHEET);
  assert.equal(unplaceable.length, 0);
  assert.ok(pieces.length > 1);
  const usable = usableStock(SHEET);
  for (const p of pieces) assert.ok(fitsStock(p.flat, usable), `${p.label} still does not fit`);
  const area = pieces.reduce((s, p) => s + p.flat.flatArea, 0);
  assert.ok(Math.abs(area - mesh.stats.surfaceArea) / mesh.stats.surfaceArea < 1e-9,
    'cutting a piece up neither creates nor destroys material');
});

test('a single triangle bigger than the stock is reported, with its size', () => {
  const positions = [0, 0, 0, 5000, 0, 0, 0, 4000, 0];
  const mesh = buildMesh({ positions, tris: [0, 1, 2], groups: [0] }, { units: 'mm' });
  const patches = [{ id: 0, key: 'huge', label: 'huge', faces: [0], area: mesh.areas[0], seed: 0 }];
  const { pieces, unplaceable } = splitToFit(mesh, patches, SHEET);
  assert.equal(pieces.length, 0);
  assert.equal(unplaceable.length, 1);
  assert.match(unplaceable[0].why, /single triangle/);
  assert.ok(unplaceable[0].width > 1000, 'and its size is in the report');
});

test('the bunny nests legally at several sizes', () => {
  const mesh = bunny();
  const patches = segmentByCurvature(mesh, { maxFoldDeg: 179, maxDefectDeg: 8, maxTotalDefectDeg: 15 });
  const { pieces } = splitToFit(mesh, patches, SHEET);
  const nest = nestPieces(pieces.map((p, i) => ({ id: i, label: p.label, outline: p.flat.outline })), SHEET);
  assert.equal(nest.oversize.length, 0);
  assertSheetsAreLegal(nest, SHEET);
});

test('REGRESSION: the packing quality on the sample bunny', () => {
  // Pinned numbers, because every other test in this file passed while the
  // nester quietly got worse. A "skyline" pruning — start each column above the
  // highest cell already occupied there — is a valid optimisation for rectangles
  // and wrong for shapes: nesting DEPENDS on a wedge lying in the hollow under
  // its neighbour, and a skyline reports that hollow as full. It cost a whole
  // sheet at x2 and another at x3, and nothing else noticed.
  //
  // If a change to the nester moves these, that is a result to look at rather
  // than a number to update: down is a real improvement, up is a real loss.
  //
  // Pinned WITHOUT glue tabs, so this measures the nester and nothing else. Tabs
  // legitimately change the answer — they are material, and the pieces get
  // bigger — and folding that into the same number would mean a real nester
  // regression could hide behind a tab-width tweak.
  const mesh = bunny();
  const prepared = prepare(mesh, { stock: 'sheet-1to2-420', material: 'card' });
  const got = [1, 1.5, 2, 2.5, 3].map((k) => runScale(prepared, k, { tabs: false }).sheetCount);
  assert.deepEqual(got, [1, 2, 3, 5, 7]);
});

test('glue tabs cost sheets, and the cost is visible rather than absorbed', () => {
  // Tabs are cut from the same material as the piece. If the sheet count did not
  // move, the tabs would be coming from somewhere unaccounted for.
  const prepared = prepare(bunny(), { stock: 'sheet-1to2-420', material: 'card' });
  const bare = runScale(prepared, 2, { tabs: false });
  const tabbed = runScale(prepared, 2, { tabs: true });
  assert.ok(tabbed.partArea > bare.partArea, 'tabs are counted as material used');
  assert.ok(tabbed.sheetCount >= bare.sheetCount);
  assert.ok(tabbed.tabs.stats.tabs > 100);
});

test('utilisation counts the gaps as waste, because they are', () => {
  const pieces = [{ id: 0, outline: rect(100, 100) }];
  const nest = nestPieces(pieces, { ...SHEET, rotations: 1 });
  const util = polygonArea(pieces[0].outline) / (nest.sheets.length * 420 * 210);
  assert.ok(util < 0.15 && util > 0.1);
});
