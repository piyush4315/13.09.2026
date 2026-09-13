#!/usr/bin/env node
/* Verifies that dist/nebula-ar.html can actually boot.
 *
 * Extracts every module the bundler inlined, writes them to real files, then
 * imports the entry point exactly as the browser's import map would — same
 * names, same specifier order. A cycle-induced temporal-dead-zone crash shows
 * up here as a ReferenceError before any rendering happens.
 *
 * Usage: node tools/verify-bundle.js
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('dist/nebula-ar.html', root), 'utf8');

const m = html.match(/const __modules = (\[[\s\S]*?\]);\nconst __map/);
if (!m) throw new Error('could not find the inlined module table in dist/nebula-ar.html');
const modules = JSON.parse(m[1]);
console.log(`inlined modules: ${modules.map((x) => x.name).join(', ')}`);

const dir = new URL('../.verify-tmp/', root);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const mod of modules) {
  writeFileSync(new URL(mod.name, dir), mod.code);
}
/* The bundle resolves its bare specifiers through an injected import map; Node
 * would read them as package names, so mirror the map with package imports. */
writeFileSync(new URL('package.json', dir), JSON.stringify({
  type: 'module',
  imports: Object.fromEntries(modules.map((x) => [`#${x.name}`, `./${x.name}`])),
}, null, 2));
for (const mod of modules) {
  const p = new URL(mod.name, dir);
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '([^'.][^']*)'/g, (_s, n) => `from '#${n}'`));
}

/* Minimal DOM: enough for module evaluation and for boot() to reach the login
 * screen. Element identity is preserved so listeners can be found again. */
function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), innerHTML: '', textContent: '', className: '',
    dataset: {}, style: {}, children: [], value: '',
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    remove() {}, focus() {}, select() {}, click() {},
    scrollTo() {}, scrollIntoView() {}, setSelectionRange() {},
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
  };
  return el;
}
const doc = {
  documentElement: { dataset: {} },
  head: makeEl('head'),
  body: makeEl('body'),
  createElement: makeEl,
  getElementById: () => makeEl(),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  addEventListener() {},
  activeElement: { tagName: 'BODY' },
};
globalThis.document = doc;
globalThis.window = { addEventListener() {}, print() {} };
globalThis.location = { hash: '' };

/* Import in the order the browser resolves them: the entry module first, which
 * pulls the rest through its own import statements. */
let failures = 0;
try {
  const app = await import(pathToFileURL(new URL('app.js', dir).pathname).href);
  console.log('module graph evaluated — no temporal-dead-zone crash');
  for (const fn of ['boot', 'renderShell', 'navigate', 'derived']) {
    if (typeof app[fn] !== 'function') throw new Error(`app.js does not export ${fn}()`);
  }
  app.boot();
  console.log('boot() ran — login screen rendered');

  app.store.records.length || (() => { throw new Error('no records parsed'); })();
  console.log(`records parsed: ${app.store.records.length}`);

  const views = await import(pathToFileURL(new URL('views.js', dir).pathname).href);
  app.store.session = { user: 'verify', role: 'analyst', at: new Date().toISOString() };
  for (const route of Object.keys(views.PAGES)) {
    const out = views.PAGES[route]();
    if (out.includes('undefined') || out.includes('NaN')) throw new Error(`${route} emitted undefined/NaN`);
    if (out.length < 500) throw new Error(`${route} emitted suspiciously little markup`);
  }
  console.log(`all ${Object.keys(views.PAGES).length} routes render through the bundled code`);
} catch (e) {
  failures = 1;
  console.error('\nBUNDLE VERIFICATION FAILED');
  console.error(e && e.stack ? e.stack : e);
}
rmSync(dir, { recursive: true, force: true });
process.exit(failures);
