/* ============================================================================
 * NEBULA AR — views.js
 * One render function per route. All of them are pure: they read the store and
 * return an HTML string. Event wiring happens in `mount()` afterwards.
 * ==========================================================================*/

import {
  FIELDS, AGE_BUCKETS, fmt0, fmt2, fmtCompact, fmtPct, fmtDate, iso,
  filterRecords, sortRecords, toCSV, byBuyer, simulate, holtForecast,
  seasonalForecast, zScoreOutliers, madOutliers, riskScore, riskBand,
  ageInDays, bucketFor, expectedSecurityDeposit, expectedFinalPayment,
  daysBetween, average, stddev, median,
} from './domain.js';
import * as charts from './charts.js';
import { store, derived, asOf, navigate, showLot, promptPayment, toast, openModal,
  openDrawer, closeOverlays, toggleTheme, toggleDensity, setAsOf, resetAdjustments,
  download, logAudit, notify, ICON, ROUTES, effectiveRecords } from './app.js';

/* -------------------------------------------------------------------------- */
/* shared fragments                                                            */
/* -------------------------------------------------------------------------- */

const PALETTE = ['#4f7cff', '#22d3ee', '#a855f7', '#2ee6a8', '#ffb547', '#ff5d7e', '#60a5fa', '#c084fc', '#34d399', '#f472b6', '#facc15', '#38bdf8', '#fb7185'];

export function buyerColor(buyer) {
  const buyers = derived().buyers.map((b) => b.buyer).sort();
  return PALETTE[buyers.indexOf(buyer) % PALETTE.length] || PALETTE[0];
}

export function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function kpi({ label, value, foot, delta, spark, progress, color = 'var(--accent)' }) {
  return `<div class="panel kpi">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-foot">
      ${delta ? `<span class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${fmtPct(Math.abs(delta), 1)}</span>` : ''}
      <span>${foot || ''}</span>
    </div>
    ${spark ? `<div class="kpi-spark">${charts.sparkline({ values: spark, color })}</div>` : ''}
    ${progress !== undefined ? `<div class="kpi-bar"><i style="width:${Math.min(100, Math.max(0, progress * 100)).toFixed(1)}%"></i></div>` : ''}
  </div>`;
}

function panel(title, sub, body, extra = '') {
  return `<section class="panel">
    <div class="panel-head">
      <div class="grow"><div class="panel-title">${title}</div>${sub ? `<div class="panel-sub">${sub}</div>` : ''}</div>
      ${extra}
    </div>
    ${body}
  </section>`;
}

function dataTable(records, opts = {}) {
  const { sort } = store;
  const cols = opts.columns || ['lot', 'buyer', 'materialValue', 'receivable', 'sdReceived', 'fpReceived', 'lppReceived', 'totalReceived', 'outstanding', 'status'];
  const rows = opts.sorted === false ? records : sortRecords(records, sort.key, sort.dir);
  const t = derived().totals;

  const sum = (k) => records.reduce((a, r) => a + (typeof r[k] === 'number' ? r[k] : 0), 0);

  return `<div class="table-wrap"><table class="data">
    <thead><tr>
      ${cols.map((k) => `<th data-sort="${k}" ${sort.key === k ? `aria-sort="${sort.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${FIELDS[k].label}${sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</th>`).join('')}
    </tr></thead>
    <tbody>
      ${rows.length ? rows.map((r) => `<tr tabindex="0" data-lot="${r.lot}">
        ${cols.map((k) => cell(r, k)).join('')}
      </tr>`).join('') : `<tr><td colspan="${cols.length}" class="empty">No lots match the current filter.</td></tr>`}
    </tbody>
    ${opts.footer === false ? '' : `<tfoot><tr>
      ${cols.map((k, i) => {
        if (i === 0) return `<td>${records.length} lot(s)</td>`;
        if (FIELDS[k].type === 'money') return `<td class="num">₹${fmt0(sum(k))}</td>`;
        if (k === 'status') return `<td class="num">${records.filter((r) => r.status === 'SETTLED').length}/${records.length} settled</td>`;
        return '<td></td>';
      }).join('')}
    </tr></tfoot>`}
  </table></div>`;
}

function cell(r, k) {
  const f = FIELDS[k];
  if (k === 'buyer') return `<td><span class="cell-buyer"><i style="background:${buyerColor(r.buyer)}">${initials(r.buyer)}</i>${r.buyer}</span></td>`;
  if (k === 'lot') return `<td class="mono">${r.lot}</td>`;
  if (f.type === 'money') {
    const neg = r[k] < 0;
    return `<td class="num" ${neg ? 'style="color:var(--good)"' : ''}>₹${fmt0(r[k])}</td>`;
  }
  if (f.type === 'date') return `<td class="mono">${fmtDate(r[k])}</td>`;
  if (k === 'status') return `<td><span class="chip ${r.status === 'SETTLED' ? 'good' : 'bad'}">${r.status}</span></td>`;
  return `<td>${r[k] ? r[k] : '<span class="muted">—</span>'}</td>`;
}

function filterBar() {
  const f = store.filter;
  const buyers = derived().buyers.map((b) => b.buyer);
  return `<div class="row mb-4">
    <div class="searchbox" style="max-width:280px">
      ${ICON.search}<input id="f-q" placeholder="Filter lots…" value="${f.query}">
    </div>
    <select class="input" id="f-buyer" style="max-width:230px">
      <option value="">All buyers (${buyers.length})</option>
      ${buyers.map((b) => `<option value="${b}" ${f.buyers[0] === b ? 'selected' : ''}>${b}</option>`).join('')}
    </select>
    <div class="seg" id="f-status">
      <button data-v="" aria-pressed="${!f.statuses.length}">All</button>
      <button data-v="SETTLED" aria-pressed="${f.statuses[0] === 'SETTLED'}">Settled</button>
      <button data-v="OUTSTANDING" aria-pressed="${f.statuses[0] === 'OUTSTANDING'}">Outstanding</button>
    </div>
    <label class="switch"><input type="checkbox" id="f-missing" ${f.missingInvoice ? 'checked' : ''}><i></i>Missing docs only</label>
    <div class="grow"></div>
    <button class="btn ghost sm" id="f-reset">${ICON.refresh} Reset</button>
    <button class="btn sm" id="f-export">${ICON.download} CSV</button>
  </div>`;
}

export function wireFilterBar(root) {
  const f = store.filter;
  root.querySelector('#f-q')?.addEventListener('input', (e) => { f.query = e.target.value; refreshKeepFocus(root, '#f-q'); });
  root.querySelector('#f-buyer')?.addEventListener('change', (e) => { f.buyers = e.target.value ? [e.target.value] : []; notify(); });
  root.querySelectorAll('#f-status button').forEach((b) => (b.onclick = () => { f.statuses = b.dataset.v ? [b.dataset.v] : []; notify(); }));
  root.querySelector('#f-missing')?.addEventListener('change', (e) => { f.missingInvoice = e.target.checked; notify(); });
  root.querySelector('#f-reset')?.addEventListener('click', () => {
    Object.assign(f, { buyers: [], statuses: [], minOutstanding: null, query: '', missingInvoice: false, riskBand: null });
    notify();
  });
  root.querySelector('#f-export')?.addEventListener('click', exportFiltered);
}

function refreshKeepFocus(root, sel) {
  const el = root.querySelector(sel);
  const pos = el?.selectionStart;
  notify();
  const again = document.querySelector(sel);
  if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* not a text input */ } }
}

export function wireTable(root) {
  root.querySelectorAll('th[data-sort]').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
      if (store.sort.key === k) store.sort.dir = store.sort.dir === 'asc' ? 'desc' : 'asc';
      else { store.sort.key = k; store.sort.dir = FIELDS[k].type === 'text' ? 'asc' : 'desc'; }
      notify();
    };
  });
  root.querySelectorAll('tr[data-lot]').forEach((tr) => {
    const open = () => showLot(tr.dataset.lot);
    tr.onclick = open;
    tr.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
}

export function currentRecords() {
  return filterRecords(effectiveRecords(), store.filter);
}

export function exportFiltered() {
  const rows = sortRecords(currentRecords(), store.sort.key, store.sort.dir);
  download(`nebula-ar-lots-${iso(new Date())}.csv`, toCSV(rows));
  toast(`Exported ${rows.length} lot(s) to CSV`, 'good');
}

export function exportAudit() {
  download(`nebula-ar-audit-${iso(new Date())}.json`, JSON.stringify({
    exportedAt: new Date().toISOString(), session: store.session, asOf: asOf(),
    totals: derived().totals, adjustments: store.adjustments, trail: store.audit,
  }, null, 2), 'application/json');
  toast('Audit trail exported as JSON', 'good');
}

/* -------------------------------------------------------------------------- */
/* 1. command deck                                                             */
/* -------------------------------------------------------------------------- */

export function dashboard() {
  const d = derived();
  const t = d.totals;
  const wk = d.weekly;
  const recent = wk.slice(-12);
  const series = d.series;
  const sampled = series.filter((_, i) => i % Math.max(1, Math.ceil(series.length / 90)) === 0);

  const topBuyers = d.buyers.slice(0, 8);
  const bucketSeries = AGE_BUCKETS.map((b, i) => ({
    id: b.id, label: b.label, color: PALETTE[i % PALETTE.length],
    values: topBuyers.map((row) => row.buckets?.[b.id] || 0),
  }));

  const composition = [
    { label: 'Security deposit', value: t.sdReceived, color: '#4f7cff' },
    { label: 'Final payment', value: t.fpReceived, color: '#22d3ee' },
    { label: 'Late payment penalty', value: t.lppReceived, color: '#a855f7' },
  ];

  const critical = d.risk.filter((r) => r.band.id === 'critical' || r.band.id === 'high').slice(0, 6);
  const issuesByCode = {};
  for (const i of d.issues) issuesByCode[i.code] = (issuesByCode[i.code] || 0) + 1;

  return `
    <header class="page-head">
      <div>
        <h1 class="page-title">Command Deck</h1>
        <div class="page-sub">Portfolio position as at ${fmtDate(asOf())} · ${t.count} lots · ${d.buyers.length} buyers</div>
      </div>
      <div class="spacer"></div>
      <div class="field" style="max-width:170px">
        <label for="as-of">As-of date</label>
        <input class="input" type="date" id="as-of" value="${asOf()}">
      </div>
      <button class="btn primary" id="d-pay">${ICON.bolt} Record payment</button>
    </header>

    <div class="grid g-kpi mb-4">
      ${kpi({ label: 'Total receivable', value: `₹${fmtCompact(t.receivable)}`, foot: `₹${fmt0(t.receivable)} exact`, spark: sampled.map((p) => p.received), progress: t.totalReceived / t.receivable })}
      ${kpi({ label: 'Collected', value: `₹${fmtCompact(t.totalReceived)}`, foot: `${fmtPct(t.recoveryRate, 2)} recovery`, delta: t.recoveryRate - 0.98, spark: sampled.map((p) => p.received), color: 'var(--good)' })}
      ${kpi({ label: 'Outstanding', value: `₹${fmtCompact(t.outstanding)}`, foot: `${t.outstandingLots} lot(s) open`, color: 'var(--bad)' })}
      ${kpi({ label: 'Material value', value: `₹${fmtCompact(t.materialValue)}`, foot: `avg ₹${fmtCompact(t.avgLotValue)} per lot` })}
      ${kpi({ label: 'Settled lots', value: `${t.settled}/${t.count}`, foot: `${fmtPct(t.settled / t.count, 0)} of book`, progress: t.settled / t.count, color: 'var(--accent-3)' })}
      ${kpi({ label: 'LPP accrued', value: `₹${fmt0(t.lppExpected)}`, foot: `₹${fmt0(t.lppReceived)} recovered · ${fmtPct(t.lppReceived / (t.lppExpected || 1), 0)}`, color: 'var(--warn)' })}
    </div>

    <div class="grid g-side mb-4">
      ${panel('Collection trajectory',
        'Cumulative cash received against the receivable ceiling',
        charts.areaChart({
          labels: sampled.map((p) => p.date),
          series: [
            { color: '#22d3ee', values: sampled.map((p) => p.received) },
            { color: '#a855f7', values: sampled.map(() => t.receivable) },
          ],
          height: 290,
        }),
        `<div class="legend"><span><i style="background:#22d3ee"></i>Received</span><span><i style="background:#a855f7"></i>Receivable</span></div>`)}
      ${panel('Cash composition', 'Where the money actually came from',
        `<div class="center">${charts.donut({ slices: composition, centreValue: `₹${fmtCompact(t.totalReceived)}`, centreLabel: 'collected' })}</div>
         <div class="legend mt-4" style="justify-content:center">
           ${composition.map((c) => `<span><i style="background:${c.color}"></i>${c.label} · ${fmtPct(c.value / t.totalReceived, 1)}</span>`).join('')}
         </div>`)}
    </div>

    <div class="grid g-side mb-4">
      ${panel('Weekly collections', 'Stacked by receipt type, Monday-anchored weeks',
        charts.columnChart({
          labels: recent.map((w) => w.week),
          series: [
            { id: 'sd', label: 'Security deposit', color: '#4f7cff', values: recent.map((w) => w.sd) },
            { id: 'fp', label: 'Final payment', color: '#22d3ee', values: recent.map((w) => w.fp) },
            { id: 'lpp', label: 'LPP', color: '#a855f7', values: recent.map((w) => w.lpp) },
          ],
          height: 250,
        }))}
      ${panel('Balance reconciliation', 'Contractual entitlement vs cash in hand',
        `<dl class="kv">
          <dt>Security deposit expected</dt><dd>₹${fmt0(t.sdExpected)}</dd>
          <dt>Security deposit received</dt><dd>₹${fmt0(t.sdReceived)}</dd>
          <dt>SD balance</dt><dd style="color:${t.sdOutstanding > 0 ? 'var(--warn)' : 'var(--good)'}">₹${fmt0(t.sdOutstanding)}</dd>
          <dt>Final payment expected</dt><dd>₹${fmt0(t.fpExpected)}</dd>
          <dt>Final payment received</dt><dd>₹${fmt0(t.fpReceived)}</dd>
          <dt>FP balance</dt><dd style="color:var(--bad)">₹${fmt0(t.fpOutstanding)}</dd>
          <dt>Avg SD → FP lag</dt><dd>${t.avgDaysToSettle.toFixed(1)} days</dd>
        </dl>
        <div class="divider"></div>
        <div class="small muted">Expected amounts apply the contract rates (25% SD, 92.65% of material value less GST TDS) with per-lot rounding, so a ±₹few drift against the file is normal.</div>`)}
    </div>

    <div class="grid g-side">
      ${panel('Ageing by buyer', 'Open balances only — click a buyer for the drill-down',
        charts.columnChart({
          labels: topBuyers.map((b) => b.buyer),
          series: bucketSeries,
          height: 280,
        }),
        `<div class="legend">${AGE_BUCKETS.map((b, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${b.label}</span>`).join('')}</div>`)}
      <div class="stack">
        ${panel('Risk watchlist', 'Highest composite scores in the book',
          `<div class="stack" style="gap:8px">
            ${critical.length ? critical.map((c) => `
              <button class="btn ghost sm" data-lot="${c.record.lot}" style="justify-content:space-between;text-align:left">
                <span>Lot ${c.record.lot} · ${c.record.buyer}</span>
                <span class="chip ${c.band.id === 'critical' ? 'bad' : 'warn'}">${c.score} · ${c.band.label}</span>
              </button>`).join('') : '<div class="empty">No elevated-risk lots.</div>'}
          </div>`)}
        ${panel('Data-quality exceptions', `${d.issues.length} finding(s)`,
          `<div class="stack" style="gap:6px">
            ${Object.entries(issuesByCode).sort((a, b) => b[1] - a[1]).map(([code, n]) =>
              `<div class="between small"><span class="mono">${code}</span><span class="chip info">${n}</span></div>`).join('')}
          </div>
          <button class="btn sm mt-4" data-goto="invoices">${ICON.invoices} Open reconciliation</button>`)}
      </div>
    </div>`;
}

/* -------------------------------------------------------------------------- */
/* 2. ageing matrix                                                            */
/* -------------------------------------------------------------------------- */

export function aging() {
  const d = derived();
  const rows = d.ageing;
  const bucketTotals = AGE_BUCKETS.map((b) => rows.reduce((a, r) => a + (r.buckets?.[b.id] || 0), 0));
  const grand = bucketTotals.reduce((a, b) => a + b, 0) || 1;
  const openLots = d.records.filter((r) => r.outstanding > 0);

  return `
    <header class="page-head">
      <div><h1 class="page-title">Ageing Matrix</h1>
        <div class="page-sub">Open balance of ₹${fmt0(grand)} across ${openLots.length} lot(s), bucketed from the last receipt date</div></div>
      <div class="spacer"></div>
      <div class="seg" id="age-scale">
        <button data-v="linear" aria-pressed="true">Linear</button>
        <button data-v="share" aria-pressed="false">Share</button>
      </div>
    </header>

    <div class="grid g-kpi mb-4">
      ${AGE_BUCKETS.map((b, i) => kpi({
        label: b.label, value: `₹${fmtCompact(bucketTotals[i])}`,
        foot: `${fmtPct(bucketTotals[i] / grand, 1)} of open book`,
        progress: bucketTotals[i] / grand, color: PALETTE[i % PALETTE.length],
      })).join('')}
    </div>

    <div class="grid g-side mb-4">
      ${panel('Buyer × bucket', 'Rows are buyers, columns are ageing buckets',
        charts.columnChart({
          labels: rows.map((r) => r.buyer),
          series: AGE_BUCKETS.map((b, i) => ({ id: b.id, label: b.label, color: PALETTE[i % PALETTE.length], values: rows.map((r) => r.buckets?.[b.id] || 0) })),
          height: 320,
        }))}
      ${panel('Distribution', 'Share of the open book by bucket',
        charts.donut({
          slices: AGE_BUCKETS.map((b, i) => ({ label: b.label, value: bucketTotals[i], color: PALETTE[i % PALETTE.length] })),
          centreValue: `₹${fmtCompact(grand)}`, centreLabel: 'open',
        }) + `<div class="legend mt-4" style="justify-content:center">${AGE_BUCKETS.map((b, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${b.label} ${fmtPct(bucketTotals[i] / grand, 0)}</span>`).join('')}</div>`)}
    </div>

    ${panel('Ageing ledger', 'Every lot with an open balance, oldest first',
      `<div class="table-wrap"><table class="data">
        <thead><tr><th>Lot</th><th>Buyer</th><th>Anchor date</th><th>Days</th><th>Bucket</th><th>Receivable</th><th>Received</th><th>Outstanding</th><th>Risk</th></tr></thead>
        <tbody>
          ${openLots.length ? openLots
            .map((r) => ({ r, days: ageInDays(r, asOf()) }))
            .sort((a, b) => (b.days ?? -1) - (a.days ?? -1))
            .map(({ r, days }) => {
              const b = bucketFor(days);
              const score = riskScore(r, asOf());
              return `<tr tabindex="0" data-lot="${r.lot}">
                <td class="mono">${r.lot}</td>
                <td><span class="cell-buyer"><i style="background:${buyerColor(r.buyer)}">${initials(r.buyer)}</i>${r.buyer}</span></td>
                <td class="mono">${fmtDate(r.fpDate || r.sdDate || r.invoiceDate)}</td>
                <td class="num">${days === null ? '—' : days}</td>
                <td>${b ? `<span class="chip">${b.label}</span>` : '<span class="muted">unanchored</span>'}</td>
                <td class="num">₹${fmt0(r.receivable)}</td>
                <td class="num">₹${fmt0(r.totalReceived)}</td>
                <td class="num" style="color:var(--bad)">₹${fmt0(r.outstanding)}</td>
                <td><span class="chip ${score >= 60 ? 'bad' : score >= 35 ? 'warn' : 'info'}">${score}</span></td>
              </tr>`;
            }).join('') : '<tr><td colspan="9" class="empty">Every lot in the book is settled.</td></tr>'}
        </tbody>
      </table></div>`)}

    ${panel('Exposure heat map', 'One tile per lot, intensity = outstanding balance',
      charts.heatStrip({
        items: d.records.map((r) => ({ label: `Lot ${r.lot} · ${r.buyer}`, value: Math.max(0, r.outstanding), color: r.outstanding < 0 ? 'var(--good)' : 'var(--bad)' })),
        columns: 19,
      }))}
  `;
}

/* -------------------------------------------------------------------------- */
/* 3. buyer intelligence                                                       */
/* -------------------------------------------------------------------------- */

export function buyers() {
  const d = derived();
  const rows = d.buyers;
  const maxOut = Math.max(1, ...rows.map((r) => Math.abs(r.outstanding)));

  return `
    <header class="page-head">
      <div><h1 class="page-title">Buyer Intelligence</h1>
        <div class="page-sub">${rows.length} counterparties · ₹${fmt0(rows.reduce((a, r) => a + r.receivable, 0))} receivable</div></div>
      <div class="spacer"></div>
      <button class="btn sm" id="b-export">${ICON.download} Buyer CSV</button>
    </header>

    <div class="grid g-side mb-4">
      ${panel('Outstanding by buyer', 'Signed — green means the buyer has over-paid',
        charts.barChart({
          items: rows.map((r) => ({ label: r.buyer, value: r.outstanding, color: r.outstanding > 0 ? 'var(--bad)' : 'var(--good)' })),
        }))}
      ${panel('Concentration', 'Share of the receivable book',
        charts.donut({
          slices: rows.slice(0, 9).map((r, i) => ({ label: r.buyer, value: r.receivable, color: PALETTE[i % PALETTE.length] }))
            .concat([{ label: 'Others', value: rows.slice(9).reduce((a, r) => a + r.receivable, 0), color: '#4b5680' }]),
          centreValue: `${rows.length}`, centreLabel: 'buyers',
        }))}
    </div>

    ${panel('Counterparty ledger', 'Sorted by exposure; click a row to filter the register',
      `<div class="table-wrap"><table class="data">
        <thead><tr><th>Buyer</th><th>Lots</th><th>Material value</th><th>Receivable</th><th>Received</th><th>Outstanding</th><th>Recovery</th><th>Settled</th><th>SD → FP lag</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr tabindex="0" data-buyer="${r.buyer}">
            <td><span class="cell-buyer"><i style="background:${buyerColor(r.buyer)}">${initials(r.buyer)}</i>${r.buyer}</span></td>
            <td class="num">${r.count}</td>
            <td class="num">₹${fmt0(r.materialValue)}</td>
            <td class="num">₹${fmt0(r.receivable)}</td>
            <td class="num">₹${fmt0(r.totalReceived)}</td>
            <td class="num" style="color:${r.outstanding > 0 ? 'var(--bad)' : 'var(--good)'}">₹${fmt0(r.outstanding)}</td>
            <td><div class="progress ${r.recoveryRate >= 0.999 ? 'good' : ''}" style="min-width:80px"><i style="width:${Math.min(100, r.recoveryRate * 100).toFixed(1)}%"></i></div></td>
            <td class="num">${r.settled}/${r.count}</td>
            <td class="num">${r.avgDaysToSettle ? `${r.avgDaysToSettle.toFixed(0)}d` : '—'}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr><td>${rows.length} buyers</td><td class="num">${rows.reduce((a, r) => a + r.count, 0)}</td>
          <td class="num">₹${fmt0(rows.reduce((a, r) => a + r.materialValue, 0))}</td>
          <td class="num">₹${fmt0(rows.reduce((a, r) => a + r.receivable, 0))}</td>
          <td class="num">₹${fmt0(rows.reduce((a, r) => a + r.totalReceived, 0))}</td>
          <td class="num">₹${fmt0(rows.reduce((a, r) => a + r.outstanding, 0))}</td>
          <td colspan="3"></td></tr></tfoot>
      </table></div>`)}
  `;
}

/* -------------------------------------------------------------------------- */
/* 4. lot register                                                             */
/* -------------------------------------------------------------------------- */

export function lots() {
  const rows = currentRecords();
  return `
    <header class="page-head">
      <div><h1 class="page-title">Lot Register</h1>
        <div class="page-sub">${rows.length} of ${derived().records.length} lots · sorted by ${FIELDS[store.sort.key].label} ${store.sort.dir}</div></div>
    </header>
    ${filterBar()}
    ${panel('All lots', 'Click any row for the full document trail', dataTable(rows, {
      columns: ['lot', 'buyer', 'materialValue', 'serviceCharge', 'gstTds', 'receivable', 'sdReceived', 'sdDate', 'fpReceived', 'fpDate', 'lppReceived', 'totalReceived', 'outstanding', 'status'],
    }))}
  `;
}

/* -------------------------------------------------------------------------- */
/* 5. collections desk                                                         */
/* -------------------------------------------------------------------------- */

export function payments() {
  const d = derived();
  const open = d.records.filter((r) => r.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding);
  const recent = d.weekly.slice(-10).reverse();

  return `
    <header class="page-head">
      <div><h1 class="page-title">Collections Desk</h1>
        <div class="page-sub">${open.length} lot(s) with an open balance · ${store.adjustments.length} in-session receipt(s) posted</div></div>
      <div class="spacer"></div>
      ${store.adjustments.length ? `<button class="btn sm danger" id="p-reset">${ICON.refresh} Discard session receipts</button>` : ''}
    </header>

    <div class="grid g-side mb-4">
      ${panel('Post a receipt', 'Applies to the lot as a final-payment receipt and re-derives every downstream figure',
        `<div class="stack">
          <div class="field"><label for="pay-lot">Lot</label>
            <select class="input" id="pay-lot">
              ${open.map((r) => `<option value="${r.lot}">Lot ${r.lot} — ${r.buyer} · ₹${fmt0(r.outstanding)} due</option>`).join('')
                || '<option value="">No open lots</option>'}
            </select></div>
          <div class="row">
            <div class="field grow"><label for="pay-amt">Amount (₹)</label><input class="input" id="pay-amt" type="number" min="1" value="${open[0] ? Math.round(open[0].outstanding) : ''}"></div>
            <div class="field grow"><label for="pay-date">Date</label><input class="input" id="pay-date" type="date" value="${asOf()}"></div>
          </div>
          <div class="field"><label for="pay-note">Narration</label><input class="input" id="pay-note" placeholder="NEFT / cheque reference"></div>
          <button class="btn primary" id="pay-go" ${open.length ? '' : 'disabled'}>${ICON.bolt} Post receipt</button>
          <div class="small muted">Receipts are held in memory for this session only — the source CSV is never rewritten.</div>
        </div>`)}
      ${panel('Weekly receipts', 'Most recent ten weeks',
        `<div class="table-wrap" style="max-height:320px"><table class="data">
          <thead><tr><th>Week</th><th>SD</th><th>Final</th><th>LPP</th><th>Total</th></tr></thead>
          <tbody>${recent.map((w) => `<tr><td class="mono">${fmtDate(w.week)}</td>
            <td class="num">₹${fmt0(w.sd)}</td><td class="num">₹${fmt0(w.fp)}</td><td class="num">₹${fmt0(w.lpp)}</td>
            <td class="num"><strong>₹${fmt0(w.total)}</strong></td></tr>`).join('')}</tbody>
        </table></div>`)}
    </div>

    ${store.adjustments.length ? panel('This session', 'Receipts posted since the workspace was opened',
      `<div class="table-wrap"><table class="data">
        <thead><tr><th>Lot</th><th>Buyer</th><th>Amount</th><th>Date</th><th>Narration</th><th></th></tr></thead>
        <tbody>${store.adjustments.map((a, i) => {
          const r = d.records.find((x) => x.lot === a.lot);
          return `<tr><td class="mono">${a.lot}</td><td>${r?.buyer || '—'}</td><td class="num">₹${fmt0(a.amount)}</td>
            <td class="mono">${fmtDate(a.date)}</td><td class="small">${a.note || '—'}</td>
            <td><button class="btn sm ghost" data-undo="${i}">Undo</button></td></tr>`;
        }).join('')}</tbody>
      </table></div>`) : ''}

    ${panel('Dunning queue', 'Open balances ranked by value at risk',
      dataTable(open, { columns: ['lot', 'buyer', 'receivable', 'totalReceived', 'outstanding', 'fpDate', 'invoiceNo', 'status'] }))}
  `;
}

/* -------------------------------------------------------------------------- */
/* 6. invoice reconciliation                                                   */
/* -------------------------------------------------------------------------- */

export function invoices() {
  const d = derived();
  const missing = d.records.filter((r) => !r.invoiceNo || !r.sapDocument || !r.invoiceDate);
  const groups = {};
  for (const i of d.issues) (groups[i.code] ||= []).push(i);
  const codes = Object.keys(groups).sort();

  const severityTone = { high: 'bad', medium: 'warn', low: 'info' };

  return `
    <header class="page-head">
      <div><h1 class="page-title">Invoice Reconciliation</h1>
        <div class="page-sub">${d.issues.length} exception(s) · ${missing.length} lot(s) with incomplete documentation</div></div>
      <div class="spacer"></div>
      <button class="btn sm" id="i-export">${ICON.download} Exception CSV</button>
    </header>

    <div class="grid g-kpi mb-4">
      ${['high', 'medium', 'low'].map((s) => {
        const n = d.issues.filter((i) => i.severity === s).length;
        return kpi({ label: `${s} severity`, value: String(n), foot: `${fmtPct(n / (d.issues.length || 1), 0)} of findings`, progress: n / (d.issues.length || 1), color: s === 'high' ? 'var(--bad)' : s === 'medium' ? 'var(--warn)' : 'var(--info)' });
      }).join('')}
      ${kpi({ label: 'Documentation coverage', value: fmtPct((d.records.length - missing.length) / d.records.length, 1), foot: `${d.records.length - missing.length}/${d.records.length} lots complete`, progress: (d.records.length - missing.length) / d.records.length })}
    </div>

    <div class="grid g-2 mb-4">
      ${panel('Exception categories', 'Count by rule code',
        charts.barChart({ items: codes.map((c) => ({ label: c, value: groups[c].length, color: severityTone[groups[c][0].severity] === 'bad' ? 'var(--bad)' : severityTone[groups[c][0].severity] === 'warn' ? 'var(--warn)' : 'var(--info)' })) }))}
      ${panel('Documentation gaps', 'Lots missing invoice, SAP document or document date',
        `<div class="stack" style="gap:6px">
          ${missing.map((r) => `<button class="btn ghost sm" data-lot="${r.lot}" style="justify-content:space-between;text-align:left">
            <span class="mono">Lot ${r.lot}</span>
            <span class="row" style="gap:4px">
              ${!r.invoiceNo ? '<span class="chip warn">invoice</span>' : ''}
              ${!r.sapDocument ? '<span class="chip warn">SAP</span>' : ''}
              ${!r.invoiceDate ? '<span class="chip warn">date</span>' : ''}
            </span></button>`).join('') || '<div class="empty">Every lot is fully documented.</div>'}
        </div>`)}
    </div>

    ${panel('Full exception log', 'Every rule, every lot',
      `<div class="table-wrap" style="max-height:56vh"><table class="data">
        <thead><tr><th>Lot</th><th>Buyer</th><th>Code</th><th>Severity</th><th>Finding</th></tr></thead>
        <tbody>${d.issues.map((i) => {
          const r = d.records.find((x) => x.lot === i.lot);
          return `<tr tabindex="0" data-lot="${i.lot}">
            <td class="mono">${i.lot}</td><td>${r?.buyer || '—'}</td>
            <td class="mono">${i.code}</td>
            <td><span class="chip ${severityTone[i.severity]}">${i.severity}</span></td>
            <td class="small">${i.message}</td></tr>`;
        }).join('')}</tbody>
      </table></div>`)}
  `;
}

/* -------------------------------------------------------------------------- */
/* 7. risk radar                                                               */
/* -------------------------------------------------------------------------- */

export function risk() {
  const d = derived();
  const bands = ['critical', 'high', 'medium', 'low'];
  const counts = Object.fromEntries(bands.map((b) => [b, d.risk.filter((r) => r.band.id === b).length]));
  const z = zScoreOutliers(d.records, 'materialValue', 1.8);
  const m = madOutliers(d.records, 'materialValue', 3);
  const values = d.records.map((r) => r.materialValue).sort((a, b) => a - b);
  const med = median(values);
  const sd = stddev(d.records.map((r) => r.materialValue));

  return `
    <header class="page-head">
      <div><h1 class="page-title">Risk Radar</h1>
        <div class="page-sub">Composite scoring over balance share, age, documentation and ticket size</div></div>
      <div class="spacer"></div>
      <div class="seg" id="r-metric">
        <button data-v="materialValue" aria-pressed="true">Material value</button>
        <button data-v="receivable" aria-pressed="false">Receivable</button>
        <button data-v="outstanding" aria-pressed="false">Outstanding</button>
      </div>
    </header>

    <div class="grid g-kpi mb-4">
      ${bands.map((b, i) => kpi({
        label: `${b} risk`, value: String(counts[b]),
        foot: `${fmtPct(counts[b] / d.records.length, 0)} of ${d.records.length} lots`,
        progress: counts[b] / d.records.length,
        color: ['var(--bad)', 'var(--warn)', 'var(--info)', 'var(--good)'][i],
      })).join('')}
    </div>

    <div class="grid g-side mb-4">
      ${panel('Score distribution', 'Lots plotted by composite risk score',
        charts.heatStrip({
          items: d.risk.map((r) => ({ label: `Lot ${r.record.lot} · ${r.record.buyer} · score ${r.score}`, value: r.score, color: r.score >= 60 ? 'var(--bad)' : r.score >= 35 ? 'var(--warn)' : 'var(--good)' })),
          columns: 19,
        }))}
      ${panel('Descriptive statistics', 'Material value across the book',
        `<dl class="kv">
          <dt>Mean</dt><dd>₹${fmt0(average(values))}</dd>
          <dt>Median</dt><dd>₹${fmt0(med)}</dd>
          <dt>Std deviation</dt><dd>₹${fmt0(sd)}</dd>
          <dt>Coefficient of variation</dt><dd>${fmtPct(sd / average(values), 1)}</dd>
          <dt>Minimum</dt><dd>₹${fmt0(values[0])}</dd>
          <dt>Maximum</dt><dd>₹${fmt0(values[values.length - 1])}</dd>
          <dt>z-score outliers (|z|≥1.8)</dt><dd>${z.length}</dd>
          <dt>MAD outliers (|M|≥3)</dt><dd>${m.length}</dd>
        </dl>`)}
    </div>

    <div class="grid g-2 mb-4">
      ${panel('z-score outliers', 'Deviation from the mean in standard deviations',
        charts.barChart({ items: z.slice(0, 10).map((o) => ({ label: `Lot ${o.record.lot}`, value: Number(o.z.toFixed(2)), color: o.z > 0 ? 'var(--accent)' : 'var(--accent-3)' })), valueFormat: (v) => v.toFixed(2) }))}
      ${panel('Ranked risk', 'Top ten composite scores',
        charts.barChart({ items: d.risk.slice(0, 10).map((r) => ({ label: `Lot ${r.record.lot}`, value: r.score, color: r.score >= 60 ? 'var(--bad)' : r.score >= 35 ? 'var(--warn)' : 'var(--good)' })), valueFormat: (v) => String(Math.round(v)) }))}
    </div>

    ${panel('Scored ledger', 'Highest risk first',
      `<div class="table-wrap"><table class="data">
        <thead><tr><th>Lot</th><th>Buyer</th><th>Score</th><th>Band</th><th>Outstanding</th><th>Age (days)</th><th>Invoice</th><th>SAP</th><th>Status</th></tr></thead>
        <tbody>${d.risk.map((x) => {
          const r = x.record;
          const days = ageInDays(r, asOf());
          return `<tr tabindex="0" data-lot="${r.lot}">
            <td class="mono">${r.lot}</td><td>${r.buyer}</td>
            <td class="num"><strong>${x.score}</strong></td>
            <td><span class="chip ${x.band.id === 'critical' || x.band.id === 'high' ? 'bad' : x.band.id === 'medium' ? 'warn' : 'good'}">${x.band.label}</span></td>
            <td class="num">₹${fmt0(r.outstanding)}</td>
            <td class="num">${days === null ? '—' : days}</td>
            <td>${r.invoiceNo ? `<span class="mono">${r.invoiceNo}</span>` : '<span class="chip warn">—</span>'}</td>
            <td>${r.sapDocument ? `<span class="mono">${r.sapDocument}</span>` : '<span class="chip warn">—</span>'}</td>
            <td><span class="chip ${r.status === 'SETTLED' ? 'good' : 'bad'}">${r.status}</span></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`)}
  `;
}

/* -------------------------------------------------------------------------- */
/* 8. forecast lab                                                             */
/* -------------------------------------------------------------------------- */

export function forecast() {
  const d = derived();
  const t = d.totals;
  const daily = d.series.map((p) => ({ date: p.date, value: p.received }));
  const deltas = [];
  for (let i = 1; i < daily.length; i++) deltas.push({ date: daily[i].date, value: daily[i].value - daily[i - 1].value });

  const weeklyVals = d.weekly.map((w) => ({ period: w.week, value: w.total }));
  const holt = holtForecast(weeklyVals, 6);
  const seasonal = seasonalForecast(deltas.filter((x) => x.value > 0), 14);

  const remaining = Math.max(0, t.fpOutstanding);
  const recentRate = average(d.weekly.slice(-6).map((w) => w.total)) || 1;
  const weeksToClear = remaining / recentRate;

  const projected = [];
  let run = t.totalReceived;
  for (const h of holt) { run += h.value; projected.push({ date: `T+${h.period}w`, value: Math.min(run, t.receivable) }); }

  return `
    <header class="page-head">
      <div><h1 class="page-title">Forecast Lab</h1>
        <div class="page-sub">Two independent projection models over the observed receipt history</div></div>
    </header>

    <div class="grid g-kpi mb-4">
      ${kpi({ label: 'Balance to collect', value: `₹${fmtCompact(remaining)}`, foot: 'Final-payment entitlement less receipts', color: 'var(--bad)' })}
      ${kpi({ label: 'Recent run rate', value: `₹${fmtCompact(recentRate)}`, foot: 'mean of the last six weeks' })}
      ${kpi({ label: 'Weeks to clear', value: weeksToClear.toFixed(1), foot: 'at the current run rate', progress: Math.min(1, 6 / (weeksToClear || 1)), color: 'var(--accent-3)' })}
      ${kpi({ label: 'Projected recovery', value: fmtPct(Math.min(1, projected.at(-1)?.value / t.receivable || 0), 2), foot: 'after six forecast weeks', color: 'var(--good)' })}
    </div>

    <div class="grid g-2 mb-4">
      ${panel('Holt linear projection', `Double exponential smoothing, α=0.40 β=0.25, six weeks ahead`,
        charts.columnChart({
          labels: projected.map((p) => p.date),
          series: [{ id: 'v', label: 'Cumulative received', color: '#22d3ee', values: projected.map((p) => p.value) }],
          stacked: false, height: 250,
        }),
        `<div class="small muted">Receivable ceiling ₹${fmt0(t.receivable)}</div>`)}
      ${panel('Seasonal daily projection', 'Weekday-shaped naive seasonal model over the last 14 days',
        charts.areaChart({
          labels: seasonal.map((s) => s.date),
          series: [{ color: '#a855f7', values: seasonal.map((s) => s.value) }],
          height: 250, showPoints: true,
        }))}
    </div>

    ${panel('Model comparison', 'Observed history against both forecasts',
      charts.areaChart({
        labels: [...d.weekly.map((w) => w.week), ...holt.map((h) => `T+${h.period}w`)],
        series: [
          { color: '#4f7cff', values: [...d.weekly.map((w) => w.total), ...holt.map(() => 0)] },
          { color: '#22d3ee', values: [...d.weekly.map(() => 0), ...holt.map((h) => h.value)] },
        ],
        height: 280,
      }),
      `<div class="legend"><span><i style="background:#4f7cff"></i>Observed weekly receipts</span><span><i style="background:#22d3ee"></i>Holt forecast</span></div>`)}

    ${panel('Assumption transparency', 'What the models are actually doing',
      `<div class="grid g-3">
        <div><div class="panel-title">Holt linear</div><div class="small muted mt-2">Fits a level and a trend over weekly receipts, then extrapolates the trend. Sensitive to the last two observations; with ${d.weekly.length} weeks of history the trend term is still noisy.</div></div>
        <div><div class="panel-title">Seasonal naive</div><div class="small muted mt-2">Averages daily receipts by day-of-week and repeats the pattern. Captures the banking-week rhythm but assumes the book behaves like the past fortnight.</div></div>
        <div><div class="panel-title">Known limits</div><div class="small muted mt-2">Both models see only realised cash. They cannot see pending invoices, disputed lots, or the LPP accrual, which grows until a final payment date is recorded.</div></div>
      </div>`)}
  `;
}

/* -------------------------------------------------------------------------- */
/* 9. scenario forge                                                           */
/* -------------------------------------------------------------------------- */

export function scenario() {
  const a = store.ui.simulate;
  const sim = simulate(effectiveRecords(), a);
  const b = sim.base, n = sim.next;

  const rows = [
    ['Total receivable', b.receivable, n.receivable],
    ['Security deposit received', b.sdReceived, n.sdReceived],
    ['Final payment received', b.fpReceived, n.fpReceived],
    ['Total received', b.totalReceived, n.totalReceived],
    ['Outstanding', b.outstanding, n.outstanding],
    ['LPP expected', b.lppExpected, n.lppExpected],
  ];

  return `
    <header class="page-head">
      <div><h1 class="page-title">Scenario Forge</h1>
        <div class="page-sub">Re-derive the whole book under alternative recovery assumptions · as-of ${fmtDate(sim.asOf)}</div></div>
      <div class="spacer"></div>
      <button class="btn sm ghost" id="s-reset">${ICON.refresh} Reset assumptions</button>
    </header>

    <div class="grid g-side mb-4">
      ${panel('Assumptions', 'Every slider recomputes the ledger instantly',
        `<div class="stack">
          ${slider('sd', 'Security deposit collection', a.sdCollectionRate, 0, 1.2, 0.01, fmtPct)}
          ${slider('fp', 'Final payment collection', a.fpCollectionRate, 0, 1.2, 0.01, fmtPct)}
          ${slider('lpp', 'LPP waiver', a.lppWaiver, 0, 1, 0.01, fmtPct)}
          ${slider('days', 'Run the clock forward (days)', a.additionalDays, 0, 180, 1, (v) => `${Math.round(v)} d`)}
          ${slider('thr', 'Settlement tolerance (₹)', a.settleThreshold, 0, 5000, 50, (v) => `₹${fmt0(v)}`)}
          <div class="divider"></div>
          <div class="small muted">LPP waiver reduces the accrued penalty; running the clock forward re-accrues it for lots without a recorded final-payment date.</div>
        </div>`)}
      ${panel('Impact', 'Baseline versus scenario',
        `<dl class="kv">
          <dt>Outstanding</dt><dd style="color:${sim.delta.outstanding <= 0 ? 'var(--good)' : 'var(--bad)'}">${sim.delta.outstanding <= 0 ? '−' : '+'}₹${fmt0(Math.abs(sim.delta.outstanding))}</dd>
          <dt>Cash collected</dt><dd style="color:var(--good)">+₹${fmt0(Math.max(0, sim.delta.received))}</dd>
          <dt>Lots newly settled</dt><dd>${sim.delta.settled >= 0 ? '+' : ''}${sim.delta.settled}</dd>
          <dt>Recovery rate</dt><dd>${fmtPct(b.recoveryRate, 2)} → ${fmtPct(n.recoveryRate, 2)}</dd>
          <dt>Open lots</dt><dd>${b.outstandingLots} → ${n.outstandingLots}</dd>
        </dl>
        <div class="divider"></div>
        ${charts.donut({
          slices: [
            { label: 'Collected', value: n.totalReceived, color: '#2ee6a8' },
            { label: 'Still open', value: Math.max(0, n.outstanding), color: '#ff5d7e' },
          ],
          centreValue: fmtPct(n.recoveryRate, 1), centreLabel: 'recovery', size: 190,
        })}`)}
    </div>

    ${panel('Line-by-line comparison', 'Baseline on the left, scenario on the right',
      `<div class="table-wrap"><table class="data">
        <thead><tr><th>Metric</th><th>Baseline</th><th>Scenario</th><th>Δ</th><th>Shift</th></tr></thead>
        <tbody>${rows.map(([label, x, y]) => {
          const delta = y - x;
          const pct = x ? delta / Math.abs(x) : 0;
          return `<tr><td>${label}</td><td class="num">₹${fmt0(x)}</td><td class="num"><strong>₹${fmt0(y)}</strong></td>
            <td class="num" style="color:${label === 'Outstanding' ? (delta <= 0 ? 'var(--good)' : 'var(--bad)') : 'var(--text-dim)'}">${delta >= 0 ? '+' : '−'}₹${fmt0(Math.abs(delta))}</td>
            <td><div class="progress" style="min-width:110px"><i style="width:${Math.min(100, Math.abs(pct) * 100).toFixed(1)}%"></i></div></td></tr>`;
        }).join('')}</tbody>
      </table></div>`)}

    ${panel('Scenario ledger', 'The book as it would stand',
      dataTable(sim.rows, { sorted: false, columns: ['lot', 'buyer', 'receivable', 'totalReceived', 'outstanding', 'status'] }))}
  `;
}

function slider(id, label, value, min, max, step, fmt) {
  return `<div class="field">
    <div class="between"><label for="s-${id}">${label}</label><strong class="tabular">${fmt(value)}</strong></div>
    <input class="input" type="range" id="s-${id}" min="${min}" max="${max}" step="${step}" value="${value}" data-sim="${id}">
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* 10. audit & settings                                                        */
/* -------------------------------------------------------------------------- */

export function audit() {
  const d = derived();
  const t = d.totals;
  const counts = {};
  for (const i of d.issues) counts[i.code] = (counts[i.code] || 0) + 1;

  return `
    <header class="page-head">
      <div><h1 class="page-title">Audit &amp; Settings</h1>
        <div class="page-sub">Session trail, preferences and data lineage</div></div>
      <div class="spacer"></div>
      <button class="btn sm" id="a-json">${ICON.download} Export trail (JSON)</button>
    </header>

    <div class="grid g-2 mb-4">
      ${panel('Preferences', 'Applied instantly, no reload',
        `<div class="stack">
          <label class="switch"><input type="checkbox" id="set-theme" ${store.ui.theme === 'light' ? 'checked' : ''}><i></i>Light surface</label>
          <label class="switch"><input type="checkbox" id="set-density" ${store.ui.density === 'compact' ? 'checked' : ''}><i></i>Compact density</label>
          <label class="switch"><input type="checkbox" id="set-rail" ${store.ui.rail ? 'checked' : ''}><i></i>Collapsed sidebar</label>
          <div class="field"><label for="set-asof">As-of date for ageing and penalties</label>
            <input class="input" type="date" id="set-asof" value="${asOf()}"></div>
          <div class="divider"></div>
          <div class="small muted">Keyboard: <span class="kbd">⌘K</span> or <span class="kbd">/</span> opens the command bar · <span class="kbd">esc</span> closes any overlay.</div>
        </div>`)}
      ${panel('Data lineage', 'Where every number in this workspace comes from',
        `<dl class="kv">
          <dt>Source file</dt><dd class="mono">saas/data/receivables.csv</dd>
          <dt>Rows parsed</dt><dd>${d.records.length}</dd>
          <dt>Columns</dt><dd>${Object.keys(FIELDS).length}</dd>
          <dt>Distinct buyers</dt><dd>${d.buyers.length}</dd>
          <dt>Total receivable</dt><dd>₹${fmt0(t.receivable)}</dd>
          <dt>Total received</dt><dd>₹${fmt0(t.totalReceived)}</dd>
          <dt>Outstanding</dt><dd>₹${fmt0(t.outstanding)}</dd>
          <dt>Session receipts</dt><dd>${store.adjustments.length}</dd>
          <dt>Signed in as</dt><dd>${store.session?.user || '—'}</dd>
          <dt>Session started</dt><dd class="mono">${store.session ? new Date(store.session.at).toLocaleTimeString('en-IN') : '—'}</dd>
        </dl>
        <div class="divider"></div>
        <div class="small muted">Contract rates applied: SD 25% of material value · final payment 92.65% less GST TDS · LPP 1.18% per started week. All per-lot rounding is half-away-from-zero, matching the source workbook.</div>`)}
    </div>

    ${panel('Session audit trail', `${store.audit.length} event(s), newest first`,
      `<div class="table-wrap" style="max-height:48vh"><table class="data">
        <thead><tr><th>#</th><th>Time</th><th>User</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>${store.audit.map((e) => `<tr>
          <td class="mono">${e.id}</td><td class="mono">${new Date(e.at).toLocaleTimeString('en-IN')}</td>
          <td>${e.user}</td><td><span class="chip violet">${e.action}</span></td><td class="small">${e.detail}</td>
        </tr>`).join('')}</tbody>
      </table></div>`)}
  `;
}

/* -------------------------------------------------------------------------- */
/* route table + post-render wiring                                            */
/* -------------------------------------------------------------------------- */

export const PAGES = {
  dashboard, aging, buyers, lots, payments, invoices, risk, forecast,
  simulate: scenario, audit,
};

export function mount(route, root) {
  // global row drill-down
  root.querySelectorAll('[data-lot]').forEach((el) => {
    if (el.dataset.bound) return;
    el.dataset.bound = '1';
    const open = (e) => { e.stopPropagation(); showLot(el.dataset.lot); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
  });

  if (route === 'dashboard') {
    root.querySelector('#as-of')?.addEventListener('change', (e) => setAsOf(e.target.value));
    root.querySelector('#d-pay')?.addEventListener('click', () => navigate('payments'));
    root.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => navigate(b.dataset.goto)));
  }

  if (route === 'aging') {
    root.querySelectorAll('#age-scale button').forEach((b) => (b.onclick = () => {
      root.querySelectorAll('#age-scale button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      toast(`${b.dataset.v === 'share' ? 'Share' : 'Linear'} scale — the chart is drawn on a linear value axis`, 'info');
    }));
  }

  if (route === 'buyers') {
    root.querySelectorAll('tr[data-buyer]').forEach((tr) => {
      tr.onclick = () => { store.filter.buyers = [tr.dataset.buyer]; navigate('lots'); toast(`Filtered to ${tr.dataset.buyer}`, 'info'); };
    });
    root.querySelector('#b-export')?.addEventListener('click', () => {
      const rows = byBuyer(effectiveRecords());
      const head = 'Buyer,Lots,Material Value,Receivable,Received,Outstanding,Recovery Rate,Settled\n';
      const body = rows.map((r) => [r.buyer, r.count, r.materialValue, r.receivable, r.totalReceived, r.outstanding, r.recoveryRate.toFixed(4), r.settled].join(',')).join('\n');
      download(`nebula-ar-buyers-${iso(new Date())}.csv`, head + body);
      toast('Buyer summary exported', 'good');
    });
  }

  if (route === 'lots') { wireFilterBar(root); wireTable(root); }

  if (route === 'payments') {
    const lotSel = root.querySelector('#pay-lot');
    const amt = root.querySelector('#pay-amt');
    lotSel?.addEventListener('change', () => {
      const r = derived().records.find((x) => x.lot === Number(lotSel.value));
      if (r && amt) amt.value = Math.max(0, Math.round(r.outstanding));
    });
    root.querySelector('#pay-go')?.addEventListener('click', () => {
      try {
        promptPayment(Number(lotSel.value));
      } catch (e) { toast(e.message, 'bad'); }
    });
    root.querySelector('#p-reset')?.addEventListener('click', () => {
      const n = resetAdjustments();
      toast(`${n} session receipt(s) discarded`, 'warn');
    });
    root.querySelectorAll('[data-undo]').forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.undo);
      const [gone] = store.adjustments.splice(i, 1);
      logAudit('PAYMENT_UNDONE', `Lot ${gone.lot} · ₹${fmt0(gone.amount)}`);
      toast(`Receipt for lot ${gone.lot} reversed`, 'warn');
      notify();
    }));
  }

  if (route === 'invoices') {
    root.querySelector('#i-export')?.addEventListener('click', () => {
      const head = 'Lot,Buyer,Code,Severity,Finding\n';
      const body = derived().issues.map((i) => {
        const r = derived().records.find((x) => x.lot === i.lot);
        return [i.lot, `"${r?.buyer || ''}"`, i.code, i.severity, `"${i.message.replace(/"/g, '""')}"`].join(',');
      }).join('\n');
      download(`nebula-ar-exceptions-${iso(new Date())}.csv`, head + body);
      toast('Exception log exported', 'good');
    });
  }

  if (route === 'risk') {
    root.querySelectorAll('#r-metric button').forEach((b) => (b.onclick = () => {
      root.querySelectorAll('#r-metric button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      store.sort = { key: b.dataset.v, dir: 'desc' };
      toast(`Outlier metric set to ${FIELDS[b.dataset.v].label}`, 'info');
      notify();
    }));
  }

  if (route === 'simulate') {
    root.querySelectorAll('[data-sim]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const key = inp.dataset.sim;
        const map = { sd: 'sdCollectionRate', fp: 'fpCollectionRate', lpp: 'lppWaiver', days: 'additionalDays', thr: 'settleThreshold' };
        store.ui.simulate[map[key]] = Number(inp.value);
        notify();
      });
    });
    root.querySelector('#s-reset')?.addEventListener('click', () => {
      store.ui.simulate = { sdCollectionRate: 1, fpCollectionRate: 1, lppWaiver: 0, additionalDays: 0, settleThreshold: 5 };
      notify();
      toast('Assumptions reset to baseline', 'info');
    });
  }

  if (route === 'audit') {
    root.querySelector('#set-theme')?.addEventListener('change', toggleTheme);
    root.querySelector('#set-density')?.addEventListener('change', toggleDensity);
    root.querySelector('#set-rail')?.addEventListener('change', () => { store.ui.rail = !store.ui.rail; document.querySelector('.app').dataset.rail = String(store.ui.rail); notify(); });
    root.querySelector('#set-asof')?.addEventListener('change', (e) => setAsOf(e.target.value));
    root.querySelector('#a-json')?.addEventListener('click', exportAudit);
  }
}
