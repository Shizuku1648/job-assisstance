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

function latestMatchedMessage() {
  const files = fs.readdirSync(logDir)
    .filter((name) => name.endsWith("-match-communicate-send.json"))
    .map((name) => path.join(logDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    try {
      const payload = JSON.parse(fs.readFileSync(file, "utf8"));
      const message = payload.match?.result?.message;
      const candidate = payload.candidate;
      const isCurrentMessageFormat = typeof message === "string" && message.includes("本人开发的自动化求职程序");
      if (payload.match?.result?.matched === true && message && candidate?.title && isCurrentMessageFormat) {
        return { sourceLog: file, message, candidate, match: payload.match.result };
      }
    } catch {
      // Ignore partial or incompatible logs.
    }
  }
  throw new Error("No matched message found in runtime logs");
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

async function sendMessage(ws, message, candidate) {
  return await evalJson(ws, `
new Promise((resolve) => {
  const message = ${JSON.stringify(message)};
  const candidateTitle = ${JSON.stringify(candidate.title)};
  const clean = (value) => (value || '').toString().replace(/\\s+/g, ' ').trim();
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const input = document.querySelector('#chat-input.chat-input') ||
    Array.from(document.querySelectorAll('textarea, [contenteditable=true], [contenteditable="true"]')).find((el) => visible(el) && !el.disabled && !el.readOnly);
  const before = {
    href: location.href,
    title: document.title,
    bodyHasCandidate: document.body.innerText.includes(candidateTitle),
    bodyHasMessage: document.body.innerText.includes(message),
    bodySample: clean(document.body.innerText).slice(0, 3000),
  };
  if (!input || !visible(input)) return resolve(JSON.stringify({ sent: false, reason: 'input_not_found_or_hidden', before }));
  if (!before.bodyHasCandidate) return resolve(JSON.stringify({ sent: false, reason: 'candidate_title_not_visible_in_chat', before }));
  if (before.bodyHasMessage) return resolve(JSON.stringify({ sent: true, reason: 'message_already_visible', before }));
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
    const sendButton = buttons.find((el) => clean(el.innerText || el.textContent) === '发送');
    const inputText = clean(input.value || input.innerText || input.textContent);
    if (!sendButton) {
      return resolve(JSON.stringify({
        sent: false,
        reason: 'send_button_not_found',
        inputText,
        before,
        visibleButtons: buttons.map((el) => ({ text: clean(el.innerText || el.textContent), className: (el.className || '').toString() })).filter((item) => item.text).slice(0, 80),
      }));
    }
    if ((sendButton.className || '').toString().includes('disabled')) {
      return resolve(JSON.stringify({
        sent: false,
        reason: 'send_button_still_disabled',
        inputText,
        before,
        sendButtonClass: sendButton.className.toString(),
      }));
    }
    sendButton.click();
    setTimeout(() => resolve(JSON.stringify({
      sent: document.body.innerText.includes(message),
      reason: document.body.innerText.includes(message) ? 'message_visible_after_send' : 'clicked_send_but_message_not_visible',
      before,
      after: {
        href: location.href,
        title: document.title,
        inputText: clean(input.value || input.innerText || input.textContent),
        bodyHasMessage: document.body.innerText.includes(message),
        bodySample: clean(document.body.innerText).slice(0, 3000),
      },
    })), 2500);
  }, 800);
})
`);
}

async function main() {
  const runId = stamp();
  const messageInfo = latestMatchedMessage();
  const before = await pageTarget();
  const ws = await connect(before.webSocketDebuggerUrl);
  const result = await sendMessage(ws, messageInfo.message, messageInfo.candidate);
  ws.close();
  const after = await pageTarget();
  const safe = after.url.includes("zhipin.com") && after.url !== "https://www.zhipin.com/" && !after.url.includes("/web/user") && !result.before?.bodySample?.match(/验证码|登录|安全验证/);
  const payload = { runId, safe, before, after, messageInfo, result };
  const logPath = path.join(logDir, `${runId}-boss-chat-send-message.json`);
  fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf8");
  const doc = [
    `## ${runId} 聊天页发送 AI 自定义消息`,
    "",
    `- 原始日志：\`${logPath}\``,
    `- 消息来源：\`${messageInfo.sourceLog}\``,
    `- 候选岗位：${messageInfo.candidate.title}`,
    `- 页面 URL：${after.url}`,
    `- 发送结果：${result.sent ? "sent" : "not sent"} ${result.reason || ""}`,
    `- 消息：${messageInfo.message}`,
    "",
  ].join("\n");
  fs.appendFileSync(path.join(docsDir, "boss-test-runs.md"), doc, "utf8");
  fs.appendFileSync(path.join(docsDir, "boss-flow.md"), doc, "utf8");
  console.log(JSON.stringify({
    logPath,
    safe,
    sourceLog: messageInfo.sourceLog,
    candidate: messageInfo.candidate,
    message: messageInfo.message,
    result,
    after: { url: after.url, title: after.title },
  }, null, 2));
}

await main();
