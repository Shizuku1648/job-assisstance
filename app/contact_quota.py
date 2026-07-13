from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from typing import Any

from app.database import Database


BOSS_TIMEZONE = timezone(timedelta(hours=8), name="Asia/Shanghai")


def utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def local_day_utc_bounds(now: datetime | None = None) -> tuple[str, str]:
    local_now = (now or datetime.now(BOSS_TIMEZONE)).astimezone(BOSS_TIMEZONE)
    local_start = datetime.combine(local_now.date(), time.min, tzinfo=BOSS_TIMEZONE)
    return utc_text(local_start), utc_text(local_start + timedelta(days=1))


def get_contact_quota(db: Database, daily_limit: int, now: datetime | None = None) -> dict[str, Any]:
    start_utc, end_utc = local_day_utc_bounds(now)
    contacted_today = db.count_contacted_between(start_utc, end_utc)
    return {
        "daily_limit": daily_limit,
        "contacted_today": contacted_today,
        "remaining": max(daily_limit - contacted_today, 0),
        "timezone": str(BOSS_TIMEZONE),
    }
