from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import ROOT_DIR, get_settings


AI_EVENT_TYPES = (
    "ai_match",
    "ai_match_batch",
    "ai_match_error",
    "ai_match_skipped",
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Delete stale AI decisions for jobs that were never contacted.")
    parser.add_argument("--apply", action="store_true", help="Apply the cleanup after creating a database backup.")
    args = parser.parse_args()

    database_path = get_settings().database_path
    with sqlite3.connect(database_path) as conn:
        stale_jobs = conn.execute(
            "select count(*) from jobs where contacted_at is null and status <> 'contacted'"
        ).fetchone()[0]
        contacted_jobs = conn.execute(
            "select count(*) from jobs where contacted_at is not null or status = 'contacted'"
        ).fetchone()[0]
        stale_events = conn.execute(
            f"select count(*) from run_logs where event_type in ({','.join('?' for _ in AI_EVENT_TYPES)})",
            AI_EVENT_TYPES,
        ).fetchone()[0]

    result: dict[str, object] = {
        "database_path": str(database_path),
        "stale_jobs": stale_jobs,
        "contacted_jobs_preserved": contacted_jobs,
        "stale_ai_events": stale_events,
        "applied": False,
    }
    if not args.apply:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = ROOT_DIR / "runtime" / f"job_assistance-before-uncontacted-reset-{timestamp}.db"
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_path) as source, sqlite3.connect(backup_path) as backup:
        source.backup(backup)

    with sqlite3.connect(database_path) as conn:
        deleted_jobs = conn.execute(
            "delete from jobs where contacted_at is null and status <> 'contacted'"
        ).rowcount
        deleted_events = conn.execute(
            f"delete from run_logs where event_type in ({','.join('?' for _ in AI_EVENT_TYPES)})",
            AI_EVENT_TYPES,
        ).rowcount

    result.update(
        {
            "backup_path": str(backup_path),
            "deleted_jobs": deleted_jobs,
            "deleted_ai_events": deleted_events,
            "applied": True,
        }
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
