/* ═══════════════════════════════════════════════════════════
   Threads 蒐集器(電腦版)—《蜂窩性組織言》的資料來源工具
   用一個看不見的視窗,以你在偽 Chrome 裡登入的帳號(另開的帳號),以人的節奏
   打開 Threads 的搜尋頁與串文頁,讀頁面載入的資料,把「事件」的觀察值
   (只有數字:回覆數、讚數、引用數、回覆樣本)送給 td-threads/bridge/threads_bridge.py --browser。
   不送任何貼文文字或帳號;事件 ID 由橋接程式一收到就雜湊。

   · 事件 = 根貼文。關鍵字只用來發現候選:「最新」為主、「熱門」為輔(每幾輪看一次)。
   · 命中的是回覆時,打開它的頁面找根貼文;根貼文被刪除時,改用回覆鏈最上層看得到的那則。
   · 每輪重看追蹤中的事件,讓橋接程式算回覆速度與生命週期。
   · 只開搜尋頁與串文頁,不開推薦動態。不碰帳號註冊、登入或驗證。
   · 預設關閉,由「⋮ → Threads 蒐集」開啟。
   ═══════════════════════════════════════════════════════════ */
const { app, BrowserWindow, shell } = require("electron");
const dgram = require("dgram");
const fs = require("fs");
const path = require("path");
const O = require("./observe.cjs");

const DEFAULTS = {
  enabled: false,                              // true = 開程式就開始蒐集
  keywords: { flame: "炎上", trial: "公審", boycott: "抵制" },   // 要跟 bridge 的 config.json 一致
  interval_min: 15,                            // 每輪間隔(分鐘,實際會 ±15% 隨機)
  keyword_gap_sec: [20, 45],                   // 每開一頁之間停多久
  scrolls: 3,                                  // 每個搜尋頁往下捲幾次
  scroll_gap_sec: [2, 5],
  pages_per_round: 12,                         // 每輪最多開幾頁(搜尋頁 + 串文頁)
  top_every_rounds: 4,                         // 每幾輪看一次「熱門」
  thread_scrolls: 4,                           // 事件頁往下捲幾次(載入回覆樣本)
  root_fallback: "deleted_only",               // 根貼文被刪除才退到回覆鏈最上層;"always" = 沒載入也退
  quiet_min: 60,                               // 這麼久沒有新回覆就不再追蹤(要跟 bridge 的 events.quiet_min 一致)
  max_tracked: 40,                             // 同時追蹤上限
  eval_target: 100,                            // 精準度評估抽幾則
  eval_gap_sec: [8, 15],                       // 評估取樣時每開一頁之間停多久
  search_url: "https://www.threads.com/search?q=%s&serp_type=default&filter=recent",
  bridge_host: "127.0.0.1",
  bridge_port: 7010,
};

const configPath = () => process.env.CHUANONTREE_COLLECTOR_CONFIG
  || path.join(app.getPath("userData"), "collector.json");

let cfg, bot, timer = null, running = false, quitting = false;
let ok = true, nextAt = 0, statusTimer = null, seq = 0, roundNo = 0;
const tracked = new Map();                     // 事件 id -> { url, replies, lastChange, lastVisit, sampled }
const replyRoot = new Map();                   // 回覆 id -> 事件 id(null = 找不到根貼文)
const udp = dgram.createSocket("udp4");
const listeners = new Set();                   // 選單用:狀態改變時重畫

function loadConfig(){
  let user = {};
  try{ user = JSON.parse(fs.readFileSync(configPath(), "utf8")); }catch(e){}
  cfg = { ...DEFAULTS, ...user };
  if(!fs.existsSync(configPath())){
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(DEFAULTS, null, 2));
  }
  return cfg;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const between = ([a, b]) => (a + Math.random() * (b - a)) * 1000;
const send = obj => udp.send(Buffer.from(JSON.stringify({ ...obj, seq: ++seq })), cfg.bridge_port, cfg.bridge_host);
/* 同時印出並送給橋接程式,讓黑色視窗看得到蒐集器在做什麼 */
const log = (...a) => {
  console.log(new Date().toTimeString().slice(0, 8), "[蒐集]", ...a);
  if(cfg) send({ type: "log", msg: a.join(" ") });
};
const changed = () => listeners.forEach(f => f());

/* 讀頁面時,串文物件送到 sink(由 readPage / 實測工具設定) */
let sink = null;
let probing = false;

function harvest(text){
  if(sink && text && text.length >= 20) O.parseJsonish(text).forEach(j => O.findPosts(j).forEach(sink));
}

/* ── 看不見的瀏覽視窗(跟偽 Chrome 共用登入)── */
function makeBot(){
  bot = new BrowserWindow({
    show: false, width: 1100, height: 900, title: "Threads 蒐集視窗",
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  bot.webContents.setAudioMuted(true);
  bot.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  bot.on("close", e => { if(!quitting){ e.preventDefault(); bot.hide(); changed(); } });

  /* 讀網路回應:Threads 的搜尋結果透過 GraphQL 載入 */
  const dbg = bot.webContents.debugger;
  dbg.attach("1.3");
  dbg.sendCommand("Network.enable");
  const pending = new Set();
  dbg.on("message", async (_e, method, params) => {
    if(method === "Network.responseReceived"){
      const t = params.response.mimeType || "";
      if(/graphql|\/api\//.test(params.response.url) || t.includes("json")) pending.add(params.requestId);
    } else if(method === "Network.loadingFinished" && pending.delete(params.requestId)){
      try{
        const r = await dbg.sendCommand("Network.getResponseBody", { requestId: params.requestId });
        harvest(r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body);
      }catch(e){}
    }
  });
}

/* 頁面一開始就內嵌在 HTML 裡的資料 */
async function harvestEmbedded(){
  try{
    const blobs = await bot.webContents.executeJavaScript(
      `[...document.querySelectorAll('script[type="application/json"]')].map(s => s.textContent)`);
    blobs.forEach(harvest);
  }catch(e){}
}

function needsLogin(){
  const u = bot.webContents.getURL();
  return /\/login|accounts\/login/.test(u);
}

const origin = () => new URL(cfg.search_url).origin;
const searchUrl = (mode, q) => `${origin()}/search?q=${encodeURIComponent(q)}&serp_type=${mode === "標籤" ? "tags" : "default"}` +
                               (mode === "最新" ? "&filter=recent" : "");
const pageOf = p => `${origin()}/@${encodeURIComponent(p.username)}/post/${encodeURIComponent(p.code)}`;
const emit = (p, extra) => send(O.obsOf(p, extra));

/* 打開一頁,回傳頁面上的串文物件;需要登入時回傳 null */
async function readPage(url, scrolls){
  const found = new Map();
  sink = p => { if(!found.has(p.id)) found.set(p.id, p); };
  try{ return (await visit(url, scrolls)) ? [...found.values()] : null; }
  finally{ sink = null; }
}

function loginNeeded(){
  ok = false;
  log("需要登入 Threads:已打開蒐集視窗,請在裡面登入,下一輪會自動繼續");
  bot.show();
}

function track(p){
  const replies = O.tpa(p).direct_reply_count ?? 0;
  const t = tracked.get(p.id);
  if(!t){
    if(tracked.size >= cfg.max_tracked){
      const stalest = [...tracked.entries()].sort((a, b) => a[1].lastChange - b[1].lastChange)[0][0];
      tracked.delete(stalest);
    }
    tracked.set(p.id, { url: pageOf(p), replies, lastChange: Date.now(), lastVisit: 0, sampled: 0 });
  } else if(replies > t.replies){
    t.replies = replies; t.lastChange = Date.now();
  }
}

/* 一輪:搜尋 → 回覆找事件 → 重看事件。總頁數不超過 pages_per_round。 */
async function round(){
  timer = null;
  if(!running) return;
  ok = true;
  roundNo++;
  const budget = cfg.pages_per_round;
  const modes = ["最新", ...((roundNo - 1) % cfg.top_every_rounds === 0 ? ["熱門"] : [])];
  const stat = { pages: 0, hits: 0, roots: 0, replies: 0, resolved: 0, unresolved: 0, revisited: 0 };
  const gap = () => sleep(between(cfg.keyword_gap_sec));
  const pending = [];

  search: for(const [, kw] of Object.entries(cfg.keywords)){
    for(const mode of modes){
      if(!running) return;
      const posts = await readPage(searchUrl(mode, kw), cfg.scrolls); stat.pages++;
      if(!posts){ loginNeeded(); break search; }
      for(const p of posts.filter(p => O.isHit(p, kw) && !O.isGone(p))){
        stat.hits++;
        if(!O.tpa(p).is_reply){ stat.roots++; emit(p, { kw, source: mode }); track(p); }
        else if(replyRoot.has(p.id)){ const ev = replyRoot.get(p.id); if(ev) send({ type: "obs", id: ev, kw, source: mode }); }
        else if(!pending.some(x => x.p.id === p.id)){ stat.replies++; pending.push({ p, kw, mode }); }
      }
      await gap();
    }
  }

  /* 命中的回覆 → 打開它的頁面找事件(新的回覆優先;留三分之一頁數給重看) */
  pending.sort((a, b) => (b.p.taken_at || 0) - (a.p.taken_at || 0));
  const reserve = Math.min(tracked.size, Math.floor(budget / 3));
  for(const { p, kw, mode } of pending){
    if(!running || !ok || stat.pages >= budget - reserve) break;
    const posts = await readPage(pageOf(p), 0); stat.pages++;
    if(!posts){ loginNeeded(); break; }
    const r = O.resolveEvent(posts, cfg.root_fallback);
    replyRoot.set(p.id, r.event ? r.event.id : null);
    if(r.event){ stat.resolved++; emit(r.event, { kw, source: mode, fallback: r.fallback }); track(r.event); }
    else stat.unresolved++;
    await gap();
  }

  /* 重看追蹤中的事件:還沒看過自己頁面的優先,其次最久沒看的 */
  const order = [...tracked.entries()].sort((a, b) => (a[1].sampled - b[1].sampled) || (a[1].lastVisit - b[1].lastVisit));
  for(const [id, t] of order){
    if(!running || !ok || stat.pages >= budget) break;
    const posts = await readPage(t.url, cfg.thread_scrolls); stat.pages++;
    if(!posts){ loginNeeded(); break; }
    t.lastVisit = Date.now();
    const e = posts.find(p => p.id === id);
    if(e){ t.sampled = 1; stat.revisited++; emit(e, { sample: O.sampleOf(posts, id) }); track(e); }
    await gap();
  }

  for(const [id, t] of tracked) if(Date.now() - t.lastChange > cfg.quiet_min * 60000) tracked.delete(id);
  while(replyRoot.size > 5000) replyRoot.delete(replyRoot.keys().next().value);
  log(`第 ${roundNo} 輪(${modes.join("+")}):開了 ${stat.pages} 頁;命中 ${stat.hits} 則(根貼文 ${stat.roots}、新的回覆 ${stat.replies});` +
      `回覆找到事件 ${stat.resolved}、找不到 ${stat.unresolved};重看事件 ${stat.revisited};追蹤中 ${tracked.size}`);
  if(!running) return;
  const wait = cfg.interval_min * 60000 * (0.85 + Math.random() * 0.3);
  nextAt = Date.now() + wait;
  log(`這輪結束,${Math.round(wait / 60000)} 分鐘後再搜尋`);
  timer = setTimeout(round, wait);
  changed();
}

function start(){
  if(running) return;
  loadConfig();
  if(!bot) makeBot();
  running = true;
  log(`開始蒐集:${Object.values(cfg.keywords).join("、")} → ${cfg.bridge_host}:${cfg.bridge_port}`);
  statusTimer = setInterval(() => send({ type: "status", ok, next: Math.max(0, (nextAt - Date.now()) / 1000),
                                         interval: cfg.interval_min * 60 }), 1000);
  round();
  changed();
}

function stop(){
  running = false;
  clearTimeout(timer); timer = null;
  clearInterval(statusTimer);
  log("已停止蒐集");
  changed();
}

/* ── 資料結構實測:Threads 網頁的串文物件裡有哪些欄位可當事件指標 ──
   只記欄位路徑、型別、有值比例、數字範圍;文字只記長度,ID 類只記「有」。
   不記任何內文、帳號、ID。報告存到桌面。 */
const ID_KEY = /(^|_)(pk|id|fbid|code|shortcode|username|full_name|url|uri|token)$/i;

function schemaAdd(stats, obj, prefix = "", depth = 0){
  if(depth > 4 || !obj || typeof obj !== "object") return;
  for(const k of Object.keys(obj)){
    const v = obj[k];
    const path = prefix + (Array.isArray(obj) ? "[]" : (prefix ? "." : "") + k);
    if(Array.isArray(obj) && k !== "0") continue;          // 陣列只看第一個元素
    const s = stats[path] || (stats[path] = { n: 0, nonnull: 0, types: new Set(), min: null, max: null, maxlen: 0, trues: 0 });
    s.n++;
    if(v === null || v === undefined || v === ""){ s.types.add("null"); }
    else{
      s.nonnull++;
      const t = Array.isArray(v) ? "array" : typeof v;
      s.types.add(t);
      if(t === "number" && !ID_KEY.test(k)){
        s.min = s.min === null ? v : Math.min(s.min, v);
        s.max = s.max === null ? v : Math.max(s.max, v);
      }
      if(t === "string") s.maxlen = Math.max(s.maxlen, v.length);
      if(t === "boolean" && v) s.trues++;
      if(t === "array") s.maxlen = Math.max(s.maxlen, v.length);
    }
    if(v && typeof v === "object") schemaAdd(stats, v, Array.isArray(v) ? path + "[]" : path, depth + 1);
  }
}

function schemaTable(stats, total){
  const fmt = n => n === null ? "" : (Math.abs(n) >= 1e9 ? "≥1e9" : String(n));
  const rows = Object.keys(stats).sort().slice(0, 500).map(p => {
    const s = stats[p];
    const leaf = p.split(/[.\[\]]+/).filter(Boolean).pop() || p;
    let detail = "";
    if(ID_KEY.test(leaf)) detail = "(識別資料,不記值)";
    else if(s.min !== null) detail = `${fmt(s.min)} ~ ${fmt(s.max)}`;
    else if(s.types.has("string")) detail = `文字,最長 ${s.maxlen} 字`;
    else if(s.types.has("boolean")) detail = `true ${s.trues} 次`;
    else if(s.types.has("array")) detail = `最多 ${s.maxlen} 項`;
    return `| \`${p}\` | ${s.nonnull}/${total} | ${[...s.types].join(",")} | ${detail} |`;
  });
  return ["| 欄位路徑 | 有值 | 型別 | 範圍 / 說明 |", "|---|---|---|---|", ...rows];
}

/* 往下捲:整頁加上所有可捲動的內層容器(Threads 的回覆列表捲在內層) */
const SCROLL_ALL = `(() => {
  window.scrollBy(0, innerHeight * 1.5);
  for(const el of document.querySelectorAll("div, main, section")){
    if(el.scrollHeight > el.clientHeight + 50){
      const s = getComputedStyle(el).overflowY;
      if(s === "auto" || s === "scroll") el.scrollTop += el.clientHeight * 1.5;
    }
  }
})()`;

async function visit(url, scrolls = 2, afterScroll = null){
  try{ await bot.loadURL(url); }catch(e){ if(!String(e).includes("ERR_ABORTED")) log("載入失敗:", e.message); }
  await sleep(between([3, 6]));
  if(needsLogin()) return false;
  await harvestEmbedded();
  afterScroll?.(0);
  for(let s = 1; s <= scrolls; s++){
    try{ await bot.webContents.executeJavaScript(SCROLL_ALL); }catch(e){}
    await sleep(between(cfg.scroll_gap_sec));
    await harvestEmbedded();
    afterScroll?.(s);
  }
  return true;
}

/* ── 事件實測:回覆找得到根貼文嗎?回覆串載入得到多少?回覆數隔幾分鐘會變嗎? ──
   報告只有數字與是非,沒有內文、帳號、ID。 */
const tpa = p => p.raw?.text_post_app_info || {};
const counts = p => ({ 回覆: tpa(p).direct_reply_count, 讚: p.raw?.like_count, 引用: tpa(p).quote_count, 轉發: tpa(p).repost_count });
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : "—"; };

async function probeEvents(){
  if(probing) return;
  probing = true;
  changed();
  const wasRunning = running;
  if(wasRunning) stop();
  loadConfig();
  if(!bot) makeBot();
  const origin = new URL(cfg.search_url).origin;
  const pageOf = p => `${origin}/@${encodeURIComponent(p.username)}/post/${encodeURIComponent(p.code)}`;
  const lines = ["# Threads 事件實測", "", `時間:${new Date().toLocaleString()}`, "",
    "只有數字與是非;沒有任何內文、帳號、ID、標籤名稱。", "",
    "## 1. 三種搜尋頁的比較:熱門 / 最新 / 標籤", "",
    "「網址」欄是載入後實際停留的網址參數,用來確認 Threads 有沒有把我們導到別的分頁。", ""];
  const revisit = [];
  /* 搜尋頁的三種模式。Threads 網頁的參數以實測結果為準(見報告「網址」欄)。 */
  const MODES = {
    熱門: q => `${origin}/search?q=${encodeURIComponent(q)}&serp_type=default`,
    最新: q => `${origin}/search?q=${encodeURIComponent(q)}&serp_type=default&filter=recent`,
    標籤: q => `${origin}/search?q=${encodeURIComponent(q)}&serp_type=tags`,
  };
  const params = () => { try{ const u = new URL(bot.webContents.getURL()); return [...u.searchParams].filter(([k]) => k !== "q").map(([k, v]) => `${k}=${v}`).join("&") || "(無)"; }catch(e){ return "?"; } };
  const ageHours = p => p.taken_at ? (Date.now() / 1000 - p.taken_at) / 3600 : null;
  try{
    log("事件實測開始(約 18 分鐘)");
    const plan = [], hitKws = new Map(), tagged = [];
    lines.push("| 關鍵字 | 模式 | 網址 | 讀到 | 含關鍵字 | 根貼文 / 回覆 | 根貼文回覆數中位數 | 貼文距今中位數(小時) | 帶主題標籤 |",
               "|---|---|---|---|---|---|---|---|---|");
    for(const [, kw] of Object.entries(cfg.keywords)){
      const byMode = {};
      for(const [mode, url] of Object.entries(MODES)){
        const found = new Map();
        sink = p => { if(!found.has(p.id)) found.set(p.id, p); };
        if(!await visit(url(kw))){
          lines.push("", "**需要登入 Threads,實測中止。**"); bot.show(); return;
        }
        /* 內文或主題標籤含關鍵字都算命中(標籤頁的貼文內文不一定有這個字) */
        const hits = [...found.values()].filter(p => p.text.includes(kw) || (tpa(p).tag_header?.display_name || "").includes(kw));
        const roots = hits.filter(p => !tpa(p).is_reply), replies = hits.filter(p => tpa(p).is_reply);
        const ages = hits.map(ageHours).filter(v => v !== null).map(v => Math.round(v));
        byMode[mode] = new Set(hits.map(p => p.id));
        lines.push(`| ${kw} | ${mode} | ${params()} | ${found.size} | ${hits.length} | ${roots.length} / ${replies.length} | ` +
          `${median(roots.map(p => tpa(p).direct_reply_count || 0))} | ${median(ages)} | ${hits.filter(p => p.raw?.text_post_app_info?.tag_header).length} |`);
        if(mode !== "標籤"){
          hits.forEach(p => { if(!hitKws.has(p.id)) hitKws.set(p.id, new Set()); hitKws.get(p.id).add(kw); });
          const byReplies = (a, b) => (tpa(b).direct_reply_count || 0) - (tpa(a).direct_reply_count || 0);
          if(roots.length && !plan.some(x => x.kw === kw && x.kind === "根貼文")) plan.push({ kw, kind: "根貼文", post: roots.sort(byReplies)[0] });
          if(replies.length && !plan.some(x => x.kw === kw && x.kind === "回覆")) plan.push({ kw, kind: "回覆", post: replies.sort(byReplies)[0] });
          roots.forEach(p => { const t = tpa(p).tag_header?.display_name; if(t && !tagged.some(x => x.tag === t)) tagged.push({ kw, tag: t }); });
        }
        await sleep(between(cfg.keyword_gap_sec));
      }
      const both = [...byMode.熱門].filter(id => byMode.最新.has(id)).length;
      lines.push(`|  | 熱門∩最新 |  |  | ${both} 則重疊 |  |  |  |  |`);
    }
    lines.push("", `- 同一則被兩個以上關鍵字命中(熱門+最新):${[...hitKws.values()].filter(s => s.size > 1).length} 則`);

    lines.push("", "## 2. 串文頁:找得到根貼文嗎?回覆載入多少?", "");
    for(const item of plan){
      const objs = new Map(), growth = [];
      sink = p => { if(!objs.has(p.id)) objs.set(p.id, p); };
      if(!await visit(pageOf(item.post), 5, () => growth.push(objs.size))) break;
      const all = [...objs.values()];
      const root = all.find(p => !tpa(p).is_reply);
      const replies = all.filter(p => tpa(p).is_reply);
      const levels = all.map(p => tpa(p).reply_level).filter(v => typeof v === "number");
      const dist = [0, 1, 2, 3, 4].map(l => levels.filter(v => v === l).length).join("/");
      let s = `- 「${item.kw}」的${item.kind}頁:串文物件 ${all.length}(每次捲動後累計 ${growth.join("→")})、` +
              `不重複帳號 ${new Set(all.map(p => p.username)).size}、reply_level 0/1/2/3/4 = ${dist}`;
      if(item.kind === "回覆"){
        const want = tpa(item.post).root_post_author?.username;
        s += `;找到根貼文:${root ? "是" : "否"}` + (root && want ? `,與回覆記錄的根作者${root.username === want ? "相符" : "不符"}` : "");
      }
      if(root){
        const total = tpa(root).direct_reply_count || 0;
        s += `;根貼文回覆數 ${total},實際載入回覆 ${replies.length}`;
        if(!revisit.some(r => r.id === root.id)) revisit.push({ id: root.id, kw: item.kw, url: pageOf(root), at: Date.now(), before: counts(root) });
      }
      lines.push(s);
      await sleep(between(cfg.keyword_gap_sec));
    }

    lines.push("", "## 3. 隔幾分鐘再看同一則根貼文:數字會變嗎?", "");
    for(const r of revisit.slice(0, 3)){
      const wait = r.at + (cfg.probe_revisit_min ?? 5) * 60000 - Date.now();   // 測試時可縮短
      if(wait > 0) await sleep(wait);
      let again = null;
      sink = p => { if(p.id === r.id) again = p; };
      if(!await visit(r.url, 0)) break;
      const mins = ((Date.now() - r.at) / 60000).toFixed(1);
      if(!again){ lines.push(`- 「${r.kw}」:${mins} 分鐘後再看,沒讀到同一則`); continue; }
      const after = counts(again);
      lines.push(`- 「${r.kw}」:${mins} 分鐘後 ` + Object.keys(after).map(k => `${k} ${r.before[k]}→${after[k]}`).join("、"));
      await sleep(between(cfg.keyword_gap_sec));
    }

    lines.push("", "## 4. 標籤擴散:根貼文帶主題標籤時,用標籤再搜一次", "");
    if(!tagged.length) lines.push("- 這次命中的根貼文都沒有主題標籤");
    for(const t of tagged.slice(0, 3)){
      const found = new Map();
      sink = p => { if(!found.has(p.id)) found.set(p.id, p); };
      if(!await visit(MODES.標籤(t.tag))) break;
      const all = [...found.values()];
      const same = all.filter(p => tpa(p).tag_header?.display_name === t.tag);
      lines.push(`- 「${t.kw}」命中的一則根貼文的標籤:網址 ${params()},讀到 ${all.length} 則、` +
        `其中帶同一個標籤 ${same.length} 則、不重複帳號 ${new Set(same.map(p => p.username)).size}、` +
        `距今中位數 ${median(same.map(ageHours).filter(v => v !== null).map(v => Math.round(v)))} 小時`);
      await sleep(between(cfg.keyword_gap_sec));
    }
  } finally {
    sink = null;
    probing = false;
    changed();
    const file = path.join(app.getPath("desktop"), "Threads事件實測.md");
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
    log(`事件實測完成:${file}`);
    shell.openPath(file);
    if(wasRunning) start();
  }
}

async function probe(){
  if(probing) return;
  probing = true;
  changed();
  const wasRunning = running;
  if(wasRunning) stop();
  loadConfig();
  if(!bot) makeBot();
  const search = {}, thread = {};
  let nSearch = 0, nThread = 0;
  const lines = ["# Threads 網頁資料結構實測", "", `時間:${new Date().toLocaleString()}`, "",
    "只記欄位結構;沒有任何內文、帳號、ID。", ""];
  try{
    log("資料結構實測開始(約 5 分鐘)");
    const candidates = [];
    const kws = Object.values(cfg.keywords);
    for(let i = 0; i < kws.length; i++){
      const found = new Map();
      sink = p => { if(!found.has(p.id)){ found.set(p.id, p); schemaAdd(search, p.raw); nSearch++; } };
      if(!await visit(cfg.search_url.replace("%s", encodeURIComponent(kws[i])))){
        lines.push("**需要登入 Threads,實測中止。請在蒐集視窗登入後重跑。**"); bot.show(); break;
      }
      lines.push(`- 搜尋「${kws[i]}」:讀到 ${found.size} 個串文物件`);
      candidates.push(...[...found.values()].slice(0, 2).map(p => ({ ...p, kw: kws[i] })));
      await sleep(between(cfg.keyword_gap_sec));
    }
    lines.push("", "## 串文頁(根貼文 + 回覆)", "");
    for(const c of candidates){
      const users = new Set();
      let n = 0;
      sink = p => { n++; users.add(p.username); schemaAdd(thread, p.raw); nThread++; };
      const origin = new URL(cfg.search_url).origin;
      if(!await visit(`${origin}/@${encodeURIComponent(c.username)}/post/${encodeURIComponent(c.code)}`)) break;
      lines.push(`- 「${c.kw}」的一則串文頁:${n} 個串文物件(含重複出現)、不重複帳號 ${users.size}`);
      await sleep(between(cfg.keyword_gap_sec));
    }
  } finally {
    sink = null;
    probing = false;
    changed();
  }
  lines.push("", `## 搜尋頁的串文物件欄位(共 ${nSearch} 個)`, "", ...schemaTable(search, nSearch),
             "", `## 串文頁的串文物件欄位(共 ${nThread} 次)`, "", ...schemaTable(thread, nThread), "");
  const file = path.join(app.getPath("desktop"), "Threads資料結構實測.md");
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  log(`資料結構實測完成:${file}`);
  shell.openPath(file);
  if(wasRunning) start();
}

/* ── 精準度評估取樣 ──
   從「熱門」「最新」各抽一半,共 eval_target 則候選,找出各自的事件、讀事件的數字,寫成兩個檔:
     標記.csv  — 編號、命中貼文與事件根貼文的原文、空白的「你的標記」欄(只在本機暫存資料夾,評估完由 evaluate.py 刪除)
     指標.csv  — 編號與事件的數字(沒有文字)
   兩個檔分開,標記時看不到指標,不會被數字影響判斷。 */
const csvCell = v => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (file, rows) => fs.writeFileSync(file, "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n", "utf8");

async function evalSample(){
  if(probing) return;
  probing = true;
  changed();
  const wasRunning = running;
  if(wasRunning) stop();
  loadConfig();
  if(!bot) makeBot();
  const dir = path.join(app.getPath("temp"), "蜂窩性組織言_評估");
  fs.mkdirSync(dir, { recursive: true });
  const gap = () => sleep(between(cfg.eval_gap_sec));
  const kws = Object.values(cfg.keywords);
  const per = Math.ceil(cfg.eval_target / (kws.length * 2));
  let cands = [];
  const taken = new Set(), events = new Map();
  try{
    log(`精準度評估取樣開始:目標 ${cfg.eval_target} 則(約 1 小時)`);
    collect: for(const kw of kws){
      for(const mode of ["熱門", "最新"]){
        const posts = await readPage(searchUrl(mode, kw), cfg.scrolls + 2);
        if(!posts){ loginNeeded(); break collect; }
        const hits = posts.filter(p => O.isHit(p, kw) && !O.isGone(p) && !taken.has(p.id)).slice(0, per);
        hits.forEach(h => { taken.add(h.id); cands.push({ h, kw, mode }); });
        log(`評估取樣:「${kw}」${mode} 取 ${hits.length} 則`);
        await gap();
      }
    }
    cands = cands.slice(0, cfg.eval_target);
    for(let i = 0; i < cands.length && ok; i++){
      const c = cands[i];
      let ev = c.h, fallback = null;
      if(O.tpa(c.h).is_reply){
        const posts = await readPage(pageOf(c.h), 0);
        if(!posts){ loginNeeded(); break; }
        const r = O.resolveEvent(posts, cfg.root_fallback);
        ev = r.event; fallback = r.fallback;
        await gap();
      }
      if(ev && !events.has(ev.id)){
        const posts = await readPage(pageOf(ev), cfg.thread_scrolls) || [];
        events.set(ev.id, { no: events.size + 1, ev: posts.find(p => p.id === ev.id) || ev, sample: O.sampleOf(posts, ev.id) });
        await gap();
      }
      c.event = ev ? events.get(ev.id) : null;
      c.fallback = fallback;
      if((i + 1) % 10 === 0) log(`評估取樣:已處理 ${i + 1} / ${cands.length}`);
    }
    const now = Date.now() / 1000;
    writeCsv(path.join(dir, "標記.csv"), [
      ["編號", "來源", "關鍵字", "命中類型", "命中貼文", "事件根貼文(與命中貼文不同時)", "你的標記(是/否)"],
      ...cands.map((c, i) => [i + 1, c.mode, c.kw, O.tpa(c.h).is_reply ? "回覆" : "根貼文", c.h.text,
                              c.event && c.event.ev.id !== c.h.id ? c.event.ev.text : "", ""]),
    ]);
    writeCsv(path.join(dir, "指標.csv"), [
      ["編號", "來源", "關鍵字", "命中類型", "事件序號", "替代根貼文", "回覆數", "讚數", "引用數", "轉發數",
       "事件距今小時", "樣本回覆", "樣本帳號", "深層比例"],
      ...cands.map((c, i) => {
        const e = c.event, t = e ? O.tpa(e.ev) : {};
        return [i + 1, c.mode, c.kw, O.tpa(c.h).is_reply ? "回覆" : "根貼文", e ? e.no : "", c.fallback || "",
                e ? t.direct_reply_count ?? "" : "", e ? e.ev.raw?.like_count ?? "" : "", e ? t.quote_count ?? "" : "",
                e ? t.repost_count ?? "" : "", e && e.ev.taken_at ? ((now - e.ev.taken_at) / 3600).toFixed(1) : "",
                e ? e.sample.n : "", e ? e.sample.participants : "", e ? e.sample.deep_share.toFixed(2) : ""];
      }),
    ]);
    log(`精準度評估取樣完成:${cands.length} 則、${events.size} 個事件 → ${dir}`);
  } finally {
    sink = null;
    probing = false;
    changed();
    shell.openPath(dir);
    if(wasRunning) start();
  }
}

module.exports = {
  probe, probeEvents, evalSample,
  isProbing: () => probing,
  init(){
    loadConfig();
    app.on("before-quit", () => { quitting = true; });
    if(cfg.enabled) start();
  },
  start, stop,
  isRunning: () => running,
  toggleWindow(){ if(!bot) makeBot(); bot.isVisible() ? bot.hide() : bot.show(); },
  openConfig(){ loadConfig(); shell.openPath(configPath()); },
  onChange: f => listeners.add(f),
  _findPosts: O.findPosts,   // 測試用
  _schemaAdd: schemaAdd, _schemaTable: schemaTable,
};
