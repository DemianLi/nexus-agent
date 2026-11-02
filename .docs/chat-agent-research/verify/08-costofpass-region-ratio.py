#!/usr/bin/env python3
"""驗證：Cost-of-Pass 的 frontier 數值有多少是人類回落成本傳過來的（美國與印度行情的逐格比值）。

主張（章節 08-task-completion-score.md 陷阱十「frontier 的數值多半是人類成本傳過來的」與爭議第九條的算式）：
  - 精讀時依論文 C.6 的印度行情表重算，認為 Table 1 近似於「8 次都沒解出的題目比例 × 人類時薪」。
  - 組章時逐格比較美國（Table 1）與印度（Table 11）行情：GSM8K 上 Llama-3.1-8B 是 0.19 ÷ 0.031 ≈ 6.1，
    人類 3.50 ÷ 0.56 = 6.25；MATH-500 上 DeepSeek-R1 是 0.21 ÷ 0.062 ≈ 3.4，人類 12 ÷ 2.73 ≈ 4.4；
    GPQA 上 o1 是 8.07 ÷ 4.24 ≈ 1.9，人類 58 ÷ 29.17 ≈ 1.99；BBQ 上 GPT-4o 從 6.2e-3 只降到 0.005，
    人類 0.10 ÷ 0.034 ≈ 2.94。
  - 章節據此的結論：多數模型的 frontier 值大半由人類回落成本主導，但在 BBQ 與最強的推理模型上，
    模型本身的成本占比明顯較大。
出處：[arXiv:2504.13359] 全文 Table 1（美國行情的 frontier）、Table 3（美國人類成本）、
  Table 10（印度人類成本）、Table 11（印度行情的 frontier），以及第 1527 行「人類成本取區間上限」。

判準（看結果之前先定）：
  - 每一格的 frontier 是逐題 min(模型的 cost-of-pass, 人類成本) 的平均。人類成本從美國降到印度時，
    每題的比值 min(v, H_US)/min(v, H_IN) 都不大於 H_US/H_IN，所以模型的比值 r_m = T1/T11
    不大於人類的比值 r_h = H_US/H_IN（捨入誤差除外）。
  - 定義 ρ = r_m / r_h。frontier 若完全由人類成本決定，ρ = 1；若完全由模型成本決定（兩區都不回落），
    r_m = 1、ρ = 1/r_h。
  - 判定：ρ ≥ 0.85 算「人類成本主導」；ρ < 0.85 算「模型成本占比明顯」。
  - 捨入：兩張表的每個數字都依印出的位數取 ±半個末位，算出 ρ 的區間；區間跨過 0.85 的格子
    判為「精度不足，無法判定」，不下結論。Table 11 有很多格只剩一位有效數字。

只用標準函式庫；沒有隨機數。執行：python3 verify/08-costofpass-region-ratio.py
"""

import os
import re
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
with open(os.path.join(ROOT, ".cache", "text", "2504.13359.txt"), encoding="utf-8") as f:
    L = f.read().split("\n")

THRESH = 0.85
DS = ["2-Digit Add.", "GSM8K", "BBQ", "GPQA Dia.", "MATH 500", "AIME24"]


def find(pat, start=0, end=None):
    for i in range(start, end if end is not None else len(L)):
        if re.search(pat, L[i]):
            return i
    raise SystemExit("找不到：" + pat)


def parse_val(s):
    """回傳 (值, 半個末位)。支援 0.19、$4.8\\text{\\times}{10}^{-5}$ 兩種寫法。"""
    s = s.strip()
    m = re.match(r"^\$(\d+(?:\.\d+)?)\\text\{\\times\}\{10\}\^\{(-?\d+)\}\$$", s)
    if m:
        mant, ex = Decimal(m.group(1)), int(m.group(2))
        ulp = Decimal(1).scaleb(mant.as_tuple().exponent + ex)
        return float(mant.scaleb(ex)), float(ulp) / 2
    m = re.match(r"^(\d+(?:\.\d+)?)$", s)
    if m:
        d = Decimal(m.group(1))
        return float(d), float(Decimal(1).scaleb(d.as_tuple().exponent)) / 2
    raise SystemExit("看不懂的數字：" + s)


def parse_frontier(cap_pat):
    cap = find(cap_pat)
    top = find(r"^\| Lightweight Models$", cap - 120, cap)
    rows = {}
    i = top
    while i < cap:
        m = re.match(r"^\| [    ]*([A-Z][\w .\-]+)$", L[i])
        if m and not m.group(1).endswith("Models") and i + 6 < cap:
            vals = [L[i + j][2:] for j in range(1, 7)]
            if all(L[i + j].startswith("| ") for j in range(1, 7)):
                rows[m.group(1).strip()] = [parse_val(v) for v in vals]
                i += 7
                continue
        i += 1
    return cap, rows


cap1, T1 = parse_frontier(r"^Table 1: Frontier dollar cost-of-pass per model")
cap11, T11 = parse_frontier(r"^Table 11: Using the same experimental setup as in Table 1")
assert len(T1) == len(T11) == 10 and T1.keys() == T11.keys(), (len(T1), len(T11))
print(f"== 原文 ==\n  Table 1：第 {cap1 + 1} 行的表題上方，解析到 {len(T1)} 個模型")
print(f"  Table 11：第 {cap11 + 1} 行的表題上方，解析到 {len(T11)} 個模型")
up = find(r"set the rates to the upper-bound value")
print(f"  第 {up + 1} 行：人類成本取區間上限（upper-bound value）")

# 人類成本：Table 3（美國）與 Table 10（印度），取區間上限
cap3 = find(r"^Table 3: Estimated costs of hiring a human expert")
cap10 = find(r"^Table 10: Human-expert cost estimation when the region is changed to India")
LABEL = {"AIME24": "AIME", "BBQ": "BBQ", "GPQA Dia.": "GPQA Dia.", "GSM8K": "GSM8K",
         "MATH 500": "MATH500", "2-Digit Add.": "Two-Digit Add."}


def upper(s):
    return float(re.findall(r"\$(\d+(?:\.\d+)?)", s)[-1])


def human(cap, need_minutes):
    out = {}
    for ds, lab in LABEL.items():
        i = find(r"^\| " + re.escape(lab) + r"$", cap - 80, cap)
        if need_minutes:
            i = find(r"minutes", i, cap)
        j = find(r"^\| \$\d", i + 1, cap)
        out[ds] = upper(L[j])
    return out


H_US, H_IN = human(cap3, True), human(cap10, False)
print("  人類成本（美國／印度，取上限）：" + "；".join(f"{d} {H_US[d]:g}／{H_IN[d]:g}" for d in DS))

# ---------------------------------------------------------------- 逐格
print(f"\n== 逐格 ρ = (T1/T11) / (H_US/H_IN)，門檻 {THRESH} ==")
print("  " + f"{'模型':<20}" + "".join(f"{d:>16}" for d in DS))
verdict = {}
for name in T1:
    cells = []
    for j, d in enumerate(DS):
        (a, ua), (b, ub) = T1[name][j], T11[name][j]
        rh = H_US[d] / H_IN[d]
        rho = a / b / rh
        lo = (a - ua) / (b + ub) / rh
        hi = (a + ua) / (b - ub) / rh if b - ub > 0 else float("inf")
        if lo >= THRESH:
            v = "人"
        elif hi < THRESH:
            v = "模"
        else:
            v = "?"
        verdict[(name, d)] = (v, rho, lo, hi, a, b)
        cells.append(f"{rho:>6.2f}[{lo:.2f},{min(hi, 9.99):.2f}]{v}")
    print("  " + f"{name:<20}" + "".join(f"{c:>16}" for c in cells))
print("  標記：人＝人類成本主導（ρ 區間全部 ≥ 0.85）；模＝模型成本占比明顯（區間全部 < 0.85）；?＝精度不足")

print("\n== 各資料集的計數（人／模／?）==")
count = {}
for d in DS:
    c = {k: sum(1 for n in T1 if verdict[(n, d)][0] == k) for k in "人模?"}
    count[d] = c
    print(f"  {d:<14} 人 {c['人']:>2}  模 {c['模']:>2}  ? {c['?']:>2}   人類比值 r_h = {H_US[d]:g} ÷ {H_IN[d]:g} = {H_US[d] / H_IN[d]:.2f}")
tot = {k: sum(count[d][k] for d in DS) for k in "人模?"}
print(f"  合計 60 格：人 {tot['人']}、模 {tot['模']}、? {tot['?']}")

# ---------------------------------------------------------------- 對照章節的四個例子
print("\n== 章節引用的四格 ==")
for name, d, txt in (("Llama-3.1-8B", "GSM8K", "0.19 ÷ 0.031 ≈ 6.1，人類 6.25"),
                     ("DeepSeek-R1", "MATH 500", "0.21 ÷ 0.062 ≈ 3.4，人類 ≈ 4.4"),
                     ("OpenAI o1", "GPQA Dia.", "8.07 ÷ 4.24 ≈ 1.9，人類 ≈ 1.99"),
                     ("GPT-4o", "BBQ", "6.2e-3 → 0.005，人類 ≈ 2.94")):
    v, rho, lo, hi, a, b = verdict[(name, d)]
    print(f"  {d} {name}：{a:g} ÷ {b:g} = {a / b:.2f}，人類 {H_US[d] / H_IN[d]:.2f}，ρ = {rho:.2f}"
          f"（區間 {lo:.2f}–{min(hi, 9.99):.2f}，判定 {v}）｜章節：{txt}")

# ---------------------------------------------------------------- 章節結論
reasoning = ["OpenAI o1", "OpenAI o3-mini", "DeepSeek-R1", "OpenAI o1-mini"]
non_trivial = [d for d in DS if d != "2-Digit Add."]
nt = {k: sum(count[d][k] for d in non_trivial) for k in "人模?"}
print("\n== 對照章節結論 ==")
print(f"  2-Digit Add. 以外的 50 格：人 {nt['人']}、模 {nt['模']}、? {nt['?']}")
print(f"  2-Digit Add.：人 {count['2-Digit Add.']['人']}、模 {count['2-Digit Add.']['模']}、? {count['2-Digit Add.']['?']}")
# 2-Digit Add. 兩張表逐格比較：印出的值完全相同、只在 ±半個末位的捨入區間內重疊、區間不重疊
j2 = DS.index("2-Digit Add.")
same, overlap, differ = [], [], []
for name in T1:
    (a, ua), (b, ub) = T1[name][j2], T11[name][j2]
    if a == b:
        same.append(name)
    elif a - ua <= b + ub and b - ub <= a + ua:
        overlap.append(f"{name}（{a:g} 對 {b:g}）")
    else:
        differ.append(f"{name}（{a:g} 對 {b:g}）")
print(f"  2-Digit Add. 兩張表的值：完全相同 {len(same)} 個：{'、'.join(same) or '無'}")
print(f"    只在捨入範圍內一致 {len(overlap)} 個：{'、'.join(overlap) or '無'}")
print(f"    捨入區間不重疊 {len(differ)} 個：{'、'.join(differ) or '無'}")
print(f"  BBQ：人 {count['BBQ']['人']}、模 {count['BBQ']['模']}、? {count['BBQ']['?']}")
# 逐資料集：人類成本主導的格數是否超過 10 個模型的一半
over_half = {d: count[d]["人"] > len(T1) / 2 for d in DS}
print("  逐資料集「人類成本主導的格數超過一半」：" +
      "；".join(f"{d} {count[d]['人']}/{len(T1)} {'是' if over_half[d] else '否'}" for d in DS))
rs = {d: [verdict[(n, d)][0] for n in reasoning] for d in non_trivial}
print("  推理模型（o1、o3-mini、R1、o1-mini）在 2-Digit Add. 以外各資料集的判定：" +
      "；".join(f"{d} {''.join(v)}" for d, v in rs.items()))
det = nt["人"] + nt["模"]
majority = det > 0 and nt["人"] / det > 0.5
bbq_model = count["BBQ"]["模"] > count["BBQ"]["人"]
two_digit_model = count["2-Digit Add."]["模"] > count["2-Digit Add."]["人"]
print(f"  可判定的格子中，人類成本主導的比例（2-Digit Add. 以外）：{nt['人']}/{det}")
print("\n== 結論 ==")
print(f"  「多數模型的 frontier 大半由人類成本主導」：在 2-Digit Add. 以外{'成立' if majority else '不成立'}；"
      f"2-Digit Add. 上{'反而是模型成本主導' if two_digit_model else '也成立'}")
print(f"  「BBQ 上模型成本占比明顯較大」：{'成立' if bbq_model else '不成立'}")
print("  逐資料集看，多數模型（超過 10 個的一半）由人類成本主導的資料集：" +
      "、".join(d for d in DS if over_half[d]) +
      "；不到或剛好一半的：" + "、".join(d for d in DS if not over_half[d]))
if majority and bbq_model and two_digit_model:
    print("結論：部分證實——人類成本主導在 2-Digit Add. 以外的多數可判定格子成立、BBQ 例外也成立；"
          "但 2-Digit Add. 是模型成本主導，原句要把這個資料集排除，另有多格因 Table 11 精度不足無法判定；"
          "逐資料集看，多數模型由人類成本主導的只有 " + "、".join(d for d in DS if over_half[d]))
elif majority and bbq_model:
    print("結論：證實——人類成本主導與 BBQ 例外都成立")
else:
    print("結論：推翻——見上方逐格判定")
