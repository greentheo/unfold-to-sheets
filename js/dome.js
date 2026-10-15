// A geodesic dome, with a door and windows cut in it.
//
// Built to be a realistic test of the whole pipeline rather than a pretty shape:
// a dome is the case this tool is actually for. Its facets are flat triangles,
// which is what sheet stock wants; it is a surface with real openings, which
// means an OPEN mesh with several boundary loops rather than a tidy closed one;
// and it is big enough that the sheet, not the model, decides how it comes apart.
//
// WHY GEODESIC RATHER THAN LATITUDE AND LONGITUDE. A lat-long dome has panels
// that shrink to nothing at the crown and a ring of long thin slivers at the
// base. A geodesic one has panels that are all within a few per cent of each
// other, which is the difference between a nesting problem and a nesting
// nightmare — and it is why actual dome homes are built this way.
//
// WHY THE FREQUENCY MUST BE EVEN. The icosahedron has no ring of vertices on its
// equator, so an odd-frequency subdivision cannot be cut in half without leaving
// a zigzag base that no floor will ever meet. Even frequencies put subdivision
// points exactly on the equator — the edges spanning the two pentagon bands have
// their midpoints at z = 0 — so the dome sits flat on the ground.

import { buildMesh } from './mesh.js';

const norm = (p) => {
  const n = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / n, p[1] / n, p[2] / n];
};

/** The 12 vertices and 20 faces of an icosahedron, poles up and down. */
function icosahedron() {
  const lat = Math.atan(0.5);                       // 26.565 degrees
  const c = Math.cos(lat), s = Math.sin(lat);
  const v = [[0, 0, 1]];
  for (let i = 0; i < 5; i++) {
    const a = (i * 72 * Math.PI) / 180;
    v.push([c * Math.cos(a), c * Math.sin(a), s]);
  }
  for (let i = 0; i < 5; i++) {
    const a = ((36 + i * 72) * Math.PI) / 180;
    v.push([c * Math.cos(a), c * Math.sin(a), -s]);
  }
  v.push([0, 0, -1]);

  const up = (i) => 1 + (i % 5);
  const lo = (i) => 6 + (i % 5);
  const f = [];
  for (let i = 0; i < 5; i++) {
    f.push([0, up(i), up(i + 1)]);
    f.push([up(i), lo(i), up(i + 1)]);
    f.push([lo(i), lo(i + 1), up(i + 1)]);
    f.push([11, lo(i + 1), lo(i)]);
  }
  return { v, f };
}

/** Subdivide a triangle into f^2 triangles and push them onto the sphere. */
function subdivide(A, B, C, f, out) {
  const grid = [];
  for (let i = 0; i <= f; i++) {
    grid.push([]);
    for (let j = 0; j <= f - i; j++) {
      const k = f - i - j;
      grid[i].push(norm([
        (A[0] * k + B[0] * i + C[0] * j) / f,
        (A[1] * k + B[1] * i + C[1] * j) / f,
        (A[2] * k + B[2] * i + C[2] * j) / f,
      ]));
    }
  }
  for (let i = 0; i < f; i++) {
    for (let j = 0; j < f - i; j++) {
      out.push([grid[i][j], grid[i + 1][j], grid[i][j + 1]]);
      if (i + j < f - 1) out.push([grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
    }
  }
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Is this face inside an opening?
 *
 * The width is a real horizontal distance rather than an angle, because a door
 * is 1.1 m wide wherever it is on the dome. That distance covers a wider angle
 * higher up, where the dome has narrowed — which is exactly what an opening cut
 * into a curved wall does, and it keeps the sides of the doorway vertical.
 */
function inOpening(centroid, radius, o) {
  const z = centroid[2];
  if (z < o.bottom - 1e-9 || z > o.top + 1e-9) return false;
  const rh = Math.hypot(centroid[0], centroid[1]);
  if (rh < 1e-9) return false;
  const half = Math.asin(Math.min(1, (o.width / 2) / rh));
  const az = Math.atan2(centroid[1], centroid[0]);
  let d = az - (o.azimuth * Math.PI) / 180;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d) <= half;
}

/**
 * @param {{radius, frequency, openings, units, name}} opts
 * @returns {Mesh} an open surface: the dome shell, with holes.
 */
export function domeMesh(opts = {}) {
  const {
    radius = 3, frequency = 4, openings = [], units = 'm', name = 'dome',
  } = opts;
  if (frequency % 2 !== 0) {
    throw new Error(`frequency must be even so the dome has a flat base (got ${frequency})`);
  }

  const ico = icosahedron();
  const tris = [];
  for (const [a, b, c] of ico.f) subdivide(ico.v[a], ico.v[b], ico.v[c], frequency, tris);

  const positions = [];
  const faces = [];
  const removed = { door: 0, window: 0 };
  for (const t of tris) {
    const p = t.map((q) => [q[0] * radius, q[1] * radius, q[2] * radius]);
    const centroid = [0, 1, 2].map((k) => (p[0][k] + p[1][k] + p[2][k]) / 3);
    if (centroid[2] <= 1e-9) continue;                       // lower half

    const hit = openings.find((o) => inOpening(centroid, radius, o));
    if (hit) { removed[hit.kind || 'window'] = (removed[hit.kind || 'window'] || 0) + 1; continue; }

    // Wound so the normal points away from the middle of the dome — outward, so
    // every fold angle downstream has the sign a builder expects.
    const n = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    const ordered = dot(n, centroid) >= 0 ? p : [p[0], p[2], p[1]];
    const base = positions.length / 3;
    for (const q of ordered) positions.push(q[0], q[1], q[2]);
    faces.push(base, base + 1, base + 2);
  }

  const mesh = buildMesh(
    { positions, tris: faces, groups: faces.map(() => 0), source: 'dome' },
    { units, name },
  );
  mesh.dome = { radius, frequency, openings, removed, panels: faces.length / 3 };
  return mesh;
}

/**
 * A dome you could stand up in, with a door and three windows.
 *
 * Sized as a small shelter rather than as a demonstration: 3 m radius is a 6 m
 * span and 3 m of headroom at the middle, which is a room. The door is a real
 * 1.1 x 2.05 m doorway; the windows are at eye height.
 */
export function iglooPreset(radius = 3) {
  const k = radius / 3;
  return {
    radius,
    frequency: 4,
    units: 'm',
    name: `dome-${(radius * 2).toFixed(1)}m`,
    openings: [
      { kind: 'door', name: 'door', azimuth: 0, width: 1.1 * k, bottom: -1, top: 2.05 * k },
      { kind: 'window', name: 'window E', azimuth: 90, width: 0.9 * k, bottom: 1.15 * k, top: 1.95 * k },
      { kind: 'window', name: 'window W', azimuth: 200, width: 0.9 * k, bottom: 1.15 * k, top: 1.95 * k },
      { kind: 'window', name: 'window N', azimuth: 145, width: 0.9 * k, bottom: 1.15 * k, top: 1.95 * k },
    ],
  };
}

/** The dome as an OBJ, so it can be saved, opened elsewhere, or re-imported. */
export function meshToOBJ(mesh, comment = '') {
  const L = [];
  if (comment) for (const line of comment.split('\n')) L.push(`# ${line}`);
  L.push(`# ${mesh.stats.triangles} triangles, units: ${mesh.units || 'unstated'}`);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    L.push(`v ${fmt(mesh.positions[i])} ${fmt(mesh.positions[i + 1])} ${fmt(mesh.positions[i + 2])}`);
  }
  L.push('g shell');
  for (let f = 0; f < mesh.faceCount; f++) {
    L.push(`f ${mesh.tris[f * 3] + 1} ${mesh.tris[f * 3 + 1] + 1} ${mesh.tris[f * 3 + 2] + 1}`);
  }
  return `${L.join('\n')}\n`;
}

// Enough digits that a metre-scale model survives the round trip. Six decimals
// is a micron in millimetres and a micron is fine; in METRES it is a micron
// times a thousand, and the shell area comes back different.
const fmt = (v) => (Math.abs(v) < 1e-12 ? '0' : Number(v.toPrecision(12)));

/** What the dome is, in the numbers a builder asks for first. */
export function domeReport(mesh) {
  const d = mesh.dome;
  const edges = [];
  for (const e of mesh.edges) {
    const p = mesh.positions;
    edges.push(Math.hypot(p[e.a * 3] - p[e.b * 3], p[e.a * 3 + 1] - p[e.b * 3 + 1], p[e.a * 3 + 2] - p[e.b * 3 + 2]));
  }
  edges.sort((a, b) => a - b);
  return {
    span: d.radius * 2,
    height: d.radius,
    panels: mesh.faceCount,
    frequency: d.frequency,
    floorArea: Math.PI * d.radius ** 2,
    shellArea: mesh.stats.surfaceArea,
    strutMin: edges[0],
    strutMax: edges[edges.length - 1],
    strutMedian: edges[Math.floor(edges.length / 2)],
    openings: d.openings.map((o) => o.name || o.kind),
    removed: d.removed,
    openEdges: mesh.stats.boundaryEdges,
  };
}
