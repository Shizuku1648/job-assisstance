from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.automation.boss_worker import BossWorker
from app.config import get_settings
from app.database import Database


async def main() -> None:
    settings = get_settings()
    worker = BossWorker(settings, Database(settings.database_path))
    page_info = await worker.save_auth_state()
    print("Boss 登录状态已保存。")
    print(f"当前 URL: {page_info.get('url', '')}")
    print(f"页面标题: {page_info.get('title', '')}")
    print(f"登录态文件: {page_info.get('auth_state_path', '')}")
    print(f"截图: {page_info.get('screenshot_path', '')}")


if __name__ == "__main__":
    asyncio.run(main())
