from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.automation.artifacts import append_markdown, local_now_slug
from app.config import get_settings
from app.database import Database


def main() -> None:
    settings = get_settings()
    with urllib.request.urlopen(f"{settings.edge_cdp_url.rstrip('/')}/json", timeout=10) as response:
        targets = json.loads(response.read().decode("utf-8"))

    pages = [target for target in targets if target.get("type") == "page"]
    log_path = settings.logs_dir / f"{local_now_slug()}-edge-targets.json"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(json.dumps(targets, ensure_ascii=False, indent=2), encoding="utf-8")

    db = Database(settings.database_path)
    for page in pages:
        db.log_event(
            event_type="edge_target_snapshot",
            page_url=page.get("url", ""),
            page_title=page.get("title", ""),
            action="read_edge_devtools_json",
            after_state=json.dumps(page, ensure_ascii=False),
            success=True,
        )

    append_markdown(
        settings.docs_dir / "boss-test-runs.md",
        "\n".join(
            [
                f"## {local_now_slug()} Edge target 快照",
                "",
                f"- CDP：`{settings.edge_cdp_url}`",
                f"- 原始快照：`{log_path}`",
                "",
                "```json",
                json.dumps(pages, ensure_ascii=False, indent=2),
                "```",
            ]
        ),
    )
    print(json.dumps(pages, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
