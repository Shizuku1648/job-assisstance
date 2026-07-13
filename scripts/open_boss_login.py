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
    page_info = await worker.open_login()
    print("Boss 登录页已打开。")
    print(f"当前 URL: {page_info.get('url', '')}")
    print(f"页面标题: {page_info.get('title', '')}")
    print(f"截图: {page_info.get('screenshot_path', '')}")
    print("请在 Edge 中完成登录，然后运行 scripts/save_boss_auth.py 保存登录状态。")


if __name__ == "__main__":
    asyncio.run(main())
