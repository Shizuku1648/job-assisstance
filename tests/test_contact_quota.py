from __future__ import annotations

import gc
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from app.contact_quota import BOSS_TIMEZONE, get_contact_quota, local_day_utc_bounds
from app.database import Database


class ContactQuotaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self.temp_dir.name) / "quota.db"
        self.db = Database(self.db_path)

    def tearDown(self) -> None:
        del self.db
        gc.collect()
        self.temp_dir.cleanup()

    def test_uses_shanghai_calendar_day(self) -> None:
        now = datetime(2026, 7, 13, 12, tzinfo=BOSS_TIMEZONE)
        start_utc, end_utc = local_day_utc_bounds(now)
        self.assertEqual(start_utc, "2026-07-12T16:00:00Z")
        self.assertEqual(end_utc, "2026-07-13T16:00:00Z")

        for index, contacted_at in enumerate(
            ("2026-07-12T15:59:59Z", start_utc, "2026-07-13T15:59:59Z", end_utc)
        ):
            job_id = self.db.create_job({"title": f"job-{index}", "status": "matched"})
            self.db.mark_job_contacted(job_id, contacted_at=contacted_at)

        quota = get_contact_quota(self.db, 150, now=now)
        self.assertEqual(quota["contacted_today"], 2)
        self.assertEqual(quota["remaining"], 148)

    def test_migrates_existing_profile_with_salary_maximum(self) -> None:
        migration_path = Path(self.temp_dir.name) / "migration.db"
        with sqlite3.connect(migration_path) as conn:
            conn.execute(
                """
                create table user_profile (
                    id integer primary key,
                    expected_salary_min_k integer not null,
                    candidate_cities text not null,
                    description text not null,
                    updated_at text not null
                )
                """
            )
            conn.execute(
                "insert into user_profile values (?, ?, ?, ?, ?)",
                (1, 20, json.dumps(["上海"], ensure_ascii=False), "test profile", "now"),
            )

        profile = Database(migration_path).get_profile()
        self.assertEqual(profile.expected_salary_min_k, 20)
        self.assertEqual(profile.expected_salary_max_k, 25)


if __name__ == "__main__":
    unittest.main()
