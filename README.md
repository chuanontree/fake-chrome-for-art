# chuanontree — 偽 Chrome

一件新媒體藝術作品:像素級模仿 Chrome 的網頁,用 iframe 真的載入網站,但外殼是作者的。
當網站拒絕被套框時,跳出的不是 Chrome 的錯誤頁,而是作者的頁——**介面作為隱形作者**。

## 快速開始

```bash
npm run dev
# 開 http://localhost:5173
```

(`js/browser.js` 用 ES module,必須經伺服器開啟;直接雙擊 `index.html` 會被 CORS 擋。)

## 你會改的地方

| 想做的事 | 改哪個檔 |
|---|---|
| 哪些網站「裂開」、起始頁捷徑 | `js/config.js` |
| 起始頁 / 拒絕頁的內容 | `index.html`(`#startpage` / `#rupture`) |
| 外觀樣式 | `css/style.css` |
| 分頁 / 導覽邏輯 | `js/browser.js`(少動) |

## 部署

push 到 `main` 會透過 `.github/workflows/deploy.yml` 自動部署。
到 repo Settings → Pages → Source 選 **GitHub Actions**,第一次設定即可。

詳細脈絡與守則見 `CLAUDE.md`。
