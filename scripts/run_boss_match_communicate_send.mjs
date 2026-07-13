import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const cdpUrl = process.env.EDGE_CDP_URL || "http://127.0.0.1:9222";
const logDir = path.join(root, "runtime", "logs");
const docsDir = path.join(root, "runtime", "reports");
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(docsDir, { recursive: true });

const shouldSend = process.argv.includes("--send");
const batchSizeArgIndex = process.argv.indexOf("--batch-size");
const requestedBatchSize = batchSizeArgIndex >= 0 ? Number(process.argv[batchSizeArgIndex + 1]) : 1;
const batchSize = Number.isInteger(requestedBatchSize) ? Math.min(Math.max(requestedBatchSize, 1), 10) : 1;

const digitMap = new Map([
  ["\ue031", "0"], ["\ue032", "1"], ["\ue033", "2"], ["\ue034", "3"], ["\ue035", "4"],
  ["\ue036", "5"], ["\ue037", "6"], ["\ue038", "7"], ["\ue039", "8"], ["\ue030", "9"],
]);

function decodeBossText(text = "") {
  return Array.from(text).map((char) => digitMap.get(char) || char).join("");
}

function salaryRangeK(text = "") {
  const decoded = decodeBossText(text);
  const match = decoded.match(/(\d+)\s*-\s*(\d+)\s*K/i);
  return match ? { minK: Number(match[1]), maxK: Number(match[2]) } : null;
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return await response.json();
}

async function pageTarget(prefer = "jobs", timeoutMs = 0, urlMarker = "") {
  const preferredPath = prefer === "chat" ? "/web/geek/chat" : "/web/geek/jobs";
  const fallbackPath = prefer === "chat" ? "/web/geek/jobs" : "/web/geek/chat";
  const deadline = Date.now() + timeoutMs;

  do {
    try {
      const targets = await fetchJson(`${cdpUrl.replace(/\/$/, "")}/json`);
      const usablePages = targets.filter((target) =>
        target.type === "page" &&
        target.url.includes("zhipin.com") &&
        (target.url.includes("/web/geek/jobs") || target.url.includes("/web/geek/chat"))
      );
      const page =
        usablePages.find((target) => target.url.includes(preferredPath) && (!urlMarker || target.url.includes(urlMarker))) ||
        (!urlMarker ? usablePages.find((target) => target.url.includes(fallbackPath)) : null);
      if (page) return page;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);

  throw new Error(`No usable zhipin ${prefer} page target found`);
}

function isBossAutomationPage(target) {
  if (target.type !== "page" || !target.url.includes("zhipin.com")) return false;
  return target.url.includes("/web/geek/jobs") ||
    target.url.includes("/web/geek/chat") ||
    target.url.includes("/web/user") ||
    target.url === "https://www.zhipin.com/";
}

async function closeDuplicateBossPages(keepTargetId) {
  const targets = await fetchJson(`${cdpUrl.replace(/\/$/, "")}/json`);
  const duplicates = targets.filter((target) =>
    isBossAutomationPage(target) && target.id !== keepTargetId
  );
  for (const target of duplicates) {
    const response = await fetch(
      `${cdpUrl.replace(/\/$/, "")}/json/close/${encodeURIComponent(target.id)}`,
      { method: "PUT" },
    );
    if (!response.ok) throw new Error(`close duplicate target ${target.id} HTTP ${response.status}`);
  }
}

async function navigateTargetToJobs(target) {
  const ws = await connect(target.webSocketDebuggerUrl);
  try {
    await sendCdp(ws, "Page.navigate", { url: "https://www.zhipin.com/web/geek/jobs" });
  } finally {
    ws.close();
  }
  return await pageTarget("jobs", 15000);
}

async function openJobsPage() {
  let targets = [];
  try {
    targets = await fetchJson(`${cdpUrl.replace(/\/$/, "")}/json`);
  } catch {
    // CDP is not running yet; launch the project browser below.
  }
  const bossPages = targets.filter(isBossAutomationPage);
  const reusable =
    bossPages.find((target) => target.url.includes("/web/geek/jobs")) ||
    bossPages.find((target) => target.url.includes("/web/geek/chat")) ||
    bossPages[0];
  if (reusable) {
    await closeDuplicateBossPages(reusable.id);
    return reusable.url.includes("/web/geek/jobs")
      ? reusable
      : await navigateTargetToJobs(reusable);
  }

  const edgePaths = [
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const edgePath = edgePaths.find((candidate) => fs.existsSync(candidate));
  if (!edgePath) throw new Error("Microsoft Edge executable not found");
  const userDataDir = path.join(root, "runtime", "edge-profile");
  spawn(edgePath, [
    "--remote-debugging-port=9222",
    `--user-data-dir=${userDataDir}`,
    "https://www.zhipin.com/web/geek/jobs",
  ], {
    detached: true,
    stdio: "ignore",
  }).unref();
  const target = await pageTarget("jobs", 15000);
  await closeDuplicateBossPages(target.id);
  return target;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

function sendCdp(ws, method, params = {}) {
  const id = sendCdp.nextId++;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${method}: CDP target closed`));
    };
    const onError = () => {
      cleanup();
      reject(new Error(`${method}: CDP websocket error`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${method}: CDP response timeout`));
    }, 15000);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose, { once: true });
    ws.addEventListener("error", onError, { once: true });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
sendCdp.nextId = 1;

async function evalJson(ws, expression) {
  const result = await sendCdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const value = result.result?.value ?? result.result?.description;
  return JSON.parse(value);
}

const securityPromptExpression = String.raw`(
  location.pathname.startsWith('/web/user') ||
  Array.from(document.querySelectorAll(
    '[class*="captcha"], [class*="geetest"], [class*="verify"], [class*="login-dialog"], [class*="login-box"], [class*="security-check"]'
  )).some((el) => {
    const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return visible && /验证码|安全验证|请登录|扫码登录|手机号登录/.test(el.innerText || el.textContent || '');
  })
)`;

const snapshotExpression = String.raw`
JSON.stringify((() => {
  const clean = (value) => (value || '').toString().replace(/\s+/g, ' ').trim();
  const textOf = (el) => clean(el?.innerText || el?.textContent || '');
  const detailRoot =
    document.querySelector('.job-detail-container') ||
    document.querySelector('.job-detail') ||
    document.querySelector('.detail-content') ||
    document.querySelector('.job-detail-box') ||
    document;
  const activeCard = document.querySelector('.job-card-wrap.active');
  const activeJobName = activeCard?.querySelector('a.job-name');
  const jobs = Array.from(document.querySelectorAll('.job-card-wrap')).map((card, index) => {
    const nameEl = card.querySelector('a.job-name');
    const locationEl = card.querySelector('.company-location');
    return {
      index,
      title: textOf(nameEl),
      href: nameEl?.href || '',
      active: card.classList.contains('active'),
      className: card.className,
      city: textOf(locationEl),
      text: textOf(card),
    };
  }).slice(-100);
  const buttons = Array.from(detailRoot.querySelectorAll('a, button')).map((el, index) => ({
    index,
    text: textOf(el),
    className: (el.className || '').toString(),
    href: el.href || '',
  })).filter((item) => item.text).slice(0, 120);
  const dialogs = Array.from(document.querySelectorAll('.greet-boss-dialog, [class*=dialog], [class*=modal], [class*=popover]')).map((el) => ({
    className: (el.className || '').toString(),
    text: textOf(el).slice(0, 1200),
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
  })).filter((item) => item.text || item.visible);
  return {
    page: { href: location.href, title: document.title },
    activeIntent: textOf(document.querySelector('a.expect-item.active')),
    activeCardTitle: textOf(activeJobName),
    activeCardHref: activeJobName?.href || '',
    detailTitle: textOf(detailRoot.querySelector('.job-name, h1, h2, .name')),
    detailText: textOf(detailRoot).slice(0, 4000),
    buttons,
    jobs,
    dialogs,
    bodyText: textOf(document.body).slice(0, 5000),
    flags: {
      sentDialog: (document.body?.innerText || '').includes('已向BOSS发送消息'),
      continueChat: (document.body?.innerText || '').includes('继续沟通'),
      captchaOrLogin: ${securityPromptExpression},
    },
  };
})())
`;

async function snapshot(ws) {
  return await evalJson(ws, snapshotExpression);
}

async function waitForJobCards(ws, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  do {
    try {
      state = await snapshot(ws);
      if (state.jobs.length && state.activeIntent) {
        return { ready: true, state };
      }
    } catch {
      // Navigation can replace the execution context while the jobs page is loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  return { ready: false, state: state || await snapshot(ws) };
}

async function ensureShanghaiIntent(ws) {
  return await evalJson(ws, String.raw`
new Promise((resolve) => {
  const clean = (value) => (value || '').toString().replace(/\s+/g, ' ').trim();
  const before = {
    href: location.href,
    title: document.title,
    activeIntent: clean(document.querySelector('a.expect-item.active')?.innerText),
    intents: Array.from(document.querySelectorAll('a.expect-item')).map((el, index) => ({
      index,
      text: clean(el.innerText || el.textContent),
      active: el.classList.contains('active'),
    })),
  };
  const shanghai = Array.from(document.querySelectorAll('a.expect-item')).find((el) => clean(el.innerText || el.textContent).includes('上海'));
  if (!shanghai) return resolve(JSON.stringify({ clicked: false, reason: 'shanghai_intent_not_found', before }));
  if (shanghai.classList.contains('active')) return resolve(JSON.stringify({ clicked: false, reason: 'already_active', before }));
  shanghai.click();
  setTimeout(() => {
    const locations = Array.from(document.querySelectorAll('.job-card-wrap .company-location')).slice(0, 8).map((el) => clean(el.innerText || el.textContent));
    resolve(JSON.stringify({
      clicked: true,
      before,
      after: {
        href: location.href,
        title: document.title,
        activeIntent: clean(document.querySelector('a.expect-item.active')?.innerText),
        locations,
        jobCount: document.querySelectorAll('.job-card-wrap').length,
      },
    }));
  }, 2500);
})
`);
}

async function scrollJobList(ws) {
  return await evalJson(ws, String.raw`
new Promise((resolve) => {
  const cardsBefore = Array.from(document.querySelectorAll('.job-card-wrap'));
  const hrefsBefore = cardsBefore.map((card) => card.querySelector('a.job-name')?.href || '').filter(Boolean);
  const lastCard = cardsBefore.at(-1);
  const configuredList = document.querySelector('.job-list-container');
  const findScrollableAncestor = (element) => {
    let current = element;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 4) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  };
  const scroller =
    findScrollableAncestor(lastCard) ||
    findScrollableAncestor(configuredList) ||
    configuredList ||
    document.scrollingElement;
  const before = {
    cardCount: cardsBefore.length,
    scrollTop: scroller?.scrollTop ?? window.scrollY,
    scrollHeight: scroller?.scrollHeight ?? document.documentElement.scrollHeight,
    clientHeight: scroller?.clientHeight ?? window.innerHeight,
  };

  lastCard?.scrollIntoView({ block: 'end' });
  if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
    window.scrollTo(0, document.documentElement.scrollHeight);
  } else if (scroller) {
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
  }

  setTimeout(() => {
    const cardsAfter = Array.from(document.querySelectorAll('.job-card-wrap'));
    const hrefsAfter = cardsAfter.map((card) => card.querySelector('a.job-name')?.href || '').filter(Boolean);
    const previous = new Set(hrefsBefore);
    resolve(JSON.stringify({
      before,
      after: {
        cardCount: cardsAfter.length,
        scrollTop: scroller?.scrollTop ?? window.scrollY,
        scrollHeight: scroller?.scrollHeight ?? document.documentElement.scrollHeight,
        clientHeight: scroller?.clientHeight ?? window.innerHeight,
      },
      newUrls: hrefsAfter.filter((href) => !previous.has(href)),
      lastVisibleUrl: hrefsAfter.at(-1) || '',
    }));
  }, 2500);
})
`);
}

async function returnToJobsPage(ws) {
  let navigation = { method: "Page.navigate", historyEntryId: null };
  try {
    const history = await sendCdp(ws, "Page.getNavigationHistory");
    const entry = [...(history.entries || [])].reverse().find((item) => item.url.includes("/web/geek/jobs"));
    if (entry) {
      navigation = { method: "Page.navigateToHistoryEntry", historyEntryId: entry.id };
      await sendCdp(ws, "Page.navigateToHistoryEntry", { entryId: entry.id });
    } else {
      await sendCdp(ws, "Page.navigate", { url: "https://www.zhipin.com/web/geek/jobs" });
    }
  } catch (error) {
    navigation.error = String(error.message || error);
  }
  try {
    ws.close();
  } catch {
    // The chat target may already be navigating.
  }
  const target = await pageTarget("jobs", 15000);
  const jobsWs = await connect(target.webSocketDebuggerUrl);
  const ready = await waitForJobCards(jobsWs);
  return { ws: jobsWs, result: { ...navigation, target: { id: target.id, url: target.url }, ready } };
}

async function restoreCandidate(ws, candidate) {
  const maxScrolls = 20;
  let reloads = 0;
  for (let round = 0; round <= maxScrolls; round += 1) {
    const clickResult = await clickJobHref(ws, candidate.href);
    if (clickResult.clicked) {
      const state = await snapshot(ws);
      const restored = state.detailTitle.includes(candidate.title) && state.activeCardHref === candidate.href;
      if (restored) return { restored: true, round, clickResult, state };
    }
    if (round === maxScrolls) break;
    const scrollResult = await scrollJobList(ws);
    if (!scrollResult.newUrls.length && reloads < 1 && round >= 2) {
      reloads += 1;
      await sendCdp(ws, "Page.reload");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  try {
    await sendCdp(ws, "Page.navigate", { url: candidate.href });
    const deadline = Date.now() + 15000;
    do {
      try {
        const state = await snapshot(ws);
        const hasImmediate = state.buttons.some((button) => button.text === "立即沟通");
        if (state.detailTitle.includes(candidate.title) && hasImmediate) {
          return {
            restored: true,
            directNavigation: true,
            round: maxScrolls + 1,
            state,
          };
        }
      } catch {
        // The execution context is replaced while the detail page is loading.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
  } catch (error) {
    return {
      restored: false,
      reason: "candidate_direct_navigation_failed",
      href: candidate.href,
      error: String(error.message || error),
    };
  }
  return { restored: false, reason: "candidate_url_not_found_after_scroll_or_direct_navigation", href: candidate.href };
}

function selectCandidate(jobs) {
  const scored = jobs.map((job) => {
    const decodedText = decodeBossText(job.text);
    const salaryRange = salaryRangeK(job.text);
    const keywordScore = [
      /AI\s*Agent/i,
      /Agent/i,
      /智能体/,
      /AI应用/,
      /AI 应用/,
      /大模型应用/,
      /LLM/i,
      /RAG/i,
      /应用开发/,
    ].reduce((score, regex) => score + (regex.test(decodedText) ? 1 : 0), 0);
    return {
      ...job,
      decodedText,
      minK: salaryRange?.minK ?? null,
      maxK: salaryRange?.maxK ?? null,
      keywordScore,
    };
  });
  const candidates = scored
    .filter((job) => job.city.includes("上海") && job.minK !== null && job.maxK !== null && job.keywordScore > 0)
    .sort((a, b) => b.keywordScore - a.keywordScore || b.minK - a.minK || a.index - b.index);
  return { scored, candidates, candidate: candidates[0] };
}

async function dismissGreetDialog(ws) {
  return await evalJson(ws, String.raw`
new Promise((resolve) => {
  const clean = (value) => (value || '').toString().replace(/\s+/g, ' ').trim();
  const dialog = document.querySelector('.greet-boss-dialog');
  if (!dialog) return resolve(JSON.stringify({ clicked: false, reason: 'not_found' }));
  const close = dialog.querySelector('span.close') || Array.from(dialog.querySelectorAll('a, button')).find((el) => clean(el.innerText) === '留在此页');
  if (!close) return resolve(JSON.stringify({ clicked: false, reason: 'close_not_found', text: clean(dialog.innerText).slice(0, 500) }));
  close.click();
  setTimeout(() => resolve(JSON.stringify({
    clicked: true,
    stillVisible: !!document.querySelector('.greet-boss-dialog'),
    bodyHasSentDialog: (document.body?.innerText || '').includes('已向BOSS发送消息'),
    href: location.href,
    title: document.title,
  })), 800);
})
`);
}

async function clickJobName(ws, index) {
  return await evalJson(ws, `
new Promise((resolve) => {
  const clean = (value) => (value || '').toString().replace(/\\s+/g, ' ').trim();
  const card = document.querySelectorAll('.job-card-wrap')[${Number(index)}];
  const link = card?.querySelector('a.job-name');
  if (!card || !link) return resolve(JSON.stringify({ clicked: false, reason: 'not_found', index: ${Number(index)} }));
  link.scrollIntoView({ block: 'center' });
  setTimeout(() => {
    const before = {
      href: location.href,
      activeTitle: clean(document.querySelector('.job-card-wrap.active a.job-name')?.innerText),
      detailTitle: clean((document.querySelector('.job-detail-container') || document).querySelector('.job-name, h1, h2, .name')?.innerText),
    };
    link.click();
    setTimeout(() => {
      const detailRoot = document.querySelector('.job-detail-container') || document.querySelector('.job-detail') || document;
      resolve(JSON.stringify({
        clicked: true,
        index: ${Number(index)},
        title: clean(link.innerText),
        href: link.href,
        before,
        after: {
          href: location.href,
          activeTitle: clean(document.querySelector('.job-card-wrap.active a.job-name')?.innerText),
          detailTitle: clean(detailRoot.querySelector('.job-name, h1, h2, .name')?.innerText),
          bodyHasSentDialog: (document.body?.innerText || '').includes('已向BOSS发送消息'),
          captchaOrLogin: ${securityPromptExpression},
        },
      }));
    }, 2500);
  }, 300);
})
`);
}

async function clickJobHref(ws, href) {
  return await evalJson(ws, `
new Promise((resolve) => {
  const targetHref = ${JSON.stringify(href)};
  const targetPath = (() => { try { return new URL(targetHref).pathname; } catch { return targetHref; } })();
  const links = Array.from(document.querySelectorAll('.job-card-wrap a.job-name'));
  const link = links.find((item) => {
    try { return new URL(item.href).pathname === targetPath; } catch { return item.href === targetHref; }
  });
  if (!link) return resolve(JSON.stringify({ clicked: false, reason: 'href_not_found', href: targetHref }));
  link.scrollIntoView({ block: 'center' });
  setTimeout(() => {
    link.click();
    setTimeout(() => {
      const detailRoot = document.querySelector('.job-detail-container') || document.querySelector('.job-detail') || document;
      const activeLink = document.querySelector('.job-card-wrap.active a.job-name');
      resolve(JSON.stringify({
        clicked: true,
        href: link.href,
        activeHref: activeLink?.href || '',
        detailTitle: (detailRoot.querySelector('.job-name, h1, h2, .name')?.innerText || '').trim(),
      }));
    }, 2500);
  }, 300);
})
`);
}

async function extractDetailJob(ws, candidate) {
  return await evalJson(ws, `
JSON.stringify((() => {
  const clean = (value) => (value || '').toString().replace(/\\s+/g, ' ').trim();
  const textOf = (el) => clean(el?.innerText || el?.textContent || '');
  const detailRoot = document.querySelector('.job-detail-container') || document.querySelector('.job-detail') || document;
  const activeCard = document.querySelector('.job-card-wrap.active');
  const title = textOf(detailRoot.querySelector('.job-name, h1, h2, .name'));
  const salary = textOf(detailRoot.querySelector('.salary, .job-salary')) || (${JSON.stringify(candidate.text)}.match(/[\\ue030-\\ue039\\d]+\\s*-\\s*[\\ue030-\\ue039\\d]+K(?:·[\\ue030-\\ue039\\d]+薪)?/u) || [''])[0];
  const city = textOf(detailRoot.querySelector('.tag-list li:first-child, .location-address, .job-address')) || ${JSON.stringify(candidate.city)};
  const company =
    textOf(detailRoot.querySelector('.company-name')) ||
    textOf(detailRoot.querySelector('.boss-info .name')) ||
    textOf(activeCard?.querySelector('.company-name, .boss-name, .boss-info')) ||
    (${JSON.stringify(candidate.text)}.split(' ').slice(-2, -1)[0] || '');
  const jd =
    textOf(detailRoot.querySelector('.job-sec-text')) ||
    textOf(detailRoot.querySelector('.job-detail-section')) ||
    textOf(detailRoot);
  return {
    title,
    company,
    salary,
    city,
    jd,
    url: ${JSON.stringify(candidate.href)},
    pageHref: location.href,
    pageTitle: document.title,
  };
})())
`);
}

function matchJobsWithPython(runId, batchIndex, jobs) {
  const snapshotPath = path.join(logDir, `${runId}-job-batch-${batchIndex}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify({ jobs }, null, 2), "utf8");
  const python = path.join(root, ".venv", "Scripts", "python.exe");
  const result = spawnSync(python, ["scripts/match_job_batch.py", snapshotPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    timeout: 180000,
  });
  if (result.status !== 0) {
    throw new Error(`match_job_batch.py failed: ${result.stderr || result.stdout}`);
  }
  return { snapshotPath, result: JSON.parse(result.stdout) };
}

function assertCanClickImmediate(candidate, state, matchResult) {
  const immediate = state.buttons.find((button) => button.text === "立即沟通");
  if (!matchResult?.matched) return { ok: false, reason: "AI 匹配结果不是 true" };
  if (!candidate?.title || !state.detailTitle.includes(candidate.title)) {
    return { ok: false, reason: `详情岗位未切换到候选岗位：candidate=${candidate?.title || ""}, detailTitle=${state.detailTitle}` };
  }
  if (!immediate) return { ok: false, reason: "未找到立即沟通按钮" };
  if ((immediate.className || "").includes("is-disabled")) return { ok: false, reason: `立即沟通按钮不可用：${immediate.className}` };
  if (state.flags.sentDialog || state.bodyText.includes("已向BOSS发送消息")) return { ok: false, reason: "页面已经存在发送成功弹窗，禁止重复点击" };
  if (state.flags.captchaOrLogin) return { ok: false, reason: "页面出现登录/验证码/安全验证文本" };
  return { ok: true, reason: "ok" };
}

async function clickImmediate(ws) {
  return await evalJson(ws, String.raw`
new Promise((resolve) => {
  const clean = (value) => (value || '').toString().replace(/\s+/g, ' ').trim();
  const detailRoot = document.querySelector('.job-detail-container') || document.querySelector('.job-detail') || document;
  const button = Array.from(detailRoot.querySelectorAll('a, button')).find((el) => clean(el.innerText || el.textContent) === '立即沟通');
  if (!button) return resolve(JSON.stringify({ clicked: false, reason: 'not_found' }));
  if ((button.className || '').toString().includes('is-disabled')) return resolve(JSON.stringify({ clicked: false, reason: 'disabled', className: button.className.toString() }));
  button.scrollIntoView({ block: 'center' });
  setTimeout(() => {
    button.click();
    setTimeout(() => {
      const dialog = document.querySelector('.greet-boss-dialog');
      resolve(JSON.stringify({
        clicked: true,
        href: location.href,
        title: document.title,
        sentDialog: !!dialog && (document.body?.innerText || '').includes('已向BOSS发送消息'),
        dialogText: clean(dialog?.innerText).slice(0, 1000),
        buttons: Array.from((dialog || document).querySelectorAll('a, button')).map((el, index) => ({
          index,
          text: clean(el.innerText || el.textContent),
          className: (el.className || '').toString(),
          href: el.href || '',
        })).filter((item) => item.text).slice(0, 40),
        captchaOrLogin: ${securityPromptExpression},
      }));
    }, 3000);
  }, 300);
})
`);
}

async function continueToChat(ws, candidate) {
  try {
    return await evalJson(ws, String.raw`
new Promise((resolve) => {
  const clean = (value) => (value || '').toString().replace(/\s+/g, ' ').trim();
  const dialog = document.querySelector('.greet-boss-dialog');
  const button = dialog ? Array.from(dialog.querySelectorAll('a, button')).find((el) => clean(el.innerText || el.textContent) === '继续沟通') : null;
  if (!button) return resolve(JSON.stringify({ clicked: false, reason: 'not_found' }));
  button.click();
  setTimeout(() => {
    const inputs = Array.from(document.querySelectorAll('textarea, input[type=text], [contenteditable=true], [contenteditable="true"]')).map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      className: (el.className || '').toString(),
      placeholder: el.getAttribute('placeholder') || '',
      text: clean(el.value || el.innerText || el.textContent).slice(0, 300),
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    }));
    const buttons = Array.from(document.querySelectorAll('a, button')).map((el, index) => ({
      index,
      text: clean(el.innerText || el.textContent),
      className: (el.className || '').toString(),
      href: el.href || '',
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    })).filter((item) => item.text).slice(0, 120);
    resolve(JSON.stringify({
      clicked: true,
      href: location.href,
      title: document.title,
      bodySample: clean(document.body?.innerText).slice(0, 3000),
      inputs,
      buttons,
      captchaOrLogin: ${securityPromptExpression},
    }));
  }, 3500);
})
`);
  } catch (error) {
    const jobId = (candidate?.href || "").match(/job_detail\/([^.?/]+)/)?.[1] || "";
    const target = await pageTarget("chat", 10000, jobId);
    const newWs = await connect(target.webSocketDebuggerUrl);
    try {
      const state = await evalJson(newWs, String.raw`
JSON.stringify((() => {
  const clean = (value) => (value || '').toString().replace(/\s+/g, ' ').trim();
  const inputs = Array.from(document.querySelectorAll('textarea, input[type=text], [contenteditable=true], [contenteditable="true"]')).map((el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    className: (el.className || '').toString(),
    placeholder: el.getAttribute('placeholder') || '',
    text: clean(el.value || el.innerText || el.textContent).slice(0, 300),
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
  }));
  const buttons = Array.from(document.querySelectorAll('a, button')).map((el, index) => ({
    index,
    text: clean(el.innerText || el.textContent),
    className: (el.className || '').toString(),
    href: el.href || '',
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
  })).filter((item) => item.text).slice(0, 120);
  return {
    clicked: true,
    reconnectedAfterNavigation: true,
    navigationError: ${JSON.stringify(String(error.message || error))},
    href: location.href,
    title: document.title,
    bodySample: clean(document.body?.innerText).slice(0, 3000),
    inputs,
    buttons,
    captchaOrLogin: ${securityPromptExpression},
  };
})())
`);
      return state;
    } finally {
      newWs.close();
    }
  }
}

async function sendChatMessage(ws, message, candidate) {
  return await evalJson(ws, `
new Promise((resolve) => {
  const message = ${JSON.stringify(message)};
  const candidateTitle = ${JSON.stringify(candidate.title)};
  const clean = (value) => (value || '').toString().replace(/\\s+/g, ' ').trim();
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const startedAt = Date.now();
  const findInput = () => document.querySelector('#chat-input.chat-input') ||
    Array.from(document.querySelectorAll('textarea, .chat-input, [contenteditable=true], [contenteditable="true"]'))
      .find((el) => visible(el) && !el.disabled && !el.readOnly);
  const sendWhenReady = () => {
    const input = findInput();
    const candidateVisible = (document.body?.innerText || '').includes(candidateTitle);
    if ((!input || !candidateVisible) && Date.now() - startedAt < 10000) {
      return setTimeout(sendWhenReady, 250);
    }
    if (!input) return resolve(JSON.stringify({ sent: false, reason: 'input_not_found', href: location.href, title: document.title }));
    if (!candidateVisible) {
      return resolve(JSON.stringify({ sent: false, reason: 'candidate_title_not_visible_in_chat', candidateTitle, href: location.href, title: document.title }));
    }
    if ((document.body?.innerText || '').includes(message)) {
      return resolve(JSON.stringify({ sent: true, reason: 'message_already_visible', href: location.href, title: document.title }));
    }
    input.focus();
    if (input.tagName.toLowerCase() === 'textarea') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter ? setter.call(input, message) : (input.value = message);
    } else {
      input.textContent = message;
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setTimeout(() => {
      const buttons = Array.from(document.querySelectorAll('button, a')).filter(visible);
      const sendButton = buttons.find((el) => clean(el.innerText || el.textContent) === '发送' && !(el.className || '').toString().includes('disabled'));
      if (!sendButton) {
        return resolve(JSON.stringify({
          sent: false,
          reason: 'send_button_not_found',
          inputText: clean(input.value || input.innerText || input.textContent),
          href: location.href,
          title: document.title,
          visibleButtons: buttons.map((el) => clean(el.innerText || el.textContent)).filter(Boolean).slice(0, 80),
        }));
      }
      sendButton.click();
      setTimeout(() => resolve(JSON.stringify({
        sent: (document.body?.innerText || '').includes(message),
        reason: (document.body?.innerText || '').includes(message) ? 'message_visible_after_send' : 'clicked_send_but_message_not_visible',
        href: location.href,
        title: document.title,
        inputTextAfter: clean(input.value || input.innerText || input.textContent),
        bodyHasMessage: (document.body?.innerText || '').includes(message),
      })), 2500);
    }, 700);
  };
  sendWhenReady();
})
`);
}

function writeDocs(runId, payload) {
  const candidate = payload.candidate || {};
  const match = payload.match?.result || {};
  const doc = [
    `## ${runId} 匹配-立即沟通-发消息实测`,
    "",
    `- 模式：${shouldSend ? "真实发送" : "dry-run，不点击立即沟通"}`,
    `- 原始日志：\`${payload.logPath}\``,
    `- 安全检查：${payload.safe ? "ok" : "failed"}`,
    `- 候选岗位：${candidate.title || ""} / ${candidate.city || ""} / minK=${candidate.minK ?? ""}`,
    `- AI 匹配：${match.matched === true ? "true" : "false"}`,
    `- AI 理由：${match.reason || ""}`,
    `- 生成消息：${match.message || ""}`,
    `- 立即沟通保护：${payload.guard?.ok ? "allowed" : "blocked"} ${payload.guard?.reason || ""}`,
    `- 立即沟通结果：${payload.immediate?.clicked ? "clicked" : "not clicked"} ${payload.immediate?.dialogText || payload.immediate?.reason || ""}`,
    `- 继续沟通结果：${payload.continueChat?.clicked ? "clicked" : "not clicked"} ${payload.continueChat?.reason || ""}`,
    `- 自定义消息发送：${payload.sendMessage?.sent ? "sent" : "not sent"} ${payload.sendMessage?.reason || ""}`,
    "",
  ].join("\n");
  fs.appendFileSync(path.join(docsDir, "boss-test-runs.md"), doc, "utf8");
  fs.appendFileSync(path.join(docsDir, "boss-flow.md"), doc, "utf8");
}

async function main() {
  const runId = stamp();
  const beforeTarget = await openJobsPage();
  let ws = await connect(beforeTarget.webSocketDebuggerUrl);
  const steps = [];

  const initialReady = await waitForJobCards(ws);
  const before = initialReady.state;
  steps.push({ step: "before", ready: initialReady.ready, state: before });
  if (!before.activeIntent.includes("上海") || !before.jobs.some((job) => job.city.includes("上海"))) {
    const intentResult = await ensureShanghaiIntent(ws);
    steps.push({ step: "ensure_shanghai_intent", result: intentResult, state: await snapshot(ws) });
  }
  if (before.flags.sentDialog) {
    steps.push({ step: "dismiss_existing_greet_dialog", result: await dismissGreetDialog(ws) });
  }

  let selectedCandidate = null;
  let selectedJob = null;
  let selectedMatch = null;
  let selectedState = null;
  const candidateAttempts = [];
  const batchMatches = [];
  const readyItems = [];
  let pendingBatch = [];
  const attemptedUrls = new Set();
  const observedUrls = new Set();
  const maxScrollRounds = 20;
  const maxStagnantScrolls = 3;
  const maxReloads = 1;
  let stagnantScrolls = 0;
  let reloads = 0;
  let stateForSelection = await snapshot(ws);

  const processPendingBatch = () => {
    if (!pendingBatch.length) return false;
    const batchIndex = batchMatches.length + 1;
    const batchItems = pendingBatch;
    pendingBatch = [];
    const batchMatch = matchJobsWithPython(runId, batchIndex, batchItems.map((item) => item.job));
    batchMatches.push(batchMatch);
    steps.push({
      step: "match_candidate_batch",
      batchIndex,
      requestedBatchSize: batchSize,
      collectedCount: batchItems.length,
      result: batchMatch.result,
    });

    for (const result of batchMatch.result.results || []) {
      const item = batchItems[result.input_index] || batchItems.find((candidate) => candidate.job.url === result.url);
      if (!item) continue;
      item.match = { snapshotPath: batchMatch.snapshotPath, result };
      if (result.matched && result.ready && result.message) {
        readyItems.push(item);
      }
    }
    const firstReady = readyItems[0];
    if (!selectedCandidate && firstReady) {
      selectedCandidate = firstReady.candidate;
      selectedJob = firstReady.job;
      selectedMatch = firstReady.match;
    }
    return Boolean(selectedCandidate);
  };

  for (let round = 0; round <= maxScrollRounds && !selectedCandidate; round += 1) {
    const selection = selectCandidate(stateForSelection.jobs);
    const visibleUrls = stateForSelection.jobs.map((job) => job.href).filter(Boolean);
    const newVisibleUrls = visibleUrls.filter((href) => !observedUrls.has(href));
    visibleUrls.forEach((href) => observedUrls.add(href));
    const candidates = selection.candidates.filter((candidate) => candidate.href && !attemptedUrls.has(candidate.href));
    steps.push({
      step: "select_candidates",
      round,
      state: stateForSelection,
      selection,
      newVisibleUrlCount: newVisibleUrls.length,
      unattemptedCandidateCount: candidates.length,
    });

    for (const candidate of candidates) {
      attemptedUrls.add(candidate.href);
      let afterClick = await snapshot(ws);
      if (!afterClick.detailTitle.includes(candidate.title) || afterClick.activeCardHref !== candidate.href) {
        const clickResult = await clickJobName(ws, candidate.index);
        afterClick = await snapshot(ws);
        steps.push({ step: "click_candidate_job_name", round, candidate, result: clickResult, state: afterClick });
      }

      const detailMatches = afterClick.detailTitle.includes(candidate.title) && afterClick.activeCardHref === candidate.href;
      if (!detailMatches) {
        const attempt = {
          round,
          candidate,
          detailMatches,
          reason: `详情岗位未切换到候选岗位：candidate=${candidate.title}, detail=${afterClick.detailTitle}, activeHref=${afterClick.activeCardHref}`,
        };
        candidateAttempts.push(attempt);
        steps.push({ step: "candidate_detail_mismatch", attempt });
        continue;
      }

      const job = await extractDetailJob(ws, candidate);
      const attempt = { round, candidate, detailMatches, job, match: null };
      candidateAttempts.push(attempt);
      pendingBatch.push(attempt);
      steps.push({ step: "extract_candidate_for_batch", attempt });
      if (pendingBatch.length >= batchSize && processPendingBatch()) {
        break;
      }
    }

    if (selectedCandidate || round === maxScrollRounds) break;

    const scrollResult = await scrollJobList(ws);
    const nextState = await snapshot(ws);
    const nextUrls = nextState.jobs.map((job) => job.href).filter(Boolean);
    const discoveredAfterScroll = nextUrls.filter((href) => !observedUrls.has(href));
    stagnantScrolls = discoveredAfterScroll.length ? 0 : stagnantScrolls + 1;
    steps.push({
      step: "scroll_job_list",
      round,
      result: scrollResult,
      discoveredUrlCount: discoveredAfterScroll.length,
      stagnantScrolls,
      state: nextState,
    });
    stateForSelection = nextState;
    if (stagnantScrolls >= maxStagnantScrolls) {
      if (reloads >= maxReloads) break;
      reloads += 1;
      await sendCdp(ws, "Page.reload");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      stateForSelection = await snapshot(ws);
      stagnantScrolls = 0;
      steps.push({
        step: "reload_job_list_after_stagnation",
        round,
        reloads,
        state: stateForSelection,
      });
    }
  }

  if (!selectedCandidate && pendingBatch.length) {
    processPendingBatch();
  }

  if (!selectedCandidate || !selectedJob || !selectedMatch) {
    const afterTarget = await pageTarget();
    const payload = {
      runId,
      safe: afterTarget.url.includes("zhipin.com") && afterTarget.url !== "https://www.zhipin.com/" && !afterTarget.url.includes("/web/user"),
      beforeTarget,
      afterTarget,
      batchSize,
      batchMatches,
      candidateAttempts,
      guard: { ok: false, reason: "滚动加载后仍未找到通过 AI 匹配的新岗位" },
      immediate: { clicked: false, reason: "no_ai_matched_candidate" },
      continueChat: { clicked: false, reason: "no_ai_matched_candidate" },
      sendMessage: { sent: false, reason: "no_ai_matched_candidate" },
      steps,
    };
    const logPath = path.join(logDir, `${runId}-match-communicate-send.json`);
    payload.logPath = logPath;
    fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf8");
    writeDocs(runId, { ...payload, candidate: {}, match: { result: { matched: false, reason: "滚动加载后仍未找到通过 AI 匹配的新岗位", message: "" } } });
    ws.close();
    console.log(JSON.stringify({
      logPath,
      safe: payload.safe,
      batchSize,
      batchCount: batchMatches.length,
      contactedCount: 0,
      successCount: 0,
      contacts: [],
      matchedCandidate: null,
      attempts: candidateAttempts.map((item) => ({
        index: item.candidate?.index,
        round: item.round,
        title: item.candidate?.title,
        city: item.candidate?.city,
        minK: item.candidate?.minK,
        maxK: item.candidate?.maxK,
        ready: item.match?.result?.ready ?? false,
        matched: item.match?.result?.matched ?? false,
        reason: item.match?.result?.reason || item.reason || "",
      })),
      afterTarget: { url: afterTarget.url, title: afterTarget.title },
    }, null, 2));
    return;
  }

  const contacts = [];
  for (let contactIndex = 0; contactIndex < readyItems.length; contactIndex += 1) {
    const item = readyItems[contactIndex];
    if (contactIndex > 0) {
      const returned = await returnToJobsPage(ws);
      ws = returned.ws;
      steps.push({ step: "return_to_jobs_for_next_contact", contactIndex, result: returned.result });
    }

    const currentState = await snapshot(ws);
    if (currentState.flags.sentDialog) {
      steps.push({
        step: "dismiss_greet_before_next_contact",
        contactIndex,
        result: await dismissGreetDialog(ws),
      });
    }

    const restored = await restoreCandidate(ws, item.candidate);
    steps.push({ step: "restore_batch_candidate", contactIndex, candidate: item.candidate, result: restored });
    if (!restored.restored) {
      contacts.push({
        candidate: item.candidate,
        job: item.job,
        match: item.match,
        guard: { ok: false, reason: restored.reason },
        immediate: { clicked: false, reason: restored.reason },
        continueChat: { clicked: false, reason: restored.reason },
        sendMessage: { sent: false, reason: restored.reason },
      });
      continue;
    }

    const preImmediate = restored.state;
    const guard = assertCanClickImmediate(item.candidate, preImmediate, item.match.result);
    steps.push({ step: "guard_immediate", contactIndex, guard, state: preImmediate });
    let immediate = { clicked: false, reason: shouldSend ? guard.reason : "dry_run" };
    let continueChat = { clicked: false, reason: shouldSend ? "not_started" : "dry_run" };
    let sendMessage = { sent: false, reason: shouldSend ? "not_started" : "dry_run" };

    if (shouldSend && guard.ok) {
      immediate = await clickImmediate(ws);
      steps.push({ step: "click_immediate", contactIndex, result: immediate, state: await snapshot(ws) });
      if (immediate.clicked && immediate.sentDialog && !immediate.captchaOrLogin) {
        continueChat = await continueToChat(ws, item.candidate);
        let postContinueState = null;
        if (continueChat.reconnectedAfterNavigation) {
          try {
            ws.close();
          } catch {
            // The page may have already navigated away from the old inspected target.
          }
          const jobId = (item.candidate.href || "").match(/job_detail\/([^.?/]+)/)?.[1] || "";
          const chatTarget = await pageTarget("chat", 10000, jobId);
          ws = await connect(chatTarget.webSocketDebuggerUrl);
        }
        try {
          postContinueState = await snapshot(ws);
        } catch (error) {
          postContinueState = { error: String(error.message || error) };
        }
        steps.push({ step: "continue_to_chat", contactIndex, result: continueChat, state: postContinueState });
        if (continueChat.clicked && !continueChat.captchaOrLogin) {
          sendMessage = await sendChatMessage(ws, item.match.result.message, item.candidate);
          let postSendState = null;
          try {
            postSendState = await snapshot(ws);
          } catch (error) {
            postSendState = { error: String(error.message || error) };
          }
          steps.push({ step: "send_chat_message", contactIndex, result: sendMessage, state: postSendState });
        }
      }
    }

    contacts.push({
      candidate: item.candidate,
      job: item.job,
      match: item.match,
      detailMatches: restored.restored,
      guard,
      immediate,
      continueChat,
      sendMessage,
    });
  }

  try {
    ws.close();
  } catch {
    // Ignore close errors after navigation.
  }
  const afterTarget = await pageTarget();
  const safe = afterTarget.url.includes("zhipin.com") && afterTarget.url !== "https://www.zhipin.com/" && !afterTarget.url.includes("/web/user");
  const contactedCount = contacts.filter((item) => item.immediate.clicked && (item.immediate.sentDialog || item.sendMessage.sent)).length;
  const successCount = contacts.filter((item) => item.sendMessage.sent).length;
  const firstContact = contacts[0];
  const payload = {
    runId,
    safe,
    beforeTarget,
    afterTarget,
    batchSize,
    batchMatches,
    contactedCount,
    successCount,
    contacts,
    candidate: firstContact?.candidate || selectedCandidate,
    detailMatches: firstContact?.detailMatches || false,
    job: firstContact?.job || selectedJob,
    match: firstContact?.match || selectedMatch,
    candidateAttempts,
    guard: firstContact?.guard || { ok: false, reason: "no_contact_result" },
    immediate: firstContact?.immediate || { clicked: false, reason: "no_contact_result" },
    continueChat: firstContact?.continueChat || { clicked: false, reason: "no_contact_result" },
    sendMessage: firstContact?.sendMessage || { sent: false, reason: "no_contact_result" },
    steps,
  };
  const logPath = path.join(logDir, `${runId}-match-communicate-send.json`);
  payload.logPath = logPath;
  fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf8");
  writeDocs(runId, payload);
  console.log(JSON.stringify({
    logPath,
    safe,
    batchSize,
    batchCount: batchMatches.length,
    contactedCount,
    successCount,
    contacts: contacts.map((item) => ({
      candidate: {
        title: item.candidate.title,
        href: item.candidate.href,
      },
      match: item.match.result,
      guard: item.guard,
      immediate: item.immediate,
      continueChat: item.continueChat,
      sendMessage: item.sendMessage,
    })),
    candidate: {
      index: firstContact?.candidate.index ?? selectedCandidate.index,
      title: firstContact?.candidate.title || selectedCandidate.title,
      city: firstContact?.candidate.city || selectedCandidate.city,
      minK: firstContact?.candidate.minK ?? selectedCandidate.minK,
      maxK: firstContact?.candidate.maxK ?? selectedCandidate.maxK,
      keywordScore: firstContact?.candidate.keywordScore ?? selectedCandidate.keywordScore,
    },
    match: firstContact?.match.result || selectedMatch.result,
    attempts: candidateAttempts.map((item) => ({
      index: item.candidate?.index,
      title: item.candidate?.title,
      matched: item.match?.result?.matched ?? false,
      reason: item.match?.result?.reason || item.reason || "",
    })),
    guard: firstContact?.guard,
    immediate: firstContact?.immediate,
    continueChat: {
      clicked: firstContact?.continueChat.clicked,
      reason: firstContact?.continueChat.reason,
      href: firstContact?.continueChat.href,
      title: firstContact?.continueChat.title,
      inputs: firstContact?.continueChat.inputs,
    },
    sendMessage: firstContact?.sendMessage,
    afterTarget: { url: afterTarget.url, title: afterTarget.title },
  }, null, 2));
}

await main();
