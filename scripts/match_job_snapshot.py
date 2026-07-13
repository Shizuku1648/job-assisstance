from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.ai_service import AIService
from app.config import get_settings
from app.database import Database
from app.models import JobSnapshot
from app.salary import decode_boss_salary_text, salary_min_k


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: match_job_snapshot.py <job-snapshot.json>")

    snapshot_path = Path(sys.argv[1])
    payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    raw_job = payload["job"]
    settings = get_settings()
    db = Database(settings.database_path)
    profile = db.get_profile()

    job = JobSnapshot(
        title=raw_job.get("title", "").strip(),
        company=raw_job.get("company", "").strip(),
        salary=decode_boss_salary_text(raw_job.get("salary", "").strip()),
        city=raw_job.get("city", "").strip(),
        jd=decode_boss_salary_text(raw_job.get("jd", "").strip()),
        url=raw_job.get("url", "").strip(),
    )
    job_id = db.create_job(
        {
            "title": job.title,
            "company": job.company,
            "salary": job.salary,
            "city": job.city,
            "jd": job.jd,
            "url": job.url,
            "status": "pending",
        }
    )

    min_k = salary_min_k(job.salary)
    city_ok = any(city in job.city for city in profile.candidate_cities)
    salary_ok = min_k is not None and min_k >= profile.expected_salary_min_k

    try:
        if not city_ok or not salary_ok:
            result = {
                "job_id": job_id,
                "matched": False,
                "reason": f"规则过滤未通过：city_ok={city_ok}, salary_ok={salary_ok}, min_k={min_k}",
                "message": "",
                "salary_min_k": min_k,
                "city_ok": city_ok,
                "salary_ok": salary_ok,
            }
            db.update_job_match(
                job_id,
                ai_matched=False,
                ai_reason=result["reason"],
                ai_message="",
                status="rejected",
            )
        else:
            ai = AIService(settings)
            match = ai.match_job(profile, job)
            message = ai.generate_message(profile, job, match.reason) if match.matched else ""
            result = {
                "job_id": job_id,
                "matched": match.matched,
                "reason": match.reason,
                "message": message,
                "salary_min_k": min_k,
                "city_ok": city_ok,
                "salary_ok": salary_ok,
            }
            db.update_job_match(
                job_id,
                ai_matched=match.matched,
                ai_reason=match.reason,
                ai_message=message,
                status="matched" if match.matched else "rejected",
            )

        db.log_event(
            event_type="ai_match",
            page_url=job.url,
            page_title=job.title,
            action="match_job_snapshot",
            before_state=json.dumps({"snapshot": str(snapshot_path)}, ensure_ascii=False),
            after_state=json.dumps(result, ensure_ascii=False),
            success=True,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as exc:
        db.update_job_match(
            job_id,
            ai_matched=None,
            ai_reason="",
            ai_message="",
            status="error",
            error=str(exc),
        )
        db.log_event(
            event_type="ai_match_error",
            page_url=job.url,
            page_title=job.title,
            action="match_job_snapshot",
            before_state=json.dumps({"snapshot": str(snapshot_path)}, ensure_ascii=False),
            success=False,
            error=str(exc),
        )
        raise


if __name__ == "__main__":
    main()
