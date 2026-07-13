from __future__ import annotations

import re


BOSS_PRIVATE_DIGITS = {
    "\ue031": "0",
    "\ue032": "1",
    "\ue033": "2",
    "\ue034": "3",
    "\ue035": "4",
    "\ue036": "5",
    "\ue037": "6",
    "\ue038": "7",
    "\ue039": "8",
    "\ue030": "9",
}


def decode_boss_salary_text(value: str) -> str:
    return "".join(BOSS_PRIVATE_DIGITS.get(char, char) for char in value)


def salary_range_k(value: str) -> tuple[int, int] | None:
    decoded = decode_boss_salary_text(value)
    match = re.search(r"(\d+)\s*-\s*(\d+)\s*K", decoded, re.IGNORECASE)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def salary_min_k(value: str) -> int | None:
    salary_range = salary_range_k(value)
    return salary_range[0] if salary_range else None


def salary_max_k(value: str) -> int | None:
    salary_range = salary_range_k(value)
    return salary_range[1] if salary_range else None


def salary_ranges_overlap(value: str, expected_min_k: int, expected_max_k: int) -> bool:
    salary_range = salary_range_k(value)
    if salary_range is None:
        return False
    job_min_k, job_max_k = salary_range
    return job_max_k >= expected_min_k and job_min_k <= expected_max_k
