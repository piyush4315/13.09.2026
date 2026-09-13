# NEBULA AR — Receivables Operating System

A single-page SaaS for tracking MSTC e-auction receivables. Zero runtime
dependencies: no framework, no CDN, no build step, no network calls. Every
number on screen is computed in the browser from `data/receivables.csv`.

```
37 lots · 13 buyers · ₹1,77,49,922 receivable · ₹1,74,45,472 collected · ₹3,04,450 outstanding
```

---

## Run it

```bash
cd saas
python3 -m http.server 8080 --bind 0.0.0.0   # then open http://localhost:8080
```

Or open **`dist/nebula-ar.html`** directly — the whole application (markup, CSS,
all five JS modules, and the dataset) is inlined into one file and works from
`file://` with no server at all.

Any static server works; there is no backend to run.

```bash
npm test        # 46 tests, node --test
npm run gen     # regenerate js/data.js from data/receivables.csv
node tools/bundle.js   # rebuild dist/nebula-ar.html
```

Requires Node ≥ 20 for the tests and generators. The app itself needs only a
browser with ES modules (anything from the last five years).

---

## What is in it

| Route | What it does |
|---|---|
| **Command Deck** | Six live KPI tiles, collection trajectory, cash composition donut, weekly stacked collections, balance reconciliation, ageing by buyer, risk watchlist, exception summary. |
| **Ageing Matrix** | Open balances bucketed 0‑7 / 8‑15 / 16‑30 / 31‑60 / 60+ days per buyer, distribution donut, ageing ledger, exposure heat map. |
| **Buyer Intelligence** | 13 counterparties ranked by exposure, signed outstanding bars, concentration donut, recovery rate and SD→FP settlement lag per buyer. |
| **Forecast Lab** | Holt linear (α 0.40, β 0.25) projection over weekly receipts, weekday-seasonal daily projection, model comparison, run-rate and weeks-to-clear. |
| **Lot Register** | All 37 lots, 14 columns, sortable headers, full-text + fuzzy search, buyer/status/document filters, CSV export. |
| **Collections Desk** | Post a receipt against an open lot; the ledger, status and every downstream KPI recompute instantly. Undo per receipt or discard the session. |
| **Invoice Recon** | Exception centre: 15 rule codes across documentation gaps, arithmetic, status agreement, over-receipts and LPP drift. |
| **Risk Radar** | Composite 0‑100 risk score, four bands, z-score and MAD outlier detection, descriptive statistics. |
| **Scenario Forge** | Five live sliders (SD collection, FP collection, LPP waiver, clock-forward days, settlement tolerance) re-deriving the entire book against the baseline. |
| **Audit & Settings** | Session audit trail, preferences, as-of date control, full data lineage. |

Cross-cutting: ⌘K / `/` command palette over actions, buyers and lots; lot
detail drawer with commercial build-up, document trail and timeline; toasts;
dark and light surfaces; compact density; collapsible rail; print stylesheet;
CSV and JSON export.

---

## The business rules the app enforces

These are recomputed from `Material Value` on every render, not read from the
file, so a corrupt cell surfaces as an exception rather than a wrong total.

| Rule | Formula |
|---|---|
| Security deposit | `ROUND(Material Value × 0.25, 0)` |
| Final payment | `ROUND(Material Value × 0.9265 − GST TDS, 0)` |
| Late payment penalty | `Material Value × 1.18% × CEILING(days ÷ 7, 1)`, accruing from 22 Aug 2026, stopped by a final-payment date on or before 24 Aug 2026 |
| Total received | `SD + FP + LPP` |
| Outstanding | `Receivable − Total Received` |
| Status | `SETTLED` if `Outstanding ≤ 5`, else `OUTSTANDING` |

`ROUND` is half **away from zero**, matching Excel and DAX. This matters: nine
security-deposit lots and three final-payment lots land exactly on `.5`. Under
Excel rounding the expected security deposit is **₹37,82,654**, which matches
the file exactly; under Python's banker's rounding it comes out ₹37,82,651 and
appears as a phantom ₹3 shortfall. The suite pins this explicitly.

### Reconciliation against the source

| Measure | Source total | Computed | Δ |
|---|---|---|---|
| Material Value | 15,130,598 | 15,130,598 | 0 |
| Service Charge to MSTC | 410,039 | 410,039 | 0 |
| GST TDS | 83,029 | 83,029 | 0 |
| Total Receivables in Cash | 17,749,922 | 17,749,922 | 0 |
| Security Deposit Received | 3,782,654 | 3,782,654 | 0 |
| Final Payment Received | 13,646,312 | 13,646,312 | 0 |
| LPP Expected | 31,799 | 31,799 | 0 |
| LPP Received | 16,506 | 16,506 | 0 |
| Total Received | 17,445,472 | 17,445,472 | 0 |
| Outstanding | 304,450 | 304,450 | 0 |

Row-level integrity is clean: `Total Received = SD + FP + LPP` and
`Outstanding = Receivable − Total Received` hold on all 37 rows, and every
`Payment Status` agrees with the ≤ 5 rule.

### What the exception centre reports

* **Lots 2036, 2040, 2069, 2089, 2091** have no `Invoice No.`, `SAP Document`
  or `Document/Invoice Date` — 15 findings.
* **Lots 2040 and 2069** (both STERLING ENTERPRISES) are genuinely open, at
  ₹2,62,904 and ₹52,580, and have no final-payment date, so their penalty is
  still accruing.
* **Six over-receipts**: 1923, 1976, 2007, 2025, 2071 by ₹1 each and **2036 by
  ₹10,988**, where the LPP receipt is booked twice (once in `LPP Received`, once
  inside `Total Received`).
* Six lots carry a ₹1 residual `Outstanding` but are still marked `SETTLED` —
  correct under the ≤ 5 tolerance, and surfaced as information rather than error.

---

## Layout

```
saas/
├── index.html              entry point (dev / served)
├── css/theme.css           design tokens + all component styles
├── js/
│   ├── data.js             generated — CSV inlined as an ES module
│   ├── domain.js           parsing, business rules, aggregation, statistics, forecasting
│   ├── charts.js           SVG chart engine (column, bar, area, donut, gauge, heat, spark)
│   ├── views.js            one render function per route
│   └── app.js              store, router, shell, palette, drawer, toasts
├── data/receivables.csv    source of truth — 37 rows × 19 columns
├── tools/gen-data.js       CSV → js/data.js
├── tools/bundle.js         → dist/nebula-ar.html (single self-contained file)
├── dist/nebula-ar.html     offline build, opens from file://
└── test/app.test.js        46 tests under node --test
```

`domain.js` and `charts.js` are pure and side-effect free, which is what makes
them testable without a browser. `views.js` returns HTML strings; wiring happens
afterwards in `mount()`.

---

## Verification

```
$ npm run check
# tests 46
# pass 46
# fail 0
inlined modules: app.js, data.js, domain.js, charts.js, views.js
module graph evaluated — no temporal-dead-zone crash
boot() ran — login screen rendered
records parsed: 37
all 10 routes render through the bundled code
all 43 DOM checks passed against dist/nebula-ar.html
```

Three layers, each running the shipped code rather than a reimplementation:

**`npm test` — 46 unit tests** over `domain.js` and `charts.js`:

* parsing and type coercion against `data/receivables.csv`, plus a staleness
  check that fails if `js/data.js` drifts from the CSV;
* all ten column totals against the stated source totals;
* per-row arithmetic and status agreement on all 37 rows;
* the Excel-vs-banker's rounding divergence, pinned to the Excel result;
* the audit rules firing on the known defects and on deliberately corrupted rows;
* ageing bucket sums reconciling to the open book, with no lot left unbucketed;
* cumulative and weekly series reconciling to ₹17,445,472;
* both forecast models, including their refusal to extrapolate thin history;
* z-score and MAD outlier detection, risk scoring and banding;
* four simulation scenarios against the baseline;
* search ranking, filtering, sorting, formatting and CSV round-tripping;
* every chart primitive emitting well-formed SVG with no `NaN`;
* all ten routes rendered through the real view functions;
* recording a payment through the real store — lot 2069 settles, the totals
  move, the audit entry is written, and discarding restores the source state.

**`npm run verify:bundle`** extracts the five modules inlined in
`dist/nebula-ar.html`, writes them back out, and imports the entry point the way
the browser's import map does. This is what catches a cycle-induced
temporal-dead-zone crash, which would otherwise only appear in a browser.

**`npm run smoke:dom`** executes the bundle's code inside jsdom and drives the
UI end to end — 43 assertions: the login screen, entering the workspace, six KPI
tiles with Indian-locale formatting, four SVG charts, **all ten routes**, the lot
register's 37 rows, the buyer filter narrowing to 7 and resetting, the lot-2040
detail drawer flagging its missing documents, posting a receipt that settles lot
2069 and moves the totals to ₹17,49,802, discarding it, and the command palette
finding STERLING ENTERPRISES and closing on Escape.

### Not verified here

There is no browser engine in this environment (Chromium and Firefox downloads
are blocked), so **visual rendering is unconfirmed**: layout, CSS animations, the
aurora background, and the offline bundle's blob-URL import-map boot path have
not been seen by an eye or a real engine. jsdom parses SVG with its HTML parser
and drops siblings after an SVG `<title>`, so it also under-counts chart shapes;
that assertion is written to tolerate it. Everything above that is asserted was
asserted against the code that ships.

## Design

Dark-first glass surfaces over an animated aurora field, neon accent gradients,
tabular numerals throughout, SVG charts that draw themselves in on render, and a
light theme that swaps the same tokens. Reduced-motion and print stylesheets are
included. All state lives in one observable store; every mutation writes to the
audit trail.
