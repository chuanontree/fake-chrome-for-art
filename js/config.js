/* ═══════════════════════════════════════════════════════════
   ★ 策展檔 — 你最常動的就是這裡
   決定「哪些網站會裂開(跳你的頁)」與起始頁捷徑。
   純資料,不含邏輯;改完存檔、重新整理即可。
   ═══════════════════════════════════════════════════════════ */

/* 命中這些網域(含子網域)時,不真的載入,改顯示你的「拒絕頁」#rupture。
   前五個是技術上本來就無法被 iframe 套框的站(送 X-Frame-Options),
   列在這裡讓行為可控——與其默默空白,不如明確裂開。
   要收編某站就把它從這裡刪掉;要讓某站裂開就加進來。 */
export const REFUSE_LIST = [
  "google.com/search",
  "facebook.com",
  "instagram.com",
  "x.com", "twitter.com",
  "youtube.com",
];

/* 起始頁捷徑。go 是點下去前往的網址,label 是文字,glyph 是圓圈裡的字。 */
export const SHORTCUTS = [
  { label: "作品集",     glyph: "c", go: "https://chuanontree.github.io" },
  { label: "維基百科",   glyph: "W", go: "https://zh.wikipedia.org" },
  { label: "Instagram", glyph: "◎", go: "https://www.instagram.com/w___w_c__" },
  { label: "擬態",       glyph: "G", go: "https://www.google.com/search?q=%E6%93%AC%E6%85%8B" },
];

/* 預設搜尋引擎(輸入非網址文字時)。%s 會被替換成關鍵字。 */
export const SEARCH = "https://www.google.com/search?q=%s";
