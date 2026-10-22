/* node electron/observe.test.cjs */
const assert = require("assert");
const o = require("./observe.cjs");

const post = (pk, { reply = false, level, gone = false, user = "u" + pk, text = "x", replies = 0, t = 1000 } = {}) => ({
  pk, code: "C" + pk, taken_at: t, caption: gone ? undefined : { text }, user: gone ? undefined : { username: user },
  like_count: 5, text_post_app_info: { is_reply: reply, reply_level: level, direct_reply_count: replies,
    quote_count: 1, repost_count: 2, ...(gone ? { is_post_unavailable: true } : {}) },
});
const find = arr => o.findPosts({ data: arr });

// 一般串:根貼文就是事件
let ps = find([post(1, { replies: 40 }), post(2, { reply: true, level: 1 }), post(3, { reply: true, level: 2, user: "other" })]);
assert.strictEqual(o.resolveEvent(ps).event.id, "1");
assert.strictEqual(o.resolveEvent(ps).fallback, null);
assert.deepStrictEqual(o.sampleOf(ps, "1"), { n: 2, participants: 2, deep_share: 0.5 });

// 根貼文被刪除:退到最上層看得到的那則
ps = find([post(1, { gone: true }), post(5, { reply: true, level: 2, t: 900 }), post(4, { reply: true, level: 1, t: 950 })]);
assert.ok(ps.some(o.isGone), "刪除的空殼要被找到");
let r = o.resolveEvent(ps);
assert.strictEqual(r.event.id, "4");
assert.strictEqual(r.fallback, "deleted");

// 根貼文只是沒載入:預設略過,"always" 才退
ps = find([post(4, { reply: true, level: 1 }), post(5, { reply: true, level: 2 })]);
assert.strictEqual(o.resolveEvent(ps).event, null);
assert.strictEqual(o.resolveEvent(ps, "always").fallback, "missing");

// 命中:內文或標籤
const tagged = find([{ ...post(9, { text: "沒有那個詞" }), text_post_app_info: { tag_header: { display_name: "炎上討論" } } }])[0];
assert.ok(o.isHit(tagged, "炎上"));
assert.ok(!o.isHit(find([post(8, { text: "平靜" })])[0], "炎上"));

// 觀察值只有數字,沒有文字與帳號
const ob = o.obsOf(find([post(7, { text: "秘密內文", user: "someone", replies: 12 })])[0], { kw: "炎上" });
assert.strictEqual(ob.replies, 12);
assert.ok(!JSON.stringify(ob).includes("秘密") && !JSON.stringify(ob).includes("someone"));

// for (;;); 前綴與多行 JSON
assert.strictEqual(o.parseJsonish('for (;;);{"a":1}')[0].a, 1);
assert.strictEqual(o.parseJsonish('{"a":1}\n{"b":2}').length, 2);

console.log("observe: all tests passed");
