from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.salary import decode_boss_salary_text, salary_min_k


SAMPLES = [
    ("\ue033\ue036-\ue034\ue036K·\ue032\ue036薪", "25-35K·15薪"),
    ("\ue032\ue033-\ue033\ue031K", "12-20K"),
    ("\ue033\ue036-\ue035\ue031K·\ue032\ue034薪", "25-40K·13薪"),
    ("\ue033\ue031-\ue035\ue031K·\ue032\ue036薪", "20-40K·15薪"),
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
            }
        )
    output = json.dumps(rows, ensure_ascii=False, indent=2)
    try:
        print(output)
    except UnicodeEncodeError:
        print(output.encode("unicode_escape").decode("ascii"))
    if not all(row["ok"] for row in rows):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
