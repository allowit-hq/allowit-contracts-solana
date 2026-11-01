#!/usr/bin/env python3
"""Source-bound differential checks, not universal Rust/contract refinement."""

import argparse
import hashlib
import itertools
import json
import os
from pathlib import Path
import random
import re
import subprocess
import tempfile

DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parent
MAX_U64 = (1 << 64) - 1
MAX_LIMIT = 50_000_000
FIELDS = ("approved", "amount", "daily_limit", "spent", "spent_day", "now")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def expected(case):
    # A third implementation of the specification, not a proof of user intent.
    approved, amount, limit, spent, spent_day, now = case
    day = now // 86400
    total = (spent if day == spent_day else 0) + amount
    predicates = (
        (approved, "NotApproved"),
        (amount > 0, "ZeroAmount"),
        (limit <= MAX_LIMIT, "ParameterOutOfBounds"),
        (day >= spent_day, "ClockWentBackwards"),
        (total <= MAX_U64, "Overflow"),
        (total <= limit, "DailyLimitExceeded"),
    )
    for satisfied, error in predicates:
        if not satisfied:
            return "err " + error
    return "ok " + str(total)


def cases():
    amounts = (0, 1, 10, 25, MAX_LIMIT, MAX_U64)
    limits = (0, 1, 25, MAX_LIMIT, MAX_LIMIT + 1, MAX_U64)
    spending = (0, 15, 25, MAX_LIMIT, MAX_U64)
    days = ((0, 0), (86399, 0), (86400, 0), (86400, 1),
            (86399, 1), (172800, 0), (172799, 1))
    values = {(True, amount, limit, spent, spent_day, now)
              for amount, limit, spent, (now, spent_day)
              in itertools.product(amounts, limits, spending, days)}
    # Simultaneous failures exercise error priority; random inputs are reproducible.
    values.update((False,) + case[1:] for case in list(values))
    rng = random.Random(20261004)
    for _ in range(384):
        now = rng.getrandbits(64)
        day = now // 86400
        limit = rng.choice((0, 1, MAX_LIMIT, MAX_LIMIT + 1, rng.randrange(MAX_LIMIT + 1)))
        near = (0, 1, max(0, limit - 1), limit, limit + 1, MAX_U64)
        values.add((bool(rng.getrandbits(1)), rng.choice(near), limit,
                    rng.choice(near), rng.choice((max(0, day - 1), day, day + 1)), now))
    values.update({(True, 1, MAX_LIMIT, 0, MAX_U64, MAX_U64),
                   (True, 1, MAX_LIMIT, 0, MAX_U64 // 86400, MAX_U64),
                   (True, 1, MAX_LIMIT, MAX_U64, MAX_U64 // 86400, MAX_U64)})
    return sorted(values)


def run(command, directory, data=None, environment=None):
    result = subprocess.run(command, cwd=directory, input=data, text=True,
                            capture_output=True, timeout=180, env=environment)
    if result.returncode:
        raise ValueError("Runner failed: " + (result.stderr + result.stdout)[-3000:])
    return result.stdout


def read_sources(lock):
    if set(lock) != {"version", "policy_sha256", "api_sha256", "targets", "binding"} or type(lock["version"]) is not int or lock["version"] != 1:
        raise ValueError("Unsupported source-lock schema")
    if set(lock["targets"]) != {"solana", "stellar"}:
        raise ValueError("Both native source targets are required")
    for name in ("policy_sha256", "api_sha256"):
        if not isinstance(lock[name], str) or not re.fullmatch(r"[0-9a-f]{64}", lock[name]):
            raise ValueError("Invalid source digest")
    result = {}
    for target, relative in lock["targets"].items():
        directory = ROOT / relative
        policy = (directory / "policy.rs").read_bytes()
        api = (directory / "policy_api.rs").read_bytes()
        if digest(policy) != lock["policy_sha256"] or digest(api) != lock["api_sha256"]:
            raise ValueError("Stale source binding for " + target + "; inspect changes before updating proofs/lock")
        embedded_policy_hash((directory / "source_hash.rs").read_text(), lock["policy_sha256"])
        result[target] = (policy, api)
    return result


def embedded_policy_hash(source, expected_digest):
    match = re.fullmatch(r"\s*pub const SOURCE_HASH: \[u8; 32\] = \[([0-9,\s]+)\];\s*", source)
    if not match:
        raise ValueError("Unsupported embedded source-hash declaration")
    values = [int(value.strip()) for value in match[1].split(",") if value.strip()]
    if len(values) != 32 or any(value > 255 for value in values) or bytes(values).hex() != expected_digest:
        raise ValueError("Embedded source hash does not match reviewed policy")


def rust_output(directory, policy, api, inputs, rustc):
    directory.mkdir()
    (directory / "policy.rs").write_bytes(policy)
    (directory / "policy_api.rs").write_bytes(api)
    wrapper = r'''mod policy_api;
mod policy;
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let p: Vec<&str> = line.split_whitespace().collect();
        assert_eq!(p.len(), 6);
        let ctx = policy_api::Context {
            approved: p[0].parse().unwrap(), amount: p[1].parse().unwrap(),
            daily_limit: p[2].parse().unwrap(), spent: p[3].parse().unwrap(),
            spent_day: p[4].parse().unwrap(), now: p[5].parse().unwrap()
        };
        match policy::evaluate(&ctx) {
            Ok(n) => println!("ok {n}"), Err(e) => println!("err {e:?}")
        }
    }
}'''
    (directory / "main.rs").write_text(wrapper)
    run([rustc, "--edition=2024", "main.rs", "-o", "runner"], directory)
    return run([str(directory / "runner")], directory, inputs).splitlines()


def lean_output(directory, inputs, lean):
    source = DIRECTORY / "lean" / "NativeDaily.lean"
    (directory / "NativeDaily.lean").write_bytes(source.read_bytes())
    run([lean, "-o", "NativeDaily.olean", "NativeDaily.lean"], directory)
    (directory / "ReplayNative.lean").write_bytes((DIRECTORY / "lean" / "ReplayNative.lean").read_bytes())
    environment = dict(os.environ)
    environment["LEAN_PATH"] = str(directory)
    return run([lean, "--run", "ReplayNative.lean"], directory, inputs,
               environment=environment).splitlines()


def mismatch(values, reference, observed):
    if len(observed) != len(reference):
        raise ValueError("Runner returned an incomplete result corpus")
    for index, (want, got) in enumerate(zip(reference, observed)):
        if want != got:
            return {"input": dict(zip(FIELDS, values[index])), "expected": want, "observed": got}
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lean", default=os.environ.get("LEAN_BIN", "lean"))
    parser.add_argument("--rustc", default="rustc")
    arguments = parser.parse_args()
    lean = str(Path(arguments.lean).resolve()) if "/" in arguments.lean else arguments.lean
    version = run([lean, "--version"], ROOT).strip()
    toolchain = (DIRECTORY / "lean" / "lean-toolchain").read_text().strip()
    pinned_version = toolchain.split(":v", 1)[1]
    if f"version {pinned_version}," not in version:
        raise ValueError("Use the pinned " + toolchain + " checker")
    model_source = (DIRECTORY / "lean" / "NativeDaily.lean").read_bytes()
    model_digest = digest(model_source)
    audit_paths = [Path(__file__).resolve(), DIRECTORY / "lean" / "ReplayNative.lean",
                   DIRECTORY / "lean" / "check.py", DIRECTORY / "lean" / "AllowIt.lean",
                   DIRECTORY / "lean" / "lean-toolchain",
                   DIRECTORY / "native-source-lock.json"]
    audit_digests = {str(p.relative_to(DIRECTORY)): digest(p.read_bytes()) for p in audit_paths}
    # First check theorem validity/dependencies; differential execution is separate.
    environment = dict(os.environ)
    environment["LEAN_BIN"] = lean
    proof_log = run([os.environ.get("PYTHON", "python3"), str(DIRECTORY / "lean" / "check.py")], ROOT,
                    environment=environment)
    lock = json.loads((DIRECTORY / "native-source-lock.json").read_text())
    sources = read_sources(lock)
    values = cases()
    reference = [expected(case) for case in values]
    outcomes = {line.split()[1] if line.startswith("err ") else "ok" for line in reference}
    if outcomes != {"ok", "NotApproved", "ZeroAmount", "ParameterOutOfBounds",
                    "ClockWentBackwards", "Overflow", "DailyLimitExceeded"}:
        raise ValueError("Corpus does not cover every kernel result")
    inputs = "\n".join(" ".join(str(v).lower() for v in case) for case in values) + "\n"
    if digest((DIRECTORY / "lean" / "NativeDaily.lean").read_bytes()) != model_digest:
        raise ValueError("Lean specification changed during theorem checking")
    with tempfile.TemporaryDirectory(prefix="allowit-native-verification-") as temporary:
        workspace = Path(temporary)
        model = lean_output(workspace, inputs, lean)
        difference = mismatch(values, reference, model)
        if difference:
            raise ValueError("Lean/spec disagreement: " + json.dumps(difference))
        for target, (policy, api) in sources.items():
            observed = rust_output(workspace / target, policy, api, inputs, arguments.rustc)
            difference = mismatch(values, reference, observed)
            if difference:
                raise ValueError(target + " disagreement: " + json.dumps(difference))
        policy, api = sources["solana"]
        mutations = {
            "removed_daily_limit": ("if next > ctx.daily_limit", "if false"),
            "same_day_counter_reset": ("let spent = if day == ctx.spent_day { ctx.spent } else { 0 };", "let spent = 0_u64;"),
            "rejected_exact_limit": ("if next > ctx.daily_limit", "if next >= ctx.daily_limit"),
            "denied_every_success": ("Ok(next)", "Err(PolicyError::DailyLimitExceeded)"),
            "swapped_error_priority": (
                "if !ctx.approved { return Err(PolicyError::NotApproved); }\n    if ctx.amount == 0 { return Err(PolicyError::ZeroAmount); }",
                "if ctx.amount == 0 { return Err(PolicyError::ZeroAmount); }\n    if !ctx.approved { return Err(PolicyError::NotApproved); }"),
            "rejected_same_day": ("if day < ctx.spent_day", "if day <= ctx.spent_day"),
            "changed_maximum": ("MAX_DAILY_LIMIT: u64 = 50_000_000", "MAX_DAILY_LIMIT: u64 = 50_000_001"),
            "changed_day_seconds": ("DAY_SECONDS: u64 = 86_400", "DAY_SECONDS: u64 = 86_401"),
            "inverted_day_reset": ("if day == ctx.spent_day", "if day != ctx.spent_day"),
        }
        detected = []
        for name, (old, new) in mutations.items():
            text = policy.decode()
            if text.count(old) != 1:
                raise ValueError("Mutation is stale: " + name)
            observed = rust_output(workspace / name, text.replace(old, new).encode(), api,
                                   inputs, arguments.rustc)
            if not mismatch(values, reference, observed):
                raise ValueError("Corpus missed mutation: " + name)
            detected.append(name)
    if read_sources(lock) != sources:
        raise ValueError("Sources changed during verification")
    if digest((DIRECTORY / "lean" / "NativeDaily.lean").read_bytes()) != model_digest:
        raise ValueError("Lean specification changed during verification")
    if any(digest(p.read_bytes()) != audit_digests[str(p.relative_to(DIRECTORY))] for p in audit_paths):
        raise ValueError("Verification dependencies changed during the run")
    print(json.dumps({"evidence": "tested_correspondence", "runner": "host rustc and Lean executable model", "cases": len(values),
                      "targets": list(sources), "policySha256": lock["policy_sha256"],
                      "apiSha256": lock["api_sha256"], "modelSha256": model_digest,
                      "corpusSha256": digest(inputs.encode()), "lean": version,
                      "verificationDependencies": audit_digests,
                      "proofCheckLogSha256": digest(proof_log.encode()),
                      "rustc": run([arguments.rustc, "--version"], ROOT).strip(),
                      "outcomes": sorted(outcomes), "mutationsDetected": detected,
                      "embeddedSourceHashChecked": True,
                      "replayTrustedComponents": ["Lean compiler/runtime", "host Rust compiler/runtime", "Python reference and harness"],
                      "productionRefinement": False, "adapterExecution": False,
                      "deploymentChecked": False}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"evidence": "not_accepted", "error": str(error)}))
        raise SystemExit(1)
