from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from app.automation.artifacts import append_markdown, ensure_file, local_now_slug
from app.automation.edge import cdp_port_is_open, launch_edge_for_cdp, open_edge_url, wait_for_cdp
from app.config import Settings
from app.database import Database
from app.models import WorkerStatus


class BossWorker:
    def __init__(self, settings: Settings, db: Database) -> None:
        self.settings = settings
        self.db = db
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._status = WorkerStatus(False, "idle", "未运行")

    @property
    def status(self) -> WorkerStatus:
        return self._status

    async def start_explore(self) -> bool:
        if self._task and not self._task.done():
            return False
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run_explore())
        return True

    async def explore_once(self) -> WorkerStatus:
        if self._task and not self._task.done():
            raise RuntimeError("任务已在运行")
        self._stop_event.clear()
        await self._run_explore()
        return self._status

    async def open_login(self) -> dict[str, Any]:
        self._ensure_artifacts()
        launched_pid: int | None = None
        if not cdp_port_is_open(self.settings.edge_cdp_url):
            launched_pid = launch_edge_for_cdp(
                self.settings.edge_cdp_url,
                self.settings.edge_user_data_dir,
                self.settings.boss_login_url,
            )
            if not await asyncio.to_thread(wait_for_cdp, self.settings.edge_cdp_url, 25):
                raise RuntimeError(
                    f"Edge 已尝试启动，但 CDP 端口未就绪：{self.settings.edge_cdp_url}，PID={launched_pid}"
                )
        else:
            launched_pid = open_edge_url(
                self.settings.edge_cdp_url,
                self.settings.edge_user_data_dir,
                self.settings.boss_login_url,
            )
            await asyncio.sleep(1)

        page_info = {
            "url": self.settings.boss_login_url,
            "title": "Boss 直聘登录页",
            "screenshot_path": "",
            "auth_state_path": str(self.settings.auth_state_path),
        }
        self.db.log_event(
            event_type="login_opened",
            page_url=page_info.get("url", ""),
            page_title=page_info.get("title", ""),
            action="open_boss_login",
            before_state=json.dumps(
                {
                    "cdp_url": self.settings.edge_cdp_url,
                    "launched_pid": launched_pid,
                    "edge_user_data_dir": str(self.settings.edge_user_data_dir),
                },
                ensure_ascii=False,
            ),
            after_state=json.dumps(page_info, ensure_ascii=False)[:4000],
            success=True,
        )
        self._write_login_doc(page_info, launched_pid)
        self._status = WorkerStatus(
            False,
            "login_opened",
            "已打开 Boss 登录页，请在 Edge 中完成登录后点击保存登录状态",
            last_url=page_info.get("url", ""),
            last_title=page_info.get("title", ""),
        )
        return page_info | {"launched_pid": launched_pid}

    async def save_auth_state(self) -> dict[str, Any]:
        self._ensure_artifacts()
        page_info = await self._save_storage_state()
        self.db.log_event(
            event_type="auth_state_saved",
            page_url=page_info.get("url", ""),
            page_title=page_info.get("title", ""),
            action="save_boss_auth_state",
            after_state=json.dumps(page_info, ensure_ascii=False)[:4000],
            success=True,
            screenshot_path=page_info.get("screenshot_path", ""),
        )
        append_markdown(
            self.settings.docs_dir / "boss-test-runs.md",
            "\n".join(
                [
                    f"## {local_now_slug()} 登录态保存",
                    "",
                    f"- 当前 URL：`{page_info.get('url', '')}`",
                    f"- 页面标题：`{page_info.get('title', '')}`",
                    f"- Storage state：`{self.settings.auth_state_path}`",
                    f"- 截图：`{page_info.get('screenshot_path', '')}`",
                    "- 结果：已保存登录态",
                ]
            ),
        )
        self._status = WorkerStatus(
            False,
            "auth_saved",
            f"登录态已保存到 {self.settings.auth_state_path}",
            last_url=page_info.get("url", ""),
            last_title=page_info.get("title", ""),
        )
        return page_info

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task and not self._task.done():
            self._status = WorkerStatus(True, "stopping", "正在停止")
            await asyncio.wait([self._task], timeout=5)

    async def _run_explore(self) -> None:
        self._status = WorkerStatus(True, "starting", "正在连接 Edge CDP")
        self._ensure_artifacts()
        run_id = local_now_slug()
        screenshot_path = self.settings.screenshots_dir / f"{run_id}-boss-jobs.png"
        before_state = {"cdp_url": self.settings.edge_cdp_url, "target_url": self.settings.boss_jobs_url}

        try:
            open_edge_url(
                self.settings.edge_cdp_url,
                self.settings.edge_user_data_dir,
                self.settings.boss_jobs_url,
            )
            await asyncio.sleep(2)
            page_info = await self._capture_current_page(screenshot_path)
            self._status = WorkerStatus(
                True,
                "documenting",
                "正在写入页面探索留档",
                last_url=page_info.get("url", ""),
                last_title=page_info.get("title", ""),
            )
            self._write_exploration_docs(run_id, page_info, screenshot_path)
            self.db.log_event(
                event_type="explore",
                page_url=page_info.get("url", ""),
                page_title=page_info.get("title", ""),
                action="open_jobs_page_and_capture",
                before_state=json.dumps(before_state, ensure_ascii=False),
                after_state=json.dumps(page_info, ensure_ascii=False)[:4000],
                success=True,
                screenshot_path=str(screenshot_path),
            )
            self._status = WorkerStatus(
                False,
                "idle",
                "探索完成，已生成页面留档",
                last_url=page_info.get("url", ""),
                last_title=page_info.get("title", ""),
            )
        except Exception as exc:
            self.db.log_event(
                event_type="explore_failed",
                action="open_jobs_page_and_capture",
                before_state=json.dumps(before_state, ensure_ascii=False),
                success=False,
                error=str(exc),
            )
            self._status = WorkerStatus(False, "error", f"探索失败：{exc}")

    async def _capture_jobs_page(self, screenshot_path: Path) -> dict[str, Any]:
        return await self._open_page_and_capture(self.settings.boss_jobs_url, screenshot_path, check_homepage=True)

    async def _capture_current_page(self, screenshot_path: Path) -> dict[str, Any]:
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise RuntimeError("Playwright 未安装，请先运行 uv sync") from exc

        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(self.settings.edge_cdp_url)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = self._select_boss_page(context.pages) or (context.pages[0] if context.pages else await context.new_page())
            await page.wait_for_timeout(2500)

            if page.is_closed():
                raise RuntimeError("页面被关闭，疑似触发风控")
            if self._looks_like_homepage(before_url="", current_url=page.url):
                raise RuntimeError(f"页面回到首页，疑似触发风控：{page.url}")

            screenshot_path.parent.mkdir(parents=True, exist_ok=True)
            await page.screenshot(path=str(screenshot_path), full_page=True)
            dom_snapshot = await self._collect_dom_snapshot(page)
            return {
                "url": page.url,
                "title": await self._safe_title(page),
                "screenshot_path": str(screenshot_path),
                "dom": dom_snapshot,
                "login_state": self._infer_login_state(page.url, dom_snapshot),
                "expected_jobs": self._extract_expected_jobs(dom_snapshot),
            }

    async def _open_page_and_capture(
        self,
        target_url: str,
        screenshot_path: Path,
        check_homepage: bool = False,
    ) -> dict[str, Any]:
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise RuntimeError("Playwright 未安装，请先运行 uv sync 并安装浏览器依赖") from exc

        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(self.settings.edge_cdp_url)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()

            before_url = page.url
            before_title = await self._safe_title(page)
            await page.goto(target_url, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(2500)

            if page.is_closed():
                raise RuntimeError("页面被关闭，疑似触发风控")
            if check_homepage and self._looks_like_homepage(before_url=before_url, current_url=page.url):
                raise RuntimeError(f"操作后回到首页，疑似触发风控：{page.url}")

            screenshot_path.parent.mkdir(parents=True, exist_ok=True)
            await page.screenshot(path=str(screenshot_path), full_page=True)
            dom_snapshot = await self._collect_dom_snapshot(page)
            page_info = {
                "url": page.url,
                "title": await self._safe_title(page),
                "before_url": before_url,
                "before_title": before_title,
                "screenshot_path": str(screenshot_path),
                "dom": dom_snapshot,
            }
            return page_info

    async def _save_storage_state(self) -> dict[str, Any]:
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise RuntimeError("Playwright 未安装，请先运行 uv sync") from exc

        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(self.settings.edge_cdp_url)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()
            if page.is_closed():
                raise RuntimeError("页面被关闭，无法保存登录态")

            self.settings.auth_state_path.parent.mkdir(parents=True, exist_ok=True)
            await context.storage_state(path=str(self.settings.auth_state_path))

            screenshot_path = self.settings.screenshots_dir / f"{local_now_slug()}-auth-state.png"
            screenshot_path.parent.mkdir(parents=True, exist_ok=True)
            await page.screenshot(path=str(screenshot_path), full_page=True)
            return {
                "url": page.url,
                "title": await self._safe_title(page),
                "auth_state_path": str(self.settings.auth_state_path),
                "screenshot_path": str(screenshot_path),
            }

    async def _collect_dom_snapshot(self, page: Any) -> dict[str, Any]:
        return await page.evaluate(
            """
            () => {
                const clean = (value) => (value || '').toString().replace(/\\s+/g, ' ').trim();
                const short = (value, size = 180) => clean(value).slice(0, size);
                const nodes = (selector) => Array.from(document.querySelectorAll(selector)).slice(0, 80);
                return {
                    bodyTextSample: short(document.body ? document.body.innerText : '', 3000),
                    links: nodes('a').map((el) => ({
                        text: short(el.innerText),
                        href: el.href || '',
                        className: short(el.className, 120)
                    })),
                    buttons: nodes('button, [role="button"], .btn').map((el) => ({
                        text: short(el.innerText || el.getAttribute('aria-label')),
                        className: short(el.className, 120)
                    })),
                    inputs: nodes('input, textarea').map((el) => ({
                        placeholder: short(el.getAttribute('placeholder')),
                        name: short(el.getAttribute('name')),
                        type: short(el.getAttribute('type')),
                        className: short(el.className, 120)
                    })),
                    likelyJobCards: nodes('[class*="job"], [class*="geek"], [class*="card"]').map((el) => ({
                        text: short(el.innerText, 260),
                        className: short(el.className, 120)
                    }))
                };
            }
            """
        )

    def _select_boss_page(self, pages: list[Any]) -> Any | None:
        for page in reversed(pages):
            if not page.is_closed() and "zhipin.com" in page.url:
                return page
        return None

    def _infer_login_state(self, url: str, dom: dict[str, Any]) -> str:
        text = dom.get("bodyTextSample", "")
        if "/web/user" in url or "登录" in text and "注册" in text:
            return "login_required_or_login_page"
        if "/web/geek/jobs" in url and ("推荐" in text or "沟通" in text or "职位" in text):
            return "logged_in_likely"
        return "unknown"

    def _extract_expected_jobs(self, dom: dict[str, Any]) -> list[dict[str, str]]:
        expected_names = ["高性能计算工程师", "大模型算法", "算法工程师"]
        text = dom.get("bodyTextSample", "")
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        result: list[dict[str, str]] = []
        for name in expected_names:
            matched_line = next((line for line in lines if name in line), "")
            result.append(
                {
                    "name": name,
                    "found": "true" if name in text else "false",
                    "matched_line": matched_line[:300],
                    "expected_city_note": "上海" if name == "算法工程师" else "",
                }
            )
        return result

    async def _safe_title(self, page: Any) -> str:
        if page.is_closed():
            return ""
        try:
            return await page.title()
        except Exception:
            return ""

    def _looks_like_homepage(self, before_url: str, current_url: str) -> bool:
        if before_url == current_url:
            return False
        homepage_urls = {"https://www.zhipin.com/", "https://www.zhipin.com/web/geek/index"}
        return current_url.rstrip("/") in {url.rstrip("/") for url in homepage_urls}

    def _ensure_artifacts(self) -> None:
        for path in [self.settings.screenshots_dir, self.settings.traces_dir, self.settings.logs_dir, self.settings.docs_dir]:
            path.mkdir(parents=True, exist_ok=True)
        ensure_file(self.settings.docs_dir / "boss-pages.md", "Boss 直聘页面结构笔记")
        ensure_file(self.settings.docs_dir / "boss-flow.md", "Boss 直聘可行操作路径")
        ensure_file(self.settings.docs_dir / "boss-selectors.md", "Boss 直聘选择器候选")
        ensure_file(self.settings.docs_dir / "boss-test-runs.md", "Boss 直聘实战测试记录")

    def _write_login_doc(self, page_info: dict[str, Any], launched_pid: int | None) -> None:
        append_markdown(
            self.settings.docs_dir / "boss-test-runs.md",
            "\n".join(
                [
                    f"## {local_now_slug()} 打开登录页",
                    "",
                    f"- CDP：`{self.settings.edge_cdp_url}`",
                    f"- Edge PID：`{launched_pid or 'existing'}`",
                    f"- 用户数据目录：`{self.settings.edge_user_data_dir}`",
                    f"- 实际 URL：`{page_info.get('url', '')}`",
                    f"- 页面标题：`{page_info.get('title', '')}`",
                    f"- 截图：`{page_info.get('screenshot_path', '')}`",
                    "- 下一步：用户在 Edge 中完成登录，然后点击“保存登录状态”。",
                ]
            ),
        )

    def _write_exploration_docs(self, run_id: str, page_info: dict[str, Any], screenshot_path: Path) -> None:
        dom = page_info.get("dom", {})
        links = dom.get("links", [])[:20]
        buttons = dom.get("buttons", [])[:30]
        inputs = dom.get("inputs", [])[:20]
        likely_cards = dom.get("likelyJobCards", [])[:20]

        append_markdown(
            self.settings.docs_dir / "boss-test-runs.md",
            "\n".join(
                [
                    f"## {run_id} 推荐页探索",
                    "",
                    f"- CDP：`{self.settings.edge_cdp_url}`",
                    f"- 起始 URL：`{self.settings.boss_jobs_url}`",
                    f"- 实际 URL：`{page_info.get('url', '')}`",
                    f"- 页面标题：`{page_info.get('title', '')}`",
                    f"- 登录态判断：`{page_info.get('login_state', '')}`",
                    f"- 截图：`{screenshot_path}`",
                    "- 结果：成功打开并完成页面快照",
                ]
            ),
        )

        append_markdown(
            self.settings.docs_dir / "boss-pages.md",
            "\n".join(
                [
                    f"## {run_id} 推荐岗位页",
                    "",
                    f"- URL：`{page_info.get('url', '')}`",
                    f"- 标题：`{page_info.get('title', '')}`",
                    f"- 登录态判断：`{page_info.get('login_state', '')}`",
                    f"- 截图：`{screenshot_path}`",
                    "",
                    "### 期望岗位识别",
                    "",
                    "```json",
                    json.dumps(page_info.get("expected_jobs", []), ensure_ascii=False, indent=2),
                    "```",
                    "",
                    "### 页面文本样本",
                    "",
                    "```text",
                    dom.get("bodyTextSample", ""),
                    "```",
                ]
            ),
        )

        append_markdown(
            self.settings.docs_dir / "boss-selectors.md",
            "\n".join(
                [
                    f"## {run_id} 候选元素",
                    "",
                    "### 链接候选",
                    "```json",
                    json.dumps(links, ensure_ascii=False, indent=2),
                    "```",
                    "",
                    "### 按钮候选",
                    "```json",
                    json.dumps(buttons, ensure_ascii=False, indent=2),
                    "```",
                    "",
                    "### 输入框候选",
                    "```json",
                    json.dumps(inputs, ensure_ascii=False, indent=2),
                    "```",
                    "",
                    "### 岗位卡片候选",
                    "```json",
                    json.dumps(likely_cards, ensure_ascii=False, indent=2),
                    "```",
                ]
            ),
        )

        append_markdown(
            self.settings.docs_dir / "boss-flow.md",
            "\n".join(
                [
                    f"## {run_id} 当前可确认路径",
                    "",
                    "1. 连接 Edge CDP。",
                    f"2. 打开 `{self.settings.boss_jobs_url}`。",
                    "3. 等待 DOMContentLoaded 和页面稳定。",
                    "4. 检查页面是否被关闭或回到首页。",
                    "5. 截图并记录页面结构。",
                    "",
                    "下一步需要基于 `boss-selectors.md` 中的候选元素，确认岗位卡片、详情区、薪资、城市、JD 和“立即沟通”按钮的稳定选择器。",
                ]
            ),
        )
