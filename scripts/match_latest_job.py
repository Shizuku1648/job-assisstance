from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.ai_service import AIService
from app.config import get_settings
from app.database import Database
from app.models import JobSnapshot
from app.salary import salary_range_k, salary_ranges_overlap


def main() -> None:
    settings = get_settings()
    db = Database(settings.database_path)
    profile = db.get_profile()
    jobs = db.list_jobs(page_size=1)["items"]
    if not jobs:
        raise SystemExit("No jobs found")

    row = jobs[0]
    salary_range = salary_range_k(row["salary"])
    min_k, max_k = salary_range if salary_range else (None, None)
    city_ok = any(city in row["city"] for city in profile.candidate_cities)
    salary_ok = salary_ranges_overlap(
        row["salary"],
        profile.expected_salary_min_k,
        profile.expected_salary_max_k,
    )
    job = JobSnapshot(
        title=row["title"],
        company=row["company"],
        salary=row["salary"],
        city=row["city"],
        jd=row["jd"],
        url=row["url"],
    )

    if not city_ok or not salary_ok:
        result = {
            "job_id": row["id"],
            "matched": False,
            "reason": (
                "规则过滤未通过："
                f"city_ok={city_ok}, salary_ok={salary_ok}, "
                f"job_salary={min_k}-{max_k}, "
                f"expected_salary={profile.expected_salary_min_k}-{profile.expected_salary_max_k}"
            ),
            "message": "",
        }
    else:
        ai = AIService(settings)
        match = ai.match_job(profile, job)
        message = ai.generate_message(profile, job, match.reason) if match.matched else ""
        result = {
            "job_id": row["id"],
            "matched": match.matched,
            "reason": match.reason,
            "message": message,
            "salary_min_k": min_k,
            "salary_max_k": max_k,
            "city_ok": city_ok,
            "salary_ok": salary_ok,
        }

    db.log_event(
        event_type="ai_match",
        page_url=row["url"],
        page_title=row["title"],
        action="match_latest_job",
        after_state=json.dumps(result, ensure_ascii=False),
        success=True,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
