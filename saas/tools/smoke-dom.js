#!/usr/bin/env node
/* Executes the code inlined in dist/nebula-ar.html inside a real DOM (jsdom)
 * and drives the UI: login, every route, a payment, exports.
 *
 * jsdom has no ES module loader, so the inlined modules are concatenated into
 * one scope in dependency order — the same source text the browser runs, with
 * only the import/export syntax stripped. Everything else is verbatim.
 *
 * Usage: node tools/smoke-dom.js
 */
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync(new URL('../dist/nebula-ar.html', import.meta.url), 'utf8');
const table = JSON.parse(html.match(/const __modules = (\[[\s\S]*?\]);\nconst __map/)[1]);
const byName = Object.fromEntries(table.map((m) => [m.name, m.code]));

const IMPORT_RE = /^import\s+[^;]*?from\s+'[^']+';?$/gms;
const BARE_IMPORT_RE = /^import\s+'[^']+';?$/gm;
const EXPORT_RE = /^export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm;
const REEXPORT_RE = /^export\s*\{[^}]*\};?$/gms;

function strip(src) {
  const out = src.replace(IMPORT_RE, '').replace(BARE_IMPORT_RE, '')
    .replace(EXPORT_RE, '').replace(REEXPORT_RE, '');
  if (/^\s*(import|export)\s/m.test(out)) {
    throw new Error('an import/export survived stripping — the flattener is out of date');
  }
  return out;
}

// Dependency order; app.js last so `boot` is defined before it is called.
const order = ['data.js', 'domain.js', 'charts.js', 'views.js', 'app.js'];
const missing = order.filter((n) => !(n in byName));
if (missing.length) throw new Error(`bundle is missing ${missing.join(', ')}`);

// app.js reaches the chart engine and the route table through namespace
// imports (`import * as charts`, `import * as views`); rebuild both from the
// hoisted declarations before boot() runs, since renderRoute() reads them.
const NAMESPACES = `
const charts = { columnChart, barChart, donut, areaChart, gauge, sparkline, heatStrip, niceTicks, shortNumber, esc };
const views = {
  PAGES, mount, dashboard, aging, buyers, lots, payments, invoices, risk, forecast,
  simulate: scenario, audit,
  exportFiltered, exportAudit, currentRecords,
};
`;

const flat = [
  ...order.map((n) => `/* ---- ${n} ---- */\n${strip(byName[n])}`),
  NAMESPACES,
  'boot();',
].join('\n');

const problems = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => problems.push(`jsdomError: ${e.message}`));
vc.on('error', (...a) => problems.push(`console.error: ${a.join(' ')}`));

const dom = new JSDOM(html, { runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;

// jsdom implements none of the scrolling API; the app calls it after navigate().
window.Element.prototype.scrollTo = function scrollTo() {};
window.Element.prototype.scrollIntoView = function scrollIntoView() {};

let checks = 0;
const ok = (cond, label, extra = '') => {
  checks++;
  if (!cond) problems.push(`FAIL: ${label}${extra ? ` — ${extra}` : ''}`);
  else console.log(`  ok  ${label}${extra ? ` (${extra})` : ''}`);
};
const text = (sel) => doc.querySelector(sel)?.textContent ?? null;

try {
  window.eval(flat);
  ok(true, 'inlined bundle evaluated');
} catch (e) {
  problems.push(`threw during boot: ${e.stack || e}`);
}

console.log('\nlogin screen');
ok(doc.querySelector('.login-card') !== null, 'login card rendered');
ok(doc.querySelectorAll('[data-role]').length === 3, 'three roles offered');
ok(doc.body.textContent.includes('NEBULA AR'), 'brand visible');
ok(doc.body.textContent.includes('37 lots'), 'record count shown in the footer');

console.log('\nentering the workspace');
doc.querySelector('#li-go')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok(doc.querySelector('.sidebar') !== null, 'shell chrome mounted');
ok(doc.querySelectorAll('.nav-item').length >= 10, 'navigation rendered',
  `${doc.querySelectorAll('.nav-item').length} items`);

console.log('\ncommand deck');
ok(doc.querySelectorAll('.kpi').length === 6, 'six KPI tiles', `${doc.querySelectorAll('.kpi').length}`);
ok(doc.querySelectorAll('.kpi-value').length === 6, 'six KPI values', `${doc.querySelectorAll('.kpi-value').length}`);
const firstKpi = text('.kpi-value');
ok(firstKpi && /₹[\d.]+ Cr/.test(firstKpi), 'receivable KPI formatted in Indian locale', String(firstKpi));
ok(doc.querySelectorAll('svg.chart').length >= 4, 'charts drawn', `${doc.querySelectorAll('svg.chart').length} svg charts`);
// jsdom parses SVG through its HTML parser, which drops siblings after a
// <title> element, so fewer rects survive than a real browser renders.
const shapes = doc.querySelectorAll('svg.chart path, svg.chart rect, svg.chart circle').length;
ok(shapes > 10, 'charts contain geometry', `${shapes} shapes (jsdom under-counts)`);
// Scope to rendered content: doc.body also holds the bundle's own <script>,
// whose source legitimately contains the identifier Number.isNaN.
const rendered = doc.querySelector('.viewport').innerHTML + doc.querySelector('.sidebar').outerHTML
  + doc.querySelector('.topbar').outerHTML;
ok(!rendered.includes('NaN'), 'no NaN in the rendered content');
ok(!/>\s*undefined\s*</.test(rendered), 'no bare undefined in the rendered content');
ok(!rendered.includes('[object Object]'), 'no unstringified objects in the rendered content');

console.log('\nevery route');
const routes = ['dashboard', 'aging', 'buyers', 'forecast', 'lots', 'payments', 'invoices', 'risk', 'simulate', 'audit'];
for (const r of routes) {
  const before = problems.length;
  window.NEBULA.navigate(r);
  const vp = doc.querySelector('.viewport');
  const size = vp ? vp.innerHTML.length : 0;
  const clean = !vp.innerHTML.includes('NaN') && !vp.innerHTML.includes('[object Object]');
  ok(size > 1500 && problems.length === before && clean, `route ${r} renders`, `${size} bytes`);
}

console.log('\nlot register');
window.NEBULA.navigate('lots');
ok(doc.querySelectorAll('table.data tbody tr[data-lot]').length === 37, 'all 37 lots listed',
  `${doc.querySelectorAll('table.data tbody tr[data-lot]').length} rows`);
const buyerFilter = doc.querySelector('#f-buyer');
buyerFilter.value = 'STERLING ENTERPRISES';
buyerFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
ok(doc.querySelectorAll('table.data tbody tr[data-lot]').length === 7, 'buyer filter narrows to 7 lots',
  `${doc.querySelectorAll('table.data tbody tr[data-lot]').length} rows`);
doc.querySelector('#f-reset')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok(doc.querySelectorAll('table.data tbody tr[data-lot]').length === 37, 'reset restores all lots');

console.log('\nlot detail drawer');
window.NEBULA.showLot(2040);
ok(doc.querySelector('.drawer') !== null, 'drawer opened');
ok(doc.querySelector('.drawer').textContent.includes('2040'), 'drawer shows the lot');
ok(doc.querySelector('.drawer').textContent.includes('missing'), 'drawer flags the missing documents');
ok(doc.querySelector('.drawer').textContent.includes('Timeline'), 'drawer shows the timeline');
doc.querySelector('.drawer [data-close]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok(doc.querySelector('.drawer') === null, 'drawer closed');

console.log('\ncollections');
const totals0 = window.NEBULA.derived().totals;
ok(totals0.outstanding === 304450, 'outstanding matches the source file', `₹${totals0.outstanding}`);
ok(totals0.count === 37, 'record count', `${totals0.count} lots`);
ok(totals0.outstandingLots === 2, 'two lots open');
window.NEBULA.store.records.find((x) => x.lot === 2069);
const store = window.NEBULA.store;
store.adjustments.push({ lot: 2069, amount: 52580, date: '2026-09-12', note: 'smoke' });
store._subs.forEach((f) => f());
const totals1 = window.NEBULA.derived().totals;
ok(totals1.outstandingLots === 1, 'posting a receipt settles lot 2069', `${totals1.outstandingLots} left open`);
ok(Math.round(totals1.totalReceived) === 17445472 + 52580, 'totals move', `₹${Math.round(totals1.totalReceived)}`);
window.NEBULA.store.adjustments.length = 0;
window.NEBULA.store._subs.forEach((f) => f());
ok(window.NEBULA.derived().totals.outstandingLots === 2, 'discarding restores the source state');

console.log('\ncommand palette');
window.NEBULA.openPalette('ster');
ok(doc.querySelector('.palette') !== null, 'palette opened');
const items = doc.querySelectorAll('.palette-item');
ok(items.length > 0, 'palette returned matches', `${items.length} items`);
ok([...items].some((i) => i.textContent.includes('STERLING ENTERPRISES')), 'palette found the buyer');
doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
ok(doc.querySelector('.palette') === null, 'palette closed');

console.log('\nresults');
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`all ${checks} DOM checks passed against dist/nebula-ar.html`);
