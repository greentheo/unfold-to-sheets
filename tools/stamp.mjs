// Stamp a content hash onto every asset URL in index.html.
//
//   node tools/stamp.mjs           rewrite index.html for the current contents
//   node tools/stamp.mjs --check   fail if it is out of date (used by the tests)
//
// The app is a folder of ES modules with no build step, which is most of why it
// is pleasant to work on, and the one thing it costs is cache busting. A browser
// caches every module URL independently, so bumping the entry point does nothing
// for the twenty modules it imports: a fix ships and the user keeps running the
// old code with no error to explain why.
//
// An import map fixes it without a bundler. Every module is mapped to itself
// with ?v=TOKEN attached, so one token changes every URL at once and the relative
// imports inside the modules resolve through the map unchanged.
//
// The token is a hash OF THE FILES, not a version string. A hand-maintained
// version fails open — change a module, forget to bump it, re-stamp, and every
// URL comes out identical while the code is different, which is precisely the
// failure it was meant to prevent. A content hash cannot be right while the
// code is wrong.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = join(root, 'index.html');

export const modules = () =>
  readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js')).sort();

export function buildVersion() {
  const app = readFileSync(join(root, 'js', 'app.js'), 'utf8');
  const m = app.match(/export const BUILD = '([^']+)'/);
  if (!m) throw new Error('js/app.js does not declare a BUILD');
  return m[1];
}

export function stampToken() {
  const h = createHash('sha1');
  h.update(buildVersion());
  for (const f of modules()) { h.update(f); h.update(readFileSync(join(root, 'js', f))); }
  h.update(readFileSync(join(root, 'css', 'app.css')));
  return `${buildVersion()}.${h.digest('hex').slice(0, 8)}`;
}

export function stampedHtml() {
  const v = stampToken();
  let html = readFileSync(htmlPath, 'utf8');

  html = html.replace(/href="css\/app\.css(\?v=[^"]*)?"/, `href="css/app.css?v=${v}"`);
  html = html.replace(/src="js\/app\.js(\?v=[^"]*)?"/, `src="js/app.js?v=${v}"`);

  const map = {
    imports: Object.fromEntries(modules().map((f) => [`./js/${f}`, `./js/${f}?v=${v}`])),
  };
  const block = `<script type="importmap">\n${JSON.stringify(map, null, 2)}\n</script>`;
  if (/<script type="importmap">[\s\S]*?<\/script>/.test(html)) {
    html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, block);
  } else {
    html = html.replace(/(<script type="module")/, `${block}\n$1`);
  }
  return html;
}

// Only when run as a command. The tests import this file to assert the stamp is
// current, and a module that rewrites index.html merely because somebody
// imported it is a module that makes its own test pass.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const current = readFileSync(htmlPath, 'utf8');
  const wanted = stampedHtml();
  if (current === wanted) {
    if (!check) console.log(`index.html already stamped ${stampToken()}`);
  } else if (check) {
    console.error('index.html is stale — run: node tools/stamp.mjs');
    process.exit(1);
  } else {
    writeFileSync(htmlPath, wanted);
    console.log(`stamped ${stampToken()} onto ${modules().length + 2} URLs`);
  }
}
