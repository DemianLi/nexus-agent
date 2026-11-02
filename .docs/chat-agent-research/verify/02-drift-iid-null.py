#!/usr/bin/env python3
"""驗證：Drift No More 的「恢復力」迴歸在沒有任何動態的 i.i.d. 雜訊下也會得到 b≈−1、R²≈0.5。

主張（章節 02-dialogue-state-tracking.md〈多輪退化是累積的還是有界的〉的反證）：
  若 D_t 只是彼此獨立的雜訊，把 ΔD_t = D_{t+1} − D_t 對 D_t 做 OLS，必然得到 b≈−1、R²≈0.5；
  Table 6 的 b 與 R² 落在這個虛無模型附近，所以「b<0 證明有恢復力」沒有鑑別力。
出處：[arXiv:2510.07777] notes/2510.07777.json limitations_observed 第 1 條（精讀時的分析）。
缺口 C21：原稿說撰寫第 4 組草稿時跑過模擬，但 verify/ 裡沒有程式，也沒有把 Table 6 放進虛無分佈。

輸入從哪來（程式直接讀快取全文，不手抄）：
  - .cache/text/2510.07777.txt：ΔD_t 的定義（\\Delta D_{t}=D_{t+1}-D_{t}）、迴歸式（\\Delta D_{t}=a+bD_{t}+\\eta_{t}）、
    以 OLS 估計的說明，以及 Table 6（六列：GPT-4.1、LLaMA-3.1-70B、LLaMA-3.1-8B 各有 Baseline／Reminders）。
    快取裡每一列的 Model 與 Condition 各占一行（不以「|」開頭），數值格則是「| $x$」的行。程式從快取
    抽出每列的 Model 與 Condition，和下面的 LABELS 逐列 assert；另用 D̂* = −a/b 核對列內的一致性。
  - 合成任務是 8 輪（全文 §5「across 8 turns」）。論文沒報每個條件用了幾段對話（筆記 limitations_observed
    第 9 條），所以虛無分佈的樣本數 K（段數）只能掃描。

方法：
  1. 解析：D_t i.i.d.、變異數 σ² 時，cov(ΔD_t, D_t) = −σ²、Var(ΔD_t) = 2σ²，所以 b = −1、R² = 1/2。
     更一般地，平穩 AR(1)（D_{t+1} − μ = φ(D_t − μ) + ε）下 b = φ − 1、R² = (1 − φ)/2 = −b/2：
     b 接近 −1 等於說 φ 接近 0，也就是相鄰兩輪的散度幾乎不相關。
  2. 模擬：每段 8 輪、K 段疊在一起做一次 OLS（每段 7 組 (D_t, ΔD_t)）。K 取 1、5、20、100；
     雜訊分常態與對數常態（KL 恆正、右偏）兩種。每個設定 2,000 次，種子固定 20260926。
     另跑 φ = 0.5（有記憶也有恢復力）與 φ = 1（隨機漫步、沒有恢復力）當對照。
  3. 把 Table 6 六列的 b、R² 放進各設定的 95% 區間。

只用標準函式庫。執行（從研究根目錄）：python3 verify/02-drift-iid-null.py
"""

import math
import os
import random
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
txt = open(os.path.join(ROOT, ".cache", "text", "2510.07777.txt"), encoding="utf-8").read()
assert r"\Delta D_{t}=D_{t+1}-D_{t}" in txt, "ΔD_t 的定義"
assert r"\Delta D_{t}=a+bD_{t}+\eta_{t}" in txt, "迴歸式"
assert "ordinary least squares" in txt and "across 8 turns" in txt

lines = txt.split("\n")
i0 = next(k for k, l in enumerate(lines) if l.startswith("Table 6: Analysis of Equilibrium Dynamics"))
# 快取的表格轉檔：每列是「|」、Model、「|」、Condition，接著 7 個「| $x$」數值格，空行穿插其間。
toks = [l.strip() for l in lines[i0 + 1:i0 + 200] if l.strip()]
NCOL = 7
BLOCK = 4 + NCOL


def parse_block(block):
    assert block[0] == "|" and block[2] == "|", block[:4]
    assert not block[1].startswith("|") and not block[3].startswith("|"), block[:4]
    assert all(c.startswith("|") for c in block[4:]), block
    return block[1], block[3], [c.lstrip("|").strip() for c in block[4:]]


h_model, h_cond, header = parse_block(toks[:BLOCK])
assert (h_model, h_cond) == ("Model", "Condition"), (h_model, h_cond)
assert header[:4] == ["$a$", "$b$", r"$\hat{D}^{*}$", "$R^{2}$"], header
num = lambda s: float(s.strip("$").replace("−", "-"))
LABELS = ["GPT-4.1 Baseline", "GPT-4.1 Reminders", "LLaMA-3.1-70B Baseline",
          "LLaMA-3.1-70B Reminders", "LLaMA-3.1-8B Baseline", "LLaMA-3.1-8B Reminders"]
T6 = []
cache_labels = []
for j, lab in enumerate(LABELS):
    model, cond, row = parse_block(toks[BLOCK * (j + 1):BLOCK * (j + 2)])
    cache_labels.append(f"{model} {cond}")
    # 列名來自快取（快取寫 Llama，LABELS 寫 LLaMA，只差大小寫）
    assert cache_labels[-1].lower() == lab.lower(), (lab, model, cond)
    a, b, dstar, r2 = num(row[0]), num(row[1]), num(row[2]), num(row[3])
    assert abs(-a / b - dstar) < 0.01, (lab, a, b, dstar)  # 列內一致性：D̂* = −a/b
    T6.append((lab, b, r2))
nxt = toks[BLOCK * (len(LABELS) + 1)]
assert nxt != "|", f"Table 6 不只六列：{nxt}"
print(f"Table 6 從快取抽出的列名（與 LABELS 逐列相符）：{cache_labels}")

print("=" * 78)
print("一、Table 6（快取全文）與解析預期")
print("=" * 78)
print("i.i.d. 虛無模型的母體值：b = −1、R² = 0.5。平穩 AR(1) 下 b = φ − 1、R² = −b/2。")
print(f"{'列':<26}{'b':>8}{'R²':>8}{'隱含 φ=1+b':>12}{'AR(1) 的 R²=−b/2':>18}")
for lab, b, r2 in T6:
    ar_r2 = -b / 2
    note = "" if ar_r2 <= 1 else "（>1，任何平穩 AR(1) 都給不出這個 b）"
    print(f"{lab:<26}{b:8.3f}{r2:8.3f}{1 + b:12.3f}{ar_r2:18.3f}{note}")


def ols(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx
    r2 = sxy * sxy / (sxx * syy) if syy > 0 else 0.0
    return b, r2


def simulate(rng, K, T=8, phi=0.0, dist="normal"):
    xs, ys = [], []
    for _ in range(K):
        e = rng.gauss(0, 1)
        d = [e]
        for _ in range(T - 1):
            d.append(phi * d[-1] + rng.gauss(0, 1))
        if dist == "lognormal":
            d = [math.exp(v) for v in d]
        for t in range(T - 1):
            xs.append(d[t])
            ys.append(d[t + 1] - d[t])
    return ols(xs, ys)


def q(v, p):
    v = sorted(v)
    k = (len(v) - 1) * p
    f = math.floor(k)
    c = min(f + 1, len(v) - 1)
    return v[f] + (v[c] - v[f]) * (k - f)


rng = random.Random(20260926)
REPS = 2000
print()
print("=" * 78)
print(f"二、模擬（每段 8 輪，K 段合併做一次 OLS，{REPS} 次）")
print("=" * 78)
print(f"{'設定':<30}{'b 中位數':>9}{'b 95% 區間':>20}{'R² 中位數':>10}{'R² 95% 區間':>18}{'P(b<0)':>8}")
results = {}
configs = [(K, 0.0, d) for d in ("normal", "lognormal") for K in (1, 5, 20, 100)]
configs += [(20, 0.5, "normal"), (20, 1.0, "normal")]
for K, phi, dist in configs:
    bs, r2s = [], []
    for _ in range(REPS):
        b, r2 = simulate(rng, K, phi=phi, dist=dist)
        bs.append(b)
        r2s.append(r2)
    lab = f"{'i.i.d.' if phi == 0 else f'AR(1) φ={phi}'} {dist} K={K}"
    results[(K, phi, dist)] = (q(bs, .025), q(bs, .975), q(r2s, .025), q(r2s, .975))
    pneg = sum(b < 0 for b in bs) / REPS
    print(f"{lab:<30}{q(bs, .5):9.3f}   [{q(bs, .025):7.3f},{q(bs, .975):7.3f}]"
          f"{q(r2s, .5):10.3f}   [{q(r2s, .025):5.3f},{q(r2s, .975):5.3f}]{pneg:8.3f}")

print()
print("=" * 78)
print("三、Table 6 各列是否落在 i.i.d. 常態虛無模型的 95% 區間（b 與 R² 都要在區間內）")
print("=" * 78)
print(f"{'列':<26}" + "".join(f"{'K=' + str(K):>9}" for K in (1, 5, 20, 100)))
inside_counts = {}
for lab, b, r2 in T6:
    marks = []
    for K in (1, 5, 20, 100):
        blo, bhi, rlo, rhi = results[(K, 0.0, "normal")]
        ok = blo <= b <= bhi and rlo <= r2 <= rhi
        marks.append("在內" if ok else "在外")
        inside_counts.setdefault(K, 0)
        inside_counts[K] += ok
    print(f"{lab:<26}" + "".join(f"{m:>9}" for m in marks))
print("落在區間內的列數：" + "、".join(f"K={K}：{c}／6" for K, c in inside_counts.items()))

near = [lab for lab, b, r2 in T6 if abs(b + 1) < 0.06 and abs(r2 - 0.5) < 0.03]
print(f"b 與 −1 相差不到 0.06、R² 與 0.5 相差不到 0.03 的列：{near}")

print()
print("=" * 78)
print("結論")
print("=" * 78)
print("解析與模擬都證實：i.i.d. 雜訊下 b 的母體值是 −1、R² 是 0.5，而且 P(b<0) 在測過的每一種 K 下都接近 1，")
print("所以「b<0」本身分不出恢復力與沒有動態。Table 6 六列中 GPT-4.1 Baseline 與 70B Baseline 兩列")
print("（b −0.957、−1.049，R² 都是 0.494）正落在虛無模型的中心，在測過的 K = 1、5、20、100 下都在 95% 區間內；")
print("區間隨 K 變窄，K 再大時這兩列也可能落到區間外。隱含的 φ = 1 + b 都在 ±0.05 內，")
print("相鄰兩輪的散度幾乎不相關。其餘四列偏離虛無模型，但方向不是「有記憶的恢復」（那會讓 −1 < b < 0）：")
print("8B 兩列與 GPT-4.1 Reminders 的 b < −1，8B Reminders 的 −2.444 連平穩 AR(1) 都給不出來；")
print("70B Reminders 的 R² 0.278 則偏低。論文沒報段數，Table 6 在虛無分佈中的位置隨 K 改變。")
print("結論：證實（b≈−1、R²≈0.5 是 i.i.d. 的必然結果）；Table 6 只有兩列落在虛無模型中心，另四列另有偏離。")
