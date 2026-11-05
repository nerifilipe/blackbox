# Fitness Tracker integration

Three reproducible experiments against the **unmodified FastAPI backend and real PostgreSQL**, pinned in [fixture.json](fixture.json). A Python test client sends HTTP requests through the compiled Blackbox proxy. It creates synthetic users, exercises, templates and workouts through the API, then checks database state independently.

## Run with installed PostgreSQL binaries

Requirements: a built Blackbox executable, Git, Python **3.14** (tested; minimum 3.12), PostgreSQL **18** binaries and internet for first setup. Run from the Blackbox repository root:

```powershell
python integrations/fitness/start.py --postgres-bin "C:\Program Files\PostgreSQL\18\bin"
```

The command checks out the pinned Fitness Tracker revision into `.blackbox/fitness-environment`, creates a virtual environment, installs its exact dependency lockfile, initializes a separate PostgreSQL cluster and runs the experiments. It does not use or stop an installed PostgreSQL service. The new cluster listens only on loopback, uses trust authentication for synthetic local data and stops after the run. Run as a normal user; PostgreSQL `initdb` refuses root on Unix.

Linux with PostgreSQL binaries installed:

```sh
python3 integrations/fitness/start.py --postgres-bin /usr/lib/postgresql/18/bin
```

## Run with Docker PostgreSQL

```sh
docker compose -f integrations/fitness/compose.yaml up -d --wait
python integrations/fitness/start.py
docker compose -f integrations/fitness/compose.yaml down
```

The runner connects to `127.0.0.1:55432` by default. For a different local test database, set `BLACKBOX_TEST_DATABASE_URL` to a `postgresql+psycopg://USER:PASSWORD@127.0.0.1:PORT/DATABASE` URL. The account needs permission to create schemas. URL query options and remote database hosts are rejected. Do not pass credentials on the command line.

Each run creates a random `blackbox_<uuid>` schema, applies the original Alembic migrations and seeds the original exercise catalogue. On success or an ordinary exception, it stops its HTTP processes and drops **only that schema**. A forced OS/process termination may leave an isolated schema or cluster behind; the report records whether cleanup completed. It never truncates another schema. Reports and logs remain available locally.

## Results

The command prints the path to a new `.blackbox/fitness-<timestamp>-<id>/report.html` and returns:

- **0:** all three cases and cleanup completed successfully.
- **1:** an invariant failed or setup/execution/cleanup could not complete.

Open `report.html` directly in a browser. It contains all assertions, PostgreSQL checkpoints, proxy metadata, exact scenario configurations and a **75-second walkthrough**. The adjacent `report.json` is machine-readable. These files require no external scripts, fonts or service.

| Experiment | Expected client observations | Independent database assertion |
| --- | --- | --- |
| Lost response | No HTTP response, then 200 on the identical retry | Version 2 and one mutation receipt already exist before retry; retry leaves state unchanged |
| Temporary 503 | 503, 503, 200 with bounded backoff | State unchanged after each 503; version increases once after success |
| Concurrent edit | Two requests start together; one gets 200, one gets 409 | One receipt and version 2; winning notes survive, exercise/set IDs preserved |

The lost-response case checks an upstream 200 paired with downstream status zero. A timeout alone cannot pass it. The 503 case also requires zero upstream status for the injected errors. The conflict case injects 300 ms of latency into one request; either device may win. It checks `workout_conflict`, not just any 409.

## Existing fixture checkout / CI

To reuse a clean checkout and a Python environment with its locked dependencies installed:

```sh
python integrations/fitness/run.py --fitness-repo PATH_TO_PINNED_CHECKOUT --out .blackbox/fitness-results
```

`--out` must be a new directory. `--blackbox PATH` selects another compiled executable. `--postgres-bin PATH` is also supported here. Setup errors are redacted; check the reported stage and local process logs for diagnosis. The harness checks both the Git revision and uncommitted backend changes before executing it. Update the lock and CI checkout together when intentionally upgrading the fixture.

```sh
python -m unittest discover -s integrations/fitness -p 'test_*.py' -v
python -m ruff check integrations/fitness
```

The main GitHub Actions workflow runs the same experiments against a PostgreSQL service and uploads the HTML/JSON report. A green historical workflow is not evidence that unpushed integration changes passed remote CI.

## Scope

- This exercises the **real backend with a Python test client**, not the React Native UI, its offline queue or its retry implementation.
- Retries reuse the exact JSON `mutation_id` and payload. Fitness Tracker does not use the bundled demo's `Idempotency-Key` header.
- Only transport failures and 502/503/504 are retryable here. A 409 terminates that attempt; the fixture does not silently merge a conflict.
- There is no synthetic “unsafe backend” or deliberately weakened application. A failing invariant produces a failed report.
- Authentication bodies/tokens and arbitrary request/response bodies are not included in reports. Test UUIDs and paths are included for correlation.
- External cases are exported separately; the console's **Experiments** view still lists bundled demo runs. Their metrics have different meanings.
- These bounded experiments are not a throughput benchmark or a proof over every possible interleaving.

See the [case study](../../docs/fitness-case-study.md) and [presentation script](../../docs/demo-script.md).
