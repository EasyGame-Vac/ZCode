import { createInitialPetState, reducePetState } from "../lib/state-machine.mjs";

const api = window.duetPet;
const app = document.querySelector("#app");
const statusText = document.querySelector("#status-text");
const messagesEl = document.querySelector("#messages");
const activityBar = document.querySelector("#activity-bar");
const activityToggle = document.querySelector("#activity-toggle");
const activitySummary = document.querySelector("#activity-summary");
const activityEl = document.querySelector("#activity");
const previewEl = document.querySelector("#preview");
const previewToggle = document.querySelector("#preview-toggle");
const previewTitle = document.querySelector("#preview-title");
const previewFiles = document.querySelector("#preview-files");
const previewWarning = document.querySelector("#preview-warning");
const actionsEl = document.querySelector("#actions");
const activateButton = document.querySelector("#activate-button");
const logButton = document.querySelector("#log-button");
const composer = document.querySelector("#composer");
const input = document.querySelector("#input");
const sendButton = document.querySelector("#send-button");
const stopButton = document.querySelector("#stop-button");
const resetButton = document.querySelector("#reset-button");
const hideButton = document.querySelector("#hide-button");
const mascot = document.querySelector("#mascot");
const petStack = document.querySelector("#pet-stack");
const collapsedStatus = document.querySelector("#collapsed-status");
const collapsedStatusText = document.querySelector("#collapsed-status-text");
const modelSelect = document.querySelector("#model-select");

let state = createInitialPetState();
let collapsed = false;
let greeted = false;
let renderScheduled = false;
let lastSupervisorError = "";
let supervisorOnline = false;
let sending = false;
let currentModel = "";
let modelsLoading = false;
let dragState = null;
let activityExpanded = false;
let previewExpanded = false;
let persistedMessageSignature = "";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function shortSha(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 8) : "?";
}

function isLocked() {
  return state.busy || state.mode === "verifying" || sending;
}

function dispatch(action) {
  state = reducePetState(state, action);
  scheduleRender();
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function statusLabel() {
  const activation = state.activation;
  if (activation) {
    if (activation.status === "queued") return "排队中…";
    if (activation.status === "verifying") {
      if (activation.step === "stopping") return "关闭窗口版…";
      return activation.step ? `验证：${activation.step}` : "验证中…";
    }
    if (activation.status === "restarting") return "重启窗口版…";
    if (activation.status === "rolling-back") return "回滚中…";
    if (activation.status === "restoring") return "恢复窗口版…";
    if (activation.status === "failed") {
      return `失败：${truncate(activation.error ?? "未知错误", 42)}`;
    }
    if (activation.status === "succeeded") return "已更新，运行中";
  }

  if (state.supervisor?.targets?.w?.busy?.active && !state.busy && state.mode !== "verifying") {
    return "窗口版正在执行任务";
  }

  if (!state.busy && state.mode === "idle" && document.activeElement === input) {
    return "在听";
  }

  switch (state.mode) {
    case "offline":
      return "宿管未连接";
    case "idle":
      return "窗口版运行中";
    case "listening":
      return "在听";
    case "thinking":
      return "思考中…";
    case "working":
      return "正在处理…";
    case "verifying":
      return "处理中…";
    case "waiting":
      return "等你确认";
    case "error":
      return truncate(state.error ?? "出错了", 42);
    default:
      return state.mode;
  }
}

function renderMessages() {
  messagesEl.replaceChildren();

  for (const message of state.messages) {
    const element = document.createElement("div");
    element.className = `message ${message.role}`;
    element.textContent = message.text;
    messagesEl.append(element);
  }

  if (state.streaming && state.busy) {
    const element = document.createElement("div");
    element.className = "message assistant streaming";
    element.textContent = state.streaming;
    messagesEl.append(element);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderActivity() {
  const items = state.activity.slice(-8);
  activityBar.hidden = items.length === 0;
  activityBar.classList.toggle("expanded", activityExpanded);
  activityToggle.setAttribute("aria-expanded", String(activityExpanded));
  activitySummary.textContent = items.length > 0 ? truncate(items.at(-1).text, 60) : "工具活动";

  activityEl.replaceChildren();
  for (const item of items) {
    const element = document.createElement("div");
    element.className = "activity-item";
    element.textContent = item.text;
    element.title = item.text;
    activityEl.append(element);
  }
  if (activityExpanded) activityEl.scrollTop = activityEl.scrollHeight;
}

function renderPreview() {
  const preview = state.preview;
  if (!preview) {
    previewEl.hidden = true;
    return;
  }

  previewEl.hidden = false;
  previewEl.classList.toggle("expanded", previewExpanded);
  previewToggle.setAttribute("aria-expanded", String(previewExpanded));

  const changes = Array.isArray(preview.changes) ? preview.changes : [];
  previewTitle.textContent =
    changes.length > 0
      ? `改动 ${changes.length} 个文件 · ${shortSha(preview.base)} → ${shortSha(preview.commit)}`
      : "没有检测到已提交的改动";
  previewFiles.replaceChildren();

  if (changes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "preview-empty";
    empty.textContent = "没有检测到已提交的改动。";
    previewFiles.append(empty);
  } else {
    const statuses = {
      A: ["added", "+"],
      C: ["added", "C"],
      D: ["deleted", "-"],
      M: ["modified", "M"],
      R: ["modified", "R"],
    };

    for (const change of changes.slice(0, 40)) {
      const row = document.createElement("div");
      row.className = "preview-file";

      const badge = document.createElement("span");
      const [className, label] = statuses[change.status] ?? ["modified", change.status ?? "?"];
      badge.className = `preview-status ${className}`;
      badge.textContent = label;

      const path = document.createElement("span");
      path.className = "preview-path";
      path.textContent = change.oldPath
        ? `${change.oldPath} → ${change.path}`
        : (change.path ?? "");
      path.title = path.textContent;

      row.append(badge, path);
      previewFiles.append(row);
    }

    if (changes.length > 40) {
      const more = document.createElement("div");
      more.className = "preview-empty";
      more.textContent = `还有 ${changes.length - 40} 个文件…`;
      previewFiles.append(more);
    }
  }

  const warnings = [];
  const protectedResult = preview.protected;
  if (protectedResult && protectedResult.ok === false) {
    warnings.push("受保护路径被修改，不能自动激活：");
    for (const violation of protectedResult.violations ?? []) {
      warnings.push(`  ${violation.status ?? "?"} ${violation.path ?? ""}`);
    }
  }
  if (preview.dirty) warnings.push("工作区还有未提交改动，先让 K 提交。");
  if (state.supervisor?.targets?.w?.busy?.active) {
    warnings.push("窗口版正在执行任务；等它完成或先停止任务后再更新。");
  }

  previewWarning.hidden = warnings.length === 0;
  previewWarning.classList.toggle(
    "danger",
    Boolean(protectedResult && protectedResult.ok === false),
  );
  previewWarning.textContent = warnings.join("\n");
}

function renderActions() {
  const protectedOk = state.preview ? state.preview.protected?.ok !== false : false;
  const windowBusy = Boolean(state.supervisor?.targets?.w?.busy?.active);
  const canActivate = Boolean(
    state.preview && protectedOk && !state.preview.dirty && !windowBusy && !isLocked(),
  );

  activateButton.hidden = !canActivate;
  actionsEl.hidden = !canActivate;
  activateButton.disabled = !canActivate;
  resetButton.disabled = state.busy;
  stopButton.hidden = !state.busy;
  sendButton.disabled = isLocked();
  modelSelect.disabled = isLocked() || modelsLoading;
}

function persistMessages() {
  if (!api.saveMessages) return;
  const last = state.messages.at(-1);
  const signature = `${state.messages.length}:${last?.id ?? ""}:${last?.text?.length ?? 0}`;
  if (signature === persistedMessageSignature) return;
  persistedMessageSignature = signature;
  void api.saveMessages(state.messages).catch(() => {});
}

function render() {
  const label = statusLabel();
  app.dataset.state = state.mode;
  document.body.dataset.petMode = state.mode;
  statusText.textContent = label;
  collapsedStatusText.textContent = truncate(label, 18);
  renderMessages();
  renderActivity();
  renderPreview();
  renderActions();
  persistMessages();
}

function ensureGreeting() {
  if (greeted) return;
  greeted = true;
  if (state.supervisor) {
    dispatch({ type: "assistant-message", text: "在呢。要我改点什么？" });
    return;
  }
  dispatch({
    type: "assistant-message",
    text: "我在，但还没连上宿管。\n先在另一个终端运行：\nnode scripts/duet/supervisor.mjs",
  });
}

function handleBrainEvent(event) {
  if (!event || typeof event.kind !== "string") return;
  switch (event.kind) {
    case "assistant-delta":
      dispatch({ type: "assistant-delta", text: event.text });
      break;
    case "reasoning-delta":
      break;
    case "tool":
      dispatch({
        type: "tool",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        phase: event.phase,
        description: event.description,
      });
      break;
    case "activity":
      dispatch({ type: "activity", text: event.text });
      break;
    case "session":
      dispatch({ type: "session", sessionId: event.sessionId });
      break;
    case "result":
      dispatch({ type: "result", text: event.text, sessionId: event.sessionId });
      break;
    case "error":
      dispatch({ type: "assistant-error", text: event.message });
      break;
    default:
      break;
  }
}

function handleTaskComplete(payload) {
  // 本轮没有新提交也没有未提交改动时不显示预览，避免把历史提交反复列出来。
  if (payload?.noChanges) return;
  if (payload?.preview) {
    previewExpanded = false;
    dispatch({ type: "preview", preview: payload.preview });
    if (payload.preview.dirty) {
      dispatch({
        type: "assistant-message",
        text: "改动还没提交。让 K 先 git commit，再点验证。",
      });
    } else if ((payload.preview.changes?.length ?? 0) === 0) {
      dispatch({ type: "assistant-message", text: "没有检测到已提交的改动。" });
    }
    return;
  }

  dispatch({
    type: "assistant-message",
    text: "没拿到改动摘要。确认 K 已经 commit，并且宿管在运行。",
  });
  if (payload?.previewError) {
    dispatch({ type: "activity", text: payload.previewError });
  }
}

function handleSupervisorStatus(status) {
  const wasOnline = supervisorOnline;
  supervisorOnline = Boolean(status);
  dispatch({ type: "supervisor-status", status });
  if (!greeted) {
    ensureGreeting();
    return;
  }
  if (!wasOnline && supervisorOnline) {
    dispatch({ type: "assistant-message", text: "宿管连上了。" });
    lastSupervisorError = "";
  }
}

function handleSupervisorError(payload) {
  const message = typeof payload?.message === "string" ? payload.message : "宿管连接失败";
  if (message === lastSupervisorError) return;
  lastSupervisorError = message;
  dispatch({ type: "activity", text: `宿管：${message}` });
}

function applyModelValue(model) {
  currentModel = typeof model === "string" ? model : "";
  modelSelect.value = currentModel;
  modelSelect.title = currentModel || "默认模型";
}

function handleEvent(envelope) {
  if (!envelope || typeof envelope.type !== "string") return;
  const payload = envelope.payload;
  switch (envelope.type) {
    case "brain-start":
      dispatch({ type: "brain-start" });
      break;
    case "brain-event":
      handleBrainEvent(payload);
      break;
    case "brain-exit":
      dispatch({
        type: "brain-exit",
        code: payload?.code,
        signal: payload?.signal,
        stderrTail: payload?.stderrTail,
      });
      break;
    case "brain-cancelled":
      dispatch({ type: "cancelled" });
      break;
    case "task-complete":
      handleTaskComplete(payload);
      break;
    case "supervisor-status":
      handleSupervisorStatus(payload);
      break;
    case "supervisor-error":
      handleSupervisorError(payload);
      break;
    case "model-changed":
      applyModelValue(payload?.model);
      break;
    case "session-reset":
      dispatch({ type: "reset" });
      activityExpanded = false;
      previewExpanded = false;
      greeted = false;
      supervisorOnline = Boolean(state.supervisor);
      ensureGreeting();
      break;
    case "collapsed":
      collapsed = Boolean(payload?.collapsed);
      applyCollapsedClass();
      break;
    default:
      break;
  }
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 92)}px`;
}

async function submit() {
  const text = input.value.trim();
  if (!text || isLocked()) return;

  sending = true;
  input.value = "";
  resizeInput();
  previewExpanded = false;
  dispatch({ type: "user-message", text });
  try {
    await api.sendMessage(text);
  } catch (error) {
    dispatch({ type: "assistant-error", text: errorMessage(error) });
  } finally {
    sending = false;
    scheduleRender();
  }
}

async function activate() {
  if (!state.preview || state.preview.protected?.ok === false || state.preview.dirty) return;
  if (isLocked()) return;
  if (state.supervisor?.targets?.w?.busy?.active) {
    dispatch({
      type: "assistant-message",
      text: "窗口版正在执行任务，等它完成或先停止任务后再更新。",
    });
    return;
  }

  dispatch({ type: "activation-requested" });
  try {
    const result = await api.supervisor("activate", { profile: "fast" });
    if (result?.ok === false) {
      if (result.status === 409) {
        dispatch({
          type: "assistant-message",
          text: "窗口版或小人还在执行任务，等任务结束或先取消后再试。",
        });
      } else {
        dispatch({ type: "assistant-error", text: result.error ?? "宿管拒绝了激活" });
      }
    }
  } catch (error) {
    dispatch({ type: "assistant-error", text: errorMessage(error) });
  }
}

async function openLog() {
  try {
    const result = await api.openLog();
    if (!result?.ok) {
      dispatch({ type: "activity", text: `打开日志失败：${result?.error ?? "unknown"}` });
    }
  } catch (error) {
    dispatch({ type: "activity", text: `打开日志失败：${errorMessage(error)}` });
  }
}

async function resetSession() {
  try {
    await api.resetSession();
  } catch (error) {
    dispatch({ type: "assistant-error", text: errorMessage(error) });
  }
}

async function stopBrain() {
  try {
    await api.cancel();
  } catch (error) {
    dispatch({ type: "assistant-error", text: errorMessage(error) });
  }
}

function modelValue(option) {
  const providerId = option?.ref?.providerId;
  const modelId = option?.ref?.modelId;
  return providerId && modelId ? `${providerId}/${modelId}` : "";
}

function modelLabel(option) {
  return option?.label || option?.ref?.modelId || modelValue(option);
}

async function loadModels() {
  if (!api.models) return;
  modelsLoading = true;
  modelSelect.replaceChildren(new Option("模型加载中…", ""));
  modelSelect.disabled = true;
  scheduleRender();
  try {
    const result = await api.models();
    if (!result?.ok) throw new Error(result?.error ?? "模型列表不可用");
    const options = [new Option("默认模型", "")];
    const known = new Set();
    for (const model of result.models ?? []) {
      const value = modelValue(model);
      if (!value || known.has(value)) continue;
      known.add(value);
      const option = new Option(modelLabel(model), value);
      const detail = [model.providerLabel, value, model.disabledReason]
        .filter((part) => typeof part === "string" && part.length > 0)
        .join(" · ");
      option.title = detail;
      option.disabled = Boolean(model.disabledReason);
      options.push(option);
    }
    if (currentModel && !known.has(currentModel)) {
      options.push(new Option(`${currentModel}（当前）`, currentModel));
    }
    modelSelect.replaceChildren(...options);
    applyModelValue(currentModel);
  } catch (error) {
    const fallback = [new Option("默认模型", "")];
    if (currentModel) fallback.push(new Option(`${currentModel}（当前）`, currentModel));
    modelSelect.replaceChildren(...fallback);
    applyModelValue(currentModel);
    dispatch({ type: "activity", text: `模型列表：${errorMessage(error)}` });
  } finally {
    modelsLoading = false;
    scheduleRender();
  }
}

async function changeModel() {
  const next = modelSelect.value;
  if (next === currentModel) return;
  modelSelect.disabled = true;
  try {
    const result = await api.setModel(next);
    applyModelValue(result?.model);
    dispatch({ type: "activity", text: `模型：${currentModel || "默认"}` });
  } catch (error) {
    modelSelect.value = currentModel;
    dispatch({ type: "activity", text: `切换模型失败：${errorMessage(error)}` });
  } finally {
    scheduleRender();
  }
}

function applyCollapsedClass() {
  app.classList.toggle("collapsed", collapsed);
  mascot.setAttribute("aria-label", collapsed ? "展开对话" : "收起对话");
  if (collapsed) {
    input.blur();
    modelSelect.blur();
  } else {
    resizeInput();
  }
}

async function setCollapsed(next) {
  collapsed = Boolean(next);
  applyCollapsedClass();
  try {
    await api.toggle(collapsed);
  } catch {
    // The main process may be shutting down.
  }
}

function finishPetDrag(pointerId, cancelled) {
  if (!dragState || dragState.pointerId !== pointerId) return;
  const { moved, dragging } = dragState;
  dragState = null;
  app.classList.remove("dragging");
  if (dragging) api.dragEnd();
  try {
    petStack.releasePointerCapture(pointerId);
  } catch {
    // Pointer capture may already be gone.
  }
  if (!cancelled && !dragging && moved < 4) void setCollapsed(false);
}

function bindPetDrag() {
  petStack.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    dragState = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      moved: 0,
      dragging: false,
    };
    petStack.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  petStack.addEventListener("pointermove", (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const distance = Math.hypot(event.screenX - dragState.startX, event.screenY - dragState.startY);
    dragState.moved = Math.max(dragState.moved, distance);
    // 先等用户真的移动再开始拖，纯点击不会因为光标抖动让窗口漂移。
    if (!dragState.dragging && dragState.moved > 3) {
      dragState.dragging = true;
      app.classList.add("dragging");
      api.dragStart();
    }
  });
  petStack.addEventListener("pointerup", (event) => {
    finishPetDrag(event.pointerId, false);
  });
  petStack.addEventListener("pointercancel", (event) => {
    finishPetDrag(event.pointerId, true);
  });
  window.addEventListener("blur", () => {
    if (!dragState) return;
    const pointerId = dragState.pointerId;
    finishPetDrag(pointerId, true);
  });
  // 键盘触发的 click 没有 pointer 过程，单独保留展开入口。
  mascot.addEventListener("click", (event) => {
    if (event.detail === 0) void setCollapsed(false);
  });
  collapsedStatus.addEventListener("click", (event) => {
    if (event.detail === 0) void setCollapsed(false);
  });
}

function renderFallback(message) {
  app.dataset.state = "error";
  statusText.textContent = "界面加载失败";
  collapsedStatusText.textContent = "界面加载失败";
  messagesEl.textContent = message;
}

function bindUi() {
  hideButton.addEventListener("click", () => {
    void setCollapsed(true);
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
    if (event.key === "Escape") {
      void setCollapsed(true);
    }
  });
  input.addEventListener("input", resizeInput);
  input.addEventListener("focus", scheduleRender);
  input.addEventListener("blur", scheduleRender);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !collapsed) {
      event.preventDefault();
      void setCollapsed(true);
    }
  });
  activateButton.addEventListener("click", () => {
    void activate();
  });
  logButton.addEventListener("click", () => {
    void openLog();
  });
  resetButton.addEventListener("click", () => {
    void resetSession();
  });
  stopButton.addEventListener("click", () => {
    void stopBrain();
  });
  modelSelect.addEventListener("change", () => {
    void changeModel();
  });
  activityToggle.addEventListener("click", () => {
    activityExpanded = !activityExpanded;
    scheduleRender();
  });
  previewToggle.addEventListener("click", () => {
    previewExpanded = !previewExpanded;
    scheduleRender();
  });
  bindPetDrag();
}

async function boot() {
  if (!api) {
    renderFallback("preload 没有加载，桌面小人无法连接主进程。");
    return;
  }

  api.onEvent(handleEvent);
  bindUi();
  applyCollapsedClass();

  try {
    const info = await api.init();
    collapsed = Boolean(info?.collapsed);
    applyCollapsedClass();
    applyModelValue(info?.model);
    supervisorOnline = Boolean(info?.status);
    const restoredMessages = Array.isArray(info?.messages) ? info.messages : [];
    dispatch({
      type: "init",
      status: info?.status ?? null,
      sessionId: info?.sessionId ?? null,
      messages: restoredMessages,
    });
    if (restoredMessages.length > 0) greeted = true;
    ensureGreeting();
  } catch (error) {
    renderFallback(`初始化失败：${errorMessage(error)}`);
    return;
  }

  render();
  resizeInput();
  void loadModels();
}

document.body.dataset.petReady = "1";
void boot();
