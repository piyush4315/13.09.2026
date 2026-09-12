# Receivables Tracker — Power BI project (`.pbip`)

A Power BI Desktop project built from `Book1.xlsx` → sheet **Final Calculation Sheet**
(37 lots, columns A–AH). Every spreadsheet *formula* is re-implemented in DAX, so the
model recomputes the numbers instead of carrying the workbook's cached values.

```
Receivables Tracker.pbip                    <- open this file
├── Receivables Tracker.Report/             PBIR-Legacy report, 5 pages, 24 visuals
├── Receivables Tracker.SemanticModel/      TMDL semantic model (4 tables, 35 columns, 31 measures, 4 relationships)
├── Data/receivables.csv                    the 37 rows, readable/diffable source of truth
├── tools/build_pbip.py                     regenerates the whole project from Book1.xlsx
├── tools/test_pbip.py                      the test suite (see below)
└── .schemas/                               Microsoft's item JSON Schemas (used by the tests)
                                              .schemas/authoritative/ = microsoft/json-schemas, the
                                              set Power BI Desktop actually validates against
```

## Open it

Double-click `Receivables Tracker.pbip` (Power BI Desktop, PBIP format enabled —
*Options → Preview features → Power BI Project*). The data is **embedded in the model**
as base64, so it loads with no file path to approve and no privacy prompt.

### Refreshing with new data

1. Replace `Data/receivables.csv` (keep the header row and the column order).
2. In Power Query, point the `Receivables` partition at `ReceivablesFromCsv`
   (or paste `ReceivablesFromCsv`'s body over `Receivables`). That query reads
   `Data/receivables.csv` relative to the project folder.
3. Re-run `python tools/build_pbip.py` instead, if you prefer to regenerate from the xlsx.

Desktop will ask once to allow local file access for the CSV.

## Model

| Table | Contents |
| --- | --- |
| `Receivables` | 19 imported input columns + 7 calculated columns + 27 measures |
| `Buyer` | distinct buyers (`DISTINCT`) |
| `Receipt Date` | calendar 2026‑01‑01 … 2027‑12‑31 for the security-deposit and final-payment dates (4 columns) |
| `Invoice Date` | same calendar for invoice / SAP document dates (4 columns) |

Relationships: `Receivables[SD Receipt Date] → Receipt Date[Date]` (active),
`Receivables[FP Receipt Date] → Receipt Date[Date]` (**inactive** — use `USERELATIONSHIP`),
`Receivables[Invoice Date] → Invoice Date[Date]`, `Receivables[Buyer] → Buyer[Buyer]`.

### What is imported vs recomputed

Only the columns someone *typed into* the sheet are imported:

`Quantity, Lot Name, Rate, Bid Sheet, Unit, Lot No., Buyer, Material Value, GST TDS Rate,
Security Deposit (Received), SD/FP/LPP Receipt Date (Text), Final Payment (Received),
LPP Received, Payment Status (Sheet), Invoice No., SAP Document, Invoice Date (Text)`

Every formula column is a DAX measure instead — `GST, Material Value incl. GST, TCS,
TDS u/s 194(O), Service Charge to MSTC, TDS u/s 194(H), Net Service Charge,
Service Charge to MSTC (Net), GST TDS, Total Receivables in Cash,
Security Deposit (Expected), Final Payment (Expected), LPP Expected, Total Received,
Outstanding, Recovery %, Lots Settled, Lots Outstanding, Over-Receipts,
Lots Missing Invoice Details, Lots Without FP Receipt Date, Lots With Zero GST TDS Rate`.

`Payment Status` is a calculated column (a slicer needs a physical column);
`Payment Status (Sheet)` is the spreadsheet's own value, kept so you can compare.

### Source-data notes found while building

* **Two duplicate headers.** Columns V and Y are both "Date of Receipt" → renamed
  `SD Receipt Date (Text)` and `FP Receipt Date (Text)`.
* **`Quantity` is not an integer** — row 25 is `8.2`. Typed as decimal.
* **Two rows have no final payment** (rows 27 and 34) and the sheet stores their date as
  the number `0`; treated as blank, which is what the sheet's own formula does.
* **Five rows have no invoice details** (rows 25, 27, 34, 37, 38) — surfaced on the
  *Data Quality* page.
* **Two rows carry fractional final payments** (rows 7 and 12, e.g. `2582447.09429161`).
* **Late payment penalty is `TODAY()`-based**, so it moves daily. The workbook was last
  calculated on 2026‑09‑12; the model recomputes to the day you open it.

## The tests

```bash
python3 tools/build_pbip.py     # regenerate the project from Book1.xlsx
python3 tools/test_pbip.py      # run the test suite (exit code 0 = pass)
python3 tools/test_pbip.py --verbose
```

Item files are validated against **`microsoft/json-schemas`** (`.schemas/authoritative/`) —
the schemas Power BI Desktop itself uses. The older `microsoft/powerbi-desktop-samples`
item-schemas from 2023 are *not* authoritative: they predate the now-mandatory `$schema`
property and will pass a project that Desktop refuses to open. See the postmortem in
`VALIDATION-REPORT.md`.

Nine groups: official Microsoft JSON-Schema validation of the item files; project
cross-references; a full TMDL parse; model integrity (types, `sortByColumn`, partitions,
relationships, M typing); DAX reference resolution, bracket/quote balance and
constant verification; a step-by-step replay of the Power Query pipeline; cell-by-cell
comparison of the data against `Book1.xlsx`; an independent re-implementation of every
measure compared with the values Excel itself stored; and report-to-model binding checks.

**Not covered here:** the suite cannot execute DAX or Power Query (no Analysis Services
engine or .NET runtime on Linux), and it cannot render the report. See
`VALIDATION-REPORT.md` for exactly what was and was not verified.
