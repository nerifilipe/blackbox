"""Own only the processes and randomly named schema created for this experiment."""

import contextlib
import http.client
import json
import os
import secrets
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

HERE = Path(__file__).resolve().parent
FIXTURE = json.loads((HERE / "fixture.json").read_text(encoding="utf-8"))


def request(origin, method, path, payload=None, headers=None):
    """One connection, one attempt. No automatic retries, redirects or environment proxy."""
    url = urlsplit(origin)
    if url.scheme != "http" or url.hostname != "127.0.0.1":
        raise ValueError("experiment HTTP traffic must use local IPv4 HTTP")
    connection = http.client.HTTPConnection(url.hostname, url.port, timeout=12)
    sent_headers = {"Connection": "close", **(headers or {})}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode()
        sent_headers["Content-Type"] = "application/json"
    try:
        connection.request(method, path, body=body, headers=sent_headers)
        response = connection.getresponse()
        raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("response exceeds experiment limit")
        data = (
            json.loads(raw)
            if "application/json" in response.getheader("Content-Type", "")
            else None
        )
        return response.status, data
    except (OSError, http.client.HTTPException):
        return 0, None
    finally:
        connection.close()


def expect(origin, method, path, payload=None, headers=None, status=200):
    actual, data = request(origin, method, path, payload, headers)
    if actual != status:
        # Never include submitted credentials or arbitrary response bodies in errors.
        raise RuntimeError(f"{method} {path}: expected HTTP {status}, got {actual}")
    return data


def free_ports(count):
    with contextlib.ExitStack() as stack:
        sockets = [stack.enter_context(socket.socket()) for _ in range(count)]
        for sock in sockets:
            sock.bind(("127.0.0.1", 0))
        return [sock.getsockname()[1] for sock in sockets]


@contextlib.contextmanager
def process(command, log, cwd=None, env=None):
    with log.open("w", encoding="utf-8") as output:
        child = subprocess.Popen(
            list(map(str, command)),
            cwd=cwd,
            env=env,
            stdout=output,
            stderr=output,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            yield child
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=10)


def wait_http(origin, path, child):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError("experiment service exited; inspect its local log")
        status, _ = request(origin, "GET", path)
        if status == 200:
            return
        time.sleep(0.1)
    raise RuntimeError("experiment service did not become ready within 30 seconds")


def verify_fixture(repo):
    def git(*args):
        return subprocess.check_output(
            ["git", "-c", f"safe.directory={repo.as_posix()}", "-C", str(repo), *args],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()

    if git("rev-parse", "HEAD") != FIXTURE["revision"]:
        raise RuntimeError(f"Fitness Tracker must be checked out at {FIXTURE['revision']}")
    if git("status", "--porcelain", "--", "backend"):
        raise RuntimeError(
            "Fitness Tracker backend has local changes; use a clean fixture checkout"
        )


@contextlib.contextmanager
def postgres(bin_dir, output):
    """Optional disposable PostgreSQL cluster; never touches an installed service."""
    suffix = ".exe" if os.name == "nt" else ""

    def executable(name):
        return bin_dir / (name + suffix)

    data = Path("postgres-data")
    port = free_ports(1)[0]
    with (output / "postgres-init.log").open("w", encoding="utf-8") as log:
        subprocess.run(
            [
                str(executable("initdb")),
                "-D",
                str(data),
                "-U",
                "blackbox",
                "--auth=trust",
                "--encoding=UTF8",
                "--locale=C",
            ],
            stdout=log,
            stderr=log,
            check=True,
            timeout=90,
            cwd=output,
        )
    with process(
        [
            executable("postgres"),
            "-D",
            data,
            "-h",
            "127.0.0.1",
            "-p",
            port,
            "-c",
            "unix_socket_directories=",
        ],
        output / "postgres.log",
        cwd=output,
    ) as child:
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise RuntimeError("PostgreSQL exited; inspect postgres.log")
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=1):
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("PostgreSQL did not start")
            yield f"postgresql+psycopg://blackbox@127.0.0.1:{port}/postgres"
        finally:
            if child.poll() is None:
                subprocess.run(
                    [str(executable("pg_ctl")), "-D", str(data), "stop", "-m", "fast", "-w"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=20,
                    check=True,
                    cwd=output,
                )


@contextlib.contextmanager
def database(raw_url, repo):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url
    from sqlalchemy.orm import Session

    url = make_url(raw_url)
    if url.get_backend_name() != "postgresql" or url.host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("use a local PostgreSQL database for this fixture")
    if url.query:
        raise ValueError("database URL query options are not supported by this fixture")
    url = url.set(drivername="postgresql+psycopg")
    schema = "blackbox_" + uuid4().hex
    admin = create_engine(url, isolation_level="AUTOCOMMIT", connect_args={"connect_timeout": 3})
    scoped = create_engine(
        url, connect_args={"options": f"-csearch_path={schema}", "connect_timeout": 3}
    )
    created = False
    previous = {key: os.environ.get(key) for key in ("JWT_SECRET", "DATABASE_URL", "PGOPTIONS")}
    try:
        os.environ.update(
            JWT_SECRET=secrets.token_hex(32),
            DATABASE_URL=url.render_as_string(hide_password=False),
            PGOPTIONS=f"-csearch_path={schema}",
        )
        sys.path.insert(0, str(repo / "backend"))
        with admin.connect() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            created = True
        with scoped.begin() as connection:
            config = Config(str(repo / "backend" / "alembic.ini"))
            config.set_main_option("script_location", str(repo / "backend" / "migrations"))
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
        from app.modules.exercises.seed import seed_catalogue

        with Session(scoped) as session, session.begin():
            seed_catalogue(session)
        yield scoped, dict(os.environ)
    finally:
        scoped.dispose()
        try:
            if created:
                with admin.connect() as connection:
                    connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        finally:
            admin.dispose()
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
