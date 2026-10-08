# chuanontree — 偽 Chrome

一件新媒體藝術作品:像素級模仿 Chrome 的網頁,用 iframe 真的載入網站,但外殼是作者的。
當網站拒絕被套框時,跳出的不是 Chrome 的錯誤頁,而是作者的頁——**介面作為隱形作者**。

## 快速開始

```bash
npm run dev
# 開 http://localhost:5173
```

(`js/browser.js` 用 ES module,必須經伺服器開啟;直接雙擊 `index.html` 會被 CORS 擋。)

## 電腦版:真的能進任何網站

網頁版受瀏覽器規則限制,Google、IG、Threads 這類網站一定會拒絕被套框。
電腦版用 Electron 把同一個外殼變成真的瀏覽器,**任何網站都能真的進入**,不再拒絕;
網站真的連不上時,顯示擬態 Chrome 的「無法連上這個網站」。

### 下載即用(推薦)

到 **[Releases → 偽 Chrome 電腦版(最新)](https://github.com/chuanontree/fake-chrome-for-art/releases/latest)** 下載:

- **Mac**:`chuanontree-mac.zip` → 解壓縮 → 把 `chuanontree` 拖進「應用程式」→ 雙擊開啟。
  第一次若被擋下,到「系統設定 → 隱私權與安全性」按「仍要打開」。
  (若顯示「已損毀」,在終端機執行 `xattr -cr /Applications/chuanontree.app` 再開。)
- **Windows**:`chuanontree-windows.zip` → 解壓縮 → 執行資料夾裡的 `chuanontree.exe`。
  若出現 SmartScreen,按「其他資訊」→「仍要執行」。

每次推送到 `main` 會由 `.github/workflows/desktop.yml` 自動重新打包。
展場全螢幕:Mac 執行 `open -a chuanontree --args --kiosk`,Windows 執行 `chuanontree.exe --kiosk`。

### 從原始碼執行(開發用)

需要先安裝 [Node.js](https://nodejs.org)(LTS 版即可),然後在專案資料夾:

```bash
npm install      # 第一次才需要,會下載 Electron
npm run app      # 開啟視窗
npm run kiosk    # 展場用:全螢幕、無法離開(macOS 按 ⌘Q 結束)
```

快捷鍵與 Chrome 相同:⌘T 新分頁、⌘W 關閉分頁、⌘L 網址列、⌘R 重新整理、⌘[ / ⌘] 上一頁 / 下一頁
(Windows 用 Ctrl)。

已知限制:Google 帳號登入會擋「嵌入式瀏覽器」,可能無法在電腦版登入 Google;
其他網站(IG、Threads、YouTube 等)的登入一般可用。

## 你會改的地方

| 想做的事 | 改哪個檔 |
|---|---|
| 哪些網站「裂開」、起始頁捷徑 | `js/config.js` |
| 起始頁 / 拒絕頁的內容 | `index.html`(`#startpage` / `#rupture`) |
| 外觀樣式 | `css/style.css` |
| 分頁 / 導覽邏輯 | `js/browser.js`(少動) |
| 電腦版視窗、選單、快捷鍵 | `electron/main.cjs` |

## 部署

push 到 `main` 會透過 `.github/workflows/deploy.yml` 自動部署。
到 repo Settings → Pages → Source 選 **GitHub Actions**,第一次設定即可。

詳細脈絡與守則見 `CLAUDE.md`。

## 延伸:Threads 關鍵字 → TouchDesigner

`td-threads/` 用 Threads 官方 API 追蹤「炎上 / 公審 / 抵制」,把串文與熱度即時用 OSC 送進
TouchDesigner。步驟見 [`td-threads/README.md`](td-threads/README.md)。
