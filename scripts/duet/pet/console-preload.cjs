const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petConsole", {
  onHistory: (callback) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("pet-console-history", (_event, lines) => callback(lines));
  },
  onLine: (callback) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("pet-console-line", (_event, line) => callback(line));
  },
  clear: () => ipcRenderer.invoke("pet:console-clear"),
  openRawLog: () => ipcRenderer.invoke("pet:console-open-log"),
});
