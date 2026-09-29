/* ═══════════════════════════════════════════════════════════
   引擎 — 分頁、導覽、歷史。一般情況你不用動這裡。
   策展改 config.js;外觀改 css/style.css;頁面內容改 index.html。
   ═══════════════════════════════════════════════════════════ */
import { REFUSE_LIST, SHORTCUTS, SEARCH } from "./config.js";

const NEWTAB = "chrome://newtab";
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
  const bare = u.replace(/^https?:\/\//, "");
  return REFUSE_LIST.some(d => bare.startsWith(d) || u.includes("//"+d) || u.includes("."+d));
}
function hostOf(u){ try{ return new URL(u).hostname.replace(/^www\./,""); }catch(e){ return u; } }

/* ── 分頁 ── */
function newTab(u = NEWTAB){
  const id = ++seq;
  const f = document.createElement("iframe");
  f.dataset.id = id; f.style.display = "none";
  view.appendChild(f);
  tabs.push({ id, frame:f, hist:[], hi:-1, title:"新分頁" });
  select(id);
  go(u, true);
}
function cur(){ return tabs.find(t => t.id === active); }
function select(id){
  active = id;
  tabs.forEach(t => { t.frame.style.display = (t.id===id && t.cur!==NEWTAB && !refused(t.cur||"")) ? "block" : "none"; });
  render();
}
function go(u, push){
  const t = cur(); if(!t) return;
  const dest = normalize(u);
  if(push){ t.hist = t.hist.slice(0, t.hi+1); t.hist.push(dest); t.hi++; }
  t.cur = dest;

  document.querySelectorAll(".page").forEach(p => p.classList.remove("show"));
  if(dest === NEWTAB){
    t.frame.style.display = "none";
    document.getElementById("startpage").classList.add("show");
    t.title = "新分頁";
  } else if(refused(dest)){
    t.frame.style.display = "none";
    document.getElementById("rhost").textContent = hostOf(dest);
    document.getElementById("rupture").classList.add("show");
    t.title = hostOf(dest);
  } else {
    t.frame.src = dest;
    t.frame.style.display = "block";
    t.title = hostOf(dest);
  }
  render();
}
const back   = () => { const t=cur(); if(t&&t.hi>0){ t.hi--; go(t.hist[t.hi],false);} };
const fwd    = () => { const t=cur(); if(t&&t.hi<t.hist.length-1){ t.hi++; go(t.hist[t.hi],false);} };
const reload = () => { const t=cur(); if(t) go(t.cur,false); };
function closeTab(id){
  const i = tabs.findIndex(t => t.id===id); if(i<0) return;
  tabs[i].frame.remove(); tabs.splice(i,1);
  if(!tabs.length){ newTab(); return; }
  if(active===id) select(tabs[Math.max(0,i-1)].id); else render();
}

/* ── 畫面 ── */
function render(){
  strip.innerHTML = "";
  tabs.forEach(t => {
    const el = document.createElement("div");
    el.className = "tab" + (t.id===active ? " on" : "");
    el.innerHTML = `<span class="fav"></span><span class="ttl"></span><span class="x">×</span>`;
    el.querySelector(".ttl").textContent = t.title;
    el.onclick = e => e.target.classList.contains("x") ? closeTab(t.id) : select(t.id);
    strip.appendChild(el);
  });
  const plus = document.createElement("div");
  plus.className = "newtab"; plus.textContent = "+"; plus.onclick = () => newTab();
  strip.appendChild(plus);

  const t = cur();
  urlInput.value = (t && t.cur!==NEWTAB) ? t.cur : "";
  document.getElementById("back").disabled = !(t && t.hi>0);
  document.getElementById("fwd").disabled  = !(t && t.hi<t.hist.length-1);
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
urlInput.addEventListener("keydown", e => { if(e.key==="Enter") go(urlInput.value, true); });
document.getElementById("sbox").addEventListener("keydown", e => { if(e.key==="Enter") go(e.target.value, true); });
document.getElementById("back").onclick   = back;
document.getElementById("fwd").onclick     = fwd;
document.getElementById("reload").onclick  = reload;

/* ── 開場 ── */
buildShortcuts();
newTab();
