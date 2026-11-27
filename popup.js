import { planSearchText } from "./lib/bookmark-core.js";
import {
  appendLogEntry,
  createLogEntry,
  formatLogEntry
} from "./lib/job-log.js";
import {
  testLocalConnection,
  validateLocalEndpoint
} from "./lib/llm-client.js";
import {
  applyBookmarkPlan,
  hasUndoBackup,
  undoLastBookmarkPlan
} from "./lib/chrome-bookmarks.js";

const elements = {
  serverPreset: document.querySelector("#serverPresetInput"),
  job: document.querySelector("#jobBadge"),
  endpoint: document.querySelector("#endpointInput"),
  model: document.querySelector("#modelInput"),
  allowDeletion: document.querySelector("#allowDeletionInput"),
  test: document.querySelector("#testButton"),
  saveSettings: document.querySelector("#saveSettingsButton"),
  analyze: document.querySelector("#analyzeButton"),
  undo: document.querySelector("#undoButton"),
  batchSize: document.querySelector("#batchSizeInput"),
  cancel: document.querySelector("#cancelButton"),
  connection: document.querySelector("#connectionBadge"),
  status: document.querySelector("#status"),
  progressRow: document.querySelector("#progressRow"),
  progress: document.querySelector("#progress"),
  progressLabel: document.querySelector("#progressLabel"),
  backgroundHint: document.querySelector("#backgroundHint"),
  activityLog: document.querySelector("#activityLog"),
  copyLog: document.querySelector("#copyLogButton"),
  clearLog: document.querySelector("#clearLogButton"),
  empty: document.querySelector("#emptyState"),
  results: document.querySelector("#results"),
  totalCount: document.querySelector("#totalCount"),
  keepCount: document.querySelector("#keepCount"),
  moveCount: document.querySelector("#moveCount"),
  deleteCount: document.querySelector("#deleteCount"),
  filter: document.querySelector("#filterInput"),
  selectAll: document.querySelector("#selectAllInput"),
  list: document.querySelector("#planList"),
  template: document.querySelector("#planItemTemplate"),
  consentLabel: document.querySelector("#deleteConsentLabel"),
  consent: document.querySelector("#deleteConsentInput"),
  selectionSummary: document.querySelector("#selectionSummary"),
  apply: document.querySelector("#applyButton")
};

let plans = [];
let busy = false;
let lastRenderedLogCount = 0;
let currentLogs = [];
let renderedCompletedAt = 0;

function setBusy(value) {
  busy = value;
  elements.analyze.disabled = value;
  elements.test.disabled = value;
  elements.saveSettings.disabled = value;
  elements.undo.disabled = value || !elements.undo.dataset.available;
  elements.apply.disabled = value || !canApply();
  elements.cancel.disabled = false;
}

function syncServerPreset() {
  const endpoint = elements.endpoint.value.trim().replace(/\/$/, "");
  if (endpoint === "http://localhost:1234/v1") {
    elements.serverPreset.value = "lmstudio";
  } else if (endpoint === "http://localhost:8080/v1") {
    elements.serverPreset.value = "llamacpp";
  } else {
    elements.serverPreset.value = "custom";
  }
}

function setStatus(message, kind = "") {
  elements.status.textContent = message;
  elements.status.className = `status ${kind}`.trim();
  elements.status.hidden = !message;
}

function setConnection(message, kind) {
  elements.connection.textContent = message;
  elements.connection.className = `badge ${kind}`;
}

function setProgress(value, max = 100) {
  elements.progress.max = max;
  elements.progress.value = value;
  elements.progressRow.hidden = false;
  const percent = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
  elements.progressLabel.textContent = `${percent}%`;
}

function settings() {
  return {
    serverPreset: elements.serverPreset.value,
    endpoint: elements.endpoint.value.trim(),
    model: elements.model.value.trim(),
    allowDeletion: elements.allowDeletion.checked,
    batchSize: Number(elements.batchSize.value)
  };
}

function isDeletionEnabled() {
  return elements.allowDeletion.checked;
}

function canApply() {
  const deletionEnabled = isDeletionEnabled();
  const changes = plans.filter((plan) => {
    if (!plan.selected || plan.action === "keep") {
      return false;
    }
    return deletionEnabled || plan.action !== "delete";
  });
  const selectedDeletes = changes.some((plan) => plan.action === "delete");
  return changes.length > 0 && (!selectedDeletes || elements.consent.checked);
}

function formatConfidence(confidence) {
  return `${Math.round(confidence * 100)}% confidence`;
}

function updateSelectionState() {
  const deletionEnabled = isDeletionEnabled();
  const selectedChanges = plans.filter((plan) => {
    if (!plan.selected || plan.action === "keep") {
      return false;
    }
    return deletionEnabled || plan.action !== "delete";
  });
  const selectedDeletes = selectedChanges.filter((plan) => plan.action === "delete");
  elements.selectionSummary.textContent = `${selectedChanges.length} change${selectedChanges.length === 1 ? "" : "s"} selected`;
  elements.consentLabel.hidden = selectedDeletes.length === 0 || !deletionEnabled;
  if (selectedDeletes.length === 0) {
    elements.consent.checked = false;
  }
  if (!deletionEnabled) {
    elements.consent.checked = false;
  }
  elements.apply.disabled = busy || !canApply();
}

function applyDeletionPolicyToPlans() {
  if (isDeletionEnabled()) {
    return;
  }
  for (const plan of plans) {
    if (plan.action === "delete") {
      plan.selected = false;
    }
  }
  elements.consent.checked = false;
}

function renderPlan(plan) {
  const node = elements.template.content.firstElementChild.cloneNode(true);
  const checkbox = node.querySelector(".action-checkbox");
  const link = node.querySelector(".bookmark-link");
  const badge = node.querySelector(".action-badge");
  const path = node.querySelector(".plan-path");
  const reason = node.querySelector(".plan-reason");
  const meta = node.querySelector(".plan-meta");
  const deletionSuppressed = plan.action === "delete" && !isDeletionEnabled();

  node.classList.toggle("keep", plan.action === "keep");
  node.classList.toggle("deselect", !plan.selected);
  checkbox.checked = plan.selected;
  checkbox.disabled = plan.action === "keep" || deletionSuppressed;
  if (deletionSuppressed) {
    checkbox.checked = false;
  }
  checkbox.addEventListener("change", () => {
    plan.selected = checkbox.checked;
    node.classList.toggle("deselect", !plan.selected);
    updateSelectionState();
  });

  link.href = plan.bookmark.url;
  link.textContent = plan.title !== plan.bookmark.title
    ? `${plan.bookmark.title} → ${plan.title}`
    : plan.bookmark.title;
  link.title = plan.bookmark.url;

  badge.textContent = plan.action;
  badge.classList.add(plan.action);

  const currentFolder = plan.bookmark.path.join(" / ") || "Root";
  const targetFolder = plan.folderPath.join(" / ") || "Unchanged";
  path.textContent = plan.action === "move"
    ? `${currentFolder} → AI Organized / ${targetFolder}`
    : plan.action === "delete"
      ? `${currentFolder} · ${deletionSuppressed ? "deletion disabled (organization-only mode)" : "will be removed"}`
      : currentFolder;
  reason.textContent = deletionSuppressed
    ? `${plan.reason} (Not applied unless "Allow deletions" is enabled.)`
    : plan.reason;
  const sourceLabel = plan.source === "duplicate"
    ? "detected locally"
    : plan.source === "local"
      ? "local fallback rules"
      : plan.source === "fallback"
        ? "safe fallback"
        : "local LLM";
  meta.textContent = `${formatConfidence(plan.confidence)} · ${sourceLabel}`;

  return node;
}

function renderPlans() {
  const query = elements.filter.value.trim().toLowerCase();
  const visible = plans.filter((plan) => !query || planSearchText(plan).includes(query));
  elements.list.replaceChildren(...visible.map(renderPlan));
  elements.selectAll.checked = visible.length > 0 && visible.every((plan) => plan.selected || plan.action === "keep");
  elements.selectAll.indeterminate = visible.some(
    (plan) => plan.selected && plan.action !== "keep"
  ) && !elements.selectAll.checked;
  updateSelectionState();
}

function showResults(nextPlans) {
  plans = nextPlans.map((plan) => ({
    ...plan,
    selected: plan.action !== "keep"
  }));
  applyDeletionPolicyToPlans();
  elements.totalCount.textContent = plans.length;
  elements.keepCount.textContent = plans.filter((plan) => plan.action === "keep").length;
  elements.moveCount.textContent = plans.filter((plan) => ["move", "rename"].includes(plan.action)).length;
  elements.deleteCount.textContent = plans.filter((plan) => plan.action === "delete").length;
  elements.empty.hidden = true;
  elements.results.hidden = false;
  elements.filter.value = "";
  elements.consent.checked = false;
  renderPlans();
}

async function saveSettings() {
  const config = settings();
  validateLocalEndpoint(config.endpoint);
  await chrome.storage.local.set({ organizerSettings: config });
  setStatus("Local LLM settings saved.", "success");
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("organizerSettings");
  const config = stored.organizerSettings;
  if (!config) {
    return;
  }
  elements.endpoint.value = config.endpoint ?? elements.endpoint.value;
  elements.model.value = config.model ?? "";
  elements.allowDeletion.checked = config.allowDeletion === true;
  syncServerPreset();
  if ([5, 10, 15, 20].includes(config.batchSize)) {
    elements.batchSize.value = String(config.batchSize);
  } else {
    elements.batchSize.value = "10";
  }
}

async function testConnection() {
  setBusy(true);
  setStatus("Testing the local model…");
  try {
    const config = settings();
    const model = await testLocalConnection(config.endpoint, config.model);
    elements.model.value = model;
    await chrome.storage.local.set({
      organizerSettings: { ...config, model }
    });
    setConnection("Connected", "success");
    setStatus(`Connected to local model "${model}".`, "success");
  } catch (error) {
    setConnection("Unavailable", "error");
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function analyzeBookmarks() {
  try {
    const config = settings();
    const endpoint = validateLocalEndpoint(config.endpoint);
    await chrome.storage.local.set({
      organizerSettings: { ...config, endpoint }
    });
    const response = await chrome.runtime.sendMessage({
      type: "START_ANALYSIS",
      config: { ...config, endpoint }
    });
    if (!response?.ok) {
      throw new Error(response?.error ?? "The analysis could not be started.");
    }
    setStatus("Analysis started. You can close this popup; progress will continue in the background.");
    setBusy(true);
    document.body.dataset.jobStatus = "running";
    setProgress(1, 100);
    elements.cancel.hidden = false;
  } catch (error) {
    setStatus(error.message, "error");
    elements.job.textContent = "Idle";
    elements.job.className = "badge neutral";
    elements.progressRow.hidden = true;
    document.body.dataset.jobStatus = "idle";
  }
}

function applyJobState(job) {
  if (!job) {
    return;
  }
  document.body.dataset.jobStatus = job.status ?? "idle";

  const running = job.status === "running";
  elements.job.textContent = running
    ? "Running in background"
    : job.status === "completed"
      ? "Analysis ready"
      : job.status === "failed"
        ? "Needs attention"
        : job.status === "cancelled"
          ? "Stopped"
          : "Idle";
  elements.job.className = `badge ${
    running ? "running" : job.status === "completed" ? "success" : job.status === "failed" ? "error" : "neutral"
  }`;
  elements.cancel.hidden = !running;
  elements.cancel.disabled = false;
  elements.analyze.textContent = running ? "Analysis running…" : "Analyze bookmarks";
  setStatus(job.message ?? "", job.status === "failed" ? "error" : job.status === "completed" ? "success" : "");
  setBusy(running);
  renderActivityLog(job.logs ?? []);

  if (running) {
    setProgress(job.progress ?? 0, Math.max(1, job.progressMax ?? 100));
    elements.backgroundHint.hidden = false;
  } else {
    elements.progressRow.hidden = true;
    elements.backgroundHint.hidden = true;
  }

  if (
    job.status === "completed" &&
    Array.isArray(job.plans) &&
    job.plans.length > 0 &&
    job.completedAt !== renderedCompletedAt
  ) {
    showResults(job.plans);
    renderedCompletedAt = job.completedAt;
    if (job.model) {
      elements.model.value = job.model;
      setConnection("Connected", "success");
    }
    setStatus(job.message ?? "Analysis complete.", "success");
  }
  if (job.status === "failed") {
    setConnection("Unavailable", "error");
  }
}

function renderActivityLog(logs) {
  currentLogs = logs;
  const nodeList = logs.map((entry) => {
    const item = document.createElement("li");
    item.className = `log-entry ${entry.level}`;
    item.textContent = formatLogEntry(entry);
    return item;
  });

  if (nodeList.length === 0) {
    const empty = document.createElement("li");
    empty.className = "log-empty";
    empty.textContent = "No activity yet. Start an analysis to see each step.";
    elements.activityLog.replaceChildren(empty);
    lastRenderedLogCount = 0;
    return;
  }

  elements.activityLog.replaceChildren(...nodeList);
  if (logs.length !== lastRenderedLogCount) {
    elements.activityLog.scrollTop = elements.activityLog.scrollHeight;
  }
  lastRenderedLogCount = logs.length;
}

async function appendPopupLog(level, message) {
  const stored = await chrome.storage.local.get("organizerJob");
  const job = stored.organizerJob ?? { status: "idle", plans: [] };
  const entry = createLogEntry(level, message);
  const logs = appendLogEntry(job.logs, entry);
  await chrome.storage.local.set({
    organizerJob: { ...job, logs, updatedAt: Date.now() }
  });
}

async function applySelected() {
  applyDeletionPolicyToPlans();
  if (!canApply()) {
    setStatus("Review the selection and confirm removals before applying.", "error");
    return;
  }

  setBusy(true);
  setStatus("Applying the selected bookmark changes…");
  setProgress(20);
  try {
    await appendPopupLog("info", `Applying ${plans.filter((plan) => plan.selected && plan.action !== "keep").length} selected bookmark change(s).`);
    const results = await applyBookmarkPlan(plans);
    elements.undo.dataset.available = "true";
    elements.undo.disabled = false;
    showResults([]);
    elements.results.hidden = true;
    elements.empty.hidden = false;
    elements.empty.querySelector("h2").textContent = "Changes applied";
    elements.empty.querySelector("p").textContent =
      `${results.moved} organized, ${results.renamed} renamed, and ${results.deleted} removed. Use Undo if needed.`;
    setStatus("The selected changes were applied successfully.", "success");
    await appendPopupLog("success", `Applied changes: ${results.moved} moved, ${results.renamed} renamed, ${results.deleted} removed.`);
  } catch (error) {
    setStatus(error.message, "error");
    await appendPopupLog("error", `Apply failed: ${error.message}`);
  } finally {
    elements.progressRow.hidden = true;
    setBusy(false);
  }
}

async function undoChanges() {
  setBusy(true);
  setStatus("Restoring the previous bookmark layout…");
  try {
    const restored = await undoLastBookmarkPlan();
    elements.undo.dataset.available = "";
    setStatus(`Restored ${restored} bookmark(s).`, "success");
    await appendPopupLog("success", `Undo restored ${restored} bookmark(s).`);
    setConnection("Connected", "success");
  } catch (error) {
    setStatus(error.message, "error");
    await appendPopupLog("error", `Undo failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

elements.test.addEventListener("click", testConnection);
elements.serverPreset.addEventListener("change", () => {
  const endpoints = {
    lmstudio: "http://localhost:1234/v1",
    llamacpp: "http://localhost:8080/v1"
  };
  if (endpoints[elements.serverPreset.value]) {
    elements.endpoint.value = endpoints[elements.serverPreset.value];
    elements.model.value = "";
    setConnection("Not tested", "neutral");
    setStatus(`${elements.serverPreset.selectedOptions[0].textContent} selected. Test the connection before analysis.`);
  }
});
elements.endpoint.addEventListener("input", syncServerPreset);
elements.allowDeletion.addEventListener("change", () => {
  applyDeletionPolicyToPlans();
  renderPlans();
  setStatus(
    isDeletionEnabled()
      ? "Deletion mode enabled. Deletions still require explicit confirmation."
      : "Organization-only mode enabled. Delete actions are disabled."
  );
});
elements.saveSettings.addEventListener("click", async () => {
  try {
    await saveSettings();
  } catch (error) {
    setStatus(error.message, "error");
  }
});
elements.analyze.addEventListener("click", analyzeBookmarks);
elements.cancel.addEventListener("click", async () => {
  elements.cancel.disabled = true;
  await chrome.runtime.sendMessage({ type: "CANCEL_ANALYSIS" });
  setStatus("Stopping the background analysis…");
});
elements.copyLog.addEventListener("click", async () => {
  const text = currentLogs.map(formatLogEntry).join("\n");
  if (!text) {
    setStatus("The activity log is empty.", "error");
    return;
  }
  await navigator.clipboard.writeText(text);
  setStatus("Activity log copied to the clipboard.", "success");
});
elements.clearLog.addEventListener("click", async () => {
  const stored = await chrome.storage.local.get("organizerJob");
  const job = stored.organizerJob ?? { status: "idle", plans: [] };
  await chrome.storage.local.set({
    organizerJob: { ...job, logs: [], updatedAt: Date.now() }
  });
});
elements.undo.addEventListener("click", undoChanges);
elements.apply.addEventListener("click", applySelected);
elements.consent.addEventListener("change", updateSelectionState);
elements.filter.addEventListener("input", renderPlans);
elements.selectAll.addEventListener("change", () => {
  const query = elements.filter.value.trim().toLowerCase();
  for (const plan of plans) {
    if (plan.action === "keep") {
      continue;
    }
    if (!isDeletionEnabled() && plan.action === "delete") {
      continue;
    }
    if (!query || planSearchText(plan).includes(query)) {
      plan.selected = elements.selectAll.checked;
    }
  }
  elements.consent.checked = false;
  renderPlans();
});

async function initialize() {
  document.body.dataset.jobStatus = "idle";
  await loadSettings();
  syncServerPreset();
  const stored = await chrome.storage.local.get("organizerJob");
  if (stored.organizerJob) {
    applyJobState(stored.organizerJob);
  } else {
    renderActivityLog([]);
  }
  const canUndo = await hasUndoBackup();
  elements.undo.dataset.available = canUndo ? "true" : "";
  elements.undo.disabled = !canUndo;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.organizerJob?.newValue) {
    applyJobState(changes.organizerJob.newValue);
  }
});

initialize().catch((error) => setStatus(error.message, "error"));
