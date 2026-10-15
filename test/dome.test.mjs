// The dome, and the unit handling it exposed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domeMesh, iglooPreset, meshToOBJ, domeReport } from '../js/dome.js';
import { buildMesh, parseOBJ } from '../js/mesh.js';
import { resolveStock, toMM, fromMM, unitFactor, UNITS, STOCKS, MATERIALS } from '../js/materials.js';
import { unfoldToSheets } from '../js/pipeline.js';

test('an even frequency puts the base flat on the ground', () => {
  for (const frequency of [2, 4, 6]) {
    const mesh = domeMesh({ ...iglooPreset(3), frequency, openings: [] });
    let minZ = Infinity, onGround = 0;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      minZ = Math.min(minZ, mesh.positions[i]);
      if (Math.abs(mesh.positions[i]) < 1e-9) onGround++;
    }
    assert.ok(Math.abs(minZ) < 1e-9, `${frequency}V dips to ${minZ} below the floor`);
    assert.ok(onGround >= 10, `${frequency}V has only ${onGround} vertices on the ground`);
  }
});

test('an odd frequency is refused rather than quietly producing a zigzag base', () => {
  assert.throws(() => domeMesh({ ...iglooPreset(3), frequency: 3 }), /even/);
});

test('the panels are all much the same size — which is the point of a geodesic', () => {
  const mesh = domeMesh({ ...iglooPreset(3), openings: [] });
  const r = domeReport(mesh);
  assert.ok(r.strutMax / r.strutMin < 1.35,
    `struts run ${r.strutMin} to ${r.strutMax}; a lat-long dome is far worse, which is why this is not one`);
});

test('it is a hemisphere: the area matches 2 pi r squared', () => {
  const mesh = domeMesh({ ...iglooPreset(3), frequency: 6, openings: [] });
  const ideal = 2 * Math.PI * 9;
  // A faceted dome is inscribed in the sphere, so it is slightly smaller. At 6V
  // the shortfall should be a couple of per cent, not a quarter.
  assert.ok(mesh.stats.surfaceArea < ideal);
  assert.ok(mesh.stats.surfaceArea > ideal * 0.97,
    `${mesh.stats.surfaceArea} vs ${ideal}`);
});

test('the openings really are holes, and the shell is otherwise sound', () => {
  const closed = domeMesh({ ...iglooPreset(3), openings: [] });
  const holed = domeMesh(iglooPreset(3));
  assert.ok(holed.faceCount < closed.faceCount, 'faces were removed');
  assert.ok(holed.stats.manifold, 'and what is left is still a manifold');
  assert.ok(holed.stats.consistentWinding);
  assert.ok(holed.stats.boundaryEdges > closed.stats.boundaryEdges,
    'a hole has a rim, and the rim is boundary edges');
  assert.equal(holed.stats.closed, false, 'a dome with a door is an open surface');
});

test('the door is a door: you can walk through it', () => {
  const mesh = domeMesh(iglooPreset(3));
  const p = mesh.positions;
  const rim = new Set();
  for (const e of mesh.edges) if (e.faces.length === 1) { rim.add(e.a); rim.add(e.b); }
  const door = [...rim].filter((v) => Math.abs(Math.atan2(p[v * 3 + 1], p[v * 3]) * 180 / Math.PI) < 40
    && p[v * 3 + 2] > 1e-9);
  assert.ok(door.length >= 4, 'the doorway has a rim');
  const top = Math.max(...door.map((v) => p[v * 3 + 2]));
  assert.ok(top > 1.9, `the doorway is only ${top.toFixed(2)} m high`);
  let widest = 0;
  for (const a of door) {
    for (const b of door) {
      if (Math.abs(p[a * 3 + 2] - p[b * 3 + 2]) > 0.3) continue;
      widest = Math.max(widest, Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1]));
    }
  }
  assert.ok(widest > 0.8, `the doorway is only ${widest.toFixed(2)} m wide`);
});

test('the dome survives a round trip through OBJ', () => {
  const mesh = domeMesh(iglooPreset(3));
  const back = buildMesh(parseOBJ(meshToOBJ(mesh)), { units: 'm', name: 'round trip' });
  assert.equal(back.faceCount, mesh.faceCount);
  assert.equal(back.stats.vertices, mesh.stats.vertices);
  assert.ok(Math.abs(back.stats.surfaceArea - mesh.stats.surfaceArea) / mesh.stats.surfaceArea < 1e-9);
  assert.equal(back.stats.boundaryEdges, mesh.stats.boundaryEdges);
});

// ─── the units bug the dome found ───────────────────────────────────────────

test('THE BUG: a model in metres gets a sheet in metres', () => {
  // The version before this treated any unrecognised unit as millimetres, so a
  // dome modelled in metres was nested against a sheet of plywood 2438 METRES
  // long. The pipeline did not complain — it reported all 140 panels on one
  // sheet at 0.0% used. That absurdity is easy to spot; the same mistake by a
  // factor of ten would not be.
  const s = resolveStock('ply-4x8', 'ply', 'm');
  assert.ok(Math.abs(s.sheetLength - 2.4384) < 1e-9, `sheet is ${s.sheetLength} m long`);
  assert.ok(Math.abs(s.sheetWidth - 1.2192) < 1e-9);
  assert.ok(s.kerf < 0.01 && s.kerf > 0, 'and a 3 mm kerf is 0.003 m');
});

test('every unit converts both ways, exactly', () => {
  for (const u of Object.keys(UNITS)) {
    assert.ok(Math.abs(fromMM(toMM(7, u), u) - 7) < 1e-12, u);
  }
  assert.equal(unitFactor('m'), 1000);
  assert.ok(Math.abs(unitFactor('ft') - 304.8) < 1e-9);
  assert.ok(Math.abs(toMM(1, 'in') - 25.4) < 1e-12);
});

test('an unknown unit throws instead of pretending to be millimetres', () => {
  assert.throws(() => unitFactor('furlong'), /unknown unit/);
  assert.throws(() => resolveStock('ply-4x8', 'ply', undefined), /unknown unit/);
});

test('a model with no stated units is refused, not guessed at', () => {
  const mesh = domeMesh({ ...iglooPreset(3), units: null });
  assert.throws(() => unfoldToSheets(mesh, { stock: 'ply-4x8', material: 'ply' }), /no units/);
});

test('every stock resolves sanely into every unit', () => {
  for (const st of STOCKS) {
    for (const m of MATERIALS) {
      for (const u of Object.keys(UNITS)) {
        const r = resolveStock(st.id, m.id, u);
        // The sheet is the same physical object however it is measured.
        assert.ok(Math.abs(toMM(r.sheetLength, u) - toMM(st.length, st.units)) < 1e-6,
          `${st.id} in ${u} is the wrong size`);
        assert.ok(r.sheetLength >= r.sheetWidth);
      }
    }
  }
});

test('A 2V DOME AT 6 m CANNOT BE BUILT FROM 4x8 SHEETS, and says so panel by panel', () => {
  // Its facets are 1.85 m across and a sheet is 1.22 m wide. The splitter cuts
  // along edges the model already has, so a single triangle bigger than the
  // stock is the end of the line — there is nothing inside it to cut along.
  //
  // The right answer is a higher frequency, which is exactly what dome builders
  // do as domes get bigger. The wrong answer, and the one this checks against,
  // is to report a tidy sheet count for a dome missing most of its skin.
  const mesh = domeMesh({ ...iglooPreset(3), frequency: 2 });
  const { result } = unfoldToSheets(mesh, { stock: 'ply-4x8', material: 'ply', scale: 1 });
  assert.equal(result.pieces.length, 0);
  assert.equal(result.missing.length, mesh.faceCount, 'every panel is accounted for');
  for (const m of result.missing) {
    assert.ok(m.width > 1.2, 'and reported WITH its size');
    assert.match(m.why, /single triangle/);
  }
});

test('a 4V dome at the same span does fit, which is the answer to the one above', () => {
  const mesh = domeMesh({ ...iglooPreset(3), frequency: 4 });
  const strut = domeReport(mesh).strutMax;
  assert.ok(strut < 1.0, `4V struts are ${strut.toFixed(2)} m, inside a 1.22 m sheet`);
});

test('the dome runs end to end on coroplast, in metres, with nothing dropped', () => {
  // A dome small enough that its 2V facets fit the stock, so this test is about
  // the metre conversion and completeness rather than about facet count.
  const mesh = domeMesh({ ...iglooPreset(1), frequency: 2 });
  const { result } = unfoldToSheets(mesh, { stock: 'coro-4x8', material: 'coroplast', scale: 1 });
  assert.equal(result.units, 'm');
  assert.equal(result.missing.length, 0);
  assert.ok(result.tokenCheck.ok);
  // A 6 m dome has about 49 m2 of shell and a 4x8 sheet is 2.97 m2, so it
  // cannot possibly be fewer than seventeen sheets however well it packs.
  const floor = mesh.stats.surfaceArea / (result.stock.sheetLength * result.stock.sheetWidth);
  assert.ok(result.sheetCount >= floor,
    `${result.sheetCount} sheets is below the ${floor.toFixed(1)} the area alone requires`);
  assert.ok(result.sheetCount < floor * 4, `${result.sheetCount} sheets is implausibly many`);
});

test('the dome on rigid stock is one flat panel per facet, exactly', () => {
  const mesh = domeMesh({ ...iglooPreset(1), frequency: 2 });
  const { result } = unfoldToSheets(mesh, { stock: 'ply-4x8', material: 'ply', scale: 1 });
  assert.equal(result.pieces.length, mesh.faceCount, 'every facet is its own part');
  assert.ok(result.worstEdgeError / mesh.bbox.size[0] < 1e-14,
    `a flat triangle flattens to itself; error was ${result.worstEdgeError}`);
  assert.equal(result.seams.stats.foldCount, 0, 'plywood does not fold');
});
