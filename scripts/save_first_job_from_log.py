from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings
from app.database import Database
from app.salary import decode_boss_salary_text


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: save_first_job_from_log.py <first-job-read.json>")

    log_path = Path(sys.argv[1])
    payload = json.loads(log_path.read_text(encoding="utf-8"))
    job = payload["data"]["firstJob"]
    db = Database(get_settings().database_path)
    decoded_salary = decode_boss_salary_text(job.get("salary", ""))
    decoded_jd = decode_boss_salary_text(job.get("jd", ""))
    job_id = db.create_job(
        {
            "title": job.get("title", ""),
            "company": job.get("company", ""),
            "salary": decoded_salary,
            "city": job.get("city", ""),
            "jd": decoded_jd,
            "url": job.get("url", ""),
            "status": "pending",
        }
    )
    db.log_event(
        event_type="first_job_read",
        page_url=payload["after"].get("url", ""),
        page_title=payload["after"].get("title", ""),
        action="cdp_runtime_read_first_job",
        after_state=json.dumps({"job_id": job_id, "log": str(log_path)}, ensure_ascii=False),
        success=bool(payload.get("safe")),
    )
    print(job_id)


if __name__ == "__main__":
    main()
