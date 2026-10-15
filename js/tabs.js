// Glue tabs: the flap on one side of a seam that the other side is stuck to.
//
// A tab is a trapezoid standing outside the cut line, folded up along the seam
// it belongs to. Three things about it are less obvious than the shape:
//
// ONLY ONE SIDE OF A SEAM GETS ONE. Two tabs on the same joint means the two
// pieces cannot meet — the material is in the way. So each seam picks a side,
// and because a tab can fail to fit on the side it picked, it has to be able to
// try the other one and then to give up in writing rather than silently.
//
// THE ENDS ARE ANGLED IN. A rectangular tab collides with its neighbour at every
// corner of the piece. Drawing each end back along the seam by `width / tan θ`
// leaves the corner clear, which is why every papercraft tab is a trapezoid
// rather than a rectangle, and it costs nothing.
//
// A TAB IS PART OF THE PART. It is cut with the piece, so it is inside the
// outline the nester packs and inside the size the splitter measures — if it is
// not, every piece is a centimetre bigger than the thing that was checked
// against the sheet, which is the §5.4 failure again wearing a different hat.
// `nestGeometry()` therefore knows the tab width, and it is the only thing that
// does.

const EPS = 1e-9;

/**
 * The tab standing outside one segment of an outline.
 *
 * The ring runs counter-clockwise, so the interior is to the left of travel and
 * the tab goes to the right.
 */
export function tabPolygon(P0, P1, width, angleDeg, maxInsetFraction = 0.35) {
  const du = P1.u - P0.u, dv = P1.v - P0.v;
  const len = Math.hypot(du, dv);
  if (len < EPS) return null;
  const ux = du / len, uy = dv / len;
  const nx = dv / len, ny = -du / len;                 // outward

  const theta = (Math.min(89, Math.max(20, angleDeg)) * Math.PI) / 180;
  // Held back from both ends so neighbouring tabs cannot meet at a corner, and
  // capped so a short seam gets a triangle rather than a bow tie.
  const inset = Math.min(width / Math.tan(theta), len * maxInsetFraction);
  const T0 = { u: P0.u + ux * inset + nx * width, v: P0.v + uy * inset + ny * width };
  const T1 = { u: P1.u - ux * inset + nx * width, v: P1.v - uy * inset + ny * width };
  return { points: [P0, T0, T1, P1], inset, length: len, width };
}

const cross = (a, b, c) => (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);

function segmentsCross(p1, p2, q1, q2) {
  const d1 = Math.sign(cross(p1, p2, q1)), d2 = Math.sign(cross(p1, p2, q2));
  const d3 = Math.sign(cross(q1, q2, p1)), d4 = Math.sign(cross(q1, q2, p2));
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i].v > p.v) !== (poly[j].v > p.v)
      && p.u < ((poly[j].u - poly[i].u) * (p.v - poly[i].v)) / (poly[j].v - poly[i].v) + poly[i].u) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Does this tab foul the piece it stands on, or a tab already accepted?
 *
 * The base segment is skipped: a tab shares it with the outline by construction
 * and would otherwise always report a collision with the very edge it is
 * attached to.
 */
function fouls(tab, outline, baseIndex, accepted) {
  const n = outline.length;
  const outer = [tab.points[1], tab.points[2]];
  for (const p of outer) if (pointInPolygon(p, outline)) return true;
  for (let i = 0; i < n; i++) {
    if (i === baseIndex) continue;
    const a = outline[i], b = outline[(i + 1) % n];
    for (let k = 0; k < 3; k++) {
      if (segmentsCross(tab.points[k], tab.points[k + 1], a, b)) return true;
    }
  }
  for (const other of accepted) {
    for (let k = 0; k < 3; k++) {
      for (let m = 0; m < 3; m++) {
        if (segmentsCross(tab.points[k], tab.points[k + 1], other.points[m], other.points[m + 1])) return true;
      }
    }
    if (pointInPolygon(tab.points[1], other.points) || pointInPolygon(other.points[1], tab.points)) return true;
  }
  return false;
}

/**
 * Decide where every tab goes, and say what could not be given one.
 *
 * @param {Array} pieces from splitToFit
 * @param {object} seams from markSeams
 * @param {{tabWidth, tabAngle, minSeam, shrinkTo}} opts
 * @returns {{byPiece, skipped, stats}}
 */
export function planTabs(pieces, seams, opts = {}) {
  const {
    tabWidth = 6, tabAngle = 60, minSeam = tabWidth * 1.2, shrinkTo = 0.5,
  } = opts;

  // Where each seam sits on each piece's outline, once, up front.
  const indexOf = pieces.map((p) => {
    const m = new Map();
    p.flat.outline.forEach((step, i) => m.set(step.edge, i));
    return m;
  });

  const byPiece = pieces.map(() => []);
  const skipped = [];

  // In token order, so the same model always puts its tabs in the same places
  // and a kit cut today matches the drawing printed yesterday.
  const seamList = [...seams.seams.values()].sort((a, b) => (a.token < b.token ? -1 : 1));

  for (const seam of seamList) {
    const [pa, pb] = seam.pieces;
    // Alternate which side is tried first. Always preferring the lower-numbered
    // piece loads every tab in a joint onto the earlier part, which is both
    // ugly and much more likely to run tabs into each other.
    const order = seam.edge % 2 === 0 ? [pa, pb] : [pb, pa];

    let placed = null;
    for (const pi of order) {
      if (pi < 0 || pi >= pieces.length) continue;
      const outline = pieces[pi].flat.outline;
      const i = indexOf[pi].get(seam.edge);
      if (i === undefined) continue;
      const P0 = outline[i], P1 = outline[(i + 1) % outline.length];
      const len = Math.hypot(P1.u - P0.u, P1.v - P0.v);
      if (len < minSeam) continue;                 // too short to glue anything to

      // Full width first, then narrower rather than nothing: a 3 mm tab still
      // holds, and a missing one leaves a joint with no way to fasten it.
      for (const scale of [1, 0.7, shrinkTo]) {
        const t = tabPolygon(P0, P1, tabWidth * scale, tabAngle);
        if (!t) break;
        if (fouls(t, outline, i, byPiece[pi])) continue;
        placed = {
          ...t,
          piece: pi,
          edge: seam.edge,
          token: seam.token,
          at: i,
          joinsPiece: pi === pa ? pb : pa,
          shrunk: scale < 1,
          foldDeg: seam.foldDeg,
        };
        break;
      }
      if (placed) break;
    }

    if (placed) byPiece[placed.piece].push(placed);
    else {
      // Named, with the reason. A seam with no tab is a joint with nothing to
      // fasten it, and finding that out with the glue open is too late.
      skipped.push({
        token: seam.token,
        edge: seam.edge,
        pieces: seam.pieces.map((i) => pieces[i]?.label ?? '?'),
        length: seam.length,
        why: seam.length < minSeam
          ? `the seam is only ${seam.length.toFixed(1)} long — shorter than a tab`
          : 'a tab on either side would foul the piece or another tab',
      });
    }
  }

  return {
    byPiece,
    skipped,
    stats: {
      tabs: byPiece.reduce((s, t) => s + t.length, 0),
      shrunk: byPiece.flat().filter((t) => t.shrunk).length,
      skipped: skipped.length,
    },
  };
}

/**
 * The outline as it is actually CUT: the piece, with its tabs let into the ring
 * at the segments they belong to.
 *
 * The base outline is left alone and kept alongside. Labels belong inside the
 * piece and not out on a flap that gets folded up and glued face down, so the
 * two are different polygons on purpose.
 */
export function cutOutlineWithTabs(outline, tabs) {
  if (!tabs.length) return outline.slice();
  const at = new Map(tabs.map((t) => [t.at, t]));
  const out = [];
  for (let i = 0; i < outline.length; i++) {
    out.push(outline[i]);
    const t = at.get(i);
    if (t) out.push({ ...t.points[1], tab: t.token }, { ...t.points[2], tab: t.token });
  }
  return out;
}

/** Attach the plan to the pieces, so downstream reads one place. */
export function applyTabs(pieces, plan) {
  pieces.forEach((p, i) => {
    p.tabs = plan.byPiece[i] || [];
    p.flat.cutOutline = cutOutlineWithTabs(p.flat.outline, p.tabs);
  });
  return pieces;
}

/** No tabs at all — butt joints — but the same shape of answer. */
export function noTabs(pieces) {
  pieces.forEach((p) => { p.tabs = []; p.flat.cutOutline = p.flat.outline.slice(); });
  return { byPiece: pieces.map(() => []), skipped: [], stats: { tabs: 0, shrunk: 0, skipped: 0 } };
}
