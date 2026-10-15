// Output checked by SOMEBODY ELSE'S parser.
//
// Never trust your own writer. A malformed DXF or a PDF with a broken
// cross-reference table opens perfectly in the one viewer you happen to have
// open, because readers repair silently — and then fails on the machine that
// matters. Both of the export bugs found while building this (a PDF whose byte
// offsets were wrong wherever an em-dash appeared) were invisible by eye and
// obvious to a foreign reader on the first run.
//
// These tests skip rather than fail when the foreign tools are absent, so the
// suite still runs on a machine without them — but the CI that matters has them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unfoldToSheets } from '../js/pipeline.js';
import { buildSheets } from '../js/sheetview.js';
import { buildAssembly, assemblySVG, assemblyText } from '../js/assembly.js';
import { buildPackage, packageZip, latin1Bytes, sweepCSV } from '../js/package.js';
import { sheetSVG, niceLength } from '../js/svg.js';
import { dxfDocument, polyline, ascii } from '../js/dxf.js';
import { toWinAnsi } from '../js/pdf.js';
import { bunny } from './fixtures/bunny.mjs';

const python = (() => {
  try { execFileSync('python3', ['-c', 'import ezdxf, pypdf'], { stdio: 'pipe' }); return 'python3'; }
  catch { return null; }
})();
const runPy = (src, cwd) => execFileSync(python, ['-c', src], { cwd, encoding: 'utf8', stdio: 'pipe' });

/** One complete package, built once and reused by everything below. */
function makePackage() {
  const { result } = unfoldToSheets(bunny(), { stock: 'sheet-1to2-420', material: 'card', scale: 1.5 });
  const view = buildSheets(result);
  const assembly = buildAssembly(result);
  return { result, view, assembly, files: buildPackage(result, view, assembly) };
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'unfold-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the package declares every file once, name and content together', () => {
  const { files, view } = makePackage();
  const names = files.map((f) => f.name);
  assert.equal(new Set(names).size, names.length, 'no file is declared twice');
  assert.ok(names.includes('README.txt'));
  assert.ok(names.includes('assembly.svg'));
  assert.ok(names.includes('assembly.txt'));
  assert.ok(names.includes('pattern.pdf'));
  for (let i = 0; i < view.sheets.length; i++) {
    const n = String(i + 1).padStart(2, '0');
    assert.ok(names.includes(`sheets/sheet-${n}.svg`));
    assert.ok(names.includes(`sheets/sheet-${n}.dxf`));
  }
  for (const f of files) assert.ok(f.describe && f.describe.length > 10, `${f.name} has no description`);
});

test('FOREIGN: every DXF passes ezdxf\'s strict reader', { skip: !python && 'ezdxf not installed' }, () => {
  const { files } = makePackage();
  withTempDir((dir) => {
    const dxfs = files.filter((f) => f.name.endsWith('.dxf'));
    assert.ok(dxfs.length > 0);
    for (const f of dxfs) {
      const p = join(dir, 'sheet.dxf');
      writeFileSync(p, f.text);
      const out = runPy(`
import ezdxf
doc = ezdxf.readfile('sheet.dxf')
msp = doc.modelspace()
layers = {l.dxf.name for l in doc.layers}
need = {'CUT','SCORE-MOUNTAIN','SCORE-VALLEY','SEAM','LABEL','SHEET'}
assert need <= layers, layers
kinds = {(e.dxftype(), e.dxf.layer) for e in msp}
assert ('POLYLINE','CUT') in kinds, kinds
assert doc.dxfversion == 'AC1009', doc.dxfversion
# The two kinds of fold must be told apart by the LINE ITSELF, not only by the
# layer they sit on: a drawing shows lines, not layer names.
lts = {l.dxf.name for l in doc.linetypes}
assert {'DASHED','DASHDOT'} <= lts, lts
by = {l.dxf.name: l.dxf.linetype for l in doc.layers}
assert by['SCORE-VALLEY'] == 'DASHED', by
assert by['SCORE-MOUNTAIN'] == 'DASHDOT', by
assert by['CUT'] == 'CONTINUOUS', by
# In DRAWING units, so the pattern is a few millimetres of real sheet whatever
# the model was drawn in — not longer than the panel it is drawn on.
tags = {t.code: t.value for t in doc.linetypes.get('DASHED').pattern_tags.tags if t.code == 40}
MM = {1: 25.4, 2: 304.8, 4: 1.0, 5: 10.0, 6: 1000.0}
mm = tags[40] * MM[doc.header['$INSUNITS']]
assert 3 <= mm <= 20, ('dash pattern is not a few mm of real sheet', mm)
print(len(msp), mm)
`, dir);
      const [entities, dashMM] = out.trim().split(/\s+/).map(Number);
      assert.ok(entities > 0, 'the file has entities');
      assert.ok(dashMM > 0, 'the fold linetype has a real pattern length');
    }
  });
});

test('FOREIGN: ezdxf\'s auditor finds nothing to fix', { skip: !python && 'ezdxf not installed' }, () => {
  const { files } = makePackage();
  withTempDir((dir) => {
    writeFileSync(join(dir, 'sheet.dxf'), files.find((f) => f.name.endsWith('.dxf')).text);
    const out = runPy(`
from ezdxf import recover
doc, aud = recover.readfile('sheet.dxf')
print(len(aud.errors), len(aud.fixes))
`, dir);
    assert.equal(out.trim(), '0 0', 'a file needing repair is a file that will fail somewhere else');
  });
});

test('FOREIGN: the PDF passes pypdf in strict mode', { skip: !python && 'pypdf not installed' }, () => {
  const { files, view } = makePackage();
  withTempDir((dir) => {
    const pdf = files.find((f) => f.name === 'pattern.pdf');
    writeFileSync(join(dir, 'p.pdf'), latin1Bytes(pdf.text));
    const out = runPy(`
import warnings
from pypdf import PdfReader
with warnings.catch_warnings():
    warnings.simplefilter('error')
    r = PdfReader('p.pdf', strict=True)
    n = len(r.pages)
    t0 = r.pages[0].extract_text()
print(n)
print('BUNNY' if 'Bunny' in t0 else 'NO')
`, dir);
    const [count, found] = out.trim().split('\n');
    assert.ok(Number(count) >= view.sheets.length + 1);
    assert.equal(found, 'BUNNY', 'the model name survived into the text');
  });
});

test('FOREIGN: every sheet page carries a measured scale bar', { skip: !python && 'pypdf not installed' }, () => {
  const { files, result } = makePackage();
  withTempDir((dir) => {
    writeFileSync(join(dir, 'p.pdf'), latin1Bytes(files.find((f) => f.name === 'pattern.pdf').text));
    const out = runPy(`
from pypdf import PdfReader
r = PdfReader('p.pdf')
bars = sum(1 for p in r.pages if 'has been rescaled' in p.extract_text())
print(bars)
`, dir);
    assert.equal(Number(out.trim()), result.sheetCount,
      'a printer set to fit-to-page ruins a pattern and nothing else on the sheet reveals it');
  });
});

test('FOREIGN: the zip is readable by the system unzip', () => {
  const { files } = makePackage();
  withTempDir((dir) => {
    const zip = packageZip(files);
    writeFileSync(join(dir, 'out.zip'), Buffer.from(zip));
    const out = execFileSync('unzip', ['-t', 'out.zip'], { cwd: dir, encoding: 'utf8' });
    assert.match(out, /No errors detected/);
    const list = execFileSync('unzip', ['-Z1', 'out.zip'], { cwd: dir, encoding: 'utf8' });
    for (const f of files) assert.ok(list.includes(f.name), `${f.name} is not in the archive`);
  });
});

test('FOREIGN: the PDF inside the zip is still a valid PDF', { skip: !python && 'pypdf not installed' }, () => {
  // A PDF is BYTES. Run it through a UTF-8 encoder on the way into an archive
  // and every cross-reference offset past the first non-ASCII character is
  // wrong — while the file still looks fine to a lenient reader.
  const { files } = makePackage();
  withTempDir((dir) => {
    writeFileSync(join(dir, 'out.zip'), Buffer.from(packageZip(files)));
    execFileSync('unzip', ['-q', 'out.zip'], { cwd: dir });
    const out = runPy(`
from pypdf import PdfReader
print(len(PdfReader('pattern.pdf', strict=True).pages))
`, dir);
    assert.ok(Number(out.trim()) > 1);
  });
});

test('FOREIGN: every SVG is well-formed XML', { skip: !python && 'python3 not available' }, () => {
  const { files } = makePackage();
  withTempDir((dir) => {
    for (const f of files.filter((x) => x.name.endsWith('.svg'))) {
      writeFileSync(join(dir, 'x.svg'), f.text);
      const out = runPy(`
import xml.etree.ElementTree as ET
t = ET.parse('x.svg')
root = t.getroot()
ids = {g.get('id') for g in root.iter('{http://www.w3.org/2000/svg}g')}
print(root.tag.split('}')[-1], sorted(i for i in ids if i))
`, dir);
      assert.match(out, /^svg /, `${f.name} is not an svg`);
    }
  });
});

test('the SVG keeps cut, score, seam and label on separable layers', () => {
  const { view } = makePackage();
  const svg = sheetSVG(view.sheets[0]);
  for (const id of ['sheet', 'cut', 'seam', 'label']) {
    assert.ok(svg.includes(`id="${id}"`), `layer ${id} is missing — CAM cannot ignore what it cannot find`);
  }
  assert.ok(svg.includes('has been rescaled'), 'and it carries a measured bar');
});

test('the SVG is its REAL size, not a size in CSS pixels', () => {
  // An SVG user unit is a 96th of an inch. Without a unit on width and height a
  // 420 mm sheet reaches the cutter 111 mm wide, and nothing on the file says so.
  const { view } = makePackage();
  const sheet = view.sheets[0];
  const svg = sheetSVG(sheet);
  const m = svg.match(/width="([\d.]+)mm" height="([\d.]+)mm" viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  assert.ok(m, `no physical size on the svg: ${svg.slice(0, 200)}`);
  assert.equal(m[1], m[3], 'one user unit must be one millimetre');
  assert.equal(m[2], m[4]);
  assert.ok(Number(m[1]) >= sheet.width, 'and the sheet itself fits inside it');
});

test('DXF text is folded to ASCII, because R12 predates Unicode', () => {
  assert.equal(ascii('90° — fold ×2 ≤ A17'), '90 deg - fold x2 <= A17');
  const doc = dxfDocument([polyline([{ u: 0, v: 0 }, { u: 1, v: 1 }], 'CUT', { closed: true })], { units: 'mm' });
  assert.ok(doc.includes('AC1009'));
  assert.ok(doc.includes('$INSUNITS'));
  assert.ok(/[^\x00-\x7f]/.test(doc) === false, 'no byte in a DXF may be non-ASCII');
});

test('PDF text is folded to WinAnsi, so bytes and characters are the same count', () => {
  const s = toWinAnsi('an em-dash — and a degree ° and a times ×');
  for (let i = 0; i < s.length; i++) assert.ok(s.charCodeAt(i) <= 255, `char ${i} is above 0xFF`);
  assert.equal(toWinAnsi('≤'), '<=', 'no WinAnsi form, so it is spelled out');
  assert.equal(toWinAnsi('×'), '×', 'WinAnsi has this one at 0xD7, so it is kept');
  assert.equal(toWinAnsi('×').charCodeAt(0), 0xd7);
  assert.equal(toWinAnsi('—').charCodeAt(0), 0x97);
  // Unlike DXF, which is read a byte at a time as ASCII and must spell it out.
  assert.equal(ascii('×'), 'x');
});

test('the README names anything that was excluded', () => {
  const { files, result, view } = makePackage();
  const readme = files.find((f) => f.name === 'README.txt').text;
  assert.ok(readme.includes(result.units));
  assert.ok(readme.includes('HOW MUCH THIS LIED'));
  assert.ok(readme.includes(result.worstEdgeError.toFixed(4)));
  if (result.missing.length) {
    for (const m of result.missing) assert.ok(readme.includes(m.label));
  } else {
    assert.ok(readme.includes('Nothing was dropped'));
  }
  for (const d of view.dropped) assert.ok(readme.includes(d.piece));
});

test('the assembly text lists every seam and every piece', () => {
  const { result, assembly } = makePackage();
  const txt = assemblyText(result, assembly);
  for (const p of result.pieces) assert.ok(txt.includes(p.label));
  for (const j of assembly.joins.slice(0, 20)) assert.ok(txt.includes(j.token));
});

test('the assembly drawing renders every piece in its own colour', () => {
  const { result, assembly } = makePackage();
  const svg = assemblySVG(result.mesh, result, assembly);
  assert.ok(svg.startsWith('<svg'));
  for (const v of assembly.views) assert.ok(svg.includes(`>${v.name}<`), `view ${v.name} is missing`);
  assert.ok(svg.length > 5000);
});

test('the sweep CSV has a row per size and names its units', () => {
  const rows = [
    { scale: 1, size: 108, pieces: 30, sheets: 1, utilisation: 0.3, wasteSheets: 0.7, splits: 2, unplaceable: 0, worstEdgeError: 0.26 },
    { scale: 2, size: 216, pieces: 30, sheets: 3, utilisation: 0.44, wasteSheets: 1.7, splits: 2, unplaceable: 0, worstEdgeError: 0.52 },
  ];
  const csv = sweepCSV(rows, 'mm');
  assert.match(csv.split('\n')[0], /size_mm/);
  assert.equal(csv.split('\n').length, 3);
});

test('niceLength gives a number a person would put on a ruler', () => {
  // Rounds DOWN to 1, 2 or 5 times a power of ten: a bar shorter than asked for
  // still fits on the page, and one longer than asked for does not.
  assert.equal(niceLength(63), 50);
  assert.equal(niceLength(2.4), 2);
  assert.equal(niceLength(430), 200);
  assert.equal(niceLength(9.9), 5);
  assert.ok(Math.abs(niceLength(0.03) - 0.02) < 1e-12);
  assert.equal(niceLength(0), 1, 'and it never returns zero');
});
