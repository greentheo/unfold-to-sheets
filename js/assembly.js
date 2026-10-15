// The document that says what any of it IS.
//
// A cut list says what to make. It does not say what the pieces are, which one
// goes where, or which way round. In the lofting project the shaded assembly
// drawing — the pieces coloured onto a view of the whole object — was the single
// most appreciated output, and it is the one thing that turns a stack of
// correctly-cut shapes into something a person can actually build.
//
// Two halves:
//
//   THE SEAM LIST. Every token, the two pieces it joins, its length, and the
//   angle the surface turns through there. That last number falls straight out
//   of the model and is otherwise obtained by holding a bevel gauge against a
//   half-built object.
//
//   THE SHADED VIEW. The model drawn from a few directions with each piece in
//   its own colour and named where it is big enough to name. No projection is
//   flattering to every part of a shape, so several are drawn rather than one.

import { foldSense } from './mesh.js';
import { senseNote } from './sheetview.js';

/** Distinguishable at a glance, and still distinguishable printed grey. */
const PALETTE = [
  '#4C78A8', '#F58518', '#54A24B', '#E45756', '#72B7B2', '#EECA3B',
  '#B279A2', '#FF9DA6', '#9D755D', '#79706E', '#6BAED6', '#FD8D3C',
  '#74C476', '#9E9AC8', '#C7C7C7', '#D6616B', '#8CA252', '#E7BA52',
];
export const colourFor = (i) => PALETTE[i % PALETTE.length];

/**
 * The seam list, in token order.
 *
 * Built from the same seam records the sheets are drawn from, so a token on a
 * piece and a token in this table cannot disagree.
 */
export function buildAssembly(result, opts = {}) {
  const { pieces, seams } = result;
  const joins = [...seams.seams.values()]
    .map((s) => ({
      token: s.token,
      edge: s.edge,
      a: pieces[s.pieces[0]]?.label ?? '?',
      b: pieces[s.pieces[1]]?.label ?? '?',
      length: s.length,
      foldDeg: s.foldDeg,
      // The word, not just the sign. A reader with the table in one hand and a
      // panel in the other should not have to remember which way positive went,
      // and on an inside-out model the sign and the word disagree on purpose.
      sense: foldSense(result.mesh, s.foldDeg),
    }))
    .sort((x, y) => (x.token < y.token ? -1 : x.token > y.token ? 1 : 0));

  const byPiece = pieces.map((p, i) => ({
    label: p.label,
    faces: p.patch.faces.length,
    colour: colourFor(i),
    width: p.flat.width,
    height: p.flat.height,
    area: p.flat.flatArea,
    seams: (seams.byPiece[i] || []).map((m) => m.token).sort(),
    maxEdgeError: p.flat.maxEdgeError,
    folds: p.flat.folds.filter((f) => Math.abs(f.angleDeg ?? 0) >= 0.5).length,
  }));

  return {
    joins,
    byPiece,
    views: opts.views || DEFAULT_VIEWS,
    stats: {
      seams: joins.length,
      mountains: joins.filter((j) => j.sense === 'mountain').length,
      valleys: joins.filter((j) => j.sense === 'valley').length,
      orientation: result.mesh?.stats?.orientation ?? 'unknown',
    },
  };
}

export const DEFAULT_VIEWS = [
  { name: 'front', dir: [0, -1, 0.35], up: [0, 0, 1] },
  { name: 'right', dir: [1, -0.3, 0.35], up: [0, 0, 1] },
  { name: 'back', dir: [0, 1, 0.35], up: [0, 0, 1] },
  { name: 'top', dir: [0.2, -0.35, 1], up: [0, 1, 0] },
];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const n = Math.hypot(...a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

/**
 * Project the mesh onto a plane facing `dir`.
 *
 * Orthographic and hidden-surface by painter's algorithm — sort the triangles
 * back to front and draw them. For a closed model that is exact; for an open one
 * a triangle seen edge-on can land the wrong way round, which is a blemish on a
 * reference drawing rather than an error in a pattern.
 */
export function projectMesh(mesh, view) {
  const dir = unit(view.dir);
  const upHint = view.up || [0, 0, 1];
  const right = unit(cross(dir, upHint));
  const up = unit(cross(right, dir));
  const p = mesh.positions;
  const at = (v) => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];

  const tris = [];
  for (let f = 0; f < mesh.faceCount; f++) {
    const vs = [0, 1, 2].map((k) => at(mesh.tris[f * 3 + k]));
    const pts = vs.map((q) => ({ u: dot(q, right), v: dot(q, up) }));
    const depth = vs.reduce((s, q) => s + dot(q, dir), 0) / 3;
    const n = unit(cross(sub(vs[1], vs[0]), sub(vs[2], vs[0])));
    tris.push({ face: f, pts, depth, facing: dot(n, dir), shade: 0.55 + 0.45 * Math.max(0, dot(n, unit([0.4, -0.7, 0.6]))) });
  }
  tris.sort((a, b) => a.depth - b.depth);         // far first
  const us = tris.flatMap((t) => t.pts.map((q) => q.u));
  const vs = tris.flatMap((t) => t.pts.map((q) => q.v));
  return {
    tris,
    bbox: { minU: Math.min(...us), maxU: Math.max(...us), minV: Math.min(...vs), maxV: Math.max(...vs) },
  };
}

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The shaded view: every piece in its own colour, named where it is big enough
 * to carry a name.
 */
export function assemblySVG(mesh, result, assembly, opts = {}) {
  const views = assembly.views;
  const cellW = opts.width ?? 320;
  const cellH = opts.height ?? 340;
  const cols = Math.min(views.length, 2);
  const rows = Math.ceil(views.length / cols);

  const owner = new Int32Array(mesh.faceCount).fill(-1);
  result.pieces.forEach((p, i) => { for (const f of p.patch.faces) owner[f] = i; });

  const panels = views.map((view, vi) => {
    const proj = projectMesh(mesh, view);
    const w = proj.bbox.maxU - proj.bbox.minU || 1;
    const h = proj.bbox.maxV - proj.bbox.minV || 1;
    const pad = 18;
    const k = Math.min((cellW - pad * 2) / w, (cellH - pad * 2 - 22) / h);
    const ox = pad + (cellW - pad * 2 - w * k) / 2;
    const oy = pad + 22 + (cellH - pad * 2 - 22 - h * k) / 2;
    const X = (u) => ox + (u - proj.bbox.minU) * k;
    const Y = (v) => cellH - (oy + (v - proj.bbox.minV) * k);

    const paths = [];
    // Where each piece ended up on screen, so its name can be put on the biggest
    // patch of it that is actually facing the reader.
    const seen = new Map();
    for (const t of proj.tris) {
      const pi = owner[t.face];
      const base = pi >= 0 ? colourFor(pi) : '#cccccc';
      const fill = shade(base, t.shade);
      const d = t.pts.map((q, i) => `${i ? 'L' : 'M'}${X(q.u).toFixed(2)} ${Y(q.v).toFixed(2)}`).join(' ') + ' Z';
      paths.push(`<path d="${d}" fill="${fill}"/>`);
      if (pi >= 0 && t.facing < 0) {
        const a = Math.abs(areaOf(t.pts.map((q) => ({ u: X(q.u), v: Y(q.v) }))));
        const cur = seen.get(pi);
        const cu = t.pts.reduce((s, q) => s + X(q.u), 0) / 3;
        const cv = t.pts.reduce((s, q) => s + Y(q.v), 0) / 3;
        if (!cur || a > cur.area) seen.set(pi, { area: a, u: cu, v: cv });
      }
    }
    const labels = [...seen.entries()]
      .filter(([, s]) => s.area > 140)                 // too small to read is worse than absent
      .map(([pi, s]) => `<text x="${s.u.toFixed(1)}" y="${s.v.toFixed(1)}" text-anchor="middle" `
        + `font-size="9" font-family="Helvetica, Arial, sans-serif" fill="#0b0d10" stroke="#ffffff" `
        + `stroke-width="2.4" paint-order="stroke">${escXml(result.pieces[pi].label)}</text>`);

    const x = (vi % cols) * cellW, y = Math.floor(vi / cols) * cellH;
    return `<g transform="translate(${x} ${y})">
  <rect width="${cellW}" height="${cellH}" fill="#ffffff" stroke="#e3e6ec"/>
  <text x="12" y="18" font-size="11" font-family="Helvetica, Arial, sans-serif" fill="#5a6472">${escXml(view.name)}</text>
  <g shape-rendering="crispEdges">${paths.join('')}</g>
  ${labels.join('')}
</g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cellW}" height="${rows * cellH}" viewBox="0 0 ${cols * cellW} ${rows * cellH}">
<title>${escXml(mesh.name)} — which piece is which</title>
<rect width="${cols * cellW}" height="${rows * cellH}" fill="#ffffff"/>
${panels.join('\n')}
</svg>`;
}

function areaOf(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].u * pts[i].v - pts[i].u * pts[j].v;
  return a / 2;
}

function shade(hex, k) {
  const r = Math.round(Math.min(255, parseInt(hex.slice(1, 3), 16) * k));
  const g = Math.round(Math.min(255, parseInt(hex.slice(3, 5), 16) * k));
  const b = Math.round(Math.min(255, parseInt(hex.slice(5, 7), 16) * k));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** The assembly document as plain text, for the README and the CLI. */
export function assemblyText(result, assembly) {
  const lines = [];
  lines.push(`${result.pieces.length} pieces, ${assembly.joins.length} seams `
    + `(${assembly.stats.mountains} mountain, ${assembly.stats.valleys} valley).`);
  lines.push('On the sheets: mountain folds are dash-dot, valley folds are plain dashed.');
  lines.push(senseNote(assembly.stats.orientation));
  lines.push('');
  lines.push('piece   faces  size                seams');
  for (const p of assembly.byPiece) {
    lines.push(`${p.label.padEnd(7)} ${String(p.faces).padStart(5)}  `
      + `${(p.width.toFixed(1) + ' x ' + p.height.toFixed(1)).padEnd(18)}  ${p.seams.join(' ')}`);
  }
  lines.push('');
  lines.push('token  joins            length   fold');
  for (const j of assembly.joins) {
    lines.push(`${j.token.padEnd(6)} ${(j.a + ' - ' + j.b).padEnd(16)} `
      + `${j.length.toFixed(1).padStart(7)}  `
      + `${j.foldDeg == null ? '-' : Math.abs(j.foldDeg).toFixed(0) + '° ' + (j.sense || '')}`);
  }
  return lines.join('\n');
}
