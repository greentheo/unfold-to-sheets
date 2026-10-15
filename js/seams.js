// Marking the cuts so the thing can be put back together.
//
// A pile of correctly-shaped pieces is not a kit. Every cut edge gets a token,
// BOTH SIDES OF THE CUT CARRY THE SAME TOKEN, and that is the whole point: it is
// what turns the output from a set of shapes into something assemblable.
//
// The token is derived from the stable edge ID assigned when the mesh was
// loaded, which is the only reason this works at all. By the time the pieces
// exist they share no data structure — they have been segmented apart, cut apart
// and nested onto different sheets — but they still refer to the same numbered
// edge, so both can be given the same name without either knowing about the
// other.
//
// The fold angle comes along for free. It is the dihedral angle across the edge,
// which is known exactly from the model, and it is the number that otherwise
// gets measured off a half-built object with a bevel gauge.

/**
 * Tokens, in a fixed and readable alphabet.
 *
 * Two letters' worth before it has to grow, which covers a couple of thousand
 * seams. `I` and `O` are left out: on a cut edge, in pencil, they are 1 and 0.
 */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Below this an interior edge is triangulation, not a crease. */
const CREASE_DEG = 0.5;
export function tokenFor(index) {
  const per = 99;
  const letter = Math.floor(index / per);
  const num = (index % per) + 1;
  const name = letter < LETTERS.length
    ? LETTERS[letter]
    : LETTERS[Math.floor(letter / LETTERS.length) - 1] + LETTERS[letter % LETTERS.length];
  return `${name}${String(num).padStart(2, '0')}`;
}

/**
 * Work out every seam in a finished set of pieces, and name it.
 *
 * A seam is an edge whose two faces ended up in different pieces, or an edge of
 * the original surface's own rim. An edge INSIDE a piece is a fold, not a seam,
 * and on foldable stock it is scored rather than divided — the two ideas are
 * kept apart here, in one place, so that a second module cannot invent its own
 * slightly different notion of a seam and drift away from this one.
 *
 * @param {Mesh} mesh
 * @param {Array} pieces from splitToFit
 * @returns {{seams, byPiece, folds, openEdges, stats}}
 */
export function markSeams(mesh, pieces) {
  const owner = new Int32Array(mesh.faceCount).fill(-1);
  pieces.forEach((p, i) => { for (const f of p.patch.faces) owner[f] = i; });

  // Sorted by the stable edge ID so tokens are deterministic: the same model
  // gives the same names every run, and a drawing printed yesterday still
  // matches the one printed today.
  const cutEdges = [];
  const openEdges = [];
  for (const e of mesh.edges) {
    if (e.faces.length === 1) { openEdges.push(e.id); continue; }
    if (e.faces.length !== 2) { openEdges.push(e.id); continue; }
    const [f0, f1] = e.faces;
    if (owner[f0] < 0 || owner[f1] < 0) continue;              // face was dropped
    if (owner[f0] !== owner[f1]) cutEdges.push(e.id);
  }
  cutEdges.sort((a, b) => a - b);

  const seams = new Map();
  cutEdges.forEach((ei, i) => {
    const e = mesh.edges[ei];
    seams.set(ei, {
      edge: ei,
      token: tokenFor(i),
      pieces: [owner[e.faces[0]], owner[e.faces[1]]],
      foldDeg: dihedral(mesh, ei),
      length: len3(mesh, e.a, e.b),
    });
  });

  // Where each token has to be written, on each piece, in that piece's own flat
  // coordinates. Both entries for one token are produced from the same edge, so
  // they cannot drift apart.
  const byPiece = pieces.map(() => []);
  for (const [ei, seam] of seams) {
    const e = mesh.edges[ei];
    for (const pi of new Set(seam.pieces)) {
      if (pi < 0) continue;
      const flat = pieces[pi].flat;
      const A = flat.xy.get(e.a), B = flat.xy.get(e.b);
      if (!A || !B) continue;
      byPiece[pi].push({
        token: seam.token,
        edge: ei,
        a: A,
        b: B,
        mid: { u: (A.u + B.u) / 2, v: (A.v + B.v) / 2 },
        // Which way is into the piece: away from the neighbour it joins.
        inward: inwardNormal(mesh, flat, ei, pieces[pi]),
        foldDeg: seam.foldDeg,
        length: seam.length,
        joinsPiece: seam.pieces.find((x) => x !== pi) ?? pi,
      });
    }
  }

  // Fold lines: interior to a piece, scored rather than cut.
  //
  // Only the ones that are actually creases. Every interior edge of a piece is
  // in this list, and most of them are the diagonals the triangulation put
  // across a flat quad — drawing those would invite someone to cut along them,
  // and counting them would tell a user a flat plate has folds in it.
  const folds = pieces.map((p) => p.flat.folds.map((f) => ({ ...f })));
  const creases = folds.map((list) => list.filter((f) => Math.abs(f.angleDeg ?? 0) >= CREASE_DEG));

  return {
    seams,
    byPiece,
    folds,
    creases,
    openEdges,
    stats: {
      seamCount: seams.size,
      foldCount: creases.reduce((s, f) => s + f.length, 0),
      interiorEdges: folds.reduce((s, f) => s + f.length, 0),
      openEdges: openEdges.length,
      totalSeamLength: [...seams.values()].reduce((s, x) => s + x.length, 0),
    },
  };
}

/**
 * The direction "into the material" from a seam.
 *
 * A token written on the far side of its own cut line is in the offcut, and you
 * find that out after the part is cut, which is the one time it cannot be
 * fixed. The perpendicular is easy; which of the two perpendiculars is the
 * inside is the part worth computing, and the piece's own third corner answers
 * it.
 */
function inwardNormal(mesh, flat, ei, piece) {
  const e = mesh.edges[ei];
  const A = flat.xy.get(e.a), B = flat.xy.get(e.b);
  const du = B.u - A.u, dv = B.v - A.v;
  const d = Math.hypot(du, dv) || 1;
  const n = { u: -dv / d, v: du / d };
  const f = e.faces.find((x) => piece.patch.faces.includes(x));
  if (f === undefined) return n;
  const far = [mesh.tris[f * 3], mesh.tris[f * 3 + 1], mesh.tris[f * 3 + 2]]
    .find((x) => x !== e.a && x !== e.b);
  const P = flat.xy.get(far);
  if (!P) return n;
  const side = (P.u - A.u) * n.u + (P.v - A.v) * n.v;
  return side >= 0 ? n : { u: -n.u, v: -n.v };
}

function dihedral(mesh, ei) {
  const e = mesh.edges[ei];
  if (e.faces.length !== 2) return null;
  const [f0, f1] = e.faces;
  let c = 0;
  for (let k = 0; k < 3; k++) c += mesh.normals[f0 * 3 + k] * mesh.normals[f1 * 3 + k];
  const a = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  const p = mesh.positions;
  const far = [mesh.tris[f1 * 3], mesh.tris[f1 * 3 + 1], mesh.tris[f1 * 3 + 2]]
    .find((x) => x !== e.a && x !== e.b);
  let d = 0;
  for (let k = 0; k < 3; k++) d += mesh.normals[f0 * 3 + k] * (p[far * 3 + k] - p[e.a * 3 + k]);
  return d < 0 ? a : -a;
}

const len3 = (mesh, a, b) => {
  const p = mesh.positions;
  return Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
};

/**
 * The invariant that makes the output assemblable: every token appears exactly
 * twice, once on each side of its cut. Checked rather than assumed, because the
 * failure is silent and only shows up with the glue open.
 */
export function checkTokens(byPiece) {
  const count = new Map();
  for (const list of byPiece) {
    for (const m of list) count.set(m.token, (count.get(m.token) || 0) + 1);
  }
  const wrong = [...count.entries()].filter(([, n]) => n !== 2);
  return { ok: wrong.length === 0, wrong, tokens: count.size };
}
