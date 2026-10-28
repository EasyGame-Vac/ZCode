import { BrowserWindow, ipcMain, shell } from "electron";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_LINES = 1000;
const MAX_HISTORY = 500;

/** 把 brain 的 tool/activity/error 事件转成控制台一行；其他事件返回 null。 */
export function formatBrainActivity(event) {
  if (!event || typeof event.kind !== "string") return null;
  if (event.kind === "tool") {
    const phase = event.phase ? ` (${event.phase})` : "";
    const description = event.description ? ` — ${event.description}` : "";
    return `tool: ${event.toolName ?? event.toolCallId ?? "tool"}${phase}${description}`;
  }
  if (event.kind === "activity") return event.text;
  if (event.kind === "error") return `error: ${event.message}`;
  return null;
}

/**
 * 工具活动和系统消息不再占用对话面板：单独一个控制台窗口，
 * 同时把活动写入 .duet/logs/k-activity.log，重启后仍可回看。
 */
export function createActivityConsole({ activityPath, logPath, htmlPath, preloadPath }) {
  let win = null;
  const lines = [];

  function timestamp() {
    return new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }

  async function persist(line) {
    try {
      await mkdir(dirname(activityPath), { recursive: true });
      await appendFile(activityPath, `${line}\n`, "utf8");
    } catch {
      // 控制台不可写不能影响 brain 运行。
    }
  }

  function append(text) {
    const value = String(text ?? "").trim();
    if (!value) return;
    const line = `[${timestamp()}] ${value}`;
    lines.push(line);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    if (win && !win.isDestroyed()) win.webContents.send("pet-console-line", line);
    void persist(line);
  }

  async function readHistory() {
    try {
      const text = await readFile(activityPath, "utf8");
      return text
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .slice(-MAX_HISTORY);
    } catch {
      return [];
    }
  }

  async function open() {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }

    win = new BrowserWindow({
      width: 560,
      height: 360,
      minWidth: 420,
      minHeight: 220,
      show: false,
      title: "ZCode 精灵控制台",
      backgroundColor: "#0f1117",
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: preloadPath,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    win.once("ready-to-show", () => win?.show());
    win.on("closed", () => {
      win = null;
    });
    win.webContents.once("did-finish-load", async () => {
      const history = lines.length > 0 ? [...lines] : await readHistory();
      win?.webContents.send("pet-console-history", history.slice(-MAX_HISTORY));
    });
    await win.loadFile(htmlPath);
  }

  async function clear() {
    lines.length = 0;
    try {
      await writeFile(activityPath, "", "utf8");
    } catch {
      // 清空失败只影响历史文件，不影响当前窗口。
    }
    return { ok: true };
  }

  async function openRawLog() {
    const error = await shell.openPath(logPath);
    return { ok: error.length === 0, error: error || null };
  }

  ipcMain.handle("pet:console-clear", clear);
  ipcMain.handle("pet:console-open-log", openRawLog);

  return { append, open, clear, openRawLog };
}
