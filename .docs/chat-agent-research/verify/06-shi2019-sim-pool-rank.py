#!/usr/bin/env python3
"""驗證：1909.01388（Shi 等，How to Build User Simulators to Train RL-based Dialog Systems）裡，
「模擬器上的分數」能不能排出真人的名次，以及模擬器本身的直接指標和下游真人結果的關係。

主張（精讀筆記 notes/1909.01388.json，key_results 與 limitations_observed；論文本身只比對了第一名）：
  a. 在自家訓練模擬器上量到的 Auto Success 與真人 Solved Ratio 的名次幾乎無關（筆記自算 Spearman 0.14、對 Satisfaction 0.31）。
  b. 6 個模擬器的交叉平均成功率與 Solved Ratio 的 Spearman 0.83（筆記寫 p≈0.04）、與 Satisfaction 0.94（p≈0.005），筆記沒寫用哪種檢定；
     排除各系統自家模擬器那一格後不變。
  c. 只用 3 個 Agenda 模擬器取平均，對 Solved Ratio 仍是 0.83；只用 3 個 SL 模擬器只剩 0.37。
  d. 論文：「對角線通常最高」；筆記：6 列中只有 3 列的對角線是該列最大。
  e. 論文用來說明「固定一個模擬器會排錯」的例子（SLR 模擬器下 Sys-SLT 0.975 對 Sys-AgenG 0.965）在每格 200 段下 z 約 0.59。
  f. 人讀模擬對話給模擬器的 Overall（Hu.All）與用它訓出的系統在真人面前的 Solved Ratio，Spearman 約 −0.09。
  g. 論文：PPL 與 Hu.Div 相關 0.95（p=0.003）、與 Hu.Fl 相關 −0.21；筆記：PPL 與 Hu.Div 的 Spearman 只有 0.77，
     用表上平均算 PPL 與 Hu.Fl 的 Pearson 約 −0.03。
出處：[arXiv:1909.01388]

輸入（全部由程式從 .cache/text/1909.01388.txt 解析，不手抄）：
  - Table 1：6 個模擬器的 PPL、Vocab、Utt、Hu.Fl、Hu.Co、Hu.Go、Hu.Div、Hu.All。
  - Table 2：6 個 RL 系統的 Solved Ratio、Satisfaction、…、Auto Success（附 95% 信賴區間）。
  - Table 3：6 個模擬器 × 6 個系統的交叉成功率（每格 200 段），以及論文自己算的 Average 列。
  - 正文：每個系統 100 位 Turker、對角線那句、SLR 的例子、PPL 相關係數。

方法：
  1. Spearman 用名次差平方和；精確 p 列舉 6! = 720 個排列：單尾是 ρ 不小於觀察值的比例，雙尾是 |ρ| 不小於 |觀察值| 的比例。
     另外列出常見的 t 分布近似（t = ρ × √(n − 2) ÷ √(1 − ρ²)，自由度 n − 2 = 4，雙尾），用來判斷筆記的 p 是哪一種算法；
     自由度 4 的雙尾 p 有封閉式 1 − √(1 − x) × (1 + x ÷ 2)，其中 x = 4 ÷ (4 + t²)。
     Kendall τ 一併列出。表上沒有同分（Average 列除外，不影響名次）。
  2. 交叉平均由程式從 Table 3 逐欄重算，再和論文的 Average 列比對；「排除自家模擬器」是每欄拿掉對角那一格再平均。
  3. 對角線：同時看「列內」（固定模擬器、比 6 個系統）與「欄內」（固定系統、比 6 個模擬器）兩種讀法。
  4. 兩比例 z 檢定把每格 200 段當獨立樣本，沒有計入訓練隨機性，所以是證據強度的上限。

只用標準函式庫；沒有隨機數。執行：python3 verify/06-shi2019-sim-pool-rank.py（研究根目錄）
"""

import math
import os
import re
from itertools import combinations, permutations

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "..", ".cache", "text", "1909.01388.txt")
L = open(PATH, encoding="utf-8").read().split("\n")


def find_line(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(L)):
        if rx.search(L[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def blocks(a, b):
    out, cur = [], []
    for i in range(a, b):
        s = L[i].strip()
        if s:
            cur.append((i, s))
        elif cur:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


NUM = lambda s: float(s.split()[0])
SIMS = ["AgenT", "AgenR", "AgenG", "SLT", "SLR", "SLE"]
AGENDA, SL = SIMS[:3], SIMS[3:]

# ---------------- Table 1 ----------------
h1 = find_line(r"^Simulators$")
c1 = find_line(r"^Table 1: Automatic metrics and human evaluation scores", h1)
hdr1 = [s for _, s in blocks(h1, c1)[0]]
assert hdr1 == ["Simulators", "NLU", "DM", "NLG", "PPL", "Vocab", "Utt", "Hu.Fl", "Hu.Co", "Hu.Go", "Hu.Div", "Hu.All"], hdr1
T1 = {}
for b in blocks(h1, c1)[1:]:
    # Agenda 列有 NLU／DM／NLG 三格標籤，SL 列只有兩格、SLE 一格（PDF 合併儲存格），所以取最後 8 格數字
    m = re.search(r"\((\w+)\)$", b[0][1])
    if m and len(b) >= 10:
        T1[m.group(1)] = dict(zip(hdr1[4:], [float(s) for _, s in b[-8:]]))
assert list(T1) == SIMS, list(T1)
print(f"Table 1（第 {h1 + 1}–{c1 + 1} 行）：")
for k in SIMS:
    print(f"    {k:6s} PPL {T1[k]['PPL']:6.2f}  Hu.Fl {T1[k]['Hu.Fl']:.2f}  Hu.Div {T1[k]['Hu.Div']:.1f}  Hu.All {T1[k]['Hu.All']:.2f}")

# ---------------- Table 2 ----------------
h2 = find_line(r"^RL System$")
c2 = find_line(r"^Table 2: Human evaluation of RL systems", h2)
assert "95% confidence intervals" in L[c2]
hdr2 = [s for _, s in blocks(h2, c2)[0]]
assert hdr2 == ["RL System", "Solved Ratio", "Satisfaction", "Efficiency", "Naturalness", "Rule-likeness", "Dialog Length", "Auto Success"], hdr2
T2, CI = {}, {}
for b in blocks(h2, c2)[1:]:
    if b[0][1].startswith("Sys-") and len(b) == 8:
        k = b[0][1][4:]
        T2[k] = dict(zip(hdr2[1:], [NUM(s) for _, s in b[1:]]))
        CI[k] = float(re.search(r"\\pm\s*([\d.]+)", b[1][1]).group(1))
assert list(T2) == SIMS, list(T2)
l100 = find_line(r"tested on 100 Turkers")
print(f"\nTable 2（第 {h2 + 1}–{c2 + 1} 行，caption 註明 95% 信賴區間；第 {l100 + 1} 行：每個系統 100 位 Turker）：")
for k in SIMS:
    print(f"    Sys-{k:6s} Solved {T2[k]['Solved Ratio']:.3f}±{CI[k]:.2f}  Satisfaction {T2[k]['Satisfaction']:.2f}  Auto Success {T2[k]['Auto Success']:.3f}")

# ---------------- Table 3 ----------------
h3 = find_line(r"^Usr\\Sys$")
c3 = find_line(r"^Table 3: Cross study results", h3)
cap3 = L[c3] + " " + L[c3 + 1]
assert "Each row represents one user simulator, each column represents one RL system" in cap3 and "200 times" in cap3
cols = [s[4:] for _, s in blocks(h3, c3)[0][1:]]
assert cols == SIMS, cols
X, AVG = {}, None
for b in blocks(h3, c3)[1:]:
    vals = [float(s) for _, s in b[1:]]
    if b[0][1] == "Average":
        AVG = dict(zip(SIMS, vals))
    else:
        X[b[0][1]] = dict(zip(SIMS, vals))
assert list(X) == SIMS and AVG
print(f"\nTable 3（第 {h3 + 1}–{c3 + 2} 行；列＝模擬器、欄＝系統，每格 200 段）：")
for u in SIMS:
    print(f"    {u:6s} " + "  ".join(f"{X[u][s]:.3f}" for s in SIMS))
print(f"    論文 Average " + "  ".join(f"{AVG[s]:.3f}" for s in SIMS))


def colmean(rows, drop_own=False):
    out = {}
    for s in SIMS:
        v = [X[u][s] for u in rows if not (drop_own and u == s)]
        out[s] = sum(v) / len(v)
    return out


cross = colmean(SIMS)
off = [s for s in SIMS if f"{cross[s]:.3f}" != f"{AVG[s]:.3f}"]
for s in SIMS:
    assert abs(cross[s] - AVG[s]) < 0.001, (s, cross[s], AVG[s])
print("  程式重算各欄平均：" + "、".join(f"{s} {cross[s]:.4f}" for s in SIMS)
      + f"（與論文 Average 列的差都在 0.001 以內；四捨五入到三位後不同的欄：{off or '無'}，不影響名次）")
assert sorted(SIMS, key=lambda s: -cross[s]) == sorted(SIMS, key=lambda s: -AVG[s])


# ---------------- 名次統計 ----------------
def ranks(v):
    order = sorted(range(len(v)), key=lambda i: -v[i])
    r = [0] * len(v)
    for k, i in enumerate(order):
        r[i] = k + 1
    return r


def spearman_exact(xs, ys):
    n = len(xs)
    rx, ry = ranks(xs), ranks(ys)
    d2 = sum((a - b) ** 2 for a, b in zip(rx, ry))
    rho = 1 - 6 * d2 / (n * (n * n - 1))
    ge = two = 0
    tot = 0
    for p in permutations(range(1, n + 1)):
        dd = sum((a - b) ** 2 for a, b in zip(rx, p))
        r = 1 - 6 * dd / (n * (n * n - 1))
        tot += 1
        ge += r >= rho - 1e-12
        two += abs(r) >= abs(rho) - 1e-12
    return rho, d2, ge, two, tot


def t_approx_p(rho, n=6):
    # Spearman 的 t 分布近似，自由度 n − 2；這裡 n = 6，自由度 4 的雙尾 p 用封閉式
    assert n == 6
    t = rho * math.sqrt(n - 2) / math.sqrt(1 - rho * rho)
    x = 4 / (4 + t * t)
    return 1 - math.sqrt(1 - x) * (1 + x / 2)


def kendall(xs, ys):
    c = d = 0
    for i, j in combinations(range(len(xs)), 2):
        s = (xs[i] - xs[j]) * (ys[i] - ys[j])
        c += s > 0
        d += s < 0
    return (c - d) / (len(xs) * (len(xs) - 1) // 2), d


def disc_pairs(xs, ys):
    return [(SIMS[i], SIMS[j]) for i, j in combinations(range(len(xs)), 2) if (xs[i] - xs[j]) * (ys[i] - ys[j]) < 0]


R = {}


def rep(label, xs, ys, claim=None):
    rho, d2, ge, two, tot = spearman_exact(xs, ys)
    tau, d = kendall(xs, ys)
    tp = t_approx_p(rho)
    R[label] = (rho, ge / tot, two / tot, tau, d, tp)
    c = f"；筆記 {claim}" if claim is not None else ""
    print(f"  {label}：Spearman 1 − 6 × {d2} ÷ (6 × 35) = {rho:+.4f}（單尾精確 p = {ge}/{tot} = {ge / tot:.4f}，"
          f"雙尾精確 p = {two}/{tot} = {two / tot:.4f}，t 近似雙尾 p = {tp:.4f}）；Kendall τ = {tau:+.3f}（逆序 {d} 對：{disc_pairs(xs, ys)}）{c}")


solved = [T2[s]["Solved Ratio"] for s in SIMS]
satis = [T2[s]["Satisfaction"] for s in SIMS]
auto = [T2[s]["Auto Success"] for s in SIMS]
print("\n名次比較（6 個系統）：")
rep("Auto Success 對 Solved Ratio", auto, solved, "0.14")
rep("Auto Success 對 Satisfaction", auto, satis, "0.31")
rep("交叉平均（6 個模擬器）對 Solved Ratio", [cross[s] for s in SIMS], solved, "0.83（p≈0.04）")
rep("交叉平均（6 個模擬器）對 Satisfaction", [cross[s] for s in SIMS], satis, "0.94（p≈0.005）")
own = colmean(SIMS, drop_own=True)
rep("交叉平均（排除自家模擬器）對 Solved Ratio", [own[s] for s in SIMS], solved, "0.83")
rep("交叉平均（排除自家模擬器）對 Satisfaction", [own[s] for s in SIMS], satis, "0.94")
ag, sl = colmean(AGENDA), colmean(SL)
print("  3 個 Agenda 模擬器平均：" + "、".join(f"{s} {ag[s]:.4f}" for s in SIMS))
print("  3 個 SL 模擬器平均：" + "、".join(f"{s} {sl[s]:.4f}" for s in SIMS))
rep("只用 3 個 Agenda 模擬器 對 Solved Ratio", [ag[s] for s in SIMS], solved, "0.83")
rep("只用 3 個 SL 模擬器 對 Solved Ratio", [sl[s] for s in SIMS], solved, "0.37")
hu = [T1[s]["Hu.All"] for s in SIMS]
rep("模擬器 Hu.All（人讀模擬對話）對 用它訓出的系統的 Solved Ratio", hu, solved, "約 −0.09")

print("\n  逆序的兩對在真人端是否分得開（95% 信賴區間是否重疊）：")
for a, b in disc_pairs([cross[s] for s in SIMS], solved):
    lo_a, hi_a = T2[a]["Solved Ratio"] - CI[a], T2[a]["Solved Ratio"] + CI[a]
    lo_b, hi_b = T2[b]["Solved Ratio"] - CI[b], T2[b]["Solved Ratio"] + CI[b]
    ov = not (hi_a < lo_b or hi_b < lo_a)
    print(f"    {a} {T2[a]['Solved Ratio']:.3f}±{CI[a]:.2f} 對 {b} {T2[b]['Solved Ratio']:.3f}±{CI[b]:.2f}：{'重疊' if ov else '不重疊'}")
top2 = sorted(SIMS, key=lambda s: -T2[s]["Solved Ratio"])[:2]
print(f"    真人第一、二名 {top2[0]} {T2[top2[0]]['Solved Ratio']:.3f} 對 {top2[1]} {T2[top2[1]]['Solved Ratio']:.3f}，"
      f"差 {T2[top2[0]]['Solved Ratio'] - T2[top2[1]]['Solved Ratio']:.3f}")

# ---------------- 對角線 ----------------
l_diag = find_line(r"The diagonal in the table is usually the highest")
print(f"\n對角線（第 {l_diag + 1} 行：論文說對角線通常最高）：")
row_max = col_max = 0
for s in SIMS:
    row = sorted((X[s][t] for t in SIMS), reverse=True)
    col = sorted((X[u][s] for u in SIMS), reverse=True)
    d = X[s][s]
    rr = 1 + sum(v > d for v in row)
    cr = 1 + sum(v > d for v in col)
    row_max += rr == 1
    col_max += cr == 1
    print(f"    {s:6s} 對角 {d:.3f}：在該列（固定模擬器、比 6 個系統）排第 {rr}；在該欄（固定系統、比 6 個模擬器）排第 {cr}")
print(f"  對角是該列最大的有 {row_max}/6 列；是該欄最大的有 {col_max}/6 欄")
ag_on_sl = [X[u][s] for u in AGENDA for s in SL]
sl_on_all = [X[u][s] for u in SL for s in SIMS]
print(f"  Agenda 模擬器測 SL 系統的 9 格介於 {min(ag_on_sl):.3f} 到 {max(ag_on_sl):.3f}；SL 模擬器測全部系統的 18 格介於 {min(sl_on_all):.3f} 到 {max(sl_on_all):.3f}")

# ---------------- SLR 的例子 ----------------
l_slr = find_line(r"prefer Sys-SLT \(0\.975\) over Sys-AgenG \(0\.965\)")
p1, p2, n = X["SLR"]["SLT"], X["SLR"]["AgenG"], 200
se = math.sqrt(p1 * (1 - p1) / n + p2 * (1 - p2) / n)
z = (p1 - p2) / se
pz = math.erfc(abs(z) / math.sqrt(2))
print(f"\nSLR 的例子（第 {l_slr + 1} 行）：Sys-SLT {p1} 對 Sys-AgenG {p2}，每格 {n} 段；"
      f"差值的標準誤 {se:.4f}，z = {z:.3f}，雙尾 p = {pz:.2f}；交叉平均則是 AgenG {cross['AgenG']:.3f} 對 SLT {cross['SLT']:.3f}")


# ---------------- PPL 相關 ----------------
def pearson(a, b):
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    return cov / math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))


l_ppl = find_line(r"\$-0\.21\$ with \$p>0\.05\$ and \$0\.95\$ with \$p=0\.003\$")
ppl = [T1[s]["PPL"] for s in SIMS]
div = [T1[s]["Hu.Div"] for s in SIMS]
flu = [T1[s]["Hu.Fl"] for s in SIMS]
rs_div = spearman_exact(ppl, div)
print(f"\nPPL 相關（第 {l_ppl + 1} 行：論文報 Hu.Fl −0.21、Hu.Div 0.95）：")
print(f"  用 Table 1 的平均重算 Pearson：PPL 對 Hu.Div {pearson(ppl, div):+.3f}、PPL 對 Hu.Fl {pearson(ppl, flu):+.3f}")
print(f"  Spearman：PPL 對 Hu.Div {rs_div[0]:+.4f}（雙尾精確 p = {rs_div[3]}/{rs_div[4]} = {rs_div[3] / rs_div[4]:.3f}，"
      f"t 近似雙尾 p = {t_approx_p(rs_div[0]):.3f}；筆記 0.77（p≈0.07））")
print("  PPL 由高到低：" + "、".join(f"{s} {T1[s]['PPL']}" for s in sorted(SIMS, key=lambda s: -T1[s]['PPL'])))
print(f"  兩個真人指標彼此：Solved Ratio 對 Satisfaction 的 Pearson {pearson(solved, satis):+.3f}（筆記約 0.96）")

# ---------------- 結論 ----------------
a_s = R["Auto Success 對 Solved Ratio"]
c_s = R["交叉平均（6 個模擬器）對 Solved Ratio"]
c_t = R["交叉平均（6 個模擬器）對 Satisfaction"]
s_s = R["只用 3 個 SL 模擬器 對 Solved Ratio"]
h_s = R["模擬器 Hu.All（人讀模擬對話）對 用它訓出的系統的 Solved Ratio"]
print(f"\n結論：筆記自算的相關係數全部重現（Auto Success 對 Solved {a_s[0]:+.2f}、交叉平均對 Solved {c_s[0]:+.2f}、對 Satisfaction {c_t[0]:+.2f}、"
      f"只用 SL 模擬器 {s_s[0]:+.2f}、Hu.All 對 Solved {h_s[0]:+.2f}）；筆記的 p≈0.04、p≈0.005 與 t 分布近似（自由度 4）的雙尾 {c_s[5]:.3f}、{c_t[5]:.4f} 吻合，"
      f"是近似法不是算錯；n = 6 時較站得住的精確排列檢定，交叉平均對 Solved Ratio 單尾 {c_s[1]:.3f}、雙尾 {c_s[2]:.3f}（雙尾跨過 0.05），"
      f"兩對逆序都落在真人 95% 信賴區間重疊的範圍；對 Satisfaction 單尾 {c_t[1]:.4f}、雙尾 {c_t[2]:.4f}。"
      f"對角線是該列最大的只有 {row_max}/6 列、是該欄最大的只有 {col_max}/6 欄，「通常最高」誇大；SLR 例子的 z = {z:.2f}，翻轉在雜訊內。")
