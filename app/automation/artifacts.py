from __future__ import annotations

from datetime import datetime
from pathlib import Path


def local_now_slug() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def append_markdown(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as file:
        file.write(content.rstrip() + "\n\n")


def ensure_file(path: Path, title: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(f"# {title}\n\n", encoding="utf-8")
