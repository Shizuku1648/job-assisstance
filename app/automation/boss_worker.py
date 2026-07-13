from __future__ import annotations

import asyncio
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from app.automation.artifacts import append_markdown, ensure_file, local_now_slug
from app.automation.edge import cdp_port_is_open, launch_edge_for_cdp, open_edge_url, wait_for_cdp
from app.config import ROOT_DIR, Settings
from app.contact_quota import BOSS_TIMEZONE, contact_batch_size, get_contact_quota, utc_text
from app.database import Database
from app.models import WorkerStatus


class BossWorker:
    def __init__(self, settings: Settings, db: Database) -> None:
        self.settings = settings
        self.db = db
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._status = WorkerStatus(False, "idle", "未运行")
        self._reconcile_contact_history()

    @property
    def status(self) -> WorkerStatus:
        return self._status

    async def start_explore(self) -> bool:
        if self._task and not self._task.done():
            return False
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run_explore())
        return True

    async def start_contact_loop(self, limit: int = 1) -> bool:
        if self._task and not self._task.done():
            return False
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run_contact_loop(limit=limit))
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

    async def _run_contact_loop(self, limit: int) -> None:
        run_id = local_now_slug()
        self._ensure_artifacts()
        self._status = WorkerStatus(True, "contact_loop", f"开始运行，目标沟通 {limit} 位 Boss")
        results: list[dict[str, Any]] = []
        max_attempts_per_iteration = 3
        quota_exhausted = False
        starting_contacted_today = get_contact_quota(
            self.db,
            self.settings.daily_contact_limit,
        )["contacted_today"]

        def contacted_during_run() -> int:
            current = get_contact_quota(self.db, self.settings.daily_contact_limit)["contacted_today"]
            return max(int(current) - int(starting_contacted_today), 0)

        try:
            while contacted_during_run() < limit:
                if self._stop_event.is_set():
                    break
                batch_contacted = False
                for attempt in range(1, max_attempts_per_iteration + 1):
                    quota = get_contact_quota(self.db, self.settings.daily_contact_limit)
                    contacted_so_far = contacted_during_run()
                    batch_size = contact_batch_size(limit - contacted_so_far, quota["remaining"])
                    if batch_size <= 0:
                        quota_exhausted = True
                        break
                    self._status = WorkerStatus(
                        True,
                        "contact_loop",
                        (
                            f"正在准备第 {contacted_so_far + 1}/{limit} 位 Boss"
                            f"（并发批次 {batch_size}，尝试 {attempt}/{max_attempts_per_iteration}）"
                        ),
                    )
                    result = await asyncio.to_thread(
                        self._run_contact_once,
                        run_id,
                        contacted_so_far + 1,
                        batch_size,
                    )
                    result["attempt"] = attempt
                    results.append(result)
                    actual_contacted = contacted_during_run()
                    result["actual_contacted_during_run"] = actual_contacted
                    if actual_contacted > contacted_so_far:
                        batch_contacted = True
                        break
                    if self._stop_event.is_set():
                        break
                    await asyncio.sleep(2)
                if not batch_contacted:
                    break
                await asyncio.sleep(1.5)

            contacted_count = contacted_during_run()
            success_count = sum(int(item.get("success_count", 0)) for item in results)
            payload = {
                "run_id": run_id,
                "limit": limit,
                "contacted_count": contacted_count,
                "success_count": success_count,
                "attempt_count": len(results),
                "quota_exhausted": quota_exhausted,
                "quota": get_contact_quota(self.db, self.settings.daily_contact_limit),
                "results": results,
            }
            loop_log_path = self.settings.logs_dir / f"{run_id}-contact-loop.json"
            loop_log_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            self.db.log_event(
                event_type="contact_loop",
                action="run_contact_loop",
                after_state=json.dumps(payload, ensure_ascii=False)[:4000],
                success=contacted_count == limit,
            )
            append_markdown(
                self.settings.docs_dir / "boss-test-runs.md",
                "\n".join(
                    [
                        f"## {run_id} 批量沟通",
                        "",
                        f"- 目标沟通数：{limit}",
                        f"- 尝试次数：{len(results)}",
                        f"- 实际沟通数：{contacted_count}",
                        f"- 自定义消息发送成功数：{success_count}",
                        f"- 完整日志：`{loop_log_path}`",
                        f"- 结果：`{json.dumps(results, ensure_ascii=False)[:1000]}`",
                    ]
                ),
            )
            self._status = WorkerStatus(
                False,
                "idle",
                f"运行结束：已沟通 {contacted_count}/{limit} 位 Boss，消息发送成功 {success_count} 次",
            )
        except Exception as exc:
            self.db.log_event(
                event_type="contact_loop_failed",
                action="run_contact_loop",
                after_state=json.dumps({"run_id": run_id, "results": results}, ensure_ascii=False)[:4000],
                success=False,
                error=str(exc),
            )
            self._status = WorkerStatus(False, "error", f"运行失败：{exc}")

    def _run_contact_once(self, run_id: str, iteration: int, batch_size: int) -> dict[str, Any]:
        command = [
            "node",
            "scripts\\run_boss_match_communicate_send.mjs",
            "--send",
            "--batch-size",
            str(batch_size),
        ]
        try:
            completed = subprocess.run(
                command,
                cwd=ROOT_DIR,
                text=True,
                encoding="utf-8",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=900,
            )
        except subprocess.TimeoutExpired as exc:
            stdout = exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            stderr = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            return {
                "iteration": iteration,
                "returncode": -1,
                "success": False,
                "contacted": False,
                "contacted_count": 0,
                "success_count": 0,
                "batch_size": batch_size,
                "stdout_tail": stdout[-4000:],
                "stderr_tail": stderr[-4000:],
                "error": f"Node batch timed out after {exc.timeout} seconds",
            }
        result: dict[str, Any] = {
            "iteration": iteration,
            "returncode": completed.returncode,
            "success": completed.returncode == 0,
            "contacted": False,
            "contacted_count": 0,
            "success_count": 0,
            "batch_size": batch_size,
            "stdout_tail": completed.stdout[-4000:],
            "stderr_tail": completed.stderr[-4000:],
        }
        if completed.returncode == 0:
            try:
                parsed = json.loads(completed.stdout)
                result["parsed"] = parsed
                contacts = parsed.get("contacts")
                if not isinstance(contacts, list):
                    contacts = [
                        {
                            "match": parsed.get("match", {}),
                            "immediate": parsed.get("immediate", {}),
                            "sendMessage": parsed.get("sendMessage", {}),
                        }
                    ]
                contacted_job_ids: list[int] = []
                sent_count = 0
                for contact in contacts:
                    immediate = contact.get("immediate", {})
                    send_message = contact.get("sendMessage", {})
                    job_id = contact.get("match", {}).get("job_id")
                    contacted = bool(job_id) and bool(immediate.get("clicked")) and bool(
                        immediate.get("sentDialog")
                        or immediate.get("continueAvailable")
                        or send_message.get("sent")
                    )
                    if contacted:
                        contacted_job_ids.append(int(job_id))
                    if send_message.get("sent"):
                        sent_count += 1
                result["contacted_count"] = len(contacted_job_ids)
                result["success_count"] = sent_count
                result["contacted"] = bool(contacted_job_ids)
                result["success"] = bool(parsed.get("safe")) and sent_count == len(contacted_job_ids)
                for job_id in contacted_job_ids:
                    self.db.mark_job_contacted(job_id)
            except (json.JSONDecodeError, TypeError, ValueError):
                result["success"] = False
        return result

    def _reconcile_contact_history(self) -> None:
        for log_path in self.settings.logs_dir.glob("*-match-communicate-send.json"):
            try:
                payload = json.loads(log_path.read_text(encoding="utf-8"))
                run_id = str(payload.get("runId", ""))
                try:
                    local_time = datetime.strptime(run_id, "%Y%m%d-%H%M%S").replace(tzinfo=BOSS_TIMEZONE)
                except ValueError:
                    local_time = datetime.fromtimestamp(log_path.stat().st_mtime, tz=BOSS_TIMEZONE)
                contacts = payload.get("contacts")
                records = contacts if isinstance(contacts, list) else [payload]
                for record in records:
                    immediate = record.get("immediate", {})
                    contacted = bool(immediate.get("clicked")) and bool(
                        immediate.get("sentDialog")
                        or immediate.get("continueAvailable")
                        or record.get("sendMessage", {}).get("sent")
                    )
                    match = record.get("match", {})
                    job_id = match.get("result", {}).get("job_id") or match.get("job_id")
                    if contacted and job_id:
                        self.db.mark_job_contacted(int(job_id), contacted_at=utc_text(local_time))
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                continue

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

            page_url = page.url
            page_title = await self._safe_title(page)
            self.settings.auth_state_path.parent.mkdir(parents=True, exist_ok=True)
            await context.storage_state(path=str(self.settings.auth_state_path))

            screenshot_path = self.settings.screenshots_dir / f"{local_now_slug()}-auth-state.png"
            screenshot_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                await page.screenshot(path=str(screenshot_path), full_page=True)
                saved_screenshot_path = str(screenshot_path)
            except Exception:
                saved_screenshot_path = ""
            return {
                "url": page_url,
                "title": page_title,
                "auth_state_path": str(self.settings.auth_state_path),
                "screenshot_path": saved_screenshot_path,
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
