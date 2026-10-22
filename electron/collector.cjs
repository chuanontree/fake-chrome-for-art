/* ═══════════════════════════════════════════════════════════
   Threads 關鍵字蒐集器(電腦版)
   用一個看不見的視窗,以你在偽 Chrome 裡登入的帳號,定期打開 Threads 搜尋頁,
   讀取頁面載入的串文資料,送給 td-threads/bridge/threads_bridge.py --browser,
   再由它算熱度、匿名化、存 CSV、送 OSC 進 TouchDesigner。

   · 預設關閉,由「Threads 蒐集」選單開啟。
   · 以人的節奏瀏覽:每輪間隔、關鍵字之間、捲動之間都有隨機停頓。
   · 不碰帳號建立、登入或驗證;需要登入時會把視窗叫出來讓你自己登入。
   · 讀的是頁面帶的資料(JSON),不是畫面樣式,Threads 改版面時比較不會壞。
   ═══════════════════════════════════════════════════════════ */
const { app, BrowserWindow, shell } = require("electron");
const dgram = require("dgram");
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  enabled: false,                              // true = 開程式就開始蒐集
  keywords: { flame: "炎上", trial: "公審", boycott: "抵制" },   // 要跟 bridge 的 config.json 一致
  interval_min: 15,                            // 每輪間隔(分鐘,實際會 ±15% 隨機)
  keyword_gap_sec: [20, 45],                   // 同一輪內關鍵字之間停多久
  scrolls: 3,                                  // 每個搜尋頁往下捲幾次
  scroll_gap_sec: [2, 5],
  require_keyword_in_text: true,               // 只收內文真的含關鍵字的串文
  search_url: "https://www.threads.com/search?q=%s&serp_type=default&filter=recent",
  bridge_host: "127.0.0.1",
  bridge_port: 7010,
};

const configPath = () => process.env.CHUANONTREE_COLLECTOR_CONFIG
  || path.join(app.getPath("userData"), "collector.json");

let cfg, bot, timer = null, running = false, quitting = false;
let current = null;                            // 正在搜尋的 { slug, kw }
let ok = true, nextAt = 0, statusTimer = null;
const seen = new Set();
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
const send = obj => udp.send(Buffer.from(JSON.stringify(obj)), cfg.bridge_port, cfg.bridge_host);
/* 同時印出並送給橋接程式,讓黑色視窗看得到蒐集器在做什麼 */
const log = (...a) => {
  console.log(new Date().toTimeString().slice(0, 8), "[蒐集]", ...a);
  if(cfg) send({ type: "log", msg: a.join(" ") });
};
const changed = () => listeners.forEach(f => f());

/* ── 從任何 JSON 裡找出「串文」:有 code、caption.text、user.username 的物件 ── */
function findPosts(root, out = []){
  const stack = [root];
  while(stack.length){
    const o = stack.pop();
    if(!o || typeof o !== "object") continue;
    if(typeof o.code === "string" && typeof o.caption?.text === "string" && typeof o.user?.username === "string"){
      out.push({
        id: String(o.pk || o.id || o.code),
        code: o.code,
        text: o.caption.text,
        username: o.user.username,
        taken_at: o.taken_at,
        raw: o,
      });
    }
    for(const k in o) if(o[k] && typeof o[k] === "object") stack.push(o[k]);
  }
  return out;
}

function parseJsonish(text){
  const s = text.replace(/^\s*for\s*\(;;\);/, "");
  try{ return [JSON.parse(s)]; }catch(e){}
  return s.split("\n").map(l => { try{ return JSON.parse(l); }catch(e){ return null; } }).filter(Boolean);
}

let probeSink = null;   // 資料結構實測進行中時,資料改送到這裡,不送給橋接程式
let probing = false;

function harvest(text){
  if(probeSink){ if(text && text.length >= 20) parseJsonish(text).forEach(j => findPosts(j).forEach(probeSink)); return; }
  if(!current || !text || text.length < 20) return;
  const { slug, kw } = current;
  for(const json of parseJsonish(text)){
    for(const p of findPosts(json)){
      if(seen.has(p.id)) continue;
      if(cfg.require_keyword_in_text && !p.text.includes(kw)) continue;
      seen.add(p.id);
      if(seen.size > 20000) seen.delete(seen.values().next().value);
      send({
        type: "post", slug, keyword: kw, id: p.id, text: p.text, username: p.username,
        timestamp: p.taken_at ? new Date(p.taken_at * 1000).toISOString() : "",
        permalink: `https://www.threads.com/@${p.username}/post/${p.code}`,
      });
      current.n++;
    }
  }
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

async function round(){
  timer = null;
  if(!running) return;
  ok = true;
  /* 每輪都重送全部:橋接程式會去重。這樣橋接程式晚開、重開,都不會漏掉資料 */
  seen.clear();
  const list = Object.entries(cfg.keywords);
  for(let i = 0; i < list.length && running; i++){
    const [slug, kw] = list[i];
    current = { slug, kw, n: 0 };
    try{ await bot.loadURL(cfg.search_url.replace("%s", encodeURIComponent(kw))); }
    catch(e){ if(!String(e).includes("ERR_ABORTED")){ ok = false; log("載入失敗:", e.message); } }
    await sleep(between([3, 6]));
    if(needsLogin()){
      ok = false;
      log("需要登入 Threads:已打開蒐集視窗,請在裡面登入,下一輪會自動繼續");
      bot.show();
      break;
    }
    await harvestEmbedded();
    for(let s = 0; s < cfg.scrolls && running; s++){
      try{ await bot.webContents.executeJavaScript("window.scrollBy(0, innerHeight * 1.5)"); }catch(e){}
      await sleep(between(cfg.scroll_gap_sec));
      await harvestEmbedded();
    }
    log(`搜尋「${kw}」:讀到 ${current.n} 則含關鍵字的串文`);
    current = null;
    if(i < list.length - 1) await sleep(between(cfg.keyword_gap_sec));
  }
  current = null;
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
  current = null;
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
        probeSink = p => { if(!found.has(p.id)) found.set(p.id, p); };
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
      probeSink = p => { if(!objs.has(p.id)) objs.set(p.id, p); };
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
      probeSink = p => { if(p.id === r.id) again = p; };
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
      probeSink = p => { if(!found.has(p.id)) found.set(p.id, p); };
      if(!await visit(MODES.標籤(t.tag))) break;
      const all = [...found.values()];
      const same = all.filter(p => tpa(p).tag_header?.display_name === t.tag);
      lines.push(`- 「${t.kw}」命中的一則根貼文的標籤:網址 ${params()},讀到 ${all.length} 則、` +
        `其中帶同一個標籤 ${same.length} 則、不重複帳號 ${new Set(same.map(p => p.username)).size}、` +
        `距今中位數 ${median(same.map(ageHours).filter(v => v !== null).map(v => Math.round(v)))} 小時`);
      await sleep(between(cfg.keyword_gap_sec));
    }
  } finally {
    probeSink = null;
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
      probeSink = p => { if(!found.has(p.id)){ found.set(p.id, p); schemaAdd(search, p.raw); nSearch++; } };
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
      probeSink = p => { n++; users.add(p.username); schemaAdd(thread, p.raw); nThread++; };
      const origin = new URL(cfg.search_url).origin;
      if(!await visit(`${origin}/@${encodeURIComponent(c.username)}/post/${encodeURIComponent(c.code)}`)) break;
      lines.push(`- 「${c.kw}」的一則串文頁:${n} 個串文物件(含重複出現)、不重複帳號 ${users.size}`);
      await sleep(between(cfg.keyword_gap_sec));
    }
  } finally {
    probeSink = null;
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

module.exports = {
  probe, probeEvents,
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
  _findPosts: findPosts,   // 測試用
  _schemaAdd: schemaAdd, _schemaTable: schemaTable,
};
