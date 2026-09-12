#!/usr/bin/env python3
"""
Build a Power BI Desktop project (.pbip) from Book1.xlsx.

Source : Book1.xlsx  -> sheet "Final Calculation Sheet" (37 data rows, cols A..AH)
Target : Receivables Tracker.pbip
           Receivables Tracker.Report/          (PBIR-Legacy report.json)
           Receivables Tracker.SemanticModel/   (TMDL semantic model)
           Data/receivables.csv                 (the model's single source of truth)

Every spreadsheet *formula* column is re-implemented as a DAX measure / calculated
column, so the model recomputes the numbers instead of shipping stale cached values.

Usage:  python3 tools/build_pbip.py
"""
from __future__ import annotations

import base64
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import uuid
import zlib

import openpyxl

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
XLSX = os.path.join(REPO, "Book1.xlsx")
SHEET = "Final Calculation Sheet"

PROJECT = "Receivables Tracker"

# Schema URLs from microsoft/json-schemas - the schemas Power BI Desktop validates
# against. Every one of these files *requires* a $schema property.
SCHEMA = "https://developer.microsoft.com/json-schemas/fabric"
S_PBIP = f"{SCHEMA}/pbip/pbipProperties/1.0.0/schema.json"
S_PLATFORM = f"{SCHEMA}/gitIntegration/platformProperties/2.0.0/schema.json"
S_PBIR = f"{SCHEMA}/item/report/definitionProperties/2.0.0/schema.json"
S_PBISM = f"{SCHEMA}/item/semanticModel/definitionProperties/1.0.0/schema.json"
S_REPORT_LOCAL = f"{SCHEMA}/item/report/localSettings/1.0.0/schema.json"
S_SM_EDITOR = f"{SCHEMA}/item/semanticModel/editorSettings/1.0.0/schema.json"

# Report-definition format version. 4.0 = PBIR-Legacy (report.json) or PBIR (definition/).
PBIR_VERSION = "4.0"
REPORT_DIR = f"{PROJECT}.Report"
MODEL_DIR = f"{PROJECT}.SemanticModel"
DATA_REL = "Data/receivables.csv"
FIRST_ROW, LAST_ROW = 2, 38  # 37 data rows

# ---------------------------------------------------------------------------
# The model only imports the columns the spreadsheet *typed in*.
# Every formula column (I, J, K, L, M, N, O, P, R, S, T, W, Z, AC, AD, AE)
# is re-implemented as a DAX measure / calculated column, so the model
# recomputes them and cannot drift out of sync with the inputs.
#
# (excel col, model name, PQ type, DAX data type, format string, summarizeBy)
COLUMNS = [
    ("A", "Quantity",                     "type number",        "double", "#,##0.###", "sum"),
    ("B", "Lot Name",                     "type nullable text", "string", None,        "none"),
    ("C", "Rate",                         "type number",        "double", "#,##0.##",  "sum"),
    ("D", "Bid Sheet",                    "Int64.Type",         "int64",  "0",         "none"),
    ("E", "Unit",                         "type nullable text", "string", None,        "none"),
    ("F", "Lot No.",                      "Int64.Type",         "int64",  "0",         "none"),
    ("G", "Buyer",                        "type nullable text", "string", None,        "none"),
    ("H", "Material Value",               "Int64.Type",         "int64",  "#,##0",     "sum"),
    ("Q", "GST TDS Rate",                 "type number",        "double", "0.00%",     "none"),
    ("U", "Security Deposit (Received)",  "type number",        "double", "#,##0",     "sum"),
    ("V", "SD Receipt Date (Text)",       "type nullable text", "string", None,        "none"),
    ("X", "Final Payment (Received)",     "type number",        "double", "#,##0.00",  "sum"),
    ("Y", "FP Receipt Date (Text)",       "type nullable text", "string", None,        "none"),
    ("AA", "LPP Received",                "type number",        "double", "#,##0.00",  "sum"),
    ("AB", "LPP Receipt Date (Text)",     "type nullable text", "string", None,        "none"),
    ("AE", "Payment Status (Sheet)",      "type nullable text", "string", None,        "none"),
    ("AF", "Invoice No.",                 "type nullable text", "string", None,        "none"),
    ("AG", "SAP Document",                "type nullable text", "string", None,        "none"),
    ("AH", "Invoice Date (Text)",         "type nullable text", "string", None,        "none"),
]
BY_LETTER = {c[0]: c for c in COLUMNS}
MODEL_NAMES = [c[1] for c in COLUMNS]
DATE_TEXT_COLS = {"V", "Y", "AB", "AH"}

# spreadsheet columns that are formulas - recomputed in DAX, never imported
DERIVED_COLS = {
    "I": ("GST", "measure"), "J": ("Material Value incl. GST", "measure"),
    "K": ("TCS", "measure"), "L": ("TDS u/s 194(O)", "measure"),
    "M": ("Service Charge to MSTC", "measure"), "N": ("TDS u/s 194(H)", "measure"),
    "O": ("Net Service Charge", "measure"), "P": ("Service Charge to MSTC (Net)", "measure"),
    "R": ("GST TDS", "measure"), "S": ("Total Receivables in Cash", "measure"),
    "T": ("Security Deposit (Expected)", "measure"), "W": ("Final Payment (Expected)", "measure"),
    "Z": ("LPP Expected", "measure"), "AC": ("Total Received", "measure"),
    "AD": ("Outstanding", "measure"), "AE": ("Payment Status Calc", "calculated column"),
}


# --------------------------------------------------------------------------- #
# small TMDL / json helpers
# --------------------------------------------------------------------------- #
def tmdl_str(value: str) -> str:
    """Escape a value for a single-line TMDL double-quoted string literal."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def tmdl_expr(expr: str, indent: str = "\t\t") -> str:
    """TMDL multi-line expression block (triple-backtick)."""
    body = "\n".join((indent + ln) if ln.strip() else "" for ln in expr.strip("\n").split("\n"))
    return "```\n" + body + "\n" + indent + "```"


def jdump(obj) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def write(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)


# --------------------------------------------------------------------------- #
# workbook read + normalisation
# --------------------------------------------------------------------------- #
DATE_RE = re.compile(r"^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$")


def parse_ddmmyyyy(raw):
    """'24.08.2026' -> datetime.date.  0 / None / '' -> None."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return None
    if isinstance(raw, dt.datetime):
        return raw.date()
    if isinstance(raw, dt.date):
        return raw
    m = DATE_RE.match(str(raw).strip())
    if not m:
        raise ValueError(f"unparseable date text {raw!r}")
    d, mo, y = (int(g) for g in m.groups())
    return dt.date(y, mo, d)


def csv_cell(letter: str, raw) -> str:
    spec = BY_LETTER[letter]
    if raw is None:
        return ""
    if letter in DATE_TEXT_COLS:
        d = parse_ddmmyyyy(raw)
        return "" if d is None else d.isoformat()
    if spec[3] == "string":
        return str(raw).strip()
    if isinstance(raw, str):
        return raw.strip()
    if isinstance(raw, float):
        if raw == int(raw):
            return str(int(raw))
        # full round-trip precision - Excel stores IEEE-754 doubles
        return repr(float(raw))
    return str(raw)


def read_workbook():
    wb = openpyxl.load_workbook(XLSX, data_only=True)
    if SHEET not in wb.sheetnames:
        raise SystemExit(f"sheet {SHEET!r} not found in {XLSX}")
    ws = wb[SHEET]
    records = []
    for r in range(FIRST_ROW, LAST_ROW + 1):
        rec = {"_row": r}
        for letter, _n, _pq, _dax, _fmt, _s in COLUMNS:
            raw = ws[f"{letter}{r}"].value
            rec[letter] = raw
            rec[f"csv_{letter}"] = csv_cell(letter, raw)
        records.append(rec)
    return ws, records


def write_csv(records) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    w.writerow(MODEL_NAMES)
    for rec in records:
        w.writerow([rec[f"csv_{c[0]}"] for c in COLUMNS])
    text = buf.getvalue()
    write(os.path.join(REPO, DATA_REL), text)
    return text


# --------------------------------------------------------------------------- #
# DAX
# --------------------------------------------------------------------------- #
DAX_DATE_CALC = """VAR _t = TRIM ( 'Receivables'[{src}] )
RETURN
\tIF (
\t\tISBLANK ( _t ) || _t = "0" || LEN ( _t ) <> 10,
\t\tBLANK (),
\t\tDATE ( VALUE ( MID ( _t, 7, 4 ) ), VALUE ( MID ( _t, 4, 2 ) ), VALUE ( LEFT ( _t, 2 ) ) )
\t)"""

CALC_COLUMNS = [
    ("SD Receipt Date", "dateTime", "dd/mm/yyyy", False,
     "True date parsed from 'SD Receipt Date (Text)' (dd.mm.yyyy on the sheet).",
     DAX_DATE_CALC.format(src="SD Receipt Date (Text)")),
    ("FP Receipt Date", "dateTime", "dd/mm/yyyy", False,
     "True date parsed from 'FP Receipt Date (Text)'.",
     DAX_DATE_CALC.format(src="FP Receipt Date (Text)")),
    ("LPP Receipt Date", "dateTime", "dd/mm/yyyy", False,
     "True date parsed from 'LPP Receipt Date (Text)'.",
     DAX_DATE_CALC.format(src="LPP Receipt Date (Text)")),
    ("Invoice Date", "dateTime", "dd/mm/yyyy", False,
     "True date parsed from 'Invoice Date (Text)' (Excel column AH).",
     DAX_DATE_CALC.format(src="Invoice Date (Text)")),
    ("LPP Expected Calc", "double", "#,##0.00", True,
     "Row-level late payment penalty. Hidden - consumed by [Outstanding Calc].",
     """VAR _LPPStart = DATE ( 2026, 8, 22 )
VAR _Grace = DATE ( 2026, 8, 24 )
VAR _Received = 'Receivables'[FP Receipt Date]
VAR _End = IF ( ISBLANK ( _Received ), TODAY (), _Received )
VAR _Weeks = CEILING ( DIVIDE ( DATEDIFF ( _LPPStart, _End, DAY ), 7 ), 1 )
RETURN
\tIF (
\t\tNOT ISBLANK ( _Received ) && _Received <= _Grace,
\t\t0,
\t\t'Receivables'[Material Value] * 0.0118 * _Weeks
\t)"""),
    ("Outstanding Calc", "double", "#,##0.00", True,
     "Row-level outstanding amount. Hidden - consumed by the payment-status measures.",
     """VAR _MatValue = 'Receivables'[Material Value]
VAR _GstTds = ROUND ( _MatValue * 'Receivables'[GST TDS Rate], 0 )
VAR _Lpp = 'Receivables'[LPP Expected Calc]
VAR _Receivable = ROUND ( _MatValue * 1.1765 - _GstTds + _Lpp, 0 )
VAR _Received =
\tCOALESCE ( 'Receivables'[Security Deposit (Received)], 0 )
\t\t+ COALESCE ( 'Receivables'[Final Payment (Received)], 0 )
\t\t+ COALESCE ( 'Receivables'[LPP Received], 0 )
RETURN
\t_Receivable - _Received"""),
    ("Payment Status", "string", None, False,
     "SETTLED when the row-level Outstanding is 5 or less, otherwise OUTSTANDING. "
     "Recomputed from the inputs; mirrors Excel column AE. Compare with "
     "[Payment Status (Sheet)] to spot rows the spreadsheet has not recalculated.",
     """IF ( 'Receivables'[Outstanding Calc] <= 5, "SETTLED", "OUTSTANDING" )"""),
]

MEASURES = [
    ("Lot Count", "#,##0", False, "Number of lots in the current filter context.",
     "COUNTROWS ( 'Receivables' )"),
    ("Material Value", "#,##0", False, "Excel column H - auction material value before tax.",
     "SUM ( 'Receivables'[Material Value] )"),
    ("GST", "#,##0", False, "Excel column I - ROUND( Material Value * 18%, 0 ).",
     "SUMX ( 'Receivables', ROUND ( 'Receivables'[Material Value] * 0.18, 0 ) )"),
    ("Material Value incl. GST", "#,##0", False, "Excel column J - Material Value + GST.",
     """SUMX (
\t'Receivables',
\t'Receivables'[Material Value] + ROUND ( 'Receivables'[Material Value] * 0.18, 0 )
)"""),
    ("TCS", "#,##0", False, "Excel column K - ROUND( ( Material Value + GST ) * 2%, 0 ).",
     """SUMX (
\t'Receivables',
\tROUND ( ( 'Receivables'[Material Value] + ROUND ( 'Receivables'[Material Value] * 0.18, 0 ) ) * 0.02, 0 )
)"""),
    ("TDS u/s 194(O)", "#,##0.00", False, "Excel column L - Material Value * 0.1% (source is not rounded).",
     "SUMX ( 'Receivables', 'Receivables'[Material Value] * 0.001 )"),
    ("Service Charge to MSTC", "#,##0.00", False, "Excel column M - Material Value * 2.25% * 118%.",
     "SUMX ( 'Receivables', 'Receivables'[Material Value] * 0.0225 * 1.18 )"),
    ("TDS u/s 194(H)", "#,##0.00", False, "Excel column N - Material Value * 2.25% * 2%.",
     "SUMX ( 'Receivables', 'Receivables'[Material Value] * 0.0225 * 0.02 )"),
    ("Net Service Charge", "#,##0.00", False, "Excel column O - Service Charge to MSTC - TDS u/s 194(H).",
     "SUMX ( 'Receivables', 'Receivables'[Material Value] * 0.0225 * ( 1.18 - 0.02 ) )"),
    ("Service Charge to MSTC (Net)", "#,##0", False, "Excel column P - ROUND( Net Service Charge + TDS u/s 194(O), 0 ).",
     """SUMX (
\t'Receivables',
\tROUND ( 'Receivables'[Material Value] * 0.0225 * ( 1.18 - 0.02 ) + 'Receivables'[Material Value] * 0.001, 0 )
)"""),
    ("GST TDS", "#,##0", False, "Excel column R - ROUND( Material Value * GST TDS Rate, 0 ).",
     "SUMX ( 'Receivables', ROUND ( 'Receivables'[Material Value] * 'Receivables'[GST TDS Rate], 0 ) )"),
    ("LPP Expected", "#,##0.00", False,
     "Excel column Z - late payment penalty: 1.18% of Material Value per started week from 22-Aug-2026 "
     "to the final-payment receipt date (grace to 24-Aug-2026); accrues to today while unpaid.",
     "SUMX ( 'Receivables', 'Receivables'[LPP Expected Calc] )"),
    ("Security Deposit (Expected)", "#,##0", False, "Excel column T - ROUND( Material Value * 25%, 0 ).",
     "SUMX ( 'Receivables', ROUND ( 'Receivables'[Material Value] * 0.25, 0 ) )"),
    ("Security Deposit (Received)", "#,##0", False, "Excel column U - as entered on the sheet.",
     "SUM ( 'Receivables'[Security Deposit (Received)] )"),
    ("Final Payment (Expected)", "#,##0", False, "Excel column W - ROUND( Material Value * 92.65% - GST TDS, 0 ).",
     """SUMX (
\t'Receivables',
\tROUND ( 'Receivables'[Material Value] * 0.9265 - ROUND ( 'Receivables'[Material Value] * 'Receivables'[GST TDS Rate], 0 ), 0 )
)"""),
    ("Final Payment (Received)", "#,##0.00", False, "Excel column X - as entered on the sheet.",
     "SUM ( 'Receivables'[Final Payment (Received)] )"),
    ("LPP Received", "#,##0.00", False, "Excel column AA - late payment penalty actually received.",
     "SUM ( 'Receivables'[LPP Received] )"),
    ("Total Receivables in Cash", "#,##0", False,
     "Excel column S - ROUND( Material Value * 117.65% - GST TDS + LPP Expected, 0 ).",
     """SUMX (
\t'Receivables',
\tROUND (
\t\t'Receivables'[Material Value] * 1.1765
\t\t\t- ROUND ( 'Receivables'[Material Value] * 'Receivables'[GST TDS Rate], 0 )
\t\t\t+ 'Receivables'[LPP Expected Calc],
\t\t0
\t)
)"""),
    ("Total Received", "#,##0.00", False,
     "Excel column AC - Security Deposit (Received) + Final Payment (Received) + LPP Received.",
     """SUMX (
\t'Receivables',
\tCOALESCE ( 'Receivables'[Security Deposit (Received)], 0 )
\t\t+ COALESCE ( 'Receivables'[Final Payment (Received)], 0 )
\t\t+ COALESCE ( 'Receivables'[LPP Received], 0 )
)"""),
    ("Outstanding", "#,##0.00", False, "Excel column AD - Total Receivables in Cash - Total Received.",
     "[Total Receivables in Cash] - [Total Received]"),
    ("Recovery %", "0.0%", False, "Total Received as a percentage of Total Receivables in Cash.",
     "DIVIDE ( [Total Received], [Total Receivables in Cash] )"),
    ("Lots Settled", "#,##0", False, "Excel column AE - lots whose Outstanding is 5 or less.",
     "COUNTROWS ( FILTER ( 'Receivables', 'Receivables'[Outstanding Calc] <= 5 ) )"),
    ("Lots Outstanding", "#,##0", False, "Excel column AE - lots whose Outstanding is above 5.",
     "COUNTROWS ( FILTER ( 'Receivables', 'Receivables'[Outstanding Calc] > 5 ) )"),
    ("Lots Missing Invoice Details", "#,##0", False,
     "Lots with no Invoice No., SAP Document or Invoice Date.",
     """COUNTROWS (
\tFILTER (
\t\t'Receivables',
\t\tISBLANK ( 'Receivables'[Invoice No.] )
\t\t\t|| ISBLANK ( 'Receivables'[SAP Document] )
\t\t\t|| ISBLANK ( 'Receivables'[Invoice Date] )
\t)
)"""),
    ("Over-Receipts", "#,##0.00", False, "Received in excess of Total Receivables in Cash (negative Outstanding).",
     "SUMX ( FILTER ( 'Receivables', 'Receivables'[Outstanding Calc] < 0 ), - 'Receivables'[Outstanding Calc] )"),
    ("Lots Without FP Receipt Date", "#,##0", False, "Lots with no final-payment receipt date entered.",
     "COUNTROWS ( FILTER ( 'Receivables', ISBLANK ( 'Receivables'[FP Receipt Date] ) ) )"),
    ("Lots With Zero GST TDS Rate", "#,##0", False, "Lots where the GST TDS Rate is 0.",
     "COUNTROWS ( FILTER ( 'Receivables', 'Receivables'[GST TDS Rate] = 0 ) )"),
]

RELATIONSHIPS = [
    ("Receivables", "SD Receipt Date", "Receipt Date", "Date", True,
     "Security-deposit receipt date to calendar"),
    ("Receivables", "FP Receipt Date", "Receipt Date", "Date", False,
     "Final-payment receipt date to calendar (inactive - use USERELATIONSHIP)"),
    ("Receivables", "Invoice Date", "Invoice Date", "Date", True,
     "Invoice / SAP document date to calendar"),
    ("Receivables", "Buyer", "Buyer", "Buyer", True, "Buyer dimension"),
]


def m_type_list(indent: str = "\t\t\t\t\t") -> str:
    rows = ",\n".join(f'{indent}{{"{name}", {pq}}}' for _l, name, pq, _d, _f, _s in COLUMNS)
    return f"{indent}{{\n{rows}\n{indent}}}"


def pq_embedded(csv_text: str) -> str:
    """Primary query: the 37 rows travel inside the model as base64.

    Nothing to configure, no folder path, no privacy prompt - the project opens
    and loads exactly as built.
    """
    b64 = base64.b64encode(csv_text.encode("utf-8")).decode("ascii")
    return f"""let
\tCsvBase64 = "{b64}",
\tSource = Csv.Document(Binary.FromText(CsvBase64), [Delimiter = ",", Encoding = 65001]),
\tPromoted = Table.PromoteHeaders(Source, [PromoteAllScalars = true]),
\tTyped = Table.TransformColumnTypes(
\t\tPromoted,
{m_type_list()}
\t)
in
\tTyped"""


def pq_from_csv() -> str:
    """Alternative query: read Data/receivables.csv next to the project.

    Use this one for a monthly refresh - replace the CSV and refresh. The path is
    resolved from the query's own location, so the project folder can be moved.
    """
    return f"""let
\tProjectRoot = Text.BeforeDelimiter(Text.From(#section[Section1][ReceivablesFromCsv][Meta][ConceptualRelativePath]), "/", {{0, -1}}),
\tCsvPath = Text.Combine({{ProjectRoot, "Data", "receivables.csv"}}, "/"),
\tSource = Csv.Document(File.Contents(CsvPath), [Delimiter = ",", Encoding = 65001]),
\tPromoted = Table.PromoteHeaders(Source, [PromoteAllScalars = true]),
\tTyped = Table.TransformColumnTypes(
\t\tPromoted,
{m_type_list()}
\t)
in
\tTyped"""


# --------------------------------------------------------------------------- #
# TMDL emission
# --------------------------------------------------------------------------- #
def build_model_tmdl(csv_text: str) -> dict:
    files = {}
    files["model.tmdl"] = (
        "model Model\n"
        "\tculture: en-IN\n"
        "\tdefaultPowerBIDataSourceVersion: powerBI_V3\n"
        "\tdiscourageImplicitMeasures\n"
        "\tsourceQueryCulture: en-IN\n"
        "\tcompatibilityLevel: 1567\n"
    )
    files["database.tmdl"] = (
        "database\n"
        "\tcompatibilityLevel: 1567\n"
        f"\tmodelName: {tmdl_str(PROJECT)}\n"
    )
    files["expression.tmdl"] = (
        "shared expression Receivables =\n\t" + tmdl_expr(pq_embedded(csv_text)) + "\n"
        "\n"
        "// Alternative loader - reads Data/receivables.csv from the project folder.\n"
        "// Point the Receivables partition at ReceivablesFromCsv to refresh from the CSV.\n"
        "shared expression ReceivablesFromCsv =\n\t" + tmdl_expr(pq_from_csv()) + "\n"
    )

    t = ["table Receivables", "\tlineageTag: " + str(uuid.uuid4()), ""]
    t.append("\tpartition Receivables")
    t.append("\t\tmode: import")
    t.append("\t\tsource =")
    t.append("\t\t" + tmdl_expr("Receivables"))

    for letter, name, _pq, dax, fmt, summarize in COLUMNS:
        t.append("")
        t.append(f"\tcolumn {tmdl_str(name)}")
        t.append(f"\t\tdataType: {dax}")
        if fmt:
            t.append(f"\t\tformatString: {tmdl_str(fmt)}")
        t.append("\t\tlineageTag: " + str(uuid.uuid4()))
        t.append(f"\t\tsummarizeBy: {'none' if dax in ('string', 'dateTime') else summarize}")
        t.append("\t\tdescription: " + tmdl_str(f"Excel column {letter} of 'Final Calculation Sheet'."))
        t.append("\t\tannotations")
        t.append("\t\t\tannotation PBI_SourceColumn = " + tmdl_str(name))

    for name, dax, fmt, hidden, desc, expr in CALC_COLUMNS:
        t.append("")
        t.append(f"\tcolumn {tmdl_str(name)} =")
        t.append("\t\t" + tmdl_expr(expr))
        t.append(f"\t\tdataType: {dax}")
        if fmt:
            t.append(f"\t\tformatString: {tmdl_str(fmt)}")
        t.append("\t\tisDataTypeInferred")
        if hidden:
            t.append("\t\tisHidden")
        t.append("\t\tlineageTag: " + str(uuid.uuid4()))
        t.append(f"\t\tsummarizeBy: {'sum' if dax in ('int64', 'double', 'decimal') else 'none'}")
        t.append("\t\tdescription: " + tmdl_str(desc))

    for name, fmt, hidden, desc, expr in MEASURES:
        t.append("")
        t.append(f"\tmeasure {tmdl_str(name)} =")
        t.append("\t\t" + tmdl_expr(expr))
        t.append(f"\t\tformatString: {tmdl_str(fmt)}")
        if hidden:
            t.append("\t\tisHidden")
        t.append("\t\tlineageTag: " + str(uuid.uuid4()))
        t.append("\t\tdescription: " + tmdl_str(desc))

    files["tables/Receivables.tmdl"] = "\n".join(t) + "\n"

    files["tables/Buyer.tmdl"] = "\n".join([
        "table Buyer",
        "\tlineageTag: " + str(uuid.uuid4()),
        "",
        "\tcolumn " + tmdl_str("Buyer") + " =",
        "\t\t" + tmdl_expr("DISTINCT ( 'Receivables'[Buyer] )"),
        "\t\tdataType: string",
        "\t\tisDataTypeInferred",
        "\t\tlineageTag: " + str(uuid.uuid4()),
        "\t\tsummarizeBy: none",
        "\t\tdescription: " + tmdl_str("Distinct buyers, derived from the receivables rows."),
        "",
        "\tmeasure " + tmdl_str("Buyer Lots") + " =",
        "\t\t" + tmdl_expr("CALCULATE ( [Lot Count] )"),
        "\t\tformatString: " + tmdl_str("#,##0"),
        "\t\tlineageTag: " + str(uuid.uuid4()),
        "",
        "\tmeasure " + tmdl_str("Buyer Outstanding") + " =",
        "\t\t" + tmdl_expr("CALCULATE ( [Outstanding] )"),
        "\t\tformatString: " + tmdl_str("#,##0.00"),
        "\t\tlineageTag: " + str(uuid.uuid4()),
    ]) + "\n"

    for tbl in ("Receipt Date", "Invoice Date"):
        files[f"tables/{tbl}.tmdl"] = "\n".join([
            f"table {tmdl_str(tbl)}",
            "\tlineageTag: " + str(uuid.uuid4()),
            "",
            "\tcolumn " + tmdl_str("Date") + " =",
            "\t\t" + tmdl_expr("CALENDAR ( DATE ( 2026, 1, 1 ), DATE ( 2027, 12, 31 ) )"),
            "\t\tdataType: dateTime",
            "\t\tformatString: " + tmdl_str("dd/mm/yyyy"),
            "\t\tisDataTypeInferred",
            "\t\tisKey",
            "\t\tlineageTag: " + str(uuid.uuid4()),
            "\t\tsummarizeBy: none",
            "",
            "\tcolumn " + tmdl_str("DateKey") + " =",
            "\t\t" + tmdl_expr(f"YEAR ( '{tbl}'[Date] ) * 10000 + MONTH ( '{tbl}'[Date] ) * 100 + DAY ( '{tbl}'[Date] )"),
            "\t\tdataType: int64",
            "\t\tformatString: " + tmdl_str("0"),
            "\t\tisDataTypeInferred",
            "\t\tisHidden",
            "\t\tlineageTag: " + str(uuid.uuid4()),
            "\t\tsummarizeBy: none",
            "",
            "\tcolumn " + tmdl_str("Month") + " =",
            "\t\t" + tmdl_expr(f"FORMAT ( '{tbl}'[Date], \"mmm yyyy\" )"),
            "\t\tdataType: string",
            "\t\tisDataTypeInferred",
            "\t\tlineageTag: " + str(uuid.uuid4()),
            "\t\tsortByColumn: " + tmdl_str("MonthKey"),
            "\t\tsummarizeBy: none",
            "",
            "\tcolumn " + tmdl_str("MonthKey") + " =",
            "\t\t" + tmdl_expr(f"YEAR ( '{tbl}'[Date] ) * 100 + MONTH ( '{tbl}'[Date] )"),
            "\t\tdataType: int64",
            "\t\tformatString: " + tmdl_str("0"),
            "\t\tisDataTypeInferred",
            "\t\tisHidden",
            "\t\tlineageTag: " + str(uuid.uuid4()),
            "\t\tsummarizeBy: none",
            "",
            "\tmeasure " + tmdl_str("Day Count") + " =",
            "\t\t" + tmdl_expr(f"COUNTROWS ( '{tbl}' )"),
            "\t\tformatString: " + tmdl_str("#,##0"),
            "\t\tisHidden",
            "\t\tlineageTag: " + str(uuid.uuid4()),
        ]) + "\n"

    rel = []
    for frm, fc, to, tc, active, desc in RELATIONSHIPS:
        rel.append("relationship " + str(uuid.uuid4()))
        rel.append(f"\tfromColumn: {frm}.{tmdl_str(fc)}")
        rel.append(f"\ttoColumn: {to}.{tmdl_str(tc)}")
        rel.append("\tcardinality: manyToOne")
        rel.append("\tcrossFilteringBehavior: single")
        if not active:
            rel.append("\tisActive: false")
        rel.append("\tdescription: " + tmdl_str(desc))
        rel.append("")
    files["relationships.tmdl"] = "\n".join(rel)
    return files


# --------------------------------------------------------------------------- #
# report.json (PBIR-Legacy)
# --------------------------------------------------------------------------- #
def qm(role, name, entity="Receivables"):
    return {"Role": role, "IsMeasure": True, "Property": name, "Entity": entity,
            "QueryRef": f"{entity}.{name}"}


def qc(role, name, entity="Receivables"):
    return {"Role": role, "IsMeasure": False, "Property": name, "Entity": entity,
            "QueryRef": f"{entity}.{name}"}


def v(name, vtype, x, y, w, h, queries, objects=None):
    entities = sorted({q["Entity"] for q in queries})
    alias = {e: f"e{i}" for i, e in enumerate(entities)}
    single = {
        "visualType": vtype,
        "prototypeQuery": {
            "Version": 2,
            "From": [{"Name": alias[e], "Entity": e, "Type": 0} for e in entities],
            "Select": [
                {
                    ("Measure" if q["IsMeasure"] else "Column"): {
                        "Expression": {"SourceRef": {"Source": alias[q["Entity"]]}},
                        "Property": q["Property"],
                    },
                    "Name": q["QueryRef"],
                }
                for q in queries
            ],
        },
        "drillFilterOtherVisuals": True,
    }
    if objects:
        single["objects"] = objects
    return {
        "Name": name,
        "x": x, "y": y, "w": w, "h": h,
        "config": json.dumps({"name": name, "singleVisual": single}, separators=(",", ":")),
    }


def build_report_json() -> dict:
    pages = []

    pages.append(("Overview", "pOverview", [
        v("vCardLots", "card", 0, 0, 232, 140, [qm("Values", "Lot Count")]),
        v("vCardMatValue", "card", 242, 0, 232, 140, [qm("Values", "Material Value")]),
        v("vCardReceivable", "card", 484, 0, 232, 140, [qm("Values", "Total Receivables in Cash")]),
        v("vCardReceived", "card", 726, 0, 232, 140, [qm("Values", "Total Received")]),
        v("vCardOutstanding", "card", 968, 0, 232, 140, [qm("Values", "Outstanding")]),
        v("vStatusPie", "pieChart", 0, 150, 470, 330,
          [qc("Category", "Payment Status"), qm("Y", "Total Receivables in Cash")]),
        v("vComposition", "barChart", 482, 150, 718, 330,
          [qc("Category", "Payment Status"),
           qm("Y", "Security Deposit (Received)"),
           qm("Y", "Final Payment (Received)"),
           qm("Y", "LPP Received")]),
        v("vBuyerBar", "clusteredBarChart", 0, 492, 1200, 296,
          [qc("Category", "Buyer", "Buyer"), qm("Y", "Outstanding")]),
    ]))

    pages.append(("Receivables Build-Up", "pReceivables", [
        v("vStack", "clusteredColumnChart", 0, 0, 1200, 440,
          [qc("Category", "Payment Status"),
           qm("Y", "Material Value"),
           qm("Y", "GST"),
           qm("Y", "TCS"),
           qm("Y", "GST TDS"),
           qm("Y", "Service Charge to MSTC (Net)"),
           qm("Y", "LPP Expected")]),
        v("vKpiTable", "tableEx", 0, 452, 1200, 336,
          [qm("Values", m) for m in (
              "Material Value", "Material Value incl. GST", "TCS", "TDS u/s 194(O)",
              "Service Charge to MSTC", "TDS u/s 194(H)", "Net Service Charge",
              "Service Charge to MSTC (Net)", "GST TDS", "Total Receivables in Cash")]),
    ]))

    pages.append(("Buyer Analysis", "pBuyers", [
        v("vSlicerStatus", "slicer", 0, 0, 250, 96, [qc("Values", "Payment Status")]),
        v("vSlicerBuyer", "slicer", 260, 0, 250, 96, [qc("Values", "Buyer", "Buyer")]),
        v("vSlicerUnit", "slicer", 520, 0, 190, 96, [qc("Values", "Unit")]),
        v("vSlicerMonth", "slicer", 720, 0, 240, 96, [qc("Values", "Month", "Receipt Date")]),
        v("vBuyerMatrix", "pivotTable", 0, 108, 1200, 680,
          [qc("Rows", "Buyer", "Buyer"),
           qm("Values", "Lot Count"),
           qm("Values", "Material Value"),
           qm("Values", "Total Receivables in Cash"),
           qm("Values", "Total Received"),
           qm("Values", "Outstanding"),
           qm("Values", "Recovery %")]),
    ]))

    reg_cols = ["Lot No.", "Bid Sheet", "Lot Name", "Buyer", "Unit", "Quantity", "Rate",
                "Material Value", "Security Deposit (Received)", "Final Payment (Received)",
                "Payment Status", "Invoice No.", "SAP Document"]
    reg_measures = ["GST", "TCS", "GST TDS", "LPP Expected", "Total Receivables in Cash",
                    "Total Received", "Outstanding"]
    pages.append(("Lot Register", "pRegister", [
        v("vRegSlicerStatus", "slicer", 0, 0, 250, 96, [qc("Values", "Payment Status")]),
        v("vRegSlicerBuyer", "slicer", 260, 0, 250, 96, [qc("Values", "Buyer", "Buyer")]),
        v("vRegister", "tableEx", 0, 108, 1200, 680,
          [qc("Values", c) for c in reg_cols] + [qm("Values", m) for m in reg_measures]),
    ]))

    pages.append(("Data Quality", "pDataQuality", [
        v("vDqMissing", "card", 0, 0, 290, 140, [qm("Values", "Lots Missing Invoice Details")]),
        v("vDqOutstanding", "card", 300, 0, 290, 140, [qm("Values", "Lots Outstanding")]),
        v("vDqOver", "card", 600, 0, 290, 140, [qm("Values", "Over-Receipts")]),
        v("vDqRecovery", "card", 900, 0, 300, 140, [qm("Values", "Recovery %")]),
        v("vDqTable", "tableEx", 0, 152, 1200, 300,
          [qc("Values", c) for c in ("Lot No.", "Bid Sheet", "Buyer", "Invoice No.", "SAP Document",
                                     "Invoice Date", "Payment Status (Sheet)")]
          + [qm("Values", m) for m in ("Total Receivables in Cash", "Total Received", "Outstanding")]),
        v("vDqMonth", "clusteredColumnChart", 0, 464, 1200, 324,
          [qc("Category", "Month", "Receipt Date"),
           qm("Y", "Total Receivables in Cash"),
           qm("Y", "Total Received")]),
    ]))

    return {
        "$schema": "http://powerbi.com/product/schema/report",
        "themeCollection": {"baseTheme": {"name": "CY24SU06", "version": "5.41", "type": 2}},
        "resourcePackages": [{
            "resourcePackage": {
                "name": "SharedResources",
                "type": 2,
                "items": [{"name": "CY24SU06", "path": "BaseThemes/CY24SU06.json", "type": 202}],
            }
        }],
        "sections": [
            {
                "displayName": title,
                "name": name,
                "ordinal": i,
                "width": 1280,
                "height": 800,
                "displayOption": 0,
                "config": json.dumps({"relationships": []}, separators=(",", ":")),
                "filters": "[]",
                "visualContainers": [
                    {
                        "x": vis["x"], "y": vis["y"], "z": 1000 + i * 100 + j,
                        "width": vis["w"], "height": vis["h"],
                        "name": vis["Name"],
                        "config": vis["config"],
                        "dataTransforms": "{}",
                    }
                    for j, vis in enumerate(visuals)
                ],
            }
            for i, (title, name, visuals) in enumerate(pages)
        ],
        "config": json.dumps({
            "version": "5.41",
            "themeCollection": {"baseTheme": {"name": "CY24SU06", "version": "5.41", "type": 2}},
            "activeSectionIndex": 0,
            "defaultDrillFilterOtherVisuals": True,
            "settings": {
                "useNewFilterPaneExperience": True,
                "allowChangeFilterTypes": True,
                "useStylableVisualContainerHeader": True,
                "exportDataMode": 1,
            },
            "objects": {},
        }, separators=(",", ":")),
        "layoutOptimization": 0,
    }


BASE_THEME = {
    "name": "CY24SU06",
    "dataColors": ["#118DFF", "#12239E", "#E66C37", "#6B007B", "#E044A7", "#744EC2", "#D9B300", "#D64550"],
    "background": "#FFFFFF",
    "foreground": "#252423",
    "tableAccent": "#118DFF",
    "good": "#1A9613",
    "neutral": "#D9B300",
    "bad": "#D64550",
    "maximum": "#118DFF",
    "center": "#D9B300",
    "minimum": "#E044A7",
    "null": "#A6A6A6",
    "textClasses": {
        "callout": {"fontSize": 45, "fontFace": "DIN", "color": "#252423"},
        "title": {"fontSize": 12, "fontFace": "DIN", "color": "#252423"},
        "header": {"fontSize": 12, "fontFace": "Segoe UI Semibold", "color": "#252423"},
        "label": {"fontSize": 10, "fontFace": "Segoe UI", "color": "#252423"},
    },
}


# --------------------------------------------------------------------------- #
def main() -> int:
    ws, records = read_workbook()
    csv_text = write_csv(records)

    root = REPO
    rep = os.path.join(root, REPORT_DIR)
    mdl = os.path.join(root, MODEL_DIR)

    write(os.path.join(root, f"{PROJECT}.pbip"), jdump({
        "$schema": S_PBIP,
        "version": "1.0",
        "artifacts": [{"report": {"path": REPORT_DIR}}],
        "settings": {"enableAutoRecovery": True},
    }))

    write(os.path.join(rep, ".platform"), jdump({
        "$schema": S_PLATFORM,
        "metadata": {"type": "Report", "displayName": PROJECT},
        "config": {"version": "2.0", "logicalId": str(uuid.uuid4())},
    }))
    write(os.path.join(rep, "item.config.json"), jdump({"version": "1.0", "logicalId": str(uuid.uuid4())}))
    write(os.path.join(rep, "item.metadata.json"), jdump({
        "type": "Report", "displayName": PROJECT,
        "description": "MSTC scrap-auction receivables tracker built from Book1.xlsx.",
    }))
    write(os.path.join(rep, "definition.pbir"), jdump({
        "$schema": S_PBIR,
        "version": PBIR_VERSION,
        "datasetReference": {"byPath": {"path": f"../{MODEL_DIR}"}},
    }))
    write(os.path.join(rep, ".pbi", "localSettings.json"), jdump({"$schema": S_REPORT_LOCAL}))
    write(os.path.join(rep, "report.json"), jdump(build_report_json()))
    write(os.path.join(rep, "StaticResources", "SharedResources", "BaseThemes", "CY24SU06.json"),
          jdump(BASE_THEME))
    for d in ("StaticResources/RegisteredResources", "CustomVisuals"):
        os.makedirs(os.path.join(rep, d), exist_ok=True)
        write(os.path.join(rep, d, ".gitkeep"), "")

    write(os.path.join(mdl, ".platform"), jdump({
        "$schema": S_PLATFORM,
        "metadata": {"type": "SemanticModel", "displayName": PROJECT},
        "config": {"version": "2.0", "logicalId": str(uuid.uuid4())},
    }))
    write(os.path.join(mdl, "item.config.json"), jdump({"version": "1.0", "logicalId": str(uuid.uuid4())}))
    write(os.path.join(mdl, "item.metadata.json"), jdump({
        "type": "SemanticModel", "displayName": PROJECT,
        "description": "TMDL semantic model for the MSTC scrap-auction receivables tracker.",
    }))
    write(os.path.join(mdl, "definition.pbidataset"), jdump({
        "$schema": S_PBISM,
        "version": "1.0",
        "settings": {"qnaEnabled": False, "qnaLsdlSharingPermissions": 0},
    }))
    write(os.path.join(mdl, ".pbi", "editorSettings.json"), jdump({
        "$schema": S_SM_EDITOR,
        "showHiddenFields": True,
        "autodetectRelationships": False,
        "parallelQueryLoading": True,
        "typeDetectionEnabled": True,
        "relationshipImportEnabled": False,
        "relationshipRefreshEnabled": False,
        "runBackgroundAnalysis": True,
    }))
    write(os.path.join(mdl, "definition", "version.json"), jdump({
        "version": "3.0",
        "compatibilityLevel": 1567,
        "dataAccessOptions": {"legacyRedirects": True, "returnErrorValuesAsNull": True},
        "defaultPowerBIDataSourceVersion": "powerBI_V3",
    }))
    write(os.path.join(mdl, "diagramLayout.json"), jdump({
        "version": "1.1.0",
        "diagrams": [{
            "ordinal": 1, "name": "All tables", "zoomValue": 100,
            "pinKeyFieldsToTop": False, "showExtraHeaderInfo": False,
            "hideKeyFieldsWhenCollapsed": False, "tablesLocked": False,
        }],
        "selectedDiagram": "All tables",
        "defaultDiagram": "All tables",
    }))
    model_files = build_model_tmdl(csv_text)
    for rel, content in model_files.items():
        write(os.path.join(mdl, "definition", rel), content)

    nfiles = len(model_files)
    print(f"OK  built {PROJECT}.pbip")
    print(f"    csv rows={len(records)}  csv bytes={len(csv_text)}  "
          f"zlib9+b64 would be {len(zlib.compress(csv_text.encode(), 9))} bytes")
    print(f"    tmdl files={nfiles}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
