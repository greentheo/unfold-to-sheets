// Laying a patch of surface down flat, and saying how much that was a lie.
//
// Triangles are placed one at a time, each against a neighbour already down, by
// the lengths of its own sides. Nothing is projected and nothing is minimised,
// so every triangle in the plane is congruent to its twin on the surface and
// every edge comes out exactly the length it really is. That is the property the
// whole tool exists to deliver: cut to this and the edges meet.
//
// What it cannot do is make the copies agree. Walk a ring of triangles around an
// interior corner and the last one does not line up with the first — it falls
// short, or laps over, by exactly the angle the surface was missing there. That
// gap is the curvature, it is a theorem, and no laying-down order avoids it.
//
// So the pattern is built in two steps, and both numbers are reported:
//
//   SPREAD       how far apart the copies of one corner ended up. The raw lie,
//                in millimetres or inches, before anything is done about it.
//   EDGE ERROR   after the copies are reconciled into one pattern, the worst
//                disagreement between an edge on the surface and the same edge
//                on the flat. This is what a builder measures with a tape, so
//                it is what goes on the drawing.
//
// A patch that really is developable gives zero for both, exactly, and the
// reconciliation step does nothing at all. That is asserted in the tests, on a
// flat plate and on a cylinder, because it fails NUMERICALLY rather than
// plausibly and so catches what looking at the screen does not.

import { edgeLength, faceNeighbours, dihedralDeg, thirdVertex } from './mesh.js';

const dist2 = (a, b) => Math.hypot(a.u - b.u, a.v - b.v);

/**
 * Lay one triangle down against an edge already placed.
 *
 * @param {{u,v}} A,B  the shared edge, already in the plane
 * @param {number} ra,rb  distances from A and from B to the corner being placed
 * @param {{u,v}} away    the parent's far corner; the new one goes on the far side
 */
function placeThird(A, B, ra, rb, away) {
  const dx = B.u - A.u, dy = B.v - A.v;
  const d = Math.hypot(dx, dy);
  if (d < 1e-12) return null;
  // Standard two-circle intersection, written along the edge and across it.
  const a = (ra * ra - rb * rb + d * d) / (2 * d);
  const h2 = ra * ra - a * a;
  const h = Math.sqrt(Math.max(0, h2));
  const mx = A.u + (a * dx) / d, my = A.v + (a * dy) / d;
  const nx = -dy / d, ny = dx / d;
  const p = { u: mx + h * nx, v: my + h * ny };
  const q = { u: mx - h * nx, v: my - h * ny };
  // Which side is "away"? The one the parent's own far corner is not on. Nearest
  // to the last point cannot decide this — both candidates are equidistant from
  // the shared edge by construction — and getting it wrong folds the patch back
  // over itself, which then reads as an overlap rather than as a bug.
  const side = (pt) => (pt.u - A.u) * nx + (pt.v - A.v) * ny;
  const sAway = (away.u - A.u) * nx + (away.v - A.v) * ny;
  return Math.sign(side(p)) !== Math.sign(sAway) ? p : q;
}

/**
 * Walk the patch's dual graph and place every triangle.
 *
 * The order is breadth-first from the most central face rather than from the
 * first one in the list. The error accumulates with distance from the root, so
 * starting in the middle halves the worst of it, and it costs one sort.
 *
 * @returns {{place: Map<face, [u,v,u,v,u,v]>, order: face[], parentOf: Map}}
 */
function layDown(mesh, faces) {
  const inPatch = new Set(faces);
  const place = new Map();
  const order = [];
  const parentOf = new Map();

  // The root: the face whose greatest hop-count to any other face is least.
  const root = centralFace(mesh, faces);

  const v0 = mesh.tris[root * 3], v1 = mesh.tris[root * 3 + 1], v2 = mesh.tris[root * 3 + 2];
  const l01 = edgeLength(mesh, v0, v1);
  const A = { u: 0, v: 0 }, B = { u: l01, v: 0 };
  const C = placeThird(A, B, edgeLength(mesh, v0, v2), edgeLength(mesh, v1, v2), { u: 0, v: -1 });
  place.set(root, [A, B, C]);
  order.push(root);

  const queue = [root];
  const seen = new Set([root]);
  while (queue.length) {
    const f = queue.shift();
    const pf = place.get(f);
    const fv = [mesh.tris[f * 3], mesh.tris[f * 3 + 1], mesh.tris[f * 3 + 2]];
    for (const { face: g, edge: ei } of faceNeighbours(mesh, f)) {
      if (!inPatch.has(g) || seen.has(g)) continue;
      const e = mesh.edges[ei];
      const ia = fv.indexOf(e.a), ib = fv.indexOf(e.b);
      if (ia < 0 || ib < 0) continue;
      const far = thirdVertex(mesh, g, e.a, e.b);
      const parentFar = pf[fv.findIndex((x) => x !== e.a && x !== e.b)];
      const P = placeThird(pf[ia], pf[ib],
        edgeLength(mesh, e.a, far), edgeLength(mesh, e.b, far), parentFar);
      if (!P) continue;
      const gv = [mesh.tris[g * 3], mesh.tris[g * 3 + 1], mesh.tris[g * 3 + 2]];
      const pg = [null, null, null];
      pg[gv.indexOf(e.a)] = pf[ia];
      pg[gv.indexOf(e.b)] = pf[ib];
      pg[gv.indexOf(far)] = P;
      place.set(g, pg);
      parentOf.set(g, { face: f, edge: ei });
      seen.add(g);
      order.push(g);
      queue.push(g);
    }
  }
  return { place, order, parentOf, root, unreached: faces.filter((f) => !seen.has(f)) };
}

/** The face nearest the middle of the patch, by hops through the dual graph. */
function centralFace(mesh, faces) {
  const inPatch = new Set(faces);
  if (faces.length < 3) return faces[0];
  // Two sweeps of breadth-first search find the ends of the longest path; the
  // middle of that path is a good enough centre and is far cheaper than the
  // exact one on patches of any size.
  const bfs = (start) => {
    const d = new Map([[start, 0]]);
    const q = [start];
    let last = start;
    while (q.length) {
      const f = q.shift();
      last = f;
      for (const { face: g } of faceNeighbours(mesh, f)) {
        if (!inPatch.has(g) || d.has(g)) continue;
        d.set(g, d.get(f) + 1);
        q.push(g);
      }
    }
    return { d, last };
  };
  const a = bfs(faces[0]).last;
  const { d, last: b } = bfs(a);
  const db = bfs(b).d;
  let best = faces[0], bestScore = Infinity;
  for (const f of faces) {
    const score = Math.max(d.get(f) ?? Infinity, db.get(f) ?? Infinity);
    if (score < bestScore) { bestScore = score; best = f; }
  }
  return best;
}

/** Boundary loops of a face set, as ordered vertex rings carrying their edges. */
export function boundaryLoops(mesh, faces) {
  const inPatch = new Set(faces);
  const bEdges = new Set();
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const ei = mesh.faceEdges[f * 3 + k];
      if (mesh.edges[ei].faces.filter((g) => inPatch.has(g)).length === 1) bEdges.add(ei);
    }
  }
  // Walk each ring in the direction the faces wind, so the loop comes out with
  // a consistent handedness and the outer one can be told from a hole by sign.
  const next = new Map();
  for (const ei of bEdges) {
    const e = mesh.edges[ei];
    const f = e.faces.find((g) => inPatch.has(g));
    const fv = [mesh.tris[f * 3], mesh.tris[f * 3 + 1], mesh.tris[f * 3 + 2]];
    const k = fv.findIndex((x, i) => (x === e.a && fv[(i + 1) % 3] === e.b)
                                  || (x === e.b && fv[(i + 1) % 3] === e.a));
    const from = fv[k], to = fv[(k + 1) % 3];
    if (!next.has(from)) next.set(from, []);
    next.get(from).push({ to, edge: ei });
  }
  const loops = [];
  const used = new Set();
  for (const [start] of next) {
    if (used.has(start)) continue;
    const loop = [];
    let v = start;
    let guard = 0;
    while (guard++ < bEdges.size + 2) {
      const outs = next.get(v);
      if (!outs) break;
      const step = outs.find((o) => !used.has(`${v}>${o.edge}`));
      if (!step) break;
      used.add(`${v}>${step.edge}`);
      used.add(v);
      loop.push({ vertex: v, edge: step.edge });
      v = step.to;
      if (v === start) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

const signedArea = (pts) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j].u * pts[i].v - pts[i].u * pts[j].v;
  }
  return a / 2;
};
export const polygonArea = (pts) => Math.abs(signedArea(pts));

/**
 * Turn the pattern so it runs along its own length.
 *
 * Where a patch ENDS UP in the plane is an accident of which triangle happened
 * to be laid down first. The shape is right either way, but everything after
 * this reads a bounding box: a piece sitting on a diagonal measures longer than
 * it is, so the splitter cuts one in half that would have fitted whole and the
 * nester reserves a square of sheet for a sliver. Rotating is rigid, so no edge
 * length is touched and it is the same part.
 */
function alignToPrincipalAxis(points) {
  const n = points.length;
  let cu = 0, cv = 0;
  for (const p of points) { cu += p.u; cv += p.v; }
  cu /= n; cv /= n;
  let suu = 0, svv = 0, suv = 0;
  for (const p of points) {
    const du = p.u - cu, dv = p.v - cv;
    suu += du * du; svv += dv * dv; suv += du * dv;
  }
  const theta = 0.5 * Math.atan2(2 * suv, suu - svv);
  return { cu, cv, cos: Math.cos(-theta), sin: Math.sin(-theta) };
}

/** Do two triangles in the plane actually overlap? Separating-axis test. */
function trianglesOverlap(t1, t2, shrink) {
  const pull = (t) => {
    const cu = (t[0].u + t[1].u + t[2].u) / 3, cv = (t[0].v + t[1].v + t[2].v) / 3;
    return t.map((p) => ({ u: p.u + (cu - p.u) * shrink, v: p.v + (cv - p.v) * shrink }));
  };
  // Pulled very slightly towards their own centres, so triangles that merely
  // touch — which every adjacent pair does, along the edge they share — are not
  // reported as lapping over each other.
  const a = pull(t1), b = pull(t2);
  for (const t of [a, b]) {
    for (let i = 0; i < 3; i++) {
      const p = t[i], q = t[(i + 1) % 3];
      const nx = -(q.v - p.v), ny = q.u - p.u;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const z of a) { const d = z.u * nx + z.v * ny; aMin = Math.min(aMin, d); aMax = Math.max(aMax, d); }
      for (const z of b) { const d = z.u * nx + z.v * ny; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d); }
      if (aMax <= bMin || bMax <= aMin) return false;
    }
  }
  return true;
}

/**
 * Flatten one patch.
 *
 * @param {Mesh} mesh
 * @param {Patch} patch
 * @param {{relax?: number}} opts
 * @returns {Flat} outline, folds, and every error it made getting there
 */
export function unfoldPatch(mesh, patch, opts = {}) {
  const { relax = 60 } = opts;
  const faces = patch.faces;
  const { place, order, unreached, root } = layDown(mesh, faces);

  // ── reconcile the copies ──
  // Each corner has been placed once per triangle that meets there. Where the
  // surface was flat they coincide; where it was not they scatter, and how far
  // they scatter IS the curvature enclosed, expressed as a length.
  const acc = new Map();
  for (const f of order) {
    const p = place.get(f);
    for (let k = 0; k < 3; k++) {
      const v = mesh.tris[f * 3 + k];
      if (!acc.has(v)) acc.set(v, []);
      acc.get(v).push(p[k]);
    }
  }
  let spread = 0, spreadAt = null;
  const xy = new Map();
  for (const [v, list] of acc) {
    let u = 0, w = 0;
    for (const p of list) { u += p.u; w += p.v; }
    xy.set(v, { u: u / list.length, v: w / list.length });
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = dist2(list[i], list[j]);
        if (d > spread) { spread = d; spreadAt = v; }
      }
    }
  }

  // ── even the error out ──
  // Averaging puts the whole discrepancy wherever the copies happened to
  // disagree most. A few passes of pulling each edge back to its true length
  // spreads it over the patch instead, which is both a smaller worst case and a
  // fairer one. On a developable patch every edge is already exact and this
  // loop is a no-op, which is asserted rather than assumed.
  const edgesIn = patchEdges(mesh, faces);
  if (relax > 0 && spread > 1e-9) relaxEdges(mesh, xy, edgesIn, faces, relax);

  // ── what it cost ──
  let maxEdgeError = 0, worstEdge = null;
  for (const ei of edgesIn) {
    const e = mesh.edges[ei];
    const want = edgeLength(mesh, e.a, e.b);
    const got = dist2(xy.get(e.a), xy.get(e.b));
    const err = Math.abs(got - want);
    if (err > maxEdgeError) { maxEdgeError = err; worstEdge = ei; }
  }

  // ── orientation, outline, folds ──
  const loops = boundaryLoops(mesh, faces);
  // A piece with holes lines up with its OUTLINE. Every point counts in the
  // principal axes, so a hole off to one side (a lightening hole, a window with
  // fifty points round its corners) pulls them towards itself and the piece
  // goes onto the sheet tilted. A piece without holes is lined up as before.
  let alignBy = [...xy.values()];
  if (loops.length > 1) {
    const rings = loops.map((loop) => loop.map((step) => xy.get(step.vertex)));
    alignBy = rings.reduce((a, b) => (polygonArea(b) > polygonArea(a) ? b : a));
  }
  const { cu, cv, cos, sin } = alignToPrincipalAxis(alignBy);
  const turn = (p) => ({ u: (p.u - cu) * cos - (p.v - cv) * sin, v: (p.u - cu) * sin + (p.v - cv) * cos });
  for (const [v, p] of xy) xy.set(v, turn(p));

  const rings = loops.map((loop) => loop.map((step) => ({ ...xy.get(step.vertex), vertex: step.vertex, edge: step.edge })));
  rings.sort((a, b) => polygonArea(b) - polygonArea(a));
  let outline = rings[0] || [];
  const holes = rings.slice(1);
  // Counter-clockwise, so area is positive and every consumer can assume it.
  if (signedArea(outline) < 0) outline = reverseRing(outline);

  const folds = [];
  for (const ei of edgesIn) {
    const e = mesh.edges[ei];
    if (e.faces.filter((f) => faces.includes(f)).length !== 2) continue;
    folds.push({
      edge: ei,
      a: xy.get(e.a),
      b: xy.get(e.b),
      angleDeg: dihedralDeg(mesh, ei),
    });
  }

  // ── overlap ──
  // Mandatory for this route: the error does not vanish, it moves, and where it
  // has moved to is one part of the island lying on top of another. An island
  // that laps over itself must be cut further, not exported.
  const tri2d = faces.map((f) => [0, 1, 2].map((k) => xy.get(mesh.tris[f * 3 + k])));
  const overlaps = [];
  const scale = Math.sqrt(patch.area) || 1;
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      if (trianglesOverlap(tri2d[i], tri2d[j], 0.02)) overlaps.push([faces[i], faces[j]]);
    }
  }

  const us = xy.size ? [...xy.values()].map((p) => p.u) : [0];
  const vs = xy.size ? [...xy.values()].map((p) => p.v) : [0];
  const width = Math.max(...us) - Math.min(...us);
  const height = Math.max(...vs) - Math.min(...vs);

  return {
    patchId: patch.id,
    key: patch.key,
    label: patch.label,
    faces,
    xy,
    outline,
    holes,
    folds,
    root,
    method: 'spanning-tree + reconciled',
    // Every derived value carries its own error, so a caller cannot lose it
    // without deleting a field — which is at least a visible act.
    spread,
    spreadAt,
    maxEdgeError,
    worstEdge,
    overlaps,
    unreached,
    surfaceArea: patch.area,
    flatArea: polygonArea(outline) - holes.reduce((s, h) => s + polygonArea(h), 0),
    width,
    height,
    units: mesh.units,
  };
}

const reverseRing = (ring) => {
  // Reversing a ring has to carry the edges with it: entry i holds the edge
  // LEADING AWAY from vertex i, so after reversing it must hold its neighbour's.
  const out = ring.slice().reverse();
  const edges = out.map((p) => p.edge);
  return out.map((p, i) => ({ ...p, edge: edges[(i + edges.length - 1) % edges.length] }));
};

/** Every edge with at least one face in the patch. */
export function patchEdges(mesh, faces) {
  const set = new Set();
  for (const f of faces) for (let k = 0; k < 3; k++) set.add(mesh.faceEdges[f * 3 + k]);
  return [...set];
}

/**
 * Pull each edge back towards its true length, a few times over.
 *
 * Gauss-Seidel, and deliberately not a solver: the pattern is already close, the
 * job is only to share out the discrepancy, and a triangle that turns itself
 * inside out in the process would be a worse answer than the one it replaced. So
 * every move is checked against the winding it started with and dropped if it
 * flips one.
 */
function relaxEdges(mesh, xy, edges, faces, iterations) {
  const faceList = faces.slice();
  const sign0 = faceList.map((f) => Math.sign(area2(mesh, xy, f)));
  const targets = edges.map((ei) => {
    const e = mesh.edges[ei];
    return { a: e.a, b: e.b, len: edgeLength(mesh, e.a, e.b) };
  });
  for (let it = 0; it < iterations; it++) {
    let moved = 0;
    for (const t of targets) {
      const A = xy.get(t.a), B = xy.get(t.b);
      if (!A || !B) continue;
      const du = B.u - A.u, dv = B.v - A.v;
      const d = Math.hypot(du, dv);
      if (d < 1e-12) continue;
      const push = ((d - t.len) / d) * 0.5;
      const kx = du * push * 0.5, ky = dv * push * 0.5;
      const before = [{ ...A }, { ...B }];
      A.u += kx; A.v += ky; B.u -= kx; B.v -= ky;
      moved += Math.abs(d - t.len);
      // Any triangle turned inside out undoes the move that did it.
      let bad = false;
      for (let i = 0; i < faceList.length && !bad; i++) {
        const f = faceList[i];
        if (mesh.tris[f * 3] !== t.a && mesh.tris[f * 3 + 1] !== t.a && mesh.tris[f * 3 + 2] !== t.a
         && mesh.tris[f * 3] !== t.b && mesh.tris[f * 3 + 1] !== t.b && mesh.tris[f * 3 + 2] !== t.b) continue;
        if (Math.sign(area2(mesh, xy, f)) !== sign0[i]) bad = true;
      }
      if (bad) { Object.assign(A, before[0]); Object.assign(B, before[1]); }
    }
    if (moved < 1e-12) break;
  }
}

function area2(mesh, xy, f) {
  const a = xy.get(mesh.tris[f * 3]), b = xy.get(mesh.tris[f * 3 + 1]), c = xy.get(mesh.tris[f * 3 + 2]);
  return (b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v);
}

/** Flatten every patch, and gather what went wrong across all of them. */
export function unfoldAll(mesh, patches, opts = {}) {
  const flats = patches.map((p) => unfoldPatch(mesh, p, opts));
  const overlapping = flats.filter((f) => f.overlaps.length);
  return {
    flats,
    worstEdgeError: flats.reduce((m, f) => Math.max(m, f.maxEdgeError), 0),
    worstSpread: flats.reduce((m, f) => Math.max(m, f.spread), 0),
    overlapping,
  };
}
