/* ═══════════════════════════════════════════════════════════
   觀察:從 Threads 網頁載入的資料裡,找出串文、判斷事件(根貼文)、算回覆樣本。
   純函式,不碰視窗,可以單獨測試(electron/observe.test.cjs)。
   ═══════════════════════════════════════════════════════════ */

const tpa = p => p.raw?.text_post_app_info || {};

/* 已被刪除 / 無法顯示的貼文 */
const isGone = p => !!(tpa(p).is_post_unavailable || tpa(p).post_tombstone_info || tpa(p).post_unavailable_reason);

/* 從任何 JSON 裡找出串文物件:有 code、內文、帳號;或是已刪除貼文留下的空殼 */
function findPosts(root, out = []){
  const stack = [root];
  while(stack.length){
    const o = stack.pop();
    if(!o || typeof o !== "object") continue;
    const t = o.text_post_app_info || {};
    const normal = typeof o.code === "string" && typeof o.caption?.text === "string" && typeof o.user?.username === "string";
    const tomb = typeof o.code === "string" && !!(t.is_post_unavailable || t.post_tombstone_info || t.post_unavailable_reason);
    if(normal || tomb){
      out.push({
        id: String(o.pk || o.id || o.code),
        code: o.code,
        text: o.caption?.text || "",
        username: o.user?.username || "",
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

/* 命中:內文或主題標籤含關鍵字 */
const isHit = (p, kw) => p.text.includes(kw) || (tpa(p).tag_header?.display_name || "").includes(kw);

/* 在一個串文頁裡決定「事件」是哪一則:
   - 有根貼文(不是回覆、沒被刪) → 根貼文
   - 根貼文被刪除(頁面上有已刪除的貼文)→ 回覆鏈最上層看得到的那則(fallback: "deleted")
   - 根貼文只是沒載入、看不出被刪除 → policy 為 "always" 時同樣退到最上層(fallback: "missing"),
     預設 "deleted_only" 則略過(event: null) */
function resolveEvent(posts, policy = "deleted_only"){
  const root = posts.find(p => !tpa(p).is_reply && !isGone(p));
  if(root) return { event: root, fallback: null };
  const deleted = posts.some(isGone);
  if(!deleted && policy !== "always") return { event: null, reason: "根貼文未載入" };
  const visible = posts.filter(p => !isGone(p));
  if(!visible.length) return { event: null, reason: "沒有看得到的貼文" };
  visible.sort((a, b) => (tpa(a).reply_level ?? 99) - (tpa(b).reply_level ?? 99) || (a.taken_at || 0) - (b.taken_at || 0));
  return { event: visible[0], fallback: deleted ? "deleted" : "missing" };
}

/* 事件頁上載入的回覆樣本:幾則、幾個不重複帳號、第 2 層以後占多少 */
function sampleOf(posts, eventId){
  const replies = posts.filter(p => p.id !== eventId && tpa(p).is_reply && !isGone(p));
  const n = replies.length;
  if(!n) return { n: 0, participants: 0, deep_share: 0 };
  return {
    n,
    participants: new Set(replies.map(p => p.username)).size,
    deep_share: replies.filter(p => (tpa(p).reply_level ?? 1) >= 2).length / n,
  };
}

/* 送給橋接程式的觀察值:只有數字。id 是原始 ID,橋接程式一收到就雜湊 */
function obsOf(p, extra = {}){
  return {
    type: "obs",
    id: p.id,
    replies: tpa(p).direct_reply_count ?? null,
    likes: p.raw?.like_count ?? null,
    quotes: tpa(p).quote_count ?? null,
    reposts: tpa(p).repost_count ?? null,
    taken_at: p.taken_at || null,
    ...extra,
  };
}

module.exports = { tpa, isGone, findPosts, parseJsonish, isHit, resolveEvent, sampleOf, obsOf };
