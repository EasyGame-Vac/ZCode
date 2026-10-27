const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("duetPet", {
  init: () => ipcRenderer.invoke("pet:init"),
  saveMessages: (messages) => ipcRenderer.invoke("pet:save-messages", messages),
  sendMessage: (text) => ipcRenderer.invoke("pet:send", text),
  cancel: () => ipcRenderer.invoke("pet:cancel"),
  resetSession: () => ipcRenderer.invoke("pet:reset-session"),
  supervisor: (action, payload) => ipcRenderer.invoke("pet:supervisor", { action, payload }),
  models: () => ipcRenderer.invoke("pet:models"),
  setModel: (model) => ipcRenderer.invoke("pet:set-model", model),
  toggle: (collapsed) => ipcRenderer.invoke("pet:toggle", collapsed),
  dragStart: () => ipcRenderer.send("pet:drag-start"),
  dragEnd: () => ipcRenderer.send("pet:drag-end"),
  hide: () => ipcRenderer.invoke("pet:hide"),
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
