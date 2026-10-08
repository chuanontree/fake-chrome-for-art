/* ═══════════════════════════════════════════════════════════
   電腦版外殼 — 用 Electron 把偽 Chrome 變成真的瀏覽器。
   網頁版(GitHub Pages)用 iframe,會被網站拒絕;這裡用 <webview>,
   不受 X-Frame-Options 限制,任何網站都能真的進入。
   殼的畫面仍是同一份 index.html / css / js。
   ═══════════════════════════════════════════════════════════ */
const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const path = require("path");
const collector = require("./collector.cjs");

const KIOSK = process.argv.includes("--kiosk");
const MAC   = process.platform === "darwin";

/* 讓網站以為這是一般的 Chrome(拿掉 Electron 與本程式的識別字) */
app.userAgentFallback = app.userAgentFallback
  .replace(/ Electron\/\S+/, "")
  .replace(` ${app.getName()}/${app.getVersion()}`, "");

let win;

function createWindow(){
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 480, minHeight: 320,
    backgroundColor: "#d5d8dd",
    kiosk: KIOSK,
    /* 隱藏系統標題列,讓分頁列頂到最上面,跟 Chrome 一樣 */
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 14 },
    titleBarOverlay: MAC ? false : { color: "#d5d8dd", symbolColor: "#5f6368", height: 40 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "index.html"));
}

/* 網站開新視窗(target=_blank、window.open)→ 改成開新分頁 */
app.on("web-contents-created", (_e, contents) => {
  if(contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(({ url }) => {
    win?.webContents.send("shell", "open-tab", url);
    return { action: "deny" };
  });
});

/* 網站內容一律不給 Node 權限、不給 preload */
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (_ev, prefs) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
  });
});

/* 選單與快捷鍵。焦點在網頁裡時殼收不到按鍵,所以一律走選單。 */
function menu(){
  const send = cmd => () => win?.webContents.send("shell", cmd);
  const tpl = [
    ...(MAC ? [{ role: "appMenu" }] : []),
    { label: "檔案", submenu: [
      { label: "新分頁",   accelerator: "CmdOrCtrl+T", click: send("new-tab") },
      { label: "關閉分頁", accelerator: "CmdOrCtrl+W", click: send("close-tab") },
      { label: "網址列",   accelerator: "CmdOrCtrl+L", click: send("focus-url") },
      ...(MAC ? [] : [{ type: "separator" }, { role: "quit" }]),
    ]},
    { role: "editMenu" },
    { label: "檢視", submenu: [
      { label: "重新整理", accelerator: "CmdOrCtrl+R", click: send("reload") },
      { label: "上一頁",   accelerator: "CmdOrCtrl+[", click: send("back") },
      { label: "下一頁",   accelerator: "CmdOrCtrl+]", click: send("fwd") },
      { type: "separator" },
      { role: "togglefullscreen" },
      { role: "toggleDevTools" },
    ]},
    { label: "Threads 蒐集", submenu: threadsItems() },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function threadsItems(){
  return [
    { label: "蒐集中", type: "checkbox", checked: collector.isRunning(),
      click: () => collector.isRunning() ? collector.stop() : collector.start() },
    { label: "顯示 / 隱藏蒐集視窗", click: () => collector.toggleWindow() },
    { label: "打開設定檔", click: () => collector.openConfig() },
  ];
}

/* 「⋮」按鈕跳出的選單,跟 Chrome 一樣。Windows 隱藏了標題列,選單列看不到,所以功能都要能從這裡找到。 */
ipcMain.on("more-menu", (_e, x, y) => {
  const send = cmd => () => win?.webContents.send("shell", cmd);
  Menu.buildFromTemplate([
    { label: "新分頁", accelerator: "CmdOrCtrl+T", click: send("new-tab") },
    { type: "separator" },
    { label: "Threads 蒐集", submenu: threadsItems() },
    { type: "separator" },
    { label: "全螢幕", role: "togglefullscreen" },
    { label: "開發人員工具", role: "toggleDevTools" },
    ...(MAC ? [] : [{ type: "separator" }, { label: "結束", role: "quit" }]),
  ]).popup({ window: win, x: Math.round(x), y: Math.round(y) });
});

app.whenReady().then(() => {
  collector.onChange(menu);
  menu(); createWindow();
  collector.init();
});
app.on("window-all-closed", () => app.quit());
