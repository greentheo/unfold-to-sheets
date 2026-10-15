// The sample model, kept as a regression fixture.
//
// A real model that the pipeline once got wrong is worth more than any number of
// synthetic ones: this bunny is where the snaking-patch bug, the undivided
// eight-face fragment and the PDF byte-offset bug were all found.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSTL, buildMesh } from '../../js/mesh.js';

const here = dirname(fileURLToPath(import.meta.url));

export function bunnyBuffer() {
  const b = readFileSync(join(here, 'Bunny-LowPoly.stl'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

export const bunny = () => buildMesh(parseSTL(bunnyBuffer()), { units: 'mm', name: 'Bunny-LowPoly' });
