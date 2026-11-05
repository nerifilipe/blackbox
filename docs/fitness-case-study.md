# Case study: a successful write with a lost response

## Problem

A client cannot infer database state from a network error. Fitness Tracker synchronizes workouts through `PUT /api/v1/workouts/{id}`. If the backend commits an update and the response disappears, the client has to decide whether and how to retry.

The original backend associates each synchronization with a JSON `mutation_id`. Inside a transaction, it locks the workout, checks existing mutation receipts, validates the expected version, applies the change and records the resulting version. Repeating the same mutation and payload returns its `applied_version`. A different mutation based on an old workout version is rejected with `workout_conflict`.

Source: [Fitness Tracker synchronization service at the tested revision](https://github.com/nerifilipe/fitness-tracker-app/blob/fbb5b76610652045da4d080175d814f07cf87134/backend/app/modules/workouts/service.py).

## Experiment design

```mermaid
sequenceDiagram
    participant C as Python test client
    participant B as Blackbox proxy
    participant F as Original Fitness API
    participant D as PostgreSQL
    C->>B: PUT workout, version 1, mutation M
    B->>F: Forward unchanged request
    F->>D: Lock workout; apply M; store receipt; commit version 2
    D-->>F: Commit succeeded
    F-->>B: HTTP 200, applied_version 2
    B--xC: Drop response; close connection
    C->>D: Independent read: version 2, one receipt
    C->>B: Retry identical mutation M and payload
    B->>F: Forward retry
    F->>D: Read existing mutation receipt
    F-->>C: HTTP 200, applied_version 2
    C->>D: Verify unchanged state and preserved exercise/set IDs
```

The test uses the compiled Go proxy, actual TCP connections, Uvicorn, the original FastAPI routes, original Alembic migrations and PostgreSQL. Each execution gets a new schema. Each scenario creates its own synthetic user and workout through authenticated HTTP requests. No application service is replaced with a mock.

The test client is intentionally small and observable. It opens a new connection for each attempt, disables implicit retries by construction and retries only transport failures or 502/503/504, within the case's attempt budget. It reuses the identical mutation ID and JSON payload.

## Observed results

The checked-in [JSON evidence](evidence/fitness/report.json) and [offline HTML report](evidence/fitness/report.html) record a local run against the pinned backend with **42 passing assertions across three cases**.

| Case | Client observations | PostgreSQL evidence |
| --- | --- | --- |
| Response lost after commit | Connection closes without an HTTP status; identical retry returns 200 | Version 2 and one mutation receipt exist before retry; state remains unchanged afterward |
| Two temporary errors | 503, 503, 200 | Both rejected attempts leave version 1 and zero receipts; the accepted attempt produces version 2 and one receipt |
| Two concurrent edits | One 200; one 409 with `workout_conflict` | One receipt, version 2, winning notes retained |

Every case also checks that one exercise and one set remain and that their IDs are preserved. Each client attempt must have a corresponding recorded proxy event. A client error without evidence of the configured fault fails the test.

For the concurrency case, two worker threads start at a barrier with distinct mutation IDs and the same expected version. Blackbox delays the first eligible request by 300 ms. Either device may win; the assertion is about the resulting state and error semantics, not OS scheduling.

## What this demonstrates

- The distinction between an upstream response and the response actually delivered to a client.
- How a stable mutation ID makes a bounded retry safe for this endpoint.
- How optimistic version checks and transactional row locking preserve a winning update.
- Why both HTTP evidence and independent database assertions matter.
- How to make a failure experiment reproducible with pinned source, locked dependencies, isolated data and explicit exit codes.

The integration harness has negative controls for duplicate commits, writes during injected 503s, missing upstream evidence, unrelated 409 errors and overwritten winning edits. These must fail even if the client eventually receives HTTP 200.

## Limits and decisions

This is evidence for these concrete scenarios and revision, not a proof of exactly-once delivery in general. The harness exercises the backend with its own Python retry client; it does not validate the mobile application's offline queue. PostgreSQL is essential here because the backend uses row locking, deferred constraints and PostgreSQL-specific indexes. A SQLite substitute would change the semantics under test.

The reports deliberately remain separate from the bundled demo's Experiments view. The bundled demo measures stored workout counts, while this integration checks versions, mutation receipts and existing workout state. Treating those values as interchangeable would produce misleading comparisons.

Durations include local scheduling, database work, injected delay and backoff. They are not performance benchmarks. The report captures the scenario configuration and revision but does not reproduce every possible network or concurrency schedule.

## Reproduce

Follow the [integration instructions](../integrations/fitness/README.md). The entry point is `python integrations/fitness/start.py`, with `--postgres-bin` for an installed PostgreSQL distribution or the supplied Docker Compose database. The command emits a fresh report and exits nonzero on failure.
