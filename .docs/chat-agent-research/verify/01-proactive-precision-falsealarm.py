"""驗證：2410.12361（Proactive Agent）的 False-Alarm 在數值上等於 1−Precision，F1 排名跟著 Precision 走。

主張（章節 01-goal-intent.md〈陷阱一〉Proactive Agent 條）：
  Table 3 八列的 Precision＋False-Alarm 都等於 100%（捨入內）；Table 4 的 12 列中 11 列也成立，
  唯一例外是 LLaMA-3.1-8B w/ RM：42.52＋57.41＝99.93。
  Table 3 八列中有七列的 Recall 介於 97.89% 到 100%，這七列的 F1 排名與 Precision 排名完全相同。
  理由：Recall 近於 1 時 F1＝2PR/(P+R) 近似 2P/(1+P)，是 Precision 的單調函數。

出處：[arXiv:2410.12361]；FP/(TP+FP) 的實作與 Recall 範圍來自筆記 notes/2410.12361.json 的
limitations_observed，全表加總與排名是本章對照全文的結果。

輸入數字全部取自 .cache/text/2410.12361.txt 的 Table 3（八個模型）與 Table 4（三個模型 × 四種設定）。
欄位依序是 Recall、Precision、Accuracy、False-Alarm、F1-Score（百分比）。

檢查：
  1. Table 3、Table 4 每列的 Precision＋False-Alarm 與 100 的差（容差 0.02，涵蓋兩位小數的捨入）。
  2. 校準：每列報的 F1 與 2PR/(P+R) 的差（容差 0.02），確認欄位解析正確、F1 用的是報出的 P 與 R。
  3. Table 3 裡 Recall ≥ 97.89 的列數，以及這些列依報出的 F1 排名與依 Precision 排名是否相同
     （排名用論文報的 F1，不用近似）。
  4. 補充：這些列的報出 F1 與近似式 2P/(1+P) 的最大差距，說明「Recall 近於 1」只是近似。
  5. 補充：Table 4 的例外列若改用 100−False-Alarm 當 Precision，F1 會變多少，看哪一欄比較可能是誤植。

執行：python3 verify/01-proactive-precision-falsealarm.py（只用標準函式庫，無隨機數）。
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", ".cache", "text", "2410.12361.txt")
TOL = 0.02

# --- 輸入（取自 .cache/text/2410.12361.txt） ---
TABLE3_RAW = (
    "| Proprietary models | Claude-3-Sonnet | 27.47% | 37.31% | 52.42% | 62.69% | 31.65% | Claude-3.5-Sonnet | 97.89% | 45.37% | 49.78% | 54.63% | 62.00% "
    "| GPT-4o-mini | 100.00% | 35.28% | 36.12% | 64.73% | 52.15% | GPT-4o | 98.11% | 48.15% | 49.78% | 51.85% | 64.60% "
    "| Open-source models | LLaMA-3.1-8B | 98.86% | 38.16% | 39.06% | 61.84% | 55.06% | LLaMA-3.1-8B-Proactive | 99.06% | 49.76% | 52.86% | 50.24% | 66.25% "
    "| Qwen2-7B | 98.02% | 44.00% | 43.61% | 56.00% | 60.74% | Qwen2-7B-Proactive | 100.00% | 49.78% | 50.66% | 50.22% | 66.47% Table 3:"
)
TABLE4_RAW = (
    "| GPT-4o-mini | pred@1 | 100.00% | 35.28% | 36.12% | 64.73% | 52.15% | | pred@3 | 99.32% | 65.32% | 66.52% | 34.68% | 78.80% "
    "| | w/ RM | 55.45% | 63.54% | 63.95% | 36.46% | 59.22% | | pred@3, w/ RM | 100.00% | 65.35% | 66.09% | 34.65% | 79.05% "
    "| GPT-4o | pred@1 | 98.11% | 48.15% | 49.78% | 51.85% | 64.60% | | pred@3 | 100.00% | 63.56% | 64.81% | 36.44% | 77.72% "
    "| | w/ RM | 56.76% | 55.26% | 57.61% | 44.74% | 56.00% | | pred@3, w/ RM | 100.00% | 63.30% | 65.67% | 36.70% | 77.53% "
    "| LLaMA-3.1-8B | pred@1 | 98.86% | 38.16% | 39.06% | 61.84% | 55.06% | | pred@3 | 100.00% | 52.79% | 52.79% | 47.21% | 69.10% "
    "| | w/ RM | 77.08% | 42.52% | 47.64% | 57.41% | 54.81% | | pred@3, w/ RM | 95.12% | 61.58% | 66.09% | 38.42% | 74.76% Table 4:"
)
TEXT_ANCHORS = [
    "| Model | Recall↑ | Precision↑ | Accuracy↑ | False-Alarm↓ | F1-Score↑ |",
    "| Model | Settings | Recall↑ | Precision↑ | Accuracy↑ | False-Alarm↓ | F1-Score↑ |",
    "The False-Alarm measures the proportion of incorrect task predictions, specifically when a task is predicted but not needed.",
]
NUM = r"([\d.]+)%"
ROW = r" \| ".join([NUM] * 5)


def parse_t3(raw):
    return [(m.group(1), [float(m.group(i)) for i in range(2, 7)])
            for m in re.finditer(r"([A-Za-z][\w.\-]*(?:-[\w.]+)*) \| " + ROW, raw)]


def parse_t4(raw):
    out, model = [], None
    for m in re.finditer(r"\| (?:([A-Za-z][\w.\-]+) )?\| (pred@1|pred@3|w/ RM|pred@3, w/ RM) \| " + ROW, raw):
        model = m.group(1) or model
        out.append((f"{model} {m.group(2)}", [float(m.group(i)) for i in range(3, 8)]))
    return out


def flatten(path):
    with open(path, encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]
    return re.sub(r"\s+", " ", " ".join(lines))


def check_anchors():
    if not os.path.exists(SOURCE):
        print(f"[錨點] 找不到 {SOURCE}，略過錨點檢查（.cache/ 不進版控）")
        return None
    flat = flatten(SOURCE)
    ok = True
    for a in [TABLE3_RAW, TABLE4_RAW] + TEXT_ANCHORS:
        hit = a in flat
        ok = ok and hit
        print(f"[錨點] {'找到' if hit else '缺少'}：{a[:90]}")
    return ok


def f1(p, r):
    return 2 * p * r / (p + r)


def main():
    anchors_ok = check_anchors()
    print()
    t3, t4 = parse_t3(TABLE3_RAW), parse_t4(TABLE4_RAW)
    print(f"[解析] Table 3 {len(t3)} 列、Table 4 {len(t4)} 列")
    parse_ok = len(t3) == 8 and len(t4) == 12
    print()

    print("[1] Precision＋False-Alarm 與 100 的差")
    sums = {}
    for tname, rows in (("Table 3", t3), ("Table 4", t4)):
        bad = []
        for name, (r, p, acc, fa, f) in rows:
            s = p + fa
            if abs(s - 100) > TOL:
                bad.append(f"{name} {p}＋{fa}＝{s:.2f}")
        sums[tname] = (len(rows) - len(bad), bad)
        print(f"  {tname}：{len(rows) - len(bad)}／{len(rows)} 列成立；例外：{'；'.join(bad) if bad else '無'}")
    sum_ok = sums["Table 3"][0] == 8 and sums["Table 4"][0] == 11 and sums["Table 4"][1] == ["LLaMA-3.1-8B w/ RM 42.52＋57.41＝99.93"]
    print()

    print("[2] 校準：報出的 F1 與 2PR/(P+R)")
    worst = 0.0
    for name, (r, p, acc, fa, f) in t3 + t4:
        worst = max(worst, abs(f1(p, r) - f))
    calib_ok = worst <= TOL
    print(f"  20 列最大差 {worst:.3f}（容差 {TOL}）：{'吻合' if calib_ok else '不吻合'}")
    print()

    print("[3] Table 3：Recall ≥ 97.89 的列，F1 排名對 Precision 排名")
    high = [(name, v) for name, v in t3 if v[0] >= 97.89]
    by_f1 = [name for name, v in sorted(high, key=lambda x: -x[1][4])]
    by_p = [name for name, v in sorted(high, key=lambda x: -x[1][1])]
    rec = [v[0] for _, v in high]
    print(f"  {len(high)} 列，Recall {min(rec):.2f}–{max(rec):.2f}")
    print(f"  依 F1：{' > '.join(by_f1)}")
    print(f"  依 P ：{' > '.join(by_p)}")
    rank_ok = len(high) == 7 and by_f1 == by_p and min(rec) == 97.89
    print(f"  七列、兩種排名完全相同：{'是' if rank_ok else '否'}")
    print()

    print("[4] 補充：Recall 視為 1 的近似 2P/(1+P) 與報出 F1 的差")
    gaps = [(name, v[4] - 100 * f1(v[1] / 100, 1.0)) for name, v in high]
    for name, g in gaps:
        print(f"  {name:24s} {g:+.2f}")
    ps = sorted((v[1] for _, v in high), reverse=True)
    min_gap = min(a - b for a, b in zip(ps, ps[1:]))
    print(f"  最大絕對差 {max(abs(g) for _, g in gaps):.2f} 個百分點，相鄰兩列 Precision 的最小差距是 {min_gap:.2f}：")
    print("  近似只說明 F1 大致隨 Precision 走；排名完全相同是逐列比出來的，不是近似保證的")
    print()

    print("[5] 補充：Table 4 例外列")
    for name, (r, p, acc, fa, f) in t4:
        if abs(p + fa - 100) > TOL:
            print(f"  {name}：報出 F1 {f}；用報出的 P {p} 算 {f1(p, r):.2f}；改用 100−FA＝{100 - fa:.2f} 算 {f1(100 - fa, r):.2f}")
            print("  報出的 F1 與報出的 Precision 自洽，False-Alarm 那一格比較可能是誤植（僅為推論）")
    print()

    claim = parse_ok and sum_ok and calib_ok and rank_ok
    if anchors_ok is False:
        verdict = "無法判定（輸入數字與原文錨點對不上）"
    elif claim:
        verdict = "證實（Table 3 八列、Table 4 十一列 Precision＋False-Alarm＝100；Recall 97.89–100 的七列 F1 排名與 Precision 排名相同，Recall＝1 只是近似）"
    else:
        verdict = "推翻"
    print(f"結論：{verdict}")
    return 0 if claim and anchors_ok is not False else 1


if __name__ == "__main__":
    sys.exit(main())
