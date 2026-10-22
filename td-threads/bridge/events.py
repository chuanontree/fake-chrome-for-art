"""
事件引擎:把蒐集器送來的「觀察值」變成事件的強度與生命週期。

事件 = 一則根貼文(根貼文被刪除時,改用回覆鏈最上層看得到的那則)。
觀察值只有數字:回覆數、讚數、引用數、轉發數、發文時間,
以及(看過事件本身的頁面時)前幾十則回覆的樣本:幾則、幾個不重複帳號、第 2 層以後占多少。
沒有任何文字。事件 ID 一進來就加鹽雜湊,之後全程只用雜湊。

強度(0~1)由五個去語意化的指標加權:
  回覆速度   每 10 分鐘新增回覆數(兩次觀察之間的差;只有一次觀察時,用「回覆數 ÷ 發文至今」估)
  回覆/讚    回覆數 ÷ (讚數 + 1),高代表被圍剿
  引用數
  參與多樣性 樣本裡不重複帳號 ÷ 樣本回覆數
  回覆深度   樣本裡第 2 層以後的回覆比例
每個指標先用 x / (x + k) 壓到 0~1,再加權。回覆總數太少的事件會被打折。

生命週期(依回覆速度):
  0 發現 → 1 升溫(速度比上次快)→ 2 高峰(速度在最高點的 60% 以上)
  → 3 冷卻(速度掉下來或低於門檻)→ 4 消失(超過 quiet_min 分鐘回覆數沒有增加)
"""
import hashlib, math, time

STAGES = ["發現", "升溫", "高峰", "冷卻", "消失"]

DEFAULTS = {
    "weights": {"velocity": 0.40, "reply_like": 0.25, "quotes": 0.10, "diversity": 0.15, "depth": 0.10,
                "multi_keyword": 0.0},
    "k": {"velocity": 10.0, "reply_like": 0.3, "quotes": 20.0},   # x/(x+k) 的 k:到達 k 時該指標 = 0.5
    "min_replies": 5,          # 回覆總數少於這個數,強度依比例打折
    "min_velocity": 1.0,       # 每 10 分鐘少於這個數,算冷卻
    "peak_ratio": 0.6,         # 速度在最高點的這個比例以上,算高峰
    "quiet_min": 60,           # 這麼多分鐘回覆數沒增加,算消失
    "max_events": 60,          # 同時追蹤上限,超過時先丟最冷的
}


def sat(x, k):
    return x / (x + k) if x and x > 0 else 0.0


def components(m, cfg=DEFAULTS):
    """m: replies, likes, quotes, velocity(每 10 分), sample_n, participants, deep_share, keywords。回傳各指標 0~1。"""
    k = cfg["k"]
    n = m.get("sample_n") or 0
    return {
        "velocity": sat(m.get("velocity") or 0, k["velocity"]),
        "reply_like": sat((m.get("replies") or 0) / ((m.get("likes") or 0) + 1), k["reply_like"]),
        "quotes": sat(m.get("quotes") or 0, k["quotes"]),
        "diversity": (m.get("participants") or 0) / n if n >= 5 else 0.0,
        "depth": (m.get("deep_share") or 0.0) if n >= 5 else 0.0,
        "multi_keyword": 1.0 if (m.get("keywords") or 1) > 1 else 0.0,
    }


def score(m, cfg=DEFAULTS):
    """強度 0~1。"""
    w = cfg["weights"]
    c = components(m, cfg)
    total = sum(w.values()) or 1.0
    s = sum(w[key] * c[key] for key in w) / total
    replies = m.get("replies") or 0
    if replies < cfg["min_replies"]:
        s *= replies / cfg["min_replies"]
    return max(0.0, min(1.0, s))


def single_visit_velocity(replies, taken_at, now):
    """只看過一次時的速度估計:回覆數 ÷ 發文至今(每 10 分鐘)。"""
    if not replies or not taken_at:
        return 0.0
    minutes = max(30.0, (now - taken_at) / 60.0)
    return replies / minutes * 10.0


class Event:
    __slots__ = ("hid", "first_seen", "taken_at", "obs", "velocity", "prev_velocity", "max_velocity",
                 "last_change", "stage", "intensity", "keywords", "sources", "sample", "fallback", "updated")

    def __init__(self, hid, now):
        self.hid, self.first_seen = hid, now
        self.taken_at = None
        self.obs = []                       # [(t, replies, likes, quotes, reposts)],只留最近 20 筆
        self.velocity = self.prev_velocity = self.max_velocity = 0.0
        self.last_change = now
        self.stage, self.intensity = 0, 0.0
        self.keywords, self.sources = set(), set()
        self.sample = None
        self.fallback = None
        self.updated = now

    def metrics(self):
        last = self.obs[-1] if self.obs else (0, 0, 0, 0, 0)
        s = self.sample or {}
        return {"replies": last[1], "likes": last[2], "quotes": last[3], "velocity": self.velocity,
                "sample_n": s.get("n", 0), "participants": s.get("participants", 0),
                "deep_share": s.get("deep_share", 0.0), "keywords": len(self.keywords)}


class Engine:
    def __init__(self, salt, cfg=None, on_change=None):
        self.salt = salt
        cfg = cfg or {}
        self.cfg = {**DEFAULTS, **cfg,
                    "weights": {**DEFAULTS["weights"], **cfg.get("weights", {})},
                    "k": {**DEFAULTS["k"], **cfg.get("k", {})}}
        self.events = {}            # hid -> Event
        self.gone = {}              # 已消失的事件:hid -> (消失時間, 當時回覆數);回覆數真的再增加才復活
        self.on_change = on_change or (lambda ev: None)

    def hid(self, raw_id):
        return hashlib.sha1(f"{self.salt}:{raw_id}".encode()).hexdigest()[:10]

    def observe(self, o, now=None):
        """o:蒐集器的觀察值(id 可以是原始 ID 或已雜湊的 hid)。回傳 Event。"""
        now = now if now is not None else o.get("t") or time.time()
        hid = o.get("hid") or self.hid(o["id"])
        ev = self.events.get(hid)
        if ev is None:
            if hid in self.gone:
                if (o.get("replies") or 0) <= self.gone[hid][1]:
                    return None                 # 已消失、也沒有新回覆:不讓舊串反覆閃現
                del self.gone[hid]              # 有新回覆:同一個事件(同一個 ID)復活
            ev = self.events[hid] = Event(hid, now)
            self._trim()
        if o.get("taken_at"):
            ev.taken_at = o["taken_at"]
        if o.get("kw"):
            ev.keywords.add(o["kw"])
        if o.get("source"):
            ev.sources.add(o["source"])
        if o.get("fallback"):
            ev.fallback = o["fallback"]
        if o.get("sample") and o["sample"].get("n"):
            ev.sample = o["sample"]
        replies = o.get("replies")
        if replies is not None:
            prev = ev.obs[-1] if ev.obs else None
            if prev and replies > prev[1]:
                ev.last_change = now
            if prev and now - prev[0] >= 60:
                ev.prev_velocity = ev.velocity
                ev.velocity = max(0.0, (replies - prev[1]) / ((now - prev[0]) / 600.0))
                ev.obs.append((now, replies, o.get("likes"), o.get("quotes"), o.get("reposts")))
            elif not prev:
                ev.velocity = single_visit_velocity(replies, ev.taken_at, now)
                ev.obs.append((now, replies, o.get("likes"), o.get("quotes"), o.get("reposts")))
            else:                                   # 一分鐘內重複觀察:只更新數字,不算速度
                ev.obs[-1] = (prev[0], replies, o.get("likes"), o.get("quotes"), o.get("reposts"))
            ev.obs = ev.obs[-20:]
            ev.max_velocity = max(ev.max_velocity, ev.velocity)
        self._restage(ev, now, first=len(ev.obs) <= 1)
        return ev

    def _restage(self, ev, now, first=False):
        c = self.cfg
        old = (ev.stage, round(ev.intensity, 3))
        ev.intensity = score(ev.metrics(), c)
        if first:
            ev.stage = 0
        elif ev.velocity < c["min_velocity"]:
            ev.stage = 3
        elif ev.velocity > ev.prev_velocity:
            ev.stage = 1
        elif ev.velocity >= c["peak_ratio"] * ev.max_velocity:
            ev.stage = 2
        else:
            ev.stage = 3
        ev.updated = now
        if (ev.stage, round(ev.intensity, 3)) != old or first:
            self.on_change(ev)

    def tick(self, now=None):
        """定時呼叫:超過 quiet_min 沒有新回覆的事件 → 消失並移除。回傳消失的事件。"""
        now = now if now is not None else time.time()
        gone = []
        for hid, ev in list(self.events.items()):
            if now - ev.last_change > self.cfg["quiet_min"] * 60:
                ev.stage, ev.updated = 4, now
                self.on_change(ev)
                gone.append(ev)
                del self.events[hid]
                self.gone[hid] = (now, ev.obs[-1][1] if ev.obs else 0)
        for hid, (t, _) in list(self.gone.items()):
            if now - t > 86400:                 # 記住一天
                del self.gone[hid]
        return gone

    def _trim(self):
        while len(self.events) > self.cfg["max_events"]:
            coldest = min(self.events.values(), key=lambda e: (e.intensity, e.updated))
            del self.events[coldest.hid]
            self.gone[coldest.hid] = (time.time(), coldest.obs[-1][1] if coldest.obs else 0)

    def global_heat(self):
        """所有事件強度的彙總(0~1):1 - exp(-Σ強度 / 2)。"""
        return 1.0 - math.exp(-sum(e.intensity for e in self.events.values()) / 2.0)

    def keyword_heat(self, kw):
        return 1.0 - math.exp(-sum(e.intensity for e in self.events.values() if kw in e.keywords) / 2.0)
