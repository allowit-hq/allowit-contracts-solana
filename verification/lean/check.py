#!/usr/bin/env python3
"""Check the pinned Lean model and audit every theorem's axiom dependencies."""

from pathlib import Path
import os
import re
import subprocess
import sys


def check_module(checker: str, path: Path, namespace: str, version: str) -> int:
    source = path.read_text()
    if re.search(r"\b(?:sorry|admit|axiom|native_decide|implemented_by|extern|unsafe)\b|debug\.skipKernelTC", source):
        print(f"Unproved declarations, native proof evaluation or execution overrides in {path.name}.", file=sys.stderr)
        return 1
    result = subprocess.run([checker, str(path)], capture_output=True, text=True)
    print(result.stdout, end="")
    print(result.stderr, end="", file=sys.stderr)
    if result.returncode:
        return result.returncode
    expected = set(re.findall(r"^theorem\s+(\w+)", source, re.MULTILINE))
    if not expected:
        print(f"No theorems found in {path.name}.", file=sys.stderr)
        return 1
    audited: set[str] = set()
    standard_axioms = {"propext", "Quot.sound"}
    for line in result.stdout.splitlines():
        match = re.fullmatch(
            rf"'{re.escape(namespace)}\.(\w+)' (?:does not depend on any axioms|depends on axioms: \[(.*)\])",
            line,
        )
        if not match:
            continue
        name, dependencies = match.groups()
        axioms = set(filter(None, (dependencies or "").split(", ")))
        if not axioms <= standard_axioms:
            print(f"Unapproved axiom dependency for {name}: {sorted(axioms)}", file=sys.stderr)
            return 1
        audited.add(name)
    if audited != expected:
        print(f"Incomplete theorem audit in {path.name}: expected {sorted(expected)}, saw {sorted(audited)}", file=sys.stderr)
        return 1
    print(f"Verified {len(audited)} theorems in {path.name} with Lean {version}; only standard logical axioms.")
    return 0


def main() -> int:
    directory = Path(__file__).resolve().parent
    toolchain = (directory / "lean-toolchain").read_text().strip()
    version = toolchain.split(":v", 1)[1]
    checker = os.environ.get("LEAN_BIN", "lean")
    try:
        result = subprocess.run(
            [checker, "--version"], capture_output=True, text=True, check=True
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        print(f"Lean checker unavailable: {error}", file=sys.stderr)
        return 1
    if f"version {version}," not in result.stdout:
        print(f"Expected {toolchain}; got {result.stdout.strip()}", file=sys.stderr)
        return 1
    for filename, namespace in (("AllowIt.lean", "AllowIt"), ("NativeDaily.lean", "AllowIt.NativeDaily")):
        code = check_module(checker, directory / filename, namespace, version)
        if code:
            return code
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
