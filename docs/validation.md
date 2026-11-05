# Validation record — 2026-11-05

This report describes checks actually run on the local Windows delivery. It does not imply that a remote CI workflow has run or that an external fitness application has been integrated.

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

The final Go coverage measurement was 68.8% of statements in `internal/lab` and 19.3% in `cmd/blackbox`. The command-line executable was additionally exercised outside that coverage run. Coverage is not a claim of exhaustive correctness.

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

The race detector was not run locally because a CGO C compiler was unavailable. The included Linux CI workflow configures `go test -race`; that workflow has not yet been run remotely. No load benchmark, real mobile-device test, WebSocket test or external Fitness Tracker integration is claimed.
