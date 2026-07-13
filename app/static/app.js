const state = {
  repoUrl: "https://github.com/Shizuku1648/job-assisstance",
  jobs: [],
  logs: [],
  quota: null,
  status: null,
};

const actions = {
  "save-profile": saveProfile,
  "load-profile": loadProfile,
  "open-login": openLogin,
  "save-auth": saveAuth,
  "explore": startExplore,
  "run": startConfiguredRun,
  "stop": stopWorker,
  "refresh": refreshAll,
  "load-jobs": loadJobs,
  "load-logs": loadLogs,
};

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = actions[button.dataset.action];
  if (action) void runWithButton(button, action);
});

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || JSON.stringify(data));
  }
  return data;
}

async function runWithButton(button, action) {
  button.disabled = true;
  try {
    const result = await action();
    if (result) renderStatus(result);
  } catch (error) {
    renderStatus({ error: error.message });
  } finally {
    button.disabled = false;
    syncRunControls();
  }
}

async function loadProfile() {
  const data = await api("/api/profile");
  document.querySelector("#salaryMin").value = data.expected_salary_min_k;
  document.querySelector("#salaryMax").value = data.expected_salary_max_k ?? 25;
  document.querySelector("#cities").value = data.candidate_cities.join(",");
  document.querySelector("#description").value = data.description;
  setPill("#profileState", "已加载", "success");
  renderMessagePreview();
  return { profile: data };
}

async function saveProfile() {
  await api("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expected_salary_min_k: Number(document.querySelector("#salaryMin").value),
      expected_salary_max_k: Number(document.querySelector("#salaryMax").value),
      candidate_cities: document.querySelector("#cities").value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      description: document.querySelector("#description").value,
    }),
  });
  await loadProfile();
  return { ok: true, action: "save-profile" };
}

async function loadRepository() {
  const data = await api("/api/repository");
  state.repoUrl = data.url;
  const link = document.querySelector("#repoLink");
  link.href = data.url;
  link.textContent = data.url.replace("https://github.com/", "GitHub / ");
  renderMessagePreview();
}

async function openLogin() {
  return runAction(() => api("/api/browser/open-login", { method: "POST" }));
}

async function saveAuth() {
  const result = await runAction(() => api("/api/browser/save-auth", { method: "POST" }));
  await loadLogs();
  return result;
}

async function startExplore() {
  return runAction(() => api("/api/automation/explore", { method: "POST" }));
}

async function startConfiguredRun() {
  const count = Number(document.querySelector("#runCount").value);
  const remaining = state.quota?.remaining ?? 0;
  if (!Number.isInteger(count) || count < 1 || count > remaining) {
    throw new Error(`本次沟通数量必须在 1-${remaining} 之间`);
  }
  return runAction(() => api(`/api/automation/run-loop?limit=${count}`, { method: "POST" }));
}

async function stopWorker() {
  return runAction(() => api("/api/automation/stop", { method: "POST" }));
}

async function runAction(action) {
  const result = await action();
  renderStatus(result);
  await refreshAll();
  return result;
}

async function refreshAll() {
  const [status, quota] = await Promise.all([loadStatus(), loadQuota(), loadJobs(), loadLogs()]);
  return { status, quota };
}

async function loadStatus() {
  const data = await api("/api/status");
  state.status = data;
  renderStatus(data);
  document.querySelector("#runningMetric").textContent = data.running ? "运行中" : "空闲";
  document.querySelector("#phaseMetric").textContent = data.phase || "-";
  setPill("#runPill", data.phase || "idle", data.running ? "success" : "");
  syncRunControls();
  return data;
}

async function loadQuota() {
  try {
    const data = await api("/api/contact-quota");
    state.quota = data;
    document.querySelector("#contactedMetric").textContent = `${data.contacted_today} / ${data.daily_limit}`;
    document.querySelector("#remainingMetric").textContent = data.remaining;
    syncRunControls();
    return data;
  } catch (error) {
    state.quota = null;
    document.querySelector("#contactedMetric").textContent = "-";
    document.querySelector("#remainingMetric").textContent = "-";
    syncRunControls();
    return { error: error.message };
  }
}

async function loadJobs() {
  const data = await api("/api/jobs?page_size=50");
  state.jobs = data.items || [];
  document.querySelector("#jobsBody").innerHTML = state.jobs.map(renderJobRow).join("");
  return data;
}

async function loadLogs() {
  const data = await api("/api/logs?page_size=40");
  state.logs = data.items || [];
  document.querySelector("#logsBody").innerHTML = state.logs.map(renderLogRow).join("");
  return data;
}

function renderJobRow(row) {
  const match = row.ai_matched === 1
    ? '<span class="pill success">match</span>'
    : row.ai_matched === 0
      ? '<span class="pill danger">reject</span>'
      : '<span class="pill warning">pending</span>';
  return `
    <tr>
      <td>${escapeHtml(row.title || "")}<br><span class="muted">${escapeHtml(row.company || "")}</span></td>
      <td>${escapeHtml(row.city || "")}<br><span class="muted">${escapeHtml(row.salary || "")}</span></td>
      <td>${statusPill(row.status)}</td>
      <td>${match}</td>
    </tr>
  `;
}

function renderLogRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.created_at || "")}</td>
      <td>${escapeHtml(row.event_type || "")}<br><span class="muted">${escapeHtml(row.action || "")}</span></td>
      <td>${row.success ? '<span class="pill success">ok</span>' : '<span class="pill danger">failed</span>'}<br><span class="muted">${escapeHtml(row.error || "")}</span></td>
    </tr>
  `;
}

function renderStatus(data) {
  document.querySelector("#statusBox").textContent = JSON.stringify(data, null, 2);
}

function renderMessagePreview() {
  document.querySelector("#messagePreview").textContent = [
    "您好，这是我本人开发的自动化求职程序发来的消息。",
    "",
    "AI 对岗位匹配度的判断如下：",
    "这里展示 AI 生成的正向匹配点，只说明岗位与经历匹配的地方。",
    "",
    "如果您觉得合适，我也很愿意发送简历，期待进一步沟通。",
    `项目地址：${state.repoUrl}`,
  ].join("\n");
}

function statusPill(status) {
  const cls = status === "contacted"
    ? "success"
    : status === "rejected" || status === "error"
      ? "danger"
      : "warning";
  return `<span class="pill ${cls}">${escapeHtml(status || "pending")}</span>`;
}

function setPill(selector, text, cls) {
  const el = document.querySelector(selector);
  el.textContent = text;
  el.className = `pill${cls ? ` ${cls}` : ""}`;
}

function syncRunControls() {
  const input = document.querySelector("#runCount");
  const button = document.querySelector("#runButton");
  if (!input || !button) return;

  const remaining = state.quota?.remaining ?? 0;
  const running = Boolean(state.status?.running);
  input.max = String(remaining);
  const current = Number(input.value);
  if (remaining <= 0) {
    input.value = "0";
  } else if (!Number.isInteger(current) || current < 1) {
    input.value = String(Math.min(5, remaining));
  } else if (current > remaining) {
    input.value = String(remaining);
  }
  input.disabled = running || remaining <= 0;
  button.disabled = running || remaining <= 0 || state.quota === null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[ch]);
}

void loadProfile();
void loadRepository();
void refreshAll();
setInterval(() => void Promise.all([loadStatus(), loadQuota()]), 3000);
