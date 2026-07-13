from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT_DIR / ".env"


def _load_env_file(path: Path = ENV_FILE) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        values[key] = value
    return values


def _env(name: str, default: str = "") -> str:
    file_values = _load_env_file()
    return os.getenv(name) or file_values.get(name, default)


@dataclass(frozen=True)
class Settings:
    openai_base_url: str
    openai_api_key: str
    openai_model: str
    edge_cdp_url: str
    database_path: Path
    daily_contact_limit: int
    boss_jobs_url: str
    boss_login_url: str
    edge_user_data_dir: Path
    auth_state_path: Path
    screenshots_dir: Path
    traces_dir: Path
    logs_dir: Path
    docs_dir: Path


def get_settings() -> Settings:
    return Settings(
        openai_base_url=_env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        openai_api_key=_env("OPENAI_API_KEY"),
        openai_model=_env("OPENAI_MODEL", "gpt-4.1-mini"),
        edge_cdp_url=_env("EDGE_CDP_URL", "http://127.0.0.1:9222"),
        database_path=Path(_env("DATABASE_PATH", str(ROOT_DIR / "runtime" / "job_assistance.db"))),
        daily_contact_limit=int(_env("DAILY_CONTACT_LIMIT", "150")),
        boss_jobs_url=_env("BOSS_JOBS_URL", "https://www.zhipin.com/web/geek/jobs"),
        boss_login_url=_env("BOSS_LOGIN_URL", "https://www.zhipin.com/web/user/?ka=header-login"),
        edge_user_data_dir=Path(_env("EDGE_USER_DATA_DIR", str(ROOT_DIR / "runtime" / "edge-profile"))),
        auth_state_path=Path(_env("AUTH_STATE_PATH", str(ROOT_DIR / "runtime" / "auth" / "boss_state.json"))),
        screenshots_dir=Path(_env("SCREENSHOTS_DIR", str(ROOT_DIR / "runtime" / "screenshots"))),
        traces_dir=Path(_env("TRACES_DIR", str(ROOT_DIR / "runtime" / "traces"))),
        logs_dir=Path(_env("LOGS_DIR", str(ROOT_DIR / "runtime" / "logs"))),
        docs_dir=Path(_env("DOCS_DIR", str(ROOT_DIR / "docs"))),
    )
