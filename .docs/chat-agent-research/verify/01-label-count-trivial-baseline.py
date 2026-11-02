"""驗證：2010.05256 的標籤數準確率與「永遠只猜一個意圖」的平凡基準幾乎打平。

主張（章節 01-goal-intent.md 的「多意圖的『該輸出幾個』與平凡基準打平」）：
  TourSG 平凡基準 = 100 − (22.7+18.2+16.0+17.4+18.1+16.4)/6 = 81.87%，
  StanfordLU = 100 − (21.3+24.6+3.8)/3 = 83.43%；完整模型（Table 6 的 ALR+MT+KR）
  82.26／82.05／80.92／84.70 與基準的差只有 −2.51 到 +1.27 點，StanfordLU 1-shot 甚至低於基準。

出處：[arXiv:2010.05256]，筆記 notes/2010.05256.json 的 limitations_observed 第 1 條。

輸入數字全部取自 .cache/text/2010.05256.txt：
  - Table 1：各領域的 P. ML（多標籤句比例）。TourSG 六個領域 It/Ac/At/Fo/Tr/Sh，
    StanfordLU 三個領域 Sc/Na/We。
  - Table 6（Analysis of label number accuracy）：ALR、ALR+MT、ALR+MT+KR 三列，
    欄位依序 TourSG 1-shot、5-shots、StanfordLU 1-shot、5-shots。
  - Table 2 圖說：主表的 Ave. 是各目標領域分數的平均（本程式據此用簡單平均算基準）。

檢查：
  1. 每句至少一個意圖時，「永遠只猜一個」在領域 d 的標籤數準確率 = 100 − P.ML_d；
     跨目標領域簡單平均得到資料集的平凡基準。
  2. 完整模型逐格減去基準；四格差距的絕對值都不超過 2.6，且 StanfordLU 1-shot 為負。
  3. 補充（敏感度）：
     - P.ML 只到小數一位，基準的捨入誤差上限 ±0.05。
     - 若 Table 6 不是逐領域簡單平均、而是按 query 數加權，基準會落在各領域基準的最小值到最大值之間；
       列出這個範圍，看結論在多寬的假設下還站得住。
     - 列出 ALR、ALR+MT 兩列與基準的差，看消融表的「持續上升」是從多低的地方升上來。
  4. 嵌入器：Table 6 沒標嵌入器；平凡基準只用 Table 1 的資料統計，與嵌入器無關，
     所以不存在「Table 6 的嵌入器與 Table 1 的統計基準不一致」的問題，但無法得知 Table 6 是
     Electra 還是 BERT 的結果。

執行：python3 01-label-count-trivial-baseline.py（只用標準函式庫，無隨機數）。
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", ".cache", "text", "2010.05256.txt")
LIMIT = 2.6

# --- 輸入（取自 .cache/text/2010.05256.txt） ---
# Table 1：| Domain | 1-shot |S| | 5-shot |S| | P. ML | |Y| |
TABLE1_RAW = {
    "It": "12.56 | 48.44 | 22.7% | 16",
    "Ac": "13.93 | 59.95 | 18.2% | 17",
    "At": "14.40 | 65.71 | 16.0% | 18",
    "Fo": "14.92 | 63.77 | 17.4% | 18",
    "Tr": "13.97 | 59.77 | 18.1% | 17",
    "Sh": "13.12 | 55.53 | 16.4% | 16",
    "Sc": "11.07 | 52.88 | 21.3% | 14",
    "Na": "7.34 | 34.29 | 24.6% | 10",
    "We": "7.45 | 36.40 | 3.8% | 8",
}
DATASETS = {"TourSG": ["It", "Ac", "At", "Fo", "Tr", "Sh"], "StanfordLU": ["Sc", "Na", "We"]}
# Table 6：| Setting | TourSG 1-shot | TourSG 5-shots | StanfordLU 1-shot | StanfordLU 5-shots |
TABLE6_RAW = {
    "ALR": "68.16 | 67.28 | 15.67 | 21.91",
    "ALR + MT": "77.85 | 78.18 | 51.24 | 51.38",
    "ALR + MT + KR": "82.26 | 82.05 | 80.92 | 84.70",
}
COLUMNS = [("TourSG", "1-shot"), ("TourSG", "5-shot"), ("StanfordLU", "1-shot"), ("StanfordLU", "5-shot")]

P_ML = {d: float(row.split("|")[2].strip().rstrip("%")) for d, row in TABLE1_RAW.items()}
TABLE6 = {name: [float(x) for x in row.split("|")] for name, row in TABLE6_RAW.items()}

ANCHORS = [
    "P. ML denotes the proportion multi-label sentences.",
    "Table 6: Analysis of label number accuracy.",
    "we conduct accuracy analysis of whether model can predict correct number of labels",
    "Ave. shows the averaged scores.",
    "| Setting | TourSG | StanfordLU | 1-shot | 5-shots | 1-shot | 5-shots",
] + [f"| {d} | {row}" for d, row in TABLE1_RAW.items()] + [f"| {n} | {row}" for n, row in TABLE6_RAW.items()]


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
    for a in ANCHORS:
        hit = a in flat
        ok = ok and hit
        print(f"[錨點] {'找到' if hit else '缺少'}：{a}")
    return ok


def main():
    anchors_ok = check_anchors()
    print()

    print("[基準] 永遠只猜一個意圖的標籤數準確率 = 100 − P.ML（每句至少一個意圖）")
    baseline = {}
    per_domain = {}
    for ds, domains in DATASETS.items():
        vals = [100 - P_ML[d] for d in domains]
        per_domain[ds] = vals
        baseline[ds] = sum(vals) / len(vals)
        pml = "＋".join(f"{P_ML[d]}" for d in domains)
        print(f"  {ds:10s} 100 − ({pml})／{len(domains)} = {baseline[ds]:.4f} ≈ {baseline[ds]:.2f}%")
        print(f"  {'':10s} 各領域：" + "，".join(f"{d} {100 - P_ML[d]:.1f}" for d in domains))
    print()

    print("[比較] 完整模型（ALR + MT + KR）− 平凡基準")
    full = TABLE6["ALR + MT + KR"]
    diffs = {}
    for (ds, shot), v in zip(COLUMNS, full):
        diffs[(ds, shot)] = v - baseline[ds]
        print(f"  {ds:10s} {shot}：{v:.2f} − {baseline[ds]:.2f} = {diffs[(ds, shot)]:+.2f}")
    lo, hi = min(diffs.values()), max(diffs.values())
    within = all(abs(x) <= LIMIT for x in diffs.values())
    neg = diffs[("StanfordLU", "1-shot")] < 0
    print(f"  差距範圍 {lo:+.2f} 到 {hi:+.2f}；四格絕對值都 ≤ {LIMIT}：{'是' if within else '否'}；StanfordLU 1-shot 為負：{'是' if neg else '否'}")
    print()

    print("[敏感度] P.ML 捨入：每個 P.ML 誤差 ±0.05，平均後基準誤差上限 ±0.05")
    robust = all(abs(x) - 0.05 <= LIMIT for x in diffs.values()) and diffs[("StanfordLU", "1-shot")] + 0.05 < 0
    print(f"  捨入誤差下結論不變：{'是' if robust else '否'}")
    print("[敏感度] 若 Table 6 按 query 數加權而非逐領域簡單平均，基準落在各領域基準的最小到最大之間：")
    for (ds, shot), v in zip(COLUMNS, full):
        b_lo, b_hi = min(per_domain[ds]), max(per_domain[ds])
        print(f"  {ds:10s} {shot}：基準 {b_lo:.1f}–{b_hi:.1f} → 差距 {v - b_hi:+.2f} 到 {v - b_lo:+.2f}")
    print("  （Table 1 沒有各領域 query 數，無法算出加權版；簡單平均與主表 Ave. 的做法一致。）")
    print()

    print("[補充] 消融各列 − 平凡基準")
    for name, row in TABLE6.items():
        cells = "，".join(f"{ds} {shot} {v - baseline[ds]:+.2f}" for (ds, shot), v in zip(COLUMNS, row))
        print(f"  {name:14s} {cells}")
    below = [
        name
        for name, row in TABLE6.items()
        if all(v < baseline[ds] for (ds, _), v in zip(COLUMNS, row))
    ]
    print(f"  四格全部低於平凡基準的列：{'、'.join(below) if below else '無'}")
    print()

    print("[嵌入器] Table 6 圖說沒有標 +E／+B；平凡基準只用 Table 1 的資料統計，與嵌入器無關，")
    print("  所以不會有「嵌入器與統計基準不一致」的問題；但 Table 6 是哪個嵌入器的結果無從得知。")
    print()

    claim = within and neg
    if anchors_ok is False:
        verdict = "無法判定（輸入數字與原文錨點對不上）"
    elif claim:
        verdict = "證實（前提：每句至少一個意圖、Table 6 為逐領域簡單平均、query 分布近似領域整體）"
    else:
        verdict = "推翻"
    print(f"結論：{verdict}")
    return 0 if claim and anchors_ok is not False else 1


if __name__ == "__main__":
    sys.exit(main())
