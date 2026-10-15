// Putting text inside a shape, and keeping it there.
//
// Every mark on a piece — its name, its seam tokens — has to end up INSIDE the
// cut line. Outside it the label goes in the offcut, and you find that out
// after the part is cut, which is the one moment it cannot be fixed. A label
// found in the bin is worse than no label, because the part was cut believing
// it was marked.
//
// "Inside the bounding box" is not the same thing. An unfolded patch is usually
// a wedge or a fan, and most of its box is air. What matters is the horizontal
// RUN of solid material at the height the text is written at, and how wide the
// string is once it is drawn at that size.
//
// The two kinds of label are NOT interchangeable, and the difference decides
// what happens when one will not fit:
//
//   A PIECE NAME is read before the part is cut, off the sheet. If there is
//   nowhere inside to write it, just outside is a poor answer but a usable one.
//
//   A SEAM TOKEN is read after the part is cut, when the sheet is gone. Outside
//   is not a poor answer, it is no answer, so it is reported as a failure
//   instead.

/** Helvetica averages near this fraction of its point size per character. */
const PER_CHAR = 0.52;
export const textWidth = (s, height) => String(s).length * height * PER_CHAR;

/**
 * The spans of solid material along a horizontal line at height v.
 * @returns {Array<{lo, hi, width}>} left to right
 */
export function runsAt(outline, v) {
  const xs = [];
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[j], b = outline[i];
    // Half-open in v, so a vertex shared by two edges is counted once.
    if ((a.v > v) === (b.v > v)) continue;
    const t = (v - a.v) / (b.v - a.v);
    xs.push(a.u + t * (b.u - a.u));
  }
  xs.sort((p, q) => p - q);
  const runs = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    runs.push({ lo: xs[i], hi: xs[i + 1], width: xs[i + 1] - xs[i] });
  }
  return runs;
}

/**
 * Where a string fits inside an outline at a given height, and how big.
 *
 * Shrinks the text rather than letting it run over the edge, down to a floor.
 * Past that the label is unreadable and pretending otherwise helps nobody, so it
 * reports failure and lets the caller decide.
 *
 * @returns {{x, y, height, run}|null}
 */
export function fitAt(outline, v, str, height, opts = {}) {
  const { minHeight = height * 0.35, near = null } = opts;
  const runs = runsAt(outline, v);
  if (!runs.length) return null;

  const widest = runs.reduce((best, r) => (r.width > best.width ? r : best), runs[0]);
  const run = near == null
    ? widest
    : runs.find((r) => near >= r.lo - 1e-6 && near <= r.hi + 1e-6) ?? widest;

  let h = height;
  const pad = () => h * 0.3;
  while (h > minHeight && textWidth(str, h) + pad() * 2 > run.width) h *= 0.9;
  if (textWidth(str, h) + pad() * 2 > run.width) return null;

  // A label that names a particular place — a seam — belongs BESIDE that place,
  // so it starts there and is pushed in only far enough to fit. Without that,
  // every token on a piece slides to the same left-hand edge, where they are
  // perfectly legible and all in the wrong place.
  const want = near == null ? run.lo + (run.width - textWidth(str, h)) / 2 : near + pad();
  const x = Math.max(run.lo + pad(), Math.min(want, run.hi - pad() - textWidth(str, h)));
  return { x, y: v, height: h, run };
}

/** Do two placed labels sit on top of each other? */
export function overlaps(a, b) {
  const gapV = Math.max(a.height, b.height) * 1.1;
  if (Math.abs(a.y - b.y) >= gapV) return false;
  return a.x < b.x + textWidth(b.text, b.height) && b.x < a.x + textWidth(a.text, a.height);
}

/**
 * The piece's own name, inside the shape where it fits and just outside where it
 * does not.
 */
export function namePlacement(outline, label, height) {
  if (!label) return null;
  const vs = outline.map((p) => p.v);
  const us = outline.map((p) => p.u);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  let best = null;
  for (const f of [0.5, 0.42, 0.58, 0.34, 0.66, 0.25, 0.75]) {
    const at = fitAt(outline, lo + (hi - lo) * f, label, height);
    if (at && (!best || at.height > best.height)) best = { text: label, ...at };
    if (best && best.height >= height - 1e-9) break;
  }
  if (best) return best;
  return { text: label, x: Math.min(...us), y: hi + height * 0.6, height, outside: true };
}

/**
 * The seam tokens.
 *
 * Each sits on its own seam, inside the run of material that seam crosses,
 * nudged in off the cut line so it survives the knife. Two seams can run close
 * together, so a token that would land on one already placed slides along its
 * own line instead of covering it.
 *
 * No fallback outside, unlike the piece name: a token in the waste is a token
 * that is gone, and the whole purpose of the token is to be read once the waste
 * has been thrown away.
 *
 * @returns {Array<{text, x, y, height}|{text, dropped:true}>}
 */
export function seamPlacements(outline, marks, height) {
  const out = [];
  for (const m of marks) {
    const span = Math.hypot(m.b.u - m.a.u, m.b.v - m.a.v);
    const h = Math.max(height * 0.4, Math.min(height, span * 0.5));
    let at = null;
    for (const t of [0.5, 0.35, 0.65, 0.22, 0.78]) {
      const base = {
        u: m.a.u + (m.b.u - m.a.u) * t,
        v: m.a.v + (m.b.v - m.a.v) * t,
      };
      // Stepped in along the inward normal, so the text sits on the material
      // rather than astride the line it names.
      const v = base.v + m.inward.v * h * 0.9;
      const u = base.u + m.inward.u * h * 0.9;
      const cand = fitAt(outline, v, m.token, h, { near: u, minHeight: h * 0.5 });
      if (!cand) continue;
      at = at || cand;
      if (!out.some((q) => !q.dropped && overlaps(q, { ...cand, text: m.token }))) { at = cand; break; }
    }
    out.push(at ? { text: m.token, edge: m.edge, ...at } : { text: m.token, edge: m.edge, dropped: true });
  }
  return out;
}

/** What could not be written on a piece at all, for the caller to report. */
export function unlabelled(placements) {
  return placements.filter((p) => p.dropped).map((p) => p.text);
}
