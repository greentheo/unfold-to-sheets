// What the stock is, and what it will put up with.
//
// The spec asks which material this is for — plywood wants grain and hates a
// tight radius, card wants score lines and glue tabs, sheet metal wants a bend
// allowance. They are different products sharing a pipeline, and the honest
// thing is to say which one is in front of you rather than to average them.
//
// The distinction that actually reaches the geometry is a single question:
//
//   CAN THIS MATERIAL BE FOLDED?
//
// If it can, a crease is a score line and a cardboard box is one piece. If it
// cannot, the same crease is a cut and the same box is six parts. That one
// answer sets the fold limit in segmentation, decides whether joints are tabs
// or butt joints, and changes the part count by an order of magnitude. So it is
// declared here, once, and every stage reads it from here.
//
// UNITS. Stock is sold in the units of its own country and the model arrives in
// whatever the file had, which was nothing. Both are carried explicitly and
// converted at the boundary, because a 4x8 sheet and a 4x8 anything else are
// not the same purchase.

export const MM_PER_INCH = 25.4;

/**
 * Every unit this tool understands, as millimetres.
 *
 * A table rather than a pair of ternaries, and unknown units THROW. The version
 * before this one silently treated anything it did not recognise as
 * millimetres, so a dome modelled in metres was nested against a sheet of
 * plywood 2438 metres long — and the pipeline did not complain, it simply
 * reported that all 140 panels fitted on one sheet at 0.0% utilisation. An
 * answer that absurd is easy to catch; the same mistake at a factor of ten is
 * not, and it would have been just as silent.
 */
export const UNITS = { mm: 1, cm: 10, m: 1000, in: MM_PER_INCH, ft: MM_PER_INCH * 12 };

export function unitFactor(units) {
  const f = UNITS[units];
  if (!f) {
    throw new Error(`unknown unit "${units}" — expected one of ${Object.keys(UNITS).join(', ')}`);
  }
  return f;
}

export const toMM = (value, units) => value * unitFactor(units);
export const fromMM = (value, units) => value / unitFactor(units);

/**
 * Sheet stock, as it is actually sold.
 *
 * `length` is the long side and `width` the short one. The plywood and MDF
 * sheets are exactly 1:2; the paper sizes are not, and are here because most of
 * what anyone will try first is a printer.
 */
export const STOCKS = [
  { id: 'ply-4x8', name: 'Plywood 4 x 8 ft', length: 96, width: 48, units: 'in', grain: true,
    kerf: 0.125, margin: 0.5, note: 'the default sheet in North America; exactly 1:2' },
  { id: 'ply-5x10', name: 'Plywood 5 x 10 ft', length: 120, width: 60, units: 'in', grain: true,
    kerf: 0.125, margin: 0.5, note: 'oversize sheet, also 1:2' },
  { id: 'ply-2440x1220', name: 'Plywood 2440 x 1220 mm', length: 2440, width: 1220, units: 'mm',
    grain: true, kerf: 3, margin: 12, note: 'the metric equivalent, very nearly 1:2' },
  { id: 'coro-4x8', name: 'Corrugated plastic 4 x 8 ft', length: 96, width: 48, units: 'in',
    grain: true, kerf: 0.06, margin: 0.5,
    note: 'coroplast; exactly 1:2, and its flutes run the long way — grain constrained' },
  { id: 'sheet-1to2-420', name: 'Card 420 x 210 mm', length: 420, width: 210, units: 'mm',
    grain: false, kerf: 0, margin: 5, note: 'A3 trimmed to 1:2; a good size for a desk model' },
  { id: 'sheet-1to2-840', name: 'Card 840 x 420 mm', length: 840, width: 420, units: 'mm',
    grain: false, kerf: 0, margin: 5, note: 'A1 trimmed to 1:2' },
  { id: 'a4', name: 'A4 297 x 210 mm', length: 297, width: 210, units: 'mm', grain: false,
    kerf: 0, margin: 8, note: 'not 1:2 — what a home printer actually holds' },
  { id: 'letter', name: 'US Letter 11 x 8.5 in', length: 11, width: 8.5, units: 'in', grain: false,
    kerf: 0, margin: 0.35, note: 'not 1:2' },
];

/**
 * Materials, and the one property that changes the geometry.
 *
 * `maxFoldDeg` is how far the stock will bend at a scored line before it has to
 * become a cut instead. Card will fold flat on itself; plywood will not fold at
 * all, so every crease in the model is a separate part with a joint.
 */
export const MATERIALS = [
  {
    id: 'card', name: 'Card / paper', foldable: true, maxFoldDeg: 179, joint: 'tab',
    thickness: 0.3, units: 'mm', tabWidth: 6, tabAngle: 60,
    note: 'creases are scored and folded; pieces join with glue tabs',
  },
  {
    id: 'thin-ply', name: 'Thin plywood / MDF', foldable: false, maxFoldDeg: 2, joint: 'butt',
    thickness: 6, units: 'mm',
    note: 'no folding at all: every crease in the model becomes a cut and a joint',
  },
  {
    id: 'ply', name: 'Plywood 12 mm', foldable: false, maxFoldDeg: 2, joint: 'butt',
    thickness: 12, units: 'mm',
    note: 'as above, and thick enough that the joints want backing blocks',
  },
  {
    id: 'coroplast', name: 'Corrugated plastic 4 mm', foldable: true, maxFoldDeg: 150,
    joint: 'tab', thickness: 4, units: 'mm', tabWidth: 40, tabAngle: 55,
    note: 'scored across the flutes it folds cleanly; tabs take rivets or vinyl '
      + 'cement, and the outside of every seam wants tape over it',
  },
  {
    id: 'sheet-metal', name: 'Sheet metal', foldable: true, maxFoldDeg: 120, joint: 'butt',
    thickness: 1.5, units: 'mm',
    note: 'bends, but not sharply; a bend allowance is NOT modelled — see the README',
  },
];

export const stockById = (id) => STOCKS.find((s) => s.id === id);
export const materialById = (id) => MATERIALS.find((m) => m.id === id);

/**
 * A stock and a material expressed in the model's own units.
 *
 * Everything downstream works in one unit system — the model's — so this is the
 * only place a conversion happens and the only place it can be got wrong.
 *
 * `modelUnits` has no default on purpose. A default here is a guess about the
 * size of somebody's building.
 */
export function resolveStock(stockId, materialId, modelUnits) {
  const stock = typeof stockId === 'object' ? stockId : stockById(stockId);
  const material = typeof materialId === 'object' ? materialId : materialById(materialId);
  if (!stock) throw new Error(`unknown stock ${stockId}`);
  if (!material) throw new Error(`unknown material ${materialId}`);
  const conv = (v, from) => fromMM(toMM(v, from), modelUnits);
  return {
    stockId: stock.id,
    materialId: material.id,
    name: stock.name,
    materialName: material.name,
    units: modelUnits,
    sheetLength: conv(stock.length, stock.units),
    sheetWidth: conv(stock.width, stock.units),
    kerf: conv(stock.kerf, stock.units),
    margin: conv(stock.margin, stock.units),
    grain: stock.grain,
    thickness: conv(material.thickness, material.units),
    tabWidth: material.tabWidth ? conv(material.tabWidth, material.units) : 0,
    tabAngle: material.tabAngle ?? 60,
    foldable: material.foldable,
    maxFoldDeg: material.maxFoldDeg,
    joint: material.joint,
    note: `${stock.note}; ${material.note}`,
  };
}

/** Segmentation options implied by the material. The caller may override any
 *  of them, which is the point — a heuristic without an override is a trap. */
export function segmentOptionsFor(resolved, overrides = {}) {
  return {
    maxFoldDeg: resolved.maxFoldDeg,
    maxDefectDeg: 8,
    maxTotalDefectDeg: 15,
    maxPerimeterRatio: 2.2,
    ...overrides,
  };
}
