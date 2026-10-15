// A small DXF writer, and a store-only ZIP writer to bundle the results.
//
// DXF R12 (AC1009) with POLYLINE/VERTEX rather than a newer flavour with
// LWPOLYLINE: R12 is the most widely readable DXF there is, and CAM software is
// exactly where the strictest parsers live.
//
// LAYERS MATTER. Cut, the two kinds of fold, seam token and label go on separate
// layers so the CAM side can take the outlines and ignore the rest — otherwise
// the machine cuts along the fold lines and through every label.

const g = (code, value) => `${code}\n${value}\n`;
const num = (v) => (Math.abs(v) < 1e-10 ? 0 : Number(v.toFixed(6)));

/** DXF unit codes for $INSUNITS. */
const INSUNITS = { in: 1, ft: 2, mm: 4, cm: 5, m: 6 };

export const LAYERS = {
  cut: 'CUT',
  mountain: 'SCORE-MOUNTAIN',
  valley: 'SCORE-VALLEY',
  seam: 'SEAM',
  label: 'LABEL',
  sheet: 'SHEET',
};

/**
 * Linetypes, so the two kinds of fold are told apart inside CAD as well as on
 * paper.
 *
 * Separate LAYERS would be enough to select them, but a drawing opened in CAD
 * shows lines, not layer names, and two identical solid lines invite the same
 * mistake the dash patterns exist to prevent. R12 has no dash without an LTYPE
 * table, so here is one.
 *
 * Pattern lengths are in DRAWING UNITS: a dome drawn in metres wants dashes of
 * 0.004, not of 4, or the pattern is longer than the panel and every line comes
 * out solid again.
 */
const LINETYPES = {
  CONTINUOUS: { desc: 'Solid line', mm: [] },
  DASHED: { desc: 'Dashed __ __ __ __', mm: [4, -3] },
  DASHDOT: { desc: 'Dash dot __ . __ . __', mm: [9, -2, 0, -2] },
};

const LAYER_LINETYPE = {
  [LAYERS.valley]: 'DASHED',
  [LAYERS.mountain]: 'DASHDOT',
};

/** Millimetres per drawing unit, for the linetype table. */
const MM_PER = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

export function dxfDocument(entities, opts = {}) {
  const units = opts.units || 'mm';
  const layers = opts.layers || [...new Set(entities.map((e) => e.layer))];

  let s = '';
  s += g(0, 'SECTION') + g(2, 'HEADER');
  s += g(9, '$ACADVER') + g(1, 'AC1009');
  s += g(9, '$INSUNITS') + g(70, INSUNITS[units] ?? 4);
  s += g(0, 'ENDSEC');

  const per = MM_PER[units] ?? 1;
  s += g(0, 'SECTION') + g(2, 'TABLES');

  const ltNames = Object.keys(LINETYPES);
  s += g(0, 'TABLE') + g(2, 'LTYPE') + g(70, ltNames.length);
  for (const name of ltNames) {
    const lt = LINETYPES[name];
    const pat = lt.mm.map((v) => v / per);
    const total = pat.reduce((a, v) => a + Math.abs(v), 0);
    s += g(0, 'LTYPE') + g(2, name) + g(70, 64) + g(3, lt.desc)
      + g(72, 65) + g(73, pat.length) + g(40, num(total));
    for (const v of pat) s += g(49, num(v));
  }
  s += g(0, 'ENDTAB');

  s += g(0, 'TABLE') + g(2, 'LAYER') + g(70, layers.length);
  for (const name of layers) {
    s += g(0, 'LAYER') + g(2, name) + g(70, 0) + g(62, 7)
      + g(6, LAYER_LINETYPE[name] || 'CONTINUOUS');
  }
  s += g(0, 'ENDTAB') + g(0, 'ENDSEC');

  s += g(0, 'SECTION') + g(2, 'ENTITIES');
  for (const e of entities) s += entity(e);
  s += g(0, 'ENDSEC') + g(0, 'EOF');
  return s;
}

function entity(e) {
  if (e.type === 'polyline') {
    let s = g(0, 'POLYLINE') + g(8, e.layer) + g(66, 1) + g(70, e.closed ? 1 : 0);
    for (const p of e.points) {
      s += g(0, 'VERTEX') + g(8, e.layer) + g(10, num(p.u ?? p.x)) + g(20, num(p.v ?? p.y)) + g(30, 0);
    }
    return s + g(0, 'SEQEND') + g(8, e.layer);
  }
  if (e.type === 'line') {
    return g(0, 'LINE') + g(8, e.layer)
      + g(10, num(e.a.u ?? e.a.x)) + g(20, num(e.a.v ?? e.a.y)) + g(30, 0)
      + g(11, num(e.b.u ?? e.b.x)) + g(21, num(e.b.v ?? e.b.y)) + g(31, 0);
  }
  if (e.type === 'text') {
    return g(0, 'TEXT') + g(8, e.layer)
      + g(10, num(e.at.u ?? e.at.x)) + g(20, num(e.at.v ?? e.at.y)) + g(30, 0)
      + g(40, num(e.height)) + g(1, ascii(e.text));
  }
  return '';
}

/**
 * Fold text down to plain ASCII.
 *
 * R12 predates Unicode: the file is read a byte at a time, so a UTF-8 degree
 * sign arrives in the CAD package as mojibake. Better to spell the characters
 * out than to ship labels nobody can read.
 */
export function ascii(str) {
  return String(str)
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[′″]/g, '"')
    .replace(/×/g, 'x')
    .replace(/°/g, ' deg')
    .replace(/≤/g, '<=').replace(/≥/g, '>=')
    .replace(/[^\x20-\x7e]/g, '');
}

export const polyline = (points, layer = '0', { closed = false } = {}) =>
  ({ type: 'polyline', points, layer, closed });
export const line = (a, b, layer = '0') => ({ type: 'line', a, b, layer });
export const text = (str, at, height, layer = LAYERS.label) =>
  ({ type: 'text', text: str, at, height, layer });

// ─── ZIP (stored, no compression) ──────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @returns {Uint8Array} a .zip, store-only */
export function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.bytes ? new Uint8Array(f.bytes) : enc.encode(f.text);
    const crc = crc32(data);
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    chunks.push(new Uint8Array(local), nameBytes, data);
    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
    ].concat([...nameBytes]));
    offset += local.length + nameBytes.length + data.length;
  }

  const dir = central.flat();
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(dir.length), ...u32(offset), ...u16(0),
  ];
  const total = chunks.reduce((n, c) => n + c.length, 0) + dir.length + eocd.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  out.set(new Uint8Array(dir), at); at += dir.length;
  out.set(new Uint8Array(eocd), at);
  return out;
}
