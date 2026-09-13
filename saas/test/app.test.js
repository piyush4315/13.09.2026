/* NEBULA AR — test suite. Run with: node --test
 * Exercises the real domain layer, the real chart engine, and renders every
 * route through the real view functions against a minimal DOM stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CSV } from '../js/data.js';
import * as D from '../js/domain.js';
import * as C from '../js/charts.js';

const AS_OF = '2026-09-12';

function AGE_OK(rows, asOfDate) {
  return rows.filter((r) => r.outstanding > 0)
    .every((r) => D.bucketFor(D.ageInDays(r, asOfDate)) !== null);
}

/* ------------------------------------------------------------------ parsing */

test('embedded data module matches the CSV on disk', () => {
  const onDisk = readFileSync(new URL('../data/receivables.csv', import.meta.url), 'utf8');
  assert.equal(CSV, onDisk, 'js/data.js is stale — run node tools/gen-data.js');
});

test('parses 37 records with all 19 columns', () => {
  const rows = D.parseReceivables(CSV);
  assert.equal(rows.length, 37);
  assert.equal(rows[0].lot, 1763);
  assert.equal(rows[0].buyer, 'AL HAMD TRADE CORPORATION');
  assert.equal(rows.at(-1).lot, 2091);
  for (const key of Object.keys(D.FIELDS)) {
    assert.ok(key in rows[0], `missing field ${key}`);
  }
});

test('numeric and date coercion is applied', () => {
  const r = D.parseReceivables(CSV).find((x) => x.lot === 1763);
  assert.equal(r.materialValue, 790089);
  assert.equal(r.sdDate, '2026-08-24');
  assert.equal(r.fpDate, '2026-08-18');
  assert.equal(r.invoiceNo, 'DR2640100029');
  assert.equal(r.sapDocument, '1800003271');
});

test('rejects a CSV with an unknown column', () => {
  assert.throws(() => D.parseReceivables('Lot No.,Mystery\n1,2\n'), /Unrecognised CSV column/);
});

/* ------------------------------------------------------------------ totals */

test('column totals reproduce the stated source totals exactly', () => {
  const t = D.totals(D.parseReceivables(CSV));
  const expected = {
    materialValue: 15130598, serviceCharge: 410039, gstTds: 83029,
    receivable: 17749922, sdReceived: 3782654, fpReceived: 13646312,
    lppExpected: 31799, lppReceived: 16506, totalReceived: 17445472,
    outstanding: 304450,
  };
  for (const [k, v] of Object.entries(expected)) {
    assert.equal(Math.round(t[k]), v, `${k} mismatch`);
  }
  assert.equal(t.count, 37);
  assert.equal(t.settled, 35);
  assert.equal(t.outstandingLots, 2);
});

test('recovery rate and per-lot averages are derived correctly', () => {
  const t = D.totals(D.parseReceivables(CSV));
  assert.ok(Math.abs(t.recoveryRate - 17445472 / 17749922) < 1e-9);
  assert.ok(Math.abs(t.avgLotValue - 15130598 / 37) < 1e-6);
  assert.ok(t.avgDaysToSettle > 0, 'SD→FP lag should be positive');
});

/* ------------------------------------------------------- row-level integrity */

test('every row satisfies Total Received = SD + FP + LPP', () => {
  for (const r of D.parseReceivables(CSV)) {
    assert.ok(Math.abs(r.sdReceived + r.fpReceived + r.lppReceived - r.totalReceived) < 0.5,
      `lot ${r.lot} total received`);
  }
});

test('every row satisfies Outstanding = Receivable − Total Received', () => {
  for (const r of D.parseReceivables(CSV)) {
    assert.ok(Math.abs(r.receivable - r.totalReceived - r.outstanding) < 0.5, `lot ${r.lot}`);
  }
});

test('Payment Status agrees with the ≤5 rule on all rows', () => {
  for (const r of D.parseReceivables(CSV)) {
    assert.equal(r.status, D.statusFor(r.outstanding), `lot ${r.lot}`);
  }
});

test('contractual balances reproduce the stated balance lines under Excel rounding', () => {
  const rows = D.parseReceivables(CSV);
  const t = D.totals(rows);
  // Nine SD lots and three FP lots land exactly on .5, so the rounding mode is
  // material: Excel ROUND (half away from zero) gives 3,782,654 / 13,935,473,
  // Python round() (banker's) gives 3,782,651 / 13,935,472.
  assert.equal(t.sdExpected, 3782654);
  assert.equal(t.sdOutstanding, 0, 'security deposits are fully collected');
  assert.equal(t.fpExpected, 13935473);
  assert.ok(Math.abs(t.fpOutstanding - 289161) <= 1, `FP outstanding ${t.fpOutstanding}`);
  // SD + FP + open LPP must reconcile to the outstanding balance.
  assert.equal(t.sdOutstanding + t.fpOutstanding + (t.lppExpected - t.lppReceived), t.outstanding + 4,
    'the ₹4 gap is the six ₹1 over-receipt residues netted against the four whole-rupee rounding steps');
});

/* -------------------------------------------------------------------- audit */

test('audit finds exactly the five lots with missing documents', () => {
  const issues = D.auditRecords(D.parseReceivables(CSV), AS_OF);
  const missing = new Set(issues.filter((i) => i.code.startsWith('MISSING_')).map((i) => i.lot));
  assert.deepEqual([...missing].sort((a, b) => a - b), [2036, 2040, 2069, 2089, 2091]);
  assert.equal(issues.filter((i) => i.code.startsWith('MISSING_')).length, 15, '3 fields × 5 lots');
});

test('audit never raises a structural error on this file', () => {
  const codes = new Set(D.auditRecords(D.parseReceivables(CSV), AS_OF).map((i) => i.code));
  for (const structural of ['TOTAL_RECEIVED', 'OUTSTANDING', 'STATUS']) {
    assert.ok(!codes.has(structural), `${structural} should not fire`);
  }
});

test('audit flags the known over-receipts and the two open lots', () => {
  const issues = D.auditRecords(D.parseReceivables(CSV), AS_OF);
  const over = issues.filter((i) => i.code === 'OVER_RECEIPT').map((i) => i.lot).sort((a, b) => a - b);
  assert.deepEqual(over, [1923, 1976, 2007, 2025, 2036, 2071]);
  const open = D.parseReceivables(CSV).filter((r) => r.status === 'OUTSTANDING').map((r) => r.lot);
  assert.deepEqual(open.sort((a, b) => a - b), [2040, 2069]);
});

test('audit catches a corrupted total', () => {
  const rows = D.parseReceivables(CSV);
  const i = rows.findIndex((r) => r.lot === 2040);
  rows[i] = { ...rows[i], totalReceived: rows[i].totalReceived + 1000 };
  let codes = D.auditRecords(rows, AS_OF).filter((x) => x.lot === 2040).map((x) => x.code);
  assert.ok(codes.includes('TOTAL_RECEIVED'), 'sum check should fire');
  assert.ok(codes.includes('OUTSTANDING'), 'balance check should fire');

  // The status rule is checked against the *stated* outstanding, so corrupt that.
  rows[i] = { ...rows[i], outstanding: 0 };
  codes = D.auditRecords(rows, AS_OF).filter((x) => x.lot === 2040).map((x) => x.code);
  assert.ok(codes.includes('STATUS'), 'status check should fire once the lot claims to be settled');
  assert.ok(codes.includes('OUTSTANDING'), 'balance check should still fire');
});

/* ------------------------------------------------------------------ grouping */

test('13 distinct buyers, exposure sorted descending', () => {
  const buyers = D.byBuyer(D.parseReceivables(CSV));
  assert.equal(buyers.length, 13);
  for (let i = 1; i < buyers.length; i++) {
    assert.ok(buyers[i - 1].outstanding >= buyers[i].outstanding, 'not sorted by outstanding');
  }
  const total = buyers.reduce((a, b) => a + b.count, 0);
  assert.equal(total, 37);
});

test('ageing buckets sum to the open book', () => {
  const rows = D.parseReceivables(CSV);
  const ageing = D.ageingByBuyer(rows, AS_OF);
  const bucketSum = ageing.reduce((a, r) => a + Object.values(r.buckets).reduce((x, y) => x + y, 0), 0);
  const openSum = rows.filter((r) => r.outstanding > 0).reduce((a, r) => a + r.outstanding, 0);
  assert.equal(bucketSum, openSum, 'no balance may fall outside the buckets');
  // Two materially open lots plus six ₹1 rounding residues.
  assert.equal(openSum, 315490);
  assert.ok(AGE_OK(rows, AS_OF), 'every open lot must land in a bucket');
});

test('ageInDays anchors on the last receipt date', () => {
  const rows = D.parseReceivables(CSV);
  const open = rows.find((x) => x.lot === 2069);           // no final payment: falls back to the SD date
  assert.equal(D.ageInDays(open, AS_OF), D.daysBetween('2026-08-11', AS_OF));
  const closed = rows.find((x) => x.lot === 1763);         // SD 24/08, FP 18/08 — the FP date anchors
  assert.equal(D.ageInDays(closed, AS_OF), D.daysBetween('2026-08-18', AS_OF));
  assert.equal(D.ageInDays(closed, AS_OF), 25);
});

/* --------------------------------------------------------------- time series */

test('cumulative series is monotonic and ends at total received', () => {
  const rows = D.parseReceivables(CSV);
  const s = D.cumulativeSeries(rows, AS_OF);
  assert.ok(s.length > 30);
  for (let i = 1; i < s.length; i++) assert.ok(s[i].received >= s[i - 1].received, 'series decreased');
  const t = D.totals(rows);
  assert.equal(Math.round(s.at(-1).received), Math.round(t.totalReceived));
});

test('weekly collections reconcile to the received total', () => {
  const w = D.weeklyCollections(D.parseReceivables(CSV), AS_OF);
  const sum = w.reduce((a, x) => a + x.total, 0);
  assert.equal(Math.round(sum), 17445472);
  for (const x of w) assert.equal(Math.round(x.total), Math.round(x.sd + x.fp + x.lpp));
});

/* -------------------------------------------------------------- forecasting */

test('holtForecast returns the requested horizon and stays non-negative', () => {
  const f = C && D.holtForecast([{ value: 100 }, { value: 120 }, { value: 130 }, { value: 125 }, { value: 140 }], 6);
  assert.equal(f.length, 6);
  for (const p of f) assert.ok(p.value >= 0);
});

test('holtForecast refuses to extrapolate from too little history', () => {
  assert.deepEqual(D.holtForecast([{ value: 1 }, { value: 2 }], 4), []);
});

test('seasonalForecast produces one point per requested day', () => {
  const daily = Array.from({ length: 21 }, (_, i) => ({ date: D.iso(new Date(Date.UTC(2026, 7, 20 + i))), value: (i % 7) * 10 }));
  const f = D.seasonalForecast(daily, 14);
  assert.equal(f.length, 14);
  assert.ok(f.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date)));
});

/* ----------------------------------------------------------------- statistics */

test('z-score outliers isolate the largest lots', () => {
  const rows = D.parseReceivables(CSV);
  const out = D.zScoreOutliers(rows, 'materialValue', 2);
  assert.ok(out.length >= 1);
  assert.equal(out[0].record.lot, 2007, 'SHAR JAHAN TRADERS ₹38,57,116 is the largest ticket');
  assert.ok(out[0].z > 4);
});

test('MAD outliers are robust and agree in direction', () => {
  const rows = D.parseReceivables(CSV);
  const out = D.madOutliers(rows, 'materialValue', 3.5);
  assert.ok(out.length >= 1);
  assert.ok(out.every((o) => o.score > 0), 'should flag large tickets, not small ones');
});

test('risk scoring bands the two open lots as elevated', () => {
  const rows = D.parseReceivables(CSV);
  for (const lot of [2040, 2069]) {
    const r = rows.find((x) => x.lot === lot);
    const s = D.riskScore(r, AS_OF);
    assert.ok(s >= 35, `lot ${lot} score ${s} should be high or critical`);
  }
  const settled = rows.find((x) => x.lot === 1923);
  assert.ok(D.riskScore(settled, AS_OF) < 35, 'a settled lot should not be high risk');
});

test('riskScore is bounded 0-100', () => {
  for (const r of D.parseReceivables(CSV)) {
    const s = D.riskScore(r, AS_OF);
    assert.ok(s >= 0 && s <= 100);
  }
});

/* ----------------------------------------------------------------- simulation */

test('baseline simulation reproduces the current book', () => {
  const rows = D.parseReceivables(CSV);
  const sim = D.simulate(rows, {});
  assert.equal(Math.round(sim.next.receivable), Math.round(sim.base.receivable));
  assert.equal(sim.delta.settled, 0);
});

test('a full waiver of LPP lowers the receivable', () => {
  const rows = D.parseReceivables(CSV);
  const sim = D.simulate(rows, { lppWaiver: 1 });
  assert.ok(sim.next.receivable < sim.base.receivable);
  assert.ok(sim.delta.outstanding < 0);
});

test('a 90% final-payment haircut leaves a material balance', () => {
  const rows = D.parseReceivables(CSV);
  const sim = D.simulate(rows, { fpCollectionRate: 0.9 });
  assert.ok(sim.next.outstanding > 1_000_000);
  assert.ok(sim.next.outstandingLots > 2);
});

test('running the clock forward re-accrues LPP on unanchored lots', () => {
  const rows = D.parseReceivables(CSV);
  const now = D.simulate(rows, { additionalDays: 0 });
  const later = D.simulate(rows, { additionalDays: 60 });
  assert.ok(later.next.lppExpected > now.next.lppExpected);
});

/* --------------------------------------------------------------- search/sort */

test('fuzzy search finds buyers, lots and invoices', () => {
  const rows = D.parseReceivables(CSV);
  assert.equal(D.searchRecords(rows, 'sterling').length, 7, 'STERLING ENTERPRISES holds 7 lots');
  assert.equal(D.searchRecords(rows, '2036')[0].lot, 2036, 'exact lot id must outrank a subsequence hit');
  assert.equal(D.searchRecords(rows, 'DR2640100029')[0].lot, 1763);
  assert.equal(D.searchRecords(rows, 'national')[0].buyer, 'NATIONAL ENTERPRISES');
  assert.equal(D.searchRecords(rows, 'zzzzz').length, 0);
  assert.equal(D.searchRecords(rows, '').length, 37);
});

test('fuzzyScore prefers prefixes over subsequences', () => {
  assert.ok(D.fuzzyScore('STER', 'STERLING AND STERLING') > D.fuzzyScore('STER', 'MAHAJAN ENTERPRISES'));
  assert.equal(D.fuzzyScore('xyz', 'STERLING'), null);
});

test('sortRecords honours direction and type', () => {
  const rows = D.parseReceivables(CSV);
  const desc = D.sortRecords(rows, 'outstanding', 'desc');
  assert.equal(desc[0].lot, 2040);
  const asc = D.sortRecords(rows, 'lot', 'asc');
  assert.equal(asc[0].lot, 1763);
  assert.equal(asc.at(-1).lot, 2091);
});

test('filterRecords combines query, buyer, status and doc flags', () => {
  const rows = D.parseReceivables(CSV);
  assert.equal(D.filterRecords(rows, {}).length, 37);
  assert.equal(D.filterRecords(rows, { statuses: ['OUTSTANDING'] }).length, 2);
  assert.equal(D.filterRecords(rows, { buyers: ['STERLING ENTERPRISES'] }).length, 7);
  assert.equal(D.filterRecords(rows, { buyers: ['NATIONAL ENTERPRISES'] }).length, 13);
  assert.equal(D.filterRecords(rows, { missingInvoice: true }).length, 5);
  assert.equal(D.filterRecords(rows, { query: 'sterling', statuses: ['OUTSTANDING'] }).length, 2);
});

/* ----------------------------------------------------------------- formatting */

test('formatters produce Indian-locale output', () => {
  assert.equal(D.fmt0(15130598), '1,51,30,598');
  assert.equal(D.fmtCompact(15130598), '1.51 Cr');
  assert.equal(D.fmtCompact(262904), '2.63 L');
  assert.equal(D.fmtPct(0.9828, 2), '98.28%');
  assert.equal(D.fmtDate('2026-09-05'), '05/09/2026');
  assert.equal(D.fmtDate(null), '—');
});

test('round0 rounds half away from zero like Excel', () => {
  assert.equal(D.round0(2.5), 3);
  assert.equal(D.round0(-2.5), -3);
  assert.equal(D.round0(2.4), 2);
  assert.equal(D.expectedSecurityDeposit(400000), 100000);
  assert.equal(D.expectedFinalPayment(400000, 14400), 356200);
});

test('toCSV round-trips through the parser', () => {
  const rows = D.parseReceivables(CSV);
  const csv = D.toCSV(rows);
  const again = D.parseReceivables(csv);
  assert.equal(again.length, 37);
  assert.equal(again[0].lot, rows[0].lot);
  assert.equal(Math.round(D.totals(again).receivable), 17749922);
});

/* ------------------------------------------------------------- chart engine */

test('columnChart emits one rect per non-zero series cell', () => {
  const svg = C.columnChart({
    labels: ['A', 'B'],
    series: [{ id: 'x', label: 'X', color: '#fff', values: [10, 0] }],
  });
  assert.match(svg, /^<svg class="chart/);
  assert.equal((svg.match(/<rect/g) || []).length, 1);
  assert.match(svg, /viewBox="0 0 900 260"/);
});

test('areaChart draws a line per series and closes the area', () => {
  const svg = C.areaChart({ labels: ['a', 'b', 'c'], series: [{ color: '#0f0', values: [1, 2, 3] }] });
  assert.equal((svg.match(/<path/g) || []).length, 2);
  assert.match(svg, / Z"/);
});

test('donut renders one arc per slice and never NaN', () => {
  const svg = C.donut({ slices: [{ label: 'a', value: 1, color: '#f00' }, { label: 'b', value: 3, color: '#0f0' }] });
  assert.equal((svg.match(/<path class="c-arc"/g) || []).length, 2);
  assert.ok(!svg.includes('NaN'));
});

test('gauge clamps out-of-range values', () => {
  assert.match(C.gauge({ value: 1.6, label: 'x' }), /100\.0%/);
  assert.match(C.gauge({ value: -1, label: 'x' }), /0\.0%/);
});

test('barChart and heatStrip scale to their inputs', () => {
  const bars = C.barChart({ items: [{ label: 'a', value: 5 }, { label: 'b', value: -2 }] });
  assert.equal((bars.match(/<rect/g) || []).length, 2);
  const heat = C.heatStrip({ items: [{ label: 'a', value: 1 }, { label: 'b', value: 9 }], columns: 2 });
  assert.equal((heat.match(/<rect/g) || []).length, 2);
  assert.ok(!heat.includes('NaN'));
});

test('niceTicks produces a monotonic ascending scale', () => {
  const t = C.niceTicks(0, 17749922, 5);
  assert.ok(t.length >= 5);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
  assert.ok(t.at(-1) >= 17749922);
});

/* ------------------------------------------------------------ end-to-end UI */

function installDomStub() {
  const el = () => ({
    innerHTML: '', dataset: {}, style: {}, className: '', textContent: '',
    appendChild() {}, append() {}, remove() {}, focus() {}, select() {},
    scrollTo() {}, scrollIntoView() {}, setSelectionRange() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, click() {},
  });
  globalThis.document = {
    documentElement: { dataset: {} },
    body: { appendChild() {}, append() {} },
    createElement: el,
    getElementById: () => el(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    activeElement: { tagName: 'BODY' },
  };
  globalThis.window = { addEventListener() {}, print() {}, NEBULA: {} };
  globalThis.location = { hash: '' };
  globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
}

test('every route renders without throwing and produces markup', async () => {
  installDomStub();
  const app = await import('../js/app.js');
  const views = await import('../js/views.js');
  app.store.records = D.parseReceivables(CSV);
  app.store.session = { user: 'test', role: 'analyst', at: new Date().toISOString() };

  for (const route of Object.keys(views.PAGES)) {
    const html = views.PAGES[route]();
    assert.ok(typeof html === 'string' && html.length > 500, `${route} produced no markup`);
    assert.ok(!html.includes('undefined'), `${route} rendered the literal string "undefined"`);
    assert.ok(!html.includes('NaN'), `${route} rendered NaN`);
  }
});

test('recording a payment moves the ledger and settles the lot', async () => {
  installDomStub();
  const app = await import('../js/app.js');
  app.store.records = D.parseReceivables(CSV);
  app.store.adjustments = [];
  app.store.session = { user: 'test', role: 'analyst', at: new Date().toISOString() };

  const before = app.derived().totals;
  assert.equal(before.outstandingLots, 2);

  app.recordPayment({ lot: 2069, amount: 52580, date: AS_OF, note: 'NEFT-TEST' });
  const after = app.derived().totals;
  assert.equal(after.outstandingLots, 1, 'lot 2069 should now be settled');
  assert.equal(Math.round(after.totalReceived), 17445472 + 52580);
  assert.equal(app.store.adjustments.length, 1);
  assert.equal(app.store.audit[0].action, 'PAYMENT_RECORDED');

  assert.equal(app.resetAdjustments(), 1);
  assert.equal(app.derived().totals.outstandingLots, 2, 'reset should restore the source state');
});

test('the exception centre data backs the nav badge counts', async () => {
  installDomStub();
  const app = await import('../js/app.js');
  app.store.records = D.parseReceivables(CSV);
  const d = app.derived();
  assert.equal(d.issues.filter((i) => i.code.startsWith('MISSING_')).length, 15);
  assert.ok(d.risk.length === 37);
});
