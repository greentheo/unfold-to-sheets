// Glue tabs: the flap on one side of a seam.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabPolygon, planTabs, cutOutlineWithTabs, pointInPolygon } from '../js/tabs.js';
import { unfoldToSheets } from '../js/pipeline.js';
import { markSeams } from '../js/seams.js';
import { nestGeometry } from '../js/split.js';
import { buildSheets } from '../js/sheetview.js';
import { polygonArea } from '../js/nesting.js';
import { bunny } from './fixtures/bunny.mjs';
import { domeMesh, iglooPreset } from '../js/dome.js';

const square = (n = 40) => [
  { u: 0, v: 0 }, { u: n, v: 0 }, { u: n, v: n }, { u: 0, v: n },
];

test('a tab stands OUTSIDE the piece, not on top of it', () => {
  const s = square();
  const t = tabPolygon(s[0], s[1], 6, 60);
  // The ring is counter-clockwise, so the interior is up and the tab goes down.
  assert.ok(t.points[1].v < 0 && t.points[2].v < 0);
  for (const p of t.points.slice(1, 3)) assert.equal(pointInPolygon(p, s), false);
});

test('the ends are drawn back so neighbouring tabs cannot meet at a corner', () => {
  const s = square();
  const t = tabPolygon(s[0], s[1], 6, 60);
  assert.ok(Math.abs(t.inset - 6 / Math.tan(Math.PI / 3)) < 1e-9);
  // A rectangular tab would reach the corner; this one stops short of it.
  assert.ok(t.points[1].u > s[0].u + 1e-9);
  assert.ok(t.points[2].u < s[1].u - 1e-9);
});

test('a short seam gets a triangle rather than a bow tie', () => {
  // width/tan(theta) can exceed half the seam, which would cross the two ends
  // over each other and produce a self-intersecting flap.
  const t = tabPolygon({ u: 0, v: 0 }, { u: 5, v: 0 }, 20, 40);
  assert.ok(t.inset <= 5 * 0.35 + 1e-9);
  assert.ok(t.points[1].u < t.points[2].u, 'the outer edge still runs the right way');
});

test('ONLY ONE side of a seam gets a tab', () => {
  // Two tabs on one joint means the two pieces cannot meet — the material is in
  // the way.
  const { result } = unfoldToSheets(bunny(), { stock: 'sheet-1to2-420', material: 'card', scale: 2 });
  const perSeam = new Map();
  result.pieces.forEach((p) => {
    for (const t of p.tabs) perSeam.set(t.edge, (perSeam.get(t.edge) || 0) + 1);
  });
  for (const [edge, n] of perSeam) assert.equal(n, 1, `edge ${edge} has ${n} tabs`);
});

test('every seam has a tab or is named as having none', () => {
  const { result } = unfoldToSheets(bunny(), { stock: 'sheet-1to2-420', material: 'card', scale: 2 });
  const withTab = new Set(result.pieces.flatMap((p) => p.tabs.map((t) => t.edge)));
  const skipped = new Set(result.tabs.skipped.map((s) => s.edge));
  for (const [edge] of result.seams.seams) {
    assert.ok(withTab.has(edge) || skipped.has(edge),
      `seam ${edge} has no tab and no explanation — a joint with nothing to fasten it`);
  }
  for (const s of result.tabs.skipped) assert.ok(s.why && s.token);
});

test('tabs carry the seam token, so you know what glues to what', () => {
  const { result } = unfoldToSheets(bunny(), { stock: 'sheet-1to2-420', material: 'card', scale: 2 });
  const tokens = new Set([...result.seams.seams.values()].map((s) => s.token));
  for (const p of result.pieces) {
    for (const t of p.tabs) {
      assert.ok(tokens.has(t.token));
      assert.ok(t.joinsPiece >= 0 && t.joinsPiece < result.pieces.length);
      assert.notEqual(t.joinsPiece, result.pieces.indexOf(p));
    }
  }
});

test('no tab overlaps its own piece or another tab on it', () => {
  const { result } = unfoldToSheets(bunny(), { stock: 'sheet-1to2-420', material: 'card', scale: 2 });
  for (const p of result.pieces) {
    for (const t of p.tabs) {
      for (const q of [t.points[1], t.points[2]]) {
        assert.equal(pointInPolygon(q, p.flat.outline), false,
          `a tab on ${p.label} lies over the piece itself`);
      }
    }
    for (let i = 0; i < p.tabs.length; i++) {
      for (let j = i + 1; j < p.tabs.length; j++) {
        assert.equal(pointInPolygon(p.tabs[i].points[1], p.tabs[j].points), false,
          `two tabs on ${p.label} overlap`);
      }
    }
  }
});

test('the cut outline includes the tabs and is bigger than the piece', () => {
  const { result } = unfoldToSheets(bunny(), { stock: 'sheet-1to2-420', material: 'card', scale: 2 });
  const withTabs = result.pieces.filter((p) => p.tabs.length);
  assert.ok(withTabs.length > 0);
  for (const p of withTabs) {
    assert.equal(p.flat.cutOutline.length, p.flat.outline.length + p.tabs.length * 2);
    assert.ok(polygonArea(p.flat.cutOutline) > polygonArea(p.flat.outline),
      `${p.label}'s cut line does not include its tabs`);
  }
});

test('THE §5.4 RULE AGAIN: the splitter leaves room for tabs it has not added yet', () => {
  // Tabs are decided after the pieces are, but cut with them. A piece measured
  // against the sheet without its tabs and then given them is bigger than the
  // thing that was checked.
  const opts = { sheetLength: 420, sheetWidth: 210, margin: 5, kerf: 1 };
  const plain = nestGeometry(opts);
  const tabbed = nestGeometry({ ...opts, tabAllowance: 6 });
  assert.equal(plain.usableForSplit.length, plain.usable.length, 'no tabs, no allowance');
  assert.ok(tabbed.usableForSplit.length === tabbed.usable.length - 12);
  assert.ok(tabbed.usableForSplit.width === tabbed.usable.width - 12);
  assert.equal(tabbed.usable.length, plain.usable.length, 'the nester is not shrunk');
});

test('with tabs on, everything still fits and nothing is dropped', () => {
  for (const scale of [1, 2, 3]) {
    const { result } = unfoldToSheets(bunny(), { stock: 'sheet-1to2-420', material: 'card', scale });
    assert.equal(result.missing.length, 0, `pieces went missing at x${scale}`);
    const view = buildSheets(result);
    for (const sheet of view.sheets) {
      for (const item of sheet.items) {
        if (item.kind !== 'outline') continue;
        for (const p of item.points) {
          assert.ok(p.u >= -1e-6 && p.u <= sheet.width + 1e-6, `${item.label} tab runs off the sheet`);
          assert.ok(p.v >= -1e-6 && p.v <= sheet.height + 1e-6, `${item.label} tab runs off the sheet`);
        }
      }
    }
  }
});

test('every tab base is drawn as a score line — a tab that cannot fold is scrap', () => {
  const { result } = unfoldToSheets(bunny(), { stock: 'sheet-1to2-420', material: 'card', scale: 2 });
  const view = buildSheets(result);
  const folds = view.sheets.flatMap((s) => s.items.filter((i) => i.kind === 'tabfold'));
  const placedTabs = view.sheets.flatMap((s) => s.pieces)
    .map((label) => result.pieces.find((p) => p.label === label))
    .reduce((n, p) => n + p.tabs.length, 0);
  assert.equal(folds.length, placedTabs);
});

test('butt-jointed material gets no tabs at all', () => {
  const { result } = unfoldToSheets(bunny(), { stock: 'sheet-1to2-420', material: 'thin-ply', scale: 1 });
  assert.equal(result.tabs.stats.tabs, 0);
  for (const p of result.pieces) {
    assert.equal(p.tabs.length, 0);
    assert.deepEqual(p.flat.cutOutline, p.flat.outline);
  }
});

test('tabs can be turned off for a material that would otherwise have them', () => {
  const on = unfoldToSheets(bunny(), { stock: 'sheet-1to2-420', material: 'card', scale: 2 }).result;
  const off = unfoldToSheets(bunny(), { stock: 'sheet-1to2-420', material: 'card', scale: 2, tabs: false }).result;
  assert.ok(on.tabs.stats.tabs > 0);
  assert.equal(off.tabs.stats.tabs, 0);
  assert.ok(off.partArea < on.partArea, 'tabs are material, and are counted as used rather than wasted');
});

test('tabs on the dome, in metres, are metre-sized', () => {
  const mesh = domeMesh({ ...iglooPreset(1), frequency: 2 });
  const { result } = unfoldToSheets(mesh, { stock: 'coro-4x8', material: 'coroplast', scale: 1 });
  assert.equal(result.units, 'm');
  assert.ok(Math.abs(result.stock.tabWidth - 0.04) < 1e-9, `tab width ${result.stock.tabWidth} is not 40 mm`);
  const tabs = result.pieces.flatMap((p) => p.tabs);
  assert.ok(tabs.length > 0);
  for (const t of tabs) assert.ok(t.width <= 0.04 + 1e-9 && t.width > 0.01);
});
