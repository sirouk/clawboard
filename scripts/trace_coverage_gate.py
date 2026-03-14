#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


SUMMARY_RE = re.compile(r"^\s*\d+\s+(\d+)%\s+\S+\s+\(([^)]+)\)\s*$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a Python test command under trace and enforce file coverage.")
    parser.add_argument("--coverdir", required=True, help="Directory for trace coverage artifacts.")
    parser.add_argument(
        "--target",
        action="append",
        required=True,
        help="Coverage target in the form relative/or/absolute/path.py=90",
    )
    parser.add_argument(
        "--ignore-dir",
        action="append",
        default=[],
        help="Directory list to ignore, joined with os.pathsep when repeated.",
    )
    parser.add_argument("--runner-module", required=True, help="Module to execute via trace, e.g. unittest.")
    parser.add_argument("runner_args", nargs=argparse.REMAINDER, help="Arguments passed to the runner module.")
    return parser.parse_args()


def parse_targets(raw_targets: list[str]) -> list[tuple[Path, float]]:
    targets: list[tuple[Path, float]] = []
    for raw in raw_targets:
        if "=" not in raw:
            raise SystemExit(f"invalid --target {raw!r}: expected path.py=MIN")
        path_text, threshold_text = raw.rsplit("=", 1)
        target_path = Path(path_text).expanduser().resolve()
        try:
            minimum = float(threshold_text)
        except ValueError as exc:
            raise SystemExit(f"invalid coverage threshold in {raw!r}") from exc
        targets.append((target_path, minimum))
    return targets


def run_trace(coverdir: Path, ignore_dirs: list[str], runner_module: str, runner_args: list[str]) -> tuple[int, str, str]:
    coverdir.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        "-m",
        "trace",
        "--count",
        "--summary",
        "-C",
        str(coverdir),
    ]
    if ignore_dirs:
        command.extend(["--ignore-dir", os.pathsep.join(ignore_dirs)])
    command.extend(["--module", runner_module])
    command.extend(runner_args)
    completed = subprocess.run(command, capture_output=True, text=True)
    return completed.returncode, completed.stdout, completed.stderr


def parse_summary(output: str) -> dict[Path, float]:
    coverage_by_path: dict[Path, float] = {}
    for line in output.splitlines():
        match = SUMMARY_RE.match(line)
        if not match:
            continue
        coverage_pct = float(match.group(1))
        file_path = Path(match.group(2)).expanduser().resolve()
        coverage_by_path[file_path] = coverage_pct
    return coverage_by_path


def main() -> int:
    args = parse_args()
    runner_args = list(args.runner_args)
    if runner_args and runner_args[0] == "--":
        runner_args = runner_args[1:]

    targets = parse_targets(args.target)
    returncode, stdout, stderr = run_trace(Path(args.coverdir).resolve(), args.ignore_dir, args.runner_module, runner_args)

    if stdout:
        sys.stdout.write(stdout)
    if stderr:
        sys.stderr.write(stderr)
    if returncode != 0:
        return returncode

    coverage_by_path = parse_summary(f"{stdout}\n{stderr}")
    failures: list[str] = []
    for target_path, minimum in targets:
        actual = coverage_by_path.get(target_path)
        if actual is None:
            failures.append(f"missing coverage result for {target_path}")
            continue
        if actual < minimum:
            failures.append(f"{target_path}: {actual:.1f}% < {minimum:.1f}%")
        else:
            print(f"coverage ok: {target_path} {actual:.1f}% >= {minimum:.1f}%")

    if failures:
        for failure in failures:
            print(f"coverage gate failed: {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
