from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from app.ai_service import AIService
from app.automation.boss_worker import BossWorker
from app.config import ROOT_DIR, get_settings
from app.contact_quota import get_contact_quota
from app.database import Database
from app.models import JobSnapshot, UserProfile


STATIC_DIR = ROOT_DIR / "app" / "static"
REPOSITORY_URL = "https://github.com/Shizuku1648/job-assisstance"


class ProfileIn(BaseModel):
    expected_salary_min_k: int = Field(ge=1)
    expected_salary_max_k: int = Field(ge=1)
    candidate_cities: list[str] = Field(min_length=1)
    description: str = Field(min_length=10)

    @model_validator(mode="after")
    def validate_salary_range(self) -> "ProfileIn":
        if self.expected_salary_max_k < self.expected_salary_min_k:
            raise ValueError("期望薪资最大值不能小于最小值")
        return self


class JobMatchIn(BaseModel):
    title: str
    company: str = ""
    salary: str = ""
    city: str = ""
    jd: str
    url: str = ""


def create_app() -> FastAPI:
    settings = get_settings()
    db = Database(settings.database_path)
    worker = BossWorker(settings, db)
    ai_service = AIService(settings)

    app = FastAPI(title="Job Assistance")
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/", response_class=FileResponse)
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/profile")
    async def get_profile() -> dict[str, object]:
        profile = db.get_profile()
        return {
            "expected_salary_min_k": profile.expected_salary_min_k,
            "expected_salary_max_k": profile.expected_salary_max_k,
            "candidate_cities": profile.candidate_cities,
            "description": profile.description,
        }

    @app.post("/api/profile")
    async def save_profile(payload: ProfileIn) -> dict[str, bool]:
        db.save_profile(
            UserProfile(
                expected_salary_min_k=payload.expected_salary_min_k,
                expected_salary_max_k=payload.expected_salary_max_k,
                candidate_cities=[city.strip() for city in payload.candidate_cities if city.strip()],
                description=payload.description.strip(),
            )
        )
        return {"ok": True}

    @app.get("/api/status")
    async def status() -> dict[str, object]:
        return worker.status.as_dict()

    @app.get("/api/contact-quota")
    async def contact_quota() -> dict[str, object]:
        return get_contact_quota(db, settings.daily_contact_limit)

    @app.get("/api/repository")
    async def repository() -> dict[str, str]:
        return {"url": REPOSITORY_URL}

    @app.post("/api/browser/open-login")
    async def open_login() -> dict[str, object]:
        try:
            page_info = await worker.open_login()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return {"ok": True, "page": page_info, "status": worker.status.as_dict()}

    @app.post("/api/browser/save-auth")
    async def save_auth() -> dict[str, object]:
        try:
            page_info = await worker.save_auth_state()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return {"ok": True, "page": page_info, "status": worker.status.as_dict()}

    @app.post("/api/automation/explore")
    async def start_explore() -> dict[str, object]:
        started = await worker.start_explore()
        if not started:
            raise HTTPException(status_code=409, detail="任务正在运行")
        return {"ok": True, "status": worker.status.as_dict()}

    @app.post("/api/automation/run-loop")
    async def start_run_loop(limit: int = Query(..., ge=1, le=150)) -> dict[str, object]:
        quota = get_contact_quota(db, settings.daily_contact_limit)
        if limit > quota["remaining"]:
            raise HTTPException(
                status_code=400,
                detail=f"本次沟通数量不能超过今日剩余额度 {quota['remaining']}",
            )
        started = await worker.start_contact_loop(limit=limit)
        if not started:
            raise HTTPException(status_code=409, detail="任务正在运行")
        return {"ok": True, "status": worker.status.as_dict(), "limit": limit, "quota": quota}

    @app.post("/api/automation/stop")
    async def stop() -> dict[str, object]:
        await worker.stop()
        return {"ok": True, "status": worker.status.as_dict()}

    @app.get("/api/jobs")
    async def list_jobs(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)) -> dict[str, object]:
        return db.list_jobs(page=page, page_size=page_size)

    @app.get("/api/logs")
    async def list_logs(page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200)) -> dict[str, object]:
        return db.list_logs(page=page, page_size=page_size)

    @app.post("/api/ai/match")
    async def match_job(payload: JobMatchIn) -> dict[str, object]:
        profile = db.get_profile()
        job = _job_from_payload(payload)
        result = ai_service.match_job(profile, job)
        return {"matched": result.matched, "reason": result.reason}

    @app.post("/api/ai/message")
    async def generate_message(payload: JobMatchIn, match_reason: str = "") -> dict[str, str]:
        profile = db.get_profile()
        job = _job_from_payload(payload)
        message = ai_service.generate_message(profile, job, match_reason)
        return {"message": message}

    return app


def _job_from_payload(payload: JobMatchIn) -> JobSnapshot:
    return JobSnapshot(
        title=payload.title,
        company=payload.company,
        salary=payload.salary,
        city=payload.city,
        jd=payload.jd,
        url=payload.url,
    )
