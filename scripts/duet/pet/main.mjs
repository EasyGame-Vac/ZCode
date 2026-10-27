import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { createEventStream } from "./lib/event-parser.mjs";
import { createSupervisorClient } from "./lib/supervisor-client.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CONFIG_PATH = join(REPO_ROOT, "scripts", "duet", "config.json");
const STATE_DIR = join(REPO_ROOT, ".duet");
const PET_STATE_PATH = join(STATE_DIR, "pet-state.json");
const SESSION_PATH = join(STATE_DIR, "pet-session.json");
const TOKEN_PATH = join(STATE_DIR, "token");
const LOG_PATH = join(STATE_DIR, "logs", "w.log");
const IS_SMOKE = process.env.DUET_PET_SMOKE === "1";
const K_INSTRUCTION =
  "你是 K，ZCode 的桌面小人。先阅读 scripts/duet/k-prompt.md，并严格遵守其中的约束。";

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
let petState = { bounds: null, collapsed: false };

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

async function loadSessionId() {
  const parsed = await loadJson(SESSION_PATH, null);
  return typeof parsed?.sessionId === "string" && parsed.sessionId.length > 0
    ? parsed.sessionId
    : null;
}

async function saveSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return;
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    SESSION_PATH,
    `${JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
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
    return { ...saved, width: sizes.width, height: sizes.height };
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
  petState = { bounds, collapsed };
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

function setCollapsed(nextCollapsed) {
  collapsed = Boolean(nextCollapsed);
  if (!win || win.isDestroyed()) return;
  const sizes = currentSizes();
  const bounds = win.getBounds();
  const x = bounds.x + bounds.width - sizes.width;
  const y = bounds.y + bounds.height - sizes.height;
  win.setBounds({ x, y, width: sizes.width, height: sizes.height });
  sendEvent("collapsed", { collapsed });
  scheduleSave();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
    return;
  }
  win.showInactive();
  enforceTopmost();
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
          `({
            ready: document.body?.dataset?.petReady === "1",
            mascot: Boolean(document.querySelector("#mascot")),
            messages: Boolean(document.querySelector("#messages")),
            api: Boolean(window.duetPet),
            state: document.body?.dataset?.petMode ?? null
          })`,
        );
        if (!result.ready || !result.mascot || !result.messages || !result.api) {
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
  win.on("resized", scheduleSave);
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

function createTray() {
  if (IS_SMOKE || process.platform === "darwin") return;
  const iconPath = join(REPO_ROOT, "public", "icon_512@2x.png");
  try {
    const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip("ZCode 小人");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "显示 / 隐藏", click: toggleWindow },
        {
          label: "重置会话",
          click: () => {
            void clearSession();
          },
        },
        { type: "separator" },
        {
          label: "退出",
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

function resolveBrainCommand() {
  const brain = petConfig.brain ?? {};
  const preferBuilt = brain.preferBuilt === true;
  const builtPath = brain.builtCliPath ? resolve(REPO_ROOT, brain.builtCliPath) : null;

  if (preferBuilt && builtPath && existsSync(builtPath)) {
    return { command: "node", args: [builtPath], cwd: REPO_ROOT };
  }

  const tsxPath = resolve(REPO_ROOT, brain.tsxCliPath ?? "node_modules/tsx/dist/cli.mjs");
  const cliCwd = resolve(REPO_ROOT, brain.cliCwd ?? "apps/zcode-cli/packages/cli");
  const cliEntry = brain.cliEntry ?? "src/main.ts";

  if (!existsSync(tsxPath)) {
    throw new Error(`找不到 tsx：${tsxPath}。先在仓库根目录运行 pnpm install。`);
  }
  if (!existsSync(join(cliCwd, cliEntry))) {
    throw new Error(`找不到 CLI 入口：${join(cliCwd, cliEntry)}`);
  }

  return { command: "node", args: [tsxPath, cliEntry], cwd: cliCwd };
}

async function finishTask(result) {
  try {
    const preview = await supervisor.preview({ target: "w" });
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
    const sessionId = await loadSessionId();
    const prompt = sessionId ? trimmed : `${K_INSTRUCTION}\n\n任务：${trimmed}`;
    const base = resolveBrainCommand();
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
    if (sessionId) args.push("--resume", sessionId);

    lease = await acquireBrainLease("brain turn");
    child = spawn(base.command, args, {
      cwd: base.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    current = { cancelled: false, child, lease };
    brain = current;
    brainStarting = false;
    let result = null;
    let stderr = "";
    sendEvent("brain-start", { sessionId });

    const stream = createEventStream({
      onEvent: (event) => {
        if (event.kind === "result") {
          result = event;
          if (event.sessionId) void saveSessionId(event.sessionId);
        }
        if (event.kind === "session" && event.sessionId) {
          void saveSessionId(event.sessionId);
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
      sendEvent("brain-exit", {
        code: code ?? (signal ? 1 : 0),
        signal,
        stderrTail: tail(stderr, 40),
      });
      if (result) void finishTask(result);
    });

    child.once("error", (error) => {
      if (brain === current) brain = null;
      releaseBrainLease(current.lease);
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
  await rm(SESSION_PATH, { force: true });
  sendEvent("session-reset", {});
}

function sanitizeSupervisorPayload(action, payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  if (action === "preview") {
    return {
      target: "w",
      commit: typeof source.commit === "string" ? source.commit.slice(0, 128) : undefined,
      base: typeof source.base === "string" ? source.base.slice(0, 128) : undefined,
    };
  }
  if (action === "activate") {
    return {
      target: "w",
      actor: "pet",
      profile: typeof source.profile === "string" ? source.profile.slice(0, 32) : "fast",
      commit: typeof source.commit === "string" ? source.commit.slice(0, 128) : undefined,
      tests: Array.isArray(source.tests)
        ? source.tests
            .filter((value) => typeof value === "string")
            .map((value) => value.slice(0, 200))
            .slice(0, 20)
        : undefined,
    };
  }
  if (action === "rollback") {
    return {
      target: "w",
      actor: "pet",
      reason: typeof source.reason === "string" ? source.reason.slice(0, 200) : "pet",
    };
  }
  if (action === "ledger") {
    return { limit: Number.isFinite(source.limit) ? Math.min(Math.max(source.limit, 1), 200) : 20 };
  }
  if (action === "restart") return { target: "w" };
  return {};
}

async function handleSupervisorAction(action, payload) {
  switch (action) {
    case "status":
      return supervisor.getStatus();
    case "preview":
      return supervisor.preview(sanitizeSupervisorPayload("preview", payload));
    case "activate":
      return supervisor.activate(sanitizeSupervisorPayload("activate", payload));
    case "rollback":
      return supervisor.rollback(sanitizeSupervisorPayload("rollback", payload));
    case "restart":
      return supervisor.restart(sanitizeSupervisorPayload("restart", payload));
    case "ledger":
      return supervisor.getLedger(sanitizeSupervisorPayload("ledger", payload).limit);
    default:
      throw new Error(`未知的宿管动作：${action}`);
  }
}

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
      sessionId: await loadSessionId(),
      status,
      smoke: IS_SMOKE,
    };
  });

  ipcMain.handle("pet:send", async (_event, text) => sendMessage(text));
  ipcMain.handle("pet:cancel", async () => cancelBrain());
  ipcMain.handle("pet:reset-session", async () => {
    await clearSession();
    return { ok: true };
  });
  ipcMain.handle("pet:supervisor", async (_event, input) => {
    const action = typeof input?.action === "string" ? input.action : "";
    try {
      return await handleSupervisorAction(action, input?.payload);
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
  ipcMain.handle("pet:open-log", async () => {
    const error = await shell.openPath(LOG_PATH);
    return { ok: error.length === 0, error: error || null };
  });
}

async function bootstrap() {
  config = await loadJson(CONFIG_PATH, {});
  petConfig = config.pet ?? {};
  windowSizes = { ...windowSizes, ...petConfig.window };
  petState = await loadJson(PET_STATE_PATH, { bounds: null, collapsed: false });
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
