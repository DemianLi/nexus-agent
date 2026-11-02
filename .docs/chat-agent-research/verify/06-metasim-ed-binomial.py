#!/usr/bin/env python3
"""驗證：MetaSim 的 ExactDistinct（ED）在 MultiWOZ 以外幾乎沒有鑑別力。

主張：
  筆記版：三個變體完全排對的隨機機率約 1/6≈16.7%，Agenda 的 16.9–19.5 等於隨機；
  MetaSim 在 ReDial（17.48／20.61／20.43）與 JDDC（19.17／17.47）只比隨機高 1–4 個百分點，
  全文沒做顯著性檢定。
  章節修正版（06-user-simulator-feedback.md 第 195 行）：假設每格 1K 組偏好彼此獨立、沒有平手，
  標準誤約 1.18 個百分點；20.61、20.43 超過 3 個標準誤，19.17 約 2.1 個，17.48、17.47 不顯著；
  五格中三格高於隨機（未做多重比較校正），但幅度都在 4 個百分點以內。
  另查：筆記的 Agenda「16.9–19.5」只涵蓋 MultiWOZ；Agenda 在 JDDC 的 T_C／T_D 是 13.76／14.52，
  低於 1/6，要算下尾機率。
出處：[arXiv:2204.00763] 精讀筆記 notes/2204.00763.json 的 limitations_observed 第 2 條。

輸入從哪來（全部由程式直接從 .cache/text/2204.00763.txt 解析，不手抄）：
  - 「Table 4. Results of tester-based evaluation」caption 之後到「### 6.2」之間的表格
    （這篇的 caption 在表格之前）：Agenda／Seq2seq／MetaSim／Human 四列、八欄。
  - §6.2 正文：「scored 1 ... otherwise scored as 0」「repeated the testing on 1K different preferences」
    「If the scoring of the two system variants is the same, we further distinguish them by the number
    of dialogue turns」。
  - 全文的 t-test／p-value 字樣：用來判定「全文沒做顯著性檢定」的範圍。

方法：
  1. 解析 ED 表，檢查每格 ×10 是不是整數：1K 組 0／1 的平均只能是 0.1% 的倍數。
  2. 在「每格 n=1000 組獨立、沒有平手、虛無假設下六種排序等機率」的假設下，
     p0 = 1/6，標準誤 = sqrt(p0(1−p0)/1000)。
  3. 每格成功次數 = ED% × 10 不是整數，所以 floor 與 ceil 兩個 k 都算精確二項尾機率
     （math.comb 整數運算，沒有近似）：高於 1/6 算上尾 P(X ≥ k)，低於 1/6 算下尾 P(X ≤ k)。
  4. MetaSim 在 ReDial／JDDC 的五格：未校正、Bonferroni、Holm 三種判定（單尾 α=0.05，
     取 floor／ceil 中較保守的 p）。
  5. 敏感度：若有效樣本數不是 1000，17.48 與 17.47 要多大的 n 才會達到單尾 0.05。
  6. 檢查 Table 4 區塊裡有沒有 * 或 signific，並列出全文其他有做檢定的地方。

只用標準函式庫；沒有隨機數。執行：python3 06-metasim-ed-binomial.py
"""

import math
import os
import re
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "2204.00763.txt")

with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")


def find_line(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(LINES)):
        if rx.search(LINES[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def blocks_between(a, b):
    rows, cur = [], []
    for i in range(a, b):
        s = LINES[i]
        if s.startswith("| "):
            cur.append(s[2:].strip())
        elif s.strip() == "":
            if cur:
                rows.append(cur)
                cur = []
    if cur:
        rows.append(cur)
    return rows


N = 1000
P0 = Fraction(1, 6)
DEN = 6 ** N
# 預先算好每個 k 的機率分子：C(N,k)·5^(N−k)，分母 6^N
PMF_NUM = [math.comb(N, k) * 5 ** (N - k) for k in range(N + 1)]


def upper_tail(k):
    return sum(PMF_NUM[k:]) / DEN


def lower_tail(k):
    return sum(PMF_NUM[: k + 1]) / DEN


SE = math.sqrt(float(P0) * (1 - float(P0)) / N) * 100  # 以百分點計

# ---- 解析 Table 4 ----
t4 = find_line(r"^Table 4\. Results of tester-based evaluation")
s62 = find_line(r"^### 6\.2\. Tester-based evaluation", t4)
rows = blocks_between(t4 + 1, s62)
ds_row = [r for r in rows if r[0] == "Datasets"][0]
tester_row = [r for r in rows if r[0] == "Tester"][0]
testers = [re.search(r"_\{([A-Z])\}", c).group(1) for c in tester_row[1:]]
assert ds_row[1:] == ["MultiWOZ", "ReDial", "JDDC"] and testers == list("CRDCRDCD"), (ds_row, testers)
cols = [f"{d}/T_{t}" for d, t in zip(["MultiWOZ"] * 3 + ["ReDial"] * 3 + ["JDDC"] * 2, testers)]
ED = {}
for r in rows:
    if r[0] in ("Agenda", "Seq2seq", "MetaSim", "Human"):
        ED[r[0]] = [None if c in ("–", "-") else float(c) for c in r[1:]]
        assert len(ED[r[0]]) == 8
print(f"ED 表（第 {t4 + 1}–{s62} 行；caption 在表格之前）欄位：{cols}")
for k, v in ED.items():
    print(f"  {k:8s} {v}")

l_score = find_line(r"scored 1 on ExactDistinct if the order given by the simulator is")
l_1k = find_line(r"repeated the testing on 1K different preferences")
l_tie = find_line(r"If the scoring of the two system variants is the same")
print(f"  第 {l_score + 1}–{l_score + 2} 行：每組偏好 0／1 計分；第 {l_1k + 1} 行：1K 組偏好取平均；"
      f"第 {l_tie + 1} 行：同分時以輪數少者為佳（平手另有規則，不一定剩下純隨機）")

# ---- (1) 報告精度與 n=1000 相不相容 ----
print("\n(1) 1K 組 0／1 的平均只能是 0.1% 的倍數；檢查三個模擬器每格 ×10 是否為整數")
print("    （Human 列來自 40 位標註者，不是 1K 組偏好，不列入）")
SIMS = ("Agenda", "Seq2seq", "MetaSim")
nonint = []
for k in SIMS:
    for c, x in zip(cols, ED[k]):
        cnt = x * 10
        if abs(cnt - round(cnt)) > 1e-6:
            nonint.append((k, c, x))
total = sum(len(ED[k]) for k in SIMS)
print(f"  {total} 個數值裡有 {len(nonint)} 個 ×10 不是整數（例如 MetaSim ReDial/T_C 17.48 → 174.8 次）")
print("  → 表上的兩位小數不可能來自單一次 1000 組的 0／1 平均；實際樣本數或平均方式論文沒寫清楚，"
      "以下 n=1000 的檢定是條件式的。")

# ---- (2)(3) 逐格二項檢定 ----
print(f"\n(2) 虛無假設 p0 = 1/6 = {float(P0) * 100:.3f}%，n = {N}，標準誤 = {SE:.4f} 個百分點")
print("(3) 逐格精確二項尾機率（k 取 floor／ceil 兩種）")


def cell_test(x):
    cnt = x * 10
    kf, kc = math.floor(cnt + 1e-9), math.ceil(cnt - 1e-9)
    z = (x - float(P0) * 100) / SE
    if x >= float(P0) * 100:
        pf, pc = upper_tail(kf), upper_tail(kc)
        side = "上尾"
    else:
        pf, pc = lower_tail(kf), lower_tail(kc)
        side = "下尾"
    return z, side, kf, kc, pf, pc


RESULTS = {}
for sim in ("Agenda", "Seq2seq", "MetaSim"):
    print(f"  {sim}:")
    for c, x in zip(cols, ED[sim]):
        z, side, kf, kc, pf, pc = cell_test(x)
        RESULTS[(sim, c)] = (x, z, side, kf, kc, pf, pc)
        print(f"    {c:13s} {x:6.2f}  差 {x - float(P0) * 100:+6.2f} 點  z={z:+.2f}  "
              f"{side} P(k={kf})={pf:.2e}  P(k={kc})={pc:.2e}")

# ---- 章節數字核對 ----
print("\n章節數字核對：")
chk = {
    "20.61 超過 3 SE": RESULTS[("MetaSim", "ReDial/T_R")][1] > 3,
    "20.43 超過 3 SE": RESULTS[("MetaSim", "ReDial/T_D")][1] > 3,
    "19.17 約 2.1 SE": abs(RESULTS[("MetaSim", "JDDC/T_C")][1] - 2.1) < 0.05,
    "標準誤約 1.18": abs(SE - 1.18) < 0.005,
}
for k, v in chk.items():
    print(f"  {k}：{v}")

# ---- (4) 多重比較 ----
print("\n(4) MetaSim 在 ReDial／JDDC 五格：單尾 α=0.05，p 取 floor／ceil 較保守者（上尾取 floor 的 k）")
five = [(c, RESULTS[("MetaSim", c)]) for c in cols[3:]]
ps = [(c, max(r[5], r[6]), r[0]) for c, r in five]
m = len(ps)
print(f"  {'格':13s} {'ED':>6s}  {'p':>9s}  未校正  Bonferroni(α/{m}={0.05 / m:.4f})")
for c, p, x in ps:
    print(f"  {c:13s} {x:6.2f}  {p:9.2e}  {'顯著' if p < 0.05 else '不顯著':4s}   {'顯著' if p < 0.05 / m else '不顯著'}")
holm_sorted = sorted(ps, key=lambda t: t[1])
print("  Holm 逐步：")
rejected = 0
stop = False
for i, (c, p, x) in enumerate(holm_sorted):
    thr = 0.05 / (m - i)
    rej = (not stop) and p < thr
    if not rej:
        stop = True
    rejected += rej
    print(f"    第 {i + 1} 小 {c:13s} p={p:.5f}  門檻 {thr:.5f}  {'拒絕虛無' if rej else '停止'}")
n_raw = sum(1 for _, p, _ in ps if p < 0.05)
n_bon = sum(1 for _, p, _ in ps if p < 0.05 / m)
print(f"  → 未校正 {n_raw}／5 格高於隨機；Bonferroni {n_bon}／5；Holm {rejected}／5")
max_gap = max(x - float(P0) * 100 for _, _, x in ps)
print(f"  五格高出隨機的最大幅度 {max_gap:.2f} 個百分點（< 4：{max_gap < 4}）")

# ---- (5) 敏感度 ----
print("\n(5) 敏感度：17.48 與 17.47 要多大的有效 n 才會達到單尾 0.05（常態近似 z ≥ 1.645）")
for c in ("ReDial/T_C", "JDDC/T_D"):
    x = RESULTS[("MetaSim", c)][0] / 100
    d = x - float(P0)
    n_need = (1.6448536 * math.sqrt(float(P0) * (1 - float(P0))) / d) ** 2
    print(f"  {c} {x * 100:.2f}：n ≥ {math.ceil(n_need)}")

# ---- Agenda ----
print("\n(6) Agenda 八格")
for c, x in zip(cols, ED["Agenda"]):
    r = RESULTS[("Agenda", c)]
    tag = "高於隨機" if (r[1] > 0 and max(r[5], r[6]) < 0.05) else ("低於隨機" if (r[1] < 0 and max(r[5], r[6]) < 0.05) else "與隨機分不開")
    print(f"  {c:13s} {x:6.2f}  z={r[1]:+.2f}  單尾 p（保守）={max(r[5], r[6]):.4f}  {tag}")
mw = ED["Agenda"][:3]
print(f"  筆記的「16.9–19.5」= MultiWOZ 三格 {min(mw):.2f}–{max(mw):.2f}；ReDial 三格 "
      f"{min(ED['Agenda'][3:6]):.2f}–{max(ED['Agenda'][3:6]):.2f}；JDDC 兩格 {ED['Agenda'][6]:.2f}／{ED['Agenda'][7]:.2f}")

# ---- (7) 全文有沒有做顯著性檢定 ----
print("\n(7) 顯著性檢定的範圍")
blk = LINES[t4:s62]
has_star = any("*" in s for s in blk)
has_sig = any(re.search(r"signific", s, re.I) for s in blk)
print(f"  ED 表區塊（第 {t4 + 1}–{s62} 行）有 * 標記：{has_star}；有 signific 字樣：{has_sig}")
sig_lines = [i + 1 for i, s in enumerate(LINES) if re.search(r"t-test|p-value|statistically significant", s)]
print(f"  全文提到 t-test／p-value／statistically significant 的行：{sig_lines}")
for i in sig_lines:
    print(f"    第 {i} 行：{LINES[i - 1][:110]}")

print("\n結論：")
print("  - 1/6 ≈ 16.7% 的隨機基準、標準誤 1.18、20.61／20.43 > 3 SE、19.17 ≈ 2.1 SE、17.48／17.47 不顯著：在 n=1000 獨立假設下證實。")
print(f"  - 「五格中三格高於隨機（未校正）」：證實；但 Holm 下剩 {rejected} 格、Bonferroni 下剩 {n_bon} 格。")
min_gap = min(x - float(P0) * 100 for _, _, x in ps)
print(f"  - 筆記「只比隨機高 1–4 個百分點」：幅度證實（{min_gap:.2f}–{max_gap:.2f}）；「幾乎不存在鑑別力」對 ReDial T_R／T_D 說得太滿。")
print("  - 筆記「Agenda 16.9–19.5 等於隨機」：範圍只涵蓋 MultiWOZ；MultiWOZ/T_D 19.47 在同一假設下已高於隨機，"
      "JDDC 兩格則顯著低於隨機（系統性排反），「等於隨機」反而低估了 Agenda 在 JDDC 的問題。")
print("  - 「全文沒做顯著性檢定」：ED 表確實沒做（證實）；但全文其他表有 t-test（Table 2、3、7、8、12），全文範圍的說法推翻。")
print("  - 所有檢定都建立在 n=1000 上，而表上的兩位小數與 n=1000 的 0／1 平均不相容，實際樣本數無法從論文判定。")
