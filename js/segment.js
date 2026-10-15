// Cutting the surface into pieces that will lie flat.
//
// This is the stage that can eat a schedule, so it is worth being clear about
// what it is for. Most surfaces do not flatten — that is a theorem, not a
// missing feature — and the job here is to find the largest pieces that very
// nearly do, and to put the cuts where they can be lived with.
//
// TWO KINDS OF INPUT, and the first one is better:
//
//   1. The user already knows. An OBJ with groups, or a model authored with the
//      seams in it, says where the thing comes apart, and reading that beats any
//      amount of inferring it. This was the single most transferable lesson from
//      the lofting project: the software was guessing at something the person
//      had known all along.
//   2. Nobody said, so it has to be worked out. That is the rest of this file.
//
// WHAT "NEARLY FLAT" MEANS. The tempting test is that the face normals inside a
// patch stay within some cone of each other. That test is wrong, and wrong in a
// way that costs material: a cylinder's normals sweep through a half turn and it
// rolls out to an exact rectangle. Curvature in ONE direction is free.
//
// The test that is actually right is the discrete Gaussian curvature — at every
// corner interior to the patch, do the angles meeting there add up to a full
// turn? A cylinder: yes, everywhere, so it comes out as one piece. A sphere: no,
// anywhere, so it gets cut up. That is the theorem, applied directly, and it is
// about ten lines.
//
// WHAT THE MATERIAL WANTS. A crease is not a cut. A cardboard box unfolds as one
// piece with score lines; the same box in plywood is six separate parts. So the
// fold limit is a property of the STOCK, not of the geometry, and it lives in
// materials.js.

import { dihedralDeg, vertexFaces, faceNeighbours, edgeLength } from './mesh.js';

const TAU = Math.PI * 2;

/**
 * @typedef {{id, key, faces:number[], area, seed, worstDefectDeg, worstFoldDeg, source}} Patch
 */

/**
 * Split a set of faces into pieces that are actually joined up.
 *
 * A group in an OBJ file, or a material assignment, is a label rather than a
 * region — "left ear" can perfectly well name two faces at opposite ends of the
 * model. Every later stage assumes it can walk from any face of a patch to any
 * other, so the pieces are separated here and counted, rather than producing an
 * unfold that quietly drops everything it could not reach from the root.
 */
export function connectedComponents(mesh, faces, blocked = null) {
  const inSet = new Set(faces);
  const seen = new Set();
  const out = [];
  for (const start of faces) {
    if (seen.has(start)) continue;
    const comp = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const f = stack.pop();
      comp.push(f);
      for (const { face: g, edge } of faceNeighbours(mesh, f)) {
        if (!inSet.has(g) || seen.has(g)) continue;
        if (blocked && blocked.has(edge)) continue;
        seen.add(g);
        stack.push(g);
      }
    }
    out.push(comp.sort((a, b) => a - b));
  }
  return out;
}

/** Patches straight from the file's own grouping. */
export function segmentByGroups(mesh) {
  const byGroup = new Map();
  for (let f = 0; f < mesh.faceCount; f++) {
    const g = mesh.groups[f] ?? 0;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(f);
  }
  const patches = [];
  for (const [g, faces] of [...byGroup.entries()].sort((a, b) => a[0] - b[0])) {
    const name = mesh.groupNames ? mesh.groupNames[g] : `group ${g}`;
    const comps = connectedComponents(mesh, faces);
    comps.forEach((comp, i) => {
      patches.push(makePatch(mesh, patches.length,
        comps.length > 1 ? `${name} (${i + 1})` : name, comp, comp[0], 'groups'));
    });
  }
  return patches;
}

/** How far from flat the surface is at vertex `v`, counting only patch faces. */
function defectAt(mesh, v, angleSum, closed) {
  if (!closed) return 0;                     // still on the patch's rim: no verdict yet
  return Math.abs(TAU - angleSum) * 180 / Math.PI;
}

/**
 * Grow patches over the mesh until every face belongs to one.
 *
 * Growth is a shortest-path search out from the seed, where the distance to a
 * face is the total bending crossed to reach it. Faces come in cheapest-first,
 * so the patch spreads through whatever is flattest and meets the creases last —
 * which is where the cut wanted to be anyway.
 *
 * ACCUMULATED cost rather than the cost of the next step alone, and the
 * difference is not cosmetic. Taking the flattest single step available anywhere
 * on the frontier lets the patch follow one smooth seam right across the model
 * and spiral back on itself: on the sample bunny that gave two 148-face patches
 * shaped like snakes, each perfectly developable — a spiral is a disc and
 * encloses no curvature at all — and each useless as a part. Accumulating the
 * cost makes the frontier a contour around the seed, so patches come out as
 * blobs. Ties are broken by plain distance from the seed, which is what keeps a
 * dead-flat region (every step costing nothing) compact as well.
 *
 * Two constraints hold it back, and BOTH are needed.
 *
 * THE DISC RULE. A patch must stay a topological disc. Without that the growth
 * finds a loophole: curvature is only counted once a corner is completely
 * surrounded, so a patch can flow all the way around a sharp corner, leave the
 * single face that would close it, and report no curvature at all. Measured on
 * the sample bunny, that produced one 231-face "flat" patch slit at a hundred
 * corners like a paper snowflake, and fifty-seven leftover single triangles —
 * the faces it had declined to close. Euler settles it in one line: adding a
 * face keeps a disc a disc exactly when it brings one more new vertex than it
 * shares edges, so V - E + F never leaves 1.
 *
 * THE COMPACTNESS BOUND. Being a disc is not the same as being a usable part. A
 * long thin spiral is a perfectly good disc, encloses no curvature at all, and
 * is therefore free under both rules above — and on a surface where nearly every
 * corner is too sharp to enclose, growth will find exactly that, because
 * wandering is the only move left. The sample bunny is such a surface: its
 * median corner is 25 degrees from flat, so the search produced a 150-face patch
 * with 138 edges of boundary and 7 interior corners, shaped like a maze. It
 * flattens beautifully and it is not a part anybody can cut, handle or nest. So
 * the patch's perimeter is held near what a compact region of the same area
 * would have, and a patch that cannot grow outward stops instead of growing
 * sideways.
 *
 * THE CURVATURE BUDGET. What a flat pattern cannot reproduce is the curvature
 * the patch ENCLOSES, and by Gauss-Bonnet that is the sum of the angle defects
 * at its interior corners — the angle by which the island fails to close up. A
 * per-corner limit does not bound it: a closed surface carries a fixed 720
 * degrees however finely it is divided, so on a few hundred vertices every
 * single corner passes comfortably while the total runs away. Both limits are
 * therefore applied, and the sum is the one that usually binds.
 *
 * @param {{maxFoldDeg, maxDefectDeg, maxTotalDefectDeg, maxFaces,
 *          forceSeam, forceJoin, forcePatch}} opts
 *   maxFoldDeg   — an edge that bends more than this is a seam whatever else is
 *                  true. Rigid stock sets this near zero; card sets it near 180.
 *   maxDefectDeg — the allowed angle defect at any one corner inside a patch.
 *   maxTotalDefectDeg — the allowed defect summed over the patch.
 *   maxPerimeterRatio — perimeter over that of a disc of equal area. 1 is a
 *                  circle, about 1.35 a single triangle, and past roughly 2.5
 *                  the piece is a ribbon.
 */
export function segmentByCurvature(mesh, opts = {}) {
  const {
    maxFoldDeg = 25, maxDefectDeg = 8, maxTotalDefectDeg = 20,
    maxPerimeterRatio = 2.2, maxFaces = Infinity,
    forceSeam = new Set(), forceJoin = new Set(), forcePatch = null,
  } = opts;

  const vf = vertexFaces(mesh);
  const owner = new Int32Array(mesh.faceCount).fill(-1);
  const patches = [];

  // Explicit assignments are placed before anything is grown, so the heuristic
  // never gets the chance to disagree with them.
  const pinned = new Map();
  if (forcePatch) {
    for (const [f, key] of forcePatch) {
      if (!pinned.has(key)) pinned.set(key, []);
      pinned.get(key).push(f);
    }
    for (const [key, faces] of pinned) {
      for (const comp of connectedComponents(mesh, faces)) {
        const p = makePatch(mesh, patches.length, String(key), comp, comp[0], 'pinned');
        for (const f of comp) owner[f] = p.id;
        patches.push(p);
      }
    }
  }

  // An edge may be declared a seam or declared not-a-seam, and either wins. A
  // heuristic without an override meets input that names things differently and
  // has no way to be told it is wrong; guessing harder only moves the problem.
  const isSeam = (ei) => {
    if (forceJoin.has(ei)) return false;
    if (forceSeam.has(ei)) return true;
    const e = mesh.edges[ei];
    if (e.faces.length !== 2) return true;                  // rim, or non-manifold
    return Math.abs(dihedralDeg(mesh, ei)) > maxFoldDeg;
  };

  // Biggest face first. A seed in the middle of a large flat area grows a large
  // flat patch; a seed in a thicket of small triangles grows a patch shaped like
  // the thicket, and the big area gets picked over afterwards.
  const order = Array.from({ length: mesh.faceCount }, (_, f) => f)
    .sort((a, b) => mesh.areas[b] - mesh.areas[a] || a - b);

  for (const seed of order) {
    if (owner[seed] >= 0) continue;
    const me = patches.length;

    const faces = [seed];
    // Running angle sums and face counts per corner, so the developability test
    // costs three lookups per candidate however large the patch has grown.
    const sum = new Map();
    const count = new Map();
    let worstFold = 0, totalDefect = 0;
    let area = mesh.areas[seed], perimeter = facePerimeter(mesh, seed);

    const addFace = (f) => {
      const v = [mesh.tris[f * 3], mesh.tris[f * 3 + 1], mesh.tris[f * 3 + 2]];
      for (const at of v) {
        const k = vf.faces[at].indexOf(f);
        sum.set(at, (sum.get(at) || 0) + vf.angles[at][k]);
        count.set(at, (count.get(at) || 0) + 1);
      }
    };
    owner[seed] = me;
    addFace(seed);

    /**
     * May `f` join, and if so what does it do to the patch?
     * @returns {{defect, area, perimeter}|null} null to refuse.
     */
    const admit = (f) => {
      const v = [mesh.tris[f * 3], mesh.tris[f * 3 + 1], mesh.tris[f * 3 + 2]];
      // The disc rule, by Euler. sharedV must be exactly sharedE + 1.
      let sharedE = 0, sharedLen = 0;
      for (let k = 0; k < 3; k++) {
        const e = mesh.edges[mesh.faceEdges[f * 3 + k]];
        if (e.faces.some((g) => g !== f && owner[g] === me)) {
          sharedE++;
          sharedLen += edgeLength(mesh, e.a, e.b);
        }
      }
      const sharedV = v.filter((at) => (count.get(at) || 0) > 0).length;
      if (sharedV !== sharedE + 1) return null;

      // An edge that was on the boundary is now inside; the rest of the new
      // face's edges join the boundary in its place.
      const nextArea = area + mesh.areas[f];
      const nextPerim = perimeter + facePerimeter(mesh, f) - 2 * sharedLen;
      const ratio = nextPerim / (2 * Math.sqrt(Math.PI * nextArea));
      // A patch is allowed to be over the limit only while it is getting
      // better, so a seed triangle can always grow into something rounder.
      if (ratio > maxPerimeterRatio
          && ratio >= perimeter / (2 * Math.sqrt(Math.PI * area))) return null;

      let added = 0;
      for (const at of v) {
        if (vf.onBoundary[at]) continue;
        const k = vf.faces[at].indexOf(f);
        const s = (sum.get(at) || 0) + vf.angles[at][k];
        const c = (count.get(at) || 0) + 1;
        // Only once every face around the corner is in the patch is the sum
        // final and the comparison meaningful.
        if (c < vf.faces[at].length) continue;
        const d = defectAt(mesh, at, s, true);
        if (d > maxDefectDeg) return null;
        added += d;
      }
      if (totalDefect + added > maxTotalDefectDeg) return null;
      return { defect: added, area: nextArea, perimeter: nextPerim };
    };

    // A small priority queue. A face refused now may well be admissible later,
    // once a neighbour of its own has joined and the disc rule is satisfied, so
    // refusal drops it from the queue rather than from the running.
    const home = centroid(mesh, seed);
    const cost = new Map([[seed, 0]]);
    const queue = [];
    const queued = new Set();
    const push = (face, edge, from) => {
      if (owner[face] >= 0) return;
      const step = (cost.get(from) ?? 0) + Math.abs(dihedralDeg(mesh, edge) ?? 180);
      if (cost.has(face) && cost.get(face) <= step) { if (queued.has(face)) return; }
      else cost.set(face, step);
      if (queued.has(face)) return;
      const c = centroid(mesh, face);
      queue.push({ face, edge, away: Math.hypot(c[0] - home[0], c[1] - home[1], c[2] - home[2]) });
      queued.add(face);
    };
    const openFrom = (f) => {
      for (const { face, edge } of faceNeighbours(mesh, f)) if (!isSeam(edge)) push(face, edge, f);
    };
    openFrom(seed);

    while (queue.length && faces.length < maxFaces) {
      queue.sort((a, b) => (cost.get(a.face) - cost.get(b.face)) || (a.away - b.away));
      const next = queue.shift();
      queued.delete(next.face);
      if (owner[next.face] >= 0) continue;

      const step = admit(next.face);
      if (step === null) continue;

      // The patch may have grown round to touch this face over a gentler edge
      // than the one it was queued on; report the fold actually used.
      let fold = Math.abs(dihedralDeg(mesh, next.edge) ?? 180);
      for (const { face: g, edge } of faceNeighbours(mesh, next.face)) {
        if (owner[g] !== me || isSeam(edge)) continue;
        fold = Math.min(fold, Math.abs(dihedralDeg(mesh, edge) ?? 180));
      }

      owner[next.face] = me;
      faces.push(next.face);
      addFace(next.face);
      totalDefect += step.defect;
      area = step.area;
      perimeter = step.perimeter;
      worstFold = Math.max(worstFold, fold);
      openFrom(next.face);
    }

    // The defect measured over the patch as it actually ended up, rather than
    // the running total that happened to be reached while it was being grown.
    let worstDefect = 0, finalTotal = 0;
    for (const [at, s] of sum) {
      if (vf.onBoundary[at] || count.get(at) !== vf.faces[at].length) continue;
      const d = defectAt(mesh, at, s, true);
      worstDefect = Math.max(worstDefect, d);
      finalTotal += d;
    }

    const p = makePatch(mesh, me, `P${me + 1}`, faces.sort((a, b) => a - b), seed, 'curvature');
    p.worstDefectDeg = worstDefect;
    p.totalDefectDeg = finalTotal;
    p.worstFoldDeg = worstFold;
    p.perimeterRatio = perimeter / (2 * Math.sqrt(Math.PI * area));
    patches.push(p);
  }

  return patches;
}

/** The total length of a face's three edges. */
function facePerimeter(mesh, f) {
  const v = [mesh.tris[f * 3], mesh.tris[f * 3 + 1], mesh.tris[f * 3 + 2]];
  return edgeLength(mesh, v[0], v[1]) + edgeLength(mesh, v[1], v[2]) + edgeLength(mesh, v[2], v[0]);
}

/** The middle of a face, for measuring how far the growth has spread. */
function centroid(mesh, f) {
  const p = mesh.positions;
  const v = [mesh.tris[f * 3], mesh.tris[f * 3 + 1], mesh.tris[f * 3 + 2]];
  return [0, 1, 2].map((k) => (p[v[0] * 3 + k] + p[v[1] * 3 + k] + p[v[2] * 3 + k]) / 3);
}

function makePatch(mesh, id, key, faces, seed, source) {
  let area = 0;
  const n = [0, 0, 0];
  for (const f of faces) {
    area += mesh.areas[f];
    for (let k = 0; k < 3; k++) n[k] += mesh.normals[f * 3 + k] * mesh.areas[f];
  }
  const len = Math.hypot(...n) || 1;
  return {
    id,
    key,
    label: key,
    faces,
    area,
    seed,
    meanNormal: [n[0] / len, n[1] / len, n[2] / len],
    worstDefectDeg: 0,
    totalDefectDeg: 0,
    worstFoldDeg: 0,
    perimeterRatio: 0,
    source,
  };
}

/**
 * The edges a patching leaves as seams: every edge whose two faces ended up in
 * different patches, plus every edge of the original surface's own rim.
 *
 * Note what is NOT here — an edge interior to a patch is a FOLD, not a cut, and
 * on foldable stock it will be scored rather than divided. Keeping the two ideas
 * apart in one place is what stops a second module inventing its own slightly
 * different notion of a seam later on.
 */
export function seamEdges(mesh, patches) {
  const owner = new Int32Array(mesh.faceCount).fill(-1);
  for (const p of patches) for (const f of p.faces) owner[f] = p.id;
  const cuts = [];
  const folds = [];
  for (const e of mesh.edges) {
    if (e.faces.length !== 2) { cuts.push(e.id); continue; }
    if (owner[e.faces[0]] !== owner[e.faces[1]]) cuts.push(e.id);
    else folds.push(e.id);
  }
  return { cuts, folds, owner };
}

/**
 * Choose the segmentation, and say which one was used.
 *
 * Grouped input wins when it is there and asked for, because it is the user
 * stating the answer rather than the software estimating it.
 */
export function segment(mesh, opts = {}) {
  const grouped = mesh.groupNames && mesh.groupNames.length > 1;
  if (opts.useGroups !== false && grouped) {
    const patches = segmentByGroups(mesh);
    return { patches, method: 'groups', note: `from ${mesh.groupNames.length} groups in the file` };
  }
  const patches = segmentByCurvature(mesh, opts);
  return {
    patches,
    method: 'curvature',
    note: `region growing, fold limit ${opts.maxFoldDeg ?? 25}°, `
      + `defect limit ${opts.maxDefectDeg ?? 8}° per corner and ${opts.maxTotalDefectDeg ?? 20}° per patch`,
  };
}
