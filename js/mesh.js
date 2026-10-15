// Getting a mesh in, and getting it into a state the rest of the pipeline can
// rely on.
//
// Everything downstream assumes three things that a file off a CAD package or a
// 3D printer slicer routinely does NOT provide: that vertices which look shared
// really are shared, that every edge knows both faces that use it, and that an
// edge can be named the same way at the end of the pipeline as it was at the
// start. The last of those is the one that cannot be retrofitted, so it is done
// here and nowhere else.
//
// UNITS. An STL file does not say what its numbers mean. It is not 3 mm or 3
// inches, it is 3. Guessing produces a bunny either the size of a thumb or the
// size of a shed, and the mistake is invisible until the material is cut. So
// `units` is whatever the caller says it is, `null` until then, and it is
// printed on every output.

/** The tolerance below which two vertices are the same vertex, as a fraction
 *  of the bounding box diagonal. STL from CAD is routinely unwelded, and the
 *  duplicates are exact or near enough that this is generous. */
const WELD_FRACTION = 1e-6;

// ─── file formats ──────────────────────────────────────────────────────────

/**
 * Is this buffer a binary STL?
 *
 * The advertised test is "does it start with `solid`", which is wrong often
 * enough to matter: plenty of binary writers put a product name in the 80-byte
 * header and some of them start it with the word solid. The reliable test is
 * arithmetic — a binary STL is exactly 84 + 50n bytes for the triangle count it
 * declares — so that is what is used, with the keyword only as a tie-break.
 */
export function isBinarySTL(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 84) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(80, true);
  if (bytes.length === 84 + n * 50) return true;
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 5)).toLowerCase();
  return head !== 'solid';
}

/** @returns {{positions: number[], tris: number[], groups: number[], source: string}} raw, unwelded */
export function parseSTL(buf) {
  if (typeof buf === 'string') return parseAsciiSTL(buf);
  return isBinarySTL(buf) ? parseBinarySTL(buf)
                          : parseAsciiSTL(new TextDecoder().decode(new Uint8Array(buf)));
}

function parseBinarySTL(buf) {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(80, true);
  if (bytes.length < 84 + n * 50) {
    throw new Error(`binary STL declares ${n} triangles but is only ${bytes.length} bytes`);
  }
  const positions = [];
  const tris = [];
  const groups = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;                   // skip the stored facet normal
    const base = positions.length / 3;
    for (let k = 0; k < 9; k++) positions.push(dv.getFloat32(o + k * 4, true));
    tris.push(base, base + 1, base + 2);
    groups.push(0);
  }
  return { positions, tris, groups, source: 'stl-binary' };
}

function parseAsciiSTL(text) {
  const positions = [];
  const tris = [];
  const groups = [];
  // One pass over the vertex lines. `facet`/`endloop` carry no information the
  // vertex order does not already carry, so they are not parsed.
  const nums = [];
  for (const m of text.matchAll(/^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)/gmi)) {
    nums.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if (nums.length % 9 !== 0) {
    throw new Error(`ASCII STL has ${nums.length / 3} vertices, not a whole number of triangles`);
  }
  for (let i = 0; i < nums.length; i += 9) {
    const base = positions.length / 3;
    for (let k = 0; k < 9; k++) positions.push(nums[i + k]);
    tris.push(base, base + 1, base + 2);
    groups.push(0);
  }
  return { positions, tris, groups, source: 'stl-ascii' };
}

/**
 * OBJ, which unlike STL can say which faces belong together.
 *
 * That matters more than it looks: `g`/`o`/`usemtl` is the authored-seam input
 * format the whole segmentation problem can often be sidestepped with. A model
 * made to be built already knows where it comes apart, and reading that is
 * better than any amount of guessing at it. See segment.js.
 */
export function parseOBJ(text) {
  const positions = [];
  const tris = [];
  const groups = [];
  const groupNames = [];
  let current = -1;

  const nameToId = new Map();
  const useGroup = (name) => {
    if (!nameToId.has(name)) { nameToId.set(name, groupNames.length); groupNames.push(name); }
    current = nameToId.get(name);
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();

    if (key === 'v') {
      const p = rest.split(/\s+/).map(Number);
      positions.push(p[0], p[1], p[2]);
    } else if (key === 'g' || key === 'o' || key === 'usemtl') {
      useGroup(rest || key);
    } else if (key === 'f') {
      // "1", "1/2", "1//3", "1/2/3" — only the position index is wanted here.
      const idx = rest.split(/\s+/).map((tok) => {
        const v = parseInt(tok.split('/')[0], 10);
        return v > 0 ? v - 1 : positions.length / 3 + v;      // negative = relative
      });
      if (current < 0) useGroup('default');
      // Fan-triangulate. A quad from a modeller is planar often enough that the
      // fan is right, and where it is not, segmentation sees two triangles that
      // agree and keeps them together anyway.
      for (let k = 2; k < idx.length; k++) {
        tris.push(idx[0], idx[k - 1], idx[k]);
        groups.push(current);
      }
    }
  }
  return { positions, tris, groups, groupNames, source: 'obj' };
}

/** Dispatch on the file name, falling back to sniffing the content. */
export function parseModel(nameOrBuf, maybeBuf) {
  const name = typeof nameOrBuf === 'string' && maybeBuf !== undefined ? nameOrBuf : '';
  const buf = maybeBuf !== undefined ? maybeBuf : nameOrBuf;
  if (/\.obj$/i.test(name)) {
    return parseOBJ(typeof buf === 'string' ? buf : new TextDecoder().decode(new Uint8Array(buf)));
  }
  if (/\.stl$/i.test(name)) return parseSTL(buf);
  if (typeof buf === 'string' && /^\s*(v|vn|vt|f|g|o|mtllib)\s/m.test(buf)) return parseOBJ(buf);
  return parseSTL(buf);
}

// ─── welding ───────────────────────────────────────────────────────────────

/**
 * Merge vertices that are the same point.
 *
 * A hash grid rather than an O(n^2) sweep, and every one of the 27 neighbouring
 * cells is searched rather than just the home cell. Two points a nanometre
 * apart can still land either side of a cell boundary, and a weld that misses
 * those leaves a crack the manifold test then reports as a hole — a confusing
 * way to be told the tolerance was applied to a grid instead of to a distance.
 */
export function weldVertices(positions, tolerance) {
  const n = positions.length / 3;
  const cell = Math.max(tolerance, 1e-12) * 2;
  const buckets = new Map();
  const remap = new Int32Array(n);
  const out = [];
  const tol2 = tolerance * tolerance;

  const key = (a, b, c) => `${a},${b},${c}`;

  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const list = buckets.get(key(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const j of list) {
            const ddx = out[j * 3] - x, ddy = out[j * 3 + 1] - y, ddz = out[j * 3 + 2] - z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= tol2) { found = j; break; }
          }
        }
      }
    }
    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      const k = key(cx, cy, cz);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(found);
    }
    remap[i] = found;
  }
  return { positions: out, remap };
}

// ─── the mesh ──────────────────────────────────────────────────────────────

const sub = (p, a, b) => [p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]];
const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
export const dot3 = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
export const norm3 = (u) => Math.hypot(u[0], u[1], u[2]);

/** Distance between two welded vertex indices. This is THE length the flat
 *  pattern has to reproduce, so everything measures it the same way. */
export function edgeLength(mesh, a, b) {
  const p = mesh.positions;
  return Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
}

/**
 * Build the connected mesh everything else runs on.
 *
 * @param {{positions, tris, groups?}} raw
 * @param {{units?: string|null, weld?: number, name?: string}} opts
 * @returns {Mesh}
 */
export function buildMesh(raw, opts = {}) {
  const bboxRaw = bounds(raw.positions);
  const diag = Math.hypot(...bboxRaw.size);
  const tolerance = opts.weld ?? Math.max(diag * WELD_FRACTION, 1e-9);

  const { positions, remap } = weldVertices(raw.positions, tolerance);

  // Degenerate triangles — zero area, or two corners welded into one — break
  // every normal and every unfold that touches them. They are dropped, and
  // COUNTED, because "292 triangles in, 289 used" is a sentence the user needs
  // to see rather than a discrepancy for them to find later.
  const tris = [];
  const groups = [];
  const degenerate = [];
  for (let f = 0; f * 3 < raw.tris.length; f++) {
    const a = remap[raw.tris[f * 3]], b = remap[raw.tris[f * 3 + 1]], c = remap[raw.tris[f * 3 + 2]];
    if (a === b || b === c || a === c) { degenerate.push({ face: f, why: 'repeated vertex' }); continue; }
    const area = norm3(cross(sub(positions, b, a), sub(positions, c, a))) / 2;
    if (!(area > tolerance * tolerance)) { degenerate.push({ face: f, why: 'zero area' }); continue; }
    tris.push(a, b, c);
    groups.push(raw.groups ? raw.groups[f] : 0);
  }

  const faceCount = tris.length / 3;

  // ── the edge table, and the stable IDs ──
  //
  // Assigned HERE, once, in the order the faces arrive, and never reassigned.
  // Segmentation, splitting and seam marking all refer to an edge by this
  // number, which is the only reason both halves of a cut can be given the same
  // token: the two pieces no longer share a data structure, but they still
  // share the number.
  const edges = [];
  const edgeOf = new Map();
  const faceEdges = new Int32Array(faceCount * 3);

  for (let f = 0; f < faceCount; f++) {
    const v = [tris[f * 3], tris[f * 3 + 1], tris[f * 3 + 2]];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = lo * 4294967296 + hi;
      let ei = edgeOf.get(key);
      if (ei === undefined) {
        ei = edges.length;
        edges.push({ id: ei, a: lo, b: hi, faces: [], dirs: [] });
        edgeOf.set(key, ei);
      }
      edges[ei].faces.push(f);
      edges[ei].dirs.push(a === lo ? 1 : -1);      // which way this face walks it
      faceEdges[f * 3 + k] = ei;
    }
  }

  // ── face normals and areas ──
  const normals = new Float64Array(faceCount * 3);
  const areas = new Float64Array(faceCount);
  for (let f = 0; f < faceCount; f++) {
    const a = tris[f * 3], b = tris[f * 3 + 1], c = tris[f * 3 + 2];
    const n = cross(sub(positions, b, a), sub(positions, c, a));
    const len = norm3(n);
    areas[f] = len / 2;
    normals[f * 3] = n[0] / len; normals[f * 3 + 1] = n[1] / len; normals[f * 3 + 2] = n[2] / len;
  }

  // ── what kind of mesh is this, really ──
  let boundaryEdges = 0, nonManifoldEdges = 0, flippedEdges = 0;
  for (const e of edges) {
    if (e.faces.length === 1) boundaryEdges++;
    else if (e.faces.length !== 2) nonManifoldEdges++;
    // Two faces sharing an edge and walking it the SAME way are wound
    // inconsistently. Dihedral angles come out with the wrong sign, so mountain
    // folds are reported as valleys and the model assembles inside out.
    else if (e.dirs[0] === e.dirs[1]) flippedEdges++;
  }

  // ── which way is out? ──
  //
  // Every fold sign in this program — mountain or valley — is read off the face
  // normals, and those are computed from the winding. A CLOSED model wound inside
  // out gives normals pointing into the solid, and then every mountain on the
  // printout is really a valley. That is a silent error: the pattern still cuts,
  // still nests, still assembles, just inside out, and the first evidence is a
  // finished shell with the seam tape on the wrong face.
  //
  // The divergence theorem settles it for a closed surface, for the price of one
  // pass, and it is exact. Taken about the centre of the box rather than the
  // origin so a model far from zero is still measured against its own bulk.
  //
  // AN OPEN SURFACE IS A DIFFERENT QUESTION AND IT HAS NO GEOMETRIC ANSWER. A
  // dome with its normals out and a bowl with its normals in are the same
  // triangles in the same places; only the winding says which the author meant.
  // Measuring the bulk anyway gets a dish confidently and wrongly labelled
  // inside out, and then the correction — which exists to fix a reversed model —
  // reverses a correct one instead. So an open surface is taken as wound, and
  // says so.
  const bboxAll = bounds(positions);
  const mid = [
    (bboxAll.lo[0] + bboxAll.hi[0]) / 2,
    (bboxAll.lo[1] + bboxAll.hi[1]) / 2,
    (bboxAll.lo[2] + bboxAll.hi[2]) / 2,
  ];
  let signedVolume = 0;
  for (let f = 0; f < faceCount; f++) {
    const v = [tris[f * 3], tris[f * 3 + 1], tris[f * 3 + 2]].map((i) => [
      positions[i * 3] - mid[0], positions[i * 3 + 1] - mid[1], positions[i * 3 + 2] - mid[2],
    ]);
    signedVolume += dot3(v[0], cross(v[1], v[2])) / 6;
  }
  const totalArea = areas.reduce((s2, a) => s2 + a, 0);
  const diagAll = Math.hypot(...bboxAll.size);
  // Dimensionless: a sphere scores 1/6 whatever its radius, a flat plate ~0.
  const bulk = totalArea * diagAll > 0 ? signedVolume / (totalArea * diagAll) : 0;
  const ORIENTATION_FLOOR = 0.02;
  const sealed = nonManifoldEdges === 0 && boundaryEdges === 0;
  const orientation = flippedEdges > 0 ? 'inconsistent'
    : !sealed ? 'as-wound'
      : bulk > ORIENTATION_FLOOR ? 'outward'
        : bulk < -ORIENTATION_FLOOR ? 'inward' : 'unknown';

  const mesh = {
    name: opts.name || 'model',
    units: opts.units ?? null,
    source: raw.source || 'unknown',
    positions,
    tris,
    groups,
    groupNames: raw.groupNames || null,
    faceCount,
    edges,
    edgeOf,
    faceEdges,
    normals,
    areas,
    bbox: bboxAll,
    stats: {
      trianglesIn: raw.tris.length / 3,
      triangles: faceCount,
      vertices: positions.length / 3,
      vertexesMerged: raw.positions.length / 3 - positions.length / 3,
      degenerate,
      edges: edges.length,
      boundaryEdges,
      nonManifoldEdges,
      flippedEdges,
      weldTolerance: tolerance,
      manifold: nonManifoldEdges === 0,
      closed: nonManifoldEdges === 0 && boundaryEdges === 0,
      consistentWinding: flippedEdges === 0,
      surfaceArea: totalArea,
      signedVolume,
      orientation,
    },
  };
  return mesh;
}

/** The two faces on an edge, or one and -1 at a boundary. */
export function edgeFaces(mesh, ei) {
  const e = mesh.edges[ei];
  return [e.faces[0], e.faces.length > 1 ? e.faces[1] : -1];
}

/**
 * The angle the surface turns through across an edge, in degrees.
 *
 * 0 means the two faces are coplanar; 180 means the surface folds back flat on
 * itself. The SIGN says which way: positive is convex (a mountain fold, seen
 * from outside), negative concave (a valley). That sign is the number you
 * otherwise get by half-assembling the thing and holding it up to the light,
 * and it costs nothing to emit here.
 */
export function dihedralDeg(mesh, ei) {
  const e = mesh.edges[ei];
  if (e.faces.length !== 2) return null;
  const [f0, f1] = e.faces;
  const n0 = [mesh.normals[f0 * 3], mesh.normals[f0 * 3 + 1], mesh.normals[f0 * 3 + 2]];
  const n1 = [mesh.normals[f1 * 3], mesh.normals[f1 * 3 + 1], mesh.normals[f1 * 3 + 2]];
  const c = Math.max(-1, Math.min(1, dot3(n0, n1)));
  const angle = (Math.acos(c) * 180) / Math.PI;
  // Convex or concave: does the far corner of face 1 lie in front of face 0's
  // plane or behind it?
  const far = thirdVertex(mesh, f1, e.a, e.b);
  const d = dot3(n0, sub(mesh.positions, far, e.a));
  return d < 0 ? angle : -angle;
}

/**
 * Mountain or valley, decided in one place.
 *
 * `dihedralDeg` gives the sign relative to the face normals; this turns that
 * into the word that goes on the printout, which is a different question,
 * because the printout is a physical side of a physical sheet.
 *
 * The flat pattern is laid down preserving winding, so a face that runs
 * counter-clockwise in 3D seen from its normal also runs counter-clockwise on
 * the sheet: THE MARKED FACE OF THE SHEET IS THE OUTSIDE OF THE MODEL. A convex
 * edge is then a ridge coming towards the reader with the flanks falling away —
 * a mountain — and a concave one a valley.
 *
 * Only a closed model wound inside out swaps the two, and only that case is
 * corrected here. On an open surface the winding is the only evidence there is
 * (see the orientation note in buildMesh), so it is believed.
 *
 * @param {Mesh} mesh
 * @param {number|null} angleDeg  signed dihedral, from dihedralDeg
 * @returns {'mountain'|'valley'|null}
 */
export function foldSense(mesh, angleDeg) {
  if (angleDeg == null || !Number.isFinite(angleDeg)) return null;
  const flip = mesh?.stats?.orientation === 'inward' ? -1 : 1;
  return angleDeg * flip >= 0 ? 'mountain' : 'valley';
}

/** The corner of face `f` that is not `a` or `b`. */
export function thirdVertex(mesh, f, a, b) {
  const v = [mesh.tris[f * 3], mesh.tris[f * 3 + 1], mesh.tris[f * 3 + 2]];
  return v.find((x) => x !== a && x !== b);
}

/** Faces sharing an edge with `f`, and the edge each is over. */
export function faceNeighbours(mesh, f) {
  const out = [];
  for (let k = 0; k < 3; k++) {
    const ei = mesh.faceEdges[f * 3 + k];
    for (const g of mesh.edges[ei].faces) if (g !== f) out.push({ face: g, edge: ei });
  }
  return out;
}

export function bounds(positions) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < lo[k]) lo[k] = positions[i + k];
      if (positions[i + k] > hi[k]) hi[k] = positions[i + k];
    }
  }
  if (!positions.length) return { lo: [0, 0, 0], hi: [0, 0, 0], size: [0, 0, 0] };
  return { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

/**
 * The name of a child edge, for the day the splitter has to cut ACROSS an edge
 * rather than along one.
 *
 * It does not today — split.js partitions faces, so every cut runs along edges
 * that already exist and every seam keeps a whole original ID. This is here so
 * that when subdivision arrives the naming convention is already fixed and the
 * two halves of `17` are `17.0` and `17.1` rather than two fresh numbers with
 * no relation to each other or to the seam token already printed.
 */
export const childEdgeId = (parent, index) => `${parent}.${index}`;

/** A short human name for a dimension, for the sweep's "size" column. */
export const AXES = ['x', 'y', 'z'];

/** The stated dimension of the model, used as "size" in the scale sweep. */
export function modelSize(mesh, axis = 'longest') {
  const s = mesh.bbox.size;
  if (axis === 'longest') return Math.max(...s);
  if (axis === 'diagonal') return Math.hypot(...s);
  const i = AXES.indexOf(axis);
  return i >= 0 ? s[i] : Math.max(...s);
}

/**
 * Faces around each vertex, and the interior angle each one contributes there.
 *
 * Wanted for the developability test in segment.js, which is a statement about
 * vertices rather than about faces: a patch flattens exactly when the angles
 * meeting at each of its interior corners add to a full turn.
 */
export function vertexFaces(mesh) {
  if (mesh._vertexFaces) return mesh._vertexFaces;
  const n = mesh.positions.length / 3;
  const faces = Array.from({ length: n }, () => []);
  const angles = Array.from({ length: n }, () => []);
  for (let f = 0; f < mesh.faceCount; f++) {
    const v = [mesh.tris[f * 3], mesh.tris[f * 3 + 1], mesh.tris[f * 3 + 2]];
    for (let k = 0; k < 3; k++) {
      const at = v[k], p = v[(k + 1) % 3], q = v[(k + 2) % 3];
      const u1 = sub(mesh.positions, p, at), u2 = sub(mesh.positions, q, at);
      const c = dot3(u1, u2) / (norm3(u1) * norm3(u2));
      faces[at].push(f);
      angles[at].push(Math.acos(Math.max(-1, Math.min(1, c))));
    }
  }
  // A vertex on the rim of an open surface has no full turn to compare against,
  // so it is exempt from the test rather than failing it.
  const onBoundary = new Uint8Array(n);
  for (const e of mesh.edges) {
    if (e.faces.length === 1) { onBoundary[e.a] = 1; onBoundary[e.b] = 1; }
  }
  mesh._vertexFaces = { faces, angles, onBoundary };
  return mesh._vertexFaces;
}
