// Shapes whose flat patterns are known exactly, so the pipeline can be checked
// against arithmetic instead of against a screenshot.
//
// A flat plate must come back as itself. A cylinder must come back as a
// rectangle, height by circumference. A cone must come back as a sector. These
// fail numerically rather than plausibly, which is the whole reason they are
// worth more than any amount of looking at the output.

import { buildMesh } from '../../js/mesh.js';

/** Triangulated rectangle in the z = 0 plane. Unfolds to itself. */
export function plate(w = 100, h = 60, nx = 4, ny = 3) {
  const positions = [];
  const tris = [];
  const at = (i, j) => j * (nx + 1) + i;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) positions.push((i * w) / nx, (j * h) / ny, 0);
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      tris.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      tris.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return buildMesh({ positions, tris, groups: tris.map(() => 0), source: 'plate' },
    { units: 'mm', name: `plate ${w}x${h}` });
}

/**
 * A tube, capless.
 *
 * Developable everywhere — every corner has a full turn of angle around it — so
 * it must roll out to a rectangle `height` by the CHORD circumference. Not by
 * pi*d: the mesh is a prism, its edges are straight lines, and a flat pattern
 * measured to the true circle is longer than the part it has to fit.
 *
 * `closed` is the real distinction and it matters more than it looks. A closed
 * tube is not a disc, so it cannot be flattened in one piece however flat it is
 * — the pattern has to be cut somewhere, and if nothing cuts it the unfolding
 * walks all the way around and disagrees with itself by one whole
 * circumference. That is the annulus case, and it is here to be sure the
 * pipeline cuts it rather than reporting a rectangle that does not exist.
 *
 * The open variant is a closed tube less one facet, which keeps every remaining
 * vertex where it was. Sweeping the full circle and stopping one column short
 * would not do: the first and last columns land on the same points, welding
 * joins them, and the "open" tube is quietly closed again.
 */
export function cylinder(radius = 20, height = 50, segments = 24, rows = 4, { closed = false } = {}) {
  const positions = [];
  const tris = [];
  const n = closed ? segments : segments;
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i < n; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(radius * Math.cos(a), radius * Math.sin(a), (j * height) / rows);
    }
  }
  const at = (i, j) => j * n + (i % n);
  const columns = closed ? segments : segments - 1;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      tris.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      tris.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return buildMesh({ positions, tris, groups: tris.map(() => 0), source: 'cylinder' },
    { units: 'mm', name: `cylinder r${radius} h${height}${closed ? ' closed' : ' open'}` });
}

/** The chord length of one facet of `cylinder()` — the unit its flat pattern
 *  is actually measured in. */
export const chord = (radius, segments) => 2 * radius * Math.sin(Math.PI / segments);

/** Cone without a base, apex up. Unfolds to a sector of a circle. */
export function cone(radius = 30, height = 40, segments = 24) {
  const positions = [];
  const tris = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(radius * Math.cos(a), radius * Math.sin(a), 0);
  }
  positions.push(0, 0, height);
  const apex = segments;
  for (let i = 0; i < segments; i++) tris.push(i, (i + 1) % segments, apex);
  return buildMesh({ positions, tris, groups: tris.map(() => 0), source: 'cone' },
    { units: 'mm', name: `cone r${radius} h${height}` });
}

/** Closed box. Developable, six flat faces, twelve creases. */
export function box(w = 40, d = 30, h = 20) {
  const c = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, h], [w, 0, h], [w, d, h], [0, d, h],
  ];
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const positions = c.flat();
  const tris = [];
  const groups = [];
  quads.forEach((q, gi) => {
    tris.push(q[0], q[1], q[2], q[0], q[2], q[3]);
    groups.push(gi, gi);
  });
  return buildMesh({ positions, tris, groups, groupNames: quads.map((_, i) => `face ${i + 1}`), source: 'box' },
    { units: 'mm', name: `box ${w}x${d}x${h}` });
}

/** A sphere — the surface that provably does NOT flatten. */
export function sphere(radius = 30, bands = 12, segments = 18) {
  const positions = [];
  const tris = [];
  for (let j = 0; j <= bands; j++) {
    const phi = (j / bands) * Math.PI;
    for (let i = 0; i < segments; i++) {
      const th = (i / segments) * Math.PI * 2;
      positions.push(radius * Math.sin(phi) * Math.cos(th),
                     radius * Math.sin(phi) * Math.sin(th),
                     radius * Math.cos(phi));
    }
  }
  const at = (i, j) => j * segments + (i % segments);
  for (let j = 0; j < bands; j++) {
    for (let i = 0; i < segments; i++) {
      tris.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      tris.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return buildMesh({ positions, tris, groups: tris.map(() => 0), source: 'sphere' },
    { units: 'mm', name: `sphere r${radius}` });
}
