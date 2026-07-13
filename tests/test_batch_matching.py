from __future__ import annotations

import gc
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from app.batch_matching import match_job_batch
from app.database import Database
from app.models import MatchResult


class FakeAIService:
    lock = threading.Lock()
    active_matches = 0
    active_messages = 0
    peak_matches = 0
    peak_messages = 0

    def __init__(self, settings: object) -> None:
        self.settings = settings

    @classmethod
    def reset(cls) -> None:
        cls.active_matches = 0
        cls.active_messages = 0
        cls.peak_matches = 0
        cls.peak_messages = 0

    def match_job(self, profile: object, job: object) -> MatchResult:
        with self.lock:
            type(self).active_matches += 1
            type(self).peak_matches = max(type(self).peak_matches, type(self).active_matches)
        time.sleep(0.05)
        with self.lock:
            type(self).active_matches -= 1
        return MatchResult(matched=True, reason=f"match:{job.title}")

    def generate_message(self, profile: object, job: object, reason: str) -> str:
        with self.lock:
            type(self).active_messages += 1
            type(self).peak_messages = max(type(self).peak_messages, type(self).active_messages)
        time.sleep(0.05)
        with self.lock:
            type(self).active_messages -= 1
        return f"message:{job.title}:{reason}"


class BatchMatchingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db = Database(Path(self.temp_dir.name) / "batch.db")
        FakeAIService.reset()

    def tearDown(self) -> None:
        del self.db
        gc.collect()
        self.temp_dir.cleanup()

    def test_hard_filters_before_concurrent_match_and_message_phases(self) -> None:
        jobs = [
            {
                "title": "eligible-a",
                "company": "A",
                "salary": "18-25K",
                "city": "上海",
                "jd": "AI Agent RAG",
                "url": "https://example.test/a",
            },
            {
                "title": "eligible-b",
                "company": "B",
                "salary": "20-30K",
                "city": "上海",
                "jd": "AI Agent RAG",
                "url": "https://example.test/b",
            },
            {
                "title": "salary-rejected",
                "company": "C",
                "salary": "30-40K",
                "city": "上海",
                "jd": "AI Agent RAG",
                "url": "https://example.test/c",
            },
        ]

        with patch("app.batch_matching.AIService", FakeAIService):
            result = match_job_batch(object(), self.db, jobs, max_workers=10)

        self.assertEqual(result["batch_size"], 3)
        self.assertEqual(result["matched_count"], 2)
        self.assertEqual(result["ready_count"], 2)
        self.assertGreaterEqual(FakeAIService.peak_matches, 2)
        self.assertGreaterEqual(FakeAIService.peak_messages, 2)
        rejected = next(item for item in result["results"] if item["title"] == "salary-rejected")
        self.assertFalse(rejected["matched"])
        self.assertIn("salary_ok=False", rejected["reason"])

    def test_reuses_prepared_match_without_calling_ai_again(self) -> None:
        job = {
            "title": "prepared",
            "company": "A",
            "salary": "18-25K",
            "city": "上海",
            "jd": "AI Agent RAG",
            "url": "https://example.test/prepared",
        }
        with patch("app.batch_matching.AIService", FakeAIService):
            first = match_job_batch(object(), self.db, [job])
            FakeAIService.reset()
            second = match_job_batch(object(), self.db, [job])

        self.assertEqual(first["ready_count"], 1)
        self.assertEqual(second["ready_count"], 1)
        self.assertTrue(second["results"][0]["prepared"])
        self.assertEqual(FakeAIService.peak_matches, 0)
        self.assertEqual(FakeAIService.peak_messages, 0)


if __name__ == "__main__":
    unittest.main()
