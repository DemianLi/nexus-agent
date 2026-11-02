#!/usr/bin/env python3
"""驗證：Lost in Conversation 的 A⁹⁰／U⁹⁰₁₀ 在二元任務、N=10 下有機械性。

主張（章節 02-dialogue-state-tracking.md「它的 A／U 拆解在二元任務上有機械性」一段）：
  在 0／100 的二元任務、每條指令跑 N=10 次、百分位採 numpy 預設的線性內插時，
  - 10 次中答對 2 次以上，A⁹⁰ 就是 100；
  - 答對 2–8 次，U⁹⁰₁₀ 一律是 100；
  - 所以單題成功率從 100% 掉到 20%–80% 之間，都只算進 U，不算進 A。
出處：[arXiv:2505.06120] 精讀筆記 notes/2505.06120.json 的 limitations_observed 第 1 條。

輸入從哪來（全部取自 .cache/text/2505.06120.txt）：
  - 約第 289–292 行：Code、Database、Actions、Math 四個任務是二元正確性，映射成 0（失敗）／100（成功）。
  - 約第 303–320 行：A⁹⁰ = percentile_90(S)，U⁹⁰₁₀ = percentile_90(S) − percentile_10(S)；論文沒寫插值法。
  - 約第 337 行：每組模型 × 模擬型態跑 N=10 次。
前提：repo（microsoft/lost_in_conversation）沒附 A／U 的計算程式（依筆記），插值法是假設。
      本程式把 numpy 的 linear／lower／higher／nearest／midpoint 與 Hyndman–Fan type 6
      （statistics.quantiles 的 exclusive）都跑一遍，看結論對插值假設有多敏感。

只用標準函式庫；沒有隨機數（二項分布用精確機率計算）。執行：python3 02-lic-au-percentile.py
"""

import math
import statistics

N = 10


def pct(xs, q, method="linear"):
    """numpy.percentile 的幾種插值法，以標準函式庫重寫。xs 會先排序。"""
    s = sorted(xs)
    n = len(s)
    h = (n - 1) * q / 100.0
    lo = math.floor(h)
    hi = math.ceil(h)
    if method == "linear":
        return s[lo] + (h - lo) * (s[hi] - s[lo])
    if method == "lower":
        return s[lo]
    if method == "higher":
        return s[hi]
    if method == "nearest":
        # numpy 用 around（四捨六入五成雙）；Python 的 round 同樣是銀行家捨入
        return s[int(round(h))]
    if method == "midpoint":
        return (s[lo] + s[hi]) / 2.0
    if method == "exclusive":
        # Hyndman–Fan type 6，即 statistics.quantiles(method="exclusive")
        cuts = statistics.quantiles(s, n=10, method="exclusive")
        return cuts[int(q // 10) - 1]
    raise ValueError(method)


def scores(k):
    """答對 k 次、答錯 10−k 次（未排序，pct 內會排序）。"""
    return [100] * k + [0] * (N - k)


def a_u(k, method):
    xs = scores(k)
    a = pct(xs, 90, method)
    return a, a - pct(xs, 10, method)


def fmt(v):
    return f"{v:g}"


print("=" * 72)
print("一、線性內插（numpy 預設）：列舉答對次數 k = 0..10")
print("=" * 72)
expected = {0: (0, 0), 1: (10, 10), 9: (100, 10), 10: (100, 0)}
for k in range(2, 9):
    expected[k] = (100, 100)

ok_all = True
print(f"{'k':>3} {'A⁹⁰':>6} {'U⁹⁰₁₀':>6}   預期(A,U)   statistics.quantiles(inclusive) 交叉核對")
for k in range(N + 1):
    a, u = a_u(k, "linear")
    # 交叉核對：statistics.quantiles 的 inclusive 就是 numpy 的 linear（type 7）
    cuts = statistics.quantiles(scores(k), n=10, method="inclusive")
    a2, u2 = cuts[8], cuts[8] - cuts[0]
    exp = expected[k]
    match = abs(a - exp[0]) < 1e-9 and abs(u - exp[1]) < 1e-9
    cross = abs(a - a2) < 1e-9 and abs(u - u2) < 1e-9
    ok_all &= match and cross
    print(f"{k:>3} {fmt(a):>6} {fmt(u):>6}   {str(exp):<11} "
          f"{'一致' if cross else '不一致'}（A={fmt(a2)}, U={fmt(u2)}）  {'符合預期' if match else '不符預期'}")
print(f"\n→ 線性內插下，逐格都符合預期：{ok_all}")

print()
print("=" * 72)
print("二、換插值法：核心區段 k=2..8 是否仍然 A=100、U=100？")
print("=" * 72)
methods = ["linear", "lower", "higher", "nearest", "midpoint", "exclusive"]
print(f"{'k':>3} " + " ".join(f"{m:>15}" for m in methods))
core_ok = {m: True for m in methods}
for k in range(N + 1):
    cells = []
    for m in methods:
        a, u = a_u(k, m)
        cells.append(f"A={fmt(a):>3} U={fmt(u):>3}")
        if 2 <= k <= 8 and not (a == 100 and u == 100):
            core_ok[m] = False
    print(f"{k:>3} " + " ".join(f"{c:>15}" for c in cells))
print()
for m in methods:
    print(f"  {m:<10} k=2..8 全部 A=U=100：{core_ok[m]}")
print("→ 核心區段對插值假設不敏感；只有兩端（k=1、k=9）隨插值法改變。")

print()
print("=" * 72)
print("三、把「觀察到的答對次數」換成「真實成功機率 p」：N=10 的二項分布精確期望值")
print("=" * 72)
print("（E[P̄]=100p 是平均分數；E[A]、E[U] 以線性內插計算，逐 k 乘上二項機率加總）")
print(f"{'p':>5} {'E[P̄]':>7} {'E[A]':>7} {'E[U]':>7} {'P(k≥2)':>8}")
EA = {}
for p in [1.0, 0.95, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05, 0.0]:
    ea = eu = 0.0
    for k in range(N + 1):
        w = math.comb(N, k) * p ** k * (1 - p) ** (N - k)
        a, u = a_u(k, "linear")
        ea += w * a
        eu += w * u
    pk2 = sum(math.comb(N, k) * p ** k * (1 - p) ** (N - k) for k in range(2, N + 1))
    EA[p] = (ea, eu)
    print(f"{p:>5.2f} {100 * p:>7.1f} {ea:>7.2f} {eu:>7.2f} {pk2:>8.4f}")
print(f"→ 真實成功率 p 從 1.0 掉到 0.5，E[A] 只從 100 降到 {EA[0.5][0]:.2f}；E[U] 從 0 升到 {EA[0.5][1]:.2f}。")
print(f"  但 p 掉到 0.3 與 0.2 時，E[A] 分別降到 {EA[0.3][0]:.2f} 與 {EA[0.2][0]:.2f}，A 開始反映能力下降。")
print("  所以「20%–80% 都只算進 U」是對『觀察到的答對次數 k/10』成立；")
print("  對真實成功率而言，約 0.4 以上才幾乎只算進 U。")

print()
print("=" * 72)
print("結論")
print("=" * 72)
print("證實（在線性內插假設下，且核心區段 k=2..8 對六種插值法都成立）：")
print("  答對 ≥2 次 A=100；答對 2–8 次 U=100；k/10 從 1.0 掉到 0.2–0.8 之間只會改變 U。")
print("範圍提醒：這個機制只作用在四個二元任務（Code、Database、Actions、Math；快取第 289–292 行）。")
print("  §6.2 的 A −16%、U +112%（快取第 857–858 行）沒寫明平均涵蓋哪些任務；主實驗涵蓋六個任務")
print("  （第 331 行），若平均含兩個連續分數的 refinement 任務，這個機制只解釋其中一部分。")
