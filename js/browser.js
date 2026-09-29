/* ═══════════════════════════════════════════════════════════
   引擎 — 分頁、導覽、歷史。一般情況你不用動這裡。
   策展改 config.js;外觀改 css/style.css;頁面內容改 index.html。

   同一份引擎跑兩種版本:
   · 網頁版(GitHub Pages):內容用 <iframe>,被網站拒絕時跳 #rupture。
   · 電腦版(Electron,見 electron/):內容用 <webview>,任何網站都能真的進入,
     不拒絕;真的連不上時顯示擬態 Chrome 的 #neterror。
   ═══════════════════════════════════════════════════════════ */
import { REFUSE_LIST, SHORTCUTS, SEARCH } from "./config.js";

const NEWTAB = "chrome://newtab";
const APP = window.chuanontree || null;   // 電腦版由 electron/preload.cjs 注入
let tabs = [], active = -1, seq = 0;

const view     = document.getElementById("view");
const strip    = document.getElementById("strip");
const urlInput = document.getElementById("url");

/* ── 工具 ── */
function normalize(raw){
  const s = raw.trim();
  if(!s) return NEWTAB;
  const hasScheme = /^[a-z]+:\/\//i.test(s);
  const looksUrl  = hasScheme || /^[\w-]+(\.[\w-]+)+(\/|$|:)/.test(s);
  if(looksUrl) return hasScheme ? s : "https://" + s;
  return SEARCH.replace("%s", encodeURIComponent(s));
}
function refused(u){
  if(APP) return false;   // 電腦版:不拒絕任何網站
  const bare = u.replace(/^https?:\/\//, "");
  return REFUSE_LIST.some(d => bare.startsWith(d) || u.includes("//"+d) || u.includes("."+d));
}
function hostOf(u){ try{ return new URL(u).hostname.replace(/^www\./,""); }catch(e){ return u; } }
/* webview 還沒掛好前呼叫它的方法會丟錯,一律當作「不行」 */
function wv(t, fn){ try{ return t.frame ? fn(t.frame) : false; }catch(e){ return false; } }

/* ── 分頁 ── */
function newTab(u = NEWTAB){
  const id = ++seq;
  const t = { id, frame:null, hist:[], hi:-1, cur:NEWTAB, home:true, error:null, title:"新分頁", fav:"" };
  if(!APP){ t.frame = document.createElement("iframe"); view.appendChild(t.frame); }
  tabs.push(t);
  select(id);
  go(u, true);
}
function cur(){ return tabs.find(t => t.id === active); }
function select(id){ active = id; update(); }
function go(u, push){
  const t = cur(); if(!t) return;
  const dest = normalize(u);
  t.error = null;
  if(dest === NEWTAB){
    t.home = true; t.title = "新分頁"; t.fav = "";
    if(!APP) t.cur = dest;
  } else {
    t.home = false; t.cur = dest; t.title = hostOf(dest); t.fav = "";
    if(!APP){ if(!refused(dest)) t.frame.src = dest; }
    else if(!t.frame)   attachView(t, dest);
    else if(t.ready)    t.frame.loadURL(dest).catch(() => {});   // 失敗交給 did-fail-load
    else                t.frame.src = dest;
  }
  if(!APP && push){ t.hist = t.hist.slice(0, t.hi+1); t.hist.push(dest); t.hi++; }
  update();
}
function back(){
  const t = cur(); if(!t) return;
  if(!APP){ if(t.hi>0){ t.hi--; go(t.hist[t.hi], false); } return; }
  if(t.home) return;
  if(wv(t, w => w.canGoBack())) t.frame.goBack();
  else { t.home = true; t.error = null; update(); }   // 第一頁再往回 = 起始頁
}
function fwd(){
  const t = cur(); if(!t) return;
  if(!APP){ if(t.hi<t.hist.length-1){ t.hi++; go(t.hist[t.hi], false); } return; }
  if(t.home){ if(t.frame){ t.home = false; update(); } return; }
  if(wv(t, w => w.canGoForward())) t.frame.goForward();
}
function reload(){
  const t = cur(); if(!t || t.home) return;
  if(!APP || t.error || !t.ready) go(t.cur, false);
  else t.frame.reload();
}
function canBack(t){ return APP ? !t.home : t.hi>0; }
function canFwd(t){ return APP ? (t.home ? !!t.frame : wv(t, w => w.canGoForward())) : t.hi<t.hist.length-1; }
function closeTab(id){
  const i = tabs.findIndex(t => t.id===id); if(i<0) return;
  tabs[i].frame?.remove(); tabs.splice(i,1);
  if(!tabs.length){ newTab(); return; }
  if(active===id) select(tabs[Math.max(0,i-1)].id); else render();
}

/* ── 電腦版:真的瀏覽器分頁 ── */
function attachView(t, src){
  const w = document.createElement("webview");
  w.setAttribute("allowpopups", "");   // 新視窗由 electron/main.cjs 轉成新分頁
  w.src = src;
  w.addEventListener("dom-ready", () => { if(!t.ready){ t.ready = true; update(); } });
  w.addEventListener("did-start-navigation", e => { if(e.isMainFrame && !e.isInPlace) t.error = null; });
  w.addEventListener("did-navigate", e => {
    t.cur = e.url; t.home = false; t.title = hostOf(e.url); t.fav = ""; update();
  });
  w.addEventListener("did-navigate-in-page", e => { if(e.isMainFrame){ t.cur = e.url; update(); } });
  w.addEventListener("page-title-updated", e => { t.title = e.title; update(); });
  w.addEventListener("page-favicon-updated", e => { t.fav = e.favicons[0] || ""; update(); });
  w.addEventListener("did-fail-load", e => {
    if(!e.isMainFrame || e.errorCode === -3) return;   // -3 = 被新的導覽取代,不是錯誤
    t.error = e.errorDescription || "ERR_FAILED";
    t.cur = e.validatedURL || t.cur; t.title = hostOf(t.cur);
    update();
  });
  t.frame = w;
  view.appendChild(w);
}

/* ── 畫面 ── */
function update(){ paint(); render(); }

/* 依作用中分頁決定露出什麼:起始頁 / 拒絕頁 / 連線錯誤頁 / 網站本身 */
function paint(){
  const t = cur();
  document.querySelectorAll(".page").forEach(p => p.classList.remove("show"));
  tabs.forEach(x => { if(x.frame) x.frame.style.visibility = "hidden"; });
  if(!t) return;
  if(t.home){
    document.getElementById("startpage").classList.add("show");
  } else if(t.error){
    showNetError(t);
  } else if(refused(t.cur)){
    document.getElementById("rhost").textContent = hostOf(t.cur);
    document.getElementById("rupture").classList.add("show");
  } else if(t.frame){
    t.frame.style.visibility = "visible";
  }
}
/* 連線錯誤訊息,<b></b> 會填入網域 */
const NETERR = {
  ERR_NAME_NOT_RESOLVED:     "找不到 <b></b> 的伺服器 IP 位址。",
  ERR_CONNECTION_REFUSED:    "<b></b> 拒絕連線。",
  ERR_CONNECTION_TIMED_OUT:  "<b></b> 的回應時間過長。",
  ERR_INTERNET_DISCONNECTED: "沒有網際網路連線。",
};
function showNetError(t){
  const host = hostOf(t.cur);
  const msg  = document.getElementById("nmsg");
  msg.innerHTML = NETERR[t.error] || "目前無法連上 <b></b>。";
  msg.querySelector("b")?.replaceChildren(host);
  document.getElementById("ncode").textContent = t.error;
  document.getElementById("neterror").classList.add("show");
}
function render(){
  strip.innerHTML = "";
  tabs.forEach(t => {
    const el = document.createElement("div");
    el.className = "tab" + (t.id===active ? " on" : "");
    el.innerHTML = `<span class="fav"></span><span class="ttl"></span><span class="x">×</span>`;
    el.querySelector(".ttl").textContent = t.title;
    if(t.fav && !t.home){
      const f = el.querySelector(".fav");
      f.classList.add("img"); f.style.backgroundImage = `url(${JSON.stringify(t.fav)})`;
    }
    el.onclick = e => e.target.classList.contains("x") ? closeTab(t.id) : select(t.id);
    strip.appendChild(el);
  });
  const plus = document.createElement("div");
  plus.className = "newtab"; plus.textContent = "+"; plus.onclick = () => newTab();
  strip.appendChild(plus);

  const t = cur();
  if(document.activeElement !== urlInput) urlInput.value = (t && !t.home) ? t.cur : "";
  document.getElementById("back").disabled = !(t && canBack(t));
  document.getElementById("fwd").disabled  = !(t && canFwd(t));
}

/* ── 起始頁捷徑(由 config.js 產生)── */
function buildShortcuts(){
  const wrap = document.getElementById("shorts");
  wrap.innerHTML = SHORTCUTS.map(s =>
    `<div class="short" data-go="${s.go}"><div class="ic">${s.glyph}</div>${s.label}</div>`
  ).join("");
  wrap.querySelectorAll(".short").forEach(s => s.onclick = () => go(s.dataset.go, true));
}

/* ── 事件 ── */
function submit(input){ const v = input.value; input.blur(); go(v, true); }
urlInput.addEventListener("keydown", e => { if(e.key==="Enter") submit(urlInput); });
urlInput.addEventListener("focus", () => urlInput.select());
/* 沒按 Enter 就離開網址列 → 還原成目前網址;iPad 收鍵盤後把被推走的殼捲回來 */
urlInput.addEventListener("blur", () => { render(); window.scrollTo(0, 0); });
const sbox = document.getElementById("sbox");
sbox.addEventListener("keydown", e => { if(e.key==="Enter"){ submit(sbox); sbox.value = ""; } });
sbox.addEventListener("blur", () => window.scrollTo(0, 0));
document.getElementById("back").onclick   = back;
document.getElementById("fwd").onclick     = fwd;
document.getElementById("reload").onclick  = reload;
document.getElementById("nreload").onclick = reload;

/* 電腦版:選單快捷鍵與網站開的新視窗 */
if(APP){
  document.body.classList.add("app", APP.platform === "darwin" ? "mac" : "other");
  const focusUrl = () => { urlInput.focus(); urlInput.select(); };
  const cmds = {
    "new-tab":   () => { newTab(); focusUrl(); },
    "close-tab": () => closeTab(active),
    "focus-url": focusUrl,
    "open-tab":  url => newTab(url),
    reload, back, fwd,
  };
  APP.onCommand((cmd, arg) => cmds[cmd]?.(arg));
}

/* ── 開場 ── */
buildShortcuts();
newTab();
