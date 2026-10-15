// Cutting a piece that will not fit on the stock, and knowing how big "fits"
// actually is.
//
// TWO RULES, both learned the hard way in the lofting project.
//
// CUT ON A REAL EDGE. Never an arbitrary straight line through the pattern. The
// pieces are separated by choosing which triangles go to which side, so the cut
// necessarily runs along edges the model already has — which means the joint
// lands where the surface has a crease to support it, and both halves of the
// cut are the same length by construction rather than by arithmetic.
//
// MEASURE AGAINST WHAT THE NESTER CAN ACTUALLY PLACE. Not against the sheet.
// The nester keeps a margin at the edges, grows every part by the cutting gap so
// two parts cannot touch, and works on a raster that rounds up to whole cells. A
// part sized to the bare sheet fails all three. In lofting this shipped: the
// largest placeable part on a 96 inch sheet was about 92 inches, the splitter
// measured against 96, and parts that landed in the four-inch band between "too
// short to bother splitting" and "too long to nest" DISAPPEARED — no warning, no
// entry in the cut list, indistinguishable from a part that was never made.
//
// So there is exactly one function that answers "how big can a part be", it
// lives here, and both the splitter and the nester call it.

import { unfoldPatch } from './unfold.js';
import { connectedComponents } from './segment.js';
import { faceNeighbours } from './mesh.js';

/**
 * All the nesting arithmetic, in one place.
 *
 * The cell size, the dilation in cells, the real clearance that dilation buys,
 * and the largest part that can therefore be placed. Everything that needs any
 * of these reads them from here — the nester, the splitter and the reports — so
 * they cannot come to differ.
 *
 * @returns {{cell, pad, gap, usable, usableForSplit}}
 *   gap — the clearance actually enforced, which is at least the kerf and may be
 *   a little more where the grid is coarse. Generous is safe; short is not.
 *   usable — the biggest thing the nester can place, as cut.
 *   usableForSplit — the same, less room for a glue tab on each side. THE
 *   SPLITTER MUST USE THIS ONE. Tabs are added after the pieces are decided but
 *   are cut as part of them, so a piece measured without its tabs and then given
 *   them is bigger than the thing that was checked against the sheet. That is
 *   the §5.4 failure again in a different hat, and its symptom is the same: a
 *   part that is never cut and never mentioned.
 */
export function nestGeometry(opts = {}) {
  const {
    sheetLength = 96, sheetWidth = 48, margin = 0.5, kerf = 0.125, tabAllowance = 0,
  } = opts;
  const cell = opts.cell ?? rasterCell(opts);
  // CEILING, not rounding. The dilation IS the clearance, and it is measured in
  // whole cells: rounding a 3 mm kerf on a 2 mm grid down to one cell leaves
  // parts 2 mm apart and the saw takes the difference out of the neighbour.
  // Erring long costs a little packing; erring short costs the part.
  const pad = kerf > 0 ? Math.max(1, Math.ceil(kerf / cell)) : 1;
  const gap = pad * cell;
  // The margin at both edges, the dilation at both edges, and one cell of
  // rounding at each end of the raster.
  const slack = margin * 2 + gap * 2 + cell * 2;
  const usable = { length: sheetLength - slack, width: sheetWidth - slack, slack, cell, gap };
  const tabRoom = tabAllowance * 2;
  return {
    cell,
    pad,
    gap,
    usable,
    usableForSplit: tabRoom > 0
      ? { ...usable, length: usable.length - tabRoom, width: usable.width - tabRoom, tabAllowance }
      : usable,
  };
}

/**
 * The biggest part that can actually be nested on a sheet.
 *
 * Not the sheet size. Everything that decides where to CUT has to measure
 * against this, or parts land in the band between "not big enough to be worth
 * splitting" and "too big to nest" and vanish without a word.
 */
export const usableStock = (opts = {}) => nestGeometry(opts).usable;

/**
 * The nester's raster cell.
 *
 * Half the kerf where that is affordable, because the clearance is quantised to
 * whole cells and a grid much coarser than the kerf spends its accuracy on
 * gaps nobody asked for. Floored at a fixed fraction of the sheet: on a 2.4 m
 * plywood sheet a 1.5 mm grid is 1.3 million cells searched per placement per
 * rotation, and the nest would take minutes. The extra clearance that floor
 * implies is counted in `gap` rather than ignored, so it costs packing rather
 * than correctness.
 */
export function rasterCell(opts = {}) {
  const { sheetLength = 96, kerf = 0 } = opts;
  const fromKerf = kerf > 0 ? kerf / 2 : Infinity;
  return Math.max(Math.min(fromKerf, sheetLength / 200), sheetLength / 1200);
}

/** Will this flattened piece fit the stock, in either orientation? */
export function fitsStock(flat, usable) {
  const w = flat.width, h = flat.height;
  const eps = 1e-9;
  return (w <= usable.length + eps && h <= usable.width + eps)
      || (h <= usable.length + eps && w <= usable.width + eps);
}

/**
 * Take off the BIGGEST piece that will fit on a sheet, and leave the rest.
 *
 * Halving is the obvious thing and it is badly wrong here. Cut a patch in two,
 * and each half is a little over half a sheet — so each one takes a whole sheet
 * and leaves most of it empty. Measured on the 6 m dome in coroplast: blind
 * halving produced pieces around 1.88 x 0.84 m on a 2.36 x 1.14 m sheet, one
 * piece per sheet, 30% used, 47 sheets. The pieces were not too big for the
 * stock. They were too big for HALF of it, which is a different problem and the
 * splitter had no idea it existed.
 *
 * So instead: order the faces breadth-first from one end of the pattern — every
 * prefix of that order is a connected patch — and binary-search for the longest
 * prefix that still fits. That is the largest piece obtainable by cutting here,
 * and it costs about log2(n) trial unfoldings rather than one.
 *
 * @returns {Array<number[]>|null} the piece taken, then the remaining components.
 */
export function cleaveToFit(mesh, faces, flat, usable, opts = {}) {
  if (faces.length < 2) return null;
  const order = growthOrder(mesh, faces, flat);

  const fitsPrefix = (n) => {
    const set = order.slice(0, n);
    const f = unfoldPatch(mesh, {
      id: 0, key: 'trial', faces: set, seed: set[0],
      area: set.reduce((a, x) => a + mesh.areas[x], 0),
    }, opts);
    return fitsStock(f, usable) && f.overlaps.length === 0;
  };

  // The single first face is checked by the caller; if even that will not fit,
  // there is nothing to cut and it is reported rather than divided forever.
  if (!fitsPrefix(1)) return null;

  let lo = 1, hi = faces.length;                 // lo fits, hi is not yet known
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (fitsPrefix(mid)) lo = mid; else hi = mid;
  }
  if (lo >= faces.length) return null;           // the whole thing fits already

  const taken = order.slice(0, lo).sort((a, b) => a - b);
  const rest = order.slice(lo);
  if (!rest.length) return null;
  return [taken, ...connectedComponents(mesh, rest)];
}

/**
 * The faces of a patch, ordered outward from one end of the flat pattern.
 *
 * Breadth-first, so every prefix is connected — which is what lets the search
 * above take a prefix and know it has a real patch rather than a scattering of
 * triangles. The frontier is ordered along the pattern's long axis so the piece
 * grows as a straight-edged front rather than reaching around itself.
 */
function growthOrder(mesh, faces, flat) {
  const inPatch = new Set(faces);
  const along = flat.width >= flat.height ? 'u' : 'v';
  const at = (f) => {
    let s = 0;
    for (let k = 0; k < 3; k++) s += flat.xy.get(mesh.tris[f * 3 + k])[along];
    return s / 3;
  };
  const start = faces.reduce((best, f) => (at(f) < at(best) ? f : best), faces[0]);
  const taken = [start];
  const seen = new Set([start]);
  const frontier = [];
  const push = (f) => {
    for (const { face: g } of faceNeighbours(mesh, f)) {
      if (inPatch.has(g) && !seen.has(g)) { seen.add(g); frontier.push({ f: g, key: at(g) }); }
    }
  };
  push(start);
  while (frontier.length) {
    frontier.sort((a, b) => a.key - b.key);
    const next = frontier.shift();
    taken.push(next.f);
    push(next.f);
  }
  return taken;
}

/**
 * Divide a patch in two along the mesh's own edges.
 *
 * Breadth-first from the face at one end of the pattern's long axis, taking
 * faces until half the area has gone. Growing the half rather than slicing at a
 * coordinate guarantees it is in one piece; the remainder may not be, so it is
 * returned as its own connected components and each is dealt with in turn.
 *
 * The pattern has already been turned to run along its own long axis, so "one
 * end" means the end, and the cut falls across the piece rather than down it.
 *
 * @returns {Array<number[]>|null} two or more connected face sets, or null if
 *   the patch cannot be divided at all.
 */
export function bisect(mesh, faces, flat) {
  if (faces.length < 2) return null;
  const inPatch = new Set(faces);

  // The end of the long axis, measured on the FLAT pattern: which faces are far
  // apart on the sheet is the question being asked, and on a curved patch that
  // is not the same as which are far apart in space.
  const along = flat.width >= flat.height ? 'u' : 'v';
  const at = (f) => {
    let s = 0;
    for (let k = 0; k < 3; k++) s += flat.xy.get(mesh.tris[f * 3 + k])[along];
    return s / 3;
  };
  const start = faces.reduce((best, f) => (at(f) < at(best) ? f : best), faces[0]);

  const half = faces.reduce((s, f) => s + mesh.areas[f], 0) / 2;
  const taken = new Set([start]);
  let got = mesh.areas[start];
  // A frontier ordered by position along the axis, so the growing half keeps a
  // straight-ish edge instead of reaching around the piece.
  const frontier = [];
  const pushNbrs = (f) => {
    for (const { face: g } of faceNeighbours(mesh, f)) {
      if (inPatch.has(g) && !taken.has(g) && !frontier.some((x) => x.f === g)) {
        frontier.push({ f: g, key: at(g) });
      }
    }
  };
  pushNbrs(start);
  // Stop one short of taking everything. The loop runs until half the AREA has
  // gone, and on a patch where one triangle carries most of the area that can
  // mean every triangle: the half is complete, the remainder is empty, and the
  // caller is told the piece cannot be divided when in fact it just was. That
  // reported an eight-face fragment of the sample bunny as unplaceable.
  while (frontier.length && got < half && taken.size < faces.length - 1) {
    frontier.sort((a, b) => a.key - b.key);
    const next = frontier.shift();
    if (taken.has(next.f)) continue;
    taken.add(next.f);
    got += mesh.areas[next.f];
    pushNbrs(next.f);
  }

  const rest = faces.filter((f) => !taken.has(f));
  if (!rest.length || !taken.size) return null;
  // The taken half is connected by construction. The remainder need not be.
  return [[...taken].sort((a, b) => a - b), ...connectedComponents(mesh, rest)];
}

/**
 * Flatten every patch, cutting any that will not fit or that laps over itself,
 * until what is left is a set of pieces that can each be placed.
 *
 * An island that overlaps itself is cut too, not exported. The overlap IS the
 * curvature the flattening could not lose; a smaller piece encloses less of it,
 * so cutting is the fix rather than a workaround.
 *
 * @returns {{pieces, unplaceable, splits}}
 *   unplaceable — named, with its size, because a part that is silently dropped
 *   is indistinguishable from a part that was never made.
 */
export function splitToFit(mesh, patches, opts = {}) {
  const { allowOverlap = false } = opts;
  // Every cut leaves both halves strictly smaller than what went in, so the
  // recursion cannot run away and the guard only has to be generous enough not
  // to stop honest work. It is derived rather than a constant because taking the
  // largest FITTING bite peels one sheet at a time — depth is linear in the
  // number of faces, not logarithmic as it was when the splitter simply halved.
  // A fixed 12 stopped a 2 x 0.8 m plate less than a third of the way through
  // and reported the remainder as unplaceable.
  const maxDepth = opts.maxDepth
    ?? Math.max(16, patches.reduce((m, p) => Math.max(m, p.faces.length), 0) + 8);
  // Room for the tabs that have not been added yet. See nestGeometry.
  const usable = nestGeometry(opts).usableForSplit;
  const pieces = [];
  const unplaceable = [];
  let splits = 0;

  const work = patches.map((p) => ({ patch: p, faces: p.faces, depth: 0, part: 0, of: 1 }));

  while (work.length) {
    const job = work.shift();
    const patch = { ...job.patch, faces: job.faces, area: job.faces.reduce((s, f) => s + mesh.areas[f], 0) };
    const flat = unfoldPatch(mesh, patch, opts);
    const tooBig = !fitsStock(flat, usable);
    const laps = !allowOverlap && flat.overlaps.length > 0;

    if (!tooBig && !laps) {
      pieces.push({ ...job, patch, flat });
      continue;
    }
    const why = tooBig
      ? `${fmt(flat.width)} x ${fmt(flat.height)} will not fit ${fmt(usable.length)} x ${fmt(usable.width)}`
      : `the flat pattern laps over itself in ${flat.overlaps.length} place(s)`;

    if (job.depth >= maxDepth || job.faces.length < 2) {
      unplaceable.push({
        key: patch.key,
        label: patch.label,
        faces: job.faces.length,
        width: flat.width,
        height: flat.height,
        units: mesh.units,
        why: job.faces.length < 2
          ? `${why}, and it is a single triangle — there is nothing left to cut`
          : `${why}, and it has been cut ${maxDepth} times already`,
        faceCount: job.faces.length,
      });
      continue;
    }

    // A piece that is too big is cut to the largest thing that WILL fit. A piece
    // that laps over itself is halved instead: the problem there is enclosed
    // curvature, not size, and taking a sheet-sized bite off one end does not
    // reduce it.
    const parts = tooBig
      ? (cleaveToFit(mesh, job.faces, flat, usable, opts) || bisect(mesh, job.faces, flat))
      : bisect(mesh, job.faces, flat);
    if (!parts || parts.length < 2) {
      unplaceable.push({
        key: patch.key, label: patch.label, faces: job.faces.length,
        width: flat.width, height: flat.height, units: mesh.units,
        why: `${why}, and it could not be divided`,
      });
      continue;
    }
    splits++;
    parts.forEach((set, i) => {
      work.push({
        patch: job.patch,
        faces: set,
        depth: job.depth + 1,
        part: job.part * 10 + i + 1,
        of: parts.length,
      });
    });
  }

  // Named in a stable order, so the same model always produces the same cut
  // list and a re-run can be compared with the one already printed out.
  pieces.sort((a, b) => a.patch.id - b.patch.id || a.part - b.part);
  const seen = new Map();
  for (const p of pieces) {
    const n = (seen.get(p.patch.id) || 0) + 1;
    seen.set(p.patch.id, n);
    p.label = n === 1 && countFor(pieces, p.patch.id) === 1
      ? p.patch.key
      : `${p.patch.key}${String.fromCharCode(96 + n)}`;
    p.flat.label = p.label;
  }
  return { pieces, unplaceable, splits, usable };
}

const countFor = (pieces, id) => pieces.filter((p) => p.patch.id === id).length;
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
