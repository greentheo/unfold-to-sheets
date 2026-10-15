// Fitting the flattened pieces onto sheets of stock.
//
// Adapted from the lofting project's nester, with its two findings kept because
// both were measured rather than reasoned:
//
//   A FULL TURN OF ANGLES, NOT A HALF. For a bounding box 180 degrees is the
//   same as 0. For a SHAPE it is the entire point — two tapered pieces nest head
//   to tail with one of them turned end for end, and half a turn of angles can
//   never find that. Sampling only a half turn cost a whole sheet.
//
//   THE FLIP IS WHERE THE WIN IS, AND MORE ANGLES CAN HURT. Going from one angle
//   to two gained a sheet on tapered strips. Going further does NOT keep helping:
//   measured on the 6 m dome's 140 triangles, eight angles took 40 sheets,
//   sixteen took 41 and twenty-four took 42 — worse material AND four times the
//   time. Bottom-left-fill is greedy, and handing a greedy algorithm more
//   choices lets it make a locally lower placement that ruins the skyline for
//   everything after it. Eight is the default because eight measured best, not
//   because more would be better if only there were time for it.
//
// Packing is by SHAPE rather than by bounding box. Rectangle packing is why
// rotation usually buys so little: turning a long tapered piece only makes its
// box bigger, and two wedges that would interlock are treated as two rectangles
// that cannot overlap at all. So each piece is rasterised onto a coarse grid and
// dropped bottom-left-first against real occupancy, which is how a person lays
// them out and lets a wedge lie in the hollow of its neighbour.
//
// The grid is deliberately coarse — it is a cutting layout, not a fit-up. Every
// piece is dilated by the gap before it is drawn, so a placement that looks legal
// on the grid has real clearance on the sheet.

import { nestGeometry } from './split.js';

const rot = (p, cos, sin) => ({ u: p.u * cos - p.v * sin, v: p.u * sin + p.v * cos });

/** Scanline-fill a polygon into a grid, dilated by `pad` cells. */
function rasterise(outline, cell, pad) {
  const us = outline.map((p) => p.u), vs = outline.map((p) => p.v);
  const minU = Math.min(...us), minV = Math.min(...vs);
  const cols = Math.ceil((Math.max(...us) - minU) / cell) + pad * 2 + 1;
  const rows = Math.ceil((Math.max(...vs) - minV) / cell) + pad * 2 + 1;
  const grid = new Uint8Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    const y = minV + (r - pad + 0.5) * cell;
    const xs = [];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length];
      if ((a.v <= y && b.v > y) || (b.v <= y && a.v > y)) {
        xs.push(a.u + ((y - a.v) / (b.v - a.v)) * (b.u - a.u));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.floor((xs[k] - minU) / cell) + pad;
      const c1 = Math.ceil((xs[k + 1] - minU) / cell) + pad;
      for (let c = Math.max(0, c0); c < Math.min(cols, c1); c++) grid[r * cols + c] = 1;
    }
  }

  // Dilate, so parts keep their gap without the packer having to think about it.
  let out = grid;
  for (let step = 0; step < pad; step++) {
    const next = new Uint8Array(out);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!out[r * cols + c]) continue;
        if (r > 0) next[(r - 1) * cols + c] = 1;
        if (r + 1 < rows) next[(r + 1) * cols + c] = 1;
        if (c > 0) next[r * cols + c - 1] = 1;
        if (c + 1 < cols) next[r * cols + c + 1] = 1;
      }
    }
    out = next;
  }

  // Row spans make the collision test cheap: most placements fail on the first.
  const spans = [];
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      if (!out[r * cols + c]) { c++; continue; }
      const start = c;
      while (c < cols && out[r * cols + c]) c++;
      spans.push({ r, c0: start, c1: c });
    }
  }
  return { cols, rows, spans, minU, minV };
}

/** The candidate orientations of one piece. */
function orientations(piece, angles, cell, pad) {
  return angles.map((deg) => {
    const a = (deg * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    const outline = piece.outline.map((p) => rot(p, cos, sin));
    const mask = rasterise(outline, cell, pad);
    return { angle: deg, cos, sin, mask,
      w: Math.max(...outline.map((p) => p.u)) - mask.minU,
      h: Math.max(...outline.map((p) => p.v)) - mask.minV };
  });
}

/**
 * Nest pieces onto sheets.
 *
 * Returns placements as a plain rotate-then-translate, so the exporters can put
 * the outline, the fold lines, the seam tokens and the labels through the same
 * transform. Anything that carried its own copy of the placement arithmetic
 * would drift from this one the first time either changed.
 *
 * @param {Array<{id, outline}>} pieces
 * @param {{sheetLength, sheetWidth, margin, kerf, rotations, grain}} opts
 * @returns {{sheets, oversize, cell, usable}}
 */
export function nestPieces(pieces, opts = {}) {
  const {
    sheetLength = 96, sheetWidth = 48, margin = 0.5, kerf = 0.125,
    rotations = 8, grain = false, openSheets = 0,
  } = opts;
  const { cell, pad, gap, usable } = nestGeometry(opts);
  const steps = Math.max(1, Math.round(rotations));
  // Grain-constrained stock — plywood, and any fabric — may only be turned end
  // for end, never across. Two angles rather than none: the flip is free and it
  // is where most of the saving was.
  const angles = grain
    ? [0, 180]
    : Array.from({ length: steps }, (_, i) => (i * 360) / steps);

  const sheetCols = Math.floor((sheetLength - margin * 2) / cell);
  const sheetRows = Math.floor((sheetWidth - margin * 2) / cell);
  // The sheet's occupancy as one bit per cell rather than one byte. A 2.4 metre
  // plywood sheet is 1200 x 600 cells, and the packer asks "is anything in this
  // run of forty cells" hundreds of millions of times; asking it of two machine
  // words instead of forty bytes is the whole difference between a nest that
  // takes seven seconds and one that takes one. It answers exactly the same
  // question, so the packing is bit-for-bit what it was.
  const words = (sheetCols + 31) >> 5;

  const prepared = pieces.map((piece, index) => ({
    index, piece, opts: orientations(piece, angles, cell, pad),
  }));
  // Bottom-left-fill wants the bulky things down first: a tall part dropped onto
  // a jagged skyline late on has nowhere good to go.
  prepared.sort((a, b) => {
    const tall = (x) => Math.max(...x.opts.map((o) => Math.min(o.w, o.h)));
    const area = (x) => Math.min(...x.opts.map((o) => o.w * o.h));
    return (tall(b) - tall(a)) || (area(b) - area(a)) || (a.index - b.index);
  });

  const sheets = [];
  const oversize = [];
  const newSheet = () => {
    const s = { placed: [], bits: new Uint32Array(words * sheetRows) };
    sheets.push(s);
    return s;
  };

  /** Is any cell in [from, to) of this row occupied? */
  const anySet = (bits, rowBase, from, to) => {
    let w = from >> 5;
    const lastW = (to - 1) >> 5;
    if (w === lastW) {
      // A single word: mask off the bits at both ends in one go.
      const m = (0xffffffff >>> (from & 31)) & ~(to & 31 ? 0xffffffff >>> (to & 31) : 0);
      return (bits[rowBase + w] & m) !== 0;
    }
    if (bits[rowBase + w] & (0xffffffff >>> (from & 31))) return true;
    for (w += 1; w < lastW; w++) if (bits[rowBase + w]) return true;
    const tail = to & 31 ? ~(0xffffffff >>> (to & 31)) : 0xffffffff;
    return (bits[rowBase + lastW] & tail) !== 0;
  };

  const collides = (bits, mask, cx, cy) => {
    for (const sp of mask.spans) {
      const r = cy + sp.r;
      if (r < 0 || r >= sheetRows) return true;
      const from = cx + sp.c0, to = cx + sp.c1;
      if (from < 0 || to > sheetCols) return true;
      if (anySet(bits, r * words, from, to)) return true;
    }
    return false;
  };

  for (const item of prepared) {
    const usableOpts = item.opts.filter((o) => o.mask.cols <= sheetCols && o.mask.rows <= sheetRows);
    if (!usableOpts.length) {
      // Named and measured, never silently dropped. A part missing from a cut
      // list looks exactly like a part that was never meant to exist.
      oversize.push({
        index: item.index,
        piece: item.piece,
        width: Math.min(...item.opts.map((o) => o.w)),
        height: Math.min(...item.opts.map((o) => o.h)),
        limit: usable,
      });
      continue;
    }

    let best = null;
    const trySheet = (sheet) => {
      for (const o of usableOpts) {
        // Rows from the bottom up, and the first row that takes this piece is
        // the answer for this rotation — nothing higher can beat it under
        // bottom-left-first, so the remaining rows are not searched. That early
        // exit is worth most of the running time on a large sheet, where a part
        // that comes to rest near the bottom would otherwise be tested against
        // several hundred rows it can never be placed in.
        //
        // A tempting further pruning — keep a skyline of the highest occupied
        // cell per column and start each column above it — is WRONG here, and
        // measurably so: shape nesting depends on a wedge lying in the hollow
        // under its neighbour, and a skyline says that hollow is full. It cost
        // a whole sheet at ×2 on the sample bunny, three going to four.
        for (let cy = 0; cy + o.mask.rows <= sheetRows; cy++) {
          if (best && cy >= best.cy) break;
          let found = -1;
          for (let cx = 0; cx + o.mask.cols <= sheetCols; cx++) {
            if (!collides(sheet.bits, o.mask, cx, cy)) { found = cx; break; }
          }
          if (found < 0) continue;
          if (!best || cy < best.cy || (cy === best.cy && found < best.cx)) {
            best = { sheet, o, cx: found, cy };
          }
          break;
        }
      }
    };
    // `openSheets` limits how far back a part may be dropped onto an earlier
    // sheet. Rescanning every sheet for every part is quadratic and dominates
    // once a model needs dozens of them.
    //
    // It is OFF by default, because it is not a free optimisation. Measured on
    // the 6 m dome: unlimited gives 38 sheets in 50 seconds, a window of six
    // gives 43 in 11. Five sheets of plywood is real money and eleven seconds is
    // not, so the default buys material with time rather than the other way
    // round — and because the sheets here are only about 40% full, backfilling
    // an early one is exactly where the saving comes from.
    const open = openSheets > 0 ? sheets.slice(-openSheets) : sheets;
    for (const sheet of open) { trySheet(sheet); if (best) break; }
    if (!best) trySheet(newSheet());
    if (!best) { oversize.push({ index: item.index, piece: item.piece }); continue; }

    const { sheet, o, cx, cy } = best;
    for (const sp of o.mask.spans) {
      const rowBase = (cy + sp.r) * words;
      for (let c = cx + sp.c0; c < cx + sp.c1; c++) {
        sheet.bits[rowBase + (c >> 5)] |= 0x80000000 >>> (c & 31);
      }
    }
    sheet.placed.push({
      index: item.index,
      piece: item.piece,
      angle: o.angle,
      // rotate by `angle`, then shift by this. One transform, applied by every
      // consumer, so outline and labels cannot end up in different places.
      offsetU: margin + (cx + pad) * cell - o.mask.minU,
      offsetV: margin + (cy + pad) * cell - o.mask.minV,
    });
  }

  return {
    sheets: sheets.map(({ placed }) => ({ placed })),
    oversize,
    cell,
    gap,
    usable,
    openSheets,
  };
}

/** The placement as a function, for anything that has to follow a piece. */
export function placementTransform(placed) {
  const a = (placed.angle * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  return (p) => ({
    u: p.u * cos - p.v * sin + placed.offsetU,
    v: p.u * sin + p.v * cos + placed.offsetV,
  });
}

/** Signed area of a closed outline, by the shoelace formula. */
export function polygonArea(outline) {
  let a = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    a += outline[j].u * outline[i].v - outline[i].u * outline[j].v;
  }
  return Math.abs(a) / 2;
}
