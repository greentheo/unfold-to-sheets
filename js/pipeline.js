// The whole thing, as one function of (mesh, scale, stock, options).
//
// Stages 1 to 6 are pure: same inputs, same output, no clock, no randomness, no
// canvas. Stage 7 — the scale sweep, which is the point of the tool — is that
// function called in a loop, and keeping this boundary clean is the only reason
// the sweep is cheap to build. In lofting the equivalent was about 120 lines
// once the pipeline was already pure, and would have been a rewrite otherwise.
//
// SCALE is applied to the model rather than to the stock, and the difference
// matters: the sheet is 8 feet long whatever you do with the model, the kerf is
// 3 mm whatever you do with the model, and a pipeline that scaled everything
// together would report the same answer at every scale and have nothing to say.

import { buildMesh, modelSize } from './mesh.js';
import { segment, seamEdges } from './segment.js';
import { splitToFit, usableStock } from './split.js';
import { markSeams, checkTokens } from './seams.js';
import { planTabs, applyTabs, noTabs } from './tabs.js';
import { nestPieces, polygonArea } from './nesting.js';
import { resolveStock, segmentOptionsFor } from './materials.js';

/**
 * A copy of the mesh at a different size.
 *
 * Positions and lengths scale; normals, topology and every angle do not. So the
 * segmentation computed once at scale 1 is valid at every scale — which is what
 * makes a hundred-row sweep affordable — and only the flattening, the splitting
 * and the nesting have to be redone.
 */
export function scaleMesh(mesh, k) {
  if (k === 1) return mesh;
  const positions = new Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i++) positions[i] = mesh.positions[i] * k;
  const areas = new Float64Array(mesh.faceCount);
  for (let f = 0; f < mesh.faceCount; f++) areas[f] = mesh.areas[f] * k * k;
  return {
    ...mesh,
    positions,
    areas,
    _vertexFaces: null,
    bbox: {
      lo: mesh.bbox.lo.map((v) => v * k),
      hi: mesh.bbox.hi.map((v) => v * k),
      size: mesh.bbox.size.map((v) => v * k),
    },
    stats: { ...mesh.stats, surfaceArea: mesh.stats.surfaceArea * k * k, scale: k },
  };
}

/**
 * Everything that does not depend on the scale: load the mesh, decide where the
 * seams go, and say what kind of surface this is.
 */
export function prepare(mesh, opts = {}) {
  // No fallback. A mesh with no stated units cannot be nested against a real
  // sheet, and picking one for the user is how a dome comes out the size of a
  // dolls' house — or, as actually happened here, how a 6 m dome gets nested
  // against a sheet of plywood 2438 metres long without a word of complaint.
  const units = opts.units ?? mesh.units;
  if (!units) {
    throw new Error('the model has no units. A file does not record them — state them '
      + 'with buildMesh(raw, { units }) or prepare(mesh, { units }).');
  }
  const stock = resolveStock(opts.stock ?? 'sheet-1to2-420', opts.material ?? 'card', units);
  const segOpts = segmentOptionsFor(stock, opts.segment || {});
  const seg = segment(mesh, { ...segOpts, useGroups: opts.useGroups });
  const { cuts, folds } = seamEdges(mesh, seg.patches);
  return {
    mesh,
    stock,
    segOpts,
    patches: seg.patches,
    segmentMethod: seg.method,
    segmentNote: seg.note,
    seamEdgeCount: cuts.length,
    foldEdgeCount: folds.length,
  };
}

/**
 * One complete run at one scale.
 *
 * @returns everything the exporters and the sweep need, with every approximation
 *   carrying its own measured error.
 */
export function runScale(prepared, scale = 1, opts = {}) {
  const { stock } = prepared;
  const mesh = scaleMesh(prepared.mesh, scale);
  // The patches are face sets and face sets do not change with size, so the
  // segmentation is reused verbatim rather than recomputed.
  const patches = prepared.patches.map((p) => ({ ...p, area: p.area * scale * scale }));

  const nestOpts = {
    sheetLength: stock.sheetLength,
    sheetWidth: stock.sheetWidth,
    margin: stock.margin,
    kerf: stock.kerf,
    grain: opts.grain ?? stock.grain,
    rotations: opts.rotations ?? 8,
    openSheets: opts.openSheets ?? 0,
  };

  // Tabs are decided after the pieces are, because a tab belongs to a seam and
  // there are no seams until the pieces exist — but they are CUT with the piece,
  // so the splitter has to leave room for them in advance.
  const wantTabs = (opts.tabs ?? (stock.joint === 'tab')) && stock.tabWidth > 0;
  const tabWidth = opts.tabWidth ?? stock.tabWidth;

  const { pieces, unplaceable, splits, usable } = splitToFit(mesh, patches, {
    ...nestOpts,
    tabAllowance: wantTabs ? tabWidth : 0,
    maxDepth: opts.maxDepth ?? 12,
    allowOverlap: opts.allowOverlap ?? false,
  });

  const seams = markSeams(mesh, pieces);
  const tokenCheck = checkTokens(seams.byPiece);

  let tabs;
  if (wantTabs) {
    tabs = planTabs(pieces, seams, { tabWidth, tabAngle: opts.tabAngle ?? stock.tabAngle });
    applyTabs(pieces, tabs);
  } else {
    tabs = noTabs(pieces);
  }

  // The nester packs what is actually CUT, tabs and all. Packing the bare
  // outline and cutting something bigger is how parts come off the sheet.
  const nest = nestPieces(
    pieces.map((p, i) => ({ id: i, label: p.label, outline: p.flat.cutOutline })), nestOpts);

  const sheetArea = stock.sheetLength * stock.sheetWidth;
  // Measured on what is cut, so the tabs count as material used rather than
  // appearing as a mysterious extra few per cent of waste.
  const partArea = pieces.reduce((s, p) => s + polygonArea(p.flat.cutOutline), 0);
  const stockArea = nest.sheets.length * sheetArea;

  const worstEdgeError = pieces.reduce((m, p) => Math.max(m, p.flat.maxEdgeError), 0);
  const worstSpread = pieces.reduce((m, p) => Math.max(m, p.flat.spread), 0);
  const overlapping = pieces.filter((p) => p.flat.overlaps.length);

  // Anything excluded must be NAMED, with its size, in the output the user
  // actually reads. The two ways a piece can go missing are counted together
  // here so that no caller has to remember to check both.
  const missing = [
    ...unplaceable.map((u) => ({ ...u, stage: 'split' })),
    ...nest.oversize.map((o) => ({
      key: o.piece.label, label: o.piece.label, stage: 'nest',
      width: o.width, height: o.height, units: mesh.units,
      why: `no orientation fits the ${fmt(usable.length)} x ${fmt(usable.width)} the nester can use`,
    })),
  ];

  return {
    scale,
    mesh,
    stock,
    pieces,
    seams,
    tabs,
    nest,
    sheets: nest.sheets,
    sheetCount: nest.sheets.length,
    size: modelSize(prepared.mesh, opts.sizeAxis || 'longest') * scale,
    sizeAxis: opts.sizeAxis || 'longest',
    partArea,
    stockArea,
    utilisation: stockArea > 0 ? partArea / stockArea : 0,
    wasteSheets: stockArea > 0 ? (stockArea - partArea) / sheetArea : 0,
    splits,
    usable,
    missing,
    unplaceable: missing.length,
    tokenCheck,
    worstEdgeError,
    worstSpread,
    overlapping,
    units: mesh.units,
  };
}

const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

/** The whole pipeline in one call, for a single size. */
export function unfoldToSheets(mesh, opts = {}) {
  const prepared = prepare(mesh, opts);
  return { prepared, result: runScale(prepared, opts.scale ?? 1, opts) };
}

export { buildMesh };
