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
  }).slice(0, 30);
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
      captchaOrLogin: /验证码|登录|安全验证/.test(document.body?.innerText || ''),
    },
  };
})())
`;

async function snapshot(ws) {
  return await evalJson(ws, snapshotExpression);
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
          captchaOrLogin: /验证码|登录|安全验证/.test(document.body?.innerText || ''),
        },
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

function matchJobWithPython(runId, job) {
  const snapshotPath = path.join(logDir, `${runId}-selected-job-snapshot.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify({ job }, null, 2), "utf8");
  const python = path.join(root, ".venv", "Scripts", "python.exe");
  const result = spawnSync(python, ["scripts/match_job_snapshot.py", snapshotPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    timeout: 120000,
  });
  if (result.status !== 0) {
    throw new Error(`match_job_snapshot.py failed: ${result.stderr || result.stdout}`);
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
        captchaOrLogin: /验证码|登录|安全验证/.test(document.body?.innerText || ''),
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
      captchaOrLogin: /验证码|登录|安全验证/.test(document.body?.innerText || ''),
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
    captchaOrLogin: /验证码|登录|安全验证/.test(document.body?.innerText || ''),
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

  const before = await snapshot(ws);
  steps.push({ step: "before", state: before });
  if (!before.activeIntent.includes("上海") || !before.jobs.some((job) => job.city.includes("上海"))) {
    const intentResult = await ensureShanghaiIntent(ws);
    steps.push({ step: "ensure_shanghai_intent", result: intentResult, state: await snapshot(ws) });
  }
  if (before.flags.sentDialog) {
    steps.push({ step: "dismiss_existing_greet_dialog", result: await dismissGreetDialog(ws) });
  }

  let stateForSelection = await snapshot(ws);
  let selection = selectCandidate(stateForSelection.jobs);
  steps.push({ step: "select_candidates", state: stateForSelection, selection });
  if (!selection.candidates.length) {
    await sendCdp(ws, "Page.reload");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    stateForSelection = await snapshot(ws);
    selection = selectCandidate(stateForSelection.jobs);
    steps.push({ step: "reload_and_select_candidates", state: stateForSelection, selection });
  }
  if (!selection.candidates.length) throw new Error("No local-rule candidates found");

  let selectedCandidate = null;
  let selectedJob = null;
  let selectedMatch = null;
  let selectedState = stateForSelection;
  const candidateAttempts = [];
  for (const candidate of selection.candidates) {
    let afterClick = await snapshot(ws);
    if (!afterClick.detailTitle.includes(candidate.title) || afterClick.activeCardHref !== candidate.href) {
      const clickResult = await clickJobName(ws, candidate.index);
      afterClick = await snapshot(ws);
      steps.push({ step: "click_candidate_job_name", candidate, result: clickResult, state: afterClick });
    }

    const detailMatches = afterClick.detailTitle.includes(candidate.title) && afterClick.activeCardHref === candidate.href;
    if (!detailMatches) {
      const attempt = {
        candidate,
        detailMatches,
        reason: `详情岗位未切换到候选岗位：candidate=${candidate.title}, detail=${afterClick.detailTitle}, activeHref=${afterClick.activeCardHref}`,
      };
      candidateAttempts.push(attempt);
      steps.push({ step: "candidate_detail_mismatch", attempt });
      continue;
    }

    const job = await extractDetailJob(ws, candidate);
    const match = matchJobWithPython(runId, job);
    const attempt = { candidate, detailMatches, job, match };
    candidateAttempts.push(attempt);
    steps.push({ step: "extract_and_match_candidate", attempt });
    if (match.result.skipped) {
      continue;
    }
    if (match.result.matched) {
      selectedCandidate = candidate;
      selectedJob = job;
      selectedMatch = match;
      selectedState = afterClick;
      break;
    }
  }

  if (!selectedCandidate || !selectedJob || !selectedMatch) {
    const afterTarget = await pageTarget();
    const payload = {
      runId,
      safe: afterTarget.url.includes("zhipin.com") && afterTarget.url !== "https://www.zhipin.com/" && !afterTarget.url.includes("/web/user"),
      beforeTarget,
      afterTarget,
      candidateAttempts,
      guard: { ok: false, reason: "当前可见本地候选均未通过 AI 匹配" },
      immediate: { clicked: false, reason: "no_ai_matched_candidate" },
      continueChat: { clicked: false, reason: "no_ai_matched_candidate" },
      sendMessage: { sent: false, reason: "no_ai_matched_candidate" },
      steps,
    };
    const logPath = path.join(logDir, `${runId}-match-communicate-send.json`);
    payload.logPath = logPath;
    fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf8");
    writeDocs(runId, { ...payload, candidate: {}, match: { result: { matched: false, reason: "当前可见本地候选均未通过 AI 匹配", message: "" } } });
    ws.close();
    console.log(JSON.stringify({
      logPath,
      safe: payload.safe,
      matchedCandidate: null,
      attempts: candidateAttempts.map((item) => ({
        index: item.candidate?.index,
        title: item.candidate?.title,
        city: item.candidate?.city,
        minK: item.candidate?.minK,
        matched: item.match?.result?.matched ?? false,
        reason: item.match?.result?.reason || item.reason || "",
      })),
      afterTarget: { url: afterTarget.url, title: afterTarget.title },
    }, null, 2));
    return;
  }

  const preImmediate = await snapshot(ws);
  const guard = assertCanClickImmediate(selectedCandidate, preImmediate, selectedMatch.result);
  steps.push({ step: "guard_immediate", guard, state: preImmediate });

  let immediate = { clicked: false, reason: shouldSend ? guard.reason : "dry_run" };
  let continueChat = { clicked: false, reason: shouldSend ? "not_started" : "dry_run" };
  let sendMessage = { sent: false, reason: shouldSend ? "not_started" : "dry_run" };

  if (shouldSend && guard.ok) {
    immediate = await clickImmediate(ws);
    steps.push({ step: "click_immediate", result: immediate, state: await snapshot(ws) });
    if (immediate.clicked && immediate.sentDialog && !immediate.captchaOrLogin) {
      continueChat = await continueToChat(ws, selectedCandidate);
      let postContinueState = null;
      if (continueChat.reconnectedAfterNavigation) {
        try {
          ws.close();
        } catch {
          // The page may have already navigated away from the old inspected target.
        }
        const jobId = (selectedCandidate.href || "").match(/job_detail\/([^.?/]+)/)?.[1] || "";
        const chatTarget = await pageTarget("chat", 10000, jobId);
        ws = await connect(chatTarget.webSocketDebuggerUrl);
      }
      try {
        postContinueState = await snapshot(ws);
      } catch (error) {
        postContinueState = { error: String(error.message || error) };
      }
      steps.push({ step: "continue_to_chat", result: continueChat, state: postContinueState });
      if (continueChat.clicked && !continueChat.captchaOrLogin) {
        sendMessage = await sendChatMessage(ws, selectedMatch.result.message, selectedCandidate);
        let postSendState = null;
        try {
          postSendState = await snapshot(ws);
        } catch (error) {
          postSendState = { error: String(error.message || error) };
        }
        steps.push({ step: "send_chat_message", result: sendMessage, state: postSendState });
      }
    }
  }

  try {
    ws.close();
  } catch {
    // Ignore close errors after navigation.
  }
  const afterTarget = await pageTarget();
  const safe = afterTarget.url.includes("zhipin.com") && afterTarget.url !== "https://www.zhipin.com/" && !afterTarget.url.includes("/web/user");
  const payload = {
    runId,
    safe,
    beforeTarget,
    afterTarget,
    candidate: selectedCandidate,
    detailMatches: selectedState.detailTitle.includes(selectedCandidate.title),
    job: selectedJob,
    match: selectedMatch,
    candidateAttempts,
    guard,
    immediate,
    continueChat,
    sendMessage,
    steps,
  };
  const logPath = path.join(logDir, `${runId}-match-communicate-send.json`);
  payload.logPath = logPath;
  fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf8");
  writeDocs(runId, payload);
  console.log(JSON.stringify({
    logPath,
    safe,
    candidate: {
      index: selectedCandidate.index,
      title: selectedCandidate.title,
      city: selectedCandidate.city,
      minK: selectedCandidate.minK,
      maxK: selectedCandidate.maxK,
      keywordScore: selectedCandidate.keywordScore,
    },
    match: selectedMatch.result,
    attempts: candidateAttempts.map((item) => ({
      index: item.candidate?.index,
      title: item.candidate?.title,
      matched: item.match?.result?.matched ?? false,
      reason: item.match?.result?.reason || item.reason || "",
    })),
    guard,
    immediate,
    continueChat: {
      clicked: continueChat.clicked,
      reason: continueChat.reason,
      href: continueChat.href,
      title: continueChat.title,
      inputs: continueChat.inputs,
    },
    sendMessage,
    afterTarget: { url: afterTarget.url, title: afterTarget.title },
  }, null, 2));
}

await main();
