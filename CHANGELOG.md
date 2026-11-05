# Changelog

## 0.3.0 — 2026-11-05

- Integrate the original Fitness Tracker backend at a pinned revision, using its migrations, HTTP authentication and PostgreSQL semantics.
- Reproduce post-commit response loss, two temporary 503 errors and concurrent edits with explicit client, proxy and database assertions.
- Prepare the fixture with one command; support a disposable local PostgreSQL cluster or an existing local test database.
- Export standalone HTML/JSON evidence and a 75-second offline presentation using recorded results.
- Add false-positive regression controls, report browser tests, a case study and a Portuguese presentation script.
- Extend CI with PostgreSQL integration execution and downloadable evidence artifacts.
- Keep external results separate from bundled-demo history because their invariants differ.

## 0.2.0 — 2026-11-05

- Browse the 100 most recent completed experiments and compare any two results.
- Preserve each new run's exact scenario and demo fixture version independently of later edits.
- Compare attempts, stored workouts, invariant outcomes and observed durations.
- Flag differing configurations and legacy records rather than inferring a fix from incomparable runs.
- Export saved results and configurations; restore a recorded setup without automatically executing it.
- Preserve existing v0.1 history without a schema reset.
- Add history persistence, retention, export and browser comparison tests.

## 0.1.0 — 2026-11-05

- Local HTTP proxy, latency, HTTP errors and post-upstream response drops.
- Visual traffic inspection, JSON scenarios, SQLite history and CLI.
- Real idempotency demonstration with fragile and resilient clients.
