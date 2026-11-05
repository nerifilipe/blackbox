"""Prepare the pinned backend in .blackbox, then execute the three experiments."""

import argparse
import os
import subprocess
import sys
import venv
from pathlib import Path

from runtime import FIXTURE, verify_fixture


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--postgres-bin",
        type=Path,
        help="PostgreSQL bin directory; creates a disposable local cluster",
    )
    parser.add_argument("--out", type=Path, help="new report directory")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    binary = root / "dist" / ("blackbox.exe" if os.name == "nt" else "blackbox")
    if sys.version_info < (3, 12):
        parser.error("Python 3.12 or newer is required; Python 3.14 is the tested version")
    if not binary.is_file():
        parser.error("Build Blackbox first with scripts/build.ps1 or scripts/build.sh")
    home = root / ".blackbox" / "fitness-environment"
    home.mkdir(parents=True, exist_ok=True)
    repo, environment = home / "fitness-tracker", home / "venv"
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    if not repo.exists():
        subprocess.run(
            ["git", "clone", "--no-checkout", FIXTURE["repository"], str(repo)], check=True, env=env
        )
        subprocess.run(
            ["git", "-C", str(repo), "checkout", "--detach", FIXTURE["revision"]],
            check=True,
            env=env,
        )
    verify_fixture(repo)
    if not environment.exists():
        venv.create(environment, with_pip=True)
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-r",
            str(repo / "backend" / "requirements.lock"),
        ],
        check=True,
    )
    command = [str(python), str(Path(__file__).with_name("run.py")), "--fitness-repo", str(repo)]
    if args.postgres_bin:
        command.extend(["--postgres-bin", str(args.postgres_bin.resolve())])
    if args.out:
        command.extend(["--out", str(args.out.resolve())])
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
