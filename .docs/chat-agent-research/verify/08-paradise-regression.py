#!/usr/bin/env python3
"""驗證：PARADISE 示範迴歸的幾個數字，以及精讀筆記對它的三個重算。

主張（章節 08-task-completion-score.md 多目標一節的 PARADISE 段、陷阱六、爭議第四條）：
  A. 論文 §2.4 的 Performance = .40·N(κ) − .78·N(c2)，只有在應變數 US 也換成 Z 分數時才重現；
     用原始 US 迴歸，係數是另一組。精讀筆記的缺點清單只寫 0.714／−1.386，那是預測變數用母體標準差
     Z 化的值；與論文一致的樣本標準差下是 0.737／−1.432（筆記的重做備註兩組都列了）。
  B. 論文報的其他數字照 Table 5 重算都重現：c1 平均 38.6、σ 18.9、user 5 的 N(c1) = −0.83、
     user 11 的 N(c1) = −1.51；#utt 與 #rep 的相關 0.91；第二次迴歸 R² = 92%、κ p < .0003、
     #rep p < .0001；第一次迴歸只有 κ 與 #rep 顯著（p < .02）；Performance 平均 A = −.44、B = .44；
     t test p < .07。
  C. Table 5 的逐段 κ（1、.46、.19）等於用全域 P(E) = 0.079 對 4/4、2/4、1/4 個屬性正確做的轉換
     （精讀筆記的推算，論文沒有明說）。
  D. §2.5 的子對話正規化只有 A、B 兩個策略，N(κ) 必然是 ±1/√2 ≈ ±0.707，與兩者的 κ 差多少無關；
     由平均 .515 與 κ_A = .70 反推 κ_B，再算樣本標準差，應得論文的 .261。
  E. §2.5 的兩個 Performance：.40×.71 − .78×.72 = −0.28；B 的 N(c2) = (1.38 − 4)/2.79 ≈ −.94，
     .40×(−.71) − .78×(−.94) = 0.45。c2 的參考平均 4 不是 A、B 兩者 6 與 1.38 的平均。
出處：[arXiv:cmp-lg/9704004] 全文 §2.2、§2.4（Table 5）、§2.5。

方法：從 .cache/text/cmp-lg_9704004.txt 解析 Table 5 的 16 列與內文數字；Z 分數預設用樣本標準差
  （statistics.stdev，論文的 σ 18.9 就是樣本標準差）。A 另外用母體標準差（statistics.pstdev）
  把預測變數重新 Z 化、真的再跑一次迴歸，四種組合都算：預測變數 {樣本 σ, 母體 σ} × 應變數
  {原始 US, Z 化 US}（應變數 Z 化時與預測變數同口徑）。√(15/16) 的換算只當交叉核對。
  OLS 用正規方程式加高斯消去；t 分布的雙尾 p 值用正則化不完全 beta 函數的連分式
  （Numerical Recipes 的 betacf）。
只用標準函式庫；沒有隨機數。執行：python3 verify/08-paradise-regression.py
"""

import math
import os
import re
from statistics import mean, pstdev, stdev

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
PATH = os.path.join(ROOT, ".cache", "text", "cmp-lg_9704004.txt")

with open(PATH, encoding="utf-8") as f:
    TEXT = f.read()
L = TEXT.split("\n")


def find(pat, start=0):
    for i in range(start, len(L)):
        if re.search(pat, L[i]):
            return i
    raise SystemExit("找不到：" + pat)


# ---------------------------------------------------------------- 解析 Table 5
cap = find(r"^Table 5: Hypothetical performance data")
flat = " ".join(L[max(0, cap - 200):cap])
rows = re.findall(r"\|\s*(\d+)\s*\|\s*([AB])\s*\|\s*(\d+)\s*\|\s*([\d.]+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)\s*(?=\|)", flat)
rows = [(int(u), a, float(us), float(k), float(ut), float(rp)) for u, a, us, k, ut, rp in rows]
rows = sorted({r[0]: r for r in rows}.values())
assert [r[0] for r in rows] == list(range(1, 17)), rows
print(f"Table 5（原文第 {cap + 1} 行之前）解析到 {len(rows)} 列：user, agent, US, κ, #utt, #rep")
for r in rows:
    print("  ", r)
user = [r[0] for r in rows]
agent = [r[1] for r in rows]
US = [r[2] for r in rows]
K = [r[3] for r in rows]
UTT = [r[4] for r in rows]
REP = [r[5] for r in rows]


def z(xs, sd=stdev):
    m, s = mean(xs), sd(xs)
    return [(x - m) / s for x in xs], m, s


# ---------------------------------------------------------------- 統計工具
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
    """t 分布雙尾 p 值。"""
    return betai(df / 2, 0.5, df / (df + t * t))


def solve(A, b):
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                M[r] = [M[r][j] - f * M[c][j] for j in range(n + 1)]
    return [M[i][n] / M[i][i] for i in range(n)]


def inv(A):
    n = len(A)
    cols = [solve(A, [1.0 if i == j else 0.0 for i in range(n)]) for j in range(n)]
    return [[cols[j][i] for j in range(n)] for i in range(n)]


def ols(y, xs):
    """y ~ 1 + xs；回傳係數、標準誤、t、p、R²。"""
    n, k = len(y), len(xs) + 1
    X = [[1.0] + [x[i] for x in xs] for i in range(n)]
    XtX = [[sum(X[r][i] * X[r][j] for r in range(n)) for j in range(k)] for i in range(k)]
    Xty = [sum(X[r][i] * y[r] for r in range(n)) for i in range(k)]
    beta = solve(XtX, Xty)
    fit = [sum(beta[j] * X[r][j] for j in range(k)) for r in range(n)]
    sse = sum((y[r] - fit[r]) ** 2 for r in range(n))
    sst = sum((v - mean(y)) ** 2 for v in y)
    df = n - k
    s2 = sse / df
    Inv = inv(XtX)
    se = [math.sqrt(s2 * Inv[j][j]) for j in range(k)]
    t = [beta[j] / se[j] for j in range(k)]
    p = [t_p2(abs(tj), df) for tj in t]
    return beta, se, t, p, 1 - sse / sst, df


ok = {}

# ---------------------------------------------------------------- B. 正規化與相關
print("\n== B1. c1（#utt）的正規化 ==")
zUTT, m1, s1 = z(UTT)
print(f"  平均 {m1:.2f}、樣本標準差 {s1:.2f}（論文 38.6、18.9）")
print(f"  user 5 的 N(c1) = {zUTT[4]:.2f}（論文 −0.83）；user 11 = {zUTT[10]:.2f}（論文 −1.51）")
ok["B1"] = round(m1, 1) == 38.6 and round(s1, 1) == 18.9 and round(zUTT[4], 2) == -0.83 and round(zUTT[10], 2) == -1.51

n = len(US)
r_ur = sum((a - mean(UTT)) * (b - mean(REP)) for a, b in zip(UTT, REP)) / ((n - 1) * stdev(UTT) * stdev(REP))
print(f"\n== B2. #utt 與 #rep 的相關 = {r_ur:.3f}（論文 0.91）==")
ok["B2"] = round(r_ur, 2) == 0.91

zK, mK, sK = z(K)
zREP, mR, sR = z(REP)
zUS, mU, sU = z(US)

print("\n== B3. 第一次迴歸：US ~ N(κ) + N(#utt) + N(#rep)（論文：只有 κ 與 #rep 顯著，p < .02）==")
for name, y in (("原始 US", US), ("Z 化 US", zUS)):
    b, se, t, p, r2, df = ols(y, [zK, zUTT, zREP])
    print(f"  {name}：κ {b[1]:+.3f}（p={p[1]:.4f}）、#utt {b[2]:+.3f}（p={p[2]:.4f}）、#rep {b[3]:+.3f}（p={p[3]:.4f}）、R²={r2:.3f}、df={df}")
b1, _, _, p1, _, _ = ols(US, [zK, zUTT, zREP])
ok["B3"] = p1[1] < 0.02 and p1[3] < 0.02 and p1[2] > 0.05

print("\n== A. 第二次迴歸：US ~ N(κ) + N(#rep)，四種組合 ==")
# 預測變數用樣本標準差 Z 化
bR, seR, tR, pR, r2R, dfR = ols(US, [zK, zREP])
bZ, seZ, tZ, pZ, r2Z, dfZ = ols(zUS, [zK, zREP])
# 預測變數改用母體標準差（除以 n）Z 化，真的重跑迴歸；應變數 Z 化時也用母體標準差
pzK, _, _ = z(K, pstdev)
pzREP, _, _ = z(REP, pstdev)
pzUS, _, psU = z(US, pstdev)
bPR, _, _, _, r2PR, _ = ols(US, [pzK, pzREP])
bPZ, _, _, _, r2PZ, _ = ols(pzUS, [pzK, pzREP])
print("  預測變數 σ 口徑 × 應變數            α（κ 係數）  w2（#rep 權重）")
print(f"  樣本 σ × 原始 US                    {bR[1]:.3f}        {-bR[2]:.3f}")
print(f"  樣本 σ × Z 化 US（樣本 σ）          {bZ[1]:.3f}        {-bZ[2]:.3f}   （論文 .40、.78）")
print(f"  母體 σ × 原始 US                    {bPR[1]:.3f}        {-bPR[2]:.3f}   （精讀筆記的缺點清單寫 0.714／−1.386）")
print(f"  母體 σ × Z 化 US（母體 σ）          {bPZ[1]:.3f}        {-bPZ[2]:.3f}")
print(f"  樣本 σ 版原始 US 與 Z 化 US 相差的倍數就是 US 的樣本標準差：{bR[1] / bZ[1]:.4f} 對 σ_US = {sU:.4f}")
print(f"  母體 σ 版原始 US 與 Z 化 US 相差的倍數就是 US 的母體標準差：{bPR[1] / bPZ[1]:.4f} 對 σ_US = {psU:.4f}")
# 交叉核對：只換預測變數的口徑時，係數應恰好乘上 √((n−1)/n) = √(15/16)
shrink = math.sqrt((n - 1) / n)
cross = max(abs(bPR[j] - bR[j] * shrink) for j in (1, 2))
print(f"  交叉核對：母體 σ × 原始 US 的係數 ÷ 樣本 σ × 原始 US 的係數 = {bPR[1] / bR[1]:.6f}，√(15/16) = {shrink:.6f}；兩種算法最大差 {cross:.2e}")
print(f"  R² 不受口徑影響：{r2R:.4f}、{r2Z:.4f}、{r2PR:.4f}、{r2PZ:.4f}")
print("  論文自己的 σ_c1 = 18.9 是樣本標準差，所以與論文一致的原始 US 係數是第一列")
ok["A_z"] = round(bZ[1], 2) == 0.40 and round(-bZ[2], 2) == 0.78 \
    and abs(bPZ[1] - bZ[1]) < 1e-9 and abs(bPZ[2] - bZ[2]) < 1e-9
ok["A_raw"] = abs(bR[1] - 0.40) > 0.1 and round(bR[1], 3) == 0.737 and round(bR[2], 3) == -1.432 \
    and round(bPR[1], 3) == 0.714 and round(bPR[2], 3) == -1.386 and cross < 1e-9
print(f"  R² = {r2Z:.3f}（論文 92%）；κ 的 p = {pZ[1]:.2e}（論文 < .0003）；#rep 的 p = {pZ[2]:.2e}（論文 < .0001）；df = {dfZ}")
ok["B4"] = round(r2Z, 2) == 0.92 and pZ[1] < 0.0003 and pZ[2] < 0.0001

print("\n== B5. Performance 的組平均與 t test（論文 A = −.44、B = .44、p < .07）==")
perf = [0.40 * zK[i] - 0.78 * zREP[i] for i in range(n)]
pa = [perf[i] for i in range(n) if agent[i] == "A"]
pb = [perf[i] for i in range(n) if agent[i] == "B"]
print(f"  A 平均 {mean(pa):+.3f}、B 平均 {mean(pb):+.3f}、全體平均 {mean(perf):+.2e}（Z 化後必為 0）")
sp = math.sqrt(((len(pa) - 1) * stdev(pa) ** 2 + (len(pb) - 1) * stdev(pb) ** 2) / (len(pa) + len(pb) - 2))
tt = (mean(pb) - mean(pa)) / (sp * math.sqrt(1 / len(pa) + 1 / len(pb)))
ptt = t_p2(abs(tt), len(pa) + len(pb) - 2)
print(f"  合併變異的雙樣本 t = {tt:.3f}、df = {len(pa) + len(pb) - 2}、雙尾 p = {ptt:.4f}")
ok["B5"] = round(mean(pa), 2) == -0.44 and round(mean(pb), 2) == 0.44 and ptt < 0.07
print("  兩組各 8 人時，全體平均固定為 0，所以兩組平均必為一正一負、絕對值相同：", round(mean(pa) + mean(pb), 12) == 0)

# ---------------------------------------------------------------- C. κ 的轉換
print("\n== C. 逐段 κ 是否等於用全域 P(E) = 0.079 轉換 ==")
assert re.search(r"P\(E\) = 0\.079", TEXT)
PE = 0.079
conv = {frac: (frac - PE) / (1 - PE) for frac in (1.0, 0.5, 0.25)}
for frac, kk in conv.items():
    print(f"  正確屬性比例 {frac:.2f} → κ = ({frac} − {PE}) / (1 − {PE}) = {kk:.3f}")
kvals = sorted(set(K))
print(f"  Table 5 出現的 κ：{kvals}")
kappa_ok = all(any(abs(kk - v) < 0.006 for kk in conv.values()) for v in kvals)
print("  N(κ) 與 N(正確比例) 是否逐列相同（κ 是正確比例的線性轉換）：", end=" ")
pc = [{1.0: 1.0, 0.46: 0.5, 0.19: 0.25}[v] for v in K]
zpc, _, _ = z(pc)
same = max(abs(a - b) for a, b in zip(zK, zpc))
print(f"最大差 {same:.4f}（κ 印到兩位小數，差異來自四捨五入；門檻 < 0.01）")
ok["C"] = kappa_ok and same < 0.01

# ---------------------------------------------------------------- D. 兩個策略的子對話正規化
print("\n== D. §2.5 只有兩個策略時的 N(κ) ==")
i25 = find(r"the mean \$\\kappa\$ is \.\d+ and \$\\sigma\$ is \.\d+")
mm_ = re.search(r"the mean \$\\kappa\$ is (\.\d+) and \$\\sigma\$ is (\.\d+)", L[i25])
m_k, s_k = float(mm_.group(1)), float(mm_.group(2))
assert re.search(r"\$\\kappa\$ = \.70\.", L[i25 - 2])
kA = 0.70
kB = 2 * m_k - kA
s2 = abs(kA - kB) / math.sqrt(2)
print(f"  原文第 {i25 + 1} 行：平均 {m_k}、標準差 {s_k}；κ_A = {kA}")
print(f"  反推 κ_B = 2 × {m_k} − {kA} = {kB:.3f}；兩點的樣本標準差 |κ_A − κ_B|/√2 = {s2:.4f}（論文 {s_k}）")
print(f"  N(κ_A) = ({kA} − {m_k}) / {s_k} = {(kA - m_k) / s_k:.3f}；兩點時恆為 1/√2 = {1 / math.sqrt(2):.4f}")
for a, b in ((0.70, 0.33), (0.70, 0.69), (0.99, 0.01)):
    mm, ss = (a + b) / 2, abs(a - b) / math.sqrt(2)
    print(f"    κ_A = {a}、κ_B = {b} → N(κ_A) = {(a - mm) / ss:.4f}")
ok["D"] = abs(s2 - s_k) < 0.002 and abs((kA - m_k) / s_k - 1 / math.sqrt(2)) < 0.005

# ---------------------------------------------------------------- E. 兩個 Performance
print("\n== E. §2.5 的 Performance(RA)、Performance(RB) ==")
assert re.search(r"standard deviation is 2\.79", TEXT) and re.search(r"is 1\.38", TEXT)
nc2_a = (6 - 4) / 2.79
nc2_b = (1.38 - 4) / 2.79
ra = 0.40 * 0.71 - 0.78 * 0.72
rb = 0.40 * -0.71 - 0.78 * round(nc2_b, 2)
print(f"  N(c2_A) = (6 − 4)/2.79 = {nc2_a:.3f}（論文 .72）；N(c2_B) = (1.38 − 4)/2.79 = {nc2_b:.3f}（論文 −.94）")
print(f"  Performance(RA) = .40×.71 − .78×.72 = {ra:.3f}（論文 −0.28）；Performance(RB) = .40×(−.71) − .78×(−.94) = {rb:.3f}（論文 0.45）")
print(f"  c2 的參考平均是 4，A、B 兩者的平均是 (6 + 1.38)/2 = {(6 + 1.38) / 2:.2f}；κ 的參考群只有 A、B 兩點，c2 的參考群另有假設的樣本池")
ok["E"] = round(nc2_a, 2) == 0.72 and round(nc2_b, 2) == -0.94 and round(ra, 2) == -0.28 and round(rb, 2) == 0.45

print("\n逐項：", ", ".join(f"{k}={'通過' if v else '不符'}" for k, v in ok.items()))
if all(ok.values()):
    print("結論：證實。論文的 .40／.78、R² 92%、p 值、±.44、p < .07 與 §2.5 的算式都由 Table 5 重現，但 .40／.78 要把 US 也 Z 化才重現（原始 US 得 0.737／−1.432；筆記缺點清單的 0.714／−1.386 是預測變數改用母體標準差重跑迴歸的值，兩種口徑在 Z 化 US 下都是 .400／.776）；逐段 κ 是全域 P(E) = 0.079 的線性轉換，N(κ) 與 N(答對比例) 逐列差 < 0.01；兩策略的 N(κ) 恆為 ±1/√2。")
else:
    print("結論：部分不符，見上方逐項。")
