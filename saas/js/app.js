/* ============================================================================
 * NEBULA AR — app.js
 * Store, router, shell chrome (sidebar / topbar / palette / toasts / drawer).
 * ==========================================================================*/

import { CSV } from './data.js';
import {
  parseReceivables, totals, byBuyer, ageingByBuyer, cumulativeSeries, weeklyCollections,
  auditRecords, riskScore, riskBand, iso, fmt0, fmtCompact, fmtPct, fmtDate,
  searchRecords, fuzzyScore, sortRecords, simulate,
} from './domain.js';
import * as charts from './charts.js';
import * as views from './views.js';

/* -------------------------------------------------------------------------- */
/* state                                                                       */
/* -------------------------------------------------------------------------- */

const AS_OF = '2026-09-12';

export const store = {
  records: [],
  adjustments: [],          // user payments recorded in-session
  audit: [],                // audit trail of app actions
  alerts: [],
  filter: { buyers: [], statuses: [], minOutstanding: null, query: '', missingInvoice: false, riskBand: null, asOf: AS_OF },
  sort: { key: 'outstanding', dir: 'desc' },
  session: null,
  ui: {
    rail: false, theme: 'dark', density: 'comfortable', route: 'dashboard',
    paletteOpen: false, drawer: null, modal: null,
    simulate: { sdCollectionRate: 1, fpCollectionRate: 1, lppWaiver: 0, additionalDays: 0, settleThreshold: 5 },
  },
  _subs: new Set(),
};

export const asOf = () => store.filter.asOf || AS_OF;

export function subscribe(fn) { store._subs.add(fn); return () => store._subs.delete(fn); }

export function notify() { for (const fn of store._subs) fn(); }

export function logAudit(action, detail) {
  store.audit.unshift({
    id: `A${store.audit.length + 1}`,
    at: new Date().toISOString(),
    user: store.session?.user || 'system',
    action, detail,
  });
  if (store.audit.length > 300) store.audit.length = 300;
}

/* -------------------------------------------------------------------------- */
/* derived data (recomputed lazily, memoised on record identity)               */
/* -------------------------------------------------------------------------- */

let _cache = { key: null, value: null };

export function derived() {
  const key = `${store.records.length}|${store.adjustments.length}|${asOf()}`;
  if (_cache.key === key) return _cache.value;
  const records = effectiveRecords();
  const value = {
    records,
    totals: totals(records),
    buyers: byBuyer(records),
    ageing: ageingByBuyer(records, asOf()),
    series: cumulativeSeries(records, asOf()),
    weekly: weeklyCollections(records, asOf()),
    issues: auditRecords(records, asOf()),
    risk: records.map((r) => ({ record: r, score: riskScore(r, asOf()), band: riskBand(riskScore(r, asOf())) }))
      .sort((a, b) => b.score - a.score),
  };
  _cache = { key, value };
  return value;
}

/** Applies in-session payment adjustments on top of the source records. */
export function effectiveRecords() {
  if (!store.adjustments.length) return store.records;
  const map = new Map(store.adjustments.map((a) => [a.lot, a]));
  return store.records.map((r) => {
    const adj = map.get(r.lot);
    if (!adj) return r;
    const totalReceived = r.totalReceived + adj.amount;
    const outstanding = r.receivable - totalReceived;
    return {
      ...r,
      fpReceived: r.fpReceived + adj.amount,
      fpDate: r.fpDate || adj.date,
      totalReceived,
      outstanding,
      status: outstanding <= 5 ? 'SETTLED' : 'OUTSTANDING',
    };
  });
}

export function recordPayment({ lot, amount, date, note }) {
  const rec = store.records.find((r) => r.lot === Number(lot));
  if (!rec) throw new Error(`Unknown lot ${lot}`);
  if (!(amount > 0)) throw new Error('Amount must be greater than zero');
  store.adjustments.push({ lot: Number(lot), amount, date: date || asOf(), note: note || '' });
  _cache = { key: null, value: null };
  logAudit('PAYMENT_RECORDED', `Lot ${lot} · ₹${fmt0(amount)} on ${date || asOf()}`);
  notify();
  return rec;
}

export function resetAdjustments() {
  const n = store.adjustments.length;
  store.adjustments = [];
  _cache = { key: null, value: null };
  logAudit('ADJUSTMENTS_RESET', `${n} in-session payment(s) discarded`);
  notify();
  return n;
}

/* -------------------------------------------------------------------------- */
/* icons                                                                       */
/* -------------------------------------------------------------------------- */

const P = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const ICON = {
  dashboard: P('<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>'),
  aging: P('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  buyers: P('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>'),
  lots: P('<path d="M3 6h18M3 12h18M3 18h18"/>'),
  payments: P('<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20"/>'),
  invoices: P('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>'),
  forecast: P('<path d="M3 17l6-6 4 4 8-8"/><path d="M21 7v5h-5"/>'),
  risk: P('<path d="M12 2 2 20h20z"/><path d="M12 9v5M12 17.5v.5"/>'),
  simulate: P('<path d="M4 4h16v16H4z"/><path d="M4 9h16M9 4v16"/>'),
  audit: P('<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>'),
  settings: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 7 2.6h.1A1.7 1.7 0 0 0 8.3 1V1a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 2.6a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  search: P('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  bell: P('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
  close: P('<path d="M18 6 6 18M6 6l12 12"/>'),
  download: P('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>'),
  refresh: P('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>'),
  check: P('<path d="M20 6 9 17l-5-5"/>'),
  alert: P('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.5"/>'),
  info: P('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>'),
  bolt: P('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  sun: P('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: P('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  menu: P('<path d="M3 6h18M3 12h18M3 18h18"/>'),
  arrowUp: P('<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>'),
  arrowDown: P('<path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/>'),
  filter: P('<path d="M3 4h18l-7 8v7l-4 2v-9z"/>'),
  logo: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 15a8 8 0 0 1 16 0" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="15" r="2.6" fill="#fff"/><path d="M12 12V4M12 4l3.2 3M12 4 8.8 7" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 19h19" stroke="#fff" stroke-width="1.4" stroke-linecap="round" opacity=".55"/></svg>`,
};

/* -------------------------------------------------------------------------- */
/* navigation                                                                  */
/* -------------------------------------------------------------------------- */

export const ROUTES = [
  { id: 'dashboard', label: 'Command Deck', icon: 'dashboard', group: 'Insight', desc: 'Portfolio health at a glance' },
  { id: 'aging', label: 'Ageing Matrix', icon: 'aging', group: 'Insight', desc: 'Receivables bucketed by days outstanding' },
  { id: 'buyers', label: 'Buyer Intelligence', icon: 'buyers', group: 'Insight', desc: 'Exposure and behaviour per counterparty' },
  { id: 'forecast', label: 'Forecast Lab', icon: 'forecast', group: 'Insight', desc: 'Projection models and collection runway' },
  { id: 'lots', label: 'Lot Register', icon: 'lots', group: 'Operate', desc: 'Every lot, filterable and exportable' },
  { id: 'payments', label: 'Collections Desk', icon: 'payments', group: 'Operate', desc: 'Record receipts and watch the ledger move' },
  { id: 'invoices', label: 'Invoice Recon', icon: 'invoices', group: 'Operate', desc: 'Document gaps and data-quality exceptions' },
  { id: 'risk', label: 'Risk Radar', icon: 'risk', group: 'Operate', desc: 'Composite scoring and anomaly detection' },
  { id: 'simulate', label: 'Scenario Forge', icon: 'simulate', group: 'Operate', desc: 'What-if the recovery assumptions' },
  { id: 'audit', label: 'Audit & Settings', icon: 'audit', group: 'Govern', desc: 'Trail, preferences and data lineage' },
];

export function navigate(route) {
  if (!ROUTES.some((r) => r.id === route)) return;
  store.ui.route = route;
  if (location.hash !== `#/${route}`) location.hash = `#/${route}`;
  logAudit('NAVIGATE', route);
  notify();
  document.querySelector('.viewport')?.scrollTo({ top: 0 });
}

function syncHash() {
  const m = location.hash.match(/^#\/([a-z]+)/);
  const route = m ? m[1] : 'dashboard';
  if (route !== store.ui.route && ROUTES.some((r) => r.id === route)) {
    store.ui.route = route;
    notify();
  }
}

/* -------------------------------------------------------------------------- */
/* toasts                                                                      */
/* -------------------------------------------------------------------------- */

export function toast(message, kind = 'info', ms = 3600) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${ICON[kind === 'good' ? 'check' : kind === 'bad' ? 'alert' : kind === 'warn' ? 'alert' : 'info']}<span>${message}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 240);
  }, ms);
}

/* -------------------------------------------------------------------------- */
/* drawer + modal                                                              */
/* -------------------------------------------------------------------------- */

export function openDrawer(html, onMount) {
  closeOverlays();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.onclick = closeOverlays;
  const drawer = document.createElement('aside');
  drawer.className = 'drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.innerHTML = html;
  document.body.append(scrim, drawer);
  store.ui.drawer = { scrim, drawer };
  drawer.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeOverlays));
  onMount?.(drawer);
  drawer.querySelector('[data-autofocus]')?.focus();
}

export function openModal(html, onMount) {
  closeOverlays();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.onclick = closeOverlays;
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.innerHTML = html;
  document.body.append(scrim, modal);
  store.ui.modal = { scrim, modal };
  modal.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeOverlays));
  onMount?.(modal);
  modal.querySelector('[data-autofocus]')?.focus();
}

export function closeOverlays() {
  document.querySelectorAll('.scrim, .drawer, .modal').forEach((n) => n.remove());
  store.ui.drawer = null;
  store.ui.modal = null;
}

/* -------------------------------------------------------------------------- */
/* lot detail drawer                                                           */
/* -------------------------------------------------------------------------- */

export function showLot(lot) {
  const r = derived().records.find((x) => x.lot === Number(lot));
  if (!r) return;
  const score = riskScore(r, asOf());
  const band = riskBand(score);
  const issues = derived().issues.filter((i) => i.lot === r.lot);
  const pct = r.receivable ? r.totalReceived / r.receivable : 0;

  const events = [
    r.invoiceDate && { date: r.invoiceDate, title: 'Invoice raised', meta: `${r.invoiceNo || 'no invoice number'} · SAP ${r.sapDocument || '—'}` },
    r.sdDate && { date: r.sdDate, title: 'Security deposit received', meta: `₹${fmt0(r.sdReceived)} (25% of material value)` },
    r.fpDate && { date: r.fpDate, title: 'Final payment received', meta: `₹${fmt0(r.fpReceived)}` },
    r.lppDate && { date: r.lppDate, title: 'Late payment penalty settled', meta: `₹${fmt0(r.lppReceived)}` },
    !r.fpDate && { date: null, title: 'Final payment outstanding', meta: `₹${fmt0(Math.max(0, r.outstanding))} still due`, pending: true },
  ].filter(Boolean).sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : 1);

  openDrawer(`
    <div class="drawer-head">
      <div class="grow">
        <div class="row" style="gap:8px">
          <h2 style="font-size:19px">Lot ${r.lot}</h2>
          <span class="chip ${r.status === 'SETTLED' ? 'good' : 'bad'}">${r.status}</span>
          <span class="chip ${band.id === 'critical' || band.id === 'high' ? 'bad' : band.id === 'medium' ? 'warn' : 'good'}">Risk ${score} · ${band.label}</span>
        </div>
        <div class="panel-sub">${r.buyer}</div>
      </div>
      <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button>
    </div>
    <div class="drawer-body">
      <div class="panel">
        <div class="between mb-2">
          <div><div class="panel-sub">Collected</div><div style="font-size:22px;font-weight:700">₹${fmt0(r.totalReceived)}</div></div>
          <div style="text-align:right"><div class="panel-sub">Outstanding</div><div style="font-size:22px;font-weight:700;color:${r.outstanding > 0 ? 'var(--bad)' : 'var(--good)'}">₹${fmt0(r.outstanding)}</div></div>
        </div>
        <div class="progress ${pct >= 0.999 ? 'good' : ''}"><i style="width:${Math.min(100, pct * 100).toFixed(1)}%"></i></div>
        <div class="small muted mt-2">${fmtPct(pct, 2)} of ₹${fmt0(r.receivable)} receivable</div>
      </div>

      <div class="panel">
        <div class="panel-title mb-2">Commercial build-up</div>
        <dl class="kv">
          <dt>Material value</dt><dd>₹${fmt0(r.materialValue)}</dd>
          <dt>Service charge to MSTC</dt><dd>₹${fmt0(r.serviceCharge)}</dd>
          <dt>GST TDS</dt><dd>₹${fmt0(r.gstTds)}</dd>
          <dt>Total receivables in cash</dt><dd><strong>₹${fmt0(r.receivable)}</strong></dd>
          <dt>Security deposit</dt><dd>₹${fmt0(r.sdReceived)} <span class="muted">/ exp ₹${fmt0(Math.round(r.materialValue * 0.25))}</span></dd>
          <dt>Final payment</dt><dd>₹${fmt0(r.fpReceived)} <span class="muted">/ exp ₹${fmt0(Math.round(r.materialValue * 0.9265 - r.gstTds))}</span></dd>
          <dt>LPP</dt><dd>₹${fmt0(r.lppReceived)} <span class="muted">/ exp ₹${fmt0(r.lppExpected)}</span></dd>
        </dl>
      </div>

      <div class="panel">
        <div class="panel-title mb-2">Document trail</div>
        <dl class="kv">
          <dt>Invoice no.</dt><dd>${r.invoiceNo ? `<span class="mono">${r.invoiceNo}</span>` : '<span class="chip warn">missing</span>'}</dd>
          <dt>SAP document</dt><dd>${r.sapDocument ? `<span class="mono">${r.sapDocument}</span>` : '<span class="chip warn">missing</span>'}</dd>
          <dt>Document date</dt><dd>${r.invoiceDate ? fmtDate(r.invoiceDate) : '<span class="chip warn">missing</span>'}</dd>
        </dl>
      </div>

      <div class="panel">
        <div class="panel-title mb-4">Timeline</div>
        <div class="timeline">
          ${events.map((e) => `<div class="tl-item ${e.pending ? 'pending' : ''}">
            <div class="tl-title">${e.title}</div>
            <div class="tl-meta">${e.date ? fmtDate(e.date) : 'pending'} · ${e.meta}</div>
          </div>`).join('')}
        </div>
      </div>

      ${issues.length ? `<div class="panel">
        <div class="panel-title mb-2">${ICON.alert} Exceptions (${issues.length})</div>
        <ul class="stack" style="gap:6px">
          ${issues.map((i) => `<li class="small"><span class="chip ${i.severity === 'high' ? 'bad' : i.severity === 'medium' ? 'warn' : 'info'}">${i.code}</span> ${i.message}</li>`).join('')}
        </ul>
      </div>` : ''}
    </div>
    <div class="drawer-foot">
      <button class="btn ghost" data-close>Close</button>
      <button class="btn primary" data-pay="${r.lot}">${ICON.bolt} Record payment</button>
    </div>
  `, (drawer) => {
    drawer.querySelector('[data-pay]')?.addEventListener('click', () => {
      closeOverlays();
      promptPayment(r.lot);
    });
  });
}

export function promptPayment(lot) {
  const r = derived().records.find((x) => x.lot === Number(lot));
  if (!r) return;
  openModal(`
    <div class="drawer-head">
      <div class="grow"><h2 style="font-size:17px">Record receipt · Lot ${r.lot}</h2>
      <div class="panel-sub">${r.buyer} · outstanding ₹${fmt0(Math.max(0, r.outstanding))}</div></div>
      <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button>
    </div>
    <div class="drawer-body">
      <div class="field"><label for="p-amt">Amount received (₹)</label>
        <input class="input" id="p-amt" type="number" min="1" step="1" value="${Math.max(0, r.outstanding)}" data-autofocus></div>
      <div class="field"><label for="p-date">Receipt date</label>
        <input class="input" id="p-date" type="date" value="${asOf()}"></div>
      <div class="field"><label for="p-note">Narration</label>
        <input class="input" id="p-note" placeholder="NEFT ref / cheque no."></div>
    </div>
    <div class="drawer-foot">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" id="p-save">${ICON.check} Post receipt</button>
    </div>
  `, (modal) => {
    modal.querySelector('#p-save').onclick = () => {
      const amount = Number(modal.querySelector('#p-amt').value);
      const date = modal.querySelector('#p-date').value;
      const note = modal.querySelector('#p-note').value;
      try {
        recordPayment({ lot: r.lot, amount, date, note });
        closeOverlays();
        toast(`Receipt of ₹${fmt0(amount)} posted against lot ${r.lot}`, 'good');
      } catch (e) {
        toast(e.message, 'bad');
      }
    };
  });
}

/* -------------------------------------------------------------------------- */
/* command palette                                                             */
/* -------------------------------------------------------------------------- */

const ACTIONS = [
  ...ROUTES.map((r) => ({ kind: 'Navigate', label: r.label, hint: r.desc, icon: r.icon, run: () => navigate(r.id) })),
  { kind: 'Action', label: 'Record a payment', hint: 'Post a receipt against a lot', icon: 'payments', run: () => { navigate('payments'); setTimeout(() => document.getElementById('pay-lot')?.focus(), 80); } },
  { kind: 'Action', label: 'Export filtered lots as CSV', hint: 'Downloads the current selection', icon: 'download', run: () => views.exportFiltered() },
  { kind: 'Action', label: 'Export audit trail as JSON', hint: 'Machine-readable trail', icon: 'download', run: () => views.exportAudit() },
  { kind: 'Action', label: 'Toggle light / dark theme', hint: 'Surface appearance', icon: 'sun', run: () => toggleTheme() },
  { kind: 'Action', label: 'Toggle compact density', hint: 'Tighten spacing', icon: 'menu', run: () => toggleDensity() },
  { kind: 'Action', label: 'Collapse / expand sidebar', hint: 'Rail mode', icon: 'menu', run: () => toggleRail() },
  { kind: 'Action', label: 'Re-run data quality audit', hint: 'Recomputes all exceptions', icon: 'refresh', run: () => { _cache = { key: null, value: null }; notify(); toast('Audit recomputed', 'good'); } },
  { kind: 'Action', label: 'Discard in-session payments', hint: 'Reverts to the source file', icon: 'refresh', run: () => { const n = resetAdjustments(); toast(`${n} adjustment(s) discarded`, 'warn'); } },
  { kind: 'Action', label: 'Print / save as PDF', hint: 'Uses the print stylesheet', icon: 'download', run: () => window.print() },
];

export function openPalette(prefill = '') {
  store.ui.paletteOpen = true;
  const el = document.createElement('div');
  el.className = 'palette';
  el.setAttribute('role', 'dialog');
  el.innerHTML = `
    <div class="palette-input">${ICON.search}<input id="pal-q" placeholder="Search lots, buyers, invoices, actions…" value="${prefill}" aria-label="Command palette"><span class="kbd">esc</span></div>
    <div class="palette-list" id="pal-list"></div>`;
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.style.zIndex = '69';
  scrim.onclick = closePalette;
  document.body.append(scrim, el);
  const input = el.querySelector('#pal-q');
  const list = el.querySelector('#pal-list');
  let items = [], active = 0;

  const render = () => {
    const q = input.value.trim();
    const actions = ACTIONS
      .map((a) => ({ ...a, score: q ? fuzzyScore(q, `${a.label} ${a.kind}`) : 10 }))
      .filter((a) => a.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    const lots = q ? searchRecords(derived().records, q).slice(0, 6)
      .map((r) => ({ kind: 'Lot', label: `Lot ${r.lot} — ${r.buyer}`, hint: `₹${fmtCompact(r.outstanding)} outstanding · ${r.status}`, icon: 'lots',
        run: () => showLot(r.lot) })) : [];
    const buyers = q ? derived().buyers.filter((b) => fuzzyScore(q, b.buyer) !== null).slice(0, 5)
      .map((b) => ({ kind: 'Buyer', label: b.buyer, hint: `${b.count} lots · ₹${fmtCompact(b.receivable)}`, icon: 'buyers',
        run: () => { store.filter.buyers = [b.buyer]; navigate('lots'); toast(`Filtered to ${b.buyer}`, 'info'); } })) : [];
    items = [...actions, ...buyers, ...lots];
    active = 0;
    list.innerHTML = items.length
      ? items.map((it, i) => {
          const first = i === 0 || items[i - 1].kind !== it.kind;
          return `${first ? `<div class="palette-group">${it.kind}</div>` : ''}
            <button class="palette-item" data-i="${i}" data-active="${i === 0}">${ICON[it.icon] || ICON.info}<span>${it.label}</span><span class="hint">${it.hint || ''}</span></button>`;
        }).join('')
      : `<div class="empty">No matches for “${q}”</div>`;
    list.querySelectorAll('.palette-item').forEach((b) => {
      b.onclick = () => { closePalette(); items[Number(b.dataset.i)].run(); };
      b.onmousemove = () => setActive(Number(b.dataset.i));
    });
  };
  const setActive = (i) => {
    active = (i + items.length) % Math.max(1, items.length);
    list.querySelectorAll('.palette-item').forEach((b) => b.dataset.active = String(Number(b.dataset.i) === active));
    list.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  input.oninput = render;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); closePalette(); items[active]?.run(); }
    else if (e.key === 'Escape') closePalette();
  };
  render();
  input.focus();
  input.select();
}

export function closePalette() {
  store.ui.paletteOpen = false;
  document.querySelectorAll('.palette').forEach((n) => n.remove());
  document.querySelectorAll('.scrim').forEach((n) => { if (n.style.zIndex === '69') n.remove(); });
}

/* -------------------------------------------------------------------------- */
/* preferences                                                                 */
/* -------------------------------------------------------------------------- */

export function toggleTheme() {
  store.ui.theme = store.ui.theme === 'dark' ? 'light' : 'dark';
  applyPrefs();
  logAudit('THEME', store.ui.theme);
}

export function toggleDensity() {
  store.ui.density = store.ui.density === 'compact' ? 'comfortable' : 'compact';
  applyPrefs();
  logAudit('DENSITY', store.ui.density);
  notify();
}

export function toggleRail() {
  store.ui.rail = !store.ui.rail;
  applyPrefs();
  logAudit('RAIL', String(store.ui.rail));
  notify();
}

export function setAsOf(value) {
  store.filter.asOf = value || AS_OF;
  _cache = { key: null, value: null };
  logAudit('AS_OF', store.filter.asOf);
  notify();
}

export function applyPrefs() {
  document.documentElement.dataset.theme = store.ui.theme;
  document.documentElement.dataset.density = store.ui.density;
  const app = document.querySelector('.app');
  if (app) app.dataset.rail = String(store.ui.rail);
}

/* -------------------------------------------------------------------------- */
/* shell rendering                                                             */
/* -------------------------------------------------------------------------- */

function navBadge(route) {
  if (route === 'invoices') {
    const n = derived().issues.filter((i) => i.code.startsWith('MISSING_')).length;
    return n ? `<span class="nav-badge">${n}</span>` : '';
  }
  if (route === 'risk') {
    const n = derived().risk.filter((r) => r.band.id === 'critical').length;
    return n ? `<span class="nav-badge">${n}</span>` : '';
  }
  if (route === 'payments' && store.adjustments.length) return `<span class="nav-badge">${store.adjustments.length}</span>`;
  return '';
}

export function renderShell() {
  const app = document.getElementById('app');
  const groups = [...new Set(ROUTES.map((r) => r.group))];
  const route = ROUTES.find((r) => r.id === store.ui.route) || ROUTES[0];
  const d = derived();

  app.innerHTML = `
    <nav class="sidebar" aria-label="Primary">
      <div class="brand">
        <div class="brand-mark">${ICON.logo}</div>
        <div class="brand-text">
          <span class="brand-name aurora-text">NEBULA AR</span>
          <span class="brand-sub">Receivables OS</span>
        </div>
      </div>
      <div class="tenant">
        <div class="tenant-avatar">MS</div>
        <div style="min-width:0">
          <div class="tenant-name">MSTC Limited</div>
          <div class="tenant-plan">Nebula · Enterprise</div>
        </div>
      </div>
      ${groups.map((g) => `
        <div class="nav-group-title">${g}</div>
        ${ROUTES.filter((r) => r.group === g).map((r) => `
          <button class="nav-item" data-route="${r.id}" ${r.id === route.id ? 'aria-current="page"' : ''} title="${r.desc}">
            ${ICON[r.icon]}<span class="nav-label">${r.label}</span>${navBadge(r.id)}
          </button>`).join('')}
      `).join('')}
      <div style="flex:1"></div>
      <div class="nav-item" data-action="palette">${ICON.bolt}<span class="nav-label">Command bar</span><span class="kbd hide-sm">⌘K</span></div>
    </nav>

    <div class="main">
      <header class="topbar">
        <button class="icon-btn" data-action="rail" aria-label="Toggle sidebar">${ICON.menu}</button>
        <div class="crumbs"><span>${route.group}</span> / <strong>${route.label}</strong></div>
        <button class="searchbox" data-action="palette">
          ${ICON.search}<input placeholder="Search lots, buyers, invoices…" aria-label="Search" readonly>
          <span class="kbd">⌘K</span>
        </button>
        <div class="topbar-actions">
          <span class="chip info hide-sm" title="As-of date used by every ageing and penalty calculation">${ICON.info} as-of ${fmtDate(asOf())}</span>
          <button class="icon-btn" data-action="alerts" aria-label="Exceptions"><span class="dot"></span>${ICON.bell}</button>
          <button class="icon-btn" data-action="theme" aria-label="Toggle theme">${store.ui.theme === 'dark' ? ICON.sun : ICON.moon}</button>
          <button class="btn sm" data-action="export">${ICON.download}<span class="hide-sm">Export</span></button>
        </div>
      </header>
      <main class="viewport" id="viewport"></main>
    </div>`;

  app.querySelectorAll('[data-route]').forEach((b) => (b.onclick = () => navigate(b.dataset.route)));
  app.querySelectorAll('[data-action]').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      const a = b.dataset.action;
      if (a === 'palette') openPalette();
      else if (a === 'rail') toggleRail();
      else if (a === 'theme') toggleTheme();
      else if (a === 'export') views.exportFiltered();
      else if (a === 'alerts') showAlerts();
    };
  });
  renderRoute();
}

export function renderRoute() {
  const vp = document.getElementById('viewport');
  if (!vp) return;
  const fn = views.PAGES[store.ui.route] || views.dashboard;
  vp.innerHTML = `<div class="page">${fn()}</div>`;
  views.mount?.(store.ui.route, vp);
  document.querySelectorAll('.topbar .crumbs strong').forEach((n) => {
    n.textContent = (ROUTES.find((r) => r.id === store.ui.route) || ROUTES[0]).label;
  });
  document.querySelectorAll('.topbar .crumbs span').forEach((n) => {
    n.textContent = (ROUTES.find((r) => r.id === store.ui.route) || ROUTES[0]).group;
  });
}

function showAlerts() {
  const issues = derived().issues;
  const groups = {};
  for (const i of issues) (groups[i.code] ||= []).push(i);
  openModal(`
    <div class="drawer-head">
      <div class="grow"><h2 style="font-size:17px">Exception centre</h2>
      <div class="panel-sub">${issues.length} finding(s) across ${new Set(issues.map((i) => i.lot)).size} lots</div></div>
      <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button>
    </div>
    <div class="drawer-body">
      ${Object.entries(groups).map(([code, list]) => `
        <div class="panel">
          <div class="between mb-2"><div class="panel-title">${code}</div><span class="chip ${list[0].severity === 'high' ? 'bad' : list[0].severity === 'medium' ? 'warn' : 'info'}">${list.length}</span></div>
          <div class="small muted mb-2">${list[0].message.replace(/^\w+ /, '')}</div>
          <div class="row">${list.map((i) => `<button class="btn sm ghost" data-lot="${i.lot}">Lot ${i.lot}</button>`).join('')}</div>
        </div>`).join('')}
    </div>
    <div class="drawer-foot"><button class="btn primary" data-close>Dismiss</button></div>
  `, (m) => {
    m.querySelectorAll('[data-lot]').forEach((b) => (b.onclick = () => { closeOverlays(); showLot(b.dataset.lot); }));
  });
}

/* -------------------------------------------------------------------------- */
/* export helpers                                                              */
/* -------------------------------------------------------------------------- */

export function download(filename, text, mime = 'text/csv') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  logAudit('EXPORT', filename);
}

/* -------------------------------------------------------------------------- */
/* boot                                                                        */
/* -------------------------------------------------------------------------- */

function login(role) {
  store.session = { user: role.user, role: role.id, at: new Date().toISOString() };
  logAudit('SESSION_START', `${role.id} · ${role.user}`);
  mountApp();
}

const ROLES = [
  { id: 'controller', user: 'Group Controller', label: 'Controller' },
  { id: 'analyst', user: 'AR Analyst', label: 'Analyst' },
  { id: 'auditor', user: 'Internal Audit', label: 'Auditor' },
];

function renderLogin() {
  const host = document.getElementById('app');
  host.className = 'login';
  let role = ROLES[0].id;
  host.innerHTML = `
    <div class="login-card">
      <div class="login-logo"><div class="brand-mark">${ICON.logo}</div></div>
      <h1 class="aurora-text">NEBULA AR</h1>
      <p class="tagline">Receivables operating system · MSTC Limited</p>
      <div class="role-picker" id="roles">
        ${ROLES.map((r) => `<button data-role="${r.id}" aria-pressed="${r.id === role}">${r.label}</button>`).join('')}
      </div>
      <div class="field mb-4"><label for="li-user">Workspace</label>
        <input class="input" id="li-user" value="MSTC · E-Auction Receivables FY 2026-27"></div>
      <button class="btn primary" id="li-go" style="width:100%;justify-content:center">${ICON.bolt} Enter workspace</button>
      <div class="login-foot">
        37 lots · ₹1.77 Cr receivable · source <span class="mono">receivables.csv</span><br>
        Demo build — no data leaves this browser.
      </div>
    </div>`;
  host.querySelectorAll('[data-role]').forEach((b) => {
    b.onclick = () => {
      role = b.dataset.role;
      host.querySelectorAll('[data-role]').forEach((x) => (x.setAttribute('aria-pressed', String(x === b))));
    };
  });
  host.querySelector('#li-go').onclick = () => {
    const ws = host.querySelector('#li-user').value.trim();
    const r = ROLES.find((x) => x.id === role);
    login({ ...r, workspace: ws });
  };
  host.querySelector('#li-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') host.querySelector('#li-go').click(); });
}

function mountApp() {
  const host = document.getElementById('app');
  host.className = 'app';
  host.dataset.rail = String(store.ui.rail);
  applyPrefs();
  renderShell();
}

export function boot() {
  store.records = parseReceivables(CSV);
  logAudit('BOOT', `${store.records.length} records loaded from data/receivables.csv`);
  syncHash();
  renderLogin();

  window.addEventListener('hashchange', syncHash);
  subscribe(() => { if (store.session) renderShell(); });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if (e.key === 'Escape') { closePalette(); closeOverlays(); }
    else if (e.key === '/' && !store.ui.paletteOpen && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) {
      e.preventDefault(); openPalette();
    }
  });

  // expose a tiny debug surface for console-driven verification
  window.NEBULA = { store, derived, charts, totals, byBuyer, simulate, navigate, showLot, openPalette };
}

