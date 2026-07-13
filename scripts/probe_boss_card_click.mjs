import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cdpUrl = process.env.EDGE_CDP_URL || "http://127.0.0.1:9222";
const logDir = path.join(root, "runtime", "logs");
fs.mkdirSync(logDir, { recursive: true });

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

async function pageTarget() {
  const targets = await fetchJson(`${cdpUrl.replace(/\/$/, "")}/json`);
  const page = targets.find((target) => target.type === "page" && target.url.includes("zhipin.com"));
  if (!page) throw new Error("No zhipin page target found");
  return page;
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
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
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
  })).filter((item) => item.text).slice(0, 80);
  const dialogs = Array.from(document.querySelectorAll('.greet-boss-dialog, [class*=dialog], [class*=modal], [class*=popover]')).map((el) => ({
    className: (el.className || '').toString(),
    text: textOf(el).slice(0, 1000),
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
  })).filter((item) => item.text || item.visible);
  return {
    page: { href: location.href, title: document.title },
    activeIntent: textOf(document.querySelector('a.expect-item.active')),
    detailTitle: textOf(detailRoot.querySelector('.job-name, h1, h2, .name')),
    detailText: textOf(detailRoot).slice(0, 2500),
    buttons,
    jobs,
    dialogs,
    flags: {
      sentDialog: document.body.innerText.includes('已向BOSS发送消息'),
      continueChat: document.body.innerText.includes('继续沟通'),
      captchaOrLogin: /验证码|登录|安全验证/.test(document.body.innerText),
    },
  };
})())
`;

async function snapshot(ws) {
  return await evalJson(ws, snapshotExpression);
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
    return { ...job, decodedText, minK: salaryRange?.minK ?? null, maxK: salaryRange?.maxK ?? null, keywordScore };
  });
  const candidate = scored
    .filter((job) => job.city.includes("上海") && job.minK !== null && job.maxK !== null && job.keywordScore > 0)
    .sort((a, b) => b.keywordScore - a.keywordScore || a.index - b.index)[0];
  return { scored, candidate };
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
    bodyHasSentDialog: document.body.innerText.includes('已向BOSS发送消息'),
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
          bodyHasSentDialog: document.body.innerText.includes('已向BOSS发送消息'),
          captchaOrLogin: /验证码|登录|安全验证/.test(document.body.innerText),
        },
      }));
    }, 2500);
  }, 300);
})
`);
}

async function main() {
  const runId = stamp();
  const beforeTarget = await pageTarget();
  const ws = await connect(beforeTarget.webSocketDebuggerUrl);
  const steps = [];

  const before = await snapshot(ws);
  steps.push({ step: "before", state: before });
  if (before.flags.sentDialog) {
    const dismiss = await dismissGreetDialog(ws);
    steps.push({ step: "dismiss_greet_dialog", dismiss });
  }

  const afterDismiss = await snapshot(ws);
  const selection = selectCandidate(afterDismiss.jobs);
  steps.push({ step: "select_candidate", state: afterDismiss, selection });
  if (!selection.candidate) {
    throw new Error("No local-rule candidate found");
  }

  const click = await clickJobName(ws, selection.candidate.index);
  const afterClick = await snapshot(ws);
  steps.push({ step: "click_job_name", click, state: afterClick });

  ws.close();
  const afterTarget = await pageTarget();
  const detailMatches = afterClick.detailTitle.includes(selection.candidate.title);
  const safe = afterTarget.url.includes("zhipin.com") && afterTarget.url !== "https://www.zhipin.com/" && !afterTarget.url.includes("/web/user") && !afterClick.flags.captchaOrLogin;
  const payload = { runId, safe, detailMatches, beforeTarget, afterTarget, steps };
  const logPath = path.join(logDir, `${runId}-boss-card-click.json`);
  fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf8");

  console.log(JSON.stringify({
    logPath,
    safe,
    detailMatches,
    candidate: selection.candidate && {
      index: selection.candidate.index,
      title: selection.candidate.title,
      city: selection.candidate.city,
      minK: selection.candidate.minK,
      keywordScore: selection.candidate.keywordScore,
    },
    click,
    after: { page: afterClick.page, detailTitle: afterClick.detailTitle, flags: afterClick.flags },
  }, null, 2));
}

await main();
