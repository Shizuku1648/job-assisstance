from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from app.ai_service import AIService
from app.automation.boss_worker import BossWorker
from app.config import get_settings
from app.database import Database
from app.models import JobSnapshot, UserProfile


class ProfileIn(BaseModel):
    expected_salary_min_k: int = Field(ge=1)
    candidate_cities: list[str] = Field(min_length=1)
    description: str = Field(min_length=10)


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

    app = FastAPI(title="Boss 直聘自动化求职助手")

    @app.get("/", response_class=HTMLResponse)
    async def index() -> str:
        return _render_index()

    @app.get("/api/profile")
    async def get_profile() -> dict[str, object]:
        profile = db.get_profile()
        return {
            "expected_salary_min_k": profile.expected_salary_min_k,
            "candidate_cities": profile.candidate_cities,
            "description": profile.description,
        }

    @app.post("/api/profile")
    async def save_profile(payload: ProfileIn) -> dict[str, bool]:
        db.save_profile(
            UserProfile(
                expected_salary_min_k=payload.expected_salary_min_k,
                candidate_cities=[city.strip() for city in payload.candidate_cities if city.strip()],
                description=payload.description.strip(),
            )
        )
        return {"ok": True}

    @app.get("/api/status")
    async def status() -> dict[str, object]:
        return worker.status.as_dict()

    @app.post("/api/automation/explore")
    async def start_explore() -> dict[str, object]:
        started = await worker.start_explore()
        if not started:
            raise HTTPException(status_code=409, detail="任务已在运行")
        return {"ok": True, "status": worker.status.as_dict()}

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
        job = JobSnapshot(
            title=payload.title,
            company=payload.company,
            salary=payload.salary,
            city=payload.city,
            jd=payload.jd,
            url=payload.url,
        )
        result = ai_service.match_job(profile, job)
        return {"matched": result.matched, "reason": result.reason}

    @app.post("/api/ai/message")
    async def generate_message(payload: JobMatchIn, match_reason: str = "") -> dict[str, str]:
        profile = db.get_profile()
        job = JobSnapshot(
            title=payload.title,
            company=payload.company,
            salary=payload.salary,
            city=payload.city,
            jd=payload.jd,
            url=payload.url,
        )
        message = ai_service.generate_message(profile, job, match_reason)
        return {"message": message}

    return app


def _render_index() -> str:
    return """
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Boss 直聘自动化求职助手</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #17202a; }
    header { padding: 18px 28px; background: #16202a; color: #fff; }
    main { max-width: 1120px; margin: 0 auto; padding: 24px; display: grid; gap: 18px; }
    section { background: #fff; border: 1px solid #dde2e8; border-radius: 8px; padding: 18px; }
    h1 { margin: 0; font-size: 20px; }
    h2 { margin: 0 0 14px; font-size: 16px; }
    label { display: block; margin: 10px 0 6px; font-weight: 600; }
    input, textarea { width: 100%; box-sizing: border-box; border: 1px solid #c8d0da; border-radius: 6px; padding: 10px; font: inherit; }
    textarea { min-height: 170px; resize: vertical; }
    button { border: 0; border-radius: 6px; padding: 10px 14px; cursor: pointer; font-weight: 700; }
    .primary { background: #1677ff; color: #fff; }
    .secondary { background: #eef2f6; color: #17202a; }
    .danger { background: #d93025; color: #fff; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    pre { background: #111827; color: #e5e7eb; border-radius: 8px; padding: 14px; overflow: auto; max-height: 280px; }
  </style>
</head>
<body>
  <header><h1>Boss 直聘自动化求职助手</h1></header>
  <main>
    <section>
      <h2>用户信息</h2>
      <label>期望最低薪资（k）</label>
      <input id="salary" type="number" min="1">
      <label>候选城市（逗号分隔）</label>
      <input id="cities">
      <label>个人描述</label>
      <textarea id="description"></textarea>
      <div class="row" style="margin-top: 12px;">
        <button class="primary" onclick="saveProfile()">保存</button>
        <button class="secondary" onclick="loadProfile()">刷新</button>
      </div>
    </section>
    <section>
      <h2>调试与探索</h2>
      <div class="row">
        <button class="primary" onclick="openLogin()">打开 Boss 登录页</button>
        <button class="secondary" onclick="saveAuth()">保存登录状态</button>
        <button class="primary" onclick="startExplore()">连接 Edge CDP 并探索推荐页</button>
        <button class="danger" onclick="stopWorker()">停止</button>
        <button class="secondary" onclick="loadStatus()">查看状态</button>
      </div>
      <pre id="status">{}</pre>
    </section>
    <section>
      <h2>最近日志</h2>
      <button class="secondary" onclick="loadLogs()">刷新日志</button>
      <pre id="logs">[]</pre>
    </section>
  </main>
  <script>
    async function api(path, options) {
      const response = await fetch(path, options);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || JSON.stringify(data));
      return data;
    }
    async function loadProfile() {
      const data = await api('/api/profile');
      document.querySelector('#salary').value = data.expected_salary_min_k;
      document.querySelector('#cities').value = data.candidate_cities.join(',');
      document.querySelector('#description').value = data.description;
    }
    async function saveProfile() {
      await api('/api/profile', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          expected_salary_min_k: Number(document.querySelector('#salary').value),
          candidate_cities: document.querySelector('#cities').value.split(',').map(s => s.trim()).filter(Boolean),
          description: document.querySelector('#description').value
        })
      });
      await loadProfile();
    }
    async function startExplore() {
      document.querySelector('#status').textContent = JSON.stringify(await api('/api/automation/explore', {method: 'POST'}), null, 2);
    }
    async function openLogin() {
      document.querySelector('#status').textContent = JSON.stringify(await api('/api/browser/open-login', {method: 'POST'}), null, 2);
    }
    async function saveAuth() {
      document.querySelector('#status').textContent = JSON.stringify(await api('/api/browser/save-auth', {method: 'POST'}), null, 2);
      await loadLogs();
    }
    async function stopWorker() {
      document.querySelector('#status').textContent = JSON.stringify(await api('/api/automation/stop', {method: 'POST'}), null, 2);
    }
    async function loadStatus() {
      document.querySelector('#status').textContent = JSON.stringify(await api('/api/status'), null, 2);
    }
    async function loadLogs() {
      document.querySelector('#logs').textContent = JSON.stringify(await api('/api/logs?page_size=20'), null, 2);
    }
    loadProfile(); loadStatus(); loadLogs();
    setInterval(loadStatus, 3000);
  </script>
</body>
</html>
"""
