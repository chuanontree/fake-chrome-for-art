# 《蜂窩性組織言》資料端 — Threads 事件 → TouchDesigner

從 Threads 取得「群體發炎」的強度,**去語意化**(只留強度,不呈現、不儲存貼文內容),
用 OSC 即時送進 TouchDesigner。

資料來源是偽 Chrome 電腦版的「Threads 蒐集」:用另開的帳號,以人的節奏瀏覽 Threads 的搜尋頁與串文頁。
偽 Chrome 在這裡只是**工具**。這樣蒐集違反 Meta 使用條款,帳號可能被停用,請只用另開的帳號。

## 事件,而不是關鍵字

貼文出現「炎上」「公審」不等於正在發生群體發炎:可能是新聞、分析、玩笑、廣告。
所以這裡以**事件**為單位,關鍵字只是發現線索。

- **事件 = 一則根貼文**(及其回覆串)。根貼文被刪除時,改用回覆鏈最上層看得到的那則。
- **發現**:每輪搜尋三個關鍵字的「最新」頁(主要)與「熱門」頁(每 4 輪一次)。
  命中的是回覆時,打開它的頁面找根貼文;根貼文只是沒載入、看不出被刪除時,略過並記錄數量。
- **追蹤**:每輪重看追蹤中的事件,記下回覆數、讚數、引用數,以及前幾十則回覆的樣本。
- **強度(0~1)**,只用數字,不看內容:

  | 指標 | 怎麼算 | 預設權重 |
  |---|---|---|
  | 回覆速度 | 兩次重看之間,每 10 分鐘新增幾則回覆 | 0.40 |
  | 回覆/讚 | 回覆數 ÷ (讚數 + 1);被圍剿的貼文通常很高 | 0.25 |
  | 參與多樣性 | 回覆樣本裡不重複帳號 ÷ 樣本則數 | 0.15 |
  | 引用數 | 引用貼文數 | 0.10 |
  | 回覆深度 | 回覆樣本裡第 2 層以後的比例 | 0.10 |
  | 多關鍵字命中 | 同一事件被兩個以上關鍵字命中 | 0(只記錄) |

- **生命週期**:0 發現 → 1 升溫(速度變快)→ 2 高峰(速度在最高點的 60% 以上)
  → 3 冷卻(速度掉下來)→ 4 消失(60 分鐘沒有新回覆,不再追蹤)。

實測依據(2026/10/22,Threads 網頁):「最新」命中多半是回覆、內容約 10 小時內;
「熱門」全是根貼文但多為數天前;兩者完全不重疊;標籤搜尋的內容太舊,不用。

## 架構

```
偽 Chrome「Threads 蒐集」 ──UDP 7010(只有數字)──▶ bridge/threads_bridge.py ──OSC──▶ TouchDesigner
   搜尋頁 / 串文頁                                     事件引擎 events.py            7000 數值
                                                     錄製 recordings/*.jsonl        7001 事件清單
                                                     事件紀錄 events_log.csv
```

蒐集器送出的觀察值只有數字;事件 ID 一進橋接程式就加鹽雜湊(鹽存在 `state.json`,不進 repo),
之後的錄製檔、事件紀錄、OSC 都只用雜湊。

### 送進 TD 的 OSC

| 位址 | port | 內容 |
|---|---|---|
| `/global/heat` | 7000 | 0~1,所有事件強度的彙總(給全局光線與聲音) |
| `/events/active` | 7000 | 追蹤中的事件數 |
| `/kw/<slug>/heat` | 7000 | 0~1,各關鍵字相關事件的強度彙總 |
| `/status/ok`、`/status/next` | 7000 | 蒐集是否正常、距離下一輪幾秒 |
| `/event` | 7001 | 匿名 ID、強度、階段(0~4)、出現至今(分)、出現時間;每秒每個事件一次,消失時送一次階段 4 |

## 檔案

| 檔案 | 用途 |
|---|---|
| `bridge/start_browser.bat` | 雙擊:即時模式,接收偽 Chrome 的蒐集(會自動錄製) |
| `bridge/start_replay.bat` | 雙擊:重播最新一份錄製檔,預設 60 倍速;`start_replay.bat 10` = 10 倍速 |
| `bridge/start_demo.bat` | 雙擊:展示模式,合成事件(不連網) |
| `bridge/evaluate.bat` | 雙擊:精準度評估(標記完之後) |
| `bridge/events.py` | 事件引擎:強度、生命週期 |
| `bridge/config.example.json` | 設定範本。要改就複製成 `config.json` 再改 |
| `build_network.py` | TD 網絡(階段 B 會改成事件清單 + 蜂格視覺) |

## 使用步驟(Windows)

1. 裝 Python:<https://www.python.org/downloads/>,勾選「Add python.exe to PATH」。
2. 下載偽 Chrome 電腦版:<https://github.com/chuanontree/fake-chrome-for-art/releases/download/desktop-latest/chuanontree-windows.zip>
3. 下載這個專案:<https://github.com/chuanontree/fake-chrome-for-art/archive/refs/heads/main.zip>,裡面的 `td-threads` 資料夾。

### 即時追蹤

1. 雙擊 `bridge\start_browser.bat`,黑色視窗開著。
2. 打開偽 Chrome,用另開的帳號登入 `threads.com`。
3. **⋮ → Threads 蒐集 → 蒐集中** 打勾。
4. 黑色視窗每輪會顯示:開了幾頁、命中幾則、回覆找到幾個事件、追蹤中幾個;每 10 分鐘顯示累計
   (觀察值、事件、消失、遺失訊息)。
5. 錄製檔在 `bridge\recordings\`;事件紀錄(只有數字)在 `bridge\events_log.csv`。

### 重播(調視覺用,不必每次都連 Threads)

雙擊 `bridge\start_replay.bat`(60 倍速,3 小時的錄製約 3 分鐘看完)。TD 端收到的和即時一模一樣。

### 精準度評估

1. 偽 Chrome:**⋮ → Threads 蒐集 → 精準度評估取樣(約 1 小時)**。
   會從「熱門」「最新」各抽一半,共 100 則,在暫存資料夾產生兩個檔,並自動打開資料夾:
   - `標記.csv`:編號、命中貼文與事件根貼文的原文、空白的「你的標記」欄
   - `指標.csv`:只有數字(分開放,標記時看不到指標,不會被影響)
2. 用 Excel 打開 `標記.csv`,「你的標記」填 **是**(真的在發生群體發炎)或 **否**,另存為「CSV UTF-8」。
3. 雙擊 `bridge\evaluate.bat`,產生 `評估報告_日期.md`:
   - 關鍵字計數 vs 事件指標的準確率、精確率、召回率
   - 熱門 vs 最新,哪一種真正群體發炎的比例較高
   - 各指標的鑑別力(哪些有用)
   - 誤判類型與編號
4. 對照完誤判的編號後按 Enter,`標記.csv` 與 `指標.csv`(含原文)會被刪除。報告本身沒有原文。

## 設定

`bridge/config.json`(橋接程式)的 `events`:權重、`k`(各指標到 0.5 的值)、`min_velocity`、
`peak_ratio`、`quiet_min`(幾分鐘沒新回覆就消失)、`max_events`。

偽 Chrome 的 `collector.json`(**⋮ → Threads 蒐集 → 打開設定檔**):

| 欄位 | 預設 | 說明 |
|---|---|---|
| `interval_min` | 15 | 每輪間隔(分鐘,±15% 隨機) |
| `pages_per_round` | 12 | 每輪最多開幾頁(搜尋頁 + 串文頁) |
| `keyword_gap_sec` | [20, 45] | 每開一頁之間停幾秒 |
| `top_every_rounds` | 4 | 每幾輪看一次「熱門」 |
| `root_fallback` | deleted_only | 根貼文被刪除才退到回覆鏈最上層;`always` = 沒載入也退 |
| `quiet_min` | 60 | 要跟橋接程式的 `events.quiet_min` 一致 |
| `eval_target` | 100 | 評估抽幾則 |

## 測試

- 事件引擎:`cd bridge` 後 `py -m unittest test_events`
- 頁面解析:`node electron/observe.test.cjs`(在 repo 根目錄)
