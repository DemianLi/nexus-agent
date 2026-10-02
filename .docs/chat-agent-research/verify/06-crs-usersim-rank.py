#!/usr/bin/env python3
"""驗證：2006.08732（Zhang & Balog，Evaluating Conversational Recommender Systems via User Simulation）
裡「模擬使用者排出的名次和真人一致」這件事，以及逼真度和預測力是不是同一件事。

主張（精讀筆記 notes/2006.08732.json 與論文 §6）：
  a. Reward：三個模擬器排出的 A > B > C 都和真人一致；Success Rate：只有 CIR6-PKG 把 A、B 對調。
  b. 論文：CIR6-PKG 的 Success Rate「在絕對數字上最接近真人」。
  c. 真人自己的兩個指標也不一致（Reward A 第一、Success Rate B 第一）。
  d. 側對側判斷（Table 6）：CIR6-PKG 被誤認為真人 36%，比 QRFA-Single 多 9 個百分點。
  e. 論文的結論句說模擬能達到 high correlation，但同一段也寫只建立在三個系統上。
出處：[arXiv:2006.08732]

輸入（全部由程式從 .cache/text/2006.08732.txt 解析）：
  - Table 4：AvgTurns、UserActRatio、DS-KL（真人與三個模擬器 × 三個受測系統 A、B、C）。
  - Table 5：Reward 與 Success Rate 的名次與括號裡的分數。
  - Table 6：每個模擬器 × 每個受測系統的 Win／Lose／Tie 與 All 欄。
  - 正文：真人對話是每個受測系統 25 段成功對話、互動模型用它訓練；側對側是 25 × 3 × 3 段、每段給 3 位工作者。

方法：
  1. 名次直接比對；3 個系統只有 3! = 6 種排法，名次完全一致在隨機下的機率是 1 ÷ 6。
  2. Reward = max{0, Full − Cost·T}，所以順手檢查 Reward 的名次是否就是 AvgTurns 名次的反向。
  3. 「絕對數字最接近」分兩組讀法檢查。三個系統一起算：平均絕對差、最大絕對差、逐系統誰最近。
     只看 A、B（論文那句的前半句說的是 A、B 的分數很接近，緊接的下一句說 CIR6-PKG 對調了 A、B，所以這是最貼近原句的讀法）：
     A、B 兩個的平均絕對差、最大絕對差，以及 A、B 差距的大小（不計方向與計方向各算一次）。
  3b. Table 6 的百分比另以一般四捨五入重算，檢查重算值加起來是不是已經是 100。
  4. Win 率的兩比例 z 檢定把 225 個判斷當獨立樣本；每段對話給 3 位工作者，真正獨立的單位最少只有 75 段，
     所以另列「除以 √3」的下限。這兩個數是證據強度的上下限，不是精確檢定。
  5. DS-KL（越小越像真人的動作分布）與 Win（越大越常被誤認為真人）的名次對照。

只用標準函式庫；沒有隨機數。執行：python3 verify/06-crs-usersim-rank.py（研究根目錄）
"""

import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "..", ".cache", "text", "2006.08732.txt")
L = open(PATH, encoding="utf-8").read().split("\n")


def find_line(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(L)):
        if rx.search(L[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def pipe_blocks(a, b):
    """每格一行、以 "| " 開頭、空行分隔列；回傳非空格子的串列。"""
    out, cur = [], []
    for i in range(a, b):
        s = L[i]
        if s.startswith("|"):
            c = s[1:].strip()
            if c:
                cur.append(c)
        elif not s.strip() and cur:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


AG = ["A", "B", "C"]
METHODS = ["Real users", "QRFA-Single", "CIR6-Single", "CIR6-PKG"]
SIMS = METHODS[1:]

# ---------------- Table 4 ----------------
t4 = find_line(r"^Table 4\. Comparison of the characteristics")
t5 = find_line(r"^Table 5\. Performance of conversational agents", t4)
T4 = {}
for b in pipe_blocks(t4, t5):
    if b[0] in METHODS:
        v = [None if x == "-" else float(x) for x in b[1:]]
        assert len(v) == 9
        T4[b[0]] = {"AvgTurns": dict(zip(AG, v[0:3])), "UserActRatio": dict(zip(AG, v[3:6])), "DS-KL": dict(zip(AG, v[6:9]))}
assert list(T4) == METHODS, list(T4)

# ---------------- Table 5 ----------------
t5_end = find_line(r"^## 6\. Experimental Evaluation", t5)
T5 = {}
for b in pipe_blocks(t5, t5_end):
    if b[0] in METHODS:
        out = []
        for cell in b[1:3]:
            pairs = re.findall(r"([ABC]) \(([\d.]+)\)", cell)
            assert len(pairs) == 3, cell
            out.append(([p[0] for p in pairs], {p[0]: float(p[1]) for p in pairs}))
        T5[b[0]] = {"Reward": out[0], "Success": out[1]}
assert list(T5) == METHODS, list(T5)
for m in METHODS:
    for k in ("Reward", "Success"):
        order, sc = T5[m][k]
        assert order == sorted(AG, key=lambda a: -sc[a]), (m, k)  # 名次與括號裡的分數一致

l25 = find_line(r"we collected 25 successful dialogs")
l100 = find_line(r"averaging by 100 conversations")
print(f"第 {l25 + 1} 行：每個受測系統收 25 段成功的真人對話（互動模型就用它們訓練）；第 {l100 + 1} 行：模擬端兩個系統各 100 段、一個只有 25 段")
print(f"\nTable 4（第 {t4 + 1} 行起）與 Table 5（第 {t5 + 1} 行起）：")
for m in METHODS:
    t = T4[m]["AvgTurns"]
    r, s = T5[m]["Reward"], T5[m]["Success"]
    print(f"  {m:12s} AvgTurns {t['A']:5.2f}/{t['B']:5.2f}/{t['C']:5.2f}  "
          f"Reward {' > '.join(f'{a}({r[1][a]})' for a in r[0])}  Success {' > '.join(f'{a}({s[1][a]})' for a in s[0])}")

# ---------------- 名次 ----------------
print("\n名次與真人一致嗎：")
real_r, real_s = T5["Real users"]["Reward"][0], T5["Real users"]["Success"][0]
agree_r = [m for m in SIMS if T5[m]["Reward"][0] == real_r]
agree_s = [m for m in SIMS if T5[m]["Success"][0] == real_s]
print(f"  Reward：真人 {'>'.join(real_r)}；一致的模擬器 {len(agree_r)}/3 {agree_r}")
print(f"  Success：真人 {'>'.join(real_s)}；一致的模擬器 {len(agree_s)}/3 {agree_s}；"
      f"CIR6-PKG 是 {'>'.join(T5['CIR6-PKG']['Success'][0])}")
print(f"  真人自己的兩個指標：Reward 第一名 {real_r[0]}、Success 第一名 {real_s[0]}，"
      f"{'不一致' if real_r != real_s else '一致'}；C 在 4 × 2 = 8 個名次裡都是最後："
      f"{all(T5[m][k][0][-1] == 'C' for m in METHODS for k in ('Reward', 'Success'))}")
print("  所以真正有資訊的只有 A、B 的先後；3 個系統的完整名次在隨機下一致的機率是 1 ÷ 6，"
      "而在已知 C 墊底時，A、B 先後碰對的機率是 1 ÷ 2")
rev = all(T5[m]["Reward"][0] == sorted(AG, key=lambda a: T4[m]["AvgTurns"][a]) for m in METHODS)
print(f"  Reward 的名次在 4 列裡是否全等於 AvgTurns 由短到長的名次：{rev}"
      "（Reward = max{0, Full − Cost·T}，名次一致等於對話長短的先後一致）")

# ---------------- 絕對數字最接近 ----------------
lclose = find_line(r"comes closest to real humans in terms of absolute numbers")
print(f"\n「CIR6-PKG 的 Success 在絕對數字上最接近真人」（第 {lclose + 1} 行）：")
rs = T5["Real users"]["Success"][1]
mad, mx = {}, {}
for m in SIMS:
    d = {a: abs(T5[m]["Success"][1][a] - rs[a]) for a in AG}
    mad[m] = sum(d.values()) / 3
    mx[m] = max(d.values())
    print(f"  {m:12s} 逐系統絕對差 " + "、".join(f"{a} {d[a]:.3f}" for a in AG) + f"；平均 {mad[m]:.4f}；最大 {mx[m]:.3f}")
best_mad = min(SIMS, key=lambda m: mad[m])
best_mx = min(SIMS, key=lambda m: mx[m])
per = {a: min(SIMS, key=lambda m: abs(T5[m]["Success"][1][a] - rs[a])) for a in AG}
print(f"  平均絕對差最小：{best_mad}；最大絕對差最小：{best_mx}；逐系統最近：{per}")
claim_ok = best_mad == "CIR6-PKG" or best_mx == "CIR6-PKG"
print(f"  → 三個系統一起算時，論文的說法{'有' if claim_ok else '沒有'}被平均或最大絕對差支持；CIR6-PKG 只在受測系統 "
      f"{[a for a in AG if per[a] == 'CIR6-PKG']} 上最近")
lab = find_line(r"agents A and B are very close in terms of absolute scores")
lflip = find_line(r"this method flips the order of agents A and B", lab)
print(f"  只看 A、B（第 {lab + 1} 行的前半句說 A、B 的分數很接近，第 {lflip + 1} 行緊接著說 CIR6-PKG 對調了 A、B）：")
AB = ["A", "B"]
mad_ab, mx_ab, gap_abs, gap_sgn = {}, {}, {}, {}
real_gap = rs["B"] - rs["A"]
for m in SIMS:
    s = T5[m]["Success"][1]
    d = {a: abs(s[a] - rs[a]) for a in AB}
    mad_ab[m] = sum(d.values()) / 2
    mx_ab[m] = max(d.values())
    g = s["B"] - s["A"]
    gap_abs[m] = abs(abs(g) - abs(real_gap))
    gap_sgn[m] = abs(g - real_gap)
    print(f"    {m:12s} A {d['A']:.3f}、B {d['B']:.3f}；平均 {mad_ab[m]:.4f}；最大 {mx_ab[m]:.3f}；"
          f"B − A = {g:+.3f}（真人 {real_gap:+.3f}），差距大小相差 {gap_abs[m]:.3f}，計方向相差 {gap_sgn[m]:.3f}")
best_mad_ab = min(SIMS, key=lambda m: mad_ab[m])
best_mx_ab = min(SIMS, key=lambda m: mx_ab[m])
best_gap_abs = min(SIMS, key=lambda m: gap_abs[m])
best_gap_sgn = min(SIMS, key=lambda m: gap_sgn[m])
print(f"    A、B 平均絕對差最小：{best_mad_ab}；A、B 最大絕對差最小：{best_mx_ab}；"
      f"A、B 差距大小最接近真人（不計方向）：{best_gap_abs}；計方向時最接近：{best_gap_sgn}")
print(f"  → 依讀法而定：三個系統一起算時 CIR6-PKG 的平均絕對差三者最大；只看 A、B 時它的平均與最大絕對差"
      f"{'都最小' if best_mad_ab == best_mx_ab == 'CIR6-PKG' else '不都是最小'}，支持論文的說法；"
      f"A、B 差距的大小也是它最接近，但它的方向反了")
rr = T5["Real users"]["Reward"][1]
for m in SIMS:
    d = sum(abs(T5[m]["Reward"][1][a] - rr[a]) for a in AG) / 3
    print(f"  Reward 平均絕對差 {m:12s} {d:.3f}")

# ---------------- Table 6 ----------------
t6 = find_line(r"^Table 6\. Side-by-side comparison results")
t6_end = find_line(r"^### 6\.2\. Performance Prediction", t6)
T6 = {}
for b in pipe_blocks(t6, t6_end):
    if b[0] in SIMS:
        v = b[1:]
        assert len(v) == 12, b
        per_ag = {a: tuple(int(x) for x in v[3 * i: 3 * i + 3]) for i, a in enumerate(AG)}
        tot = tuple(int(re.match(r"(\d+)", x).group(1)) for x in v[9:12])
        pct = tuple(int(re.search(r"\((\d+)%\)", x).group(1)) for x in v[9:12])
        T6[b[0]] = (per_ag, tot, pct)
assert list(T6) == SIMS
l225 = find_line(r"25\\times 3\\times 3=225")
print(f"\nTable 6（第 {t6 + 1} 行起；第 {l225 + 1} 行：25 × 3 × 3 = 225 段模擬對話，每段配一段真人對話給 3 位工作者）：")
for m in SIMS:
    per_ag, tot, pct = T6[m]
    s = [sum(per_ag[a][k] for a in AG) for k in range(3)]
    assert tuple(s) == tot, (m, s, tot)
    n = sum(tot)
    exact = [100 * x / n for x in tot]
    rounded = [math.floor(x + 0.5) for x in exact]
    print(f"  {m:12s} " + "  ".join(f"{a} {per_ag[a][0]}/{per_ag[a][1]}/{per_ag[a][2]}（{sum(per_ag[a])}）" for a in AG)
          + f"  All {tot[0]}/{tot[1]}/{tot[2]}（{n}）；論文百分比 {pct}，實算 " + "/".join(f"{x:.1f}" for x in exact)
          + f"，四捨五入 {tuple(rounded)}（合計 {sum(rounded)}）"
          + ("" if tuple(rounded) == pct else "；與論文不同"))
    if tuple(rounded) != pct and sum(rounded) == 100:
        print(f"    → 一般四捨五入已經合計 100，論文印的 {pct} 不能用「為了湊成 100」解釋；原因論文沒交代")


def z2(x1, x2, n):
    p1, p2 = x1 / n, x2 / n
    p = (x1 + x2) / (2 * n)
    se = math.sqrt(p * (1 - p) * 2 / n)
    return (p1 - p2) / se


win = {m: T6[m][1][0] for m in SIMS}
lose = {m: T6[m][1][1] for m in SIMS}
print("  Win 率的兩比例 z（225 個判斷當獨立 → 上限；除以 √3 相當於只有 75 段對話獨立 → 下限）：")
for a, b in (("CIR6-PKG", "QRFA-Single"), ("CIR6-Single", "QRFA-Single"), ("CIR6-PKG", "CIR6-Single")):
    z = z2(win[a], win[b], 225)
    print(f"    {a} {win[a]} 對 {b} {win[b]}（每邊 225）：z = {z:.2f}，下限 {z / math.sqrt(3):.2f}")
print("  評審是否比亂猜好（排除平手，Win 對 Lose 的符號檢定，z 上限）：")
for m in SIMS:
    k = win[m] + lose[m]
    z = (win[m] - k / 2) / math.sqrt(k / 4)
    print(f"    {m:12s} Win {win[m]} 對 Lose {lose[m]}（共 {k}）：z = {z:.2f}")
pc = T6["CIR6-PKG"][0]["C"]
print(f"  CIR6-PKG 在受測系統 C 上 Win {pc[0]} > Lose {pc[1]}，是 9 格裡唯一 Win 多於 Lose 的："
      f"{sum(T6[m][0][a][0] > T6[m][0][a][1] for m in SIMS for a in AG) == 1}")

# ---------------- 逼真度與預測力 ----------------
print("\n逼真度與預測力：")
dskl = {m: sum(T4[m]["DS-KL"][a] for a in AG) / 3 for m in SIMS}
print("  DS-KL 三系統平均（越小越像真人的動作分布）：" + "、".join(f"{m} {dskl[m]:.4f}" for m in SIMS))
print("  Win 率（越大越常被誤認為真人）：" + "、".join(f"{m} {100 * win[m] / 225:.1f}%" for m in SIMS))
o_kl = sorted(SIMS, key=lambda m: dskl[m])
o_win = sorted(SIMS, key=lambda m: -win[m])
print(f"  DS-KL 由像到不像：{o_kl}；Win 由像到不像：{o_win}；兩者{'完全相反' if o_kl == o_win[::-1] else '不是完全相反'}")
print(f"  Win 最高的 {o_win[0]} 也是唯一把 Success 名次排錯、Reward 絕對值偏離最大的那個")

lthree = find_line(r"these findings are based only on three systems")
lhigh = find_line(r"can achieve high correlation between automatic and human evaluations")
print(f"\n第 {lthree + 1} 行：論文自己說只建立在三個系統上；第 {lhigh + 1} 行：結論仍寫 high correlation")

print(f"\n結論：Reward 名次 3/3 一致，但它在 4 列都等於對話長短的先後；Success 2/3 一致，CIR6-PKG 對調 A、B；"
      f"真人自己的兩個指標也在 A、B 上相反，C 在 8 個名次裡都墊底，所以有資訊的只有 A、B 的先後（碰對機率 1 ÷ 2）；"
      f"「CIR6-PKG 的 Success 絕對數字最接近真人」依讀法而定：三個系統一起算時平均絕對差 {mad['CIR6-PKG']:.3f} 是三者最大，"
      f"只看論文那句談的 A、B 時平均絕對差 {mad_ab['CIR6-PKG']:.3f} 與最大絕對差 {mx_ab['CIR6-PKG']:.3f} 都是三者最小；"
      f"Win 率最高的 CIR6-PKG 動作分布離真人最遠，逼真度與預測力走相反方向；PKG 對 QRFA 的 Win 差 z 介於 "
      f"{z2(81, 61, 225) / math.sqrt(3):.2f} 到 {z2(81, 61, 225):.2f}。")
