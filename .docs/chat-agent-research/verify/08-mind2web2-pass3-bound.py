#!/usr/bin/env python3
"""驗證：Mind2Web 2 的 pass^3 雖然推不出點值，但推得出界限；「三次都成功不到四分之一」。

主張（章節 08-task-completion-score.md 爭議第二條末段，組章時依 Table 3 推導）：
  - 每題三次中成功 c 次，SR 的三次平均是 E[c]/3，Pass@3 是 c≥1 的題目比例，
    因此 pass^3 ≥ 3·SR − 2·Pass@3，且 pass^3 ≤ (3·SR − Pass@3)/2。
  - OpenAI DR 代入點值得 0.04 到 0.22；以 120 題的整數成功次數處理捨入後是 3/120 到 27/120。
  - 就算是最好的系統，三次都成功的題目也不到四分之一；其餘九個系統的下界都是 0。
出處：[arXiv:2506.21506] 全文 Table 3（第 422 行起）、第 391 行（private test set 120 題）、
  第 400 行（每個系統每題獨立跑三次、Pass@3 的定義）。

critic 指出：直接代入點值時，Grok DeeperSearch 的下界是 3×0.27−2×0.40＝0.01，不是 0；
「其餘九個系統的下界都是 0」要靠沒寫出來的捨入處理才成立。本程式把兩種口徑都算出來。

方法：
  1. 從 .cache/text/2506.21506.txt 解析 Table 3 的 11 列（10 個系統＋Human），取 SR 與 Pass@3。
  2. 口徑一（點值）：直接代入 3·SR−2·P3 與 (3·SR−P3)/2，下界再與 0 取大、上界再與 P3 取小。
  3. 口徑二（整數計數，閉區間捨入）：120 題 × 3 次＝360 次，總成功次數 S 滿足
     |S/360 − SR| ≤ 0.005；至少成功一次的題數 m 滿足 |m/120 − P3| ≤ 0.005。
     對每組可行的 (S, m)（還要 m ≤ S ≤ 3m），三次全成功的題數 t 滿足
     max(0, S−2m) ≤ t ≤ min(m, ⌊(S−m)/2⌋)；取所有可行組合的最小下界與最大上界，再除以 120。
  4. Human 列只在 Subset-30、三個不同的人各做一次（精讀時發現），不適用上面的模型，只印出不納入。

只用標準函式庫；沒有隨機數。執行：python3 verify/08-mind2web2-pass3-bound.py
"""

import math
import os
import re
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
with open(os.path.join(ROOT, ".cache", "text", "2506.21506.txt"), encoding="utf-8") as f:
    L = f.read().split("\n")


def find(pat, start=0):
    for i in range(start, len(L)):
        if re.search(pat, L[i]):
            return i
    raise SystemExit("找不到：" + pat)


i120 = find(r"private test set \( \$120\$ tasks\)")
i3 = find(r"we introduce Pass@3, indicating whether at least one of the three attempts")
cap = find(r"^Table 3: Main evaluation results")
end = find(r"^As shown in Table 3", cap)
print(f"== 原文 ==\n  第 {i120 + 1} 行：private test set（120 題）\n  第 {i3 + 1} 行：Pass@3 的定義"
      f"\n  Table 3：第 {cap + 1}–{end} 行")

NUM = r"^\| \$(\d+\.\d+)\$"
rows = []
i = cap
while i < end:
    m = re.match(r"^\| ([A-Z][A-Za-z .*]+)$", L[i])
    if m and i + 3 < end:
        pc, sr, p3 = (re.match(NUM, L[i + j]) for j in (1, 2, 3))
        if pc and sr and p3:
            rows.append((m.group(1).strip(), float(pc.group(1)), F(sr.group(1)), F(p3.group(1))))
            i += 4
            continue
    i += 1
print(f"  解析到 {len(rows)} 列")
assert len(rows) == 11, "Table 3 應有 10 個系統加 Human"

N_TASK, RUNS = 120, 3
HALF = F(5, 1000)


def int_bounds(sr, p3):
    s_lo = math.ceil((sr - HALF) * N_TASK * RUNS)
    s_hi = math.floor((sr + HALF) * N_TASK * RUNS)
    m_lo = math.ceil((p3 - HALF) * N_TASK)
    m_hi = math.floor((p3 + HALF) * N_TASK)
    lo = hi = None
    feas = 0
    for S in range(s_lo, s_hi + 1):
        for m in range(m_lo, m_hi + 1):
            if not (m <= S <= 3 * m):
                continue
            t_lo, t_hi = max(0, S - 2 * m), min(m, (S - m) // 2)
            if t_lo > t_hi:
                continue
            feas += 1
            lo = t_lo if lo is None else min(lo, t_lo)
            hi = t_hi if hi is None else max(hi, t_hi)
    return (s_lo, s_hi), (m_lo, m_hi), lo, hi, feas


print(f"\n  {'系統':<26}{'SR':>6}{'P@3':>6}{'點值下界':>9}{'點值上界':>9}{'S 範圍':>12}{'m 範圍':>10}"
      f"{'整數下界':>15}{'整數上界':>15}")
res = {}
for name, pc, sr, p3 in rows:
    if name.startswith("Human"):
        print(f"  {name:<26}{float(sr):>6.2f}{float(p3):>6.2f}  （Subset-30、三個不同的人各做一次，不納入）")
        continue
    raw_lo = 3 * sr - 2 * p3
    p_lo, p_hi = max(F(0), raw_lo), min(p3, (3 * sr - p3) / 2)
    (s_lo, s_hi), (m_lo, m_hi), lo, hi, feas = int_bounds(sr, p3)
    res[name] = (raw_lo, p_lo, p_hi, lo, hi)
    print(f"  {name:<26}{float(sr):>6.2f}{float(p3):>6.2f}{float(raw_lo):>+9.2f}{float(p_hi):>9.3f}"
          f"{f'{s_lo}–{s_hi}':>12}{f'{m_lo}–{m_hi}':>10}{f'{lo}/120={lo / 120:.3f}':>15}{f'{hi}/120={hi / 120:.3f}':>15}")

odr = res["OpenAI Deep Research"]
print("\n== 對照章節 ==")
print(f"  OpenAI DR 點值：下界 3×0.28−2×0.40 = {float(odr[0]):.2f}，上界 (3×0.28−0.40)/2 = {float(odr[2]):.2f}")
print(f"  OpenAI DR 整數計數：{odr[3]}/120 = {odr[3] / 120:.3f} 到 {odr[4]}/120 = {odr[4] / 120:.3f}")
ch_odr = abs(float(odr[0]) - 0.04) < 1e-9 and abs(float(odr[2]) - 0.22) < 1e-9 and odr[3] == 3 and odr[4] == 27

others = {k: v for k, v in res.items() if k != "OpenAI Deep Research"}
pos_point = [k for k, v in others.items() if v[0] > 0]
pos_int = [k for k, v in others.items() if v[3] > 0]
print(f"  其餘九個系統中，點值下界 > 0 的：{pos_point or '無'}"
      + "".join(f"（{k}：3×{float(rows[[r[0] for r in rows].index(k)][2]):.2f}−2×"
                f"{float(rows[[r[0] for r in rows].index(k)][3]):.2f} = {float(others[k][0]):+.2f}）" for k in pos_point))
print(f"  其餘九個系統中，整數計數下界 > 0 的：{pos_int or '無'}")
max_hi = max(v[4] for v in res.values())
max_hi_pt = max(v[2] for v in res.values())
who = [k for k, v in res.items() if v[4] == max_hi]
print(f"  十個系統的整數上界最大是 {max_hi}/120 = {max_hi / 120:.3f}（{who}）；點值上界最大是 {float(max_hi_pt):.3f}")
quarter = max_hi / 120 < 0.25 and max_hi_pt < F(1, 4)

print("\n== 結論 ==")
print(f"  OpenAI DR 的兩組界限與章節一致：{ch_odr}")
print(f"  「十個系統三次都成功的比例都不到四分之一」：{'證實' if quarter else '推翻'}（兩種口徑都成立）")
print(f"  「其餘九個系統的下界都是 0」：點值口徑下{'不成立' if pos_point else '成立'}，"
      f"整數計數（閉區間捨入）口徑下{'不成立' if pos_int else '成立'}")
if ch_odr and quarter and pos_point and not pos_int:
    print("結論：部分證實——界限與「不到四分之一」成立；「其餘九個下界都是 0」只在整數計數處理捨入時成立，"
          f"直接代入點值時 {'、'.join(pos_point)} 的下界大於 0")
elif ch_odr and quarter and not pos_point:
    print("結論：證實——界限、「不到四分之一」與「其餘九個下界都是 0」在兩種口徑下都成立")
else:
    print("結論：推翻——OpenAI DR 的界限或「不到四分之一」與章節不符，見上方數字")
