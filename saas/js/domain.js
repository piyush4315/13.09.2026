/* ============================================================================
 * NEBULA AR — domain.js
 * Pure, dependency-free domain layer for the receivables SaaS.
 *
 * Everything in this file is deterministic and side-effect free so it can be
 * unit-tested under `node --test` without a browser.
 * ==========================================================================*/

export const CSV_COLUMNS = [
  'Lot No.', 'Buyer', 'Material Value', 'Service Charge to MSTC', 'GST TDS',
  'Total Receivables in Cash', 'Security Deposit Received', 'Security Deposit Date',
  'Final Payment Received', 'Final Payment Date', 'LPP Expected', 'LPP Received',
  'LPP Receipt Date', 'Total Received', 'Outstanding', 'Payment Status',
  'Invoice No.', 'SAP Document', 'Document/Invoice Date',
];

/** Canonical record shape used everywhere in the app. */
export const FIELDS = {
  lot:            { key: 'lot',            label: 'Lot No.',                 type: 'int',    width: 96 },
  buyer:          { key: 'buyer',          label: 'Buyer',                   type: 'text',   width: 260 },
  materialValue:  { key: 'materialValue',  label: 'Material Value',          type: 'money',  width: 130 },
  serviceCharge:  { key: 'serviceCharge',  label: 'Service Charge to MSTC',  type: 'money',  width: 140 },
  gstTds:         { key: 'gstTds',         label: 'GST TDS',                 type: 'money',  width: 110 },
  receivable:     { key: 'receivable',     label: 'Total Receivables in Cash', type: 'money', width: 150 },
  sdReceived:     { key: 'sdReceived',     label: 'Security Deposit Received', type: 'money', width: 150 },
  sdDate:         { key: 'sdDate',         label: 'Security Deposit Date',   type: 'date',   width: 140 },
  fpReceived:     { key: 'fpReceived',     label: 'Final Payment Received',  type: 'money',  width: 140 },
  fpDate:         { key: 'fpDate',         label: 'Final Payment Date',      type: 'date',   width: 140 },
  lppExpected:    { key: 'lppExpected',    label: 'LPP Expected',            type: 'money',  width: 120 },
  lppReceived:    { key: 'lppReceived',    label: 'LPP Received',            type: 'money',  width: 120 },
  lppDate:        { key: 'lppDate',        label: 'LPP Receipt Date',        type: 'date',   width: 140 },
  totalReceived:  { key: 'totalReceived',  label: 'Total Received',          type: 'money',  width: 130 },
  outstanding:    { key: 'outstanding',    label: 'Outstanding',             type: 'money',  width: 130 },
  status:         { key: 'status',         label: 'Payment Status',          type: 'enum',   width: 130 },
  invoiceNo:      { key: 'invoiceNo',      label: 'Invoice No.',             type: 'text',   width: 140 },
  sapDocument:    { key: 'sapDocument',    label: 'SAP Document',            type: 'text',   width: 130 },
  invoiceDate:    { key: 'invoiceDate',    label: 'Document/Invoice Date',   type: 'date',   width: 150 },
};

const HEADER_TO_KEY = {
  'Lot No.': 'lot', 'Buyer': 'buyer', 'Material Value': 'materialValue',
  'Service Charge to MSTC': 'serviceCharge', 'GST TDS': 'gstTds',
  'Total Receivables in Cash': 'receivable',
  'Security Deposit Received': 'sdReceived', 'Security Deposit Date': 'sdDate',
  'Final Payment Received': 'fpReceived', 'Final Payment Date': 'fpDate',
  'LPP Expected': 'lppExpected', 'LPP Received': 'lppReceived',
  'LPP Receipt Date': 'lppDate', 'Total Received': 'totalReceived',
  'Outstanding': 'outstanding', 'Payment Status': 'status',
  'Invoice No.': 'invoiceNo', 'SAP Document': 'sapDocument',
  'Document/Invoice Date': 'invoiceDate',
};

const NUMERIC = new Set(['lot', 'materialValue', 'serviceCharge', 'gstTds', 'receivable',
  'sdReceived', 'fpReceived', 'lppExpected', 'lppReceived', 'totalReceived', 'outstanding']);

/* -------------------------------------------------------------------------- */
/* parsing                                                                     */
/* -------------------------------------------------------------------------- */

/** RFC-4180-ish CSV parser that handles quoted fields and embedded commas. */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function toNumber(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function normaliseDate(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '0') return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function pad(v) { return String(v).padStart(2, '0'); }

/** Parse the receivables CSV into canonical records. */
export function parseReceivables(csvText) {
  const rows = parseCSV(csvText);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const keys = header.map((h) => HEADER_TO_KEY[h]);
  const unknown = header.filter((h, i) => !keys[i]);
  if (unknown.length) {
    throw new Error(`Unrecognised CSV column(s): ${unknown.join(', ')}`);
  }
  return rows.slice(1).map((cells, idx) => {
    const rec = { _row: idx + 2 };
    cells.forEach((raw, i) => {
      const key = keys[i];
      if (!key) return;
      if (NUMERIC.has(key)) rec[key] = toNumber(raw);
      else if (key.endsWith('Date')) rec[key] = normaliseDate(raw);
      else rec[key] = String(raw ?? '').trim();
    });
    for (const k of NUMERIC) if (rec[k] === undefined) rec[k] = 0;
    rec.id = `LOT-${rec.lot}`;
    return rec;
  });
}

/* -------------------------------------------------------------------------- */
/* business rules                                                              */
/* -------------------------------------------------------------------------- */

export const SETTLE_THRESHOLD = 5;
export const SD_RATE = 0.25;
export const FP_RATE = 0.9265;
export const LPP_WEEKLY_RATE = 0.0118;

export function statusFor(outstanding) {
  return outstanding <= SETTLE_THRESHOLD ? 'SETTLED' : 'OUTSTANDING';
}

/** ROUND(x, 0), half away from zero — matches Excel and DAX. */
export function round0(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export function expectedSecurityDeposit(materialValue) {
  return round0(materialValue * SD_RATE);
}

export function expectedFinalPayment(materialValue, gstTds) {
  return round0(materialValue * FP_RATE - gstTds);
}

/** Late payment penalty: 1.18% of material value per started week. */
export function latePaymentPenalty(materialValue, fpDate, asOf, graceEnd = '2026-08-24', start = '2026-08-22') {
  if (fpDate && fpDate <= graceEnd) return 0;
  const end = fpDate ? new Date(fpDate) : new Date(asOf);
  const weeks = Math.ceil(daysBetween(start, iso(end)) / 7);
  return materialValue * LPP_WEEKLY_RATE * weeks;
}

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

export function iso(d) { return d.toISOString().slice(0, 10); }

/* -------------------------------------------------------------------------- */
/* row-level validation                                                        */
/* -------------------------------------------------------------------------- */

/** Recomputes every derived column and reports where the file disagrees. */
export function auditRecords(records, asOf) {
  const issues = [];
  for (const r of records) {
    const sum = r.sdReceived + r.fpReceived + r.lppReceived;
    if (Math.abs(sum - r.totalReceived) > 0.5) {
      issues.push({ lot: r.lot, severity: 'high', code: 'TOTAL_RECEIVED',
        message: `Total Received ${fmt0(r.totalReceived)} != SD+FP+LPP ${fmt0(sum)}` });
    }
    const out = r.receivable - r.totalReceived;
    if (Math.abs(out - r.outstanding) > 0.5) {
      issues.push({ lot: r.lot, severity: 'high', code: 'OUTSTANDING',
        message: `Outstanding ${fmt0(r.outstanding)} != Receivable-Received ${fmt0(out)}` });
    }
    const st = statusFor(r.outstanding);
    if (r.status !== st) {
      issues.push({ lot: r.lot, severity: 'high', code: 'STATUS',
        message: `Status ${r.status} but Outstanding ${fmt0(r.outstanding)} implies ${st}` });
    }
    for (const [k, label] of [['invoiceNo', 'Invoice No.'], ['sapDocument', 'SAP Document'], ['invoiceDate', 'Invoice Date']]) {
      if (!r[k]) issues.push({ lot: r.lot, severity: 'medium', code: `MISSING_${k.toUpperCase()}`, message: `${label} is blank` });
    }
    if (r.outstanding < 0) {
      issues.push({ lot: r.lot, severity: 'low', code: 'OVER_RECEIPT',
        message: `Over-received by ${fmt0(-r.outstanding)}` });
    }
    if (!r.fpDate && r.receivable > 0) {
      issues.push({ lot: r.lot, severity: 'high', code: 'NO_FP_DATE',
        message: 'No final-payment receipt date; penalty is still accruing' });
    }
    if (r.fpDate && r.fpDate < r.sdDate) {
      issues.push({ lot: r.lot, severity: 'low', code: 'DATE_ORDER',
        message: 'Final payment recorded before the security deposit' });
    }
    const lpp = latePaymentPenalty(r.materialValue, r.fpDate, asOf);
    if (Math.abs(lpp - r.lppExpected) > Math.max(2, lpp * 0.02)) {
      issues.push({ lot: r.lot, severity: 'medium', code: 'LPP_DRIFT',
        message: `LPP Expected ${fmt0(r.lppExpected)} vs recomputed ${fmt0(lpp)} at ${asOf}` });
    }
    if (r.lppReceived > r.lppExpected + 0.5) {
      issues.push({ lot: r.lot, severity: 'low', code: 'LPP_OVER',
        message: `LPP Received ${fmt0(r.lppReceived)} exceeds expected ${fmt0(r.lppExpected)}` });
    }
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* aggregation                                                                 */
/* -------------------------------------------------------------------------- */

export function totals(records) {
  const t = { count: records.length, materialValue: 0, serviceCharge: 0, gstTds: 0,
    receivable: 0, sdReceived: 0, fpReceived: 0, lppExpected: 0, lppReceived: 0,
    totalReceived: 0, outstanding: 0, settled: 0, outstandingLots: 0, overReceipt: 0 };
  for (const r of records) {
    t.materialValue += r.materialValue;
    t.serviceCharge += r.serviceCharge;
    t.gstTds += r.gstTds;
    t.receivable += r.receivable;
    t.sdReceived += r.sdReceived;
    t.fpReceived += r.fpReceived;
    t.lppExpected += r.lppExpected;
    t.lppReceived += r.lppReceived;
    t.totalReceived += r.totalReceived;
    t.outstanding += r.outstanding;
    if (r.status === 'SETTLED') t.settled += 1; else t.outstandingLots += 1;
    if (r.outstanding < 0) t.overReceipt += -r.outstanding;
  }
  t.recoveryRate = t.receivable ? t.totalReceived / t.receivable : 0;
  t.sdExpected = records.reduce((a, r) => a + expectedSecurityDeposit(r.materialValue), 0);
  t.fpExpected = records.reduce((a, r) => a + expectedFinalPayment(r.materialValue, r.gstTds), 0);
  t.sdOutstanding = t.sdExpected - t.sdReceived;
  t.fpOutstanding = t.fpExpected - t.fpReceived;
  t.avgLotValue = t.count ? t.materialValue / t.count : 0;
  t.avgDaysToSettle = average(records.filter((r) => r.fpDate && r.sdDate).map((r) => daysBetween(r.sdDate, r.fpDate)));
  return t;
}

export function groupBy(records, keyFn) {
  const map = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

export function byBuyer(records) {
  const out = [];
  for (const [buyer, rows] of groupBy(records, (r) => r.buyer)) {
    const t = totals(rows);
    out.push({ buyer, ...t });
  }
  return out.sort((a, b) => b.outstanding - a.outstanding || b.receivable - a.receivable);
}

/** Buckets used by the ageing view. */
export const AGE_BUCKETS = [
  { id: 'current', label: '0-7 days', min: 0, max: 7 },
  { id: 'b1', label: '8-15 days', min: 8, max: 15 },
  { id: 'b2', label: '16-30 days', min: 16, max: 30 },
  { id: 'b3', label: '31-60 days', min: 31, max: 60 },
  { id: 'b4', label: '60+ days', min: 61, max: Number.MAX_SAFE_INTEGER },
];

export function ageInDays(record, asOf) {
  const anchor = record.fpDate || record.sdDate || record.invoiceDate;
  if (!anchor) return null;
  return daysBetween(anchor, asOf);
}

export function bucketFor(days) {
  if (days === null) return null;
  return AGE_BUCKETS.find((b) => days >= b.min && days <= b.max) || null;
}

export function ageingByBuyer(records, asOf) {
  const rows = byBuyer(records);
  for (const row of rows) {
    row.buckets = Object.fromEntries(AGE_BUCKETS.map((b) => [b.id, 0]));
  }
  const index = new Map(rows.map((r) => [r.buyer, r]));
  for (const r of records) {
    if (r.outstanding <= 0) continue;
    const b = bucketFor(ageInDays(r, asOf));
    const target = index.get(r.buyer);
    if (b && target) target.buckets[b.id] += r.outstanding;
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* time series + forecasting                                                   */
/* -------------------------------------------------------------------------- */

/** Cumulative received / receivable by calendar day. */
export function cumulativeSeries(records, asOf) {
  const events = [];
  for (const r of records) {
    if (r.sdDate && r.sdReceived) events.push({ date: r.sdDate, amount: r.sdReceived, kind: 'Security Deposit' });
    if (r.fpDate && r.fpReceived) events.push({ date: r.fpDate, amount: r.fpReceived, kind: 'Final Payment' });
    if (r.lppDate && r.lppReceived) events.push({ date: r.lppDate, amount: r.lppReceived, kind: 'LPP' });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : 1));
  const days = events.length ? uniq(events.map((e) => e.date)) : [asOf];
  const first = days[0];
  const span = Math.max(1, daysBetween(first, asOf));
  const out = [];
  let running = 0;
  let cursor = new Date(first);
  const end = new Date(asOf);
  let i = 0;
  while (cursor <= end) {
    const d = iso(cursor);
    while (i < events.length && events[i].date <= d) { running += events[i].amount; i++; }
    out.push({ date: d, received: running });
    cursor = new Date(cursor.getTime() + 86400000);
    if (out.length > 4000) break;
  }
  void span;
  return out;
}

export function uniq(arr) { return [...new Set(arr)].sort(); }

/** Weekly collections, most recent last. */
export function weeklyCollections(records, asOf) {
  const map = new Map();
  for (const r of records) {
    for (const [date, amount, kind] of [
      [r.sdDate, r.sdReceived, 'Security Deposit'],
      [r.fpDate, r.fpReceived, 'Final Payment'],
      [r.lppDate, r.lppReceived, 'LPP'],
    ]) {
      if (!date || !amount) continue;
      const wk = weekStart(date);
      if (!map.has(wk)) map.set(wk, { week: wk, total: 0, sd: 0, fp: 0, lpp: 0 });
      const o = map.get(wk);
      o.total += amount;
      if (kind === 'Security Deposit') o.sd += amount;
      else if (kind === 'Final Payment') o.fp += amount;
      else o.lpp += amount;
    }
  }
  void asOf;
  return [...map.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
}

export function weekStart(dateStr) {
  const d = new Date(dateStr);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return iso(d);
}

/** Holt's linear (double) exponential smoothing forecast. */
export function holtForecast(series, periods = 6, alpha = 0.4, beta = 0.25) {
  if (series.length < 3) return [];
  const ys = series.map((p) => p.value);
  let level = ys[0];
  let trend = ys[1] - ys[0];
  for (let i = 1; i < ys.length; i++) {
    const prevLevel = level;
    level = alpha * ys[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  const out = [];
  for (let h = 1; h <= periods; h++) out.push({ period: h, value: Math.max(0, level + trend * h) });
  return out;
}

/** Naive seasonal projection: reuse the same weekday pattern from history. */
export function seasonalForecast(daily, periods = 14) {
  if (!daily.length) return [];
  const byDow = new Map();
  for (const p of daily) {
    const dow = new Date(p.date).getUTCDay();
    if (!byDow.has(dow)) byDow.set(dow, []);
    byDow.get(dow).push(p.value);
  }
  const last = new Date(daily[daily.length - 1].date);
  const out = [];
  for (let h = 1; h <= periods; h++) {
    const d = new Date(last.getTime() + h * 86400000);
    const dow = d.getUTCDay();
    const hist = byDow.get(dow) || [0];
    out.push({ date: iso(d), value: average(hist) });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* anomaly detection                                                           */
/* -------------------------------------------------------------------------- */

export function average(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

export function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = average(xs);
  return Math.sqrt(average(xs.map((x) => (x - m) ** 2)));
}

/** Z-score outliers on a numeric field. */
export function zScoreOutliers(records, field, threshold = 2) {
  const xs = records.map((r) => r[field]);
  const m = average(xs);
  const sd = stddev(xs);
  if (!sd) return [];
  return records
    .map((r) => ({ record: r, z: (r[field] - m) / sd }))
    .filter((o) => Math.abs(o.z) >= threshold)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}

/** Modified z-score using the median absolute deviation — robust to the outliers it finds. */
export function madOutliers(records, field, threshold = 3.5) {
  const xs = records.map((r) => r[field]).slice().sort((a, b) => a - b);
  const med = median(xs);
  const devs = xs.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  const mad = median(devs);
  if (!mad) return [];
  return records
    .map((r) => ({ record: r, score: (0.6745 * (r[field] - med)) / mad }))
    .filter((o) => Math.abs(o.score) >= threshold)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

export function median(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Composite risk score 0-100 for a lot. */
export function riskScore(record, asOf) {
  let score = 0;
  const out = Math.max(0, record.outstanding);
  if (record.receivable) score += Math.min(40, (out / record.receivable) * 60);
  const age = ageInDays(record, asOf);
  if (age !== null && out > 0) score += Math.min(30, (age / 60) * 30);
  if (!record.fpDate) score += 12;
  if (!record.invoiceNo) score += 6;
  if (!record.sapDocument) score += 6;
  if (!record.invoiceDate) score += 6;
  if (record.materialValue > 1_000_000) score += 5;
  return Math.round(Math.min(100, score));
}

export function riskBand(score) {
  if (score >= 60) return { id: 'critical', label: 'Critical' };
  if (score >= 35) return { id: 'high', label: 'High' };
  if (score >= 15) return { id: 'medium', label: 'Medium' };
  return { id: 'low', label: 'Low' };
}

/* -------------------------------------------------------------------------- */
/* what-if simulation                                                          */
/* -------------------------------------------------------------------------- */

export function simulate(records, assumptions) {
  const {
    sdCollectionRate = 1, fpCollectionRate = 1, lppWaiver = 0,
    additionalDays = 0, settleThreshold = SETTLE_THRESHOLD,
  } = assumptions;
  const asOf = iso(new Date(Date.now() + additionalDays * 86400000));
  const rows = records.map((r) => {
    const lpp = latePaymentPenalty(r.materialValue, r.fpDate, asOf) * (1 - lppWaiver);
    const receivable = round0(r.materialValue * 1.1765 - r.gstTds + lpp);
    const sd = r.sdReceived * sdCollectionRate;
    const fp = r.fpReceived * fpCollectionRate;
    const received = sd + fp + r.lppReceived;
    const outstanding = receivable - received;
    return { ...r, lppExpected: lpp, receivable, sdReceived: sd, fpReceived: fp,
      totalReceived: received, outstanding,
      status: outstanding <= settleThreshold ? 'SETTLED' : 'OUTSTANDING' };
  });
  const base = totals(records);
  const next = totals(rows);
  return { rows, base, next, asOf, delta: {
    outstanding: next.outstanding - base.outstanding,
    received: next.totalReceived - base.totalReceived,
    settled: next.settled - base.settled,
  } };
}

/* -------------------------------------------------------------------------- */
/* formatting + search                                                         */
/* -------------------------------------------------------------------------- */

export function fmt0(n) {
  return Math.round(n).toLocaleString('en-IN');
}

export function fmt2(n) {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtCompact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return fmt0(n);
}

export function fmtPct(n, digits = 1) { return `${(n * 100).toFixed(digits)}%`; }

export function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

/** Subsequence fuzzy match; returns a score (higher is better) or null. */
export function fuzzyScore(needle, haystack) {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  const exact = h.indexOf(n);
  if (exact === 0) return 1000;
  if (exact > 0) return 500 - exact;
  let i = 0, score = 0, streak = 0;
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) {
      i++; streak++;
      score += 10 + streak * 2;
    } else streak = 0;
  }
  return i === n.length ? score : null;
}

export function searchRecords(records, query) {
  if (!query || !query.trim()) return records;
  const q = query.trim();
  const ql = q.toLowerCase();
  return records
    .map((r) => {
      const tokens = [String(r.lot), r.buyer, r.invoiceNo, r.sapDocument, r.status];
      const hay = tokens.join(' ');
      let s = fuzzyScore(q, hay);
      if (s === null) return null;
      // An identifier that matches a whole field outranks any subsequence match,
      // otherwise lot 2036 loses to 2033 whose invoice ends in "...0036".
      if (tokens.some((t) => t && String(t).toLowerCase() === ql)) s += 100000;
      else if (tokens.some((t) => t && String(t).toLowerCase().startsWith(ql))) s += 20000;
      return { r, s };
    })
    .filter(Boolean)
    .sort((a, b) => b.s - a.s)
    .map((o) => o.r);
}

/* -------------------------------------------------------------------------- */
/* filtering / sorting                                                         */
/* -------------------------------------------------------------------------- */

export function filterRecords(records, filter) {
  const { buyers = [], statuses = [], minOutstanding = null, query = '', missingInvoice = false, riskBand: band = null } = filter;
  let out = records;
  if (query) out = searchRecords(out, query);
  if (buyers.length) out = out.filter((r) => buyers.includes(r.buyer));
  if (statuses.length) out = out.filter((r) => statuses.includes(r.status));
  if (minOutstanding !== null) out = out.filter((r) => r.outstanding >= minOutstanding);
  if (missingInvoice) out = out.filter((r) => !r.invoiceNo || !r.sapDocument || !r.invoiceDate);
  if (band) out = out.filter((r) => riskBand(riskScore(r, filter.asOf || iso(new Date()))).id === band);
  return out;
}

export function sortRecords(records, key, dir = 'desc') {
  const mul = dir === 'asc' ? 1 : -1;
  return records.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * mul;
    return String(x ?? '').localeCompare(String(y ?? '')) * mul;
  });
}

export function toCSV(records, columns) {
  const cols = columns || Object.values(FIELDS);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.map((c) => esc(c.label)).join(',');
  const body = records.map((r) => cols.map((c) => esc(r[c.key])).join(',')).join('\n');
  return `${head}\n${body}\n`;
}
