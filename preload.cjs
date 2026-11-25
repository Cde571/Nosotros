const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  getVersion: () => ipcRenderer.invoke("get-version"),
  openMedia: (url) => ipcRenderer.send("open-media", url),
  window: (action) => ipcRenderer.send("window", action),
  widget: (on) => ipcRenderer.invoke("widget", on),
  notify: (a, b) => ipcRenderer.invoke("notify", a, b),
  cloud: (op, p) => ipcRenderer.invoke("cloud", op, p),
  on: (name, fn) => {
    if (["changed", "sync", "session"].includes(name))
      ipcRenderer.on(name, (_, v) => fn(v));
  },
});
