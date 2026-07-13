import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cdpUrl = process.env.EDGE_CDP_URL || "http://127.0.0.1:9222";
const logDir = path.join(root, "runtime", "logs");
fs.mkdirSync(logDir, { recursive: true });

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

const expression = String.raw`
JSON.stringify((() => {
  const clean = (value) => (value || '').toString().replace(/\s+/g, ' ').trim();
  const textOf = (el) => clean(el?.value || el?.innerText || el?.textContent || '');
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const inputs = Array.from(document.querySelectorAll('textarea, input[type=text], [contenteditable=true], [contenteditable="true"]')).map((el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    className: (el.className || '').toString(),
    id: el.id || '',
    name: el.name || '',
    placeholder: el.getAttribute('placeholder') || '',
    text: textOf(el).slice(0, 500),
    visible: visible(el),
    disabled: !!el.disabled,
    readOnly: !!el.readOnly,
    rect: rectOf(el),
  }));
  const buttons = Array.from(document.querySelectorAll('a, button, [role=button]')).map((el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    text: clean(el.innerText || el.textContent),
    className: (el.className || '').toString(),
    href: el.href || '',
    visible: visible(el),
    rect: rectOf(el),
  })).filter((item) => item.text || item.className).slice(0, 200);
  const conversationItems = Array.from(document.querySelectorAll('[class*=message], [class*=chat], [class*=conversation], [class*=dialogue], [class*=contact]')).map((el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    className: (el.className || '').toString(),
    text: clean(el.innerText || el.textContent).slice(0, 1000),
    visible: visible(el),
    rect: rectOf(el),
  })).filter((item) => item.text || item.visible).slice(0, 120);
  return {
    page: { href: location.href, title: document.title },
    bodySample: clean(document.body.innerText).slice(0, 5000),
    inputs,
    buttons,
    conversationItems,
    flags: {
      captchaOrLogin: /验证码|登录|安全验证/.test(document.body.innerText),
      agentJobVisible: document.body.innerText.includes('Agent 技术工程师') || document.body.innerText.includes('A65384'),
      sentGreetingVisible: document.body.innerText.includes('我对Agent 技术工程师') || document.body.innerText.includes('我对Agent技术工程师'),
    },
  };
})())
`;

async function main() {
  const runId = stamp();
  const before = await pageTarget();
  const ws = await connect(before.webSocketDebuggerUrl);
  const data = await evalJson(ws, expression);
  ws.close();
  const after = await pageTarget();
  const payload = { runId, before, after, safe: after.url.includes("zhipin.com") && !after.url.includes("/web/user") && after.url !== "https://www.zhipin.com/", data };
  const logPath = path.join(logDir, `${runId}-boss-chat-state.json`);
  fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(JSON.stringify({
    logPath,
    safe: payload.safe,
    page: data.page,
    flags: data.flags,
    visibleInputs: data.inputs.filter((item) => item.visible),
    visibleButtons: data.buttons.filter((item) => item.visible).slice(0, 80),
  }, null, 2));
}

await main();
