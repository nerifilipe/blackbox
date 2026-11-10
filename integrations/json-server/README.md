# Independent compatibility check: JSON Server

This suite runs Blackbox against the **unmodified npm distribution of [typicode/json-server 0.17.4](https://github.com/typicode/json-server/tree/v0.17.4)**. This is a third-party REST API prototyping tool, independent of Blackbox and Fitness Tracker. Its official README identifies 0.17.4 as the stable v0 release; package.json and package-lock.json pin the test dependencies.

The suite creates an isolated JSON database, starts both processes on local ports, sends actual HTTP requests and checks the target's saved file alongside Blackbox's metadata. It uses synthetic data only. The third-party application is neither patched nor wrapped in replacement application logic.

## Reproduce

Requirements: Node.js 24, Python 3.12+ and a compiled Blackbox executable. From the Blackbox repository root:

```powershell
npm ci --prefix integrations/json-server --ignore-scripts --no-audit --no-fund
python integrations/json-server/check.py --blackbox dist/blackbox.exe --out .blackbox/json-server-results
```

On Linux use `--blackbox dist/blackbox`. The output directory must not exist. To test a downloaded release, point `--blackbox` at its extracted executable instead. No Python packages or PostgreSQL installation are required. The harness reuses standard-library process/HTTP helpers from `integrations/fitness/runtime.py`; it does not load the Fitness Tracker backend.

Add `--browser-check` to inspect the real external-target UI on desktop and mobile viewport. This optional check requires the frontend's npm development dependencies and an installed Chrome. `BLACKBOX_BROWSER_CHANNEL` can select another installed Playwright channel.

Exit code **0** means all nine scenarios passed and owned services stopped. Exit code **1** means a test or infrastructure check failed. `report.json` records individual assertions and correlated events; `report.md` summarizes them. The data file and logs remain in the output directory for inspection.

## Scenarios

1. CRUD, UTF-8 payloads, query filtering and omission of header/body/query markers from event metadata.
2. Lost POST response, identical retry and detection of two stored records despite a repeated `Idempotency-Key` header.
3. Lost PUT response and identical retry preserving one resource's final state.
4. Two injected 503s before a successful POST; rejected attempts do not persist data.
5. Exact method/path matching and query-string handling.
6. A 700 ms injected delay, measured at client and proxy; the next request is not delayed by the exhausted rule.
7. Client cancellation during a 1,000 ms delay; no request reaches the target and no later write appears.
8. Invalid configuration rejection, preservation of active rules and disabled bundled-demo execution for an external target.
9. Restart persistence of scenario/history and reset of fault counters.

## Interpreting the duplicate-POST result

The **tool verification passes**, but the tested application's **one-record-per-action invariant fails**: two records exist after retry. This is the expected finding. Sending an idempotency header cannot provide deduplication unless the target implements that behavior. JSON Server is an API prototyping tool and does not promise that behavior for this endpoint.

Conversely, the PUT test establishes identical final resource state for this fixture. It does not claim exactly-once processing or that arbitrary side effects elsewhere are safe to repeat.

The CLI uses lowdb's asynchronous file adapter, and its write middleware calls `db.write()` without awaiting it. File reads therefore wait up to three seconds for expected persistence and tolerate temporary Windows file-replacement locks. This waits for a database observation; it never retries the tested HTTP operation implicitly. Wait times and observed rows are included in the report. Cancellation checks wait beyond the injected delay to detect a late write.

## Recorded validation

See the [independent validation report](../../docs/third-party-validation.md) and [machine-readable evidence](../../docs/evidence/json-server/report.json). The published Windows v0.3.0 archive was downloaded independently, its checksum checked, and its executable used for the recorded run. The separate launcher smoke check removed Go/Node locations from the child PATH and used an extraction directory containing spaces.

These are automated compatibility and engineering checks. They are not observations from human participants, a security audit, a load benchmark or proof of compatibility with every API.
