// What is actually drawn on a sheet — decided once, here.
//
// There are three exporters (DXF, SVG, PDF) and they must agree. The way they
// stop agreeing is that each grows its own copy of "what goes on a sheet", and
// then a change lands in two of them: the lofting project lost an afternoon to a
// private notion of a seam that had gone stale, and produced a failure whose
// error message pointed somewhere else entirely.
//
// So this module owns the decision and produces a plain layered display list.
// The exporters translate that list into their own syntax and make no
// judgements of their own. A block added here appears in all three or in none.

import { placementTransform } from './nesting.js';
import { namePlacement, seamPlacements, unlabelled } from './labels.js';
import { foldSense } from './mesh.js';

export const LAYER = {
  sheet: 'sheet',
  cut: 'cut',
  mountain: 'mountain',
  valley: 'valley',
  seam: 'seam',
  label: 'label',
};

/**
 * Draw order. Everything that iterates layers uses this, so no exporter can
 * quietly draw a different set or a different order from the others.
 *
 * Creases go on TOP of seam lines. The two coincide in exactly one place — the
 * base of a glue tab, which is both the joint and the fold — and whichever is
 * drawn second is the one that survives. A seam line hidden under a crease still
 * has its token written beside it; a crease hidden under a seam line reads as an
 * edge to butt up against, and gets butted instead of folded.
 */
export const LAYER_ORDER = [LAYER.sheet, LAYER.cut, LAYER.seam, LAYER.valley, LAYER.mountain, LAYER.label];

/**
 * Which way a crease folds, and therefore which line it is drawn with.
 *
 * A dashed line says "fold here" and stops. On the bench that is half an
 * instruction: the same dashes on a dome panel mean bend the sheet away from you
 * at one seam and towards you at the next, and getting it backwards is not
 * recoverable in coroplast, which creases once. So the two senses get two
 * distinct dash patterns — the papercraft convention, valley plain-dashed,
 * mountain dash-dot — and the pattern rather than the colour carries it, because
 * these are printed on a black-and-white printer more often than not.
 *
 * The reference face is the marked one: see `foldSense` in mesh.js for why the
 * marks land on the OUTSIDE of the model.
 */
const SENSE_LAYER = { mountain: LAYER.mountain, valley: LAYER.valley };

/** Fold lines below this are triangulation, not creases, and drawing them just
 *  invites someone to cut along them. Kept the same as seams.js's crease
 *  threshold — what is drawn and what is counted are the same set. */
const SCORE_THRESHOLD_DEG = 0.5;

/**
 * Turn a completed run into one display list per sheet.
 *
 * @param {object} result from pipeline.runScale
 * @returns {{sheets: Array, dropped: Array, stats}}
 */
export function buildSheets(result, opts = {}) {
  const { stock, pieces, seams, nest } = result;
  const nameHeight = opts.nameHeight ?? Math.min(stock.sheetWidth * 0.03, stock.sheetLength * 0.015);
  const tokenHeight = opts.tokenHeight ?? nameHeight * 0.7;
  const showScore = opts.showScore ?? stock.foldable;
  const dropped = [];
  // Read once. If the model is wound inside out every sense on every sheet is
  // reversed, and it is reversed the same way for all of them.
  const mesh = result.mesh;

  const sheets = nest.sheets.map((sheet, si) => {
    const items = [];
    items.push({
      kind: 'sheet', layer: LAYER.sheet,
      points: [
        { u: 0, v: 0 }, { u: stock.sheetLength, v: 0 },
        { u: stock.sheetLength, v: stock.sheetWidth }, { u: 0, v: stock.sheetWidth },
      ],
      closed: true,
    });

    for (const placed of sheet.placed) {
      const piece = pieces[placed.index];
      const move = placementTransform(placed);
      // Two different polygons on purpose. The CUT line includes the glue tabs;
      // labels are placed against the piece WITHOUT them, because a name written
      // on a flap ends up folded up and glued face down against the neighbour.
      const outline = piece.flat.outline.map(move);
      const cut = (piece.flat.cutOutline || piece.flat.outline).map(move);

      items.push({
        kind: 'outline', layer: LAYER.cut, closed: true, points: cut,
        piece: placed.index, label: piece.label,
      });

      // Every tab folds up along the seam it stands on, so its base is a score
      // line — without it the tab is cut but there is nothing to say it bends.
      //
      // Always a mountain, whatever the seam it serves does. The tab has to end
      // up sandwiched between the two panels, i.e. on the INSIDE, and the marked
      // face is the outside — so it folds away from the reader every time. That
      // also puts the rivets and the glue out of sight and leaves the outside
      // clear for seam tape.
      for (const t of piece.tabs || []) {
        items.push({
          kind: 'tabfold', layer: LAYER.mountain, sense: 'mountain',
          a: move(t.points[0]), b: move(t.points[3]),
          angleDeg: 180, token: t.token, edge: t.edge, piece: placed.index, tab: true,
        });
      }
      for (const hole of piece.flat.holes) {
        items.push({ kind: 'hole', layer: LAYER.cut, closed: true, points: hole.map(move), piece: placed.index });
      }

      if (showScore) {
        for (const f of piece.flat.folds) {
          if (Math.abs(f.angleDeg ?? 0) < SCORE_THRESHOLD_DEG) continue;
          const sense = foldSense(mesh, f.angleDeg);
          if (!sense) continue;
          items.push({
            kind: 'score', layer: SENSE_LAYER[sense], sense,
            a: move(f.a), b: move(f.b),
            angleDeg: f.angleDeg, edge: f.edge, piece: placed.index,
          });
        }
      }

      // Seam tokens are placed in SHEET coordinates, after the piece has been
      // turned, so the text comes out horizontal on the sheet rather than
      // horizontal in some coordinate system the piece had before it was nested.
      const marks = (seams.byPiece[placed.index] || []).map((m) => ({
        ...m,
        a: move(m.a),
        b: move(m.b),
        inward: rotateOnly(m.inward, placed.angle),
      }));
      for (const m of marks) {
        items.push({ kind: 'seamline', layer: LAYER.seam, a: m.a, b: m.b, token: m.token, edge: m.edge, piece: placed.index });
      }

      const name = namePlacement(outline, piece.label, nameHeight);
      if (name) {
        items.push({ kind: 'text', layer: LAYER.label, text: name.text, at: { u: name.x, v: name.y }, height: name.height, outside: !!name.outside });
        if (name.outside) dropped.push({ piece: piece.label, what: 'name', why: 'no room inside the piece; written just outside it' });
      }

      const tokens = seamPlacements(outline, marks, tokenHeight);
      for (const t of tokens) {
        if (t.dropped) {
          // A token in the offcut is a token that is gone, so it is reported
          // rather than drawn somewhere it will not survive.
          dropped.push({ piece: piece.label, what: `seam token ${t.text}`, edge: t.edge, why: 'no room inside the piece' });
          continue;
        }
        items.push({ kind: 'text', layer: LAYER.seam, text: t.text, at: { u: t.x, v: t.y }, height: t.height });
      }
    }

    const used = sheet.placed.reduce(
      (s, p) => s + Math.abs(area(pieces[p.index].flat.cutOutline || pieces[p.index].flat.outline)), 0);
    return {
      index: si,
      width: stock.sheetLength,
      height: stock.sheetWidth,
      units: result.units,
      // Carried on the sheet, not just in the summary: the sheet is the thing
      // that reaches the bench, and it has to be able to say for itself which
      // face the fold names are read from.
      orientation: mesh?.stats?.orientation ?? 'unknown',
      items,
      tabs: sheet.placed.reduce((s, p) => s + (pieces[p.index].tabs || []).length, 0),
      mountains: items.filter((i) => i.sense === 'mountain').length,
      valleys: items.filter((i) => i.sense === 'valley').length,
      pieces: sheet.placed.map((p) => pieces[p.index].label),
      utilisation: used / (stock.sheetLength * stock.sheetWidth),
    };
  });

  // A seam that could not be given a tab is a joint with nothing to fasten it.
  // It belongs in the same list as everything else that did not make it onto the
  // sheets, so a reader has one place to look rather than three.
  for (const s of (result.tabs?.skipped || [])) {
    dropped.push({
      piece: s.pieces.join(' / '), what: `glue tab for seam ${s.token}`, edge: s.edge, why: s.why,
    });
  }

  return {
    sheets,
    dropped,
    stats: {
      sheets: sheets.length,
      pieces: pieces.length,
      seams: seams.stats.seamCount,
      tabs: result.tabs?.stats.tabs ?? 0,
      tabsSkipped: result.tabs?.stats.skipped ?? 0,
      droppedLabels: dropped.length,
      mountains: sheets.reduce((n, s2) => n + s2.mountains, 0),
      valleys: sheets.reduce((n, s2) => n + s2.valleys, 0),
      // Carried onto every sheet and into every legend: if this is not
      // 'outward', the words mountain and valley are a guess.
      orientation: mesh?.stats?.orientation ?? 'unknown',
    },
  };
}

const rotateOnly = (p, deg) => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return { u: p.u * c - p.v * s, v: p.u * s + p.v * c };
};

function area(points) {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += points[j].u * points[i].v - points[i].u * points[j].v;
  }
  return a / 2;
}

/**
 * The layers, in draw order, with how each should look.
 *
 * `dash` is a PATTERN, given as a list of dash and gap lengths. What matters is
 * its shape — even dashes for a valley, long-dash-dot for a mountain — not its
 * size, so each medium sizes it in the unit that is legible there: millimetres
 * of real sheet for SVG and DXF, which are cut at 1:1; points on the page for
 * the PDF, which is usually reduced to fit and whose dashes would otherwise
 * shrink to a solid line; CSS pixels on screen.
 */
export const LAYER_STYLE = {
  [LAYER.sheet]: { stroke: '#c8ccd4', width: 0.6, dash: null },
  [LAYER.cut]: { stroke: '#111418', width: 1.1, dash: null },
  [LAYER.valley]: { stroke: '#3b74d6', width: 0.7, dash: [4, 3] },
  [LAYER.mountain]: { stroke: '#b02a8f', width: 0.9, dash: [9, 2, 0.6, 2] },
  [LAYER.seam]: { stroke: '#c2410c', width: 0.6, dash: null },
  [LAYER.label]: { stroke: '#111418', width: 0.5, dash: null },
};

/**
 * The key, as words — one source for the PDF, the SVG and the app, so the
 * printout and the screen cannot come to describe the same line differently.
 */
export const LEGEND = [
  { layer: LAYER.cut, text: 'cut' },
  { layer: LAYER.mountain, text: 'mountain fold — crease towards you, panels away' },
  { layer: LAYER.valley, text: 'valley fold — crease away, panels towards you' },
  { layer: LAYER.seam, text: 'seam token' },
];

/** The sentence that says which face of the sheet the folds are named from. */
export function senseNote(orientation) {
  const base = 'Marked side faces OUT; mountain and valley are named as seen from it. Glue tabs fold under, to the inside. ';
  if (orientation === 'outward') return `${base}The model is closed and wound outward, so this is checked, not assumed.`;
  if (orientation === 'inward') {
    return `${base}The model was wound inside out, so mountain and valley have been swapped to match.`;
  }
  if (orientation === 'as-wound') {
    return `${base}This is an open surface, so which face is out comes from the model's own winding and cannot be `
      + 'checked — a bowl and a dome are the same triangles. If it is inverted, every fold is inverted together: '
      + 'hold one panel against the model before creasing the rest.';
  }
  return `${base}The tool could not tell inside from outside on this model, so mountain and valley may be swapped `
    + 'as a pair. Check one seam against the model before creasing the rest.';
}
