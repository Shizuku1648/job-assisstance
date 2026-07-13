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
  const textOf = (el) => clean(el?.innerText || el?.textContent || '');
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const cssPath = (el) => {
    if (!el || !el.parentElement) return '';
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += '#' + node.id;
        parts.unshift(part);
        break;
      }
      if (node.className && typeof node.className === 'string') {
        const cls = node.className.trim().split(/\s+/).slice(0, 3).join('.');
        if (cls) part += '.' + cls;
      }
      const siblings = Array.from(node.parentElement?.children || []).filter((item) => item.tagName === node.tagName);
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const nodeSummary = (el, index = 0) => {
    const style = el ? getComputedStyle(el) : null;
    return {
      index,
      tag: el?.tagName?.toLowerCase() || '',
      className: (el?.className || '').toString(),
      text: textOf(el).slice(0, 300),
      href: el?.href || '',
      role: el?.getAttribute?.('role') || '',
      ariaLabel: el?.getAttribute?.('aria-label') || '',
      path: cssPath(el),
      rect: rectOf(el),
      cursor: style?.cursor || '',
      pointerEvents: style?.pointerEvents || '',
      hasClickHandlerHint: !!(el?.onclick || el?.getAttribute?.('onclick')),
    };
  };

  const detailRoot =
    document.querySelector('.job-detail-container') ||
    document.querySelector('.job-detail') ||
    document.querySelector('.detail-content') ||
    document.querySelector('.job-detail-box');

  const cards = Array.from(document.querySelectorAll('.job-card-wrap')).slice(0, 15).map((card, index) => {
    const name = card.querySelector('a.job-name');
    const candidates = [
      card,
      name,
      card.querySelector('.job-title'),
      card.querySelector('.job-card-body'),
      card.querySelector('.job-info'),
      ...Array.from(card.querySelectorAll('a, button, [role=button], .job-title, .job-card-body')).slice(0, 12),
    ].filter(Boolean);
    return {
      index,
      title: textOf(name),
      href: name?.href || '',
      active: card.classList.contains('active'),
      className: card.className,
      rect: rectOf(card),
      text: textOf(card).slice(0, 500),
      candidateNodes: candidates.map(nodeSummary),
    };
  });

  const overlays = Array.from(document.querySelectorAll('[class*=dialog], [class*=modal], [class*=popover], .boss-dialog, .dialog-wrap'))
    .map((node, index) => ({
      ...nodeSummary(node, index),
      closeCandidates: Array.from(node.querySelectorAll('a, button, i, span, [class*=close]')).map(nodeSummary).filter((item) => (
        item.text || item.className.includes('close') || item.className.includes('dialog-close')
      )).slice(0, 40),
    }))
    .filter((item) => item.text || item.className);

  return {
    page: { href: location.href, title: document.title },
    activeIntent: textOf(document.querySelector('a.expect-item.active')),
    detail: {
      title: textOf(detailRoot?.querySelector('.job-name, h1, h2, .name')),
      text: textOf(detailRoot).slice(0, 3000),
      buttons: Array.from((detailRoot || document).querySelectorAll('a, button')).map(nodeSummary).filter((item) => item.text).slice(0, 80),
    },
    cards,
    overlays,
    bodyFlags: {
      sentDialog: document.body.innerText.includes('已向BOSS发送消息'),
      continueChat: document.body.innerText.includes('继续沟通'),
      captchaOrLogin: /验证码|登录|安全验证/.test(document.body.innerText),
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
  const payload = { runId, before, after, safe: after.url.includes("zhipin.com") && after.url !== "https://www.zhipin.com/" && !after.url.includes("/web/user"), data };
  const logPath = path.join(logDir, `${runId}-boss-dom-state.json`);
  fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(JSON.stringify({ logPath, safe: payload.safe, page: data.page, activeIntent: data.activeIntent, detailTitle: data.detail.title, firstCards: data.cards.slice(0, 5).map((card) => ({ index: card.index, title: card.title, active: card.active })), overlayCount: data.overlays.length, bodyFlags: data.bodyFlags }, null, 2));
}

await main();
