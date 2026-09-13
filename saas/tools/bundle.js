#!/usr/bin/env node
/* Builds dist/nebula-ar.html — a single self-contained file: markup, CSS, the
 * whole JS graph and the dataset inlined. Opens from file:// with no server,
 * no network and no build step.
 *
 * Usage: node tools/bundle.js   (run from the saas/ directory)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const html = read('index.html');
const css = read('css/theme.css');

/* Resolve the ES module graph by hand: imports are all relative and static. */
const seen = new Map();
function load(spec, fromDir) {
  const url = new URL(spec, fromDir);
  if (seen.has(url.href)) return;
  const source = readFileSync(url, 'utf8');
  seen.set(url.href, null);                     // mark before recursing (cycles)
  for (const m of source.matchAll(/from\s+'(\.[^']+)'/g)) load(m[1], url);
  seen.set(url.href, { url, source });
}
load('./js/app.js', new URL('./index.html', root));

/* Emit one concatenated <script type="module">: each file's own relative
 * imports are rewritten to bare specifiers, and every specifier is registered
 * in a data-URL-free import map so the browser resolves them in memory. */
const order = [...seen.entries()].filter(([, v]) => v).map(([href, v]) => ({ href, ...v }));
// Dependencies first: app.js and views.js form a cycle, so keep source order
// (topological for everything else) and let the import map close the loop.
/* The browser cannot import from a data: URL that we also want to define, so we
 * use a Blob-backed import map instead: one blob per module, registered by name.
 * The import map is injected synchronously during parse, before the deferred
 * module script runs, so every specifier resolves. */
const modules = order.map(({ href, source }) => {
  const bare = href.split('/').pop();
  const rewritten = source.replace(/from\s+'(\.[^']+)'/g, (_m, spec) => {
    const name = spec.split('/').pop();
    return `from '${name}'`;
  });
  return { name: bare, code: rewritten };
});

const loader = `
const __modules = ${JSON.stringify(modules)};
const __map = {};
for (const m of __modules) {
  const blob = new Blob([m.code], { type: 'text/javascript' });
  __map[m.name] = URL.createObjectURL(blob);
}
const __script = document.createElement('script');
__script.type = 'importmap';
__script.textContent = JSON.stringify({ imports: __map });
document.head.appendChild(__script);
const __boot = document.createElement('script');
__boot.type = 'module';
__boot.textContent = "import { boot } from 'app.js'; boot();";
document.body.appendChild(__boot);
`;

const stripped = html
  .replace(/<link rel="stylesheet" href="css\/theme\.css">/, `<style>\n${css}\n</style>`)
  .replace(/<script type="module">[\s\S]*?<\/script>/, `<script>${loader}</script>`)
  .replace('</head>', `  <meta name="generator" content="tools/bundle.js">\n</head>`);

mkdirSync(new URL('dist/', root), { recursive: true });
const outPath = new URL('dist/nebula-ar.html', root);
writeFileSync(outPath, stripped);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`bundled ${order.length} JS modules + CSS into dist/nebula-ar.html`);
console.log(`  source total : ${kb(order.reduce((a, m) => a + m.source.length, 0) + css.length + html.length)}`);
console.log(`  bundle size  : ${kb(stripped.length)}  (${stripped.length} bytes)`);
