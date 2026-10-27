const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("duetPet", {
  init: () => ipcRenderer.invoke("pet:init"),
  sendMessage: (text) => ipcRenderer.invoke("pet:send", text),
  cancel: () => ipcRenderer.invoke("pet:cancel"),
  resetSession: () => ipcRenderer.invoke("pet:reset-session"),
  supervisor: (action, payload) => ipcRenderer.invoke("pet:supervisor", { action, payload }),
  toggle: (collapsed) => ipcRenderer.invoke("pet:toggle", collapsed),
  hide: () => ipcRenderer.invoke("pet:hide"),
  openLog: () => ipcRenderer.invoke("pet:open-log"),
  onEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on("pet:event", listener);
    return () => {
      ipcRenderer.removeListener("pet:event", listener);
    };
  },
});
