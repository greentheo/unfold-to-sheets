// How much material the model costs, as a function of how big you build it.
//
// This is the part that does not already exist elsewhere. Plenty of software
// will unfold a mesh; none of it treats the sheet as a hard constraint with real
// dimensions and then asks what size to build.
//
// The answer is not a slope. The stock stays the size it is sold at while the
// model grows, so each piece walks across the sheet until it no longer fits,
// then splits, and the offcut it leaves is dead. What comes out is a SAWTOOTH,
// with sizes in between that cost less material than a smaller model does — and
// that is not something anyone can read off a drawing. It has to be measured,
// which means nesting the whole model at every size and counting.

import { runScale } from './pipeline.js';

/** The scales to try, inclusive of both ends, avoiding floating-point drift. */
export function scaleSteps(from, to, step) {
  const n = Math.max(1, Math.round((to - from) / step));
  return Array.from({ length: n + 1 }, (_, i) => Number((from + i * step).toFixed(6)));
}

/** One row of the sweep: what this size costs, and whether the row is honest. */
export function evaluate(prepared, scale, opts = {}) {
  const r = runScale(prepared, scale, opts);
  return {
    scale,
    size: r.size,
    pieces: r.pieces.length,
    sheets: r.sheetCount,
    partArea: r.partArea,
    stockArea: r.stockArea,
    utilisation: r.utilisation,
    wasteSheets: r.wasteSheets,
    splits: r.splits,
    unplaceable: r.unplaceable,
    missing: r.missing,
    worstEdgeError: r.worstEdgeError,
    tokensOk: r.tokenCheck.ok,
    ...scantlings(scale, opts),
  };
}

/**
 * Evaluate a range of sizes, one at a time.
 *
 * A generator rather than a loop, so a caller can spread the work out. A sweep
 * is N complete nests; done in one go it locks a page for several seconds with
 * nothing to show for it.
 */
export function* sweep(prepared, { from = 0.5, to = 2, step = 0.05 } = {}, opts = {}) {
  for (const scale of scaleSteps(from, to, step)) yield evaluate(prepared, scale, opts);
}

/**
 * The rows worth choosing.
 *
 * A size is worth considering only if nothing else beats it outright — a model
 * at least as big for no more sheets. That is a plain Pareto front over (size
 * up, sheets down), and it is the exact question being asked: how big can I go
 * without buying another sheet, and is there a bigger one that costs less than
 * mine?
 *
 * ROWS WITH MISSING PARTS ARE DISQUALIFIED, not annotated. In lofting the first
 * promising result — 1.05 on twelve sheets against 1.00 on thirteen — was a lie:
 * two panels were unplaceable and had been silently excluded, so of course it
 * used fewer sheets. A row that does not include the whole model is not a
 * cheaper way to build it, and letting it sit on the frontier with a footnote
 * invites exactly the mistake the footnote is warning about.
 */
export function frontier(rows) {
  const live = rows.filter((r) => r.sheets > 0 && !r.unplaceable);
  return live
    .filter((r) => !live.some((o) => o !== r
      && o.size >= r.size && o.sheets <= r.sheets
      && (o.size > r.size || o.sheets < r.sheets)))
    .sort((a, b) => a.scale - b.scale);
}

/** Rows that were thrown out, and why — so the frontier's silence is explained. */
export function disqualified(rows) {
  return rows.filter((r) => r.unplaceable > 0).map((r) => ({
    scale: r.scale,
    sheets: r.sheets,
    unplaceable: r.unplaceable,
    why: r.missing.map((m) => `${m.label}: ${m.why}`),
  }));
}

/**
 * The step just below a jump in sheet count — the sizes where one more
 * millimetre of model costs a whole extra sheet.
 */
export function cliffs(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (!a.sheets || !b.sheets || a.unplaceable || b.unplaceable) continue;
    if (b.sheets > a.sheets) out.push({ at: a, next: b, cost: b.sheets - a.sheets });
  }
  return out;
}

/**
 * What changes about the OBJECT when you change the size, as against what
 * changes about the pattern.
 *
 * Included because the sheet count is a packing measure and nothing more, and
 * next to it in the same table it is very easy to read it as a cost comparison.
 * It is not one. Two things do not scale with the model:
 *
 *   THE STOCK IS THE SAME STOCK. Every row is nested from material of one
 *   thickness, so the rows compare different objects built from the same sheet.
 *   Six sheets of 6 mm and eighteen sheets of 12 mm are not comparable purchases
 *   and this table does not make them so.
 *
 *   PANEL THICKNESS WANTS k^1.5, NOT k. Bending stress in a panel goes as
 *   p.b^2/t^2; both the pressure and the span grow with k, so holding stress
 *   constant needs t^2 proportional to k^3. Thickness has to grow FASTER than
 *   length, which means scaling geometrically UNDER-builds going up and
 *   over-builds coming down. This is the physics rather than a design rule — for
 *   anything that carries a load the authority is the relevant standard — but it
 *   is the right direction and roughly the right size, printed next to the sheet
 *   count where the decision is actually being made.
 */
export function scantlings(scale, opts = {}) {
  const { thickness = 0 } = opts;
  return {
    volumeRatio: scale ** 3,
    areaRatio: scale ** 2,
    thicknessWanted: thickness > 0 ? thickness * scale ** 1.5 : 0,
    thicknessIfScaledFlat: thickness,
  };
}

/** A plain-text summary of a completed sweep, for the CLI and the README. */
export function summarise(rows, units = 'mm') {
  const front = frontier(rows);
  const bad = disqualified(rows);
  const lines = [];
  lines.push(`${rows.length} sizes tried, ${front.length} on the frontier, ${bad.length} disqualified for missing parts.`);
  if (front.length) {
    const biggest = front[front.length - 1];
    lines.push(`Best value: scale ${biggest.scale} — ${biggest.size.toFixed(1)} ${units} on ${biggest.sheets} sheet(s), ${(biggest.utilisation * 100).toFixed(1)}% used.`);
  }
  for (const c of cliffs(rows)) {
    lines.push(`Cliff at scale ${c.at.scale}: the next step costs ${c.cost} more sheet(s).`);
  }
  return lines.join('\n');
}
