# CLAUDE.md

給 Claude Code 的專案說明。動手前先讀完。

## 這是什麼

一件新媒體藝術作品,不是產品。它是一個**偽 Chrome**——像素級模仿 Chrome 介面的網頁,
用 `<iframe>` 真的載入其他網站,但整個外殼是作者的。作者是 chuanontree(武威桀 / Wu Wei-Chieh),
創作關注:介面作為隱形作者、擬態、身體商品化、後人類理論。

## 概念守則(重要,別當 bug 修)

- **殼要像素級擬態 Chrome。** 分頁列、網址列、圖示的樣子是作品的功夫,不要「改善」成別的風格。
- **「網站拒絕被套框」是作品核心,不是錯誤。** 命中 `REFUSE_LIST` 的網站會顯示作者的
  `#rupture` 頁而非真的載入。這是刻意的——真實網路拒絕被收編,介面在那一刻現身為作者。
  不要試圖「修好」讓所有網站都能載入,也不要移除 rupture 邏輯。
- 作者的聲音只在兩個地方:`#startpage`(起始頁)與 `#rupture`(拒絕頁)。其他都是擬態。

## 技術限制(先知道,免得白忙)

- **GitHub Pages 是純靜態託管,沒有後端。** 不要提議加 server / proxy / build step。
  部署目標就是把這個資料夾原樣丟上 Pages。
- **多數主流網站(Google、FB、IG、YouTube…)技術上無法被 iframe 套框**(送
  `X-Frame-Options` / CSP `frame-ancestors`)。這無法從前端繞過。因此它們被放進
  `REFUSE_LIST`,讓行為可控。能正常框入的是維基、個人站、作者自己的 github.io 等。
- `js/browser.js` 用 ES module `import`,**必須經 http 伺服器開啟**(`file://` 會被 CORS 擋)。
  本地開發一律用下方 dev server;Pages 本身走 http 沒問題。

## 檔案結構

```
index.html        殼的 HTML + 兩張作者頁(#startpage / #rupture)
css/style.css     全部樣式。前段=Chrome 擬態(勿亂動);末段=兩張作者頁(可發揮)
js/config.js      ★ 策展資料:REFUSE_LIST、起始頁捷徑、預設搜尋引擎。改這裡最頻繁
js/browser.js     引擎:分頁 / 導覽 / 歷史。一般不用動
```

各檔職責分離:**策展改 config.js,外觀改 style.css,頁面內容改 index.html,引擎才動 browser.js。**

## 本地執行

```bash
npm run dev      # 起一個靜態伺服器,通常在 http://localhost:5173
```

沒有 npm 也可以:`python3 -m http.server 5173` 然後開 `http://localhost:5173`。

## 部署到 GitHub Pages

- 已附 `.github/workflows/deploy.yml`:push 到 `main` 會自動部署。
  在 repo 的 Settings → Pages → Build and deployment → Source 選 **GitHub Actions** 一次即可。
- 或手動:Settings → Pages → Source 選 `main` / `root`。入口一定是根目錄的 `index.html`。

## 可能的延伸方向(作者提過)

- **Overlay 模式**:把作者的干擾層疊在成功載入的頁面之上(半透明遮蔽、只露出允許的部分),
  從「被拒絕的隱形作者」翻轉成「強行在場的隱形作者」。若要做,新增一層絕對定位的
  overlay 蓋在 `.view` 上,別動既有 rupture 邏輯。
- 展場 kiosk:用 `--kiosk` 全螢幕跑,或加一個隱藏手勢重置分頁。
