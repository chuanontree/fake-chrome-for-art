"""
《蜂窩性組織言》橋接程式:Threads 事件 → TouchDesigner(OSC)

只處理數字。不接收、不儲存、不傳送任何貼文文字。

    py threads_bridge.py --browser             即時:接收偽 Chrome「Threads 蒐集」的觀察值(UDP 7010)
    py threads_bridge.py --demo                展示:不連網,合成事件(調視覺用)
    py threads_bridge.py --replay 檔案 --speed 60   重播:重跑錄下來的觀察值,可加速 1x / 10x / 60x

即時模式會把收到的觀察值(ID 已雜湊)錄到 recordings/,之後用 --replay 重播,不必每次都連 Threads。

送進 TD 的 OSC(預設 127.0.0.1):
  數值 → port 7000(OSC In CHOP)
    /global/heat       0~1,所有事件強度的彙總(給全局光線與聲音)
    /events/active     目前追蹤中的事件數
    /kw/<slug>/heat    0~1,各關鍵字相關事件的強度彙總
    /status/ok         1 = 蒐集正常,0 = 出錯或需要登入
    /status/next       距離下一輪蒐集的秒數
  事件清單 → port 7001(OSC In DAT),每秒每個事件送一次
    /event  匿名ID, 強度(0~1), 階段(0發現 1升溫 2高峰 3冷卻 4消失), 出現至今(分鐘), 出現時間(ISO)
    階段 4(消失)只送一次,之後該 ID 不再出現。
"""
import argparse, csv, json, math, os, random, secrets, socket, struct, sys, time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)                      # 不管從哪裡執行,都找得到同資料夾的 events.py
from events import Engine, STAGES
CONFIG_PATH = os.path.join(HERE, "config.json")
STATE_PATH = os.path.join(HERE, "state.json")
REC_DIR = os.path.join(HERE, "recordings")


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
    def __init__(self, host, num_port, list_port):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.num, self.list = (host, num_port), (host, list_port)

    def value(self, address, v):
        self.sock.sendto(osc_packet(address, v), self.num)

    def event(self, ev, now):
        first = datetime.fromtimestamp(ev.first_seen, timezone.utc).astimezone().isoformat(timespec="seconds")
        self.sock.sendto(osc_packet("/event", ev.hid, ev.intensity, ev.stage,
                                    (now - ev.first_seen) / 60.0, first), self.list)


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


def salt():
    """事件 ID 雜湊用的鹽,第一次執行時產生並存在 state.json(不進 repo)。"""
    st = load_json(STATE_PATH, {})
    if not st.get("salt"):
        st["salt"] = secrets.token_hex(16)
        save_json(STATE_PATH, st)
    return st["salt"]


# ── 主體 ──────────────────────────────────────────────────
class Bridge:
    def __init__(self, cfg, mode, speed=1.0, replay_path=None):
        self.cfg, self.mode, self.speed = cfg, mode, speed
        self.kws = cfg["keywords"]
        self.osc = Osc(cfg["osc_host"], cfg["osc_port_values"], cfg["osc_port_events"])
        self.engine = Engine(salt(), cfg.get("events"), on_change=self.changed)
        self.ok, self.next_at = 1.0, 0.0
        self.stats = {"obs": 0, "events": 0, "lost": 0, "vanished": 0}
        self.last_seq = None
        self.counted = set()
        name = cfg.get("events_log", "events_log.csv")
        if mode != "browser":                         # 展示 / 重播另存,不混進即時紀錄
            name = name.replace(".csv", f"_{mode}.csv")
        self.log_path = os.path.join(HERE, name)
        self.rec = None
        if mode == "browser":
            self.inbox = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.inbox.bind((cfg.get("browser_listen_host", "127.0.0.1"), int(cfg.get("browser_listen_port", 7010))))
            self.inbox.setblocking(False)
            self.linked, self.last_status = False, 0.0
            os.makedirs(REC_DIR, exist_ok=True)
            path = os.path.join(REC_DIR, time.strftime("%Y%m%d_%H%M%S") + ".jsonl")
            self.rec = open(path, "a", encoding="utf-8")
            log(f"錄製到 {path}")
        if mode == "replay":
            self.replay = self.load_replay(replay_path)
        if mode == "demo":
            self.demo_events, self.demo_next = {}, 0.0

    # 事件變化:寫進事件紀錄(沒有文字)
    def changed(self, ev):
        if ev.hid not in self.counted:
            self.counted.add(ev.hid); self.stats["events"] += 1
        if ev.stage == 4:
            self.stats["vanished"] += 1
            self.osc.event(ev, self.sim_now)       # 消失只送一次
        new = not os.path.exists(self.log_path)
        m = ev.metrics()
        with open(self.log_path, "a", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["時間", "事件", "階段", "強度", "回覆速度(每10分)", "回覆數", "讚數", "引用數",
                            "樣本回覆", "樣本帳號", "深層比例", "關鍵字數", "來源", "替代根貼文"])
            w.writerow([datetime.fromtimestamp(self.sim_now).strftime("%Y-%m-%d %H:%M:%S"), ev.hid,
                        STAGES[ev.stage], round(ev.intensity, 3), round(ev.velocity, 2), m["replies"], m["likes"],
                        m["quotes"], m["sample_n"], m["participants"], round(m["deep_share"], 2), m["keywords"],
                        "/".join(sorted(ev.sources)), ev.fallback or ""])

    def ingest(self, o, now):
        """一筆觀察值:先雜湊 ID,錄下來,再交給引擎。"""
        self.stats["obs"] += 1
        o = dict(o)
        if "id" in o:
            o["hid"] = self.engine.hid(o.pop("id"))
        o["t"] = now
        if self.rec:
            self.rec.write(json.dumps(o, ensure_ascii=False) + "\n"); self.rec.flush()
        self.engine.observe(o, now)

    # 即時:讀蒐集器送來的訊息
    def drain(self, now):
        while True:
            try:
                data, _ = self.inbox.recvfrom(65535)
            except (BlockingIOError, InterruptedError):
                break
            try:
                m = json.loads(data.decode("utf-8"))
            except ValueError:
                continue
            seq = m.get("seq")
            if isinstance(seq, int):                  # 序號跳號 = UDP 遺失;序號變小 = 偽 Chrome 重開
                if self.last_seq is not None and seq > self.last_seq + 1:
                    self.stats["lost"] += seq - self.last_seq - 1
                self.last_seq = seq
            t = m.get("type")
            if t == "status":
                if not self.linked:
                    log("已連上偽 Chrome 的「Threads 蒐集」")
                    self.linked = True
                self.last_status = now
                self.ok = 1.0 if m.get("ok") else 0.0
                self.next_at = now + float(m.get("next", 0))
            elif t == "log":
                log(f"[偽 Chrome] {m.get('msg', '')}")
            elif t == "obs" and m.get("id"):
                self.ingest(m, now)
        if self.linked and now - self.last_status > 5:
            log("與偽 Chrome 的「Threads 蒐集」斷線(偽 Chrome 關了,或蒐集中被取消勾選)")
            self.linked, self.ok = False, 0.0

    # 重播
    def load_replay(self, path):
        rows = []
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
        rows.sort(key=lambda r: r["t"])
        if not rows:
            sys.exit("重播檔是空的")
        log(f"重播 {os.path.basename(path)}:{len(rows)} 筆觀察值,"
            f"橫跨 {(rows[-1]['t'] - rows[0]['t']) / 3600:.1f} 小時,速度 {self.speed:g}x")
        return rows

    # 展示:合成事件(每個事件的回覆數照 S 形曲線成長,之後停住)
    def demo_step(self, now):
        if now >= self.demo_next:
            i = f"demo{len(self.demo_events)}"
            self.demo_events[i] = {"born": now, "size": random.choice([20, 60, 200, 800]),
                                   "rate": random.uniform(0.5, 3) / 600, "likes": random.randint(5, 2000),
                                   "kw": random.choice(list(self.kws.values())), "next": now}
            self.demo_next = now + random.uniform(60, 240)
        for i, d in list(self.demo_events.items()):
            if now >= d["next"]:
                x = (now - d["born"]) * d["rate"]
                replies = int(d["size"] / (1 + math.exp(-(x - 4))))
                n = min(40, replies)
                self.ingest({"id": i, "replies": replies, "likes": d["likes"], "quotes": replies // 20,
                             "taken_at": d["born"], "kw": d["kw"], "source": "展示",
                             "sample": {"n": n, "participants": int(n * 0.8), "deep_share": 0.3}}, now)
                d["next"] = now + random.uniform(300, 900)
                if now - d["born"] > 6 * 3600:
                    del self.demo_events[i]

    def send(self, now):
        e = self.engine
        for ev in e.events.values():
            self.osc.event(ev, now)
        self.osc.value("/global/heat", e.global_heat())
        self.osc.value("/events/active", len(e.events))
        for slug, kw in self.kws.items():
            self.osc.value(f"/kw/{slug}/heat", e.keyword_heat(kw))
        self.osc.value("/status/ok", self.ok)
        self.osc.value("/status/next", max(0.0, self.next_at - now))

    def run(self, duration=None):
        start = time.time()
        self.sim_now = start if self.mode != "replay" else self.replay[0]["t"]
        last_real, last_send, last_report, idx = start, 0.0, start, 0
        log(f"關鍵字:{'、'.join(self.kws.values())}")
        log(f"OSC → {self.cfg['osc_host']} 數值:{self.cfg['osc_port_values']} 事件清單:{self.cfg['osc_port_events']}")
        if self.mode == "browser":
            log(f"等待偽 Chrome 的「Threads 蒐集」(port {self.inbox.getsockname()[1]})")
        try:
            while duration is None or time.time() - start < duration:
                real = time.time()
                self.sim_now += (real - last_real) * (self.speed if self.mode == "replay" else 1)
                last_real = real
                now = self.sim_now
                if self.mode == "browser":
                    self.drain(now)
                elif self.mode == "demo":
                    self.demo_step(now)
                else:
                    while idx < len(self.replay) and self.replay[idx]["t"] <= now:
                        self.ingest(self.replay[idx], self.replay[idx]["t"]); idx += 1
                    if idx >= len(self.replay) and not self.engine.events:
                        log("重播結束"); break
                self.engine.tick(now)
                if real - last_send >= 1.0 / max(1, min(self.speed, 10)):
                    self.send(now); last_send = real
                if real - last_report >= 600:
                    self.report(); last_report = real
                time.sleep(0.05)
        finally:
            self.report()
            if self.rec:
                self.rec.close()

    def report(self):
        s = self.stats
        log(f"累計:觀察值 {s['obs']}、事件 {s['events']}、消失 {s['vanished']}、追蹤中 {len(self.engine.events)}、"
            f"遺失訊息 {s['lost']}、整體熱度 {self.engine.global_heat():.2f}")


def main():
    ap = argparse.ArgumentParser(description="《蜂窩性組織言》Threads 事件 → TouchDesigner(OSC)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--browser", action="store_true", help="即時:接收偽 Chrome 蒐集器的觀察值")
    g.add_argument("--demo", action="store_true", help="展示:合成事件")
    g.add_argument("--replay", metavar="檔案", help="重播 recordings/ 裡的錄製檔")
    ap.add_argument("--speed", type=float, default=1.0, help="重播速度(1、10、60…)")
    ap.add_argument("--duration", type=float, help=argparse.SUPPRESS)   # 測試用
    args = ap.parse_args()
    cfg = {**load_json(os.path.join(HERE, "config.example.json"), {}), **load_json(CONFIG_PATH, {})}
    mode = "browser" if args.browser else "demo" if args.demo else "replay"
    path = args.replay
    if path == "latest":
        files = sorted(f for f in os.listdir(REC_DIR) if f.endswith(".jsonl")) if os.path.isdir(REC_DIR) else []
        if not files:
            sys.exit("recordings/ 裡還沒有錄製檔:先用 --browser 跑一段時間")
        path = files[-1]
    if path and not os.path.exists(path):
        path = os.path.join(REC_DIR, path)
    try:
        Bridge(cfg, mode, args.speed, path).run(args.duration)
    except KeyboardInterrupt:
        log("已停止")


if __name__ == "__main__":
    main()
