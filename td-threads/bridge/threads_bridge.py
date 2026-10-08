"""
Threads → TouchDesigner 橋接

定期用 Threads 官方 API 搜尋關鍵字串文,把新串文與每個關鍵字的「熱度」
用 OSC 即時送進 TouchDesigner。只用 Python 標準函式庫,不需要 pip install。

    py threads_bridge.py            正式模式(需要 config.json 裡的 access token)
    py threads_bridge.py --demo     展示模式:不連網,產生假串文,用來先做 TD 視覺
    py threads_bridge.py --refresh  只更新 access token(延長 60 天)後結束
    py threads_bridge.py --browser  瀏覽器模式:不用 API,接收偽 Chrome 電腦版
                                    「Threads 蒐集」送來的串文(UDP 127.0.0.1:7010)

送進 TD 的 OSC(預設 127.0.0.1):
  數值 → port 7000(OSC In CHOP)
    /kw/<slug>/heat    0~1,每來一則串文就升高,隨時間衰減
    /kw/<slug>/total   啟動後累計收到的串文數
    /kw/<slug>/hour    最近一小時送出的串文數
    /status/ok         1 = 最近一次查詢成功,0 = 出錯
    /status/next       距離下一次查詢的秒數
  串文 → port 7001(OSC In DAT)
    /post  slug, 關鍵字, 作者, 內文, 時間, 連結
"""
import argparse, csv, hashlib, json, math, os, random, socket, struct, sys, time
import urllib.error, urllib.parse, urllib.request
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
STATE_PATH = os.path.join(HERE, "state.json")
FIELDS = "id,text,timestamp,username,permalink,media_type"
RATE_LIMIT_CODES = {4, 17, 32, 613}   # Meta 平台的「呼叫太頻繁」錯誤碼


# ── OSC(手寫編碼,免安裝套件)──────────────────────────────
def _osc_str(s):
    b = s.encode("utf-8") + b"\0"
    return b + b"\0" * (-len(b) % 4)

def osc_packet(address, *args):
    tags, data = ",", b""
    for a in args:
        if isinstance(a, str):
            tags += "s"; data += _osc_str(a)
        else:
            tags += "f"; data += struct.pack(">f", float(a))
    return _osc_str(address) + _osc_str(tags) + data

class Osc:
    def __init__(self, host, num_port, post_port):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.num = (host, num_port)
        self.post = (host, post_port)

    def value(self, address, v):
        self.sock.sendto(osc_packet(address, v), self.num)

    def post_msg(self, *args):
        self.sock.sendto(osc_packet("/post", *args), self.post)


# ── 設定與狀態 ────────────────────────────────────────────
def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default

def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ── Threads API ──────────────────────────────────────────
class ApiError(Exception):
    def __init__(self, msg, rate_limited=False):
        super().__init__(msg)
        self.rate_limited = rate_limited

def api_get(base, path, params):
    url = f"{base}/{path}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            err = json.load(e).get("error", {})
        except Exception:
            err = {}
        code = err.get("code")
        msg = err.get("message") or f"HTTP {e.code}"
        raise ApiError(f"{msg}(code {code})", e.code == 429 or code in RATE_LIMIT_CODES)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ApiError(f"連線失敗:{e}")

def search(cfg, keyword):
    data = api_get(cfg["api_base"], "keyword_search", {
        "q": keyword,
        "search_type": cfg.get("search_type", "RECENT"),
        "fields": FIELDS,
        "access_token": cfg["access_token"],
    })
    return data.get("data", [])

def refresh_token(cfg):
    data = api_get(cfg["api_base"].rsplit("/", 1)[0], "refresh_access_token", {
        "grant_type": "th_refresh_token",
        "access_token": cfg["access_token"],
    })
    cfg["access_token"] = data["access_token"]
    cfg["token_refreshed_at"] = int(time.time())
    save_json(CONFIG_PATH, cfg)
    days = int(data.get("expires_in", 0)) // 86400
    log(f"access token 已更新,{days} 天後到期")


# ── 展示模式:假串文 ──────────────────────────────────────
DEMO_LINES = [
    "又一個{kw}現場,大家拿著截圖排隊發言",
    "這次{kw}的速度比上次還快,不到一小時就擴散",
    "我只是想知道真相,為什麼變成{kw}",
    "{kw}的人其實也只是在演給演算法看",
    "截圖、轉發、標記,{kw}的儀式又開始了",
    "看完整串只覺得{kw}本身才是內容",
]

def demo_posts(keywords):
    slug = random.choice(list(keywords))
    kw = keywords[slug]
    n = random.randint(1000, 9999)
    return slug, {
        "id": f"demo{time.time_ns()}",
        "text": random.choice(DEMO_LINES).format(kw=kw),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S+0000", time.gmtime()),
        "username": f"demo_user_{n}",
        "permalink": "",
    }


# ── 主程式 ────────────────────────────────────────────────
class Bridge:
    def __init__(self, cfg, demo, browser=False):
        self.cfg, self.demo, self.browser = cfg, demo, browser
        if browser:                                      # 收偽 Chrome 蒐集器送來的 JSON
            self.inbox = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.inbox.bind((cfg.get("browser_listen_host", "127.0.0.1"), int(cfg.get("browser_listen_port", 7010))))
            self.inbox.setblocking(False)
            self.linked = False            # 有沒有收到蒐集器的狀態
            self.last_status = 0.0
            self.round_interval = 900.0    # 蒐集器每輪間隔(秒),用來攤平釋放
        self.kws = cfg["keywords"]                       # {slug: 關鍵字}
        self.osc = Osc(cfg["osc_host"], cfg["osc_port_values"], cfg["osc_port_posts"])
        state = load_json(STATE_PATH, {}) if not demo else {}
        self.seen = deque(state.get("seen", []), maxlen=5000)
        self.seen_set = set(self.seen)
        self.heat = {s: 0.0 for s in self.kws}
        self.total = {s: 0 for s in self.kws}
        self.sent = {s: deque() for s in self.kws}      # 送出時間,算最近一小時
        self.queue = deque()                             # 待釋放的新串文
        self.ok = 1.0
        self.next_poll = 0.0
        self.backoff = 1
        self.csv_path = os.path.join(HERE, cfg.get("csv", "threads_log.csv"))

    # 查詢間隔:每輪查 N 個關鍵字,一天不超過 daily_query_budget 次
    def interval(self):
        budget = max(1, int(self.cfg.get("daily_query_budget", 60)))
        return max(60.0, 86400.0 * len(self.kws) / budget) * self.backoff

    def author(self, name):
        if not self.cfg.get("anonymize", True):
            return name or ""
        return "user#" + hashlib.sha1((name or "").encode()).hexdigest()[:6]

    def poll(self):
        fresh = 0
        try:
            for slug, kw in self.kws.items():
                for p in reversed(search(self.cfg, kw)):   # 舊的先排隊
                    if p.get("id") in self.seen_set:
                        continue
                    self.seen.append(p["id"]); self.seen_set.add(p["id"])
                    self.queue.append((slug, p)); fresh += 1
            self.seen_set = set(self.seen)
            save_json(STATE_PATH, {"seen": list(self.seen)})
            self.ok, self.backoff = 1.0, 1
            log(f"查詢完成,新串文 {fresh} 則,{self.interval()/60:.0f} 分鐘後再查")
        except ApiError as e:
            self.ok = 0.0
            if e.rate_limited:
                self.backoff = min(self.backoff * 2, 8)
            log(f"查詢失敗:{e}" + ("(呼叫太頻繁,放慢查詢)" if e.rate_limited else ""))

    def drain(self):
        """讀完蒐集器目前送來的所有訊息。"""
        fresh = False
        while True:
            try:
                data, _ = self.inbox.recvfrom(65535)
            except (BlockingIOError, InterruptedError):
                break
            try:
                m = json.loads(data.decode("utf-8"))
            except ValueError:
                continue
            if m.get("type") == "status":
                if not self.linked:
                    log("已連上偽 Chrome 的「Threads 蒐集」")
                    self.linked = True
                self.last_status = time.time()
                self.ok = 1.0 if m.get("ok") else 0.0
                self.next_poll = time.time() + float(m.get("next", 0))
                self.round_interval = float(m.get("interval", self.round_interval))
            elif m.get("type") == "log":
                log(f"[偽 Chrome] {m.get('msg', '')}")
            elif m.get("type") == "post" and m.get("slug") in self.kws and m.get("id") not in self.seen_set:
                self.seen.append(m["id"]); self.seen_set.add(m["id"])
                self.queue.append((m["slug"], m)); fresh = True
        if fresh:
            self.seen_set = set(self.seen)
            save_json(STATE_PATH, {"seen": list(self.seen)})
        if self.linked and time.time() - self.last_status > 5:
            log("與偽 Chrome 的「Threads 蒐集」斷線(偽 Chrome 關了,或蒐集中被取消勾選)")
            self.linked, self.ok = False, 0.0

    def release(self, slug, p):
        now = time.time()
        self.heat[slug] = min(1.0, self.heat[slug] + float(self.cfg.get("heat_per_post", 0.25)))
        self.total[slug] += 1
        self.sent[slug].append(now)
        text = (p.get("text") or "").replace("\n", " ")
        who = self.author(p.get("username"))
        # 連結裡含有原帳號(threads.net/@帳號/…),匿名時一併不送、不記
        link = "" if self.cfg.get("anonymize", True) else p.get("permalink", "")
        self.osc.post_msg(slug, self.kws[slug], who, text, p.get("timestamp", ""), link)
        new = not os.path.exists(self.csv_path)
        with open(self.csv_path, "a", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["收到時間", "關鍵字", "作者", "內文", "發文時間", "連結"])
            w.writerow([time.strftime("%Y-%m-%d %H:%M:%S"), self.kws[slug], who, text,
                        p.get("timestamp", ""), link])
        log(f"[{self.kws[slug]}] {who}:{text[:40]}")

    def send_values(self, dt):
        half = float(self.cfg.get("heat_half_life_sec", 600))
        k = math.exp(-math.log(2) * dt / half)
        now = time.time()
        for s in self.kws:
            self.heat[s] *= k
            while self.sent[s] and now - self.sent[s][0] > 3600:
                self.sent[s].popleft()
            self.osc.value(f"/kw/{s}/heat", self.heat[s])
            self.osc.value(f"/kw/{s}/total", self.total[s])
            self.osc.value(f"/kw/{s}/hour", len(self.sent[s]))
        self.osc.value("/status/ok", self.ok)
        self.osc.value("/status/next", max(0.0, self.next_poll - now))

    def run(self, duration=None):
        tick = 0.1
        start = last = time.time()
        next_release = 0.0
        log("展示模式" if self.demo else f"追蹤關鍵字:{'、'.join(self.kws.values())}")
        if self.browser:
            log(f"瀏覽器模式:等待偽 Chrome 的「Threads 蒐集」送資料(port {self.inbox.getsockname()[1]})")
        log(f"OSC → {self.cfg['osc_host']} 數值:{self.cfg['osc_port_values']} 串文:{self.cfg['osc_port_posts']}")
        while duration is None or time.time() - start < duration:
            now = time.time()
            if self.browser:
                self.drain()
            elif self.demo:
                if now >= self.next_poll:
                    self.queue.append(demo_posts(self.kws))
                    self.next_poll = now + random.uniform(1.5, 6.0)
            elif now >= self.next_poll:
                if not self.demo and now - self.cfg.get("token_refreshed_at", 0) > 86400 * 7:
                    try:
                        refresh_token(self.cfg)
                    except ApiError as e:
                        log(f"更新 token 失敗(先繼續用舊的):{e}")
                        self.cfg["token_refreshed_at"] = int(now)   # 一週後再試
                self.poll()
                self.next_poll = time.time() + self.interval()
            # 把一批新串文平均攤到下一次查詢前慢慢釋放,TD 收到的是穩定的流,不是一次爆量
            if self.queue and now >= next_release:
                self.release(*self.queue.popleft())
                horizon = self.next_poll - now
                if self.browser and horizon < 1:      # 蒐集器正在搜尋中(還沒排下一輪),用每輪間隔估
                    horizon = self.round_interval
                gap = max(1.0, horizon) / (len(self.queue) + 1)
                next_release = now + min(gap, float(self.cfg.get("max_release_gap_sec", 20)))
            self.send_values(now - last)
            last = now
            time.sleep(tick)


def main():
    ap = argparse.ArgumentParser(description="Threads 關鍵字 → TouchDesigner(OSC)")
    ap.add_argument("--demo", action="store_true", help="展示模式,不連網")
    ap.add_argument("--refresh", action="store_true", help="只更新 access token")
    ap.add_argument("--browser", action="store_true", help="瀏覽器模式,接收偽 Chrome 蒐集器的資料")
    ap.add_argument("--duration", type=float, help=argparse.SUPPRESS)   # 測試用
    args = ap.parse_args()

    example = load_json(os.path.join(HERE, "config.example.json"), {})
    cfg = {**example, **load_json(CONFIG_PATH, {})}
    if args.browser:
        try:
            Bridge(cfg, demo=False, browser=True).run(args.duration)
        except KeyboardInterrupt:
            log("已停止")
        return
    if not args.demo and not cfg.get("access_token", "").strip():
        sys.exit("找不到 access token:把 config.example.json 複製成 config.json,填入 access_token。\n"
                 "想先看效果,用 --demo 執行。")
    if args.refresh:
        refresh_token(cfg)
        return
    try:
        Bridge(cfg, args.demo).run(args.duration)
    except KeyboardInterrupt:
        log("已停止")


if __name__ == "__main__":
    main()
