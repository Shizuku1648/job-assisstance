from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class UserProfile:
    expected_salary_min_k: int
    expected_salary_max_k: int
    candidate_cities: list[str]
    description: str


@dataclass(frozen=True)
class JobSnapshot:
    title: str
    company: str
    salary: str
    city: str
    jd: str
    url: str


@dataclass(frozen=True)
class MatchResult:
    matched: bool
    reason: str


@dataclass(frozen=True)
class WorkerStatus:
    running: bool
    phase: str
    message: str
    last_url: str = ""
    last_title: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "phase": self.phase,
            "message": self.message,
            "last_url": self.last_url,
            "last_title": self.last_title,
        }
