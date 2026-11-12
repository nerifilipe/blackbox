# Blackbox × JSON Server verification

Result: **PASS**

Started: 2026-11-11T19:33:09.016101+00:00
Binary: `Blackbox 0.3.0`
Binary SHA-256: `9c8a65fdd60fe8048f03c10c0bcbeab64a1e3c55e3a997f39fb2043ce97a5c2d`

Target: unmodified [typicode/json-server](https://github.com/typicode/json-server/tree/v0.17.4), version 0.17.4.

| Case | Assertions | Result |
| --- | --- | --- |
| CRUD, query forwarding and metadata privacy | 14/14 | PASS |
| Lost POST response exposes duplicate creation | 7/7 | PASS |
| Identical PUT retry preserves one resource | 7/7 | PASS |
| Two 503s followed by one committed POST | 7/7 | PASS |
| Exact method/path matching and query handling | 6/6 | PASS |
| Injected latency is observable and bounded by budget | 5/5 | PASS |
| Client cancellation during latency prevents forwarding | 6/6 | PASS |
| External-target controls and invalid configuration | 6/6 | PASS |
| Proxy restart retains external history and resets budgets | 4/4 | PASS |

The lost-POST case intentionally exposes **two records for one logical action**, even with the same Idempotency-Key header. The tool test passes because it detects this unsafe retry; the application's one-record invariant fails. The identical PUT test verifies final resource state, not exactly-once execution.

These are automated engineering checks against a real third-party API tool, not feedback from human participants or a production application assessment.

See report.json for exact rules, assertions and proxy observations. No third-party source was modified.
