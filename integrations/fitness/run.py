"""Reproduce three real Fitness Tracker failures through the compiled Blackbox proxy."""

import argparse
import contextlib
import os
import platform
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from threading import Barrier
from uuid import uuid4

from report import write_report
from runtime import (
    FIXTURE,
    database,
    expect,
    free_ports,
    postgres,
    process,
    request,
    verify_fixture,
    wait_http,
)

ROOT = Path(__file__).resolve().parents[2]
API = "/api/v1/workouts"


def check(case, name, actual, expected):
    case["checks"].append(
        {"name": name, "actual": actual, "expected": expected, "passed": actual == expected}
    )


def snapshot(engine, workout_id):
    from sqlalchemy import text

    with engine.connect() as connection:
        row = (
            connection.execute(
                text("""
            SELECT version, notes,
              (SELECT count(*) FROM workout_mutations WHERE workout_id = :id) AS mutations,
              (SELECT count(*) FROM workout_exercises WHERE workout_id = :id) AS exercises,
              (SELECT count(*) FROM workout_sets s JOIN workout_exercises e
                ON e.id = s.workout_exercise_id WHERE e.workout_id = :id) AS sets
            FROM workouts WHERE id = :id
        """),
                {"id": workout_id},
            )
            .mappings()
            .one()
        )
        return dict(row)


def setup_workout(upstream):
    from app.modules.exercises.seed import stable_id

    token = expect(
        upstream,
        "POST",
        "/api/v1/auth/register",
        {
            "display_name": "Blackbox fixture",
            "email": f"{uuid4().hex}@example.com",
            "password": "local-fixture-" + uuid4().hex,
        },
        status=201,
    )["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    exercise = expect(
        upstream,
        "POST",
        "/api/v1/exercises",
        {
            "name": "Blackbox press",
            "equipment": "dumbbell",
            "load_type": "external",
            "load_convention": "per_hand",
            "primary_muscle_id": str(stable_id("muscle", "chest")),
            "secondary_muscle_ids": [],
            "instructions": "Synthetic integration fixture",
        },
        headers,
        201,
    )
    template = expect(
        upstream,
        "POST",
        "/api/v1/workout-templates",
        {
            "name": "Blackbox fixture",
            "exercises": [
                {
                    "exercise_id": exercise["id"],
                    "rest_seconds": 90,
                    "sets": [
                        {
                            "set_type": "working",
                            "target_reps_min": 8,
                            "target_reps_max": 12,
                            "target_weight_kg": "20.000",
                            "target_rir": 2,
                        }
                    ],
                }
            ],
        },
        headers,
        201,
    )
    workout = expect(
        upstream,
        "POST",
        API,
        {
            "id": str(uuid4()),
            "template_id": template["id"],
            "template_version": template["version"],
        },
        headers,
        201,
    )
    return headers, workout


def mutation(workout, note):
    return {
        "version": workout["version"],
        "mutation_id": str(uuid4()),
        "status": "active",
        "paused_at": None,
        "paused_seconds": 0,
        "finished_at": None,
        "rest_deadline": None,
        "notes": note,
        "exercises": [
            {
                "id": e["id"],
                "exercise_id": e["exercise_id"],
                "rest_seconds": e["rest_seconds"],
                "notes": e["notes"],
                "sets": [
                    {
                        k: s[k]
                        for k in ("id", "set_type", "weight_kg", "reps", "rir", "completed_at")
                    }
                    for s in e["sets"]
                ],
            }
            for e in workout["exercises"]
        ],
    }


def shape(workout):
    return [(e["id"], [s["id"] for s in e["sets"]]) for e in workout["exercises"]]


def scenario(name, path, kind, limit=1, status=0, delay=0):
    return {
        "version": 1,
        "name": name,
        "description": "Fitness Tracker integration fixture",
        "rules": [
            {
                "id": "fixture-fault",
                "name": name,
                "method": "PUT",
                "path": path,
                "kind": kind,
                "limit": limit,
                "status": status,
                "delayMs": delay,
                "enabled": True,
            }
        ],
    }


def attempt(proxy, path, headers, body, label):
    start = time.monotonic()
    status, response = request(proxy, "PUT", path, body, headers)
    return {
        "label": label,
        "status": status,
        "outcome": "transport_error" if status == 0 else "http_response",
        "durationMs": round((time.monotonic() - start) * 1000, 2),
        "appliedVersion": response.get("applied_version") if isinstance(response, dict) else None,
        "errorCode": response.get("error", {}).get("code") if isinstance(response, dict) else None,
    }


def events_for(control, run_id, count):
    deadline = time.monotonic() + 3
    while True:
        state = expect(control, "GET", "/api/state")
        events = sorted((e for e in state["events"] if e["runId"] == run_id), key=lambda e: e["id"])
        if len(events) >= count or time.monotonic() > deadline:
            return events
        time.sleep(0.05)


def evaluate(case):
    """Fail closed: client success alone is never proof of the fault or database outcome."""
    case["checks"] = []
    attempts, events, states = case["attempts"], case["events"], case["states"]
    initial, final = states[0]["database"], states[-1]["database"]
    statuses = [a["status"] for a in attempts]
    check(case, "Fresh workout starts at version 1", initial["version"], 1)
    check(case, "Fresh workout has no mutation receipts", initial["mutations"], 0)
    check(case, "Exactly one version increment", final["version"] - initial["version"], 1)
    check(case, "Exactly one mutation receipt", final["mutations"], 1)
    check(case, "One exercise remains", final["exercises"], 1)
    check(case, "One set remains", final["sets"], 1)
    check(case, "Exercise and set IDs preserved", case["idsPreserved"], True)
    check(case, "All client attempts have proxy evidence", len(events), len(attempts))
    check(
        case,
        "Acknowledged mutation was applied at version 2",
        [a["appliedVersion"] for a in attempts if a["status"] == 200],
        [2],
    )
    if case["id"] == "lost-response":
        check(case, "Lost response followed by successful retry", statuses, [0, 200])
        check(
            case,
            "First response was dropped after upstream HTTP 200",
            [(e["status"], e["upstreamStatus"], e["outcome"]) for e in events],
            [(0, 200, "response_dropped"), (200, 200, "forwarded")],
        )
        check(case, "Commit exists before retry", states[1]["database"]["version"], 2)
        check(case, "Retry does not change persisted data", final, states[1]["database"])
        check(case, "Original change is preserved", final["notes"], "lost-response change")
    elif case["id"] == "temporary-503":
        check(case, "Two failures followed by success", statuses, [503, 503, 200])
        check(
            case,
            "503s never contacted upstream",
            [(e["status"], e["upstreamStatus"], e["outcome"]) for e in events],
            [(503, 0, "error_injected"), (503, 0, "error_injected"), (200, 200, "forwarded")],
        )
        for state in states[1:3]:
            check(case, state["label"] + ": database unchanged", state["database"], initial)
        check(case, "Change eventually persisted", final["notes"], "temporary-503 change")
    elif case["id"] == "concurrent-edit":
        check(case, "One concurrent edit accepted and one rejected", sorted(statuses), [200, 409])
        check(
            case,
            "Conflict is specifically a stale version",
            [a["errorCode"] for a in attempts if a["status"] == 409],
            ["workout_conflict"],
        )
        winners = [a["label"] for a in attempts if a["status"] == 200]
        check(case, "Winning edit is preserved", [final["notes"]], winners)
        check(
            case,
            "Latency was injected exactly once",
            sum(e["fault"] == "latency" for e in events),
            1,
        )
        check(
            case,
            "Both requests reached upstream",
            sorted((e["status"], e["upstreamStatus"]) for e in events),
            [(200, 200), (409, 409)],
        )
    else:
        check(case, "Recognized experiment", case["id"], "a supported scenario ID")
    case["passed"] = all(c["passed"] for c in case["checks"])


def run_case(kind, engine, upstream, proxy, control):
    names = {
        "lost-response": "The server saved. The client never knew.",
        "temporary-503": "Two failures. One successful change.",
        "concurrent-edit": "Two devices. One accepted version.",
    }
    headers, workout = setup_workout(upstream)
    path, run_id = API + "/" + workout["id"], str(uuid4())
    headers["X-Blackbox-Run"] = run_id
    case = {
        "id": kind,
        "name": names[kind],
        "runId": run_id,
        "attempts": [],
        "states": [],
        "checks": [],
    }

    def capture(label):
        case["states"].append({"label": label, "database": snapshot(engine, workout["id"])})

    sc = (
        scenario(names[kind], path, "drop_response")
        if kind == "lost-response"
        else scenario(names[kind], path, "http_error", limit=2, status=503)
        if kind == "temporary-503"
        else scenario(names[kind], path, "latency", delay=300)
    )
    case["scenario"] = sc
    expect(control, "PUT", "/api/scenario", sc)
    capture("Before requests")
    start = time.monotonic()
    body = mutation(workout, kind + " change")
    if kind == "concurrent-edit":
        barrier = Barrier(2)

        def send(label):
            change = deepcopy(body)
            change.update(mutation_id=str(uuid4()), notes=label)
            barrier.wait(timeout=10)
            return attempt(proxy, path, headers, change, label)

        with ThreadPoolExecutor(max_workers=2) as pool:
            case["attempts"] = list(pool.map(send, ("device-A", "device-B")))
    else:
        maximum = 2 if kind == "lost-response" else 3
        for index in range(maximum):
            result = attempt(proxy, path, headers, body, f"Attempt {index + 1}")
            case["attempts"].append(result)
            capture(f"After attempt {index + 1}")
            if result["status"] not in {0, 502, 503, 504}:
                break
            if index + 1 < maximum:
                time.sleep(0.15 * (2**index))
    capture("Final state")
    current = expect(upstream, "GET", path, headers=headers)
    case["idsPreserved"] = shape(current) == shape(workout)
    case["events"] = events_for(control, run_id, len(case["attempts"]))
    case["durationMs"] = round((time.monotonic() - start) * 1000, 2)
    evaluate(case)
    return case


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fitness-repo", type=Path, required=True, help="clean checkout at fixture.json revision"
    )
    parser.add_argument(
        "--blackbox",
        type=Path,
        default=ROOT / "dist" / ("blackbox.exe" if os.name == "nt" else "blackbox"),
    )
    parser.add_argument(
        "--postgres-bin",
        type=Path,
        help="create a disposable PostgreSQL cluster using these binaries",
    )
    parser.add_argument("--out", type=Path, help="new output directory (must not already exist)")
    args = parser.parse_args()
    output = (
        args.out
        or ROOT
        / ".blackbox"
        / ("fitness-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid4().hex[:6])
    ).resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {
        "schemaVersion": 1,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "fixture": FIXTURE,
        "blackboxVersion": None,
        "pythonVersion": platform.python_version(),
        "cases": [],
        "passed": False,
        "cleanupCompleted": False,
        "stage": "verify fixture",
    }
    try:
        repo, binary = args.fitness_repo.resolve(), args.blackbox.resolve()
        verify_fixture(repo)
        report["blackboxVersion"] = subprocess.check_output(
            [str(binary), "version"], text=True
        ).strip()
        db_url = os.environ.get(
            "BLACKBOX_TEST_DATABASE_URL",
            "postgresql+psycopg://blackbox:blackbox_local@127.0.0.1:55432/blackbox",
        )
        cluster = (
            postgres(args.postgres_bin.resolve(), output)
            if args.postgres_bin
            else contextlib.nullcontext(db_url)
        )
        report["stage"] = "start PostgreSQL and migrate isolated schema"
        with cluster as url, database(url, repo) as (engine, env):
            from sqlalchemy import text

            with engine.connect() as connection:
                report["postgresVersion"] = connection.scalar(text("SHOW server_version"))
            api_port, proxy_port, ui_port = free_ports(3)
            upstream, proxy, control = [
                f"http://127.0.0.1:{p}" for p in (api_port, proxy_port, ui_port)
            ]
            report["stage"] = "start API and proxy"
            with process(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "app.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    api_port,
                ],
                output / "fitness.log",
                cwd=repo / "backend",
                env=env,
            ) as api:
                wait_http(upstream, "/api/v1/ready", api)
                with process(
                    [
                        binary,
                        "serve",
                        "-target",
                        upstream,
                        "-ui",
                        f"127.0.0.1:{ui_port}",
                        "-proxy",
                        f"127.0.0.1:{proxy_port}",
                        "-db",
                        output / "history.db",
                    ],
                    output / "blackbox.log",
                ) as box:
                    wait_http(control, "/api/state", box)
                    for kind in ("lost-response", "temporary-503", "concurrent-edit"):
                        report["stage"] = kind
                        case = run_case(kind, engine, upstream, proxy, control)
                        report["cases"].append(case)
                        print(
                            f"{'PASS' if case['passed'] else 'FAIL'}  {kind}: "
                            f"{sum(c['passed'] for c in case['checks'])}/{len(case['checks'])} assertions",
                            flush=True,
                        )
                        write_report(output, report)
        report["cleanupCompleted"] = True
        report["stage"] = "complete"
        report["passed"] = len(report["cases"]) == 3 and all(c["passed"] for c in report["cases"])
    except Exception as exc:
        # Database/HTTP exception strings can contain credentials. Keep shared reports redacted.
        report["error"] = {
            "type": type(exc).__name__,
            "message": "Experiment could not complete. Check dependencies, fixture revision and local service logs.",
        }
        print(
            f"ERROR during {report['stage']}: {type(exc).__name__}. Check dependencies and logs in {output}",
            file=sys.stderr,
        )
    finally:
        write_report(output, report)
    print(f"Report: {output / 'report.html'}", flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
