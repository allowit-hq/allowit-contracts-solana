#!/usr/bin/env python3
"""Read-only intake and finite kernel replay for pinned published contracts."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

import check_native as native

DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parent
ARTIFACTS = {"solana": {"allowit_policy.so", "allowit_vault.so"},
             "stellar": {"allowit_policy.wasm", "allowit_vault.wasm", "allowit_factory.wasm"}}
METADATA = {"README.md", "artifacts/manifest.json", "evidence/opus-review.json", "evidence/stellar-testnet.json"}


def source_bundle(policy, api):
    data = b"allowit-policy-source-v1\0"
    for name, content in ((b"policy.rs", policy), (b"policy_api.rs", api)):
        data += name + b"\0" + len(content).to_bytes(8, "little") + content
    return native.digest(data)


def identity(policy, api, embedded, lock):
    if native.digest(policy) != lock["policy_sha256"] or native.digest(api) != lock["api_sha256"]:
        raise ValueError("Stale published source binding")
    bundle = source_bundle(policy, api)
    if bundle != lock["source_bundle"]:
        raise ValueError("Published source bundle mismatch")
    native.embedded_policy_hash(embedded, bundle)
    return bundle


def git(repository, *arguments):
    return native.run(["git", *arguments], repository).rstrip("\n")


def committed(repository, revision, path):
    return subprocess.run(["git", "show", revision + ":" + path], cwd=repository,
                          check=True, capture_output=True, timeout=30).stdout


def check_manifest_transition(repository, code_revision, revision):
    if not isinstance(code_revision, str) or not re.fullmatch(r"[0-9a-f]{40}", code_revision):
        raise ValueError("Invalid manifest revision")
    git(repository, "merge-base", "--is-ancestor", code_revision, revision)
    # Show both sides of renames, and preserve path delimiters independently of
    # quoting config or embedded whitespace in a filename.
    changes = set(filter(None, git(repository, "diff", "--no-renames", "--name-only", "-z", code_revision, revision).split("\0")))
    if not changes <= METADATA:
        raise ValueError("Build inputs changed after manifest revision")


def intake(lock):
    if set(lock) != {"version", "policy_sha256", "api_sha256", "source_bundle", "targets", "rustc_version"} or type(lock.get("version")) is not int or lock["version"] != 1 or set(lock["targets"]) != set(ARTIFACTS):
        raise ValueError("Unsupported published lock")
    for field in ("policy_sha256", "api_sha256", "source_bundle"):
        if not isinstance(lock[field], str) or not re.fullmatch(r"[0-9a-f]{64}", lock[field]):
            raise ValueError("Invalid published digest")
    result = {}
    for chain, target in lock["targets"].items():
        if set(target) != {"repository", "revision", "manifest_sha256", "artifact_directory"}:
            raise ValueError("Unsupported published target")
        if not re.fullmatch(r"[0-9a-f]{64}", target["manifest_sha256"]):
            raise ValueError("Invalid manifest digest")
        repository = ROOT / target["repository"]
        revision = target["revision"]
        if not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise ValueError("Invalid pinned revision")
        if git(repository, "rev-parse", "HEAD") != revision or git(repository, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"):
            raise ValueError("Published checkout changed or dirty: " + chain)
        policy = committed(repository, revision, "policy/policy.rs")
        api = committed(repository, revision, "policy/policy_api.rs")
        embedded = committed(repository, revision, "policy/source_hash.rs").decode()
        identity(policy, api, embedded, lock)
        manifest_bytes = committed(repository, revision, "artifacts/manifest.json")
        if native.digest(manifest_bytes) != target["manifest_sha256"]:
            raise ValueError("Artifact manifest binding changed")
        manifest = json.loads(manifest_bytes)
        if type(manifest["schema"]) is not int or manifest["schema"] != 1 or manifest["source_bundle"] != lock["source_bundle"]:
            raise ValueError("Artifact manifest domain mismatch")
        check_manifest_transition(repository, manifest["git_revision"], revision)
        entries = manifest["artifacts"]
        if len(entries) != len(ARTIFACTS[chain]) or {e["name"] for e in entries} != ARTIFACTS[chain]:
            raise ValueError("Unexpected or duplicate artifact names")
        for entry in entries:
            artifact = repository / target["artifact_directory"] / entry["name"]
            data = artifact.read_bytes()
            if len(data) != entry["bytes"] or native.digest(data) != entry["sha256"]:
                raise ValueError("Stale local artifact bytes: " + entry["name"])
        result[chain] = {"policy": policy, "api": api, "manifest": manifest}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lean", default=os.environ.get("LEAN_BIN", "lean"))
    arguments = parser.parse_args()
    lock = json.loads((DIRECTORY / "published-source-lock.json").read_text())
    sysroot = Path(native.run(["rustc", "--print", "sysroot"], ROOT).strip())
    compiler = str((sysroot / "bin" / "rustc").resolve(strict=True))
    rustc_version = native.run([compiler, "--version"], ROOT).strip()
    if rustc_version != lock["rustc_version"]:
        raise ValueError("Use the pinned host rustc version")
    paths = [Path(__file__).resolve(), DIRECTORY / "published-source-lock.json",
             DIRECTORY / "check_native.py", DIRECTORY / "lean/check.py",
             DIRECTORY / "lean/NativeDaily.lean", DIRECTORY / "lean/AllowIt.lean",
             DIRECTORY / "lean/ReplayNative.lean", DIRECTORY / "lean/lean-toolchain"]
    dependencies = {str(p.relative_to(DIRECTORY)): native.digest(p.read_bytes()) for p in paths}
    sources = intake(lock)
    environment = dict(os.environ, LEAN_BIN=arguments.lean)
    proof_log = native.run(["python3", str(DIRECTORY / "lean/check.py")], ROOT, environment=environment)
    values = native.cases()
    reference = [native.expected(case) for case in values]
    inputs = "\n".join(" ".join(str(v).lower() for v in case) for case in values) + "\n"
    with tempfile.TemporaryDirectory(prefix="allowit-published-") as temporary:
        workspace = Path(temporary)
        runners = {"Lean": native.lean_output(workspace, inputs, arguments.lean)}
        for chain, source in sources.items():
            runners[chain] = native.rust_output(workspace / chain, source["policy"], source["api"], inputs, compiler)
        for name, outputs in runners.items():
            disagreement = native.mismatch(values, reference, outputs)
            if disagreement:
                raise ValueError(name + " counterexample: " + json.dumps(disagreement))
    if intake(lock) != sources or any(native.digest(p.read_bytes()) != dependencies[str(p.relative_to(DIRECTORY))] for p in paths):
        raise ValueError("Published inputs or verification dependencies changed during replay")
    print(json.dumps({"evidence": "tested_correspondence", "domain": "published kernel host execution",
                      "cases": len(values), "policySha256": lock["policy_sha256"],
                      "apiSha256": lock["api_sha256"], "sourceBundleSha256": lock["source_bundle"],
                      "modelSha256": dependencies["lean/NativeDaily.lean"],
                      "corpusSha256": native.digest(inputs.encode()), "proofCheckLogSha256": native.digest(proof_log.encode()),
                      "lean": native.run([arguments.lean, "--version"], ROOT).strip(),
                      "rustc": rustc_version, "rustcExecutable": compiler,
                      "contractRevisions": {chain: target["revision"] for chain, target in lock["targets"].items()},
                      "artifactManifests": {chain: value["manifest"] for chain, value in sources.items()},
                      "verificationDependencies": dependencies, "localArtifactBytesChecked": True,
                      "oldFrozenEvidenceRetargeted": False, "mutationChecksRerun": False,
                      "buildProvenanceProved": False, "productionRefinement": False,
                      "adapterExecution": False, "deploymentChecked": False}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({"evidence": "not_accepted", "error": str(error)}))
        raise SystemExit(1)
