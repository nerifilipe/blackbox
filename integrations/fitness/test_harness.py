"""Regression checks against recorded real evidence, including false-positive controls."""

import json
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from report import render
from run import ROOT, evaluate
from runtime import database, process, request


class EvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.recorded = json.loads(
            (ROOT / "docs/evidence/fitness/report.json").read_text(encoding="utf-8")
        )

    def case(self, name):
        return deepcopy(next(c for c in self.recorded["cases"] if c["id"] == name))

    def test_recorded_real_results_revalidate(self):
        for recorded in self.recorded["cases"]:
            with self.subTest(case=recorded["id"]):
                case = deepcopy(recorded)
                evaluate(case)
                self.assertTrue(case["passed"])

    def test_client_success_cannot_hide_duplicate_commit(self):
        case = self.case("lost-response")
        case["states"][-1]["database"].update(version=3, mutations=2)
        evaluate(case)
        self.assertFalse(case["passed"])

    def test_network_error_without_post_commit_evidence_fails(self):
        case = self.case("lost-response")
        case["events"][0].update(upstreamStatus=0, outcome="upstream_error")
        evaluate(case)
        self.assertFalse(case["passed"])

    def test_503_that_reaches_backend_cannot_pass(self):
        case = self.case("temporary-503")
        case["events"][0]["upstreamStatus"] = 503
        evaluate(case)
        self.assertFalse(case["passed"])

    def test_write_during_injected_503_cannot_pass(self):
        case = self.case("temporary-503")
        case["states"][1]["database"]["mutations"] = 1
        evaluate(case)
        self.assertFalse(case["passed"])

    def test_unrelated_conflict_is_not_a_stale_version_success(self):
        case = self.case("concurrent-edit")
        next(a for a in case["attempts"] if a["status"] == 409)["errorCode"] = (
            "mutation_id_conflict"
        )
        evaluate(case)
        self.assertFalse(case["passed"])

    def test_lost_winning_edit_cannot_pass(self):
        case = self.case("concurrent-edit")
        case["states"][-1]["database"]["notes"] = "overwritten"
        evaluate(case)
        self.assertFalse(case["passed"])

    def test_report_escapes_data_and_marks_failure(self):
        report = deepcopy(self.recorded)
        report["cases"][0]["name"] = '<script>alert("bad")</script>'
        report["passed"] = False
        document = render(report)
        self.assertNotIn('<script>alert("bad")</script>', document)
        self.assertIn("&lt;script&gt;", document)
        self.assertIn("INCOMPLETE / FAILED", document)

    def test_remote_destinations_are_rejected_before_connecting(self):
        with self.assertRaises(ValueError):
            request("http://example.com", "GET", "/")
        with self.assertRaises(ValueError):
            with database("postgresql+psycopg://user:secret@example.com/db", ROOT):
                self.fail("remote database accepted")

    def test_owned_process_stops_when_body_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError, "controlled failure"):
                with process(
                    [sys.executable, "-c", "import time; time.sleep(60)"],
                    Path(folder) / "process.log",
                ) as child:
                    raise RuntimeError("controlled failure")
            self.assertIsNotNone(child.poll())

    def test_setup_failure_writes_failed_report_and_exits_one(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "result"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("run.py")),
                    "--fitness-repo",
                    folder,
                    "--out",
                    str(output),
                ],
                capture_output=True,
                text=True,
                timeout=20,
            )
            self.assertEqual(completed.returncode, 1)
            report = json.loads((output / "report.json").read_text(encoding="utf-8"))
            self.assertFalse(report["passed"])
            self.assertEqual(report["stage"], "verify fixture")
            self.assertTrue((output / "report.html").is_file())


if __name__ == "__main__":
    unittest.main()
