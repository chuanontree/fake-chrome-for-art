# 「炎上 / 公審 / 抵制」熱度 — Threads → TouchDesigner

用 Threads **官方 API** 定期搜尋三個關鍵字,把新串文和每個詞的「熱度」用 OSC 即時送進
TouchDesigner。熱度每來一則串文就升高,沒人說話就慢慢冷卻(半衰期 10 分鐘)。

## 概念說明

這件事本身有一道裂縫,值得在作品裡留著:**蒐集「公審」的資料,就是在重演公審。**
截圖、歸檔、計數、展示——跟網路上的公審用的是同一套動作。橋接程式預設把作者帳號
**匿名化**(`user#a3f2c1` 這種代號),連結也不保留,因為連結裡有原帳號。展出的是「群體的溫度」,
不是「某個人」。要不要讓個人重新浮現(`anonymize: false`),是作者的選擇,也是作品的立場。

偽 Chrome 是「介面作為隱形作者」;這裡,介面再往前一步——**它在看,而且它在記錄**。

## 架構

```
Threads 官方 API ──(每 N 分鐘查詢)──▶ bridge/threads_bridge.py ──OSC──▶ TouchDesigner
                                          │                          port 7000 數值 → OSC In CHOP
                                          └─ threads_log.csv          port 7001 串文 → OSC In DAT
```

查到的一批新串文不會一次湧進 TD,而是**平均攤到下一次查詢前慢慢釋放**,
所以 TD 收到的是穩定的資料流,畫面一直有東西在動。

| 檔案 | 用途 |
|---|---|
| `bridge/threads_bridge.py` | 橋接程式,只用 Python 標準函式庫,不需要 pip |
| `bridge/config.example.json` | 設定範本:關鍵字、查詢額度、匿名、OSC port |
| `bridge/start_demo.bat` | 雙擊:展示模式(不連網、假串文),先做視覺用 |
| `bridge/start_bridge.bat` | 雙擊:正式模式(需要 access token) |
| `bridge/start_browser.bat` | 雙擊:瀏覽器模式(接收偽 Chrome「Threads 蒐集」的資料,不用 API) |
| `build_network.py` | 在 TD 裡一鍵長出整個網絡 |
| `spec.json` | 節點規格(對照用) |

### 送進 TD 的 OSC

| 位址 | port | 內容 |
|---|---|---|
| `/kw/flame/heat`、`/kw/trial/heat`、`/kw/boycott/heat` | 7000 | 熱度 0~1(炎上 / 公審 / 抵制) |
| `/kw/<slug>/total` | 7000 | 啟動後累計串文數 |
| `/kw/<slug>/hour` | 7000 | 最近一小時串文數 |
| `/status/ok` | 7000 | 1 = 查詢正常,0 = 出錯 |
| `/status/next` | 7000 | 距離下次查詢的秒數 |
| `/post` | 7001 | slug、關鍵字、作者(匿名)、內文、發文時間、連結 |

## 操作步驟(Windows)

### 1. 安裝 Python(一次)

到 <https://www.python.org/downloads/> 下載安裝,**勾選「Add python.exe to PATH」**。

### 2. 下載這個資料夾

下載 <https://github.com/chuanontree/fake-chrome-for-art/archive/refs/heads/main.zip>,
解壓縮後裡面的 `td-threads` 資料夾就是這個專案。

### 3. 先用展示模式看效果(不需要 API)

1. 雙擊 `bridge\start_demo.bat`,黑色視窗會開始列出假串文。**讓它開著。**
2. 開 TouchDesigner,新專案,存檔到 `td-threads` 資料夾,取名 `threads_heat.toe`。
3. 把 `build_network.py` 拖進網絡編輯器。
4. 按 `Alt+T` 開 Textport,輸入 `mod('build_network').build()` 按 Enter。
5. 進到 `/project1/output`,看 `out` 這個節點:三條熱度條會隨假串文跳動,下方顯示最新一則。

### 3.5 瀏覽器模式:用偽 Chrome 蒐集(不用官方 API)

> **風險先講清楚:** 這是自動蒐集,違反 Meta 的使用條款,帳號可能被停用。
> 請用另外開的帳號,不要用主帳號。蒐集器不會替你註冊、登入或通過驗證。

偽 Chrome 電腦版內建「Threads 蒐集」:用一個看不見的視窗,以你在偽 Chrome 裡登入的帳號,
定期打開 Threads 搜尋頁,讀取頁面載入的串文資料,交給橋接程式。TD 端完全不用改。

1. 打開偽 Chrome 電腦版,在分頁裡進 `threads.com`,**用新帳號登入**。
2. 雙擊 `bridge\start_browser.bat`(瀏覽器模式的橋接程式),讓黑色視窗開著。
3. 回到偽 Chrome,按網址列最右邊的 **⋮** → **Threads 蒐集 → 蒐集中** 打勾。
4. TD 照第 3 步的做法,熱度條就會隨真實串文跳動。

節奏刻意放慢,像人在看:每 15 分鐘(±15%)一輪;同一輪內,關鍵字之間停 20~45 秒;每個搜尋頁往下捲 3 次。
蒐集器需要登入時會停下這一輪,把蒐集視窗叫出來讓你登入,下一輪自動繼續。

設定在 **⋮ → Threads 蒐集 → 打開設定檔**(`collector.json`):

| 欄位 | 預設 | 說明 |
|---|---|---|
| `enabled` | false | true = 開程式就自動開始蒐集(展場用) |
| `keywords` | 炎上/公審/抵制 | 要跟 `bridge/config.json` 的 `keywords` 一致 |
| `interval_min` | 15 | 每輪間隔(分鐘)。不建議調低,越頻繁越容易被停權 |
| `keyword_gap_sec` | [20, 45] | 關鍵字之間的隨機停頓 |
| `scrolls` | 3 | 每個搜尋頁捲幾次 |
| `require_keyword_in_text` | true | 只收內文真的含關鍵字的串文 |

Threads 改版若讓蒐集失效(黑色視窗一直沒有新串文),按 **⋮ → Threads 蒐集 → 顯示 / 隱藏蒐集視窗** 看它停在哪一頁,截圖給我。

### 4. 申請 Threads 官方 API

Meta 的介面常改版,大方向如下:

1. 到 <https://developers.facebook.com/apps> 建立 App,用途選「**Access the Threads API**」。
2. 權限加入 `threads_basic` 和 `threads_keyword_search`。
3. 在 App 的角色設定,把你的 Threads 帳號加為 **Threads 測試人員**,
   再到 Threads App →「設定 → 帳號 → 網站權限 → 邀請」接受。
4. 在 App 後台產生 **User Access Token**(長效 token,60 天)。
5. 把 `bridge\config.example.json` 複製一份,改名 `config.json`,把 token 貼到 `"access_token"`。
6. 雙擊 `bridge\start_bridge.bat`。

**重要:** 在 Meta 審核通過 `threads_keyword_search` 之前,**搜尋只會找到你自己帳號的串文**。
可以先自己發一則含「炎上」的串文,確認整條管線通了,再送審;通過後就會搜尋所有公開串文。

### 5. 查詢頻率與額度

我查到的資料對搜尋額度說法不一,所以程式不寫死,用 `daily_query_budget` 控制:
每輪查 3 個關鍵字,預設一天 60 次 → **約每 72 分鐘查一輪**。
到 Meta App 後台確認你的實際額度後,可以調高(例如 600 → 約每 7 分鐘)。
若被 Meta 回「呼叫太頻繁」,程式會自動把間隔加倍,TD 的狀態列會顯示「查詢失敗」。

### 6. Token 會過期

長效 token 60 天到期。橋接程式每 7 天會自動更新一次並寫回 `config.json`;
也可以手動執行 `py threads_bridge.py --refresh`。超過 60 天沒跑,就得回 Meta 後台重新產生。

## 設定(`bridge/config.json`)

| 欄位 | 預設 | 說明 |
|---|---|---|
| `keywords` | 炎上/公審/抵制 | `slug: 關鍵字`。slug 是英文代號,要跟 `build_network.py` 的 `KEYWORDS` 一致 |
| `daily_query_budget` | 60 | 一天最多查詢次數 |
| `anonymize` | true | 匿名化作者、不保留連結 |
| `heat_per_post` | 0.25 | 每則串文讓熱度上升多少 |
| `heat_half_life_sec` | 600 | 熱度冷卻的半衰期(秒) |
| `osc_host` | 127.0.0.1 | TD 在別台電腦就改成那台的 IP |

所有收到的串文也會記在 `bridge/threads_log.csv`(可直接用 Excel 開)。

## 疑難排解

- **TD 收不到資料**:確認黑色視窗還開著;Windows 防火牆若跳出詢問,允許 Python。
- **中文變亂碼**:TD 的 OSC In DAT 對 UTF-8 的處理依版本而定。若 `posts` 表是亂碼,告訴我,
  可以改走 UDP In DAT + JSON。
- **熱度條不動但數字有變**:進 `/project1/input/osc_values` 看通道名稱,
  `logic/chan` 會自動相容 `kw/flame/heat` 與 `kw_flame_heat` 兩種格式。
- **關鍵字想換**:改 `config.json` 的 `keywords`,同時改 `build_network.py` 的 `KEYWORDS`,
  再執行一次 `mod('build_network').build()`。
