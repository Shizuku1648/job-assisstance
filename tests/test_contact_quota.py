from __future__ import annotations

import gc
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.automation.boss_worker import BossWorker
from app.contact_quota import BOSS_TIMEZONE, contact_batch_size, get_contact_quota, local_day_utc_bounds
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

    def test_contact_batch_size_tracks_remaining_target_and_quota(self) -> None:
        self.assertEqual(contact_batch_size(100, 112), 10)
        self.assertEqual(contact_batch_size(5, 112), 5)
        self.assertEqual(contact_batch_size(8, 3), 3)
        self.assertEqual(contact_batch_size(0, 20), 0)

    def test_worker_counts_and_records_multiple_contacts_from_one_batch(self) -> None:
        first_job_id = self.db.create_job({"title": "first", "status": "matched"})
        second_job_id = self.db.create_job({"title": "second", "status": "matched"})
        logs_dir = Path(self.temp_dir.name) / "logs"
        logs_dir.mkdir()
        worker = BossWorker(SimpleNamespace(logs_dir=logs_dir), self.db)
        stdout = json.dumps(
            {
                "safe": True,
                "contacts": [
                    {
                        "match": {"job_id": first_job_id},
                        "immediate": {"clicked": True, "sentDialog": True},
                        "sendMessage": {"sent": True},
                    },
                    {
                        "match": {"job_id": second_job_id},
                        "immediate": {"clicked": True, "sentDialog": True},
                        "sendMessage": {"sent": True},
                    },
                ],
            },
            ensure_ascii=False,
        )
        completed = SimpleNamespace(returncode=0, stdout=stdout, stderr="")

        with patch("app.automation.boss_worker.subprocess.run", return_value=completed):
            result = worker._run_contact_once("test", 1, 2)

        self.assertEqual(result["contacted_count"], 2)
        self.assertEqual(result["success_count"], 2)
        self.assertTrue(result["success"])
        quota = get_contact_quota(self.db, 150)
        self.assertEqual(quota["contacted_today"], 2)


if __name__ == "__main__":
    unittest.main()
