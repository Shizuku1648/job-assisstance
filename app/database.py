from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from app.defaults import DEFAULT_PROFILE
from app.models import UserProfile


def utc_now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.init()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def init(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                create table if not exists user_profile (
                    id integer primary key check (id = 1),
                    expected_salary_min_k integer not null,
                    candidate_cities text not null,
                    description text not null,
                    updated_at text not null
                );

                create table if not exists jobs (
                    id integer primary key autoincrement,
                    title text not null default '',
                    company text not null default '',
                    salary text not null default '',
                    city text not null default '',
                    jd text not null default '',
                    url text not null default '',
                    ai_matched integer,
                    ai_reason text not null default '',
                    ai_message text not null default '',
                    status text not null,
                    error text not null default '',
                    created_at text not null,
                    updated_at text not null,
                    contacted_at text
                );

                create table if not exists run_logs (
                    id integer primary key autoincrement,
                    event_type text not null,
                    page_url text not null default '',
                    page_title text not null default '',
                    action text not null default '',
                    before_state text not null default '',
                    after_state text not null default '',
                    success integer not null default 0,
                    error text not null default '',
                    screenshot_path text not null default '',
                    created_at text not null
                );
                """
            )
            row = conn.execute("select id from user_profile where id = 1").fetchone()
            if row is None:
                conn.execute(
                    """
                    insert into user_profile
                        (id, expected_salary_min_k, candidate_cities, description, updated_at)
                    values (1, ?, ?, ?, ?)
                    """,
                    (
                        DEFAULT_PROFILE.expected_salary_min_k,
                        json.dumps(DEFAULT_PROFILE.candidate_cities, ensure_ascii=False),
                        DEFAULT_PROFILE.description,
                        utc_now(),
                    ),
                )

    def get_profile(self) -> UserProfile:
        with self.connect() as conn:
            row = conn.execute("select * from user_profile where id = 1").fetchone()
        if row is None:
            return DEFAULT_PROFILE
        return UserProfile(
            expected_salary_min_k=int(row["expected_salary_min_k"]),
            candidate_cities=json.loads(row["candidate_cities"]),
            description=row["description"],
        )

    def save_profile(self, profile: UserProfile) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                insert into user_profile
                    (id, expected_salary_min_k, candidate_cities, description, updated_at)
                values (1, ?, ?, ?, ?)
                on conflict(id) do update set
                    expected_salary_min_k = excluded.expected_salary_min_k,
                    candidate_cities = excluded.candidate_cities,
                    description = excluded.description,
                    updated_at = excluded.updated_at
                """,
                (
                    profile.expected_salary_min_k,
                    json.dumps(profile.candidate_cities, ensure_ascii=False),
                    profile.description,
                    utc_now(),
                ),
            )

    def create_job(self, data: dict[str, Any]) -> int:
        now = utc_now()
        with self.connect() as conn:
            cursor = conn.execute(
                """
                insert into jobs (
                    title, company, salary, city, jd, url, ai_matched, ai_reason,
                    ai_message, status, error, created_at, updated_at, contacted_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data.get("title", ""),
                    data.get("company", ""),
                    data.get("salary", ""),
                    data.get("city", ""),
                    data.get("jd", ""),
                    data.get("url", ""),
                    data.get("ai_matched"),
                    data.get("ai_reason", ""),
                    data.get("ai_message", ""),
                    data.get("status", "pending"),
                    data.get("error", ""),
                    now,
                    now,
                    data.get("contacted_at"),
                ),
            )
            return int(cursor.lastrowid)

    def update_job_match(
        self,
        job_id: int,
        *,
        ai_matched: bool | None,
        ai_reason: str = "",
        ai_message: str = "",
        status: str,
        error: str = "",
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                update jobs
                set ai_matched = ?,
                    ai_reason = ?,
                    ai_message = ?,
                    status = ?,
                    error = ?,
                    updated_at = ?
                where id = ?
                """,
                (
                    None if ai_matched is None else (1 if ai_matched else 0),
                    ai_reason,
                    ai_message,
                    status,
                    error,
                    utc_now(),
                    job_id,
                ),
            )

    def mark_job_contacted(self, job_id: int) -> None:
        now = utc_now()
        with self.connect() as conn:
            conn.execute(
                """
                update jobs
                set status = 'contacted',
                    contacted_at = ?,
                    updated_at = ?
                where id = ?
                """,
                (now, now, job_id),
            )

    def list_jobs(self, page: int = 1, page_size: int = 20) -> dict[str, Any]:
        page = max(page, 1)
        page_size = min(max(page_size, 1), 100)
        offset = (page - 1) * page_size
        with self.connect() as conn:
            total = conn.execute("select count(*) as total from jobs").fetchone()["total"]
            rows = conn.execute(
                "select * from jobs order by id desc limit ? offset ?",
                (page_size, offset),
            ).fetchall()
        return {"total": total, "page": page, "page_size": page_size, "items": [dict(row) for row in rows]}

    def log_event(
        self,
        event_type: str,
        page_url: str = "",
        page_title: str = "",
        action: str = "",
        before_state: str = "",
        after_state: str = "",
        success: bool = False,
        error: str = "",
        screenshot_path: str = "",
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                insert into run_logs (
                    event_type, page_url, page_title, action, before_state, after_state,
                    success, error, screenshot_path, created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_type,
                    page_url,
                    page_title,
                    action,
                    before_state,
                    after_state,
                    1 if success else 0,
                    error,
                    screenshot_path,
                    utc_now(),
                ),
            )

    def list_logs(self, page: int = 1, page_size: int = 50) -> dict[str, Any]:
        page = max(page, 1)
        page_size = min(max(page_size, 1), 200)
        offset = (page - 1) * page_size
        with self.connect() as conn:
            total = conn.execute("select count(*) as total from run_logs").fetchone()["total"]
            rows = conn.execute(
                "select * from run_logs order by id desc limit ? offset ?",
                (page_size, offset),
            ).fetchall()
        return {"total": total, "page": page, "page_size": page_size, "items": [dict(row) for row in rows]}
