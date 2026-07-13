import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cdpUrl = process.env.EDGE_CDP_URL || "http://127.0.0.1:9222";
const logDir = path.join(root, "runtime", "logs");
const docsDir = path.join(root, "docs");
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(docsDir, { recursive: true });

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

async function pageTargets() {
  const targets = await fetchJson(`${cdpUrl.replace(/\/$/, "")}/json`);
  return targets.filter((target) => target.type === "page" && target.url.includes("zhipin.com"));
}

function assertPageAlive(targets, stepName) {
  if (!targets.length) {
    throw new Error(`${stepName}: no zhipin page target; possible page closed`);
  }
  const page = targets[0];
  if (page.url === "https://www.zhipin.com/" || page.url.includes("/web/user")) {
    throw new Error(`${stepName}: page url changed to ${page.url}; possible risk/login redirect`);
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
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(payload);
  });
}
sendCdp.nextId = 1;

async function runProbe() {
  const results = [];
  const beforeTargets = await pageTargets();
  const page = assertPageAlive(beforeTargets, "before");
  results.push({ step: "devtools_http_json_before", ok: true, page });

  const ws = await connect(page.webSocketDebuggerUrl);
  const probes = [
    {
      name: "runtime_1_plus_1",
      expression: "1 + 1",
    },
    {
      name: "read_location_and_title",
      expression: "JSON.stringify({ href: location.href, title: document.title })",
    },
    {
      name: "read_body_text_sample",
      expression: "document.body && document.body.innerText ? document.body.innerText.slice(0, 1200) : ''",
    },
    {
      name: "read_intention_like_nodes",
      expression: `JSON.stringify(Array.from(document.querySelectorAll('a,button,li,span,div')).map((el, index) => ({
        index,
        tag: el.tagName,
        text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        className: (el.className || '').toString().slice(0, 120),
        href: el.href || '',
        role: el.getAttribute('role') || ''
      })).filter((item) => /推荐|\\(|（|城市|求职|算法|工程师|上海|北京|广州/.test(item.text)).slice(0, 80))`,
    },
  ];

  for (const probe of probes) {
    const startedAt = new Date().toISOString();
    try {
      const result = await sendCdp(ws, "Runtime.evaluate", {
        expression: probe.expression,
        returnByValue: true,
        awaitPromise: false,
      });
      const targetsAfter = await pageTargets();
      const pageAfter = assertPageAlive(targetsAfter, probe.name);
      results.push({
        step: probe.name,
        ok: true,
        startedAt,
        pageAfter,
        value: result.result?.value ?? result.result?.description ?? null,
      });
    } catch (error) {
      const targetsAfter = await pageTargets().catch((targetError) => [{ error: String(targetError) }]);
      results.push({
        step: probe.name,
        ok: false,
        startedAt,
        error: String(error),
        targetsAfter,
      });
      break;
    }
  }

  ws.close();
  return results;
}

const runId = stamp();
const results = await runProbe();
const logPath = path.join(logDir, `${runId}-cdp-safety-probe.json`);
fs.writeFileSync(logPath, JSON.stringify(results, null, 2), "utf8");

const summaryLines = [
  `## ${runId} CDP 安全探测`,
  "",
  "- 探测范围：只读 CDP 操作，不点击、不输入、不导航。",
  `- 原始结果：\`${logPath}\``,
  "",
  "| 步骤 | 结果 | URL | 标题 |",
  "| --- | --- | --- | --- |",
  ...results.map((item) => {
    const page = item.pageAfter || item.page || {};
    return `| ${item.step} | ${item.ok ? "ok" : "failed"} | ${page.url || ""} | ${page.title || ""} |`;
  }),
  "",
];
fs.appendFileSync(path.join(docsDir, "boss-test-runs.md"), summaryLines.join("\n") + "\n", "utf8");
console.log(JSON.stringify({ logPath, results }, null, 2));
