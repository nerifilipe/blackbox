"""Test a compiled Blackbox against unmodified typicode/json-server 0.17.4."""

import argparse
import hashlib
import http.client
import json
import subprocess
import sys
import time
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

# These helpers use only the standard library; no Fitness Tracker backend is loaded.
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE.parent / "fitness"))
from runtime import expect, free_ports, process, request, wait_http  # noqa: E402


def sc(path, kind, method="POST", limit=1, delay=0, status=0):
    return {
        "version": 1,
        "name": "JSON Server compatibility",
        "description": "Independent third-party API",
        "rules": [
            {
                "id": "test",
                "name": kind,
                "method": method,
                "path": path,
                "kind": kind,
                "limit": limit,
                "delayMs": delay,
                "status": status,
                "enabled": True,
            }
        ],
    }


class Suite:
    def __init__(self, control, proxy, upstream, data):
        self.control, self.proxy, self.upstream, self.data = control, proxy, upstream, data
        self.cases = []

    def begin(self, name, scenario):
        self.case = {"name": name, "runId": str(uuid4()), "checks": [], "scenario": scenario}
        self.cases.append(self.case)
        expect(self.control, "PUT", "/api/scenario", scenario)

    def verify(self, name, actual, expected):
        result = {
            "name": name,
            "actual": actual,
            "expected": expected,
            "passed": actual == expected,
        }
        self.case["checks"].append(result)
        if not result["passed"]:
            raise AssertionError(name)

    def send(self, method, path, body=None, headers=None):
        return request(
            self.proxy,
            method,
            path,
            body,
            {"X-Blackbox-Run": self.case["runId"], **(headers or {})},
        )

    def rows(self, collection):
        # lowdb replaces the JSON file atomically. Windows can briefly deny a read
        # during that replacement; wait only for a readable snapshot, never retry HTTP here.
        deadline = time.monotonic() + 3
        while True:
            try:
                return json.loads(self.data.read_text(encoding="utf-8"))[collection]
            except (PermissionError, FileNotFoundError, json.JSONDecodeError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.02)

    def settled_rows(self, collection, predicate):
        # JSON Server's CLI uses asynchronous file persistence. Check the real
        # file with a bounded wait, before sending the next attempt.
        deadline = time.monotonic() + 3
        started = time.monotonic()
        while True:
            rows = self.rows(collection)
            if predicate(rows) or time.monotonic() >= deadline:
                self.case.setdefault("persistenceReads", []).append(
                    {
                        "collection": collection,
                        "waitMs": round((time.monotonic() - started) * 1000, 2),
                        "rows": rows,
                    }
                )
                return rows
            time.sleep(0.02)

    def events(self, count):
        deadline = time.monotonic() + 3
        while True:
            events = sorted(
                (
                    e
                    for e in expect(self.control, "GET", "/api/state")["events"]
                    if e["runId"] == self.case["runId"]
                ),
                key=lambda e: e["id"],
            )
            if len(events) >= count or time.monotonic() > deadline:
                self.case["events"] = events
                self.verify("Every attempt has a proxy event", len(events), count)
                return events
            time.sleep(0.03)

    def crud(self):
        self.begin(
            "CRUD, query forwarding and metadata privacy",
            sc("/unmatched", "http_error", status=503),
        )
        payload = {"title": "Ação — integração independente", "author": "test-author"}
        status, created = self.send(
            "POST", "/posts", payload, {"Authorization": "Bearer synthetic-header-marker"}
        )
        self.verify("POST status", status, 201)
        self.verify("UTF-8 JSON round trip", created["title"], payload["title"])
        status, filtered = self.send(
            "GET", "/posts?author=test-author&query_marker=synthetic-query-marker"
        )
        # JSON Server treats unknown query fields as filters; verify a supported query separately.
        self.verify("Query-bearing request forwarded", status, 200)
        status, filtered = self.send("GET", "/posts?author=test-author")
        self.verify("Query filter preserved", [r["id"] for r in filtered], [created["id"]])
        path = "/posts/" + str(created["id"])
        status, patched = self.send("PATCH", path, {"title": "Updated"})
        self.verify("PATCH status", status, 200)
        self.verify(
            "PATCH persisted",
            self.settled_rows("posts", lambda rows: rows[-1]["title"] == "Updated")[-1]["title"],
            "Updated",
        )
        status, _ = self.send("DELETE", path)
        self.verify("DELETE status", status, 200)
        self.verify(
            "DELETE persisted", len(self.settled_rows("posts", lambda rows: len(rows) == 1)), 1
        )
        events = self.events(5)
        self.verify("Unmatched rule did not fire", [e["fault"] for e in events], [""] * 5)
        recorded = json.dumps(events)
        for marker in (
            "synthetic-header-marker",
            "synthetic-query-marker",
            "test-author",
            "query_marker",
        ):
            self.verify("Metadata omits " + marker, marker in recorded, False)

    def lost_post(self):
        self.begin("Lost POST response exposes duplicate creation", sc("/lost", "drop_response"))
        body, headers = (
            {"action": "one-user-action"},
            {"Idempotency-Key": "same-key-on-both-attempts"},
        )
        first, _ = self.send("POST", "/lost", body, headers)
        self.verify("First response lost", first, 0)
        self.verify(
            "Write persisted before retry",
            len(self.settled_rows("lost", lambda rows: len(rows) == 1)),
            1,
        )
        second, _ = self.send("POST", "/lost", body, headers)
        self.verify("Retry succeeded", second, 201)
        self.verify(
            "Two records expose unsafe retry",
            len(self.settled_rows("lost", lambda rows: len(rows) == 2)),
            2,
        )
        self.verify("Records have distinct IDs", len({r["id"] for r in self.rows("lost")}), 2)
        events = self.events(2)
        self.verify(
            "Dropped response followed upstream commit acknowledgement",
            [(e["status"], e["upstreamStatus"], e["outcome"]) for e in events],
            [(0, 201, "response_dropped"), (201, 201, "forwarded")],
        )
        self.case["applicationInvariant"] = {
            "name": "one record per user action",
            "passed": False,
            "actual": 2,
            "expected": 1,
            "interpretation": "Expected finding: JSON Server does not deduplicate this POST based on Idempotency-Key.",
        }

    def lost_put(self):
        self.begin(
            "Identical PUT retry preserves one resource",
            sc("/items/1", "drop_response", method="PUT"),
        )
        body = {"name": "Replaced", "quantity": 7}
        first, _ = self.send("PUT", "/items/1", body)
        self.verify("First response lost", first, 0)
        before_retry = deepcopy(self.settled_rows("items", lambda rows: rows[0]["quantity"] == 7))
        self.verify("Replacement persisted before retry", before_retry[0]["quantity"], 7)
        second, _ = self.send("PUT", "/items/1", body)
        self.verify("Retry status", second, 200)
        self.verify("Retry leaves same persisted state", self.rows("items"), before_retry)
        self.verify("Only one resource exists", len(self.rows("items")), 1)
        events = self.events(2)
        self.verify("Real response loss recorded", events[0]["outcome"], "response_dropped")

    def temporary_errors(self):
        self.begin(
            "Two 503s followed by one committed POST",
            sc("/errors", "http_error", limit=2, status=503),
        )
        statuses = []
        for index in range(3):
            status, _ = self.send("POST", "/errors", {"name": "retry"})
            statuses.append(status)
            rows = (
                self.settled_rows("errors", lambda rows: len(rows) == 1)
                if index == 2
                else self.rows("errors")
            )
            self.verify(
                f"Persisted count after attempt {index + 1}", len(rows), 1 if index == 2 else 0
            )
        self.verify("Client status sequence", statuses, [503, 503, 201])
        events = self.events(3)
        self.verify(
            "Injected errors did not reach upstream",
            [e["upstreamStatus"] for e in events],
            [0, 0, 201],
        )
        self.verify(
            "Fault budget consumed exactly twice",
            expect(self.control, "GET", "/api/state")["counts"],
            {"test": 2},
        )

    def matching(self):
        self.begin(
            "Exact method/path matching and query handling", sc("/orders", "http_error", status=503)
        )
        status, _ = self.send("GET", "/orders")
        self.verify("Different method passes", status, 200)
        status, _ = self.send("POST", "/orders-near", {"name": "does not match"})
        self.verify("Different path reaches upstream", status, 201)
        status, _ = self.send("POST", "/orders?source=test", {"name": "matches without query"})
        self.verify("Query does not bypass exact path rule", status, 503)
        self.verify("Rejected POST did not persist", len(self.rows("orders")), 0)
        events = self.events(3)
        self.verify(
            "Only the exact method/path matched",
            [e["fault"] for e in events],
            ["", "", "http_error"],
        )

    def latency(self):
        self.begin(
            "Injected latency is observable and bounded by budget",
            sc("/posts", "latency", method="GET", delay=700),
        )
        started = time.monotonic()
        first, _ = self.send("GET", "/posts")
        elapsed = (time.monotonic() - started) * 1000
        second, _ = self.send("GET", "/posts")
        self.verify("Both reads succeeded", [first, second], [200, 200])
        self.verify("Client observed at least 650 ms", elapsed >= 650, True)
        self.case["observedClientMs"] = round(elapsed, 2)
        events = self.events(2)
        self.verify("Only first request delayed", [e["fault"] for e in events], ["latency", ""])
        self.verify("Proxy recorded delay", events[0]["durationMs"] >= 650, True)

    def cancellation(self):
        self.begin(
            "Client cancellation during latency prevents forwarding",
            sc("/cancelled", "latency", delay=1000),
        )
        port = int(self.proxy.rsplit(":", 1)[1])
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=0.15)
        timed_out = False
        try:
            conn.request(
                "POST",
                "/cancelled",
                body=json.dumps({"name": "must not be saved"}),
                headers={"Content-Type": "application/json", "X-Blackbox-Run": self.case["runId"]},
            )
            conn.getresponse()
        except TimeoutError:
            timed_out = True
        finally:
            conn.close()
        self.verify("Client timed out before injected delay ended", timed_out, True)
        events = self.events(1)
        time.sleep(1.1)
        self.verify("No later write after delay expired", self.rows("cancelled"), [])
        self.verify("Cancellation recorded", events[0]["outcome"], "client_cancelled")
        self.verify("Request never reached upstream", events[0]["upstreamStatus"], 0)
        self.verify(
            "Cancelled admission still consumed budget",
            expect(self.control, "GET", "/api/state")["counts"],
            {"test": 1},
        )

    def validation(self):
        valid = sc("/orders", "http_error", status=503)
        self.begin("External-target controls and invalid configuration", valid)
        invalid = deepcopy(valid)
        invalid["rules"][0]["kind"] = "not-a-fault"
        status, _ = request(self.control, "PUT", "/api/scenario", invalid)
        self.verify("Invalid configuration rejected", status, 400)
        self.verify(
            "Valid configuration preserved", expect(self.control, "GET", "/api/scenario"), valid
        )
        self.verify(
            "Bundled demo marked unavailable",
            expect(self.control, "GET", "/api/state")["demoAvailable"],
            False,
        )
        status, _ = request(self.control, "POST", "/api/demo/run", {"mode": "resilient"})
        self.verify("Bundled demo cannot write to external target", status, 409)
        status, _ = self.send("POST", "/orders", {"name": "still rejected"})
        self.verify("Preserved rule still fires", status, 503)
        self.events(1)


def write_result(output, report):
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# Blackbox × JSON Server verification",
        "",
        f"Result: **{'PASS' if report['passed'] else 'FAIL / INCOMPLETE'}**",
        "",
        f"Started: {report['startedAt']}",
        f"Binary: `{report.get('binaryVersion', 'unavailable')}`",
        f"Binary SHA-256: `{report.get('binarySha256', 'unavailable')}`",
        "",
        "Target: unmodified [typicode/json-server](https://github.com/typicode/json-server/tree/v0.17.4), version 0.17.4.",
        "",
        "| Case | Assertions | Result |",
        "| --- | --- | --- |",
    ]
    for case in report["cases"]:
        checks = case["checks"]
        lines.append(
            f"| {case['name']} | {sum(c['passed'] for c in checks)}/{len(checks)} | {'PASS' if case.get('passed') else 'FAIL'} |"
        )
    lines += [
        "",
        "The lost-POST case intentionally exposes **two records for one logical action**, even with the same Idempotency-Key header. The tool test passes because it detects this unsafe retry; the application's one-record invariant fails. The identical PUT test verifies final resource state, not exactly-once execution.",
        "",
        "These are automated engineering checks against a real third-party API tool, not feedback from human participants or a production application assessment.",
        "",
        "See report.json for exact rules, assertions and proxy observations. No third-party source was modified.",
    ]
    if report.get("error"):
        lines += ["", "Execution error: " + report["error"]]
    (output / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--blackbox", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="new output directory")
    parser.add_argument(
        "--browser-check",
        action="store_true",
        help="also inspect desktop/mobile UI; requires web npm dependencies and Chrome",
    )
    args = parser.parse_args()
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "cases": [],
        "passed": False,
        "project": "https://github.com/typicode/json-server",
        "targetVersion": "0.17.4",
    }
    try:
        binary = args.blackbox.resolve()
        report["binaryVersion"] = subprocess.check_output(
            [str(binary), "version"], text=True
        ).strip()
        report["binarySha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
        report["dependencyLockSha256"] = hashlib.sha256(
            (HERE / "package-lock.json").read_bytes()
        ).hexdigest()
        installed = json.loads((HERE / "node_modules/json-server/package.json").read_text())
        if installed["version"] != "0.17.4":
            raise RuntimeError("Unexpected JSON Server version; run npm ci")
        data = output / "db.json"
        initial = {
            "posts": [{"id": 1, "title": "Original", "author": "other"}],
            "lost": [],
            "items": [{"id": 1, "name": "Initial", "quantity": 0}],
            "errors": [],
            "orders": [],
            "orders-near": [],
            "cancelled": [],
        }
        data.write_text(json.dumps(initial), encoding="utf-8")
        api_port, proxy_port, control_port = free_ports(3)
        upstream, proxy, control = [
            f"http://127.0.0.1:{p}" for p in (api_port, proxy_port, control_port)
        ]
        command = [
            binary,
            "serve",
            "-target",
            upstream,
            "-proxy",
            f"127.0.0.1:{proxy_port}",
            "-ui",
            f"127.0.0.1:{control_port}",
            "-db",
            output / "history.db",
        ]
        suite = Suite(control, proxy, upstream, data)
        report["cases"] = suite.cases
        with process(
            [
                "node",
                HERE / "node_modules/json-server/lib/cli/bin.js",
                data,
                "--host",
                "127.0.0.1",
                "--port",
                api_port,
                "--quiet",
            ],
            output / "json-server.log",
            cwd=output,
        ) as upstream_process:
            wait_http(upstream, "/posts", upstream_process)
            with process(command, output / "blackbox.log", cwd=output) as proxy_process:
                wait_http(control, "/api/state", proxy_process)
                for test in (
                    suite.crud,
                    suite.lost_post,
                    suite.lost_put,
                    suite.temporary_errors,
                    suite.matching,
                    suite.latency,
                    suite.cancellation,
                    suite.validation,
                ):
                    try:
                        test()
                        suite.case["passed"] = True
                    except Exception as exc:
                        suite.case["passed"] = False
                        suite.case["error"] = type(exc).__name__ + ": " + str(exc)
                    print(
                        f"{'PASS' if suite.case['passed'] else 'FAIL'} {suite.case['name']}",
                        flush=True,
                    )
                    write_result(output, report)
                before = expect(control, "GET", "/api/state")
                if args.browser_check:
                    subprocess.run(
                        ["node", str(HERE / "check-ui.mjs"), control, str(output)],
                        check=True,
                        timeout=60,
                    )
                    report["browserChecks"] = json.loads(
                        (output / "browser-checks.json").read_text()
                    )
            with process(command, output / "blackbox-restart.log", cwd=output) as restarted:
                wait_http(control, "/api/state", restarted)
                after = expect(control, "GET", "/api/state")
                suite.case = {
                    "name": "Proxy restart retains external history and resets budgets",
                    "checks": [],
                }
                suite.cases.append(suite.case)
                suite.verify(
                    "Exact event history survives restart", after["events"], before["events"]
                )
                suite.verify("Scenario survives restart", after["scenario"], before["scenario"])
                suite.verify("Fault budgets reset", after["counts"], {})
                suite.verify("External target remains external", after["demoAvailable"], False)
                suite.case["passed"] = True
                print("PASS Proxy restart", flush=True)
        report["cleanupCompleted"] = True
        report["passed"] = len(suite.cases) == 9 and all(c.get("passed") for c in suite.cases)
    except Exception as exc:
        report["error"] = type(exc).__name__ + ": " + str(exc)
    finally:
        write_result(output, report)
    print(f"Evidence: {output / 'report.md'}", flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
