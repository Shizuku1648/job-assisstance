from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.batch_matching import match_job_batch
from app.config import get_settings
from app.database import Database


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: match_job_batch.py <job-batch.json>")

    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    jobs = payload.get("jobs", [])
    if not isinstance(jobs, list):
        raise SystemExit("jobs must be a list")

    settings = get_settings()
    result = match_job_batch(settings, Database(settings.database_path), jobs, max_workers=10)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
