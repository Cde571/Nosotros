const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  Notification,
  shell,
} = require("electron");
const path = require("node:path");
const { createClient } = require("@supabase/supabase-js");
const { createCloud } = require("./cloud-client.cjs");
let win, tray;
function emit(name, data) {
  if (win && !win.isDestroyed()) win.webContents.send(name, data);
}
const cloud = createCloud(createClient, emit);
function make() {
  win = new BrowserWindow({
    width: 1220,
    height: 740,
    minWidth: 340,
    minHeight: 420,
    frame: false,
    title: "NOSOTROS.",
    icon: path.join(__dirname, "assets", "icon.ico"),
    backgroundColor: "#141413",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile("index.html");
  win.on("close", (event) => {
    if (!app.quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  win.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["https://www.youtube-nocookie.com/embed/*"] },
    (details, callback) => {
      const headers = details.requestHeaders;
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "referer"))
        headers.Referer = "https://nosotros.local/";
      callback({ requestHeaders: headers });
    },
  );
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    win.show();
    win.focus();
  });
  app.whenReady().then(() => {
    make();
    // A bundled PNG is accepted consistently on Windows; SVG tray images are not.
    tray = new Tray(
      nativeImage.createFromPath(path.join(__dirname, "assets", "icon.png")),
    );
    tray.setToolTip("NOSOTROS.");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Abrir", click: () => win.show() },
        {
          label: "Salir",
          click: () => {
            app.quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on("click", () => win.show());
  });
}
ipcMain.handle("widget", (_, on) => {
  win.setAlwaysOnTop(!!on);
  win.setSize(on ? 390 : 1220, on ? 660 : 740);
  win.center();
  return !!on;
});
ipcMain.on("window", (_, action) => {
  if (action === "close") win.hide();
  else if (action === "min") win.minimize();
  else if (action === "max") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
});
ipcMain.handle("notify", (_, title, body) => {
  if (Notification.isSupported())
    new Notification({
      title: String(title).slice(0, 100),
      body: String(body).slice(0, 200),
    }).show();
});
ipcMain.handle("cloud", (_event, op, p) => cloud(op, p));
ipcMain.handle("get-version", () => app.getVersion());
ipcMain.on("open-media", (_, value) => {
  try {
    const url = new URL(value);
    const hosts = [
      "openlibrary.org",
      "www.netflix.com",
      "www.youtube.com",
      "www.teleparty.com",
      "www.imdb.com",
      "commons.wikimedia.org",
    ];
    if (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      hosts.includes(url.hostname)
    )
      shell.openExternal(url.href).catch(() => {});
  } catch {}
});
