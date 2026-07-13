import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cdpUrl = process.env.EDGE_CDP_URL || "http://127.0.0.1:9222";
const logDir = path.join(root, "runtime", "logs");
const docsDir = path.join(root, "runtime", "reports");
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(docsDir, { recursive: true });

const digitMap = new Map([
  ["\ue031", "0"], ["\ue032", "1"], ["\ue033", "2"], ["\ue034", "3"], ["\ue035", "4"],
  ["\ue036", "5"], ["\ue037", "6"], ["\ue038", "7"], ["\ue039", "8"], ["\ue030", "9"],
]);

function decodeSalary(text = "") {
  return Array.from(text).map((char) => digitMap.get(char) || char).join("");
}

function salaryRangeK(text = "") {
  const match = decodeSalary(text).match(/(\d+)\s*-\s*(\d+)\s*K/i);
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

async function evalJs(ws, expression) {
  const result = await sendCdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result?.value ?? result.result?.description ?? null;
}

async function snapshot(ws, name) {
  const value = await evalJs(ws, `JSON.stringify((() => {
    const clean = (v) => (v || '').toString().replace(/\\s+/g, ' ').trim();
    const activeIntent = clean(document.querySelector('a.expect-item.active')?.innerText);
    const title = clean(document.querySelector('.job-detail-container .job-name, .job-detail .job-name, .job-name')?.innerText);
    const detailText = clean((document.querySelector('.job-detail-container') || document.body).innerText).slice(0, 2500);
    const bodyText = clean(document.body.innerText).slice(0, 4000);
    const buttons = Array.from(document.querySelectorAll('button,a')).map((el, index) => ({
      index,
      text: clean(el.innerText || el.textContent),
      className: (el.className || '').toString(),
      href: el.href || ''
    })).filter((item) => /立即沟通|发送|继续|确定|取消|去App|聊一聊|投递|简历|登录|验证/.test(item.text)).slice(0, 80);
    return { name: ${JSON.stringify(name)}, href: location.href, title: document.title, activeIntent, detailTitle: title, buttons, bodyText, detailText };
  })())`);
  return JSON.parse(value);
}

async function selectBestJob(ws) {
  const raw = await evalJs(ws, `JSON.stringify((() => {
    const clean = (v) => (v || '').toString().replace(/\\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('.job-card-wrap')).map((el, index) => {
      const nameEl = el.querySelector('a.job-name');
      const locationEl = el.querySelector('.company-location');
      return {
        index,
        title: clean(nameEl?.innerText || ''),
        url: nameEl?.href || '',
        city: clean(locationEl?.innerText || ''),
        text: clean(el.innerText || el.textContent || '')
      };
    }).slice(0, 30);
  })())`);
  const jobs = JSON.parse(raw).map((job) => {
    const decodedText = decodeSalary(job.text);
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
    ].reduce((score, regex) => score + (regex.test(job.text) ? 1 : 0), 0);
    return { ...job, decodedText, minK: salaryRange?.minK ?? null, maxK: salaryRange?.maxK ?? null, keywordScore };
  });
  const candidate = jobs
    .filter((job) => job.city.includes("上海") && job.minK !== null && job.maxK !== null && job.keywordScore > 0)
    .sort((a, b) => b.keywordScore - a.keywordScore || a.index - b.index)[0];
  return { jobs, candidate };
}

async function clickJobByIndex(ws, index) {
  return JSON.parse(await evalJs(ws, `new Promise((resolve) => {
    const clean = (v) => (v || '').toString().replace(/\\s+/g, ' ').trim();
    const el = document.querySelectorAll('.job-card-wrap')[${Number(index)}];
    if (!el) return resolve({ clicked: false, reason: 'not_found', index: ${Number(index)} });
    el.scrollIntoView({ block: 'center' });
    setTimeout(() => {
      el.click();
      setTimeout(() => resolve({ clicked: true, index: ${Number(index)}, text: clean(el.innerText || el.textContent).slice(0, 500) }), 2200);
    }, 300);
  }).then(JSON.stringify)`));
}

async function clickCommunicate(ws) {
  return JSON.parse(await evalJs(ws, `new Promise((resolve) => {
    const clean = (v) => (v || '').toString().replace(/\\s+/g, ' ').trim();
    const items = Array.from(document.querySelectorAll('button,a'));
    const el = items.find((node) => clean(node.innerText || node.textContent) === '立即沟通');
    if (!el) return resolve({ clicked: false, reason: 'not_found' });
    const before = { href: location.href, text: clean(document.body.innerText).slice(0, 1200) };
    el.scrollIntoView({ block: 'center' });
    setTimeout(() => {
      el.click();
      setTimeout(() => {
        const afterText = clean(document.body.innerText);
        const overlays = Array.from(document.querySelectorAll('[class*=dialog], [class*=modal], [class*=popover], .boss-dialog, .dialog-wrap')).map((node) => ({
          className: (node.className || '').toString(),
          text: clean(node.innerText || node.textContent).slice(0, 1000)
        })).filter((item) => item.text);
        resolve({
          clicked: true,
          before,
          after: {
            href: location.href,
            title: document.title,
            textSample: afterText.slice(0, 2000),
            overlays,
            buttons: Array.from(document.querySelectorAll('button,a')).map((node, index) => ({
              index,
              text: clean(node.innerText || node.textContent),
              className: (node.className || '').toString(),
              href: node.href || ''
            })).filter((item) => /发送|继续|确定|取消|去App|立即沟通|聊一聊|投递|简历|登录|验证/.test(item.text)).slice(0, 80)
          }
        });
      }, 3000);
    }, 300);
  }).then(JSON.stringify)`));
}

function assertCanClickImmediate(candidate, afterJobState) {
  const detailTitle = afterJobState?.detailTitle || "";
  const bodyText = afterJobState?.bodyText || "";
  const buttons = afterJobState?.buttons || [];
  const immediate = buttons.find((button) => button.text === "立即沟通");
  if (!candidate?.title || !detailTitle.includes(candidate.title)) {
    return {
      ok: false,
      reason: `详情岗位未切换到候选岗位：candidate=${candidate?.title || ""}, detailTitle=${detailTitle}`,
    };
  }
  if (!immediate) {
    return { ok: false, reason: "未找到立即沟通按钮" };
  }
  if ((immediate.className || "").includes("is-disabled")) {
    return { ok: false, reason: `立即沟通按钮不可用：${immediate.className}` };
  }
  if (bodyText.includes("已向BOSS发送消息") || bodyText.includes("继续沟通")) {
    return { ok: false, reason: "页面已有沟通成功弹窗或继续沟通状态，禁止重复点击" };
  }
  return { ok: true, reason: "ok" };
}

async function main() {
  const runId = stamp();
  const beforeTarget = await pageTarget();
  const ws = await connect(beforeTarget.webSocketDebuggerUrl);
  const results = [];

  const before = await snapshot(ws, "before");
  const selection = await selectBestJob(ws);
  results.push({ step: "select_candidate", before, selection });
  if (!selection.candidate) {
    throw new Error("No matched local-rule candidate found");
  }

  const clickJob = await clickJobByIndex(ws, selection.candidate.index);
  const afterJobTarget = await pageTarget();
  const afterJob = await snapshot(ws, "after_job_click");
  results.push({ step: "click_job", clickJob, page: afterJobTarget, state: afterJob });

  const guard = assertCanClickImmediate(selection.candidate, afterJob);
  results.push({ step: "guard_immediate", guard });
  let clickImmediate = { clicked: false, skipped: true, reason: guard.reason };
  let afterImmediateTarget = afterJobTarget;
  let afterImmediate = afterJob;
  if (guard.ok) {
    clickImmediate = await clickCommunicate(ws);
    afterImmediateTarget = await pageTarget();
    afterImmediate = await snapshot(ws, "after_immediate_click");
    results.push({ step: "click_immediate", clickImmediate, page: afterImmediateTarget, state: afterImmediate });
  }

  ws.close();
  const safe = results.every((item) => !item.page || (item.page.url && !item.page.url.includes("/web/user") && item.page.url !== "https://www.zhipin.com/"));
  const payload = { runId, safe, results };
  const logPath = path.join(logDir, `${runId}-match-click-immediate.json`);
  fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf8");

  const candidate = selection.candidate;
  const immediate = clickImmediate.after || {};
  const overlayText = (immediate.overlays || []).map((item) => item.text).filter(Boolean).join(" | ");
  const doc = [
    `## ${runId} 本地匹配候选并点击立即沟通检测`,
    "",
    "- OpenAI 匹配状态：接口返回 403 error code 1010，本次未完成 OpenAI 远程匹配。",
    "- 本次前置：使用本地硬规则选择上海、20k+、包含 AI/Agent/应用开发关键词的候选岗位。",
    `- 原始结果：\`${logPath}\``,
    `- 安全检查：\`${safe ? "ok" : "failed"}\``,
    "",
    "### 候选岗位",
    "",
    `- index：${candidate.index}`,
    `- 岗位：${candidate.title}`,
    `- 城市：${candidate.city}`,
    `- 薪资范围：${candidate.minK}-${candidate.maxK}k`,
    `- URL：${candidate.url}`,
    "",
    "### 立即沟通点击后检测",
    "",
    `- 点击结果：${clickImmediate.clicked ? "clicked" : "not clicked"}`,
    `- 保护结果：${guard.ok ? "allowed" : "blocked"} ${guard.reason}`,
    `- 点击后 URL：${afterImmediateTarget.url}`,
    `- 点击后标题：${afterImmediateTarget.title}`,
    `- 弹窗文本：${overlayText || "未检测到标准 dialog/modal/popover 文本"}`,
    `- 关键按钮：${(immediate.buttons || []).map((button) => button.text).filter(Boolean).join(" / ")}`,
    "",
  ].join("\n");
  fs.appendFileSync(path.join(docsDir, "boss-test-runs.md"), doc + "\n", "utf8");
  fs.appendFileSync(path.join(docsDir, "boss-flow.md"), doc + "\n", "utf8");
  console.log(JSON.stringify(payload, null, 2));
}

await main();
