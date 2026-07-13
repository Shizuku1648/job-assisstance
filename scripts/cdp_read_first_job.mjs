import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const cdpUrl = process.env.EDGE_CDP_URL || "http://127.0.0.1:9222";
const logDir = path.join(root, "runtime", "logs");
const docsDir = path.join(root, "runtime", "reports");
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(docsDir, { recursive: true });

const privateDigitMap = new Map([
  ["\ue031", "0"],
  ["\ue032", "1"],
  ["\ue033", "2"],
  ["\ue034", "3"],
  ["\ue035", "4"],
  ["\ue036", "5"],
  ["\ue037", "6"],
  ["\ue038", "7"],
  ["\ue039", "8"],
  ["\ue030", "9"],
]);

function decodeBossText(text = "") {
  return Array.from(text).map((char) => privateDigitMap.get(char) || char).join("");
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
  if (page.url === "https://www.zhipin.com/" || page.url.includes("/web/user")) {
    throw new Error(`Unexpected page url: ${page.url}`);
  }
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

function expression() {
  return String.raw`
(() => {
  const clean = (value) => (value || '').toString().replace(/\s+/g, ' ').trim();
  const textOf = (el) => clean(el ? (el.innerText || el.textContent || '') : '');
  const one = (selector, root = document) => root.querySelector(selector);
  const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const activeIntent = textOf(one('a.expect-item.active .text-content') || one('a.expect-item.active'));
  const intentItems = all('a.expect-item').map((el, index) => ({
    index,
    text: textOf(el),
    active: el.classList.contains('active'),
    className: el.className,
    href: el.href || ''
  }));

  const activeCard = one('.job-card-wrap.active') || one('.job-card-wrap');
  const cardBox = activeCard ? (activeCard.closest('.card-area') || activeCard.closest('li') || activeCard) : null;
  const jobNameEl = activeCard ? one('a.job-name', activeCard) : null;
  const jobTitleEl = activeCard ? one('.job-title', activeCard) : null;
  const salaryEl = activeCard ? one('.salary, .job-salary', activeCard) : null;
  const locationEl = activeCard ? one('.company-location', activeCard) : null;
  const companyEl = activeCard ? (one('.boss-name', activeCard) || one('.company-name', activeCard) || one('.boss-info', activeCard)) : null;
  const tags = activeCard ? all('.tag-list li, .job-tags span, .job-info li', activeCard).map(textOf).filter(Boolean) : [];

  const detailRoot = one('.job-detail-container') || one('.job-detail') || one('.detail-content') || one('.job-detail-box') || document;
  const detailTitleEl = one('.job-name, .name, h1, h2', detailRoot);
  const detailSalaryEl = one('.salary, .job-salary', detailRoot);
  const detailCompanyEl = one('.boss-name, .company-name, .boss-info', detailRoot);
  const detailLocationEl = one('.location-address, .job-address, .company-location', detailRoot);
  const jdRoot =
    one('.job-sec-text', detailRoot) ||
    one('.job-detail-section', detailRoot) ||
    one('.job-detail-content', detailRoot) ||
    one('.job-detail-container', document) ||
    detailRoot;

  const activeCardText = textOf(activeCard);
  const cardText = textOf(cardBox);
  const detailText = textOf(detailRoot);
  const jdText = textOf(jdRoot);

  return {
    page: {
      href: location.href,
      title: document.title
    },
    activeIntent,
    intentItems,
    firstJob: {
      title: textOf(jobNameEl) || textOf(detailTitleEl) || activeCardText.split(' ')[0] || '',
      company: textOf(companyEl) || textOf(detailCompanyEl),
      salary: textOf(salaryEl) || textOf(detailSalaryEl) || ((cardText.match(/[\d]+-[\d]+K(?:·[\d]+薪)?/) || [])[0] || ''),
      city: textOf(locationEl) || textOf(detailLocationEl),
      url: jobNameEl ? jobNameEl.href : '',
      tags,
      cardText,
      detailText,
      jd: jdText
    },
    selectorsUsed: {
      activeIntent: 'a.expect-item.active .text-content',
      intentItems: 'a.expect-item',
      activeCard: '.job-card-wrap.active, .job-card-wrap',
      jobName: 'a.job-name',
      location: '.company-location'
    }
  };
})()
`;
}

async function main() {
  const runId = stamp();
  const before = await pageTarget();
  const ws = await connect(before.webSocketDebuggerUrl);
  const result = await sendCdp(ws, "Runtime.evaluate", {
    expression: expression(),
    returnByValue: true,
    awaitPromise: false,
  });
  ws.close();
  const after = await pageTarget();
  const payload = {
    runId,
    before,
    after,
    safe: before.id === after.id && !after.url.includes("/web/user") && after.url !== "https://www.zhipin.com/",
    data: result.result?.value,
  };
  const logPath = path.join(logDir, `${runId}-first-job-read.json`);
  fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf8");

  const job = payload.data?.firstJob || {};
  const decodedSalary = decodeBossText(job.salary || "");
  const save = spawnSync(
    path.join(root, ".venv", "Scripts", "python.exe"),
    [
      "scripts/save_first_job_from_log.py",
      logPath,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (save.status !== 0) {
    throw new Error(`Failed to save job: ${save.stderr || save.stdout}`);
  }
  const jobId = save.stdout.trim();

  const doc = [
    `## ${runId} 只读抓取第一个岗位`,
    "",
    "- 操作：原生 CDP `Runtime.evaluate` 只读 DOM，不点击、不输入、不导航。",
    `- 原始结果：\`${logPath}\``,
    `- 数据库 job id：\`${jobId}\``,
    `- 安全检查：\`${payload.safe ? "ok" : "failed"}\``,
    `- 页面 URL：\`${payload.after.url}\``,
    `- 页面标题：\`${payload.after.title}\``,
    `- 激活求职意向：\`${payload.data?.activeIntent || ""}\``,
    "",
    "### 岗位字段",
    "",
    `- 岗位：${job.title || ""}`,
    `- 公司：${job.company || ""}`,
    `- 薪资：${job.salary || ""}`,
    `- 解码薪资：${decodedSalary || ""}`,
    `- 城市：${job.city || ""}`,
    `- URL：${job.url || ""}`,
    "",
  ].join("\n");
  fs.appendFileSync(path.join(docsDir, "boss-test-runs.md"), doc + "\n", "utf8");
  fs.appendFileSync(path.join(docsDir, "boss-pages.md"), doc + "\n", "utf8");

  console.log(JSON.stringify({ logPath, jobId, job, safe: payload.safe }, null, 2));
}

await main();
