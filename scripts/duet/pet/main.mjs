import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from "electron";
import { stopProcessTree } from "../lib/process.mjs";
import { resolveBrainCommand } from "./lib/brain-command.mjs";
import { buildContextHandoff } from "./lib/context-handoff.mjs";
import { createEventStream } from "./lib/event-parser.mjs";
import { readGitHead } from "./lib/git-head.mjs";
import { createMessageStore } from "./lib/message-store.mjs";
import { createModelCatalog } from "./lib/model-catalog.mjs";
import { createSessionStore } from "./lib/session-store.mjs";
import { createSupervisorActions } from "./lib/supervisor-actions.mjs";
import { createSupervisorClient } from "./lib/supervisor-client.mjs";
import { shouldShowTaskPreview } from "./lib/task-preview.mjs";
import { createWindowDrag } from "./lib/window-drag.mjs";
import { createWindowShape } from "./lib/window-shape.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CONFIG_PATH = join(REPO_ROOT, "scripts", "duet", "config.json");
const STATE_DIR = join(REPO_ROOT, ".duet");
const PET_STATE_PATH = join(STATE_DIR, "pet-state.json");
const PET_MESSAGES_PATH = join(STATE_DIR, "pet-messages.json");
const SESSION_PATH = join(STATE_DIR, "pet-session.json");
const TOKEN_PATH = join(STATE_DIR, "token");
// 精灵 UI 的“日志”按钮指向精灵自己的日志；窗口日志由 supervisor 的 /status 暴露。
const LOG_PATH = join(STATE_DIR, "logs", "k.log");
const IS_SMOKE = process.env.DUET_PET_SMOKE === "1";
const K_INSTRUCTION =
  "你是 K，ZCode 的桌面小人。先阅读 scripts/duet/k-prompt.md，并严格遵守其中的约束。";
// 上下文占用超过 75% 时滚动到新 session；只带最近 20 条可见消息，更早的直接丢弃。
const CONTEXT_ROTATE_AT = 0.75;
const CONTEXT_KEEP_MESSAGES = 20;
const CONTEXT_HANDOFF_MAX_CHARS = 16_000;

let win = null;
let tray = null;
let brain = null;
let brainStarting = false;
let pollTimer = null;
let savePositionTimer = null;
let isQuitting = false;
let collapsed = false;
let smokeFinished = false;

let config = {};
let petConfig = {};
let windowSizes = {
  width: 360,
  height: 520,
  collapsedWidth: 180,
  collapsedHeight: 220,
};
let supervisor = null;
let petState = { bounds: null, collapsed: false, model: null };

function log(...args) {
  console.log("[duet-pet]", ...args);
}

function warn(...args) {
  console.warn("[duet-pet]", ...args);
}

function tail(value, lines = 40) {
  return String(value ?? "")
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join("\n");
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function sendEvent(type, payload) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("pet:event", { type, payload });
}

function currentSizes() {
  return collapsed
    ? { width: windowSizes.collapsedWidth, height: windowSizes.collapsedHeight }
    : { width: windowSizes.width, height: windowSizes.height };
}

function intersectsAnyDisplay(bounds) {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });
}

function initialBounds() {
  const sizes = currentSizes();
  const saved = petState?.bounds;
  if (
    saved &&
    [saved.x, saved.y, saved.width, saved.height].every((value) => Number.isFinite(value)) &&
    intersectsAnyDisplay(saved)
  ) {
    // 尺寸随折叠状态变化时固定右下角，避免展开/收起后精灵在屏幕上“跳一下”。
    // 贴边时留 24px，避免窗口和任务栏/屏幕边缘黏在一起。
    const area = screen.getDisplayMatching(saved).workArea;
    const margin = 24;
    const x = saved.x + saved.width - sizes.width;
    const y = saved.y + saved.height - sizes.height;
    return {
      width: sizes.width,
      height: sizes.height,
      x: Math.min(
        Math.max(x, area.x + margin),
        Math.max(area.x + margin, area.x + area.width - sizes.width - margin),
      ),
      y: Math.min(
        Math.max(y, area.y + margin),
        Math.max(area.y + margin, area.y + area.height - sizes.height - margin),
      ),
    };
  }

  const area = screen.getPrimaryDisplay().workArea;
  return {
    width: sizes.width,
    height: sizes.height,
    x: area.x + area.width - sizes.width - 24,
    y: area.y + area.height - sizes.height - 24,
  };
}

function enforceTopmost() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, "floating");
  if (process.platform !== "darwin") win.moveTop();
}

async function savePetState() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  petState = { bounds, collapsed, model: petState.model ?? null };
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(PET_STATE_PATH, `${JSON.stringify(petState, null, 2)}\n`, "utf8");
  } catch (error) {
    warn("save pet state failed:", error);
  }
}

function scheduleSave() {
  clearTimeout(savePositionTimer);
  savePositionTimer = setTimeout(() => {
    void savePetState();
  }, 300);
}

const windowDrag = createWindowDrag({
  getWindow: () => win,
  screen,
  onEnd: scheduleSave,
});

const applyWindowShape = createWindowShape({
  getWindow: () => win,
  isCollapsed: () => collapsed,
  onError: (error) => warn("window shape failed:", error),
});

function setCollapsed(nextCollapsed) {
  collapsed = Boolean(nextCollapsed);
  if (collapsed) windowDrag.stop();
  if (!win || win.isDestroyed()) return;
  const sizes = currentSizes();
  const bounds = win.getBounds();
  const x = bounds.x + bounds.width - sizes.width;
  const y = bounds.y + bounds.height - sizes.height;
  win.setBounds({ x, y, width: sizes.width, height: sizes.height });
  applyWindowShape();
  sendEvent("collapsed", { collapsed });
  scheduleSave();
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  win.showInactive();
  enforceTopmost();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
    return;
  }
  showWindow();
}

function formatShortcutLabel(shortcut) {
  return String(shortcut)
    .replaceAll("CommandOrControl", process.platform === "darwin" ? "Cmd" : "Ctrl")
    .replaceAll("+", " + ");
}

function createWindow() {
  win = new BrowserWindow({
    ...initialBounds(),
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    // 只设 backgroundColor 的 alpha 不够：Windows 仍会按不透明表面绘制，
    // 收起态就会露出整块窗口底色。必须显式开启 transparent。
    transparent: true,
    thickFrame: false,
    type: process.platform === "darwin" ? "panel" : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, "preload.cjs"),
      sandbox: true,
      spellcheck: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.setAlwaysOnTop(true, "floating");
  applyWindowShape();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const pageLoaded = new Promise((resolveLoaded) => {
    win.webContents.once("did-finish-load", resolveLoaded);
  });

  win.once("ready-to-show", () => {
    if (!IS_SMOKE) {
      win.showInactive();
      enforceTopmost();
      // 宿管用这行判断 K 已就绪；页面加载完成后才打印，避免窗口空白时就被视为 ready。
      void pageLoaded.then(() => log("READY"));
      return;
    }

    win.showInactive();
    enforceTopmost();
    setTimeout(async () => {
      try {
        await pageLoaded;
        const result = await win.webContents.executeJavaScript(
          `(async () => {
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
              const current = document.querySelector("#model-select");
              if (current && current.options.length > 1) break;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            const select = document.querySelector("#model-select");
            return {
              ready: document.body?.dataset?.petReady === "1",
              mascot: Boolean(document.querySelector("#mascot")),
              messages: Boolean(document.querySelector("#messages")),
              api: Boolean(window.duetPet),
              state: document.body?.dataset?.petMode ?? null,
              collapsed: document.querySelector("#app")?.classList.contains("collapsed") ?? false,
              messageCount: document.querySelectorAll("#messages .message").length,
              modelOptions: select ? select.options.length : 0,
              modelValue: select ? select.value : null,
              rollback: Boolean(document.querySelector("#rollback-button"))
            };
          })()`,
        );
        if (
          !result.ready ||
          !result.mascot ||
          !result.messages ||
          !result.api ||
          result.rollback ||
          result.modelOptions < 2
        ) {
          console.error(`[duet-pet] PET_SMOKE_FAIL ${JSON.stringify(result)}`);
          app.exit(1);
          return;
        }
        const screenshotPath = join(STATE_DIR, "pet-smoke.png");
        await mkdir(STATE_DIR, { recursive: true });
        const image = await win.webContents.capturePage();
        await writeFile(screenshotPath, image.toPNG());
        smokeFinished = true;
        log(
          "PET_SMOKE_OK",
          JSON.stringify({
            ...result,
            bounds: win.getBounds(),
            displays: screen.getAllDisplays().map((display) => ({
              bounds: display.bounds,
              workArea: display.workArea,
              scaleFactor: display.scaleFactor,
            })),
            alwaysOnTop: win.isAlwaysOnTop(),
            screenshot: screenshotPath,
          }),
        );
        setTimeout(() => {
          isQuitting = true;
          app.quit();
        }, 300);
      } catch (error) {
        console.error(
          `[duet-pet] PET_SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`,
        );
        app.exit(1);
      }
    }, 1000);
  });

  win.on("show", enforceTopmost);
  win.on("moved", scheduleSave);
  win.on("resized", () => {
    applyWindowShape();
    scheduleSave();
  });
  win.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
  });
  win.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[duet-pet] did-fail-load ${code}: ${description}`);
    if (IS_SMOKE) {
      console.error("[duet-pet] PET_SMOKE_FAIL page failed to load");
      app.exit(1);
    }
  });

  void win.loadFile(join(import.meta.dirname, "renderer", "index.html"));
}

async function openLog() {
  const error = await shell.openPath(LOG_PATH);
  if (error) warn("open log failed:", error);
}

function createTray() {
  if (IS_SMOKE || process.platform === "darwin") return;
  const iconPath = join(import.meta.dirname, "assets", "mascot-tray.png");
  try {
    const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    const shortcutLabel = formatShortcutLabel(petConfig.shortcut ?? "CommandOrControl+Shift+Z");
    tray = new Tray(image);
    tray.setToolTip(`ZCode 小人（单击显示/隐藏，${shortcutLabel}）`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `显示精灵（${shortcutLabel}）`, click: showWindow },
        {
          label: "隐藏精灵",
          click: () => {
            win?.hide();
          },
        },
        { type: "separator" },
        {
          label: "新会话",
          click: () => {
            void clearSession();
          },
        },
        {
          label: "打开日志",
          click: () => {
            void openLog();
          },
        },
        {
          label: "退出精灵",
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on("click", toggleWindow);
  } catch (error) {
    warn("tray unavailable:", error instanceof Error ? error.message : String(error));
    tray = null;
  }
}

function registerShortcut() {
  if (IS_SMOKE) return;
  const shortcut = petConfig.shortcut ?? "CommandOrControl+Shift+Z";
  try {
    if (!globalShortcut.register(shortcut, toggleWindow)) {
      warn(`global shortcut unavailable: ${shortcut}`);
    }
  } catch (error) {
    warn("register shortcut failed:", error);
  }
}

const brainCommand = () =>
  resolveBrainCommand({ repoRoot: REPO_ROOT, brain: petConfig.brain ?? {} });

const modelCatalog = createModelCatalog({ resolveCommand: brainCommand });
const petMessages = createMessageStore(PET_MESSAGES_PATH);
const sessionStore = createSessionStore(SESSION_PATH);

async function setModel(model) {
  const next = typeof model === "string" ? model.trim() : "";
  if (next.length > 0) {
    // 列表可用时先校验；列表不可用不阻塞保存，brain 启动时 CLI 仍会做最终校验。
    const list = await modelCatalog.listModels().catch(() => null);
    if (list) {
      const option = list.models.find(
        (candidate) => `${candidate?.ref?.providerId}/${candidate?.ref?.modelId}` === next,
      );
      if (!option) throw new Error(`模型不可用：${next}`);
      if (option.disabledReason) throw new Error(`模型不可用：${option.disabledReason}`);
    }
  }

  petState = { ...petState, model: next || null };
  await savePetState();
  sendEvent("model-changed", { model: petState.model });
  return { ok: true, model: petState.model };
}

async function finishTask(result, startHead) {
  try {
    // 只有本轮真的产生了新 commit 才比较 preview；否则会把历史提交或用户已有的
    // 未提交改动当成这次任务的结果，随便问一句也弹出几十个文件。
    const endHead = startHead ? await readGitHead(REPO_ROOT) : null;
    if (!startHead || !endHead || endHead === startHead) {
      sendEvent("task-complete", { preview: null, result, noChanges: true });
      return;
    }

    const preview = await supervisor.preview({ target: "w", base: startHead });
    if (
      !shouldShowTaskPreview({
        startHead,
        endHead,
        changes: preview?.changes,
        dirty: preview?.dirty,
      })
    ) {
      sendEvent("task-complete", { preview: null, result, noChanges: true });
      return;
    }
    sendEvent("task-complete", { preview, result });
  } catch (error) {
    sendEvent("task-complete", {
      preview: null,
      result,
      previewError: error instanceof Error ? error.message : String(error),
    });
  }
}

const K_LEASE_TTL_MS = 60_000;
const K_LEASE_HEARTBEAT_MS = 20_000;

async function acquireBrainLease(reason) {
  const leaseId = `k-${process.pid}-${randomUUID()}`;
  const body = { target: "k", leaseId, holder: "pet", reason, ttlMs: K_LEASE_TTL_MS };
  const lease = { leaseId: null, body, timer: null, released: false };
  const heartbeat = () => {
    if (lease.released) return;
    void supervisor
      .lease(body)
      .then(() => {
        lease.leaseId = leaseId;
      })
      .catch(() => {});
  };

  try {
    await supervisor.lease(body);
    lease.leaseId = leaseId;
  } catch (error) {
    if (error && typeof error === "object" && error.status === 0) {
      // Supervisor is offline; retry while the task runs so a later start
      // still registers the lease before any update can target K.
      lease.timer = setInterval(heartbeat, K_LEASE_HEARTBEAT_MS);
      lease.timer.unref?.();
      return lease;
    }
    if (error && typeof error === "object" && error.status === 409) {
      throw new Error("小人正在更新或有任务在跑，暂时不能开始新任务。");
    }
    throw new Error(
      `无法登记小人任务状态：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  lease.timer = setInterval(heartbeat, K_LEASE_HEARTBEAT_MS);
  lease.timer.unref?.();
  return lease;
}

function releaseBrainLease(lease) {
  if (!lease || lease.released) return;
  lease.released = true;
  if (lease.timer) clearInterval(lease.timer);
  if (lease.leaseId) {
    void supervisor.release({ target: "k", leaseId: lease.leaseId, holder: "pet" }).catch(() => {});
  }
}

async function sendMessage(text) {
  if (brain || brainStarting) throw new Error("K 正在处理上一条消息，先等它完成或点停止。");
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) throw new Error("消息为空。");
  const maxPromptChars = petConfig.brain?.maxPromptChars ?? 8000;
  if (trimmed.length > maxPromptChars) {
    throw new Error(`消息太长，最多 ${maxPromptChars} 个字符。`);
  }

  brainStarting = true;
  let lease = null;
  let child = null;
  let current = null;
  try {
    const meta = await sessionStore.read();
    const contextRatio =
      meta.contextUsed !== null && meta.contextWindow ? meta.contextUsed / meta.contextWindow : 0;
    const rotate = Boolean(meta.sessionId) && contextRatio >= CONTEXT_ROTATE_AT;
    const sessionId = rotate ? null : meta.sessionId;
    const prompt = rotate
      ? buildContextHandoff({
          instruction: K_INSTRUCTION,
          messages: await petMessages.read(),
          task: trimmed,
          keep: CONTEXT_KEEP_MESSAGES,
          maxChars: CONTEXT_HANDOFF_MAX_CHARS,
        })
      : sessionId
        ? trimmed
        : `${K_INSTRUCTION}\n\n任务：${trimmed}`;
    const base = brainCommand();
    const args = [
      ...base.args,
      "-p",
      prompt,
      "--cwd",
      REPO_ROOT,
      "--output-format",
      "stream-json",
      "--mode",
      petConfig.brain?.cliMode ?? "yolo",
      "--no-color",
    ];
    if (petState.model) args.push("--model", petState.model);
    if (sessionId) args.push("--resume", sessionId);

    const startHead = await readGitHead(REPO_ROOT);
    lease = await acquireBrainLease("brain turn");
    child = spawn(base.command, args, {
      cwd: base.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    current = { cancelled: false, child, lease, startHead };
    brain = current;
    brainStarting = false;
    let result = null;
    let stderr = "";
    if (rotate) {
      sendEvent("context-rotated", { keep: CONTEXT_KEEP_MESSAGES });
    }
    sendEvent("brain-start", { sessionId });

    const stream = createEventStream({
      onEvent: (event) => {
        if (event.kind === "result") {
          result = event;
          if (event.sessionId) {
            void sessionStore.update({
              sessionId: event.sessionId,
              ...(Number.isFinite(event.projection?.contextUsed)
                ? { contextUsed: event.projection.contextUsed }
                : {}),
              ...(Number.isFinite(event.projection?.contextWindow)
                ? { contextWindow: event.projection.contextWindow }
                : {}),
            });
          }
        }
        if (event.kind === "session" && event.sessionId) {
          // 滚动到新 session 时清掉旧 session 的上下文占用，避免下一轮再次误判。
          void sessionStore.update({
            sessionId: event.sessionId,
            ...(rotate ? { contextUsed: null, contextWindow: null } : {}),
          });
        }
        sendEvent("brain-event", event);
      },
      onMalformed: (line) => {
        stderr += `${line}\n`;
        if (stderr.length > 16000) stderr = stderr.slice(-16000);
      },
    });

    child.stdout?.on("data", (chunk) => stream.push(chunk));
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });

    child.once("close", (code, signal) => {
      stream.flush();
      if (brain === current) brain = null;
      releaseBrainLease(current.lease);
      if (current.cancelled) {
        sendEvent("brain-cancelled", {});
        return;
      }
      const exitCode = code ?? (signal ? 1 : 0);
      if (exitCode !== 0) {
        // 把 brain 的失败尾部落到 k.log，UI 的“日志”按钮才有可排查的内容。
        warn("brain failed", `code=${exitCode}`, tail(stderr, 12));
      }
      sendEvent("brain-exit", {
        code: exitCode,
        signal,
        stderrTail: tail(stderr, 40),
      });
      if (result) void finishTask(result, current.startHead);
    });

    child.once("error", (error) => {
      if (brain === current) brain = null;
      releaseBrainLease(current.lease);
      warn("brain spawn failed", error.message);
      sendEvent("brain-exit", { code: 1, signal: null, stderrTail: error.message });
    });

    return { ok: true, sessionId };
  } catch (error) {
    if (current) current.cancelled = true;
    if (brain === current) brain = null;
    if (child) void stopProcessTree(child, { timeoutMs: 3000 });
    releaseBrainLease(lease);
    brainStarting = false;
    throw error;
  }
}

async function cancelBrain() {
  if (!brain) return { ok: false };
  const current = brain;
  current.cancelled = true;
  brain = null;
  releaseBrainLease(current.lease);
  await stopProcessTree(current.child, { timeoutMs: 5000 });
  return { ok: true };
}

async function clearSession() {
  await sessionStore.clear();
  await petMessages.clear();
  sendEvent("session-reset", {});
}

const supervisorActions = createSupervisorActions({ getSupervisor: () => supervisor });

async function pollSupervisor() {
  try {
    const status = await supervisor.getStatus();
    sendEvent("supervisor-status", status);
  } catch (error) {
    sendEvent("supervisor-status", null);
    sendEvent("supervisor-error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function registerIpc() {
  ipcMain.handle("pet:init", async () => {
    const status = await supervisor.getStatus().catch(() => null);
    return {
      ok: true,
      collapsed,
      config: {
        pollIntervalMs: petConfig.pollIntervalMs ?? 4000,
        repoRoot: REPO_ROOT,
        shortcut: petConfig.shortcut ?? "CommandOrControl+Shift+Z",
        window: windowSizes,
      },
      sessionId: (await sessionStore.read()).sessionId,
      model: petState.model ?? null,
      messages: await petMessages.read(),
      status,
      smoke: IS_SMOKE,
    };
  });

  ipcMain.handle("pet:save-messages", async (_event, messages) => {
    try {
      await petMessages.save(messages);
      return { ok: true };
    } catch (error) {
      warn("save messages failed:", error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("pet:models", async () => {
    try {
      const list = await modelCatalog.listModels();
      return { ok: true, ...list };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        models: [],
        current: null,
      };
    }
  });
  ipcMain.handle("pet:set-model", async (_event, model) => setModel(model));
  ipcMain.on("pet:drag-start", () => windowDrag.start());
  ipcMain.on("pet:drag-end", () => windowDrag.stop());
  ipcMain.handle("pet:send", async (_event, text) => sendMessage(text));
  ipcMain.handle("pet:cancel", async () => cancelBrain());
  ipcMain.handle("pet:reset-session", async () => {
    await clearSession();
    return { ok: true };
  });
  ipcMain.handle("pet:supervisor", async (_event, input) => {
    const action = typeof input?.action === "string" ? input.action : "";
    try {
      return await supervisorActions.handle(action, input?.payload);
    } catch (error) {
      return {
        ok: false,
        status: typeof error?.status === "number" ? error.status : 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle("pet:toggle", async (_event, nextCollapsed) => {
    setCollapsed(Boolean(nextCollapsed));
    return { ok: true, collapsed };
  });
  ipcMain.handle("pet:hide", async () => {
    win?.hide();
    return { ok: true };
  });
}

async function bootstrap() {
  config = await loadJson(CONFIG_PATH, {});
  petConfig = config.pet ?? {};
  windowSizes = { ...windowSizes, ...petConfig.window };
  petState = await loadJson(PET_STATE_PATH, { bounds: null, collapsed: false, model: null });
  petState.model =
    typeof petState.model === "string" && petState.model.trim() ? petState.model : null;
  collapsed = petState?.collapsed === true;

  const host =
    typeof config.server?.host === "string" && config.server.host !== "0.0.0.0"
      ? config.server.host
      : "127.0.0.1";
  const port = Number.isFinite(config.server?.port) ? config.server.port : 47821;

  supervisor = createSupervisorClient({
    baseUrl: `http://${host}:${port}`,
    tokenPath: TOKEN_PATH,
  });
  // A previous pet process may have crashed before releasing its task lease.
  void supervisor.release({ target: "k", holder: "pet" }).catch(() => {});

  registerIpc();
  createWindow();
  createTray();
  registerShortcut();

  if (!IS_SMOKE) {
    void pollSupervisor();
    pollTimer = setInterval(() => {
      void pollSupervisor();
    }, petConfig.pollIntervalMs ?? 4000);
  }

  if (IS_SMOKE) {
    setTimeout(() => {
      if (smokeFinished) return;
      console.error("[duet-pet] PET_SMOKE_FAIL window did not become ready");
      app.exit(1);
    }, 15000);
  }
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win || win.isDestroyed()) return;
    win.showInactive();
    enforceTopmost();
  });

  app.on("activate", () => {
    if (!win || win.isDestroyed()) return;
    win.showInactive();
    enforceTopmost();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    clearInterval(pollTimer);
    pollTimer = null;
    windowDrag.stop();
    globalShortcut.unregisterAll();
    tray?.destroy();
    tray = null;
    if (brain) {
      const current = brain;
      current.cancelled = true;
      brain = null;
      releaseBrainLease(current.lease);
      void stopProcessTree(current.child, { timeoutMs: 3000 });
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      isQuitting = true;
      app.quit();
    }
  });

  void app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
      console.error("[duet-pet] bootstrap failed:", error);
      app.exit(1);
    });
}
