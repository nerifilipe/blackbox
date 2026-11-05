# Architecture decisions

## One binary, three local listeners

The Go executable embeds the production React bundle. The control server, proxy and bundled demo are separate listeners, so proxy targets never share the control API namespace. An explicit target disables the bundled demo. Listeners bind only to loopback addresses.

The module uses the standard HTTP reverse proxy and `modernc.org/sqlite` via `database/sql`. SQLite uses WAL with one database connection, serializing local writes without requiring CGO. Fault-budget reservation is independent of database access.

## Fault engine

Scenarios are versioned JSON. Every rule has an ID, method, exact path, kind, enabled flag and a positive budget (`limit`). The first eligible rule wins. A mutex protects rule iteration and budget reservation together; a check-then-increment outside that lock would over-inject under concurrent traffic.

An injected HTTP error occurs before forwarding. A latency timer runs after bounded request-body reading, so the HTTP server can detect a client disconnect during the delay. A response drop occurs in `ReverseProxy.ModifyResponse`, after an upstream response has arrived. The standard `http.ErrAbortHandler` sentinel closes the downstream connection without emitting a synthetic 500 response.

The event is saved in a deferred function even when the reverse proxy aborts the connection. A stored event distinguishes downstream `status` (zero means no status was emitted) and `upstreamStatus`. Errors writing metadata are logged; they do not retroactively change an already-delivered response.

Rule budgets are consumed at admission. Cancellation still consumes the reserved fault. New scenario versions and re-arming apply to future admissions; an in-flight request retains its selected rule. Counters reset on process restart. The scenario itself is persisted.

## Bounded request handling

The proxy buffers request bodies up to 4 MiB and uses deadlines. This simplifies cancellation semantics and provides a deliberate API-only scope. It does not claim transparent support for all HTTP streaming semantics. Headers and payloads are forwarded but not copied to the history database; query strings are forwarded but omitted from recorded paths.

The proxy transport and demonstration client disable persistent connections. This avoids hidden automatic retries when a request has an idempotency key and a reused connection fails. Requests are retried only by the explicit demo loop, so the visible attempt sequence matches the experiment.

## Demonstration oracle

Every run receives a cryptographically random ID. Workout rows are grouped by that ID, giving each run an empty logical dataset without deleting unrelated state. The fragile client sends no idempotency key. The resilient client reuses one key for every attempt.

SQLite enforces a unique request key. `INSERT ... ON CONFLICT DO NOTHING` makes simultaneous duplicate requests safe. A repeated key with a different run ID is rejected. The only demo payload is the run ID; a production API would also need a canonical request-payload fingerprint and a documented key-retention policy.

The pass condition requires both a successful client response and exactly one stored workout. Three failed attempts with zero writes do not pass. The CLI exits with status 1 on a failed assertion, even though the experiment itself ran successfully.

A mutex prevents overlapping demo runs and scenario mutations through the control API. External requests are not blocked by that lock; they share the proxy budgets, which is documented. Experiments should run without competing traffic.

## Persistence and recovery

SQLite stores the current scenario, request metadata, completed experiment results and synthetic demo rows. Retention is bounded to 5,000 request events and 100 results. Demo rows outside the retained completed runs are cleaned after a run. The UI reads 200 events and the latest result.

An interrupted demo may leave synthetic rows without a completed result until a later run cleans them. In-flight requests do not survive process termination. No exactly-once delivery claim is made for arbitrary systems.

## Control surface

JSON mutation endpoints reject unknown fields and oversized documents. Scenarios are validated before storage and activation. Host, Origin and Fetch Metadata checks protect the unauthenticated loopback control surface from cross-site browser requests. A strict production content policy allows same-origin scripts and disallows framing.

`PUT /api/scenario` changes settings; `POST /api/scenario/reset` resets counters; `POST /api/demo/run` performs the bundled experiment. State and export use GET. The CLI connects only to a loopback control URL.

## Intentional scope boundaries

The application is a local HTTP failure lab, with a reproducible fixture and a visual explanation of actual outcomes. It does not snapshot external databases, capture request bodies, reconstruct arbitrary user sessions or offer deterministic distributed-system replay.

Useful future work includes a general assertion runner, external fixture integration, measured proxy overhead, history comparison and separate WebSocket semantics. Those features should be added with explicit recovery and correctness tests.
