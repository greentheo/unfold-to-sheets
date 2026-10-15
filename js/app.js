// The browser app: UI glue over a pipeline that knows nothing about it.
//
// Every calculation lives in the modules; this file loads a file, reads the
// controls, and draws. That separation is what lets the same pipeline run under
// `node --test` and from the command line, and it is why the scale sweep — the
// part of this that is actually novel — was a couple of hundred lines rather
// than a rewrite.

export const BUILD = '2026-08-28.01';

import { parseModel, buildMesh, modelSize } from './mesh.js';
import { prepare, runScale } from './pipeline.js';
import { sweep, frontier, cliffs, scaleSteps, evaluate } from './sweep.js';
import { buildSheets, LAYER, LAYER_ORDER, LAYER_STYLE, senseNote } from './sheetview.js';
import { buildAssembly, colourFor, projectMesh } from './assembly.js';
import { buildPackage, packageZip } from './package.js';
import { STOCKS, MATERIALS, resolveStock, unitFactor } from './materials.js';
import { domeMesh, iglooPreset } from './dome.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  return n;
};
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));

// The nav buttons carry `data-tab` too, so a bare attribute selector finds the
// BUTTON and the panel's content gets written into the tab bar — which empties
// the labels and makes the other tabs unreachable. Always scope to the panel.
const panelTab = (name) => document.querySelector(`.panel .tab[data-tab="${name}"]`);

const state = {
  mesh: null,
  prepared: null,
  result: null,
  view: null,
  assembly: null,
  stage: 'model',
  sweepRows: null,
  sweeping: false,
  orbit: { yaw: 0.6, pitch: -0.25, zoom: 1 },
  sheetIndex: 0,
};

// ─── setup ──────────────────────────────────────────────────────────────────

for (const s of STOCKS) {
  $('#in-stock').appendChild(el('option', { value: s.id }, `${s.name}`));
}
for (const m of MATERIALS) $('#in-material').appendChild(el('option', { value: m.id }, m.name));
$('#in-stock').value = 'sheet-1to2-420';
$('#in-material').value = 'card';

function readOptions() {
  return {
    units: $('#in-units').value,
    stock: $('#in-stock').value,
    material: $('#in-material').value,
    scale: Number($('#in-scale').value) || 1,
    sizeAxis: $('#in-axis').value,
    rotations: Number($('#in-rot').value) || 8,
    openSheets: Math.max(0, Number($('#in-open').value) || 0),
    grain: $('#in-grain').value === 'auto' ? undefined : $('#in-grain').value === 'on',
    tabs: $('#in-tabs').value === 'auto' ? undefined : $('#in-tabs').value === 'on',
    tabWidth: Number($('#in-tabw').value) || undefined,
    tabAngle: Number($('#in-taba').value) || undefined,
    segment: {
      maxFoldDeg: Number($('#in-fold').value),
      maxDefectDeg: Number($('#in-defect').value),
      maxTotalDefectDeg: Number($('#in-total').value),
      maxPerimeterRatio: Number($('#in-ratio').value),
    },
  };
}

// The fold limit belongs to the material, so picking a material sets it — and
// then the user may still overrule it, which is the whole point of an override.
function syncMaterial() {
  const m = MATERIALS.find((x) => x.id === $('#in-material').value);
  $('#in-fold').value = m.maxFoldDeg;
  const units = $('#in-units').value;
  const stock = resolveStock($('#in-stock').value, m.id, units);
  const d = (v) => (unitFactor(units) >= 1000 ? fmt(v, 3) : fmt(v, 2));
  $('#stock-note').textContent = `${d(stock.sheetLength)} × ${d(stock.sheetWidth)} ${units}, `
    + `kerf ${d(stock.kerf)}, margin ${d(stock.margin)}`
    + `${stock.grain ? ', grain constrained' : ''}. ${stock.note}`;
  $('#joint-note').textContent = stock.joint === 'tab'
    ? 'This material folds, so seams are joined with glue tabs on one side of each cut.'
    : 'This material does not fold, so seams are butt joints — back them with a batten, '
      + 'tape or a strip of glass cloth.';
  $('#tabw-units').textContent = units;
  if (!$('#in-tabw').dataset.touched) $('#in-tabw').value = Number(stock.tabWidth.toPrecision(3));
}
$('#in-tabw').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
$('#in-material').addEventListener('change', () => { syncMaterial(); run(); });
$('#in-stock').addEventListener('change', () => { syncMaterial(); run(); });
$('#in-units').addEventListener('change', () => { syncMaterial(); reload(); });
syncMaterial();

// ─── loading ────────────────────────────────────────────────────────────────

let lastFile = null;

async function loadBuffer(name, buf) {
  lastFile = { name, buf };
  reload();
}

function reload() {
  if (!lastFile) { if (state.mesh) run(); return; }
  const o = readOptions();
  try {
    const raw = parseModel(lastFile.name, lastFile.buf);
    state.mesh = buildMesh(raw, { units: o.units, name: lastFile.name.replace(/\.[^.]+$/, '') });
  } catch (err) {
    showError(err.message);
    return;
  }
  $('#dropzone').classList.add('hide');
  state.sweepRows = null;
  renderModelStats();
  run();
}

function run() {
  if (!state.mesh) return;
  const o = readOptions();
  const t0 = performance.now();
  try {
    state.prepared = prepare(state.mesh, o);
    state.result = runScale(state.prepared, o.scale, o);
    state.view = buildSheets(state.result);
    state.assembly = buildAssembly(state.result);
  } catch (err) {
    showError(err.message);
    throw err;
  }
  state.took = performance.now() - t0;
  state.sheetIndex = Math.min(state.sheetIndex, Math.max(0, state.view.sheets.length - 1));
  $('#btn-zip').disabled = false;
  renderModelStats();
  renderPieces();
  renderSeams();
  renderExport();
  draw();
}

$('#btn-run').addEventListener('click', run);
for (const id of ['#in-scale', '#in-fold', '#in-defect', '#in-total', '#in-ratio', '#in-rot',
  '#in-axis', '#in-tabs', '#in-tabw', '#in-taba', '#in-open', '#in-grain']) {
  $(id).addEventListener('change', run);
}

$('#file-model').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) loadBuffer(f.name, await f.arrayBuffer());
});
// The dome is GENERATED rather than fetched, so the parameters are live and the
// generator is exercised by the same code path a user would take.
const SAMPLES = {
  bunny: null,
  dome2: { frequency: 2, units: 'mm' },
  dome4: { frequency: 4, units: 'mm' },
  dome6: { frequency: 6, units: 'mm' },
};
$('#btn-sample').addEventListener('click', async () => {
  const pick = $('#sample-pick').value;
  if (pick === 'bunny') {
    const r = await fetch('sample/Bunny-LowPoly.stl');
    if (!r.ok) { showError('the sample model is not next to the app'); return; }
    $('#in-units').value = 'mm';
    $('#in-stock').value = 'sheet-1to2-420';
    $('#in-material').value = 'card';
    syncMaterial();
    loadBuffer('Bunny-LowPoly.stl', await r.arrayBuffer());
    return;
  }
  const { frequency } = SAMPLES[pick];
  const preset = iglooPreset(3);
  preset.frequency = frequency;
  const mesh = domeMesh(preset);
  $('#in-units').value = 'm';
  $('#in-stock').value = 'coro-4x8';
  $('#in-material').value = 'coroplast';
  syncMaterial();
  lastFile = null;
  state.mesh = mesh;
  state.sweepRows = null;
  $('#dropzone').classList.add('hide');
  renderModelStats();
  run();
});

const dz = $('#dropzone');
document.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
document.addEventListener('dragleave', () => dz.classList.remove('over'));
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) loadBuffer(f.name, await f.arrayBuffer());
});

function showError(msg) {
  panelTab('setup').prepend(el('div', { class: 'alert' }, [el('h4', {}, 'That did not load'), msg]));
}

// ─── panels ─────────────────────────────────────────────────────────────────

const stat = (k, v, cls = '') => el('div', { class: 'stat' }, [el('span', {}, k), el('b', { class: cls }, String(v))]);

function renderModelStats() {
  const box = $('#model-stats');
  box.textContent = '';
  const m = state.mesh;
  if (!m) return;
  const s = m.stats;
  if (m.dome) {
    box.appendChild(stat('Dome', `${m.dome.frequency}V, ${fmt(m.dome.radius * 2)} m span, `
      + `${fmt(m.dome.radius)} m high`));
    box.appendChild(stat('Panels', m.dome.panels));
    box.appendChild(stat('Openings', m.dome.openings.map((o) => o.name || o.kind).join(', ')));
  }
  box.appendChild(stat('Triangles', s.triangles));
  box.appendChild(stat('Vertices', `${s.vertices} (${s.vertexesMerged} welded)`));
  box.appendChild(stat('Bounding box', m.bbox.size.map((v) => fmt(v)).join(' × ') + ' ' + m.units));
  box.appendChild(stat('Manifold', s.manifold ? 'yes' : `no — ${s.nonManifoldEdges} bad edges`, s.manifold ? '' : 'bad'));
  box.appendChild(stat('Closed', s.closed ? 'yes' : `no — ${s.boundaryEdges} open edges`));
  box.appendChild(stat('Winding', s.consistentWinding ? 'consistent' : `${s.flippedEdges} flipped`));
  if (s.degenerate.length) box.appendChild(stat('Dropped', `${s.degenerate.length} degenerate triangles`));
  if (state.prepared) {
    box.appendChild(stat('Segmented by', state.prepared.segmentMethod));
    box.appendChild(stat('Patches', state.prepared.patches.length));
  }
}

function renderPieces() {
  const tab = panelTab('pieces');
  tab.textContent = '';
  const r = state.result;
  if (!r) return;

  tab.appendChild(el('h3', {}, 'Result'));
  tab.appendChild(stat('Pieces', `${r.pieces.length} (${r.splits} split to fit)`));
  tab.appendChild(stat('Sheets', r.sheetCount));
  tab.appendChild(stat('Utilisation', `${fmt(r.utilisation * 100)}%`));
  tab.appendChild(stat('Waste', `${fmt(r.wasteSheets, 2)} sheets' worth`));
  tab.appendChild(stat('Model size', `${fmt(r.size)} ${r.units} (${r.sizeAxis})`));
  tab.appendChild(stat('Computed in', `${fmt(state.took, 0)} ms`));

  tab.appendChild(el('h3', {}, 'How much this lied'));
  const span = Math.max(...r.mesh.bbox.size);
  tab.appendChild(stat('Worst edge error', `${fmt(r.worstEdgeError, 3)} ${r.units}`));
  tab.appendChild(stat('…as a fraction', `${fmt((r.worstEdgeError / span) * 100, 3)}% of the model`));
  tab.appendChild(stat('Worst spread', `${fmt(r.worstSpread, 3)} ${r.units}`));
  tab.appendChild(stat('Overlapping', r.overlapping.length, r.overlapping.length ? 'bad' : ''));
  tab.appendChild(el('p', { class: 'note' },
    'Most surfaces cannot be flattened — that is a theorem, not a shortcoming. '
    + 'These are the numbers for this model, in the units you are working in.'));

  // Anything excluded, named, with its size. This is the block that must never
  // be missing, because a dropped part looks exactly like a part nobody made.
  if (r.missing.length) {
    tab.appendChild(el('div', { class: 'alert' }, [
      el('h4', {}, `${r.missing.length} piece(s) could not be placed`),
      el('ul', {}, r.missing.map((m) => el('li', {}, `${m.label} (${fmt(m.width)} × ${fmt(m.height)} ${r.units}) — ${m.why}`))),
      el('div', { class: 'note' }, 'The model is incomplete as cut.'),
    ]));
  } else {
    tab.appendChild(el('div', { class: 'alert ok' }, 'Every piece was placed. Nothing was dropped.'));
  }
  if (state.view.dropped.length) {
    tab.appendChild(el('div', { class: 'alert warn' }, [
      el('h4', {}, `${state.view.dropped.length} label(s) would not fit inside their piece`),
      el('ul', {}, state.view.dropped.slice(0, 20).map((d) => el('li', {}, `${d.piece}: ${d.what} — ${d.why}`))),
    ]));
  }

  const table = el('table', {}, [el('thead', {}, el('tr', {}, [
    el('th', {}, 'piece'), el('th', { class: 'num' }, 'faces'),
    el('th', { class: 'num' }, `size (${r.units})`), el('th', { class: 'num' }, 'error'),
    el('th', { class: 'num' }, 'seams'), el('th', { class: 'num' }, 'folds'),
  ]))]);
  const body = el('tbody');
  state.assembly.byPiece.forEach((p, i) => {
    body.appendChild(el('tr', {}, [
      el('td', { html: `<span class="swatch" style="background:${colourFor(i)}"></span>${p.label}` }),
      el('td', { class: 'num' }, String(p.faces)),
      el('td', { class: 'num' }, `${fmt(p.width)} × ${fmt(p.height)}`),
      el('td', { class: 'num' }, fmt(p.maxEdgeError, 3)),
      el('td', { class: 'num' }, String(p.seams.length)),
      el('td', { class: 'num' }, String(p.folds)),
    ]));
  });
  table.appendChild(body);
  tab.appendChild(el('h3', {}, 'Pieces'));
  tab.appendChild(table);
}

function renderSeams() {
  const tab = panelTab('seams');
  tab.textContent = '';
  const r = state.result;
  if (!r) return;
  const a = state.assembly;
  tab.appendChild(el('p', { class: 'note' },
    'Every token appears on exactly two pieces; glue or butt those two edges together. '
    + 'The fold angle is how far the surface turns at that seam — positive is a mountain '
    + 'seen from outside, negative a valley. It comes free from the model, and is otherwise '
    + 'measured off a half-built object.'));
  tab.appendChild(stat('Seams', a.joins.length));
  tab.appendChild(stat('Mountain / valley', `${a.stats.mountains} / ${a.stats.valleys}`));
  tab.appendChild(stat('Fold lines (scored)', r.seams.stats.foldCount));
  tab.appendChild(stat('Glue tabs', r.tabs.stats.tabs
    ? `${r.tabs.stats.tabs}${r.tabs.stats.shrunk ? ` (${r.tabs.stats.shrunk} narrowed to fit)` : ''}`
    : 'none — butt joints'));
  if (r.tabs.stats.skipped) {
    tab.appendChild(stat('Seams with no tab', r.tabs.stats.skipped, 'bad'));
  }
  tab.appendChild(stat('Edge to join', `${fmt(r.seams.stats.totalSeamLength, 0)} ${r.units}`));
  tab.appendChild(stat('Every token twice', r.tokenCheck.ok ? 'yes' : 'NO', r.tokenCheck.ok ? '' : 'bad'));

  const table = el('table', {}, [el('thead', {}, el('tr', {}, [
    el('th', {}, 'token'), el('th', {}, 'joins'),
    el('th', { class: 'num' }, `length`), el('th', { class: 'num' }, 'fold'),
  ]))]);
  const body = el('tbody');
  for (const j of a.joins) {
    body.appendChild(el('tr', {}, [
      el('td', {}, j.token), el('td', {}, `${j.a} — ${j.b}`),
      el('td', { class: 'num' }, fmt(j.length)),
      el('td', { class: 'num' }, j.foldDeg == null ? '—' : `${fmt(j.foldDeg, 0)}°`),
    ]));
  }
  table.appendChild(body);
  tab.appendChild(table);
}

function renderExport() {
  const tab = $('#export-out');
  tab.textContent = '';
  if (!state.result) return;
  const files = buildPackage(state.result, state.view, state.assembly,
    state.sweepRows ? { sweepRows: state.sweepRows } : {});
  const list = el('table', {}, [el('thead', {}, el('tr', {}, [el('th', {}, 'file'), el('th', {}, 'what')]))]);
  const body = el('tbody');
  for (const f of files) {
    const link = el('a', { href: '#' }, f.name);
    link.addEventListener('click', (e) => {
      e.preventDefault();
      download(f.name.split('/').pop(), f.text, f.latin1);
    });
    body.appendChild(el('tr', {}, [el('td', {}, link), el('td', { class: 'note' }, f.describe)]));
  }
  list.appendChild(body);
  tab.appendChild(list);
}

function download(name, text, latin1) {
  const bytes = latin1
    ? Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff)
    : new TextEncoder().encode(text);
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#btn-zip').addEventListener('click', () => {
  const files = buildPackage(state.result, state.view, state.assembly,
    state.sweepRows ? { sweepRows: state.sweepRows } : {});
  const blob = new Blob([packageZip(files)], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `${state.mesh.name}-sheets.zip` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ─── the sweep ──────────────────────────────────────────────────────────────
//
// Incremental, because a sweep is N complete nests and doing them in one go
// locks the page for several seconds with nothing to show for it.
//
// requestAnimationFrame WITH a setTimeout fallback. rAF does not fire in a
// hidden tab, so a sweep started and then left behind stalls silently with the
// button still saying "Stop" — which looks exactly like a hang.
const nextTick = (fn) => {
  let done = false;
  const once = () => { if (!done) { done = true; fn(); } };
  requestAnimationFrame(once);
  setTimeout(once, 60);
};

$('#btn-sweep').addEventListener('click', () => {
  if (!state.prepared) return;
  const o = readOptions();
  const from = Number($('#sw-from').value), to = Number($('#sw-to').value), step = Number($('#sw-step').value);
  const scales = scaleSteps(from, to, step);
  const rows = [];
  state.sweeping = true;
  $('#btn-stop').disabled = false;
  $('#btn-sweep').disabled = true;
  const bar = $('#sw-progress');
  bar.hidden = false; bar.max = scales.length; bar.value = 0;

  const stepOne = (i) => {
    if (!state.sweeping || i >= scales.length) {
      state.sweeping = false;
      state.sweepRows = rows;
      $('#btn-stop').disabled = true;
      $('#btn-sweep').disabled = false;
      bar.hidden = true;
      renderSweep(rows);
      renderExport();
      return;
    }
    rows.push(evaluate(state.prepared, scales[i], o));
    bar.value = i + 1;
    if (i % 4 === 3) renderSweep(rows);
    nextTick(() => stepOne(i + 1));
  };
  nextTick(() => stepOne(0));
});
$('#btn-stop').addEventListener('click', () => { state.sweeping = false; });

function renderSweep(rows) {
  const out = $('#sweep-out');
  out.textContent = '';
  if (!rows.length) return;
  const front = new Set(frontier(rows).map((r) => r.scale));
  const units = state.result.units;

  const table = el('table', {}, [el('thead', {}, el('tr', {}, [
    el('th', { class: 'num' }, 'scale'), el('th', { class: 'num' }, `size (${units})`),
    el('th', { class: 'num' }, 'sheets'), el('th', { class: 'num' }, 'used'),
    el('th', { class: 'num' }, 'waste'), el('th', { class: 'num' }, 'pieces'),
  ]))]);
  const body = el('tbody');
  for (const r of rows) {
    const cls = [r.unplaceable ? 'bad' : '', front.has(r.scale) ? 'front' : '',
      Math.abs(r.scale - state.result.scale) < 1e-9 ? 'here' : ''].filter(Boolean).join(' ');
    const tr = el('tr', cls ? { class: cls } : {}, [
      el('td', { class: 'num' }, `×${r.scale}`),
      el('td', { class: 'num' }, fmt(r.size)),
      el('td', { class: 'num' }, r.unplaceable ? `${r.sheets}*` : String(r.sheets)),
      el('td', { class: 'num' }, `${fmt(r.utilisation * 100)}%`),
      el('td', { class: 'num' }, fmt(r.wasteSheets, 2)),
      el('td', { class: 'num' }, String(r.pieces)),
    ]);
    tr.addEventListener('click', () => { $('#in-scale').value = r.scale; run(); renderSweep(rows); });
    tr.style.cursor = 'pointer';
    body.appendChild(tr);
  }
  table.appendChild(body);

  const f = frontier(rows);
  if (f.length) {
    const best = f[f.length - 1];
    out.appendChild(el('div', { class: 'alert ok' }, [
      el('h4', {}, 'The biggest you can build for the fewest sheets'),
      `×${best.scale} — ${fmt(best.size)} ${units} on ${best.sheets} sheet(s), ${fmt(best.utilisation * 100)}% used.`,
    ]));
  }
  const bad = rows.filter((r) => r.unplaceable);
  if (bad.length) {
    out.appendChild(el('div', { class: 'alert' }, [
      el('h4', {}, `${bad.length} row(s) disqualified`),
      'They dropped a part, so their sheet count is not a cheaper way to build the model. '
      + 'Marked with an asterisk and excluded from the frontier.',
    ]));
  }
  for (const c of cliffs(rows)) {
    out.appendChild(el('div', { class: 'alert warn' },
      `×${c.at.scale} → ×${c.next.scale} costs ${c.cost} more sheet(s).`));
  }
  out.appendChild(table);
}

// ─── drawing ────────────────────────────────────────────────────────────────

const canvas = $('#canvas');
const ctx = canvas.getContext('2d');

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: r.width, h: r.height };
}
window.addEventListener('resize', () => draw());

for (const b of document.querySelectorAll('#stagetabs button')) {
  b.addEventListener('click', () => {
    document.querySelectorAll('#stagetabs button').forEach((x) => x.classList.toggle('on', x === b));
    state.stage = b.dataset.view;
    draw();
  });
}
for (const b of document.querySelectorAll('#tabs button')) {
  b.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.panel .tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === b.dataset.tab));
  });
}

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, ...state.orbit };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || state.stage !== 'model') return;
  state.orbit.yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
  state.orbit.pitch = Math.max(-1.4, Math.min(1.4, drag.pitch + (e.clientY - drag.y) * 0.01));
  draw();
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (state.stage === 'model') { state.orbit.zoom *= e.deltaY > 0 ? 0.92 : 1.08; draw(); }
  else if (state.view && state.view.sheets.length > 1) {
    state.sheetIndex = (state.sheetIndex + (e.deltaY > 0 ? 1 : -1) + state.view.sheets.length) % state.view.sheets.length;
    draw();
  }
}, { passive: false });

function draw() {
  const { w, h } = fitCanvas();
  ctx.clearRect(0, 0, w, h);
  if (!state.result) return;
  if (state.stage === 'model') drawModel(w, h);
  else if (state.stage === 'sheets') drawSheet(w, h);
  else drawAssembly(w, h);
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function drawModel(w, h) {
  const mesh = state.result.mesh;
  const { yaw, pitch, zoom } = state.orbit;
  const dir = [Math.cos(pitch) * Math.sin(yaw), -Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
  const proj = projectMesh(mesh, { dir, up: [0, 0, 1] });
  const bw = proj.bbox.maxU - proj.bbox.minU, bh = proj.bbox.maxV - proj.bbox.minV;
  const k = Math.min((w - 60) / bw, (h - 60) / bh) * zoom;
  const cx = w / 2 - ((proj.bbox.minU + proj.bbox.maxU) / 2) * k;
  const cy = h / 2 + ((proj.bbox.minV + proj.bbox.maxV) / 2) * k;

  const owner = new Int32Array(mesh.faceCount).fill(-1);
  state.result.pieces.forEach((p, i) => { for (const f of p.patch.faces) owner[f] = i; });

  for (const t of proj.tris) {
    const pi = owner[t.face];
    ctx.beginPath();
    t.pts.forEach((q, i) => {
      const x = cx + q.u * k, y = cy - q.v * k;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = shade(pi >= 0 ? colourFor(pi) : '#999999', t.shade);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.18)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }
  $('#legend').innerHTML = `<span>${state.result.pieces.length} pieces, each its own colour — drag to turn, scroll to zoom</span>`;
  $('#readout').textContent =
    `${state.result.pieces.length} pieces   ${state.result.sheetCount} sheets   `
    + `worst edge error ${fmt(state.result.worstEdgeError, 3)} ${state.result.units}`;
}

function drawSheet(w, h) {
  const sheet = state.view.sheets[state.sheetIndex];
  if (!sheet) return;
  const pad = 26;
  const k = Math.min((w - pad * 2) / sheet.width, (h - pad * 2) / sheet.height);
  const ox = (w - sheet.width * k) / 2, oy = (h - sheet.height * k) / 2;
  const X = (u) => ox + u * k, Y = (v) => oy + (sheet.height - v) * k;

  // On screen the dash is in CSS pixels — see LAYER_STYLE for why each medium
  // sizes the pattern in its own unit and only the shape is shared.
  for (const layer of LAYER_ORDER) {
    const st = LAYER_STYLE[layer];
    const colour = layer === LAYER.cut ? css('--cut')
      : layer === LAYER.valley ? css('--score')
        : layer === LAYER.mountain ? css('--mountain')
          : layer === LAYER.seam ? css('--seam')
            : layer === LAYER.sheet ? css('--line') : css('--ink');
    ctx.strokeStyle = colour; ctx.fillStyle = colour;
    ctx.lineWidth = layer === LAYER.cut ? 1.4 : st.width;
    ctx.setLineDash(st.dash || []);
    for (const item of sheet.items) {
      if (item.layer !== layer) continue;
      if (item.kind === 'text') {
        const size = Math.max(6, item.height * k);
        ctx.font = `${size}px -apple-system, Helvetica, Arial, sans-serif`;
        ctx.fillText(item.text, X(item.at.u), Y(item.at.v));
        continue;
      }
      ctx.beginPath();
      if (item.points) {
        item.points.forEach((p, i) => (i ? ctx.lineTo(X(p.u), Y(p.v)) : ctx.moveTo(X(p.u), Y(p.v))));
        if (item.closed) ctx.closePath();
      } else if (item.a && item.b) {
        ctx.moveTo(X(item.a.u), Y(item.a.v));
        ctx.lineTo(X(item.b.u), Y(item.b.v));
      }
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  $('#legend').innerHTML =
    `<span><i style="border-color:${css('--cut')}"></i>cut</span>`
    + `<span><i style="border-color:${css('--mountain')};border-top-style:dashed"></i>mountain (dash-dot)</span>`
    + `<span><i style="border-color:${css('--score')};border-top-style:dashed"></i>valley (dashed)</span>`
    + `<span><i style="border-color:${css('--seam')}"></i>seam token</span>`
    + `<span title="${senseNote(sheet.orientation).replace(/"/g, '&quot;')}">marked side faces out</span>`;
  $('#readout').textContent =
    `sheet ${sheet.index + 1} of ${state.view.sheets.length}   `
    + `${fmt(sheet.width)} × ${fmt(sheet.height)} ${sheet.units}   `
    + `${fmt(sheet.utilisation * 100)}% used   ${sheet.pieces.length} pieces   `
    + `${sheet.mountains}▲ ${sheet.valleys}▼`;
}

function drawAssembly(w, h) {
  const mesh = state.result.mesh;
  const views = state.assembly.views;
  const cols = 2, rows = Math.ceil(views.length / cols);
  const cw = w / cols, ch = h / rows;
  const owner = new Int32Array(mesh.faceCount).fill(-1);
  state.result.pieces.forEach((p, i) => { for (const f of p.patch.faces) owner[f] = i; });

  views.forEach((view, vi) => {
    const proj = projectMesh(mesh, view);
    const bw = proj.bbox.maxU - proj.bbox.minU, bh = proj.bbox.maxV - proj.bbox.minV;
    const k = Math.min((cw - 40) / bw, (ch - 46) / bh);
    const ox = (vi % cols) * cw + cw / 2 - ((proj.bbox.minU + proj.bbox.maxU) / 2) * k;
    const oy = Math.floor(vi / cols) * ch + ch / 2 + 10 + ((proj.bbox.minV + proj.bbox.maxV) / 2) * k;
    const seen = new Map();
    for (const t of proj.tris) {
      const pi = owner[t.face];
      ctx.beginPath();
      t.pts.forEach((q, i) => {
        const x = ox + q.u * k, y = oy - q.v * k;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = shade(pi >= 0 ? colourFor(pi) : '#999', t.shade);
      ctx.fill();
      if (pi >= 0 && t.facing < 0) {
        const cu = t.pts.reduce((s, q) => s + ox + q.u * k, 0) / 3;
        const cv = t.pts.reduce((s, q) => s + oy - q.v * k, 0) / 3;
        const a = Math.abs(area2(t.pts.map((q) => ({ u: ox + q.u * k, v: oy - q.v * k }))));
        const cur = seen.get(pi);
        if (!cur || a > cur.a) seen.set(pi, { a, u: cu, v: cv });
      }
    }
    ctx.fillStyle = css('--dim');
    ctx.font = '12px -apple-system, Helvetica, Arial, sans-serif';
    ctx.fillText(view.name, (vi % cols) * cw + 12, Math.floor(vi / cols) * ch + 20);
    ctx.font = '10px -apple-system, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    for (const [pi, s] of seen) {
      if (s.a < 180) continue;
      ctx.lineWidth = 2.6; ctx.strokeStyle = '#fff';
      ctx.strokeText(state.result.pieces[pi].label, s.u, s.v);
      ctx.fillStyle = '#0b0d10';
      ctx.fillText(state.result.pieces[pi].label, s.u, s.v);
    }
    ctx.textAlign = 'left';
  });
  $('#legend').innerHTML = '<span>which piece is which — the same colours as the Pieces table</span>';
  $('#readout').textContent = `${state.assembly.joins.length} seams to join`;
}

function area2(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].u * pts[i].v - pts[i].u * pts[j].v;
  return a / 2;
}
function shade(hex, k) {
  const v = (i) => Math.round(Math.min(255, parseInt(hex.slice(i, i + 2), 16) * k));
  return `rgb(${v(1)},${v(3)},${v(5)})`;
}

draw();
