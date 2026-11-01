import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

DIRECTORY = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("check_native", DIRECTORY / "check_native.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeEvidenceTests(unittest.TestCase):
    def test_sources_cannot_silently_retarget_proofs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = {"version": 1, "policy_sha256": native.digest(b"policy"),
                    "api_sha256": native.digest(b"api"),
                    "targets": {"solana": "solana", "stellar": "stellar"}, "binding": "test"}
            for target in lock["targets"]:
                (root / target).mkdir()
                (root / target / "policy.rs").write_bytes(b"policy")
                (root / target / "policy_api.rs").write_bytes(b"api")
                values = list(bytes.fromhex(lock["policy_sha256"]))
                (root / target / "source_hash.rs").write_text(
                    "pub const SOURCE_HASH: [u8; 32] = " + str(values) + ";\n")
            with patch.object(native, "ROOT", root):
                self.assertEqual(set(native.read_sources(lock)), {"solana", "stellar"})
                (root / "stellar" / "policy_api.rs").write_bytes(b"changed")
                with self.assertRaisesRegex(ValueError, "Stale source binding"):
                    native.read_sources(lock)

    def test_unknown_lock_version_and_missing_target_refuse(self):
        lock = json.loads((DIRECTORY / "native-source-lock.json").read_text())
        for version in (2, True):
            altered = copy.deepcopy(lock)
            altered["version"] = version
            with self.assertRaisesRegex(ValueError, "Unsupported source-lock schema"):
                native.read_sources(altered)
        altered = copy.deepcopy(lock)
        del altered["targets"]["stellar"]
        with self.assertRaisesRegex(ValueError, "Both native source targets"):
            native.read_sources(altered)

    def test_corpus_must_have_complete_matching_results(self):
        vector = (True, 10, 25, 15, 1, 86401)
        self.assertEqual(native.expected(vector), "ok 25")
        self.assertIsNone(native.mismatch([vector], ["ok 25"], ["ok 25"]))
        result = native.mismatch([vector], ["ok 25"], ["err DailyLimitExceeded"])
        self.assertEqual(result["input"]["amount"], 10)
        with self.assertRaisesRegex(ValueError, "incomplete result corpus"):
            native.mismatch([vector], ["ok 25"], [])

    def test_embedded_hash_cannot_claim_different_policy(self):
        source = "pub const SOURCE_HASH: [u8; 32] = " + str([0] * 32) + ";"
        native.embedded_policy_hash(source, "00" * 32)
        with self.assertRaisesRegex(ValueError, "does not match"):
            native.embedded_policy_hash(source, "01" * 32)
        with self.assertRaisesRegex(ValueError, "does not match"):
            native.embedded_policy_hash(source.replace("[0,", "[256,", 1), "00" * 32)

    def test_ledger_ids_and_profiles_are_exhaustive_and_unique(self):
        ledger = json.loads((DIRECTORY / "obligations.json").read_text())
        self.assertEqual([v["id"] for v in ledger["obligations"]],
                         ["V%02d" % n for n in range(1, 25)])
        levels = {"specified", "model_checked", "tested_correspondence", "implementation_proved",
                  "adapter_tested", "client_tested", "deployed_identity_checked", "external_assumption",
                  "source_identity_checked", "harness_checked", "extracted_model_refinement"}
        self.assertEqual(set(ledger["evidence_levels"]), levels)
        components = {"specification", "contracts", "sdk", "gateway", "cli", "frontend", "skills",
                      "builds", "policy", "lean", "semantic_provider", "provider", "verification"}
        for obligation in ledger["obligations"]:
            self.assertTrue(set(obligation["profiles"]) <= set(ledger["profiles"]))
            self.assertTrue(obligation["statement"])
            self.assertIn(obligation["status"], {"open", "satisfied", "excluded"})
            self.assertTrue(set(obligation["components"]) <= components)
            for evidence in obligation["evidence"]:
                self.assertIn(evidence["level"], levels)
                self.assertTrue(evidence["scope"])
                self.assertTrue(evidence["receipt"])
        for extension in ("semantic_policy", "paid_api"):
            self.assertEqual(ledger["profiles"][extension]["required_base_profile_any_of"],
                             ["native_solana", "native_stellar"])

    def test_ledger_evidence_receipt_and_current_dependencies_agree(self):
        ledger = json.loads((DIRECTORY / "obligations.json").read_text())
        lock = json.loads((DIRECTORY / "native-source-lock.json").read_text())
        for obligation in ledger["obligations"]:
            for evidence in obligation["evidence"]:
                receipt_bytes = (DIRECTORY / evidence["receipt"]).read_bytes()
                self.assertEqual(evidence["receipt_sha256"], native.digest(receipt_bytes))
                receipt = json.loads(receipt_bytes)
                if evidence["level"] == "extracted_model_refinement":
                    refinement_lock_bytes = (DIRECTORY / "refinement/lock.json").read_bytes()
                    refinement_lock = json.loads(refinement_lock_bytes)
                    self.assertEqual(receipt["evidence"], evidence["level"])
                    self.assertEqual(receipt["lockSha256"], native.digest(refinement_lock_bytes))
                    self.assertEqual(receipt["dependencies"], refinement_lock["files"])
                    for path, digest in receipt["dependencies"].items():
                        self.assertEqual(native.digest((DIRECTORY / "refinement" / path).read_bytes()), digest)
                    self.assertTrue(evidence["partial"])
                    self.assertTrue(evidence["producer"])
                    self.assertTrue(evidence["reviewer"])
                    self.assertTrue(evidence["checked_at"])
                    self.assertEqual(obligation["status"], "open")
                    continue
                for key, field in (("policy_sha256", "policySha256"), ("api_sha256", "apiSha256"),
                                   ("model_sha256", "modelSha256"), ("corpus_sha256", "corpusSha256"),
                                   ("proof_log_sha256", "proofCheckLogSha256")):
                    self.assertEqual(evidence[key], receipt[field])
                self.assertEqual(receipt["policySha256"], lock["policy_sha256"])
                self.assertEqual(receipt["apiSha256"], lock["api_sha256"])
                self.assertEqual(receipt["modelSha256"],
                                 native.digest((DIRECTORY / "lean" / "NativeDaily.lean").read_bytes()))
                self.assertEqual(receipt["proofCheckLogSha256"],
                                 native.digest((DIRECTORY / "lean" / "proof-check.txt").read_bytes()))
                for path, digest in receipt["verificationDependencies"].items():
                    self.assertEqual(native.digest((DIRECTORY / path).read_bytes()), digest)


if __name__ == "__main__":
    unittest.main()
