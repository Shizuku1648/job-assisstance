from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings
from app.database import Database


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: mark_job_contacted.py <job_id>")
    job_id = int(sys.argv[1])
    Database(get_settings().database_path).mark_job_contacted(job_id)
    print(job_id)


if __name__ == "__main__":
    main()
