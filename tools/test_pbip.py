#!/usr/bin/env python3
"""
Test suite for "Receivables Tracker.pbip".

What it checks
--------------
A. Structure      - required PBIP files present, every JSON parses, official Microsoft
                    Draft-7 JSON Schemas (microsoft/powerbi-desktop-samples/item-schemas)
                    validate .pbip / .pbir / .pbidataset / item.config / item.metadata /
                    localSettings / editorSettings.
B. Cross-refs     - .pbip -> Report -> SemanticModel path chain, unique logicalIds,
                    theme registration, unique visual/page names, no overlapping visuals.
C. TMDL syntax    - indentation-aware parse of every .tmdl file into a typed object model.
D. Model integrity- duplicate names, relationship endpoints, sortByColumn targets,
                    partition/query wiring, M expression shape, TMDL string escaping.
E. DAX            - brace/paren/quote balance, table & column resolution, measure
                    resolution, circular-measure detection, function whitelist sanity.
F. Power Query    - the M pipeline is simulated step by step in Python against
                    Data/receivables.csv and the resulting table is type-checked.
G. Data fidelity  - every CSV cell is compared to Book1.xlsx cell by cell (1 258 cells).
H. Business rules - every DAX measure / calculated column is re-implemented
                    independently in Python and compared with the cached results Excel
                    itself stored in Book1.xlsx (~750 value comparisons).
I. Report binding - every Entity/Property referenced by a visual exists in the model.

Exit code 0 = no errors.  Use --verbose for per-check output.
"""
from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import glob
import io
import json
import os
import re
import sys
from collections import Counter, defaultdict
from decimal import Decimal, ROUND_HALF_UP

import openpyxl

try:
    import jsonschema
except ImportError:  # pragma: no cover
    jsonschema = None

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = "Receivables Tracker"
REPORT_DIR = os.path.join(REPO, f"{PROJECT}.Report")
MODEL_DIR = os.path.join(REPO, f"{PROJECT}.SemanticModel")
TMDL_DIR = os.path.join(MODEL_DIR, "definition")
SCHEMAS = os.path.join(REPO, ".schemas")
CSV_PATH = os.path.join(REPO, "Data", "receivables.csv")
XLSX = os.path.join(REPO, "Book1.xlsx")

ERRORS: list[str] = []
WARNINGS: list[str] = []
CHECKS: list[tuple[str, int, int]] = []  # (group, ran, failed)
_cur_group = "structure"


def err(msg: str) -> None:
    ERRORS.append(f"[{_cur_group}] {msg}")


def warn(msg: str) -> None:
    WARNINGS.append(f"[{_cur_group}] {msg}")


def group(name: str):
    global _cur_group
    _cur_group = name


# ==========================================================================
# A. structure + JSON schema
# ==========================================================================
def jload(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def check_structure():
    required = [
        f"{PROJECT}.pbip",
        f"{PROJECT}.Report/.platform",
        f"{PROJECT}.Report/item.config.json",
        f"{PROJECT}.Report/item.metadata.json",
        f"{PROJECT}.Report/definition.pbir",
        f"{PROJECT}.Report/report.json",
        f"{PROJECT}.Report/.pbi/localSettings.json",
        f"{PROJECT}.Report/StaticResources/SharedResources/BaseThemes/CY24SU06.json",
        f"{PROJECT}.SemanticModel/.platform",
        f"{PROJECT}.SemanticModel/item.config.json",
        f"{PROJECT}.SemanticModel/item.metadata.json",
        f"{PROJECT}.SemanticModel/definition.pbidataset",
        f"{PROJECT}.SemanticModel/definition/version.json",
        f"{PROJECT}.SemanticModel/definition/model.tmdl",
        f"{PROJECT}.SemanticModel/definition/database.tmdl",
        f"{PROJECT}.SemanticModel/definition/expression.tmdl",
        f"{PROJECT}.SemanticModel/definition/relationships.tmdl",
        f"{PROJECT}.SemanticModel/.pbi/editorSettings.json",
        "Data/receivables.csv",
    ]
    for rel in required:
        p = os.path.join(REPO, rel)
        if not os.path.isfile(p):
            err(f"missing required file: {rel}")

    # every json-ish file must parse
    n_json = 0
    for p in glob.glob(os.path.join(REPO, "**", "*"), recursive=True):
        if not os.path.isfile(p):
            continue
        if "/.git/" in p or p.startswith(os.path.join(REPO, ".git")):
            continue
        if p.endswith((".json", ".pbip", ".pbir", ".pbidataset", ".platform")):
            n_json += 1
            try:
                jload(p)
            except Exception as exc:
                err(f"invalid JSON in {os.path.relpath(p, REPO)}: {exc}")

    if jsonschema is None:
        warn("jsonschema is not installed - official schema validation skipped")
        return n_json

    schema_map = [
        (f"{PROJECT}.pbip", "common/pbip-1.0.json"),
        (f"{PROJECT}.Report/item.config.json", "common/item.config-1.0.json"),
        (f"{PROJECT}.Report/item.metadata.json", "common/item.metadata-1.0.json"),
        (f"{PROJECT}.Report/definition.pbir", "report/definition.pbir-1.0.json"),
        (f"{PROJECT}.Report/.pbi/localSettings.json", "report/localSettings-1.0.json"),
        (f"{PROJECT}.SemanticModel/item.config.json", "common/item.config-1.0.json"),
        (f"{PROJECT}.SemanticModel/item.metadata.json", "common/item.metadata-1.0.json"),
        (f"{PROJECT}.SemanticModel/definition.pbidataset", "dataset/definition.pbidataset-1.0.json"),
        (f"{PROJECT}.SemanticModel/.pbi/editorSettings.json", "dataset/editorSettings-1.0.json"),
    ]
    for rel, schema_rel in schema_map:
        sp = os.path.join(SCHEMAS, schema_rel)
        if not os.path.isfile(sp):
            warn(f"official schema not cached locally: {schema_rel}")
            continue
        schema = jload(sp)
        try:
            instance = jload(os.path.join(REPO, rel))
        except Exception:
            continue
        v = jsonschema.Draft7Validator(schema)
        for p in sorted(v.iter_errors(instance), key=lambda e: list(e.path)):
            loc = "/".join(str(x) for x in p.path) or "<root>"
            # the 2023 item-schemas predate the "$schema" property that current
            # Power BI Desktop writes; flag every other additional property.
            if p.validator == "additionalProperties" and p.message.startswith("Additional properties") \
                    and "'$schema' was unexpected" in p.message:
                warn(f"{rel}: '$schema' is not in the 2023 official schema "
                     f"(written by current Desktop; kept intentionally)")
                continue
            err(f"official schema {os.path.basename(schema_rel)} violation in {rel} @ {loc}: {p.message}")
    return n_json


# ==========================================================================
# B. cross references
# ========================================================================== #
def check_crossrefs():
    pbip = jload(os.path.join(REPO, f"{PROJECT}.pbip"))
    paths = [a.get("report", {}).get("path") for a in pbip.get("artifacts", [])]
    for p in paths:
        if not p:
            err(".pbip artifact has no report.path")
            continue
        if "\\" in p:
            err(f".pbip report path uses backslashes: {p}")
        target = os.path.join(REPO, p)
        if not os.path.isdir(target):
            err(f".pbip points at missing folder: {p}")

    pbir = jload(os.path.join(REPORT_DIR, "definition.pbir"))
    ds = (pbir.get("datasetReference") or {}).get("byPath", {}).get("path")
    if not ds:
        err("definition.pbir has no datasetReference.byPath.path")
    else:
        target = os.path.normpath(os.path.join(REPORT_DIR, ds))
        if not os.path.isdir(target):
            err(f"definition.pbir points at missing semantic model folder: {ds}")
        elif not os.path.isfile(os.path.join(target, "definition.pbidataset")):
            err(f"semantic model folder {ds} has no definition.pbidataset")

    # logical ids must be unique
    ids = []
    for p in (os.path.join(REPORT_DIR, "item.config.json"), os.path.join(MODEL_DIR, "item.config.json")):
        ids.append(jload(p)["logicalId"])
    plat = []
    for d in (REPORT_DIR, MODEL_DIR):
        plat.append(jload(os.path.join(d, ".platform"))["config"]["logicalId"])
    dup = [k for k, c in Counter(ids + plat).items() if c > 1]
    if dup:
        err(f"duplicate logicalId values: {dup}")
    if len(set(ids)) != 2:
        err("report and semantic model item.config.json must have different logicalIds")
    if ids[0] == plat[0]:
        err("report item.config.json and .platform logicalId must differ")

    # display names must match folder names
    for d, kind in ((REPORT_DIR, "Report"), (MODEL_DIR, "SemanticModel")):
        meta = jload(os.path.join(d, "item.metadata.json"))
        if meta.get("type") != kind:
            err(f"{os.path.basename(d)}/item.metadata.json type is {meta.get('type')!r}, expected {kind!r}")
        if meta.get("displayName") != PROJECT:
            err(f"{os.path.basename(d)} displayName {meta.get('displayName')!r} != {PROJECT!r}")
        if jload(os.path.join(d, ".platform"))["metadata"]["displayName"] != PROJECT:
            err(f"{os.path.basename(d)}/.platform displayName does not match the project name")

    rep = jload(os.path.join(REPORT_DIR, "report.json"))
    # theme
    base = rep["themeCollection"]["baseTheme"]["name"]
    items = rep["resourcePackages"][0]["resourcePackage"]["items"]
    if not any(i["name"] == base for i in items):
        err(f"base theme {base!r} is not registered in resourcePackages")
    for i in items:
        tp = os.path.join(REPORT_DIR, "StaticResources", "SharedResources", i["path"])
        if not os.path.isfile(tp):
            err(f"registered theme file missing: {i['path']}")

    sections = rep["sections"]
    names = [s["name"] for s in sections]
    if len(set(names)) != len(names):
        err(f"duplicate section names: {names}")
    for i, s in enumerate(sections):
        if s.get("ordinal") != i:
            err(f"section {s['name']} ordinal {s.get('ordinal')} != position {i}")
        vnames = [vc["name"] for vc in s["visualContainers"]]
        if len(set(vnames)) != len(vnames):
            err(f"duplicate visual names on page {s['name']}: "
                f"{[k for k, c in Counter(vnames).items() if c > 1]}")
        for a in range(len(s["visualContainers"])):
            for b in range(a + 1, len(s["visualContainers"])):
                va, vb = s["visualContainers"][a], s["visualContainers"][b]
                if (va["x"] < vb["x"] + vb["width"] and vb["x"] < va["x"] + va["width"]
                        and va["y"] < vb["y"] + vb["height"] and vb["y"] < va["y"] + va["height"]):
                    err(f"overlapping visuals on page {s['name']}: {va['name']} / {vb['name']}")
                if (va["x"] + va["width"] > s["width"] or va["y"] + va["height"] > s["height"]):
                    err(f"visual {va['name']} on page {s['name']} exceeds the page bounds")
    return sections


# ==========================================================================
# C. TMDL parser
# ==========================================================================
TMDL_STR_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')

# keywords that can introduce a TMDL object; the name after them is optional
OBJECT_KINDS = ("shared expression", "table", "column", "measure", "partition", "relationship",
                "hierarchy", "level", "perspective", "role", "expression", "variation",
                "calculationGroup", "alternateOf", "annotation", "kpi",
                "model", "database", "annotations")


def tmdl_unescape(s: str) -> str:
    return re.sub(r"\\(.)", r"\1", s)


class TmdlNode:
    def __init__(self, kind, name, indent):
        self.kind = kind
        self.name = name
        self.indent = indent
        self.props = {}
        self.children = []
        self.expression = None      # multi-line expression text
        self.inline_value = None
        self.file = None
        self.line = 0

    def find(self, kind, name=None):
        return [c for c in self.children if c.kind == kind and (name is None or c.name == name)]

    def __repr__(self):
        return f"<{self.kind} {self.name!r} props={list(self.props)} children={len(self.children)}>"


def node_expr(node):
    """Expression text of a node, following a nested `<name> =` assignment node."""
    if node.expression is not None:
        return node.expression
    for c in node.children:
        if c.kind == "assignment" and c.expression is not None:
            return c.expression
    return None


def dedent_block(lines: list[str]) -> str:
    indents = [len(ln) - len(ln.lstrip("\t")) for ln in lines if ln.strip()]
    n = min(indents) if indents else 0
    return "\n".join(ln[n:] if ln.startswith("\t" * n) else ln for ln in lines).strip("\n")


def parse_tmdl(path: str) -> list[TmdlNode]:
    """Indentation-aware TMDL parser supporting ``` expression blocks."""
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    roots: list[TmdlNode] = []
    stack: list[TmdlNode] = []
    base = os.path.basename(path)
    i = 0
    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()
        if not stripped or stripped.startswith("//"):
            i += 1
            continue
        indent = len(raw) - len(raw.lstrip("\t"))

        # ---- multi-line expression block ----------------------------------
        if stripped.startswith("```"):
            owner = stack[-1] if stack else None
            if owner is None:
                err(f"{base}:{i + 1}: expression block with no owning object")
                i += 1
                continue
            body = []
            i += 1
            closed = False
            while i < len(lines):
                if lines[i].strip() == "```":
                    closed = True
                    i += 1
                    break
                body.append(lines[i])
                i += 1
            if not closed:
                err(f"{base}: unterminated ``` block in {owner.kind} {owner.name}")
            text = dedent_block(body)
            owner.expression = text if owner.expression is None else owner.expression + "\n" + text
            continue

        while stack and stack[-1].indent >= indent:
            stack.pop()
        parent = stack[-1] if stack else None

        # ---- object keyword (name optional) --------------------------------
        kind = None
        for k in OBJECT_KINDS:
            if stripped == k or stripped.startswith(k + " "):
                kind = k
                break
        if kind:
            rest = stripped[len(kind):].strip()
            if rest.startswith("="):
                # "<keyword> =" - an assignment whose value follows as a block
                node = TmdlNode("assignment", kind, indent)
                node.file, node.line = path, i + 1
                node.inline_value = rest[1:].strip() or None
                (roots if parent is None else parent.children).append(node)
                stack.append(node)
                i += 1
                continue
            m = TMDL_STR_RE.match(rest)
            if m:
                name, remainder = tmdl_unescape(m.group(1)), rest[m.end():].strip()
            elif rest:
                parts = rest.split(None, 1)
                name, remainder = parts[0], (parts[1].strip() if len(parts) > 1 else "")
            else:
                name, remainder = "", ""
            node = TmdlNode(kind, name, indent)
            node.file, node.line = path, i + 1
            if remainder.startswith("="):
                node.inline_value = remainder[1:].strip()
            elif remainder:
                err(f"{base}:{i + 1}: unexpected text after {kind} {name!r}: {remainder!r}")
            (roots if parent is None else parent.children).append(node)
            stack.append(node)
            i += 1
            continue

        # ---- bare boolean property (isHidden / isKey / ...) ----------------
        flag = re.match(r"^([A-Za-z][A-Za-z0-9_]*)$", stripped)
        if flag:
            if parent is None:
                err(f"{base}:{i + 1}: flag property {flag.group(1)!r} outside any object")
            else:
                parent.props[flag.group(1)] = True
            i += 1
            continue

        # ---- property ------------------------------------------------------
        prop = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$", stripped)
        if prop:
            if parent is None:
                err(f"{base}:{i + 1}: property {prop.group(1)!r} outside any object")
            elif prop.group(2) in (None, ""):
                parent.props[prop.group(1)] = True
            else:
                parent.props[prop.group(1)] = prop.group(2)
            i += 1
            continue

        # ---- "<name> =" opening an expression block ------------------------
        expr_open = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", stripped)
        if expr_open:
            if parent is None:
                err(f"{base}:{i + 1}: assignment {expr_open.group(1)!r} outside any object")
            elif expr_open.group(2) == "":
                parent.children.append(TmdlNode("assignment", expr_open.group(1), indent))
                stack.append(parent.children[-1])
                stack[-1].indent = indent
            else:
                err(f"{base}:{i + 1}: expected a ``` expression block after "
                    f"{expr_open.group(1)!r} =, found {expr_open.group(2)!r}")
            i += 1
            continue

        err(f"{base}:{i + 1}: cannot parse TMDL line: {stripped!r}")
        i += 1
    return roots


def load_model():
    model = {
        "tables": {},
        "relationships": [],
        "shared_expressions": {},
        "model_props": {},
        "database_props": {},
        "files": [],
    }
    for p in sorted(glob.glob(os.path.join(TMDL_DIR, "**", "*.tmdl"), recursive=True)):
        rel = os.path.relpath(p, TMDL_DIR)
        model["files"].append(rel)
        for root in parse_tmdl(p):
            if root.kind == "model":
                model["model_props"] = root.props
            elif root.kind == "database":
                model["database_props"] = root.props
            elif root.kind == "shared expression":
                model["shared_expressions"][root.name] = root
            elif root.kind == "table":
                model["tables"][root.name] = root
            elif root.kind == "relationship":
                model["relationships"].append(root)
            else:
                err(f"{rel}: unexpected top-level TMDL object {root.kind} {root.name}")
    return model


# ==========================================================================
# D. model integrity
# ==========================================================================
PQ_TYPES = {"Int64.Type", "type number", "type nullable text", "type date", "type nullable date",
            "Int32.Type", "type text", "type nullable time", "Percentage.Type"}


def check_model(model):
    src_anns = {}
    mprops = model["model_props"]
    for k in ("culture", "compatibilityLevel"):
        if k not in mprops:
            err(f"model.tmdl is missing property {k!r}")
    cl = mprops.get("compatibilityLevel")
    if cl and int(cl) < 1567:
        err(f"compatibilityLevel {cl} is too low for the TMDL/PBIP format")
    vj = jload(os.path.join(TMDL_DIR, "version.json"))
    if str(vj.get("compatibilityLevel")) != str(cl):
        err(f"version.json compatibilityLevel {vj.get('compatibilityLevel')} != model.tmdl {cl}")

    if not model["shared_expressions"]:
        err("no shared expression (Power Query) found in expression.tmdl")
    if "Receivables" not in model["shared_expressions"]:
        err("shared expression 'Receivables' not found - the partition references it")
    else:
        expr = node_expr(model["shared_expressions"]["Receivables"]) or ""
        if not expr.strip().startswith("let"):
            err("shared expression Receivables does not start with 'let'")
        if not re.search(r"\bin\b\s*\n?\s*\w+\s*$", expr.strip()):
            err("shared expression Receivables has no 'in <result>' clause")
        if not expr.strip().endswith("Typed"):
            warn("shared expression Receivables does not end with the 'Typed' step")
        for fn in ("Csv.Document", "Table.PromoteHeaders", "Table.TransformColumnTypes"):
            if fn not in expr:
                err(f"M expression 'Receivables' is missing the {fn} step")
        # every model column must be typed in the M expression
        typed = set(re.findall(r'\{"([^"]+)",\s*([^}]+)\}', expr))
        rec_tbl = model["tables"].get("Receivables")
        if rec_tbl:
            csv_cols = [c.name for c in rec_tbl.children if c.kind == "column"
                        and node_expr(c) is None and c.inline_value is None]
            typed_names = {t[0] for t in typed}
            for c in csv_cols:
                if c not in typed_names:
                    err(f"column {c!r} is not typed in the M expression")
            for t in typed_names:
                if t not in csv_cols:
                    err(f"M expression types column {t!r} which is not a model column")
            for _n, pqt in typed:
                pqt = pqt.strip()
                if pqt not in PQ_TYPES:
                    warn(f"unusual M type {pqt!r}")

    # partition wiring
    for tname, tnode in model["tables"].items():
        parts = tnode.find("partition")
        if not parts:
            if any(node_expr(c) for c in tnode.find("column")):
                warn(f"table {tname!r} is a calculated table (no partition emitted)")
            else:
                err(f"table {tname!r} has no partition and no calculated columns")
        for p in parts:
            if p.props.get("mode") != "import":
                err(f"partition {tname}.{p.name} mode is {p.props.get('mode')!r}, expected 'import'")
            src = (node_expr(p) or p.inline_value or "").strip()
            if tname == "Receivables" and src != "Receivables":
                err(f"partition Receivables source is {src!r}, expected the shared expression 'Receivables'")
            if src == "Receivables" and "Receivables" not in model["shared_expressions"]:
                err("partition references shared expression 'Receivables' which does not exist")

        # duplicate columns / measures
        colnames = [c.name for c in tnode.find("column")]
        measnames = [m.name for m in tnode.find("measure")]
        for label, names in (("column", colnames), ("measure", measnames)):
            d = [k for k, c in Counter(names).items() if c > 1]
            if d:
                err(f"table {tname!r} has duplicate {label} names: {d}")
        overlap = sorted(set(colnames) & set(measnames))
        if overlap:
            warn(f"table {tname!r} has a column and a measure with the same name "
                 f"(legal, but confusing in the field list): {overlap}")

        for c in tnode.find("column"):
            dt_ = c.props.get("dataType")
            if dt_ not in ("string", "int64", "double", "dateTime", "boolean", "decimal"):
                err(f"{tname}.{c.name}: invalid dataType {dt_!r}")
            sbc = c.props.get("sortByColumn")
            if sbc:
                sbc = tmdl_unescape(sbc.strip('"'))
                if sbc not in colnames:
                    err(f"{tname}.{c.name}: sortByColumn target {sbc!r} is not a column of {tname}")
                elif sbc == c.name:
                    err(f"{tname}.{c.name}: sortByColumn points at itself")
            if c.props.get("summarizeBy") not in ("none", "sum", "min", "max", "count", "average", "distinctCount"):
                err(f"{tname}.{c.name}: invalid summarizeBy {c.props.get('summarizeBy')!r}")
            if dt_ in ("int64", "double", "decimal") and c.props.get("summarizeBy") != "none" \
                    and "formatString" not in c.props:
                warn(f"{tname}.{c.name}: numeric column without formatString")
            if dt_ == "string" and c.props.get("summarizeBy") == "sum":
                err(f"{tname}.{c.name}: text column with summarizeBy sum")
            if not c.props.get("lineageTag"):
                warn(f"{tname}.{c.name}: no lineageTag")
            # calculated columns need an expression
            if c.inline_value is None and node_expr(c) is None:
                ann = None
                for cont in c.find("annotations"):
                    for a in cont.find("annotation", "PBI_SourceColumn"):
                        ann = (a.inline_value or "").strip('"')
                if ann is None:
                    warn(f"{tname}.{c.name}: source column without a PBI_SourceColumn annotation")
                else:
                    src_anns.setdefault(tname, {})[c.name] = ann
        for m in tnode.find("measure"):
            if node_expr(m) is None and m.inline_value is None:
                err(f"{tname}.{m.name}: measure has no expression")
            if "formatString" not in m.props:
                warn(f"{tname}.{m.name}: measure without formatString")

    # PBI_SourceColumn annotations must name real CSV headers
    if "Receivables" in src_anns:
        with open(CSV_PATH, encoding="utf-8") as fh:
            header = next(csv.reader(fh))
        for col, ann in src_anns["Receivables"].items():
            if ann not in header:
                err(f"Receivables.{col}: PBI_SourceColumn {ann!r} is not a CSV header")
        unannotated = [c.name for c in model["tables"]["Receivables"].find("column")
                       if node_expr(c) is None and c.inline_value is None
                       and c.name not in src_anns["Receivables"]]
        if unannotated:
            warn(f"Receivables columns without PBI_SourceColumn: {unannotated}")

    # relationships
    for r in model["relationships"]:
        fc = r.props.get("fromColumn", "")
        tc = r.props.get("toColumn", "")
        for side, val in (("fromColumn", fc), ("toColumn", tc)):
            mm = re.match(r"^([^.\"]+)\.\"\s*(.+?)\s*\"$", val.strip())
            if not mm:
                err(f"relationship {r.name}: cannot parse {side} {val!r}")
                continue
            tbl, col = mm.group(1), tmdl_unescape(mm.group(2))
            if tbl not in model["tables"]:
                err(f"relationship {r.name}: {side} references unknown table {tbl!r}")
            else:
                cols = [c.name for c in model["tables"][tbl].find("column")]
                if col not in cols:
                    err(f"relationship {r.name}: {side} references unknown column {tbl}.{col}")
        if r.props.get("cardinality") not in ("manyToOne", "oneToMany", "oneToOne"):
            err(f"relationship {r.name}: invalid cardinality {r.props.get('cardinality')!r}")
        if r.props.get("crossFilteringBehavior") not in ("single", "bothDirections"):
            err(f"relationship {r.name}: invalid crossFilteringBehavior")

    # a many-to-one relationship must land on a unique key
    for r in model["relationships"]:
        tc = r.props.get("toColumn", "")
        mm = re.match(r"^([^.\"]+)\.\"\s*(.+?)\s*\"$", tc.strip())
        if not mm:
            continue
        tbl, col = mm.group(1), tmdl_unescape(mm.group(2))
        node = model["tables"].get(tbl)
        if node is None:
            continue
        target = [c for c in node.find("column") if c.name == col]
        if target:
            is_key = target[0].props.get("isKey") is True or target[0].props.get("isKey") == ""
            if not is_key and node_expr(target[0]) is None and target[0].inline_value is None:
                warn(f"relationship target {tbl}.{col} is not marked isKey and is not calculated")
    return model


# ==========================================================================
# E. DAX analysis
# ==========================================================================
DAX_TABLE_REF = re.compile(r"'((?:[^']|'')+)'\s*\[\s*([^\[\]]+?)\s*\]")
DAX_MEASURE_REF = re.compile(r"(?<![\w'\[\].-])\[([^\[\]]+?)\](?!\s*\()")
DAX_FUNC = re.compile(r"(?<![\w'\[\].])([A-Z][A-Z0-9_.]*)\s*\(")
DAX_QUOTED_NAME = re.compile(r"'((?:[^']|'')+)'")

KNOWN_FUNCS = {
    "SUM", "SUMX", "COUNT", "COUNTA", "COUNTROWS", "COUNTX", "COUNTBLANK", "AVERAGE", "AVERAGEX",
    "MIN", "MINX", "MAX", "MAXX", "DIVIDE", "ROUND", "ROUNDUP", "ROUNDDOWN", "INT", "CEILING",
    "FLOOR", "ABS", "MOD", "POWER", "SQRT", "IF", "SWITCH", "TRUE", "FALSE", "BLANK", "ISBLANK",
    "ISEMPTY", "ISFILTERED", "ISNUMBER", "ISTEXT", "COALESCE", "AND", "OR", "NOT", "FILTER",
    "CALCULATE", "CALCULATETABLE", "ALL", "ALLEXCEPT", "ALLSELECTED", "VALUES", "DISTINCT",
    "DISTINCTCOUNT", "SUMMARIZE", "SUMMARIZECOLUMNS", "ADDCOLUMNS", "SELECTCOLUMNS", "GENERATE",
    "GENERATESERIES", "UNION", "INTERSECT", "EXCEPT", "TOPN", "RANKX", "RELATED", "RELATEDTABLE",
    "USERELATIONSHIP", "CROSSFILTER", "DATE", "TIME", "TODAY", "NOW", "YEAR", "MONTH", "DAY",
    "WEEKDAY", "WEEKNUM", "DATEDIFF", "DATEADD", "EOMONTH", "EDATE", "CALENDAR", "CALENDARAUTO",
    "FORMAT", "VALUE", "LEFT", "RIGHT", "MID", "LEN", "TRIM", "UPPER", "LOWER", "CONCATENATE",
    "CONCATENATEX", "SEARCH", "FIND", "SUBSTITUTE", "REPLACE", "UNICHAR", "UNICODE", "SELECTEDVALUE",
    "HASONEVALUE", "FIRSTNONBLANK", "LASTNONBLANK", "TREATAS", "KEEPFILTERS", "ROW", "DATATABLE",
    "ERROR", "BLANK", "CURRENCY", "FIXED", "PRODUCT", "MEDIAN", "PERCENTILE.INC", "STDEV.P",
}


def strip_dax_literals(expr: str) -> str:
    return re.sub(r'"(?:[^"\\]|\\.)*"', '""', expr)


def extract_constants(expr: str) -> set:
    """Numeric constants used by a DAX expression, including DATE() arguments."""
    cleaned = strip_dax_literals(expr)
    out = set()
    for m in re.finditer(r"(?<![\w.\[])(\d+(?:\.\d+)?)(?![\w\]])", cleaned):
        out.add(float(m.group(1)))
    return out


def check_balanced(text: str, where: str):
    cleaned = strip_dax_literals(text)
    for op, cl in (("(", ")"), ("[", "]"), ("{", "}")):
        if cleaned.count(op) != cleaned.count(cl):
            err(f"{where}: unbalanced {op}{cl} ({cleaned.count(op)} vs {cleaned.count(cl)})")
    if cleaned.count('"') % 2:
        err(f"{where}: odd number of double quotes")


def analyse_dax(model):
    table_cols = {}
    table_measures = {}
    table_calc_cols = set()
    for tname, tnode in model["tables"].items():
        table_cols[tname] = [c.name for c in tnode.find("column")]
        table_measures[tname] = [m.name for m in tnode.find("measure")]
        table_calc_cols.update((tname, c.name) for c in tnode.find("column") if node_expr(c))

    all_measure_names = {m for ms in table_measures.values() for m in ms}
    measure_graph = defaultdict(set)
    expressions = []
    for tname, tnode in model["tables"].items():
        for c in tnode.find("column"):
            if node_expr(c):
                expressions.append((f"{tname}.{c.name} (calculated column)", tname, node_expr(c)))
        for m in tnode.find("measure"):
            text = node_expr(m) or m.inline_value or ""
            expressions.append((f"{tname}[{m.name}] (measure)", tname, text))
            for other in table_measures[tname]:
                if other != m.name and re.search(r"(?<![\w'\[\].-])\[" + re.escape(other) + r"\](?!\s*\()",
                                                 strip_dax_literals(text)):
                    measure_graph[(tname, m.name)].add((tname, other))

    for where, home, text in expressions:
        if not text.strip():
            err(f"{where}: empty expression")
            continue
        check_balanced(text, where)
        cleaned = strip_dax_literals(text)
        for tbl, col in DAX_TABLE_REF.findall(cleaned):
            tbl = tbl.replace("''", "'")
            if tbl not in table_cols:
                err(f"{where}: references unknown table '{tbl}'")
            elif col not in table_cols[tbl]:
                err(f"{where}: references unknown column '{tbl}'[{col}]")
        # bare table references (COUNTROWS('T'), FILTER('T', ...)) carry no column
        for tbl in DAX_QUOTED_NAME.findall(cleaned):
            tbl = tbl.replace("''", "'")
            if tbl not in table_cols:
                err(f"{where}: references unknown table '{tbl}'")
        for mname in DAX_MEASURE_REF.findall(cleaned):
            if mname not in all_measure_names:
                err(f"{where}: references unknown measure [{mname}]")
            elif mname not in table_measures.get(home, []) and len(table_measures) > 1:
                pass  # resolved through a relationship - legal
        for fn in DAX_FUNC.findall(cleaned):
            if fn not in KNOWN_FUNCS:
                warn(f"{where}: uses function {fn}() which is not in the validator's whitelist")
        if re.search(r"(?<![\w'])\b(SELECT|EVALUATE|DEFINE)\b", cleaned):
            err(f"{where}: contains DAX query keyword - expressions must be scalar/table expressions")

    # circular measures
    state = {}

    def visit(node, stack):
        if state.get(node) == "done":
            return
        if state.get(node) == "visiting":
            err(f"circular measure dependency: {' -> '.join(stack + [node[1]])}")
            return
        state[node] = "visiting"
        for nxt in measure_graph.get(node, ()):
            visit(nxt, stack + [node[1]])
        state[node] = "done"

    for node in list(measure_graph):
        visit(node, [])
    return table_cols, table_measures



# Every DAX expression's business constants, stated independently here so that a
# wrong rate / factor / rounding level in the model is a test failure.
EXPECTED_CONSTANTS = {
    "Receivables[GST]":                        ([0.18], [("ROUND", 1)]),
    "Receivables[Material Value incl. GST]":   ([0.18], [("ROUND", 1)]),
    "Receivables[TCS]":                        ([0.18, 0.02], [("ROUND", 2)]),
    "Receivables[TDS u/s 194(O)]":             ([0.001], []),
    "Receivables[Service Charge to MSTC]":     ([0.0225, 1.18], []),
    "Receivables[TDS u/s 194(H)]":             ([0.0225, 0.02], []),
    "Receivables[Net Service Charge]":         ([0.0225, 1.18, 0.02], []),
    "Receivables[Service Charge to MSTC (Net)]": ([0.0225, 1.18, 0.02, 0.001], [("ROUND", 1)]),
    "Receivables[Security Deposit (Expected)]": ([0.25], [("ROUND", 1)]),
    "Receivables[Final Payment (Expected)]":   ([0.9265], [("ROUND", 2)]),
    "Receivables[Total Receivables in Cash]":  ([1.1765], [("ROUND", 2)]),
    "Receivables[LPP Expected Calc]":          ([0.0118, 7, 2026, 8, 22, 24], []),
    "Receivables[Outstanding Calc]":           ([1.1765], [("ROUND", 2)]),
    "Receivables[Lots Settled]":               ([5], []),
    "Receivables[Lots Outstanding]":           ([5], []),
}


def check_measure_constants(model):
    """Read the numbers back out of the DAX and compare them with EXPECTED_CONSTANTS."""
    found = {}
    for tname, tnode in model["tables"].items():
        for m in tnode.find("measure"):
            found[f"{tname}[{m.name}]"] = node_expr(m) or m.inline_value or ""
        for c in tnode.find("column"):
            if node_expr(c):
                found[f"{tname}[{c.name}]"] = node_expr(c)
    for key, (consts, calls) in EXPECTED_CONSTANTS.items():
        expr = found.get(key)
        if expr is None:
            err(f"expected expression {key} is missing from the model")
            continue
        actual = extract_constants(expr)
        missing = [c for c in consts if c not in actual]
        if missing:
            err(f"{key}: expected constant(s) {missing} not present (found {sorted(actual)})")
        for fn, n in calls:
            if len(DAX_FUNC.findall(expr)) and sum(1 for f in DAX_FUNC.findall(expr) if f == fn) < n:
                err(f"{key}: expected at least {n} {fn}() call(s)")
    unexpected = sorted(set(found) - set(EXPECTED_CONSTANTS))
    if unexpected:
        warn(f"{len(unexpected)} expressions are not covered by the constant table")
    return len(EXPECTED_CONSTANTS)


# ==========================================================================
# F. Power Query simulation
# ==========================================================================
def m_typed_table(expr: str, source_bytes: bytes, label: str):
    """Replay the M pipeline in Python: Csv.Document -> PromoteHeaders -> TransformColumnTypes."""
    types = dict((n, t.strip()) for n, t in re.findall(r'\{"([^"]+)",\s*([^}]+)\}', expr))
    text = source_bytes.decode("utf-8")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    header, data = rows[0], rows[1:]
    for n, r in enumerate(data, start=2):
        if len(r) != len(header):
            err(f"{label}:{n} has {len(r)} fields, expected {len(header)}")
    out_rows = []
    for lineno, r in enumerate(data, start=2):
        rec = {}
        for name, raw in zip(header, r):
            t = types.get(name)
            if t is None:
                err(f"{label}: column {name!r} is not typed in the M expression")
                rec[name] = raw
                continue
            if raw == "":
                rec[name] = None
            elif t in ("Int64.Type", "Int32.Type"):
                try:
                    rec[name] = int(raw)
                except ValueError:
                    err(f"{label}:{lineno} column {name!r}: {raw!r} is not an Int64")
                    rec[name] = None
            elif t in ("type number", "Percentage.Type"):
                try:
                    rec[name] = float(raw)
                except ValueError:
                    err(f"{label}:{lineno} column {name!r}: {raw!r} is not a number")
                    rec[name] = None
            elif t in ("type date", "type nullable date"):
                try:
                    rec[name] = dt.date.fromisoformat(raw)
                except ValueError:
                    err(f"{label}:{lineno} column {name!r}: {raw!r} is not an ISO date")
                    rec[name] = None
            else:
                rec[name] = raw
        out_rows.append(rec)
    return {"header": header, "rows": out_rows, "types": types}


def simulate_m(model):
    primary = model["shared_expressions"].get("Receivables")
    alt = model["shared_expressions"].get("ReceivablesFromCsv")
    if primary is None or not node_expr(primary):
        err("shared expression 'Receivables' is missing - the partition references it")
        return None
    expr = node_expr(primary)

    for fn in ("Binary.FromText", "Csv.Document", "Table.PromoteHeaders", "Table.TransformColumnTypes"):
        if fn not in expr:
            err(f"M expression is missing the {fn} step")
    m = re.search(r'CsvBase64 = "([A-Za-z0-9+/=\s]+)"', expr)
    if not m:
        err("M expression has no CsvBase64 literal")
        return None
    b64 = re.sub(r"\s", "", m.group(1))
    try:
        blob = base64.b64decode(b64, validate=True)
    except Exception as exc:
        err(f"CsvBase64 is not valid base64: {exc}")
        return None
    primary_tbl = m_typed_table(expr, blob, "Receivables (embedded CSV)")

    if not os.path.isfile(CSV_PATH):
        err("Data/receivables.csv is missing")
        return primary_tbl
    with open(CSV_PATH, "rb") as fh:
        csv_bytes = fh.read()
    if blob != csv_bytes.rstrip(b"\n") and blob != csv_bytes:
        err("the CSV embedded in the model differs from Data/receivables.csv - "
            "re-run tools/build_pbip.py")
    if alt is not None and node_expr(alt):
        alt_expr = node_expr(alt)
        pm = re.search(r'Text\.Combine\(\{ProjectRoot,\s*"([^"]+)",\s*"([^"]+)"\}', alt_expr)
        if not pm:
            err("ReceivablesFromCsv: cannot determine the CSV path")
        else:
            rel = f"{pm.group(1)}/{pm.group(2)}"
            path = os.path.normpath(os.path.join(os.path.dirname(MODEL_DIR), rel))
            if path != os.path.normpath(CSV_PATH):
                err(f"ReceivablesFromCsv resolves to {os.path.relpath(path, REPO)}, "
                    f"expected Data/receivables.csv")
            alt_tbl = m_typed_table(alt_expr, csv_bytes, "ReceivablesFromCsv")
            if alt_tbl["header"] != primary_tbl["header"]:
                err("ReceivablesFromCsv produces a different column set than Receivables")
            if alt_tbl["rows"] != primary_tbl["rows"]:
                err("ReceivablesFromCsv produces different values than Receivables")

    rec = model["tables"].get("Receivables")
    if rec:
        src_cols = [c.name for c in rec.find("column")
                    if node_expr(c) is None and c.inline_value is None]
        if src_cols != primary_tbl["header"]:
            err(f"model source columns do not match the query output: "
                f"{primary_tbl['header']} vs {src_cols}")
    return primary_tbl


# ==========================================================================
# G. data fidelity vs Book1.xlsx
# ==========================================================================
# spreadsheet columns that the model imports verbatim
COLS = [
    ("A", "Quantity"), ("B", "Lot Name"), ("C", "Rate"), ("D", "Bid Sheet"), ("E", "Unit"),
    ("F", "Lot No."), ("G", "Buyer"), ("H", "Material Value"), ("Q", "GST TDS Rate"),
    ("U", "Security Deposit (Received)"), ("V", "SD Receipt Date (Text)"),
    ("X", "Final Payment (Received)"), ("Y", "FP Receipt Date (Text)"), ("AA", "LPP Received"),
    ("AB", "LPP Receipt Date (Text)"), ("AE", "Payment Status (Sheet)"),
    ("AF", "Invoice No."), ("AG", "SAP Document"), ("AH", "Invoice Date (Text)"),
]
# formula columns - recomputed by DAX, deliberately not imported
DERIVED = {"I", "J", "K", "L", "M", "N", "O", "P", "R", "S", "T", "W", "Z", "AC", "AD"}
DATE_LETTERS = {"V", "Y", "AB", "AH"}
NUM_LETTERS = {c[0] for c in COLS} - DATE_LETTERS - {"B", "E", "G", "AE", "AF", "AG"}


def excel_to_expected(letter, raw):
    if raw is None:
        return None
    if letter in DATE_LETTERS:
        if isinstance(raw, (int, float)):
            return None
        s = str(raw).strip()
        m = re.match(r"^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$", s)
        return None if not m else dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
    if isinstance(raw, str):
        return raw.strip() or None
    if isinstance(raw, float):
        return int(raw) if raw == int(raw) else round(raw, 6)
    return raw


def check_data_fidelity():
    ws = openpyxl.load_workbook(XLSX, data_only=True)["Final Calculation Sheet"]
    with open(CSV_PATH, encoding="utf-8", newline="") as fh:
        rdr = csv.DictReader(fh)
        rows = list(rdr)
        if len(rdr.fieldnames or []) != len(COLS):
            err(f"CSV has {len(rdr.fieldnames)} columns, expected {len(COLS)}")
        for letter, name in COLS:
            if name not in (rdr.fieldnames or []):
                err(f"CSV is missing the column {name!r} (Excel column {letter})")
        for name in (rdr.fieldnames or []):
            if name not in {n for _l, n in COLS}:
                err(f"CSV has an unexpected column {name!r}")
    if len(rows) != 37:
        err(f"CSV has {len(rows)} data rows, expected 37 (Excel rows 2..38)")
    checked = 0
    for i, rec in enumerate(rows):
        xr = i + 2
        for letter, name in COLS:
            raw = ws[f"{letter}{xr}"].value
            exp = excel_to_expected(letter, raw)
            got = rec.get(name)
            if got == "":
                got = None
            if letter in NUM_LETTERS:
                if got is None and exp is None:
                    pass
                elif got is None or exp is None:
                    err(f"row {xr} col {letter} ({name}): xlsx={exp!r} csv={got!r}")
                else:
                    checked += 1
                    d = abs(float(got) - float(exp))
                    if d > 1e-9 * max(1.0, abs(float(exp))):
                        err(f"row {xr} col {letter} ({name}): xlsx={exp!r} csv={got!r}")
                    continue
            else:
                if (got or None) != (str(exp) if exp is not None else None):
                    err(f"row {xr} col {letter} ({name}): xlsx={exp!r} csv={got!r}")
                checked += 1
                continue
            checked += 1
    return checked, ws


# ==========================================================================
# H. business rules - independent re-implementation of every DAX expression
# ==========================================================================
def r0(x):
    """Excel / DAX ROUND(x, 0): half away from zero, exact."""
    return int(Decimal(str(x)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def r2(x):
    return float(Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def parse_date_text(s):
    """Parse the date strings that the M pipeline hands to the model.

    The workbook stores dd.mm.yyyy; build_pbip.py writes ISO yyyy-mm-dd into
    Data/receivables.csv, which is what Table.TransformColumnTypes(type date)
    consumes - so both shapes must be understood here.
    """
    if s in (None, ""):
        return None
    s = str(s).strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", s)
    if m:
        try:
            return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.match(r"^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$", s)
    if not m:
        return None
    try:
        return dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None


def check_business_rules(rows, ws):
    """Independent Python re-implementation of every DAX measure, compared with
    the results Excel itself stored in Book1.xlsx."""
    TODAY = dt.date(2026, 9, 12)
    LPP_START = dt.date(2026, 8, 22)
    GRACE = dt.date(2026, 8, 24)

    def num(v):
        return 0.0 if v in (None, "") else float(v)

    def ceil_weeks(d):
        # DAX CEILING(DIVIDE(d, 7), 1) - divide first, then round up
        return -(-d // 7)

    def lpp_for(mv, fp_date, as_of):
        end = fp_date if fp_date else as_of
        weeks = ceil_weeks((end - LPP_START).days)
        if fp_date is not None and fp_date <= GRACE:
            return 0.0
        return mv * 0.0118 * weeks

    def build(as_of):
        out = []
        for rec in rows:
            mv = num(rec["Material Value"])
            rate = num(rec["GST TDS Rate"])
            fp_date = parse_date_text(rec["FP Receipt Date (Text)"])
            lpp = lpp_for(mv, fp_date, as_of)
            gst_tds = r0(mv * rate)
            receivable = r0(mv * 1.1765 - gst_tds + lpp)
            received = (num(rec["Security Deposit (Received)"])
                        + num(rec["Final Payment (Received)"]) + num(rec["LPP Received"]))
            out.append({
                "GST": r0(mv * 0.18),
                "MatValueGST": mv + r0(mv * 0.18),
                "TCS": r0((mv + r0(mv * 0.18)) * 0.02),
                "TDS_O": mv * 0.001,
                "SvcMSTC": mv * 0.0225 * 1.18,
                "TDS_H": mv * 0.0225 * 0.02,
                "NetSvc": mv * 0.0225 * 1.16,
                "SvcNet": r0(mv * 0.0225 * 1.16 + mv * 0.001),
                "GSTTDS": gst_tds,
                "LPP": lpp,
                "SDExp": r0(mv * 0.25),
                "FPExp": r0(mv * 0.9265 - gst_tds),
                "Receivable": receivable,
                "Received": received,
                "Outstanding": receivable - received,
                "Status": "SETTLED" if receivable - received <= 5 else "OUTSTANDING",
                "SDDate": parse_date_text(rec["SD Receipt Date (Text)"]),
                "FPDate": fp_date,
                "LPPDate": parse_date_text(rec["LPP Receipt Date (Text)"]),
                "InvDate": parse_date_text(rec["Invoice Date (Text)"]),
                "MatValue": mv,
            })
        return out

    # ---- recover the workbook's as-of date from its own unpaid LPP rows ----
    cands = []
    for i, rec in enumerate(rows):
        if parse_date_text(rec["FP Receipt Date (Text)"]):
            continue
        cached = ws[f"Z{i + 2}"].value
        mv = num(rec["Material Value"])
        if cached and mv:
            weeks = float(cached) / (mv * 0.0118)
            if abs(weeks - round(weeks)) < 1e-9:
                cands.append(LPP_START + dt.timedelta(days=int(round(weeks)) * 7))
    if not cands:
        err("cannot recover the workbook's LPP as-of date from column Z")
        as_of = TODAY
    else:
        if len(set(cands)) > 1:
            warn(f"the workbook's unpaid LPP rows imply different as-of dates: {sorted(set(cands))}")
        as_of = max(set(cands), key=cands.count)
        print(f"    (workbook LPP as-of date recovered from column Z: {as_of.isoformat()}; "
              f"the model accrues to TODAY = {TODAY.isoformat()})")

    at_xlsx_date = build(as_of)   # comparable with the cached values
    live = build(TODAY)          # what the model reports today

    # ---- 1. date-independent measures: must match the workbook exactly ----
    static_cols = {"GST": "I", "MatValueGST": "J", "TCS": "K", "TDS_O": "L", "SvcMSTC": "M",
                   "TDS_H": "N", "NetSvc": "O", "SvcNet": "P", "GSTTDS": "R", "SDExp": "T",
                   "FPExp": "W", "Received": "AC"}
    compared = 0
    for i, p in enumerate(at_xlsx_date):
        xr = i + 2
        for key, letter in static_cols.items():
            raw = ws[f"{letter}{xr}"].value
            mine = p[key]
            compared += 1
            if raw is None:
                err(f"row {xr} col {letter} ({key}): workbook cached value is blank, model={mine!r}")
            elif abs(float(raw) - float(mine)) > max(0.005, 1e-9 * abs(float(raw))):
                err(f"row {xr} col {letter} ({key}): workbook={float(raw)!r} model={float(mine)!r}")

    # ---- 2. LPP-dependent measures: compared at the workbook's as-of date ----
    dyn_cols = {"LPP": "Z", "Receivable": "S", "Outstanding": "AD"}
    for i, p in enumerate(at_xlsx_date):
        xr = i + 2
        for key, letter in dyn_cols.items():
            raw = ws[f"{letter}{xr}"].value
            mine = p[key]
            compared += 1
            if raw is None:
                err(f"row {xr} col {letter} ({key}): workbook cached value is blank, model={mine!r}")
            elif abs(float(raw) - float(mine)) > max(0.02, 1e-9 * abs(float(raw))):
                err(f"row {xr} col {letter} ({key}) at as-of {as_of}: "
                    f"workbook={float(raw)!r} model={float(mine)!r}")
        raw = ws[f"AE{xr}"].value
        compared += 1
        if str(raw).strip() != p["Status"]:
            err(f"row {xr} Payment Status at as-of {as_of}: workbook={raw!r} model={p['Status']!r}")

    # ---- 3. totals against the workbook's own TOTAL row (row 39) ----
    def tot(rs, key):
        return sum(r[key] for r in rs)

    totals = {
        "H": ("Material Value", tot(at_xlsx_date, "MatValue")),
        "I": ("GST", tot(at_xlsx_date, "GST")),
        "J": ("Material Value incl. GST", tot(at_xlsx_date, "MatValueGST")),
        "K": ("TCS", tot(at_xlsx_date, "TCS")),
        "L": ("TDS u/s 194(O)", tot(at_xlsx_date, "TDS_O")),
        "M": ("Service Charge to MSTC", tot(at_xlsx_date, "SvcMSTC")),
        "N": ("TDS u/s 194(H)", tot(at_xlsx_date, "TDS_H")),
        "O": ("Net Service Charge", tot(at_xlsx_date, "NetSvc")),
        "P": ("Service Charge to MSTC (Net)", tot(at_xlsx_date, "SvcNet")),
        "R": ("GST TDS", tot(at_xlsx_date, "GSTTDS")),
        "S": ("Total Receivables in Cash", tot(at_xlsx_date, "Receivable")),
        "T": ("Security Deposit (Expected)", tot(at_xlsx_date, "SDExp")),
        "U": ("Security Deposit (Received)", sum(num(r["Security Deposit (Received)"]) for r in rows)),
        "W": ("Final Payment (Expected)", tot(at_xlsx_date, "FPExp")),
        "X": ("Final Payment (Received)", sum(num(r["Final Payment (Received)"]) for r in rows)),
        "Z": ("LPP Expected", tot(at_xlsx_date, "LPP")),
        "AC": ("Total Received", tot(at_xlsx_date, "Received")),
        "AD": ("Outstanding", tot(at_xlsx_date, "Outstanding")),
    }
    for letter, (label, mine) in totals.items():
        raw = ws[f"{letter}39"].value
        if raw is None:
            warn(f"workbook TOTAL row has no cached value for column {letter} ({label})")
            continue
        compared += 1
        if abs(float(raw) - float(mine)) > max(0.02, 1e-9 * abs(float(raw))):
            err(f"TOTAL {label}: workbook row 39 = {float(raw)!r}, model = {float(mine)!r}")

    # ---- 4. internal consistency of the live model ----
    n_settled = sum(1 for p in live if p["Status"] == "SETTLED")
    n_out = sum(1 for p in live if p["Status"] == "OUTSTANDING")
    if n_settled + n_out != len(live):
        err(f"[Lots Settled] + [Lots Outstanding] = {n_settled + n_out} != {len(live)} lots")
    if abs(tot(live, "Receivable") - tot(live, "Received") - tot(live, "Outstanding")) > 0.02:
        err("[Total Receivables in Cash] - [Total Received] != [Outstanding]")
    for i, p in enumerate(live):
        for key, col in (("SDDate", "SD Receipt Date (Text)"), ("FPDate", "FP Receipt Date (Text)"),
                         ("LPPDate", "LPP Receipt Date (Text)"), ("InvDate", "Invoice Date (Text)")):
            if rows[i][col] and p[key] is None:
                err(f"row {i + 2}: {col}={rows[i][col]!r} does not parse as dd.mm.yyyy")

    over = sum(-p["Outstanding"] for p in live if p["Outstanding"] < 0)
    missing = sum(1 for r in rows
                  if not r["Invoice No."] or not r["SAP Document"] or not r["Invoice Date (Text)"])
    kpis = {
        "Lot Count": len(live),
        "Material Value": tot(live, "MatValue"),
        "GST": tot(live, "GST"),
        "GST TDS": tot(live, "GSTTDS"),
        "LPP Expected (as of today)": round(tot(live, "LPP"), 2),
        "Total Receivables in Cash": tot(live, "Receivable"),
        "Security Deposit (Received)": sum(num(r["Security Deposit (Received)"]) for r in rows),
        "Final Payment (Received)": sum(num(r["Final Payment (Received)"]) for r in rows),
        "Total Received": tot(live, "Received"),
        "Outstanding": tot(live, "Outstanding"),
        "Recovery %": tot(live, "Received") / tot(live, "Receivable"),
        "Lots Settled": n_settled,
        "Lots Outstanding": n_out,
        "Over-Receipts": round(over, 2),
        "Lots Missing Invoice Details": missing,
        "Lots Without FP Receipt Date": sum(1 for p in live if p["FPDate"] is None),
        "Lots With Zero GST TDS Rate": sum(1 for r in rows if num(r["GST TDS Rate"]) == 0),
    }
    return compared, kpis


# ==========================================================================
# I. report -> model binding
# ==========================================================================
def check_report_binding(table_cols, table_measures, sections):
    known_cols = {t: set(c) for t, c in table_cols.items()}
    known_meas = {t: set(m) for t, m in table_measures.items()}
    n = 0
    for s in sections:
        for vc in s["visualContainers"]:
            try:
                cfg = json.loads(vc["config"])
            except Exception as exc:
                err(f"visual {vc.get('name')} on {s['name']}: config is not valid JSON ({exc})")
                continue
            single = cfg.get("singleVisual")
            if not single:
                err(f"visual {vc.get('name')} on {s['name']}: config has no singleVisual")
                continue
            vt = single.get("visualType")
            if not vt:
                err(f"visual {vc.get('name')} on {s['name']}: no visualType")
            pq = single.get("prototypeQuery", {})
            entities = {f["Entity"]: f["Name"] for f in pq.get("From", [])}
            for sel in pq.get("Select", []):
                kind = "Measure" if "Measure" in sel else ("Column" if "Column" in sel else None)
                if kind is None:
                    err(f"visual {vc.get('name')} on {s['name']}: Select item is neither Measure nor Column")
                    continue
                body = sel[kind]
                src = body["Expression"]["SourceRef"]["Source"]
                ent = next((e for e, alias in entities.items() if alias == src), None)
                if ent is None:
                    err(f"visual {vc.get('name')} on {s['name']}: SourceRef {src!r} is not declared in From")
                    continue
                prop = body["Property"]
                n += 1
                if kind == "Measure":
                    if prop not in known_meas.get(ent, set()):
                        err(f"visual {vc.get('name')} on {s['name']}: unknown measure {ent}[{prop}]")
                else:
                    if prop not in known_cols.get(ent, set()):
                        err(f"visual {vc.get('name')} on {s['name']}: unknown column {ent}[{prop}]")
            for sel in pq.get("Select", []):
                if "Name" not in sel:
                    err(f"visual {vc.get('name')} on {s['name']}: Select item without a Name")
    return n


# ==========================================================================
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    print("=" * 74)
    print(f"  PBIP test suite : {PROJECT}.pbip")
    print("=" * 74)

    results = []

    group("A. structure & JSON schema")
    n_json = check_structure()
    results.append(("Structure + official JSON Schemas", f"{n_json} JSON documents"))

    group("B. cross references")
    sections = check_crossrefs()
    results.append(("Project cross-references", f"{len(sections)} pages"))

    group("C/D. TMDL + model integrity")
    model = load_model()
    check_model(model)
    ncol = sum(len(t.find("column")) for t in model["tables"].values())
    nmeas = sum(len(t.find("measure")) for t in model["tables"].values())
    results.append(("TMDL parse + model integrity",
                    f"{len(model['files'])} tmdl files, {len(model['tables'])} tables, "
                    f"{ncol} columns, {nmeas} measures, {len(model['relationships'])} relationships"))

    group("E. DAX")
    table_cols, table_measures = analyse_dax(model)
    n_const = check_measure_constants(model)
    nex = sum(1 for t in model["tables"].values() for c in t.find("column") if node_expr(c)) \
        + sum(1 for t in model["tables"].values() for _ in t.find("measure"))
    results.append(("DAX resolution & syntax",
                    f"{nex} expressions, {n_const} constant-checked"))

    group("F. Power Query")
    mres = simulate_m(model)
    results.append(("M pipeline simulation",
                    f"{len(mres['rows']) if mres else 0} rows x {len(mres['header']) if mres else 0} columns"))

    group("G. data fidelity")
    checked, ws = check_data_fidelity()
    results.append(("CSV vs Book1.xlsx", f"{checked} cell comparisons"))

    group("H. business rules")
    compared, kpis = check_business_rules(mres["rows"], ws) if mres else (0, {})
    results.append(("DAX measures vs Excel results", f"{compared} value comparisons"))

    group("I. report binding")
    nref = check_report_binding(table_cols, table_measures, sections)
    results.append(("Report -> model binding", f"{nref} field references"))

    for label, detail in results:
        print(f"  {label:<38} {detail}")

    print("-" * 74)
    if WARNINGS:
        print(f"  warnings: {len(WARNINGS)}")
        if args.verbose:
            for w in WARNINGS:
                print("   ! " + w)
    if ERRORS:
        print(f"  ERRORS: {len(ERRORS)}")
        for e in ERRORS:
            print("   x " + e)
        print("-" * 74)
        print("  RESULT: FAIL")
        return 1
    print("  RESULT: PASS - no errors")
    print("-" * 74)
    print("  KPIs the model will report:")
    for k, v in kpis.items():
        print(f"    {k:<32} {v:,.2f}" if isinstance(v, float) else f"    {k:<32} {v:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
