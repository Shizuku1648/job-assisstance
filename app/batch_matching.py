from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from app.ai_service import AIService
from app.config import Settings
from app.database import Database
from app.models import JobSnapshot, UserProfile
from app.salary import decode_boss_salary_text, salary_range_k, salary_ranges_overlap


def _job_from_raw(raw: dict[str, Any]) -> JobSnapshot:
    return JobSnapshot(
        title=str(raw.get("title", "")).strip(),
        company=str(raw.get("company", "")).strip(),
        salary=decode_boss_salary_text(str(raw.get("salary", "")).strip()),
        city=str(raw.get("city", "")).strip(),
        jd=decode_boss_salary_text(str(raw.get("jd", "")).strip()),
        url=str(raw.get("url", "")).strip(),
    )


def _run_match(settings: Settings, profile: UserProfile, job: JobSnapshot) -> tuple[bool, str]:
    result = AIService(settings).match_job(profile, job)
    return result.matched, result.reason


def _run_message(settings: Settings, profile: UserProfile, job: JobSnapshot, reason: str) -> str:
    return AIService(settings).generate_message(profile, job, reason)


def match_job_batch(
    settings: Settings,
    db: Database,
    raw_jobs: list[dict[str, Any]],
    *,
    max_workers: int = 10,
) -> dict[str, Any]:
    profile = db.get_profile()
    worker_limit = max(1, min(max_workers, 10, len(raw_jobs) or 1))
    results: list[dict[str, Any] | None] = [None] * len(raw_jobs)
    jobs: dict[int, JobSnapshot] = {}
    match_tasks: list[tuple[int, int, JobSnapshot]] = []
    message_tasks: list[tuple[int, int, JobSnapshot, str]] = []

    for index, raw in enumerate(raw_jobs):
        job = _job_from_raw(raw)
        jobs[index] = job
        existing = db.find_latest_job_by_url(job.url)
        if existing and existing.get("status") in {"contacted", "rejected", "matched"}:
            status = str(existing.get("status", ""))
            if status == "matched":
                result = {
                    "input_index": index,
                    "job_id": int(existing["id"]),
                    "url": job.url,
                    "title": job.title,
                    "matched": True,
                    "reason": str(existing.get("ai_reason", "")),
                    "message": str(existing.get("ai_message", "")),
                    "prepared": True,
                    "ready": bool(existing.get("ai_message")),
                }
                results[index] = result
                if not result["ready"]:
                    message_tasks.append((index, int(existing["id"]), job, result["reason"]))
            else:
                results[index] = {
                    "input_index": index,
                    "job_id": int(existing["id"]),
                    "url": job.url,
                    "title": job.title,
                    "matched": False,
                    "skipped": True,
                    "ready": False,
                    "reason": f"岗位 URL 已处理过，跳过：status={status}",
                    "message": "",
                }
            continue

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
        salary_range = salary_range_k(job.salary)
        min_k, max_k = salary_range if salary_range else (None, None)
        city_ok = any(city in job.city for city in profile.candidate_cities)
        salary_ok = salary_ranges_overlap(
            job.salary,
            profile.expected_salary_min_k,
            profile.expected_salary_max_k,
        )
        if not city_ok or not salary_ok:
            reason = (
                "规则过滤未通过："
                f"city_ok={city_ok}, salary_ok={salary_ok}, "
                f"job_salary={min_k}-{max_k}, "
                f"expected_salary={profile.expected_salary_min_k}-{profile.expected_salary_max_k}"
            )
            db.update_job_match(
                job_id,
                ai_matched=False,
                ai_reason=reason,
                ai_message="",
                status="rejected",
            )
            results[index] = {
                "input_index": index,
                "job_id": job_id,
                "url": job.url,
                "title": job.title,
                "matched": False,
                "ready": False,
                "reason": reason,
                "message": "",
                "salary_min_k": min_k,
                "salary_max_k": max_k,
                "city_ok": city_ok,
                "salary_ok": salary_ok,
            }
            continue

        match_tasks.append((index, job_id, job))
        results[index] = {
            "input_index": index,
            "job_id": job_id,
            "url": job.url,
            "title": job.title,
            "matched": False,
            "ready": False,
            "reason": "",
            "message": "",
            "salary_min_k": min_k,
            "salary_max_k": max_k,
            "city_ok": city_ok,
            "salary_ok": salary_ok,
        }

    if match_tasks:
        with ThreadPoolExecutor(max_workers=min(worker_limit, len(match_tasks))) as executor:
            future_items = {
                executor.submit(_run_match, settings, profile, job): (index, job_id, job)
                for index, job_id, job in match_tasks
            }
            for future in as_completed(future_items):
                index, job_id, job = future_items[future]
                result = results[index]
                assert result is not None
                try:
                    matched, reason = future.result()
                    result["matched"] = matched
                    result["reason"] = reason
                    db.update_job_match(
                        job_id,
                        ai_matched=matched,
                        ai_reason=reason,
                        ai_message="",
                        status="matched" if matched else "rejected",
                    )
                    if matched:
                        message_tasks.append((index, job_id, job, reason))
                except Exception as exc:
                    result["error"] = str(exc)
                    result["reason"] = f"AI 匹配失败：{exc}"
                    db.update_job_match(
                        job_id,
                        ai_matched=None,
                        status="error",
                        error=str(exc),
                    )

    if message_tasks:
        with ThreadPoolExecutor(max_workers=min(worker_limit, len(message_tasks))) as executor:
            future_items = {
                executor.submit(_run_message, settings, profile, job, reason): (index, job_id)
                for index, job_id, job, reason in message_tasks
            }
            for future in as_completed(future_items):
                index, job_id = future_items[future]
                result = results[index]
                assert result is not None
                try:
                    message = future.result()
                    result["message"] = message
                    result["ready"] = True
                    db.update_job_match(
                        job_id,
                        ai_matched=True,
                        ai_reason=str(result["reason"]),
                        ai_message=message,
                        status="matched",
                    )
                except Exception as exc:
                    result["ready"] = False
                    result["message_error"] = str(exc)
                    db.update_job_match(
                        job_id,
                        ai_matched=True,
                        ai_reason=str(result["reason"]),
                        ai_message="",
                        status="matched",
                        error=str(exc),
                    )

    final_results = [result for result in results if result is not None]
    for result in final_results:
        db.log_event(
            event_type="ai_match_batch",
            page_url=str(result.get("url", "")),
            page_title=str(result.get("title", "")),
            action="match_job_batch",
            after_state=json.dumps(result, ensure_ascii=False),
            success=not bool(result.get("error")),
            error=str(result.get("error", "")),
        )

    return {
        "batch_size": len(raw_jobs),
        "worker_limit": worker_limit,
        "matched_count": sum(1 for result in final_results if result.get("matched")),
        "ready_count": sum(1 for result in final_results if result.get("ready")),
        "results": final_results,
    }
