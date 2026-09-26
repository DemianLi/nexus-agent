#!/usr/bin/env python3
"""驗證：2602.16666 的 outcome consistency 有由準確率決定的下限 C_out ≥ (2·acc−1)²。

主張（章節 08-task-completion-score.md 第 150、359、414 行）：
  C_out ≥ (2·acc−1)²，準確率 0.9 或 0.1 時下限都是 0.64，與論文引言「這些指標與原始準確率
  無關」的宣稱相左。另外：每次都失敗的題目跟每次都成功的一樣拿 1；K=5 讓單題 C_out 只剩三個值。
出處：[arXiv:2602.16666] 精讀筆記 notes/2602.16666.json 的 limitations_observed 第 2 條
  （Jensen 推導）與第 3 條（K=5 只有三個值）。

輸入從哪來：
  - .cache/text/2602.16666.txt 第 220 行：C_out = (1/T) Σ_t (2 p̂_t − 1)²（Table 2）。
  - .cache/text/2602.16666.txt 第 224–225 行：p̂_t = (1/K) Σ_k y_{t,k}；以最大 Bernoulli 變異數 0.25 正規化。
  - .cache/text/2602.16666.txt 第 489 行：K=5。
  - .cache/text/2602.16666.txt 第 84 行：「twelve concrete metrics that are independent of raw accuracy」。
  - T=26 取自 notes/2602.16666.json 的 limitations_observed 第 3 條（τ-bench 每模型 26 題×5 次）。
  以上都由程式從檔案裡找出並印出，不手抄。

方法：
  1. 推導：g(p) = (2p−1)²，g''(p) = 8 > 0，凸。acc = (1/T) Σ_t p̂_t（每題 K 次相同時，就是全部
     T·K 次執行的成功比例）。Jensen：(1/T) Σ g(p̂_t) ≥ g((1/T) Σ p̂_t) = (2·acc−1)²。
     更精確的恆等式：C_out = (2·acc−1)² + 4·Var_t(p̂_t)（Var 是題目之間的母體變異數），
     所以等號成立 ⇔ 所有題目的 p̂_t 都相同。
  2. 模擬：固定種子，K=5，T ∈ {26, 100}，準確率目標 q ∈ {0.1, 0.3, 0.5, 0.7, 0.9}，四種逐題
     成功率分佈（同質、Beta 分散、兩極 0/1、兩點混合），每組 2000 次，檢查下限與恆等式。
  3. 可達性：K=5 時 p̂ 只能是 0, 0.2, …, 1，給定 acc 的最小 C_out 是 g 在格點上的分段線性內插。
     逐一列出 acc 在格點與非格點時的最小值，說明 0.64 在 K=5 下能不能真的達到。
  4. 可行範圍：同一個 acc 下 C_out 能取到的 [最小, 最大]，看它是不是真的與準確率無關。
  5. 在全文找「independent of raw accuracy」原句。

只用標準函式庫；隨機種子固定為 20260926。執行：python3 08-cout-accuracy-bound.py
"""

import json
import math
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TEXT = os.path.join(ROOT, ".cache", "text", "2602.16666.txt")
NOTE = os.path.join(ROOT, "notes", "2602.16666.json")
SEED = 20260926

with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")


def find_line(pattern):
    for i, s in enumerate(LINES):
        if re.search(pattern, s):
            return i
    raise SystemExit(f"找不到：{pattern}")


print("== 0. 從全文取定義與設定 ==")
i_def = find_line(r"C_\{\\text\{out\}\}=\\frac\{1\}\{T\}\\sum_\{t=1\}\^\{T\}\(2\\hat\{p\}_\{t\}-1\)\^\{2\}")
i_pt = find_line(r"Compute per-task success rate")
i_k = find_line(r"Each task is executed \$K=5\$ times")
i_ind = find_line(r"twelve concrete metrics that are independent of raw accuracy")
i_cap = find_line(r"all four dimensions are independent of raw capability")
i_c11 = find_line(r"normalized by the maximum possible variance at a given accuracy level")
for label, i in (("C_out 定義", i_def), ("p̂_t 與 0.25 正規化", i_pt), ("K=5", i_k),
                 ("引言：與準確率無關", i_ind), ("§2：與能力無關", i_cap), ("附錄 C.1.1", i_c11)):
    s = LINES[i].strip()
    print(f"  {label}：第 {i + 1} 行：{s[:200]}")
m = re.search(r"\$K=(\d+)\$", LINES[i_k])
K = int(m.group(1))
with open(NOTE, encoding="utf-8") as f:
    lim = json.load(f)["limitations_observed"]
assert "26 題×5 次" in lim[2], "筆記應寫 τ-bench 每模型 26 題×5 次"
T_TAU = 26
print(f"  K = {K}（第 {i_k + 1} 行）；τ-bench T = {T_TAU}（筆記 limitations_observed[2]「26 題×5 次」）")


def g(p):
    return (2 * p - 1) ** 2


def c_out(phat):
    return sum(g(p) for p in phat) / len(phat)


print("\n== 1. 推導與單題取值 ==")
print("  g(p)=(2p−1)²，g''=8>0 為凸函數；Jensen ⇒ mean g(p̂_t) ≥ g(mean p̂_t) = (2·acc−1)²")
print("  恆等式：mean (2p̂−1)² = (2·mean p̂ − 1)² + 4·Var_t(p̂)  ⇒ 等號成立 ⇔ 所有 p̂_t 相同")
vals = sorted({round(g(s / K), 10) for s in range(K + 1)})
print(f"  K={K} 時單題 (2p̂−1)² 的可能值：{vals}（共 {len(vals)} 個）")
print(f"  p̂=0（每次都失敗）→ {g(0.0)}；p̂=1（每次都成功）→ {g(1.0)}")
for acc in (0.1, 0.9):
    print(f"  acc={acc}：下限 (2·acc−1)² = {g(acc):.4f}")

print("\n== 2. 模擬（K=5，固定種子）==")
rng = random.Random(SEED)


def draw_p(kind, q, T):
    if kind == "同質":
        return [q] * T
    if kind == "Beta 分散":
        a = 2.0
        b = a * (1 - q) / q
        return [rng.betavariate(a, b) for _ in range(T)]
    if kind == "兩極 0/1":
        return [1.0 if rng.random() < q else 0.0 for _ in range(T)]
    if kind == "兩點混合":  # 各題以 1/2 機率取 p=q+d 或 p=q−d，d=min(q, 1−q)
        d = min(q, 1 - q)
        return [q + d if rng.random() < 0.5 else q - d for _ in range(T)]
    raise ValueError(kind)


REPS = 2000
worst_slack = float("inf")
worst_ident = 0.0
n_checked = 0
print(f"  {'分佈':<8}{'T':>4}{'q':>5}{'平均 acc':>10}{'平均 C_out':>12}{'平均下限':>10}{'最小(C_out−下限)':>18}")
for T in (T_TAU, 100):
    for kind in ("同質", "Beta 分散", "兩極 0/1", "兩點混合"):
        for q in (0.1, 0.3, 0.5, 0.7, 0.9):
            s_acc = s_c = s_lb = 0.0
            min_slack = float("inf")
            for _ in range(REPS):
                ps = draw_p(kind, q, T)
                phat = [sum(1 for _ in range(K) if rng.random() < p) / K for p in ps]
                acc = sum(phat) / T
                c = c_out(phat)
                lb = g(acc)
                var = sum((x - acc) ** 2 for x in phat) / T
                worst_ident = max(worst_ident, abs(c - (lb + 4 * var)))
                min_slack = min(min_slack, c - lb)
                s_acc += acc
                s_c += c
                s_lb += lb
                n_checked += 1
            worst_slack = min(worst_slack, min_slack)
            if T == T_TAU:
                print(f"  {kind:<8}{T:>4}{q:>5}{s_acc / REPS:>10.3f}{s_c / REPS:>12.3f}{s_lb / REPS:>10.3f}{min_slack:>18.4f}")
print(f"  （T=100 的結果也一起檢查，未逐列印出）共 {n_checked} 次模擬")
print(f"  全部模擬中最小的 C_out − (2·acc−1)² = {worst_slack:.3e}（≥ −1e-12：{worst_slack >= -1e-12}）")
print(f"  恆等式最大誤差 = {worst_ident:.2e}")

print("\n== 3. 可達性：K=5 格點上的最小 C_out ==")


def min_cout(S, T, K):
    """總成功次數 S 分到 T 題（每題 0..K 次）時的最小 C_out；g 凸，所以平均分配最小。"""
    lo, r = divmod(S, T)
    return ((T - r) * g(lo / K) + r * g((lo + 1) / K)) / T if lo < K else 1.0


def max_cout(S, T, K):
    """最大 C_out：盡量把題目推到 0 或 K 次。"""
    full, r = divmod(S, K)
    rest = T - full - (1 if r else 0)
    return (full * 1.0 + (g(r / K) if r else 0.0) + rest * 1.0) / T


T = T_TAU
print(f"  T={T}、K={K}：acc = S/(T·K)，S 為總成功次數")
print(f"  {'acc':>6}{'下限 (2acc−1)²':>16}{'可達最小 C_out':>16}{'可達最大 C_out':>16}{'下限可達':>10}")
for acc_target in (0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 0.9):
    S = round(acc_target * T * K)
    acc = S / (T * K)
    lb = g(acc)
    mn, mx = min_cout(S, T, K), max_cout(S, T, K)
    print(f"  {acc:>6.3f}{lb:>16.4f}{mn:>16.4f}{mx:>16.4f}{str(abs(mn - lb) < 1e-12):>10}")
print("  → acc 落在 1/K 的格點（0.2、0.8…）時所有題目 p̂ 相同即可達到下限；")
print("    acc=0.9 或 0.1 在 K=5 下最緊只能到 0.68（一半題目 p̂=0.8、一半 p̂=1.0），0.64 是 K→∞ 的極限。")

print("\n  同質 p=0.9 時 E[C_out] 的精確值（二項分佈加總）：")
for KK in (5, 20, 100, 1000):
    e = sum(math.comb(KK, s) * 0.9 ** s * 0.1 ** (KK - s) * g(s / KK) for s in range(KK + 1))
    print(f"    K={KK:<5} E[C_out] = {e:.4f}   (= 0.64 + 4·0.09/K = {0.64 + 0.36 / KK:.4f})")

print("\n== 4. 與準確率無關嗎？==")
mn50, mn90 = min_cout(round(0.5 * T * K), T, K), min_cout(round(0.9 * T * K), T, K)
print(f"  同一個 acc 下 C_out 的可行範圍（T={T}、K={K}）：acc=0.5 最低可到 {mn50:.2f}；acc=0.9 不可能低於 {mn90:.2f}。")
print("  由恆等式，題目間變異 Var_t(p̂) 相同的兩個 agent，C_out 只因 acc 不同就相差 (2·acc−1)² 那一項；")
print("  準確率本身就限制了 C_out 的範圍，C_out 不是與準確率無關的量。")

print("\n== 結論 ==")
print(f"  下限 C_out ≥ (2·acc−1)² 證實（{n_checked} 次模擬無一違反，恆等式誤差 {worst_ident:.1e}）；")
print("  acc=0.9 或 0.1 時下限 0.64 的算術正確，但在論文的 K=5 下達不到，最緊是 0.68。")
print(f"  引言第 {i_ind + 1} 行確實寫「twelve concrete metrics that are independent of raw accuracy」，與此下限相左。")
