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
    status = await worker.explore_once()
    print(status.as_dict())


if __name__ == "__main__":
    asyncio.run(main())
