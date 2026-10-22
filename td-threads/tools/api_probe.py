"""
Threads 官方 API 實測工具

用你自己的 access token 實際呼叫官方 API,回報「現在這個 App、這個權限」實際拿得到什麼。
只用 Python 標準函式庫。

    py api_probe.py                 用 bridge/config.json 的 access_token
    set THREADS_ACCESS_TOKEN=...    也可以用環境變數(優先)

輸出 probe_report.md(同一個資料夾)。報告裡**沒有任何貼文文字**:
內文只記長度、帳號只記雜湊、貼文 ID 只記雜湊。token 會從所有錯誤訊息裡抹掉。

測什麼:
  1. token 是否有效、對應哪個帳號(/me)
  2. keyword_search 接受哪些欄位(逐一剔除不被接受的欄位)
  3. 搜尋結果是否包含「別人」的貼文(= App 是否已通過 threads_keyword_search 進階審查)
  4. 別人貼文的 /replies、/conversation、/insights 能不能讀,讀得到幾層、幾個不重複帳號
  5. 回應標頭裡的用量資訊(限流)

搜尋呼叫次數預設最多 12 次(搜尋額度很少,別浪費),可用 --max-search 調整。
"""
import argparse, hashlib, json, os, re, sys, time
import urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("THREADS_API_BASE", "https://graph.threads.net/v1.0")   # 測試時可改
KEYWORDS = ["炎上", "公審", "抵制"]

# 想知道「有沒有」的欄位;不被接受的會自動剔除並記下來
CANDIDATE_FIELDS = [
    "id", "text", "timestamp", "username", "permalink", "media_type", "media_product_type", "shortcode",
    "is_quote_post", "has_replies", "is_reply", "root_post", "replied_to", "quoted_post", "reposted_post",
    "topic_tag", "owner", "hide_status", "reply_audience", "children",
    "like_count", "reply_count", "repost_count", "quote_count", "views",
]
REPLY_FIELDS = "id,timestamp,username,has_replies,is_reply,root_post,replied_to,is_quote_post"
INSIGHT_METRICS = "views,likes,replies,reposts,quotes"
USAGE_HEADERS = ("x-app-usage", "x-business-use-case-usage", "x-ad-account-usage", "x-fb-debug")

TOKEN = ""
search_calls = 0
usage_seen = {}


def h(s):
    return hashlib.sha1(str(s).encode()).hexdigest()[:8]


def scrub(s):
    return str(s).replace(TOKEN, "<TOKEN>") if TOKEN else str(s)


def call(path, params, search=False):
    """回傳 (status, json 或 None, error 字串)。"""
    global search_calls
    if search:
        search_calls += 1
    q = dict(params, access_token=TOKEN)
    url = f"{BASE}/{path}?{urllib.parse.urlencode(q)}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            for k in USAGE_HEADERS:
                if r.headers.get(k) and k != "x-fb-debug":
                    usage_seen[k] = r.headers.get(k)
            return r.status, json.load(r), ""
    except urllib.error.HTTPError as e:
        try:
            err = json.load(e).get("error", {})
        except Exception:
            err = {}
        return e.code, None, scrub(f"code {err.get('code')} / sub {err.get('error_subcode')}: {err.get('message')}")
    except Exception as e:
        return 0, None, scrub(f"連線失敗:{e}")


def describe_value(v):
    """只描述型別與形狀,不留內容。"""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return f"bool={v}"
    if isinstance(v, (int, float)):
        return f"number={v}"
    if isinstance(v, str):
        return f"string(len {len(v)})"
    if isinstance(v, dict):
        return "object{" + ",".join(sorted(v.keys())) + "}"
    if isinstance(v, list):
        return f"list(len {len(v)})"
    return type(v).__name__


def bad_field(err, fields):
    m = re.search(r"nonexist\w*\s+field\s+\(?([a-z_]+)\)?", err, re.I) or \
        re.search(r"field[s]?\s*\(?([a-z_]+)\)?\s*(?:is|are)?\s*(?:not|invalid)", err, re.I)
    return m.group(1) if m and m.group(1) in fields else None


def discover_fields(keyword, search_type, out):
    """先用最少欄位搜一次拿到貼文 ID,再對「單則貼文」逐一剔除不存在的欄位(不耗搜尋額度)。
    單則貼文讀不到時,才退回用搜尋本身剔除(會耗額度,受 --max-search 限制)。"""
    fields = list(CANDIDATE_FIELDS)
    rejected = []
    st, data, err = call("keyword_search", {"q": keyword, "search_type": search_type, "fields": "id"}, search=True)
    if st != 200:
        out.append(f"- 最基本的搜尋(只要 id)就失敗:HTTP {st},{err}")
        return ["id"], rejected, None
    ids = [p["id"] for p in data.get("data", []) if p.get("id")]
    if ids:
        while fields:
            st, _, err = call(urllib.parse.quote(ids[0]), {"fields": ",".join(fields)})
            if st == 200:
                out.append("- 欄位是用「單則貼文」端點試出來的(不耗搜尋額度)")
                return fields, rejected, None
            bad = bad_field(err, fields)
            if not bad:
                out.append(f"- 單則貼文端點讀不到(`{err}`),改用搜尋端點試欄位")
                break
            fields.remove(bad); rejected.append((bad, err))
    while fields and search_calls < ARGS.max_search:
        st, data, err = call("keyword_search", {"q": keyword, "search_type": search_type,
                                                "fields": ",".join(fields), "limit": 25}, search=True)
        if st == 200:
            return fields, rejected, data
        bad = bad_field(err, fields)
        if not bad:
            out.append(f"- 搜尋失敗,且無法從錯誤判斷是哪個欄位:`{err}`")
            return fields, rejected, None
        fields.remove(bad); rejected.append((bad, err))
    return fields, rejected, None


def analyse_posts(posts, me_name):
    n = len(posts)
    others = sum(1 for p in posts if p.get("username") and p.get("username") != me_name)
    keys = {}
    for p in posts:
        for k, v in p.items():
            if not k.startswith("_"):
                keys.setdefault(k, []).append(v)
    rows = []
    for k in sorted(keys):
        vals = keys[k]
        nonnull = sum(1 for v in vals if v not in (None, "", [], {}))
        sample = describe_value(next((v for v in vals if v not in (None, "", [], {})), None))
        rows.append(f"| `{k}` | {nonnull}/{n} | {sample} |")
    return n, others, rows


def thread_shape(items, root_id):
    """由 replied_to 鏈算層數;算不重複帳號數。"""
    parent = {}
    authors = set()
    for it in items:
        if it.get("username"):
            authors.add(h(it["username"]))
        rt = it.get("replied_to")
        if isinstance(rt, dict) and rt.get("id"):
            parent[it["id"]] = rt["id"]
    def depth(i, seen=0):
        d = 1
        while i in parent and parent[i] != root_id and seen < 200:
            i = parent[i]; d += 1; seen += 1
        return d
    max_depth = max((depth(it["id"]) for it in items if it.get("id")), default=0)
    return len(items), len(authors), max_depth, bool(parent)


def main():
    global TOKEN, ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-search", type=int, default=12, help="最多幾次搜尋呼叫")
    ap.add_argument("--threads-per-keyword", type=int, default=3, help="每個關鍵字測幾則貼文的回覆串")
    ARGS = ap.parse_args()

    TOKEN = os.environ.get("THREADS_ACCESS_TOKEN", "").strip()
    if not TOKEN:
        try:
            with open(os.path.join(HERE, "..", "bridge", "config.json"), encoding="utf-8") as f:
                TOKEN = json.load(f).get("access_token", "").strip()
        except FileNotFoundError:
            pass
    if not TOKEN:
        sys.exit("找不到 access token:設定環境變數 THREADS_ACCESS_TOKEN,或填 td-threads/bridge/config.json。")

    out = [f"# Threads API 實測報告", f"", f"時間:{time.strftime('%Y-%m-%d %H:%M:%S')}", ""]

    # 1. token
    st, me, err = call("me", {"fields": "id,username"})
    out.append("## 1. token")
    if st != 200:
        out.append(f"- **token 無效或過期**:HTTP {st},{err}")
        return finish(out)
    me_name = me.get("username", "")
    out.append(f"- 有效。帳號雜湊 `{h(me_name)}`")
    out.append("")

    # 2-3. keyword_search
    out.append("## 2. keyword_search")
    accepted, rejected, first = discover_fields(KEYWORDS[0], "RECENT", out)
    out.append(f"- 被接受的欄位:`{','.join(accepted)}`")
    for f, e in rejected:
        out.append(f"- 不被接受:`{f}` — {e}")
    all_posts = {}
    for kw in KEYWORDS:
        for stype in ("RECENT", "TOP"):
            if kw == KEYWORDS[0] and stype == "RECENT" and first is not None:
                st, data, err = 200, first, ""
            elif search_calls >= ARGS.max_search:
                out.append(f"- 「{kw}」{stype}:略過(已達搜尋次數上限)")
                continue
            else:
                st, data, err = call("keyword_search", {"q": kw, "search_type": stype,
                                                        "fields": ",".join(accepted), "limit": 25}, search=True)
            if st != 200:
                out.append(f"- 「{kw}」{stype}:HTTP {st},{err}")
                continue
            posts = data.get("data", [])
            n, others, _ = analyse_posts(posts, me_name)
            paging = "有" if data.get("paging", {}).get("cursors") or data.get("paging", {}).get("next") else "無"
            out.append(f"- 「{kw}」{stype}:{n} 則,其中別人的 {others} 則,分頁游標:{paging}")
            for p in posts:
                all_posts.setdefault(p["id"], dict(p, _kw=kw))
    posts = list(all_posts.values())
    n, others, rows = analyse_posts(posts, me_name)
    out += ["", f"合計不重複貼文 {n} 則,別人的 {others} 則。",
            "**判斷:" + ("搜得到別人的貼文 → 進階權限已生效" if others else
                       "搜不到別人的貼文 → 很可能尚未通過 threads_keyword_search 進階審查(只搜得到自己的)") + "**",
            "", "| 欄位 | 有值的比例 | 形狀(不含內容) |", "|---|---|---|", *rows, ""]
    multi = {}
    for p in posts:
        multi.setdefault(p["id"], set()).add(p["_kw"])

    # 4. 回覆串、insights
    out.append("## 3. 別人貼文的回覆串與數據")
    tested = 0
    by_kw = {}
    for p in posts:
        if p.get("username") == me_name:
            continue
        by_kw.setdefault(p["_kw"], []).append(p)
    for kw, ps in by_kw.items():
        for p in ps[:ARGS.threads_per_keyword]:
            tested += 1
            pid = p["id"]
            out.append(f"### 貼文 `{h(pid)}`(「{kw}」,has_replies={p.get('has_replies')}, is_quote_post={p.get('is_quote_post')})")
            for edge in ("replies", "conversation"):
                st, data, err = call(f"{urllib.parse.quote(pid)}/{edge}", {"fields": REPLY_FIELDS, "reverse": "false"})
                if st != 200:
                    out.append(f"- `/{edge}`:HTTP {st},{err}")
                    continue
                items = data.get("data", [])
                cnt, authors, depth, has_chain = thread_shape(items, pid)
                more = "有" if data.get("paging", {}).get("next") else "無"
                out.append(f"- `/{edge}`:{cnt} 則、不重複帳號 {authors}、最大層數 {depth}"
                           f"(replied_to {'有' if has_chain else '無'})、下一頁 {more}")
            st, data, err = call(f"{urllib.parse.quote(pid)}/insights", {"metric": INSIGHT_METRICS})
            if st != 200:
                out.append(f"- `/insights`:HTTP {st},{err}")
            else:
                vals = {m.get("name"): (m.get("values") or [{}])[0].get("value", m.get("total_value", {}).get("value"))
                        for m in data.get("data", [])}
                out.append(f"- `/insights`:{vals}")
            out.append("")
    if not tested:
        out.append("- 沒有別人的貼文可測(見上方判斷)。")

    # 自己的貼文當對照
    st, data, err = call("me/threads", {"fields": "id", "limit": 1})
    own = (data or {}).get("data", [])
    out.append("## 4. 對照:自己的貼文")
    if own:
        pid = own[0]["id"]
        for edge in ("replies", "conversation"):
            st, d, err = call(f"{pid}/{edge}", {"fields": REPLY_FIELDS})
            out.append(f"- `/{edge}`:" + (f"{len(d.get('data', []))} 則" if st == 200 else f"HTTP {st},{err}"))
        st, d, err = call(f"{pid}/insights", {"metric": INSIGHT_METRICS})
        out.append("- `/insights`:" + ("可讀" if st == 200 else f"HTTP {st},{err}"))
    else:
        out.append(f"- 帳號沒有貼文或讀不到:{err or '無資料'}")

    out += ["", "## 5. 用量 / 限流", f"- 本次搜尋呼叫 {search_calls} 次"]
    for k, v in usage_seen.items():
        out.append(f"- `{k}`: `{v}`")
    if not usage_seen:
        out.append("- 回應裡沒有用量標頭")
    finish(out)


def finish(out):
    text = "\n".join(out) + "\n"
    path = os.path.join(HERE, "probe_report.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(text)
    print(f"已存成 {path}(裡面沒有貼文文字,可以直接貼給 Claude)")


if __name__ == "__main__":
    main()
