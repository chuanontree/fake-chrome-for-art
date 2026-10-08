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
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), "[蒐集]", ...a);
const send = obj => udp.send(Buffer.from(JSON.stringify(obj)), cfg.bridge_port, cfg.bridge_host);
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

function harvest(text){
  if(!current || !text || text.length < 20) return;
  const { slug, kw } = current;
  let n = 0;
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
      n++;
    }
  }
  if(n) log(`「${kw}」新串文 ${n} 則`);
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
  const list = Object.entries(cfg.keywords);
  for(let i = 0; i < list.length && running; i++){
    const [slug, kw] = list[i];
    current = { slug, kw };
    log(`搜尋「${kw}」`);
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
  statusTimer = setInterval(() => send({ type: "status", ok, next: Math.max(0, (nextAt - Date.now()) / 1000) }), 1000);
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

module.exports = {
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
};
