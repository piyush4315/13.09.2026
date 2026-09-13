/* ============================================================================
 * NEBULA AR — charts.js
 * Dependency-free SVG chart engine. Every chart is a pure function returning an
 * SVG string; the shell injects it and the CSS animates the result.
 * ==========================================================================*/

const NS = 'http://www.w3.org/2000/svg';

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function niceTicks(min, max, count = 5) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(step0) || 1)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 0.5; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

export function shortNumber(n) {
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}

const AX = 'var(--text-dim)';
const GRID = 'var(--grid)';

/* -------------------------------------------------------------------------- */

/**
 * Grouped / stacked column chart.
 * series: [{ id, label, color, values: number[] }]
 */
export function columnChart({ labels, series, height = 260, stacked = true, valueFormat = shortNumber }) {
  const w = 900;
  const padL = 62, padR = 16, padT = 18, padB = 46;
  const iw = w - padL - padR;
  const ih = height - padT - padB;
  const n = labels.length || 1;

  const totalsArr = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const maxV = Math.max(1, ...totalsArr);
  const ticks = niceTicks(0, maxV, 5);
  const top = ticks[ticks.length - 1] || maxV;
  const y = (v) => padT + ih - (v / top) * ih;

  const band = iw / n;
  const barW = Math.max(4, Math.min(56, band * (stacked ? 0.62 : 0.72 / Math.max(1, series.length))));

  let bars = '';
  labels.forEach((label, i) => {
    const cx = padL + band * i + band / 2;
    if (stacked) {
      let acc = 0;
      series.forEach((s, si) => {
        const v = s.values[i] || 0;
        if (!v) return;
        const h = (v / top) * ih;
        const yy = y(acc + v);
        bars += `<rect class="c-bar" x="${(cx - barW / 2).toFixed(2)}" y="${yy.toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(0.5, h).toFixed(2)}" rx="3" fill="${s.color}" style="--d:${i * 40 + si * 15}ms"><title>${esc(label)} · ${esc(s.label)}: ${valueFormat(v)}</title></rect>`;
        acc += v;
      });
    } else {
      const groupW = barW * series.length;
      series.forEach((s, si) => {
        const v = s.values[i] || 0;
        const h = (v / top) * ih;
        const x = cx - groupW / 2 + si * barW;
        bars += `<rect class="c-bar" x="${x.toFixed(2)}" y="${y(v).toFixed(2)}" width="${(barW - 2).toFixed(2)}" height="${Math.max(0.5, h).toFixed(2)}" rx="3" fill="${s.color}" style="--d:${i * 40 + si * 15}ms"><title>${esc(label)} · ${esc(s.label)}: ${valueFormat(v)}</title></rect>`;
      });
    }
  });

  let grid = '';
  for (const t of ticks) {
    grid += `<line x1="${padL}" y1="${y(t).toFixed(2)}" x2="${w - padR}" y2="${y(t).toFixed(2)}" stroke="${GRID}" stroke-width="1"/>`
      + `<text x="${padL - 10}" y="${(y(t) + 4).toFixed(2)}" text-anchor="end" class="c-tick">${valueFormat(t)}</text>`;
  }

  const skip = Math.ceil(n / 14);
  let xl = '';
  labels.forEach((label, i) => {
    if (i % skip) return;
    const x = padL + band * i + band / 2;
    xl += `<text x="${x.toFixed(2)}" y="${height - padB + 18}" text-anchor="middle" class="c-tick">${esc(String(label).slice(0, 14))}</text>`;
  });

  return svgWrap(w, height, `${grid}${bars}${xl}${axisLines(w, height, padL, padT, padR, padB)}`);
}

function axisLines(w, h, padL, padT, padR, padB) {
  return `<line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="${AX}" stroke-opacity=".35"/>`
    + `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${h - padB}" stroke="${AX}" stroke-opacity=".35"/>`;
}

function svgWrap(w, h, body, cls = '') {
  return `<svg class="chart ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">${body}</svg>`;
}

/* -------------------------------------------------------------------------- */

/** Horizontal bar chart, sorted descending, with optional value labels. */
export function barChart({ items, height, valueFormat = shortNumber, max: forceMax }) {
  const w = 900;
  const n = items.length || 1;
  const rowH = 30;
  const h = height || Math.max(140, n * rowH + 34);
  const padL = 210, padR = 90, padT = 10, padB = 24;
  const iw = w - padL - padR;
  const max = forceMax ?? Math.max(1, ...items.map((i) => Math.abs(i.value)));

  let body = '';
  items.forEach((it, i) => {
    const yy = padT + i * rowH;
    const bw = Math.max(1.5, (Math.abs(it.value) / max) * iw);
    const color = it.color || (it.value < 0 ? 'var(--bad)' : 'var(--accent)');
    body += `<text x="${padL - 12}" y="${yy + 16}" text-anchor="end" class="c-label">${esc(it.label)}</text>`
      + `<rect class="c-hbar" x="${padL}" y="${yy + 5}" width="${bw.toFixed(2)}" height="${rowH - 14}" rx="4" fill="${color}" style="--d:${i * 35}ms"><title>${esc(it.label)}: ${valueFormat(it.value)}</title></rect>`
      + `<text x="${(padL + bw + 8).toFixed(2)}" y="${yy + 16}" class="c-value">${valueFormat(it.value)}</text>`;
  });
  return svgWrap(w, h, body);
}

/* -------------------------------------------------------------------------- */

/** Donut chart with centre readout. */
export function donut({ slices, size = 220, thickness = 26, centreLabel, centreValue }) {
  const r = (size - thickness) / 2;
  const c = size / 2;
  const total = slices.reduce((a, s) => a + Math.abs(s.value), 0) || 1;
  let angle = -Math.PI / 2;
  let body = '';
  slices.forEach((s, i) => {
    const frac = Math.abs(s.value) / total;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = c + r * Math.cos(angle), y1 = c + r * Math.sin(angle);
    const x2 = c + r * Math.cos(a2), y2 = c + r * Math.sin(a2);
    const d = frac >= 0.9999
      ? `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - 0.01} ${c - r}`
      : `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
    body += `<path class="c-arc" d="${d}" fill="none" stroke="${s.color}" stroke-width="${thickness}" stroke-linecap="butt" style="--d:${i * 90}ms"><title>${esc(s.label)}: ${shortNumber(s.value)}</title></path>`;
    angle = a2;
  });
  const mid = `<text x="${c}" y="${c - 4}" text-anchor="middle" class="c-centre">${esc(centreValue ?? '')}</text>`
    + `<text x="${c}" y="${c + 18}" text-anchor="middle" class="c-sublabel">${esc(centreLabel ?? '')}</text>`;
  return svgWrap(size, size, body + mid, 'donut');
}

/* -------------------------------------------------------------------------- */

/** Area + line chart with gradient fill and optional second series. */
export function areaChart({ series, height = 260, labels, valueFormat = shortNumber, showPoints = false }) {
  const w = 900;
  const padL = 66, padR = 18, padT = 16, padB = 40;
  const iw = w - padL - padR;
  const ih = height - padT - padB;
  const n = Math.max(1, labels.length);
  const all = series.flatMap((s) => s.values);
  const maxV = Math.max(1, ...all);
  const ticks = niceTicks(0, maxV, 5);
  const top = ticks[ticks.length - 1] || maxV;
  const X = (i) => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const Y = (v) => padT + ih - (v / top) * ih;

  let grid = '';
  for (const t of ticks) {
    grid += `<line x1="${padL}" y1="${Y(t).toFixed(2)}" x2="${w - padR}" y2="${Y(t).toFixed(2)}" stroke="${GRID}"/>`
      + `<text x="${padL - 10}" y="${(Y(t) + 4).toFixed(2)}" text-anchor="end" class="c-tick">${valueFormat(t)}</text>`;
  }

  let paths = '';
  series.forEach((s, si) => {
    const pts = s.values.map((v, i) => `${X(i).toFixed(2)},${Y(v).toFixed(2)}`);
    if (!pts.length) return;
    const line = `M ${pts.join(' L ')}`;
    const area = `${line} L ${X(n - 1).toFixed(2)},${(padT + ih).toFixed(2)} L ${X(0).toFixed(2)},${(padT + ih).toFixed(2)} Z`;
    const gid = `grad-${si}-${Math.random().toString(36).slice(2, 8)}`;
    paths += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`
      + `<stop offset="0%" stop-color="${s.color}" stop-opacity=".45"/>`
      + `<stop offset="100%" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>`
      + `<path d="${area}" fill="url(#${gid})" class="c-area" style="--d:${si * 120}ms"/>`
      + `<path d="${line}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" class="c-line" style="--d:${si * 120}ms"/>`;
    if (showPoints) {
      s.values.forEach((v, i) => {
        paths += `<circle cx="${X(i).toFixed(2)}" cy="${Y(v).toFixed(2)}" r="3" fill="${s.color}"><title>${esc(labels[i])}: ${valueFormat(v)}</title></circle>`;
      });
    }
  });

  const skip = Math.ceil(n / 10);
  let xl = '';
  labels.forEach((l, i) => {
    if (i % skip) return;
    xl += `<text x="${X(i).toFixed(2)}" y="${height - padB + 18}" text-anchor="middle" class="c-tick">${esc(String(l).slice(5))}</text>`;
  });

  return svgWrap(w, height, grid + paths + xl + axisLines(w, height, padL, padT, padR, padB));
}

/* -------------------------------------------------------------------------- */

/** Radial gauge 0-1. */
export function gauge({ value, label, size = 180, color = 'var(--accent)' }) {
  const r = size / 2 - 16;
  const c = size / 2;
  const frac = Math.max(0, Math.min(1, value));
  const a = -Math.PI / 2 + frac * Math.PI * 2;
  const x = c + r * Math.cos(a), y = c + r * Math.sin(a);
  const large = frac > 0.5 ? 1 : 0;
  const track = `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - 0.01} ${c - r}`;
  const arc = frac <= 0.0001 ? '' : `M ${c} ${c - r} A ${r} ${r} 0 ${large} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
  const body = `<path d="${track}" fill="none" stroke="var(--grid)" stroke-width="14" stroke-linecap="round"/>`
    + (arc ? `<path class="c-arc" d="${arc}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"/>` : '')
    + `<text x="${c}" y="${c + 2}" text-anchor="middle" class="c-centre">${(frac * 100).toFixed(1)}%</text>`
    + `<text x="${c}" y="${c + 24}" text-anchor="middle" class="c-sublabel">${esc(label)}</text>`;
  return svgWrap(size, size, body, 'donut');
}

/* -------------------------------------------------------------------------- */

/** Sparkline for KPI tiles. */
export function sparkline({ values, color = 'var(--accent)', width = 140, height = 40 }) {
  if (!values.length) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const X = (i) => (i / Math.max(1, values.length - 1)) * width;
  const Y = (v) => height - 3 - ((v - min) / span) * (height - 6);
  const pts = values.map((v, i) => `${X(i).toFixed(2)},${Y(v).toFixed(2)}`);
  const line = `M ${pts.join(' L ')}`;
  const gid = `sp-${Math.random().toString(36).slice(2, 8)}`;
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`
    + `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="${color}" stop-opacity=".4"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`
    + `<path d="${line} L ${width},${height} L 0,${height} Z" fill="url(#${gid})"/>`
    + `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
}

/* -------------------------------------------------------------------------- */

/** Heat strip: one cell per record, coloured by intensity. */
export function heatStrip({ items, columns = 24, cell = 26 }) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  const rows = Math.ceil(items.length / columns);
  const w = columns * cell, h = rows * cell + 6;
  let body = '';
  items.forEach((it, i) => {
    const x = (i % columns) * cell, y = Math.floor(i / columns) * cell;
    const t = Math.abs(it.value) / max;
    body += `<rect x="${x + 2}" y="${y + 2}" width="${cell - 4}" height="${cell - 4}" rx="5" fill="${it.color || 'var(--accent)'}" opacity="${(0.12 + t * 0.88).toFixed(3)}" class="c-cell" style="--d:${i * 12}ms"><title>${esc(it.label)}: ${shortNumber(it.value)}</title></rect>`;
  });
  return svgWrap(w, h, body, 'heat');
}

export { NS, esc, niceTicks };
