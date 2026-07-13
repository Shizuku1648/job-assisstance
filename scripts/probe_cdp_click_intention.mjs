import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cdpUrl = process.env.EDGE_CDP_URL || "http://127.0.0.1:9222";
const logDir = path.join(root, "runtime", "logs");
const docsDir = path.join(root, "runtime", "reports");
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
  const value = await evalJs(
    ws,
    `JSON.stringify((() => {
      const clean = (value) => (value || '').toString().replace(/\\s+/g, ' ').trim();
      const items = Array.from(document.querySelectorAll('a.expect-item')).map((el, index) => ({
        index,
        text: clean(el.innerText || el.textContent),
        active: el.classList.contains('active')
      }));
      const active = items.find((item) => item.active);
      const cities = Array.from(document.querySelectorAll('.company-location')).slice(0, 8).map((el) => clean(el.innerText || el.textContent));
      return { name: ${JSON.stringify(name)}, href: location.href, title: document.title, active, items, cities };
    })())`,
  );
  return JSON.parse(value);
}

async function clickByCity(ws, city) {
  return await evalJs(
    ws,
    `new Promise((resolve) => {
      const clean = (value) => (value || '').toString().replace(/\\s+/g, ' ').trim();
      const item = Array.from(document.querySelectorAll('a.expect-item')).find((el) => clean(el.innerText || el.textContent).includes(${JSON.stringify(city)}));
      if (!item) return resolve({ clicked: false, reason: 'not_found', city: ${JSON.stringify(city)} });
      item.click();
      setTimeout(() => resolve({ clicked: true, city: ${JSON.stringify(city)}, text: clean(item.innerText || item.textContent) }), 2500);
    })`,
  );
}

async function main() {
  const runId = stamp();
  const beforeTarget = await pageTarget();
  const ws = await connect(beforeTarget.webSocketDebuggerUrl);
  const results = [];

  results.push({ step: "before", page: beforeTarget, state: await snapshot(ws, "before") });

  const clickGuangzhou = await clickByCity(ws, "广州");
  const afterGuangzhouTarget = await pageTarget();
  results.push({ step: "click_guangzhou", click: clickGuangzhou, page: afterGuangzhouTarget, state: await snapshot(ws, "after_guangzhou") });

  const clickShanghai = await clickByCity(ws, "上海");
  const afterShanghaiTarget = await pageTarget();
  results.push({ step: "click_shanghai", click: clickShanghai, page: afterShanghaiTarget, state: await snapshot(ws, "after_shanghai") });

  ws.close();
  const safe = results.every((item) => item.page?.url && !item.page.url.includes("/web/user") && item.page.url !== "https://www.zhipin.com/");
  const payload = { runId, safe, results };
  const logPath = path.join(logDir, `${runId}-cdp-click-intention.json`);
  fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf8");

  const doc = [
    `## ${runId} CDP 求职意向点击测试`,
    "",
    "- 操作：原生 CDP `Runtime.evaluate` 调用 `a.expect-item.click()`，先切广州，再切回上海。",
    `- 原始结果：\`${logPath}\``,
    `- 安全检查：\`${safe ? "ok" : "failed"}\``,
    "",
    "| 步骤 | 激活项 | URL | 前几个岗位城市 |",
    "| --- | --- | --- | --- |",
    ...results.map((item) => `| ${item.step} | ${item.state?.active?.text || ""} | ${item.page?.url || ""} | ${(item.state?.cities || []).join(" / ")} |`),
    "",
  ].join("\n");
  fs.appendFileSync(path.join(docsDir, "boss-test-runs.md"), doc + "\n", "utf8");
  fs.appendFileSync(path.join(docsDir, "boss-flow.md"), doc + "\n", "utf8");
  console.log(JSON.stringify(payload, null, 2));
}

await main();
