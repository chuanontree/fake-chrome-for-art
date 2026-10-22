"""
精準度評估:比較「只用關鍵字計數」與「事件指標達標」哪個比較準。

步驟:
  1. 偽 Chrome:⋮ → Threads 蒐集 → 精準度評估取樣(約 1 小時),會在暫存資料夾產生
       標記.csv(含原文,給你標記)與 指標.csv(只有數字)
  2. 用 Excel 打開 標記.csv,在「你的標記」欄填 是 / 否(是 = 真的在發生群體發炎),存檔(CSV UTF-8)
  3. 雙擊 evaluate.bat(或 py evaluate.py)→ 產生 評估報告_日期.md(沒有任何原文)
  4. 確認後按 Enter,刪除 標記.csv 與 指標.csv(原文就此消失)

兩種做法:
  (a) 關鍵字計數:命中關鍵字就算一次發炎(現在的舊做法)→ 等於把每一則候選都判為「是」
  (b) 事件指標:事件強度(events.py 的 score)≥ 門檻才算。只看過一次,回覆速度用「回覆數 ÷ 發文至今」估
"""
import argparse, csv, os, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from events import DEFAULTS, components, score, single_visit_velocity   # noqa: E402

YES = {"是", "y", "yes", "1", "v", "o", "true", "t"}
NO = {"否", "n", "no", "0", "x", "false", "f"}
INDICATORS = [("velocity", "回覆速度"), ("reply_like", "回覆/讚"), ("quotes", "引用數"),
              ("diversity", "參與多樣性"), ("depth", "回覆深度")]


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def metrics_of(row, now):
    """指標.csv 的一列 → events.score 用的 metrics(沒找到事件 → None)。"""
    if not row.get("事件序號"):
        return None
    replies = num(row["回覆數"])
    taken_at = now - num(row["事件距今小時"], 0) * 3600 if row.get("事件距今小時") else None
    return {"replies": replies, "likes": num(row["讚數"]), "quotes": num(row["引用數"]),
            "velocity": single_visit_velocity(replies, taken_at, now),
            "sample_n": num(row["樣本回覆"]), "participants": num(row["樣本帳號"]),
            "deep_share": num(row["深層比例"]), "keywords": 1}


def confusion(pairs):
    """pairs: [(預測, 實際)] → dict"""
    tp = sum(1 for p, a in pairs if p and a); fp = sum(1 for p, a in pairs if p and not a)
    fn = sum(1 for p, a in pairs if not p and a); tn = sum(1 for p, a in pairs if not p and not a)
    n = len(pairs) or 1
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {"n": len(pairs), "tp": tp, "fp": fp, "fn": fn, "tn": tn, "acc": (tp + tn) / n, "prec": prec, "rec": rec, "f1": f1}


def auc(values_yes, values_no):
    """Mann–Whitney:隨機挑一則「是」和一則「否」,「是」的值比較大的機率。0.5 = 沒有鑑別力。"""
    if not values_yes or not values_no:
        return None
    wins = sum((y > n) + 0.5 * (y == n) for y in values_yes for n in values_no)
    return wins / (len(values_yes) * len(values_no))


def pct(x):
    return f"{x * 100:.0f}%"


def main():
    ap = argparse.ArgumentParser(description="精準度評估")
    ap.add_argument("--dir", default=os.path.join(tempfile.gettempdir(), "蜂窩性組織言_評估"))
    ap.add_argument("--threshold", type=float, default=0.35, help="事件強度門檻")
    ap.add_argument("--yes", action="store_true", help="不詢問,直接刪除原文檔")
    args = ap.parse_args()

    label_path, metric_path = os.path.join(args.dir, "標記.csv"), os.path.join(args.dir, "指標.csv")
    if not (os.path.exists(label_path) and os.path.exists(metric_path)):
        sys.exit(f"找不到 {label_path} 或 指標.csv:先在偽 Chrome 跑「精準度評估取樣」。")
    labels = {r["編號"]: r for r in read_csv(label_path)}
    metrics = {r["編號"]: r for r in read_csv(metric_path)}
    cfg = {**DEFAULTS}
    now = os.path.getmtime(metric_path)                # 取樣當下的時間

    rows, unlabeled = [], 0
    for no, m in metrics.items():
        mark = (labels.get(no, {}).get("你的標記(是/否)") or "").strip().lower()
        if mark in YES or mark in NO:
            mt = metrics_of(m, now)
            rows.append({"no": no, "src": m["來源"], "kind": m["命中類型"], "fallback": m.get("替代根貼文", ""),
                         "actual": mark in YES, "m": mt, "score": score(mt, cfg) if mt else 0.0, "row": m})
        else:
            unlabeled += 1
    if not rows:
        sys.exit("標記.csv 裡還沒有填「是 / 否」。")

    T = args.threshold
    a = confusion([(True, r["actual"]) for r in rows])
    b = confusion([(r["score"] >= T, r["actual"]) for r in rows])
    sweep = max(((t / 100, confusion([(r["score"] >= t / 100, r["actual"]) for r in rows])) for t in range(5, 96, 5)),
                key=lambda x: (x[1]["acc"], x[1]["f1"]))

    out = [f"# 精準度評估報告", "", f"產生時間:{time.strftime('%Y-%m-%d %H:%M')}",
           f"已標記 {len(rows)} 則(未標記 {unlabeled} 則,不計入)。報告沒有任何貼文原文。", "",
           "## 1. 關鍵字計數 vs 事件指標", "",
           "| 做法 | 準確率 | 精確率(判為發炎的有幾成真的是) | 召回率(真的發炎有幾成被抓到) | F1 |", "|---|---|---|---|---|",
           f"| (a) 關鍵字計數(命中就算) | {pct(a['acc'])} | {pct(a['prec'])} | {pct(a['rec'])} | {a['f1']:.2f} |",
           f"| (b) 事件指標(強度 ≥ {T}) | {pct(b['acc'])} | {pct(b['prec'])} | {pct(b['rec'])} | {b['f1']:.2f} |",
           f"| (b′) 事件指標,最佳門檻 {sweep[0]:.2f}(事後挑的,會偏樂觀) | {pct(sweep[1]['acc'])} | "
           f"{pct(sweep[1]['prec'])} | {pct(sweep[1]['rec'])} | {sweep[1]['f1']:.2f} |", "",
           f"(b) 的混淆:真發炎判對 {b['tp']}、誤判為發炎 {b['fp']}、漏掉 {b['fn']}、正確排除 {b['tn']}。", "",
           "## 2. 熱門 vs 最新", "",
           "| 來源 | 則數 | 真的是群體發炎 | (b) 準確率 | (b) 精確率 | (b) 召回率 |", "|---|---|---|---|---|---|"]
    for src in sorted({r["src"] for r in rows}):
        rs = [r for r in rows if r["src"] == src]
        c = confusion([(r["score"] >= T, r["actual"]) for r in rs])
        out.append(f"| {src} | {len(rs)} | {pct(sum(r['actual'] for r in rs) / len(rs))} | "
                   f"{pct(c['acc'])} | {pct(c['prec'])} | {pct(c['rec'])} |")

    out += ["", "## 3. 各指標有沒有用", "",
            "鑑別力 = 隨機挑一則「是」和一則「否」,「是」的指標比較高的機率。0.5 = 沒用,越接近 1 越有用,"
            "低於 0.5 = 方向相反。", "",
            "| 指標 | 目前權重 | 鑑別力 | 「是」的平均 | 「否」的平均 |", "|---|---|---|---|---|"]
    found = [r for r in rows if r["m"]]
    for key, name in INDICATORS:
        ys = [components(r["m"], cfg)[key] for r in found if r["actual"]]
        ns = [components(r["m"], cfg)[key] for r in found if not r["actual"]]
        au = auc(ys, ns)
        avg = lambda v: f"{sum(v) / len(v):.2f}" if v else "—"
        out.append(f"| {name} | {cfg['weights'][key]} | {'—' if au is None else f'{au:.2f}'} | {avg(ys)} | {avg(ns)} |")
    for label, f in (("回覆總數", lambda m: m["replies"]), ("讚數", lambda m: m["likes"])):
        au = auc([f(r["m"]) for r in found if r["actual"]], [f(r["m"]) for r in found if not r["actual"]])
        out.append(f"| (參考)原始{label} | — | {'—' if au is None else f'{au:.2f}'} | | |")

    out += ["", "## 4. 誤判類型", ""]
    def describe(rs, title):
        out.append(f"**{title}:{len(rs)} 則**")
        if not rs:
            return
        for key, vals in (("命中類型", {r["kind"] for r in rs}), ("來源", {r["src"] for r in rs})):
            out.append(f"- 依{key}:" + "、".join(f"{v} {sum(1 for r in rs if r[{'命中類型': 'kind', '來源': 'src'}[key]] == v)}"
                                                for v in sorted(vals)))
        miss = sum(1 for r in rs if not r["m"])
        if miss:
            out.append(f"- 其中找不到事件(根貼文未載入)的:{miss}")
        out.append("- 編號(可對照 標記.csv,刪除前看):" + "、".join(r["no"] for r in rs))
    describe([r for r in rows if r["score"] >= T and not r["actual"]], "誤判為發炎(事件指標說是,你說不是)")
    describe([r for r in rows if r["score"] < T and r["actual"]], "漏掉的發炎(你說是,事件指標說不是)")
    out.append("")

    report = os.path.join(HERE, f"評估報告_{time.strftime('%Y%m%d_%H%M')}.md")
    with open(report, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    print("\n".join(out))
    print(f"\n報告已存成 {report}(沒有原文)")

    if not args.yes:
        input("\n要對照誤判的編號,現在去看 標記.csv。看完按 Enter,刪除 標記.csv 與 指標.csv(含原文)…")
    for p in (label_path, metric_path):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass
    try:
        os.rmdir(args.dir)
    except OSError:
        pass
    print("已刪除暫存的原文檔。")


if __name__ == "__main__":
    main()
