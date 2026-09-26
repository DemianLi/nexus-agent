#!/usr/bin/env python3
"""驗證：1709.06560 在 n=5 對 n=5 時報的 KS p 值是舊版 scipy 的漸近近似，精確檢定下 D=0.8 不顯著。

主張（章節 08-task-completion-score.md 第 370、510 行）：
  1709.06560 在 n=5 對 n=5 時報的 KS p 值只有四種（0.004、0.036、0.209、0.697），這四個值是
  舊版 scipy ks_2samp 的漸近近似；改用精確檢定時 D=0.8 的雙尾 p 是 20/252 ≈ 0.079，所以
  Table 9–12 中 14 格報 KS=0.80、p=0.036 的比較在 0.05 水準下都不顯著。
出處：[arXiv:1709.06560] 精讀筆記 notes/1709.06560.json 的 limitations_observed 第 1 條
  （只有四種 p 值）；「漸近近似」「20/252」「14 格不顯著」是組章時的重算。

輸入從哪來：
  - .cache/text/1709.06560.txt 的 Table 9–12（caption 分別以「Table 9: HalfCheetah」「Table 10:
    Hopper」「Table 11: Walker2d」「Table 12: Swimmer」開頭）：每格的 KS 統計量與 p 值，
    以及列、欄的演算法名稱，程式直接解析。
  - .cache/text/1709.06560.txt 附錄說明 KS 檢定用的是 scipy，並附上 scipy-0.14.0 的 ks_2samp 文件網址。
  - n=5：同一段附錄「from the 5 trials are sorted」。
  - 舊版 scipy（0.14）ks_2samp 的雙尾 p 值公式：en = sqrt(n·m/(n+m))，
    p = Q_KS((en + 0.12 + 0.11/en)·D)，Q_KS(x) = 2 Σ_{k≥1} (−1)^{k−1} exp(−2k²x²)（kstwobign.sf）。
    這是依 scipy 舊版（0.14）原始碼的寫法以純 Python 重寫的，本次沒有取得 0.14 原始碼逐行對照；
    若它能同時重現四個 p 值，而不加修正項的純漸近重現不出，就是證據。

方法：
  1. 解析 Table 9–12 的每一格，得到 (表, 列演算法, 欄演算法, D, p)；以 KS(i,j)=KS(j,i) 做解析自檢。
  2. 精確分佈：把 10 個相異值分給兩組各 5 個，共 C(10,5)=252 種等機率排列，逐一算 D，
     得到雙尾精確 p = P(D ≥ d)。
  3. 用舊版 scipy 公式算 D=0.4、0.6、0.8、1.0 的漸近 p，比對論文的四個值；
     另算不加 Stephens 修正的純漸近 Q_KS(en·D) 當對照，確認吻合不是巧合。
  4. 數 KS=0.80、p=0.036 的格數與不重複的演算法配對數，判斷在 0.05 水準下的顯著性。
  5. 掃全文有沒有宣告顯著水準。

只用標準函式庫；沒有隨機數。執行：python3 08-ks-small-sample-pvalue.py
"""

import itertools
import math
import os
import re
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TEXT = os.path.join(ROOT, ".cache", "text", "1709.06560.txt")

with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")


def find_line(pattern, start=0):
    for i in range(start, len(LINES)):
        if re.search(pattern, LINES[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


# ---------------------------------------------------------------- 0. 附錄的檢定設定
i_scipy = find_line(r"scipy-0\.14\.0/reference/generated/scipy\.stats\.ks_2samp")
i_n = find_line(r"from the 5 trials are sorted")
print("== 0. 附錄的檢定設定 ==")
for i in sorted({i_n, i_scipy}):
    print(f"  第 {i + 1} 行：{LINES[i].strip()[:230]}")
N = M = 5

# ---------------------------------------------------------------- 1. 解析 Table 9–12
ALGOS = ("DDPG", "ACKTR", "TRPO", "PPO")
anchor = find_line(r"For power analysis, we attempt to determine")
caps = [find_line(rf"^Table {n}: {env} Significance values")
        for n, env in ((9, "HalfCheetah"), (10, "Hopper"), (11, "Walker2d"), (12, "Swimmer"))]
cells = []  # (table, row, col, D, p)
tp_values = []
missing = []
prev = anchor
for tno, cap in zip((9, 10, 11, 12), caps):
    toks = []
    for ln in range(prev + 1, cap):
        s = LINES[ln].strip()
        if re.fullmatch(r"\| (DDPG|ACKTR|TRPO|PPO)", s):
            toks.append(("label", s[2:]))
        elif s == "| -":
            toks.append(("diag", None))
        else:
            for m in re.finditer(r"\$KS=([\d.]+),p=([\d.]+)\$", s):
                toks.append(("ks", (float(m.group(1)), float(m.group(2)), ln + 1)))
            for m in re.finditer(r"\$t=(-?[\d.]+),p=([\d.]+)\$", s):
                tp_values.append(float(m.group(2)))
    # 表頭：第一個 diag 之後的 4 個 label
    assert toks[0][0] == "diag"
    header = [v for _, v in toks[1:5]]
    assert header == list(ALGOS), header
    row, col, seen = None, 0, {}
    for kind, v in toks[5:]:
        if kind == "label":
            if row is not None and col != 4:
                missing.append((tno, row, header[col:]))
            row, col = v, 0
        elif kind == "diag":
            assert header[col] == row, (tno, row, col)
            col += 1
        else:
            if header[col] == row:  # 對角線應為 "-"
                raise SystemExit(f"Table {tno} 對角線出現數值")
            cells.append((tno, row, header[col], v[0], v[1], v[2]))
            col += 1
    if col != 4:
        missing.append((tno, row, header[col:]))
    prev = cap

print(f"\n== 1. Table 9–12 解析結果 ==")
per_table = Counter(c[0] for c in cells)
print(f"  共 {len(cells)} 格 KS：" + "、".join(f"Table {t} {per_table[t]} 格" for t in (9, 10, 11, 12)))
for tno, row, cols in missing:
    print(f"  Table {tno} 的 {row} 列缺 {cols} 欄（快取全文中那一格是空的）")
ks = {(c[0], c[1], c[2]): (c[3], c[4]) for c in cells}
asym = [(k, ks[k], ks[(k[0], k[2], k[1])]) for k in ks if (k[0], k[2], k[1]) in ks and ks[k] != ks[(k[0], k[2], k[1])]]
print(f"  對稱自檢 KS(i,j)=KS(j,i)：不一致 {len(asym)} 對")
pairs = {(c[0], frozenset((c[1], c[2]))) for c in cells}
print(f"  不重複的（表, 演算法配對）：{len(pairs)} 組（4 表 × 6 對 = 24）")
dp = Counter((c[3], c[4]) for c in cells)
print("  (D, 報告的 p) 出現次數：" + "、".join(f"D={d:.2f}→p={p:.3f}：{n}" for (d, p), n in sorted(dp.items())))
d_to_p = {}
for (d, p) in dp:
    d_to_p.setdefault(d, set()).add(p)
print(f"  每個 D 只對應一個 p：{all(len(v) == 1 for v in d_to_p.values())}；相異 p 值：{sorted({p for _, p in dp})}")

# ---------------------------------------------------------------- 2. 精確分佈
def ks_stat_units(xmask):
    """xmask[i]=1 表示合併排序後第 i 個值屬於 X。回傳 D×5（整數）。"""
    cx = cy = 0
    best = 0
    for b in xmask:
        if b:
            cx += 1
        else:
            cy += 1
        best = max(best, abs(cx - cy))  # n=m=5，|F_x − F_y| = |cx − cy| / 5
    return best


hist = Counter()
for pos in itertools.combinations(range(N + M), N):
    mask = [0] * (N + M)
    for p in pos:
        mask[p] = 1
    hist[ks_stat_units(mask)] += 1
TOT = sum(hist.values())
assert TOT == math.comb(10, 5) == 252
exact = {}
for u in range(1, 6):
    cnt = sum(v for k, v in hist.items() if k >= u)
    exact[u / 5] = (cnt, cnt / TOT)

# ---------------------------------------------------------------- 3. 舊版 scipy 漸近公式
def q_ks(x, terms=100):
    """Kolmogorov 分佈的存活函數（scipy kstwobign.sf）。"""
    if x <= 0:
        return 1.0
    return max(0.0, min(1.0, 2 * sum((-1) ** (k - 1) * math.exp(-2 * k * k * x * x) for k in range(1, terms + 1))))


en = math.sqrt(N * M / (N + M))


def p_scipy014(d):
    return q_ks((en + 0.12 + 0.11 / en) * d)


def p_plain_asymp(d):
    return q_ks(en * d)


print(f"\n== 2–3. 精確 p 與漸近 p（n=m=5，252 種排列）==")
print(f"  {'D':>4}{'論文報的 p':>10}{'舊 scipy 漸近':>14}{'純漸近 Q(en·D)':>16}{'精確 P(D≥d)':>16}")
reported = {d: min(ps) for d, ps in d_to_p.items()}
all_match = True
for d in (0.2, 0.4, 0.6, 0.8, 1.0):
    cnt, pe = exact[d]
    rep = reported.get(d)
    ps = p_scipy014(d)
    if rep is not None:
        all_match &= round(ps, 3) == rep
    rep_s = f"{rep:.3f}" if rep is not None else "—"
    print(f"  {d:>4.1f}{rep_s:>10}{ps:>14.4f}{p_plain_asymp(d):>16.4f}{f'{cnt}/252={pe:.4f}':>16}")
print(f"  論文出現的四個 p 值全由舊 scipy 公式四捨五入到三位重現：{all_match}")
print(f"  D=0.8 精確雙尾 p = {exact[0.8][0]}/252 = {exact[0.8][1]:.4f}（章節寫 20/252≈0.079：{exact[0.8][0] == 20}）")
print(f"  D=1.0 精確雙尾 p = {exact[1.0][0]}/252 = {exact[1.0][1]:.4f}（n=m=5 能得到的最小 p）")

# ---------------------------------------------------------------- 4. 顯著性
c08 = [c for c in cells if c[3] == 0.80 and c[4] == 0.036]
pairs08 = sorted({(c[0], tuple(sorted((c[1], c[2])))) for c in c08})
per_pair = Counter((c[0], tuple(sorted((c[1], c[2])))) for c in c08)
assert all(v == 2 for v in per_pair.values()), per_pair
print(f"\n== 4. KS=0.80、p=0.036 的格子 ==")
print(f"  格數 {len(c08)}（章節寫 14：{len(c08) == 14}）；不重複的演算法配對 {len(pairs08)} 組：")
for t, pr in pairs08:
    print(f"    Table {t}：{pr[0]} vs {pr[1]}")
print(f"  t 檢定的 p 值裡有沒有 0.036：{0.036 in tp_values}（確認上面數的是 KS 格）")
alpha = 0.05
print(f"  在 α={alpha}：報告的 0.036 < α；精確 {exact[0.8][1]:.4f} > α → 這 {len(c08)} 格（{len(pairs08)} 組比較）全部不顯著")
c10 = [c for c in cells if c[3] == 1.00]
print(f"  對照：D=1.00 的 {len(c10)} 格，報告 0.004、精確 {exact[1.0][1]:.4f}，在 α=0.05 仍顯著")

# ---------------------------------------------------------------- 5. 顯著水準宣告
print("\n== 5. 全文有沒有宣告顯著水準 ==")
pat = r"\b0\.05\b|\b0\.01\b|significance level|\\alpha\b|α|p\s*<\s*0?\."
hits = [(i + 1, s) for i, s in enumerate(LINES) if re.search(pat, s, re.I)]
ctrl = [(i + 1) for i, s in enumerate(LINES) if re.search(r"95\s*%", s)]
print(f"  樣式 /{pat}/ 命中 {len(hits)} 行（逐條印出上下文，人工判讀是否為顯著水準）：")
for ln, s in hits:
    m = re.search(pat, s, re.I)
    a = max(0, m.start() - 70)
    print(f"    第 {ln} 行：…{s[a:m.end() + 20].strip()}…")
print(f"  正向對照 /95\\s*%/ 命中 {len(ctrl)} 行（掃描器看得到數字與百分比）")

print("\n== 結論 ==")
print("  四種 p 值 0.004／0.036／0.209／0.697 與 scipy 0.14 的漸近公式逐一吻合，而附錄引的正是 0.14 的文件；")
print(f"  精確檢定 D=0.8 的雙尾 p = 20/252 = {exact[0.8][1]:.4f}，D=1.0 是 2/252 = {exact[1.0][1]:.4f}。")
print(f"  Table 9–12 報 KS=0.80、p=0.036 的共 {len(c08)} 格；每對演算法在矩陣裡正反各出現一次，"
      f"所以是 {len(pairs08)} 組不重複比較，改用精確檢定後在 0.05 水準下都不顯著。")
