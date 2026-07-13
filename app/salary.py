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


def salary_min_k(value: str) -> int | None:
    decoded = decode_boss_salary_text(value)
    match = re.search(r"(\d+)\s*-\s*(\d+)\s*K", decoded, re.IGNORECASE)
    if not match:
        return None
    return int(match.group(1))
