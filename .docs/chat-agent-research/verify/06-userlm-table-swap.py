#!/usr/bin/env python3
"""驗證：UserLM 的 Table 3（總體）與 Table 5（數學／程式分開）對不上，以及「對調後唯一解」。

主張（章節 06-user-simulator-feedback.md「表格與正文對不上的地方」）：
  %Repeat Required 對每段對話是二元值，數學與程式合併後的比例必須落在兩個分任務值之間；
  但 GPT-4o 模擬的數學 44.0、程式 12.2，總體卻是 9.4。精讀時推測數學列的兩格放反了；
  撰寫時以區間算術驗證，對調後唯一能同時算回三個總體值的是 20 題數學、其餘 45 題程式。
  原本只有四則運算經數字比對工具驗過，「唯一」沒有列舉。
出處：[arXiv:2510.06552]。

輸入（由程式從 .cache/text/2510.06552.txt 解析）：
  - 「we use 65 task intents」：數學加程式共 65 個任務意圖；每個意圖模擬 10 段對話。
  - Table 3：三個模擬器（4o-mini、GPT-4o、UserLM-8b）的總體值。
  - Table 5：同三個模擬器分數學與程式的值（Assistant Score 在 Table 5 是 0–1，Table 3 是百分比）。

方法：
  1. 每段對話權重相同、每個意圖 10 段，所以總體值 = (m × 數學 + (65 − m) × 程式) ÷ 65，m 是數學意圖數。
  2. 區間算術：表上的值都是四捨五入後的數字，各給半個末位的容許範圍；對 m = 0…65 逐一檢查
     預測區間與總體值的區間有沒有交集。
  3. 先用 %Repeat Required 以外、數學與程式都有值的「平均型」指標（Intent Coverage、%Add Demands、
     Assistant Score）逐一求相容的 m，看它們是否獨立地釘住 m。Turn Variance、Unigram Difference 不是逐段平均，不用。
  4. %Repeat Required：列舉「不對調」與九種單一對調（數學列內 3 種、程式列內 3 種、同一模擬器的數學↔程式 3 種），
     每種對調下求三個模擬器同時相容的 m。

只用標準函式庫；沒有隨機數。執行：python3 verify/06-userlm-table-swap.py（研究根目錄）
"""

import os
import re
from itertools import combinations

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "2510.06552.txt")
with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")

SIMS = ["4o-mini", "GPT-4o", "UserLM-8b"]


def find_line(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(LINES)):
        if rx.search(LINES[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def blocks(a, b):
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


def dec(s):
    return len(s.split(".")[1]) if "." in s else 0


li = find_line(r"we use (\d+) task intents")
N = int(re.search(r"we use (\d+) task intents", LINES[li]).group(1))
print(f"第 {li + 1} 行：共 {N} 個任務意圖（數學＋程式）")

t3 = find_line(r"^Table 3: Summary of results from simulated conversations")
s3 = find_line(r"^\| User Simulator", t3 - 80)
T3 = {}
for r in blocks(s3, t3):
    if len(r) == 4 and all(re.match(r"^\d+\.\d+$", x) for x in r[1:]):
        T3[r[0]] = r[1:]
t5 = find_line(r"^Table 5: Summary of evaluation metrics")
s5 = find_line(r"Task: Math", t5 - 120)
T5 = {}
for r in blocks(s5, t5):
    if len(r) == 7 and r[0] not in ("Metric",):
        T5[r[0]] = r[1:]
print(f"Table 3（第 {s3 + 1}–{t3 + 1} 行）：" + "；".join(f"{k} {v}" for k, v in T3.items()))
print(f"Table 5（第 {s5 + 1}–{t5 + 1} 行）：" + "；".join(f"{k} {v}" for k, v in T5.items()))


def interval(s, scale=1.0):
    v = float(s) * scale
    h = 0.5 * 10 ** -dec(s) * scale
    return v - h, v + h


def compatible_m(overall, math_s, code_s, scale=1.0):
    lo_o, hi_o = interval(overall)
    lo_m, hi_m = interval(math_s, scale)
    lo_c, hi_c = interval(code_s, scale)
    ok = []
    for m in range(N + 1):
        lo = (m * lo_m + (N - m) * lo_c) / N
        hi = (m * hi_m + (N - m) * hi_c) / N
        if hi >= lo_o - 1e-12 and lo <= hi_o + 1e-12:
            ok.append(m)
    return ok


def fmt(ms):
    if not ms:
        return "無"
    runs, a = [], ms[0]
    for x, y in zip(ms, ms[1:] + [None]):
        if y != x + 1:
            runs.append(f"{a}" if a == x else f"{a}–{x}")
            if y is not None:
                a = y
    return "、".join(runs)


print("\n步驟 3：其他平均型指標各自容許的數學意圖數 m")
SCALE = {"Assistant Score": 100.0}
cells, not20 = 0, []
for metric in ("Intent Coverage (%)", "%Add Demands", "Assistant Score"):
    for k, s in enumerate(SIMS):
        ms = compatible_m(T3[metric][k], T5[metric][k], T5[metric][k + 3], SCALE.get(metric, 1.0))
        cells += 1
        mark = "" if 20 in ms else "  ← m = 20 不相容"
        print(f"  {metric:20s} {s:9s}：m ∈ {{{fmt(ms)}}}{mark}")
        if 20 not in ms:
            sc = SCALE.get(metric, 1.0)
            pred = (20 * float(T5[metric][k]) * sc + (N - 20) * float(T5[metric][k + 3]) * sc) / N
            not20.append(f"{s} 的 {metric}（總體 {T3[metric][k]}，數學 {T5[metric][k]}、程式 {T5[metric][k + 3]}，m = 20 時應約 {pred:.2f}）")
print(f"  {cells} 格中 {cells - len(not20)} 格與 m = 20 相容；不相容的：" + ("；".join(not20) if not20 else "無"))

print("\n步驟 4：%Repeat Required 的對調假設")
R3 = T3["%Repeat Required"]
R5 = T5["%Repeat Required"]
math_row, code_row = R5[:3], R5[3:]
hyps = [("不對調", list(math_row), list(code_row))]
for i, j in combinations(range(3), 2):
    mr = list(math_row)
    mr[i], mr[j] = mr[j], mr[i]
    hyps.append((f"數學列 {SIMS[i]}↔{SIMS[j]}", mr, list(code_row)))
for i, j in combinations(range(3), 2):
    cr = list(code_row)
    cr[i], cr[j] = cr[j], cr[i]
    hyps.append((f"程式列 {SIMS[i]}↔{SIMS[j]}", list(math_row), cr))
for i in range(3):
    mr, cr = list(math_row), list(code_row)
    mr[i], cr[i] = cr[i], mr[i]
    hyps.append((f"{SIMS[i]} 數學↔程式", mr, cr))

survivors = []
for name, mr, cr in hyps:
    sets = [set(compatible_m(R3[k], mr[k], cr[k])) for k in range(3)]
    both = sorted(sets[0] & sets[1] & sets[2])
    per = "、".join(f"{SIMS[k]} {{{fmt(sorted(sets[k]))}}}" for k in range(3))
    print(f"  {name:22s} 三者共同 m：{{{fmt(both)}}}｜{per}")
    if both:
        survivors.append((name, both, mr, cr))

if len(survivors) == 1:
    sname, sboth, smr, scr = survivors[0]
    print(f"\n存活假設「{sname}」下，以 m = {fmt(sboth)} 代回（數值取自解析出的 Table 5，對調後）：")
    for k, s in enumerate(SIMS):
        for m in sboth:
            pred = (m * float(smr[k]) + (N - m) * float(scr[k])) / N
            ok = m in compatible_m(R3[k], smr[k], scr[k])
            print(f"  {s:9s}：({m} × {smr[k]} + {N - m} × {scr[k]}) ÷ {N} = {pred:.2f}；總體 {R3[k]}，"
                  f"區間算術下{'相容' if ok else '不相容'}")

only = survivors[0] if len(survivors) == 1 else None
if only and only[1] == [20]:
    verdict = (f"十種假設（不對調加九種單一對調）裡只有「{only[0]}」能讓三個總體值同時成立，而且只容許 m = 20，"
               f"章節的「唯一解」在單一對調的範圍內證實；其他平均型指標 {cells} 格中有 {cells - len(not20)} 格也與 m = 20 相容，"
               f"但另有 {len(not20)} 格在 m = 20 下同樣對不上，兩張表之間的不一致不只 %Repeat Required 這一處。")
else:
    verdict = f"存活的假設：{survivors}。章節的「唯一解」不成立或需改寫。"
print(f"\n結論：原表不對調時沒有任何 m 能同時算回三個總體值，表格確實有錯；{verdict}")
