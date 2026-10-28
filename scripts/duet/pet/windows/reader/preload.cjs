const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petReader", {
  onInit: (callback) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("reader:init", (_event, state) => callback(state));
  },
  onEvent: (callback) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("reader:event", (_event, event) => callback(event));
  },
  focusPet: () => ipcRenderer.invoke("pet:reader-focus-pet"),
});
