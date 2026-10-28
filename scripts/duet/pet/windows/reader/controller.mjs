import { BrowserWindow, nativeTheme, screen } from "electron";

/** 独立的大尺寸只读对话窗口；主进程 hub 是数据源，窗口只是视图。 */
export function createReaderWindow({ hub, getPetWindow, preloadPath, htmlPath }) {
  let win = null;
  let unsubscribe = null;

  function open() {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }

    const petWindow = getPetWindow();
    const bounds = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null;
    const area = bounds
      ? screen.getDisplayMatching(bounds).workArea
      : screen.getPrimaryDisplay().workArea;
    const width = Math.max(420, Math.min(760, area.width - 80));
    const height = Math.max(360, Math.min(760, area.height - 80));

    win = new BrowserWindow({
      width,
      height,
      minWidth: 420,
      minHeight: 360,
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      show: false,
      title: "与 K 的对话",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#14141b" : "#f7f7fb",
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: preloadPath,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    let ready = false;
    const buffered = [];
    unsubscribe = hub.subscribe((payload) => {
      if (!win || win.isDestroyed()) return;
      if (!ready) {
        buffered.push(payload);
        return;
      }
      win.webContents.send("reader:event", payload);
    });

    win.once("ready-to-show", () => win?.show());
    win.on("closed", () => {
      win = null;
      unsubscribe?.();
      unsubscribe = null;
    });
    win.webContents.once("did-finish-load", async () => {
      const snapshot = await hub.snapshot();
      if (!win || win.isDestroyed()) return;
      win.webContents.send("reader:init", snapshot);
      ready = true;
      for (const payload of buffered.splice(0)) {
        win.webContents.send("reader:event", payload);
      }
    });
    void win.loadFile(htmlPath);
  }

  function dispose() {
    unsubscribe?.();
    unsubscribe = null;
    win?.destroy();
    win = null;
  }

  return {
    open,
    dispose,
    get window() {
      return win;
    },
  };
}
