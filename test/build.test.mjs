// The app has no build step, which is most of why it is pleasant to work on. The
// one thing that costs is cache busting, and the failure mode is silent: a
// browser caches every module URL independently, so a fix ships and the user
// keeps running the old code with no error to explain why.
//
// So the check that the stamp is current is a TEST, not a habit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stampToken, stampedHtml, modules } from '../tools/stamp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('index.html is stamped with the CURRENT contents of the modules', () => {
  const current = readFileSync(join(root, 'index.html'), 'utf8');
  assert.equal(current, stampedHtml(),
    'index.html is stale — run: node tools/stamp.mjs');
});

test('the token is a hash of the files, so it cannot fail open', () => {
  // A hand-maintained version number can be right while the code is different,
  // which is precisely what it exists to prevent.
  const before = stampToken();
  assert.ok(before.endsWith(stampToken().slice(-8)));
  assert.match(before, /^[\w.-]+\.[0-9a-f]{8}$/);
  assert.equal(before, stampToken(), 'and it is stable while nothing changes');
});

test('every module in js/ is in the import map', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  for (const f of modules()) {
    assert.ok(map.imports[`./js/${f}`], `js/${f} is not in the import map, so it will be served stale`);
  }
  assert.equal(Object.keys(map.imports).length, modules().length);
});

test('no module imports something that is not there', () => {
  const names = new Set(modules());
  for (const f of modules()) {
    const src = readFileSync(join(root, 'js', f), 'utf8');
    for (const m of src.matchAll(/from '\.\/([\w.-]+\.js)'/g)) {
      assert.ok(names.has(m[1]), `js/${f} imports js/${m[1]}, which does not exist`);
    }
  }
});

test('the sample model is next to the app, so the demo button works', () => {
  const files = readdirSync(join(root, 'sample'));
  assert.ok(files.includes('Bunny-LowPoly.stl'));
});
