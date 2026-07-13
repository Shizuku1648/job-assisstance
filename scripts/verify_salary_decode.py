from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.salary import decode_boss_salary_text, salary_max_k, salary_min_k, salary_ranges_overlap


SAMPLES = [
    ("\ue033\ue036-\ue034\ue036K·\ue032\ue036薪", "25-35K·15薪"),
    ("\ue032\ue033-\ue033\ue031K", "12-20K"),
    ("\ue033\ue036-\ue035\ue031K·\ue032\ue034薪", "25-40K·13薪"),
    ("\ue033\ue031-\ue035\ue031K·\ue032\ue036薪", "20-40K·15薪"),
]

OVERLAP_SAMPLES = [
    ("18-20K", 20, 25, True),
    ("18-25K", 20, 25, True),
    ("25-30K", 20, 25, True),
    ("26-30K", 20, 25, False),
    ("10-19K", 20, 25, False),
]


def main() -> None:
    rows = []
    for raw, expected in SAMPLES:
        decoded = decode_boss_salary_text(raw)
        rows.append(
            {
                "raw": raw,
                "decoded": decoded,
                "expected": expected,
                "ok": decoded == expected,
                "min_k": salary_min_k(raw),
                "max_k": salary_max_k(raw),
            }
        )
    overlap_rows = [
        {
            "salary": salary,
            "expected": f"{expected_min_k}-{expected_max_k}K",
            "matched": salary_ranges_overlap(salary, expected_min_k, expected_max_k),
            "expected_match": expected_match,
        }
        for salary, expected_min_k, expected_max_k, expected_match in OVERLAP_SAMPLES
    ]
    output = json.dumps({"decode": rows, "overlap": overlap_rows}, ensure_ascii=False, indent=2)
    try:
        print(output)
    except UnicodeEncodeError:
        print(output.encode("unicode_escape").decode("ascii"))
    if not all(row["ok"] for row in rows) or not all(
        row["matched"] == row["expected_match"] for row in overlap_rows
    ):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
