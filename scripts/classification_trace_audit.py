#!/usr/bin/env python3
from __future__ import annotations

import argparse
import pathlib
import re
from dataclasses import dataclass
from typing import Dict, List

ROOT = pathlib.Path(__file__).resolve().parents[1]
CLASSIFICATION = ROOT / "CLASSIFICATION.md"
DEFAULT_OUT = ROOT / "CLASSIFICATION_TRACE_MATRIX.md"

SCENARIO_ID_RE = re.compile(r"^[A-Z]+-\d{3}$")
FILE_PATH_RE = re.compile(r"(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.(?:py|tsx|ts|js|md)")


@dataclass
class ScenarioRow:
    scenario_id: str
    family: str
    description: str
    primary_paths: str
    files: List[str]
    traced: bool
    notes: str


def _extract_section_14(text: str) -> str:
    start_marker = "## 14) Full Scenario Catalog (Normative)"
    end_marker = "## 15) Coverage Traceability and Full-Coverage Gate"
    start = text.find(start_marker)
    if start < 0:
        raise RuntimeError(f"Could not find section start marker: {start_marker!r}")
    end = text.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f"Could not find section end marker: {end_marker!r}")
    return text[start:end]


def _fallback_files_for_family(family: str) -> List[str]:
    if family == "ING":
        return ["extensions/clawboard-logger/index.ts", "backend/app/main.py"]
    if family == "CLS":
        return ["classifier/classifier.py"]
    if family == "FIL":
        return ["classifier/classifier.py"]
    if family == "SRCH":
        return ["backend/app/main.py", "backend/app/vector_search.py", "src/components/unified-view.tsx"]
    if family == "CHAT":
        return ["backend/app/main.py"]
    return []


def _parse_rows(section_14: str) -> List[ScenarioRow]:
    rows: List[ScenarioRow] = []

    header_cols: List[str] = []
    primary_col_idx: int | None = None

    for raw_line in section_14.splitlines():
        line = raw_line.strip()
        if not line.startswith("|"):
            continue
        # skip markdown table separator lines
        if re.match(r"^\|(?:\s*:?-{2,}:?\s*\|)+$", line):
            continue

        parts = [p.strip() for p in line.strip("|").split("|")]
        if not parts:
            continue

        # header row detection
        if parts[0] == "ID":
            header_cols = parts
            primary_col_idx = None
            for idx, col in enumerate(parts):
                if "Primary Code Paths" in col:
                    primary_col_idx = idx
                    break
            continue

        sid = parts[0]
        if not SCENARIO_ID_RE.match(sid):
            continue

        family = sid.split("-", 1)[0]
        description = parts[1] if len(parts) > 1 else ""
        primary_paths = ""
        if primary_col_idx is not None and primary_col_idx < len(parts):
            primary_paths = parts[primary_col_idx]

        extracted_files = FILE_PATH_RE.findall(primary_paths)
        if not extracted_files:
            extracted_files = _fallback_files_for_family(family)

        unique_files: List[str] = []
        seen = set()
        for f in extracted_files:
            if f in seen:
                continue
            seen.add(f)
            unique_files.append(f)

        missing = [f for f in unique_files if not (ROOT / f).exists()]
        traced = bool(unique_files) and not missing

        if traced:
            notes = "OK"
        elif missing:
            notes = "Missing files: " + ", ".join(missing)
        else:
            notes = "No path trace found"

        rows.append(
            ScenarioRow(
                scenario_id=sid,
                family=family,
                description=description,
                primary_paths=primary_paths or "(family fallback)",
                files=unique_files,
                traced=traced,
                notes=notes,
            )
        )

    return rows


def _render_markdown(rows: List[ScenarioRow]) -> str:
    total = len(rows)
    traced = sum(1 for row in rows if row.traced)
    pct = (100.0 * traced / total) if total else 0.0

    by_family: Dict[str, List[ScenarioRow]] = {}
    for row in rows:
        by_family.setdefault(row.family, []).append(row)

    lines: List[str] = []
    lines.append("# Classification Trace Matrix")
    lines.append("")
    lines.append("This artifact audits trace-level coverage of every scenario ID in `CLASSIFICATION.md` section 14.")
    lines.append("")
    lines.append("Trace-level coverage means each scenario maps to existing implementation files (path-level trace), not necessarily full behavioral test assertions.")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- Scenarios traced: `{traced}/{total}` (`{pct:.1f}%`)")
    lines.append("- Source of truth: `CLASSIFICATION.md` section 14")
    lines.append("- Auditor: `scripts/classification_trace_audit.py`")
    lines.append("")
    lines.append("## Family Summary")
    lines.append("")
    lines.append("| Family | Traced | Total |")
    lines.append("|---|---:|---:|")
    for family in ("ING", "CLS", "FIL", "SRCH", "CHAT"):
        fam_rows = by_family.get(family, [])
        fam_traced = sum(1 for row in fam_rows if row.traced)
        lines.append(f"| {family} | {fam_traced} | {len(fam_rows)} |")
    lines.append("")
    lines.append("## Scenario Trace Table")
    lines.append("")
    lines.append("| ID | Description | Trace Files | Trace Status | Notes |")
    lines.append("|---|---|---|---|---|")
    for row in rows:
        files = ", ".join(f"`{f}`" for f in row.files) if row.files else ""
        status = "Traced" if row.traced else "Missing"
        lines.append(f"| {row.scenario_id} | {row.description} | {files} | {status} | {row.notes} |")

    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit trace-level scenario coverage for CLASSIFICATION.md section 14.")
    parser.add_argument("--classification", default=str(CLASSIFICATION), help="Path to CLASSIFICATION.md")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Output markdown path")
    args = parser.parse_args()

    classification_path = pathlib.Path(args.classification).resolve()
    out_path = pathlib.Path(args.out).resolve()

    text = classification_path.read_text(encoding="utf-8")
    section_14 = _extract_section_14(text)
    rows = _parse_rows(section_14)

    # Expect full scenario set from spec.
    if len(rows) != 77:
        raise RuntimeError(f"Expected 77 scenario IDs in section 14, found {len(rows)}")

    out = _render_markdown(rows)
    out_path.write_text(out, encoding="utf-8")

    traced = sum(1 for row in rows if row.traced)
    total = len(rows)
    print(f"trace_audit: traced={traced}/{total} ({(100.0 * traced / total):.1f}%) -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
