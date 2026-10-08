/* 殼與電腦版之間的橋。網頁版沒有這個物件,browser.js 以此判斷是否為電腦版。 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chuanontree", {
  platform: process.platform,
  onCommand: cb => ipcRenderer.on("shell", (_e, cmd, arg) => cb(cmd, arg)),
  moreMenu: (x, y) => ipcRenderer.send("more-menu", x, y),
});
