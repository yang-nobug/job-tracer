from __future__ import annotations

import importlib.metadata
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


REQUIRED = {
    "fastapi": "0.115.6",
    "httpx": "0.28.1",
    "langgraph": "1.1.2",
    "langgraph-checkpoint-sqlite": "3.1.1",
    "pydantic": "2.10.4",
    "uvicorn": "0.34.0",
}


def main() -> int:
    if sys.version_info < (3, 11) or sys.version_info >= (3, 13):
        print(
            f"[prep-agent] Python {sys.version.split()[0]} is unsupported; use Python 3.11 or 3.12.",
            file=sys.stderr,
        )
        return 21
    mismatches: list[str] = []
    for package, expected in REQUIRED.items():
        try:
            actual = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            mismatches.append(f"{package} missing")
            continue
        if actual != expected:
            mismatches.append(f"{package}={actual}, expected {expected}")
    if mismatches:
        print("[prep-agent] Python dependencies need installation:", file=sys.stderr)
        for mismatch in mismatches:
            print(f"  - {mismatch}", file=sys.stderr)
        return 20
    try:
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver  # noqa: F401
        from agent_service.main import app  # noqa: F401
    except Exception as error:
        print(f"[prep-agent] Import check failed: {error}", file=sys.stderr)
        return 22
    print(f"[prep-agent] Python {sys.version.split()[0]} dependencies OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
