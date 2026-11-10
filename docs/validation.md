# Validation record — 2026-11-05

This report records the original v0.1 Windows checks and the v0.2 update below. No external fitness application has been integrated.

## Environment

- Windows x64
- Go 1.27.3, downloaded from the official distribution and SHA-256 verified
- Node.js 24.14.0 and npm 11.9.0
- Real installed Chrome, controlled with Playwright
- SQLite through the pinned `modernc.org/sqlite` dependency

## Results

| Check | Result |
| --- | --- |
| TypeScript and Vite production build | Passed |
| `go test ./... -count=1 -cover` | Passed |
| `go vet ./...` | Passed |
| Windows executable build | Passed; embeds frontend assets |
| Desktop browser integration | 4 tests passed |
| Mobile viewport integration (390 × 844) | 4 tests passed |
| CLI unprotected experiment | Two attempts, two stored workouts, expected exit code 1 |
| CLI idempotent experiment | Two attempts, one stored workout, exit code 0 |
| CLI export | Valid scenario JSON written and read back |
| Executable restart with existing database | Events and last result retained; fault counters reset |
| Local proxy-loop validation | Loopback and localhost alias targets rejected |
| Help command | Exit code 0 |
| Screenshot inspection | Desktop and mobile layouts inspected |

The original v0.1 Go coverage measurement was 68.8% of statements in `internal/lab` and 19.3% in `cmd/blackbox`. The command-line executable was additionally exercised outside that coverage run. Coverage is not a claim of exhaustive correctness.

## Important behavior verified

- A lost response is a genuine connection abort, with client status zero and upstream status 201.
- An idempotent retry returns the original database row; an unprotected retry creates a duplicate.
- Exactly seven fault reservations are made when 100 concurrent requests compete for a budget of seven.
- Two injected 503 responses do not contact the upstream; the third request does.
- Cancelling a client during artificial latency prevents forwarding to the upstream.
- Headers, bodies and query strings pass through correctly but do not appear in recorded event metadata.
- Thirty simultaneous duplicate writes with the same key produce one row.
- Invalid scenarios do not replace the active scenario; cross-origin control requests are rejected.
- JSON import/export, editing validation, re-arming, navigation, filtering and request inspection work in the browser.
- The mobile page does not overflow horizontally; the request table has its own horizontal scroll area.

## Environment notes and limits

The initial Windows browser test runner completed all eight tests but waited during test-server teardown. The isolated server was stopped explicitly; the runner then exited successfully with `8 passed`. No user application process was stopped.

The final frontend build used `npm run build -- --configLoader native` to avoid an esbuild parent-directory lookup blocked by the managed sandbox. The normal build had also succeeded earlier. This changes how the Vite configuration is loaded, not the produced application features.

The race detector was not run locally because a CGO C compiler was unavailable. At the time of the original local delivery, the workflow had not run remotely. After publication, [GitHub Actions run 42016317235](https://github.com/nerifilipe/blackbox/actions/runs/42016317235) passed for commit `a14ba10`, including the Linux race detector, vet, executable build and browser tests. This remote result covers v0.1, not the subsequent local v0.2 changes. No load benchmark, real mobile-device test, WebSocket test or external Fitness Tracker integration is claimed.

## v0.2 local update — experiment history and comparison

The history update passed the TypeScript/Vite build, `go test ./... -count=1 -cover`, `go vet ./...` and the Windows executable build. Go coverage in `internal/lab` is now 70.6%; the CLI package remains at 19.3%.

All **14 Playwright tests passed**: seven on desktop and seven at the mobile viewport. The completed test server again required explicit shutdown in the managed Windows environment before the runner exited successfully.

Additional backend tests verify that recorded rules survive active-scenario changes and database reopening, old records remain readable, retention preserves the newest 100 results, expired IDs return 404, legacy configuration export returns 409, and exported configurations come from the selected run rather than current settings.

Browser tests exercise actual fragile/resilient runs, comparison and reversal, result downloads, reload persistence, restoration of the recorded rules and client mode, mismatched rules with identical scenario names, legacy behavior, search, responsive overflow, and the distinction between an unavailable history and an empty one. Desktop and mobile screenshots were inspected.

After publication, [GitHub Actions run 42074904477](https://github.com/nerifilipe/blackbox/actions/runs/42074904477) passed for v0.2 commit `ec9afbc`. This remote result predates v0.3.

## v0.3 — original Fitness Tracker backend

The integration was executed locally on Windows with Python 3.14.3, PostgreSQL 18.3, the rebuilt Blackbox 0.3.0 executable and original Fitness Tracker revision `fbb5b76610652045da4d080175d814f07cf87134`. Python dependencies came from that revision's exact `backend/requirements.lock`.

Three scenarios passed **42 assertions** in each successful execution:

- **Lost response:** the first attempt received no HTTP response while the proxy recorded upstream 200. A direct PostgreSQL read before retry found version 2 and one mutation receipt. The identical retry returned `applied_version = 2` and left persisted state unchanged.
- **Temporary errors:** the client observed 503, 503, 200. Both failures had upstream status zero and unchanged database snapshots. Only the final attempt produced a receipt and version increment.
- **Concurrent edits:** two clients started from a barrier with version 1 and distinct mutation IDs. One succeeded; the other received `workout_conflict` (409). Winning notes, exercise IDs and set IDs remained intact.

Both database modes were exercised: a cluster managed by `--postgres-bin`, and an existing local database supplied through `BLACKBOX_TEST_DATABASE_URL` (the CI path). An independent sentinel table in another schema retained its value after the existing-database run; no `blackbox_*` test schema remained. Owned test services stopped. The bootstrap entry point also completed with its own fixture checkout and virtual environment.

The [recorded JSON](evidence/fitness/report.json) contains rules, events, database checkpoints and every assertion. The [HTML report](evidence/fitness/report.html) presents the same evidence and embeds its JSON download. The silent WebM video was recorded from this report; it presents captured evidence rather than new requests executing in the browser.

Additional checks:

- **11 Python harness tests passed**, including false-positive controls for duplicate writes, upstream errors mistaken for dropped responses, forwarded 503s, writes during errors, unrelated conflicts and overwritten winners. Tests also cover report escaping, local destination restrictions, owned-process cleanup and failed setup exit/report behavior.
- Ruff passed for the integration code.
- TypeScript/Vite build, Go tests, `go vet` and Windows compilation passed. Backend coverage remained 70.6%; CLI coverage remained 19.3%.
- The **14 existing console browser tests passed**. The **four new report browser tests passed** on desktop/mobile, covering offline download, assertions, playback/pause/navigation and layout. The complete set contains 18 tests; after report fixes the four affected tests were rerun separately.
- Screenshots and recording slides were visually inspected. The presentation is checked at 1280 × 720 and the mobile viewport. All five recording slides fit without vertical overflow.

Environment notes: the sandbox's Windows certificate-store handling stalled pip during bootstrap. Setup completed using pip's `legacy-certs` option; certificate verification remained enabled. Git's OpenSSL backend was used for the sandbox checkout. Neither override changes the shipped defaults. As in earlier revisions, completed Playwright runs required explicit shutdown of their isolated server before the Windows runner exited.

Docker Compose was not run locally because Docker Desktop's daemon was unavailable. After publication, [GitHub Actions run 42082208879](https://github.com/nerifilipe/blackbox/actions/runs/42082208879) passed for v0.3. No mobile app, production database or remote user data was involved.

## Independent project check — 2026-11-10

The published v0.3.0 Windows archive was downloaded, checksum-verified and tested against unmodified typicode/JSON Server 0.17.4. Nine external API scenarios passed 62 assertions, plus five browser checks at each of two viewports. The batch launcher, embedded assets, CLI behavior and cleanup passed 15 additional checks in a directory containing spaces with development tools removed from the child PATH.

The main finding was a duplicate POST after a lost response despite a repeated Idempotency-Key header: the target does not implement that deduplication behavior. The tool correctly exposed the failed application invariant. An identical PUT preserved one resource's final state. No Blackbox source change was needed for these results.

See [the report, evidence and limitations](third-party-validation.md). The independent fixture and CI steps are new local changes; the earlier successful v0.3 workflow predates them.
