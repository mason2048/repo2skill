const state = {
  source: "local",
  analysis: null,
  selected: new Set(),
  reports: { validation: null, security: null, staleness: null },
  activeTab: "validation",
  generatedPath: ""
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const categoryLabel = (value) => ({ install: "安装", test: "测试", build: "构建", format: "格式化", lint: "检查", prepublish: "发布前" })[value] || value;

function setBusy(button, busy, busyText, idleText) {
  button.disabled = busy;
  button.querySelector("span") ? button.querySelector("span").textContent = busy ? busyText : idleText : button.textContent = busy ? busyText : idleText;
}

function message(text, kind = "") {
  const element = $("#message");
  element.textContent = text;
  element.className = `message${kind ? ` is-${kind}` : ""}`;
}

async function request(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok && response.status !== 422) throw new Error(data.error || `HTTP ${response.status}`);
  return { data, blocked: response.status === 422 };
}

function repositoryPayload() {
  return {
    repository: $("#repository").value.trim(),
    sourceType: state.source,
    target: $("#target-agent").value,
    expectedRepository: state.analysis?.repository?.repository || null,
    expectedRevision: state.analysis?.repository?.revision || null,
    expectedSnapshotHash: state.analysis?.repository?.snapshotHash || null,
    expectedSource: state.analysis?.source
      ? { kind: state.analysis.source.kind, canonicalUrl: state.analysis.source.canonicalUrl || null }
      : null
  };
}

function renderSummary(scan) {
  $("#revision").textContent = scan.revision || "—";
  $("#scope").textContent = `${scan.scannedFiles} 个文本文件；${scan.dirty ? "包含未提交工作树" : "干净工作树"}`;
  $("#excluded-summary").textContent = `${scan.excludedDirectories.length} 个目录（展开查看）`;
  $("#excluded").innerHTML = scan.excludedDirectories.map((item) => `<span class="token">${escapeHtml(item)}</span>`).join("");
  const metadata = scan.metadata || {};
  $("#languages").textContent = [...(metadata.languages || []), ...(metadata.frameworks || [])].join(" · ") || "未可靠识别";
  $("#managers").textContent = (metadata.packageManagers || []).join(" · ") || "未可靠识别";
}

function candidateGroups() {
  const candidates = state.analysis?.candidates || [];
  return [...candidates.reduce((result, item) => {
    const key = `${item.category}\0${item.command}`;
    const existing = result.get(key) || { ...item, ids: [], sources: [], verified: false };
    existing.ids.push(item.id);
    existing.sources.push(item.source);
    existing.verified ||= item.verified;
    result.set(key, existing);
    return result;
  }, new Map()).values()];
}

function renderSelectionSummary(groups) {
  const selectedGroups = groups.filter((group) => group.ids.every((id) => state.selected.has(id))).length;
  $("#candidate-count").textContent = `(${groups.length})`;
  $("#selected-count").textContent = `已选 ${selectedGroups} 项`;
  $("#select-all").checked = groups.length > 0 && selectedGroups === groups.length;
  $("#select-all").indeterminate = selectedGroups > 0 && selectedGroups < groups.length;
}

function renderCandidates() {
  const groups = candidateGroups();
  renderSelectionSummary(groups);
  $("#candidate-list").innerHTML = groups.length ? groups.map((item) => `
    <label class="candidate-row">
      <input type="checkbox" data-candidate-ids="${escapeHtml(item.ids.join(","))}" ${item.ids.every((id) => state.selected.has(id)) ? "checked" : ""}>
      <span class="category">${escapeHtml(categoryLabel(item.category))}</span>
      <code class="command">${escapeHtml(item.command)}</code>
      <span class="status ${item.verified ? "verified" : "unverified"}">${item.verified ? "已验证" : "未证实"}</span>
      <code class="source">${item.sources.map((source) => `${escapeHtml(source.path)} · ${escapeHtml(source.locator)}`).join("<br>")}</code>
    </label>`).join("") : '<div class="empty-state">未发现候选工作流。</div>';
  $$('[data-candidate-ids]').forEach((checkbox) => checkbox.addEventListener("change", () => {
    const ids = checkbox.dataset.candidateIds.split(",");
    for (const id of ids) {
      if (checkbox.checked) state.selected.add(id);
      else state.selected.delete(id);
    }
    // Preserve the checkbox node so keyboard focus is not lost when a
    // candidate is cancelled. A new scan still rebuilds the complete list.
    renderSelectionSummary(groups);
  }));
}

function renderConflicts() {
  const conflicts = state.analysis?.conflicts || [];
  $("#conflict-list").innerHTML = conflicts.map((conflict) => `
    <div class="conflict">
      <strong>需要人工确认：${escapeHtml(conflict.category)} 的 README / CI 或配置说明存在冲突</strong>
      <ul>${conflict.commands.map((entry) => `<li>${escapeHtml(entry.command)} — ${entry.sources.map((source) => `${escapeHtml(source.path)} (${escapeHtml(source.locator)})`).join("；")}</li>`).join("")}</ul>
    </div>`).join("");
}

function findingHtml(item, severity) {
  const translated = {
    "conflicting-instructions": `检测到相互冲突的 ${categoryLabel(item.category || "工作流")} 命令；Repo2Skill 未自动选择。`,
    "stale-reference": "来源文件已不存在，必须重新生成或审查。",
    "changed-reference": "来源内容已变化，必须重新审查。",
    "unverified-command": "未证实的命令不能进入 Skill。",
    "unmapped-skill-command": "来源映射与 SKILL.md 命令不一致。",
    "secret-github-token": "检测到疑似 GitHub Token；匹配值已隐藏。",
    "danger-pipe-shell": "检测到管道直接执行远程脚本的高危模式。",
    "unreviewed-executable": "检测到未人工审查的可执行脚本。",
    "prompt-injection": "检测到提示词注入特征，仓库文本不会被当作系统指令。"
  }[item.id];
  const detail = translated || item.message || item.id || String(item);
  const location = item.path ? `${item.path}${item.line ? `:${item.line}` : ""}` : "";
  return `<div class="${severity}">${escapeHtml(detail)}${location ? `<code>${escapeHtml(location)}</code>` : ""}</div>`;
}

function renderInspector() {
  const security = state.analysis?.security || { blockers: [], warnings: [] };
  const validation = state.reports.validation;
  const blockers = validation?.blockers || security.blockers || [];
  const warnings = validation?.warnings || security.warnings || [];
  $("#score").textContent = validation?.score ?? "—";
  $("#blocker-count").textContent = blockers.length;
  $("#warning-count").textContent = warnings.length;
  $("#security-count").textContent = security.blockers.length + security.warnings.length;
  $("#blockers").innerHTML = blockers.length ? blockers.map((item) => findingHtml(item, "blocker")).join("") : "<p>无阻断项</p>";
  $("#warnings").innerHTML = warnings.length ? warnings.map((item) => findingHtml(item, "warning")).join("") : "<p>无警告</p>";
  $("#security-findings").innerHTML = security.blockers.length + security.warnings.length
    ? [...security.blockers.map((item) => findingHtml(item, "blocker")), ...security.warnings.map((item) => findingHtml(item, "warning"))].join("")
    : "<p>未发现已配置的安全模式</p>";
}

function validationReport(report) {
  if (!report) return "<p>生成或复验 Skill 包后显示结构、来源和安全检查。</p>";
  return `<ul class="report-list">${report.checks.map((check) => `<li class="${check.passed ? "unchanged" : "changed"}"><strong>${escapeHtml(check.id)}</strong><span>${check.points} / ${check.maximum} · ${check.passed ? "通过" : "未通过"}</span></li>`).join("")}</ul>`;
}

function securityReport() {
  const security = state.analysis?.security;
  if (!security) return "<p>扫描仓库后显示静态安全发现。</p>";
  const items = [...security.blockers.map((item) => ({ ...item, severity: "blocker" })), ...security.warnings.map((item) => ({ ...item, severity: "warning" }))];
  return items.length ? `<ul class="report-list">${items.map((item) => `<li class="${item.severity === "blocker" ? "missing" : "changed"}"><strong>${escapeHtml(item.severity)}</strong><code>${escapeHtml(item.id)} · ${escapeHtml(item.path)}:${escapeHtml(item.line)}</code></li>`).join("")}</ul>` : "<p>当前静态规则未发现风险；这不等于恶意软件分析或业务验证。</p>";
}

function stalenessReport(report) {
  if (!report) return "<p>填写已有 Skill 包并选择“比较 revision”，查看当前一致、已变更、已移除和已替代项。</p>";
  const items = report.items || report.entries || [];
  const reason = (item, classification) => ({
    unchanged: "命令、来源定位与文件哈希仍和当前仓库证据一致。",
    changed: "来源内容或定位发生变化，需要重新审查。",
    missing: "原来源文件已不存在，当前工作流不可继续使用。",
    superseded: `原命令已被当前 ${categoryLabel(item.category)} 工作流替代。`,
    unverified: "当前证据无法证实该命令。",
    conflicted: "当前仓库出现多条冲突命令，需要人工选择。"
  })[classification] || item.reason || item.message || "状态发生变化。";
  return items.length ? `<ul class="report-list">${items.map((item) => {
    const classification = item.classification || item.status || "unverified";
    const label = { unchanged: "当前一致", changed: "已变更", missing: "已移除", superseded: "已替代", unverified: "未证实", conflicted: "有冲突" }[classification] || classification;
    return `<li class="${escapeHtml(classification)}"><strong>${escapeHtml(label)}</strong><code>${escapeHtml(item.baseline?.command || item.command || item.path || item.workflowId || "source")} · ${escapeHtml(reason(item, classification))}</code></li>`;
  }).join("")}</ul>` : `<p>${escapeHtml(report.status || "current")}：未发现来源差异。</p>`;
}

function renderReport() {
  let html;
  if (state.activeTab === "validation") html = validationReport(state.reports.validation);
  else if (state.activeTab === "security") html = securityReport();
  else html = stalenessReport(state.reports.staleness);
  $("#report-content").innerHTML = html;
}

function renderAll() {
  $("#workspace").classList.toggle("is-empty", !state.analysis);
  if (state.analysis) renderSummary(state.analysis.repository);
  renderCandidates();
  renderConflicts();
  renderInspector();
  renderReport();
  const ready = Boolean(state.analysis);
  $("#generate-button").disabled = !ready;
  $("#validate-button").disabled = !ready;
  $("#diff-button").disabled = !ready;
}

async function scan() {
  const button = $("#scan-button");
  const payload = repositoryPayload();
  if (!payload.repository) { message(state.source === "github" ? "请输入公开 GitHub URL。" : "请输入本地仓库绝对路径。", "error"); return; }
  setBusy(button, true, "正在扫描…", "扫描仓库");
  message("正在进行只读静态扫描；不会执行仓库代码。", "");
  try {
    const { data } = await request("/api/inspect", payload);
    state.analysis = data;
    state.selected = new Set(data.candidates.map((item) => item.id));
    state.reports = { validation: null, security: data.security, staleness: null };
    state.generatedPath = "";
    $("#result-line").hidden = true;
    message(`扫描完成：锁定 revision ${data.repository.revision.slice(0, 18)}…`, "success");
    renderAll();
  } catch (error) {
    message(error.message, "error");
  } finally {
    setBusy(button, false, "正在扫描…", "扫描仓库");
  }
}

async function generate() {
  const button = $("#generate-button");
  const output = $("#output").value.trim();
  if (!output) { message("请输入新的仓库外输出目录。", "error"); return; }
  const allIds = state.analysis.candidates.map((item) => item.id);
  const excludedIds = allIds.filter((id) => !state.selected.has(id));
  state.generatedPath = "";
  $("#result-path").textContent = "";
  $("#result-line").hidden = true;
  setBusy(button, true, "正在生成…", "生成 Skill 包");
  try {
    const { data, blocked } = await request("/api/generate", { ...repositoryPayload(), output, excludedIds });
    state.reports.validation = data.validation;
    state.generatedPath = data.output;
    $("#existing-skill").value = data.output;
    $("#result-path").textContent = data.output;
    $("#result-line").hidden = false;
    state.activeTab = "validation";
    activateTab("validation");
    message(blocked ? "Skill 包已生成，但存在阻断项；请先审查报告。" : "Skill 包生成成功。", blocked ? "error" : "success");
    renderAll();
  } catch (error) {
    message(error.message, "error");
  } finally {
    setBusy(button, false, "正在生成…", "生成 Skill 包");
  }
}

async function validate() {
  const skill = $("#existing-skill").value.trim();
  if (!skill) { message("请输入已有 Skill 包目录。", "error"); return; }
  const button = $("#validate-button");
  button.disabled = true; button.textContent = "校验中…";
  try {
    const { data, blocked } = await request("/api/validate", { ...repositoryPayload(), skill });
    state.reports.validation = data;
    activateTab("validation");
    message(blocked ? "复验完成：存在阻断项。" : "复验完成。", blocked ? "error" : "success");
    renderAll();
  } catch (error) { message(error.message, "error"); }
  finally { button.disabled = false; button.textContent = "重新校验"; }
}

async function diff() {
  const skill = $("#existing-skill").value.trim();
  if (!skill) { message("请输入已有 Skill 包目录。", "error"); return; }
  const button = $("#diff-button");
  button.disabled = true; button.textContent = "比较中…";
  try {
    const { data } = await request("/api/staleness", { ...repositoryPayload(), skill });
    state.reports.staleness = data;
    activateTab("staleness");
    message("revision 差异比较完成。", data.status === "current" ? "success" : "error");
    renderAll();
  } catch (error) { message(error.message, "error"); }
  finally { button.disabled = false; button.textContent = "比较 revision"; }
}

function activateTab(name) {
  state.activeTab = name;
  $$(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.setAttribute("tabindex", active ? "0" : "-1");
  });
  renderReport();
}

$$('[data-source]').forEach((button) => button.addEventListener("click", () => {
  if (state.source !== button.dataset.source) {
    state.analysis = null;
    state.selected = new Set();
    state.reports = { validation: null, security: null, staleness: null };
    state.generatedPath = "";
    $("#repository").value = "";
    $("#revision").textContent = "—";
    $("#scope").textContent = "—";
    $("#excluded-summary").textContent = "—";
    $("#excluded").innerHTML = "";
    $("#languages").textContent = "—";
    $("#managers").textContent = "—";
    $("#result-path").textContent = "";
    $("#result-line").hidden = true;
    message("来源已切换，请输入仓库并重新扫描。", "");
  }
  state.source = button.dataset.source;
  $$('[data-source]').forEach((item) => {
    const active = item === button;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  const github = state.source === "github";
  $("#repository-label").textContent = github ? "GitHub URL" : "仓库路径";
  $("#repository").placeholder = github ? "https://github.com/owner/repository" : "/absolute/path/to/repository";
  renderAll();
}));
$("#scan-button").addEventListener("click", scan);
$("#generate-button").addEventListener("click", generate);
$("#validate-button").addEventListener("click", validate);
$("#diff-button").addEventListener("click", diff);
$("#select-all").addEventListener("change", (event) => {
  state.selected = event.target.checked ? new Set(state.analysis?.candidates.map((item) => item.id) || []) : new Set();
  renderCandidates();
});
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$(".tab");
    const current = tabs.indexOf(tab);
    const target = event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    activateTab(tabs[target].dataset.tab);
    tabs[target].focus();
  });
});
renderAll();
