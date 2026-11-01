import importlib.util
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIRECTORY))
spec = importlib.util.spec_from_file_location("check_published", DIRECTORY / "check_published.py")
published = importlib.util.module_from_spec(spec)
spec.loader.exec_module(published)


def declaration(digest):
    return "pub const SOURCE_HASH: [u8; 32] = " + str(list(bytes.fromhex(digest))) + ";"


class PublishedBindingTests(unittest.TestCase):
    def test_api_changes_cannot_preserve_bundle_identity(self):
        policy, api = b"policy", b"api"
        bundle = published.source_bundle(policy, api)
        lock = {"policy_sha256": published.native.digest(policy),
                "api_sha256": published.native.digest(api), "source_bundle": bundle}
        self.assertEqual(published.identity(policy, api, declaration(bundle), lock), bundle)
        altered = dict(lock, api_sha256=published.native.digest(b"different api"))
        with self.assertRaisesRegex(ValueError, "bundle mismatch"):
            published.identity(policy, b"different api", declaration(bundle), altered)
        with self.assertRaisesRegex(ValueError, "does not match"):
            published.identity(policy, api, declaration(lock["policy_sha256"]), lock)

    def test_unknown_lock_version_refuses_before_checkout_access(self):
        lock = json.loads((DIRECTORY / "published-source-lock.json").read_text())
        for version in (True, 2):
            with self.assertRaisesRegex(ValueError, "Unsupported published lock"):
                published.intake(dict(lock, version=version))

    def test_modified_local_artifact_cannot_pass_identity(self):
        policy, api = b"policy", b"api"
        bundle = published.source_bundle(policy, api)
        lock = {"version": 1, "rustc_version": "fixture", "policy_sha256": published.native.digest(policy),
                "api_sha256": published.native.digest(api), "source_bundle": bundle, "targets": {}}
        commits = {}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for chain, names in published.ARTIFACTS.items():
                repo = root / chain
                (repo / "artifacts").mkdir(parents=True)
                entries = []
                for name in names:
                    data = name.encode()
                    (repo / "artifacts" / name).write_bytes(data)
                    entries.append({"name": name, "bytes": len(data), "sha256": published.native.digest(data)})
                manifest = json.dumps({"schema": 1, "source_bundle": bundle,
                                       "git_revision": "a" * 40, "artifacts": entries}).encode()
                commits[chain] = {"policy/policy.rs": policy, "policy/policy_api.rs": api,
                                  "policy/source_hash.rs": declaration(bundle).encode(), "artifacts/manifest.json": manifest}
                lock["targets"][chain] = {"repository": chain, "revision": "a" * 40,
                                          "manifest_sha256": published.native.digest(manifest), "artifact_directory": "artifacts"}
            state = {"head": "a" * 40, "status": "", "changes": "", "ancestor": True}
            def git(repo, *args):
                if args == ("rev-parse", "HEAD"):
                    return state["head"]
                if args[0] == "status":
                    return state["status"]
                if args[0] == "diff":
                    return state["changes"]
                if args[0] == "merge-base" and not state["ancestor"]:
                    raise subprocess.CalledProcessError(1, ["git", *args])
                return ""
            with patch.object(published, "ROOT", root), patch.object(published, "git", git), \
                 patch.object(published, "committed", lambda repo, rev, path: commits[repo.name][path]):
                self.assertEqual(set(published.intake(lock)), {"solana", "stellar"})
                for field, value in (("head", "b" * 40), ("status", "?? unknown.rs"),
                                     ("changes", "programs/vault/src/lib.rs"), ("ancestor", False)):
                    original = state[field]
                    state[field] = value
                    with self.subTest(guard=field), self.assertRaises((ValueError, subprocess.CalledProcessError)):
                        published.intake(lock)
                    state[field] = original
                original = commits["solana"]["artifacts/manifest.json"]
                original_digest = lock["targets"]["solana"]["manifest_sha256"]
                lock["targets"]["solana"]["manifest_sha256"] = "0" * 64
                with self.assertRaisesRegex(ValueError, "manifest binding"):
                    published.intake(lock)
                lock["targets"]["solana"]["manifest_sha256"] = original_digest
                variants = []
                for field, value in (("schema", 2), ("source_bundle", "0" * 64), ("git_revision", "HEAD")):
                    variant = json.loads(original)
                    variant[field] = value
                    variants.append(variant)
                variant = json.loads(original)
                variant["artifacts"][0]["name"] = "unapproved.so"
                variants.append(variant)
                variant = json.loads(original)
                variant["artifacts"][1] = variant["artifacts"][0].copy()
                variants.append(variant)
                for variant in variants:
                    data = json.dumps(variant).encode()
                    commits["solana"]["artifacts/manifest.json"] = data
                    lock["targets"]["solana"]["manifest_sha256"] = published.native.digest(data)
                    with self.subTest(manifest=variant), self.assertRaises(ValueError):
                        published.intake(lock)
                commits["solana"]["artifacts/manifest.json"] = original
                lock["targets"]["solana"]["manifest_sha256"] = original_digest
                (root / "solana/artifacts/allowit_policy.so").write_bytes(b"substituted")
                with self.assertRaisesRegex(ValueError, "Stale local artifact"):
                    published.intake(lock)

    def test_published_receipt_remains_bound_to_dependencies(self):
        receipt = json.loads((DIRECTORY / "published-correspondence.json").read_text())
        lock = json.loads((DIRECTORY / "published-source-lock.json").read_text())
        for key, field in (("policy_sha256", "policySha256"), ("api_sha256", "apiSha256"),
                           ("source_bundle", "sourceBundleSha256")):
            self.assertEqual(lock[key], receipt[field])
        for name, digest in receipt["verificationDependencies"].items():
            self.assertEqual(published.native.digest((DIRECTORY / name).read_bytes()), digest)
        ledger = json.loads((DIRECTORY / "obligations.json").read_text())
        self.assertEqual(ledger["published_intake"]["receipt_sha256"],
                         published.native.digest((DIRECTORY / "published-correspondence.json").read_bytes()))
        self.assertFalse(receipt["productionRefinement"])
        self.assertFalse(receipt["adapterExecution"])

    def test_retained_old_policy_matches_original_provenance(self):
        original = json.loads((DIRECTORY / "native-source-lock.json").read_text())
        self.assertEqual(published.native.digest((DIRECTORY / "history/frozen-source/policy.rs").read_bytes()),
                         original["policy_sha256"])

    def test_real_git_rename_cannot_hide_removed_build_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()
            git("init", "-q")
            git("config", "user.name", "Verification fixture")
            git("config", "user.email", "fixture@example.invalid")
            (repo / "empty-hooks").mkdir()
            git("config", "core.hooksPath", str(repo / "empty-hooks"))
            (repo / "programs").mkdir()
            (repo / "programs/lib.rs").write_text("pub fn kernel() {}\n")
            git("add", ".")
            git("-c", "commit.gpgsign=false", "commit", "-qm", "before")
            before = git("rev-parse", "HEAD")
            (repo / "evidence").mkdir()
            git("mv", "programs/lib.rs", "evidence/opus-review.json")
            git("-c", "commit.gpgsign=false", "commit", "-qm", "after")
            after = git("rev-parse", "HEAD")
            with self.assertRaisesRegex(ValueError, "Build inputs changed"):
                published.check_manifest_transition(repo, before, after)
            git("checkout", "-qb", "space-path", before)
            (repo / " README.md").write_text("This path is not allowlisted.\n")
            git("add", " README.md")
            git("-c", "commit.gpgsign=false", "commit", "-qm", "leading-space path")
            with self.assertRaisesRegex(ValueError, "Build inputs changed"):
                published.check_manifest_transition(repo, before, git("rev-parse", "HEAD"))


if __name__ == "__main__":
    unittest.main()
