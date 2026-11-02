#!/usr/bin/env python3
"""驗證：Fantastic Rewards 逐種子表上的配對比較、標準差，以及「組合分數的中位數」的兩種算法。

主張（章節 08-task-completion-score.md 部分分數一節的 Fantastic Rewards 段、陷阱六、陷阱九）：
  A. MultiWOZ 2.0（附錄 D Table 5）以同種子配對比較 CASPI：RewardNet+GS 平均 +2.05、配對 t 約 3.6，
     RewardMLE+GS 平均 +1.76、t 約 4.2，都超過 df = 4 的雙尾 0.05 臨界值 2.78（精讀筆記的推算）。
  B. 移植到 GALAXY（附錄 E Table 6）：配對差平均 +2.11 與 +3.27，t 約 1.5 與 2.3，沒有過 2.78；
     種子 111 上原版 GALAXY 高於兩個變體（精讀筆記的推算）。
  C. MultiWOZ 2.1（附錄 F Table 8）：配對 t 約 1.1 與 1.7；種子 999 上 CASPI 同時勝過兩個變體（同上）。
  D. RewardNet+GS 五個種子的樣本標準差約 1.83、RewardMLE+GS 約 0.77；Table 1 四個變體的平均只在
     106.27–106.83 之間，變體之間的差距落在種子雜訊之內（同上）。
  E. 附錄 D 說 Combined Score 的「中位數」有兩種算法：先逐種子算組合分數再取中位數，或分別取 Inform、
     Success、BLEU 的中位數再組合。組章時依 Table 5 的 Median 列算 CASPI：前者 105.03，
     後者 (91.69 + 83.48) × 0.5 + 17.21 = 104.795。兩個變體的先後也隨聚合方式改變：五種子平均與
     「分項取中位數再組合」是 RewardNet+GS 在前，「逐種子組合後取中位數」是 RewardMLE+GS 在前。
  另外核對：每列的 Comb. 是否等於 (Inform + Success) × 0.5 + BLEU，Average 列是否等於五個種子的平均。
出處：[arXiv:2302.10342] 全文附錄 D Table 5、附錄 E Table 6、附錄 F Table 8、Table 1。

方法：從 .cache/text/2302.10342.txt 依表題定位，解析五個種子與 Average、Median 列；配對 t 用樣本標準差，
  雙尾 p 值用 t 分布（正則化不完全 beta 函數的連分式）；臨界值用二分法反解。
只用標準函式庫；沒有隨機數。執行：python3 verify/08-fantastic-rewards-seeds.py
"""

import math
import os
import re
from statistics import mean, median, stdev

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
with open(os.path.join(ROOT, ".cache", "text", "2302.10342.txt"), encoding="utf-8") as f:
    L = f.read().split("\n")


def find(pat, start=0):
    for i in range(start, len(L)):
        if re.search(pat, L[i]):
            return i
    raise SystemExit("找不到：" + pat)


NUM = r"\s*\|\s*([\d.]+)"


def parse_table(caption_pat, labels):
    """回傳 {列名: [12 個數字]}，列名為 111/333/555/777/999/Average/Median；三組依序各 4 欄。"""
    i = find(caption_pat)
    j = next((k for k in range(i + 1, len(L)) if L[k].startswith("## ")), len(L))
    flat = " ".join(L[i:j])
    out = {}
    for name in ("111", "333", "555", "777", "999", "Average", "Median"):
        m = re.search(r"\|\s*" + name + NUM * 12, flat)
        if not m:
            raise SystemExit(f"{labels} 找不到列 {name}")
        out[name] = [float(x) for x in m.groups()]
    return i, out


def betacf(a, b, x):
    MAXIT, EPS, FPMIN = 300, 3e-14, 1e-300
    qab, qap, qam = a + b, a + 1, a - 1
    c, d = 1.0, 1 - qab * x / qap
    d = 1 / (d if abs(d) > FPMIN else FPMIN)
    h = d
    for m in range(1, MAXIT + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d
        d = 1 / (d if abs(d) > FPMIN else FPMIN)
        c = 1 + aa / c
        c = c if abs(c) > FPMIN else FPMIN
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d
        d = 1 / (d if abs(d) > FPMIN else FPMIN)
        c = 1 + aa / c
        c = c if abs(c) > FPMIN else FPMIN
        de = d * c
        h *= de
        if abs(de - 1) < EPS:
            break
    return h


def betai(a, b, x):
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    bt = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x))
    if x < (a + 1) / (a + b + 2):
        return bt * betacf(a, b, x) / a
    return 1 - bt * betacf(b, a, 1 - x) / b


def t_p2(t, df):
    return betai(df / 2, 0.5, df / (df + t * t))


def t_crit(df, alpha=0.05):
    lo, hi = 0.0, 50.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if t_p2(mid, df) > alpha:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


SEEDS = ("111", "333", "555", "777", "999")
CRIT = t_crit(4)
print(f"df = 4、雙尾 0.05 的臨界值 = {CRIT:.3f}")

ok = {}
results = {}
tables = [
    ("A", "MultiWOZ 2.0（Table 5）", r"^Per random-seed results.*MultiWOZ 2\.0 dataset, comparing CASPI", "CASPI"),
    ("B", "GALAXY（Table 6）", r"^Per random-seed results.*comparing the vanilla GALAXY", "GALAXY"),
    ("C", "MultiWOZ 2.1（Table 8）", r"^Per random-seed results.*MultiWOZ 2\.1 dataset, comparing the CASPI", "CASPI"),
]
for key, label, pat, base in tables:
    i, T = parse_table(pat, label)
    print(f"\n== {key}. {label}，表題在原文第 {i + 1} 行；基準 {base} ==")
    # 一致性：Comb. = (I + S) × 0.5 + BLEU；Average = 五種子平均
    worst = 0.0
    for s in SEEDS:
        for g in range(3):
            inf, suc, bleu, comb = T[s][4 * g:4 * g + 4]
            worst = max(worst, abs((inf + suc) * 0.5 + bleu - comb))
    avg_err = max(abs(mean(T[s][c] for s in SEEDS) - T["Average"][c]) for c in range(12))
    print(f"  每格 Comb. 與 (Inform + Success)×0.5 + BLEU 的最大差 {worst:.3f}；Average 列與五種子平均的最大差 {avg_err:.3f}")
    base_c = [T[s][3] for s in SEEDS]
    for g, name in ((1, "RewardNet+GS"), (2, "RewardMLE+GS")):
        var_c = [T[s][4 * g + 3] for s in SEEDS]
        d = [v - b for v, b in zip(var_c, base_c)]
        md, sd = mean(d), stdev(d)
        t = md / (sd / math.sqrt(5))
        p = t_p2(abs(t), 4)
        neg = [s for s, x in zip(SEEDS, d) if x < 0]
        print(f"  {name}：逐種子差 {', '.join(f'{x:+.2f}' for x in d)}；平均 {md:+.2f}、配對 t = {t:.2f}、雙尾 p = {p:.3f}；輸給基準的種子 {neg or '無'}")
        results[(key, name)] = (md, t, p, neg)

ok["A"] = all(results[("A", n)][1] > CRIT for n in ("RewardNet+GS", "RewardMLE+GS")) and \
    round(results[("A", "RewardNet+GS")][0], 2) == 2.05 and round(results[("A", "RewardMLE+GS")][0], 2) == 1.76
ok["B"] = all(results[("B", n)][1] < CRIT for n in ("RewardNet+GS", "RewardMLE+GS")) and \
    all("111" in results[("B", n)][3] for n in ("RewardNet+GS", "RewardMLE+GS"))
ok["C"] = all(results[("C", n)][1] < CRIT for n in ("RewardNet+GS", "RewardMLE+GS")) and \
    all("999" in results[("C", n)][3] for n in ("RewardNet+GS", "RewardMLE+GS"))

# ---------------------------------------------------------------- D. 種子標準差對變體間差距
_, T5 = parse_table(tables[0][2], "Table 5")
print("\n== D. MultiWOZ 2.0 的種子標準差 ==")
sds = {}
for g, name in ((0, "CASPI"), (1, "RewardNet+GS"), (2, "RewardMLE+GS")):
    xs = [T5[s][4 * g + 3] for s in SEEDS]
    sds[name] = stdev(xs)
    print(f"  {name}：{min(xs):.2f}–{max(xs):.2f}，樣本標準差 {stdev(xs):.2f}，平均的標準誤 {stdev(xs) / math.sqrt(5):.2f}")
t1 = [106.83, 106.54, 106.27, 106.40]
flat_all = "\n".join(L)
assert all(re.search(r"(?<![\d.])" + re.escape(f"{v:.2f}") + r"(?!\d)", flat_all) for v in t1)
print(f"  Table 1 四個變體的平均：{', '.join(f'{v:.2f}' for v in t1)}，全距 {max(t1) - min(t1):.2f}")
ok["D"] = round(sds["RewardNet+GS"], 2) == 1.83 and round(sds["RewardMLE+GS"], 2) == 0.77 and max(t1) - min(t1) < sds["RewardNet+GS"]

# ---------------------------------------------------------------- E. 中位數的兩種算法
print("\n== E. Combined Score 的中位數有兩種算法（附錄 D）==")
assert find(r"ambiguity in calculating the .Median. of the Comb")
agg = {}
for g, name in ((0, "CASPI"), (1, "RewardNet+GS"), (2, "RewardMLE+GS")):
    med_row = T5["Median"][4 * g:4 * g + 4]
    by_comb = median(T5[s][4 * g + 3] for s in SEEDS)
    by_part = (med_row[0] + med_row[1]) * 0.5 + med_row[2]
    print(f"  {name}：逐種子組合後取中位數 {by_comb:.2f}（表上 {med_row[3]:.2f}）；分項取中位數再組合 "
          f"({med_row[0]:.2f} + {med_row[1]:.2f}) × 0.5 + {med_row[2]:.2f} = {by_part:.3f}；差 {by_comb - by_part:+.3f}")
    agg[name] = (mean(T5[s][4 * g + 3] for s in SEEDS), by_comb, by_part)
    if name == "CASPI":
        ok["E"] = abs(by_comb - 105.03) < 1e-9 and abs(by_part - 104.795) < 1e-9
print("  三種聚合下兩個變體誰在前：")
for k, lab in ((0, "五種子平均"), (1, "逐種子組合後取中位數"), (2, "分項取中位數再組合")):
    a, b = agg["RewardNet+GS"][k], agg["RewardMLE+GS"][k]
    print(f"    {lab}：RewardNet+GS {a:.3f}、RewardMLE+GS {b:.3f} → {'RewardNet+GS' if a > b else 'RewardMLE+GS'} 在前")
ok["E2"] = agg["RewardNet+GS"][0] > agg["RewardMLE+GS"][0] and agg["RewardNet+GS"][1] < agg["RewardMLE+GS"][1] \
    and agg["RewardNet+GS"][2] > agg["RewardMLE+GS"][2]

print("\n逐項：", ", ".join(f"{k}={'通過' if v else '不符'}" for k, v in ok.items()))
if all(ok.values()):
    print("結論：證實。對 CASPI 的同種子領先在 MultiWOZ 2.0 上過了 df=4 的配對 t 門檻，移植到 GALAXY 與 MultiWOZ 2.1 都沒過；"
          "變體之間的差距小於單一變體的種子標準差；CASPI 的中位數依兩種算法分別是 105.03 與 104.795，"
          "兩個變體的先後也隨平均或兩種中位數而對調。")
else:
    print("結論：部分不符，見上方逐項。")
