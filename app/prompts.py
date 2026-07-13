from __future__ import annotations

from pathlib import Path

from app.config import ROOT_DIR


PROMPTS_DIR = ROOT_DIR / "prompts"


def load_prompt(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8")


def render_prompt(template: str, values: dict[str, object]) -> str:
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", str(value))
    return rendered
