#!/usr/bin/env python3
"""驗證：OOOM Study 3 的邊際分佈偏移，以及 Cramér's V 相近能不能代表分佈相近。

主張（章節 06-user-simulator-feedback.md 的 OOOM 段與「關聯指標蓋得住邊際失真」）：
  - 精讀時依 Table 16 指出，同樣 1,782 筆完整個案上，GPT-3 的 White 0.974（ANES 0.803）、
    Graduate Degree 0.002（ANES 0.196）、年齡平均 35.5（ANES 50.1）、Male 0.759 對 0.481、
    Hispanic 0.001 對 0.089；自由取樣下 GPT-3 有 0.523 選第三人（ANES 0.078）。
  - Cramér's V 差值平均只有 −0.026，關聯指標把邊際偏移蓋住。
  - 精讀時指出：Cramér's V 經過邊際校正，對這種邊際偏移較不敏感。
出處：[arXiv:2209.06899]，notes/2209.06899.json 的 limitations_observed。

輸入（由程式從 .cache/text/2209.06899.txt 解析）：
  - Table 16（Study 3 descriptive statistics）的每一列：變數、來源、N、平均。
  - Table 17 的 Temp 0.7 平均誤差（−0.026）。
  - 附錄說明：Cramér's V 以 ANES 的「input」變數與 GPT-3 的「output」變數計算。

方法：
  1. 解析 Table 16，列出每個變數兩個來源的平均與差距，依差距排序，核對章節引用的數字。
  2. 構造確定性的例子：兩張 2×2 表（race：White／非 White × 投票：Trump／非 Trump），
     邊際分別取 ANES 的 (White 0.803, Trump 0.438) 與 GPT-3 的 (0.974, 0.245)，N = 1,782，
     在整數格數中挑出 V 最接近同一個目標值的那張，示範「V 幾乎相同、邊際差很多」。
  3. 計算兩組邊際下 2×2 表的 V（即 |φ|）可達的上限，示範極端邊際本身會壓低 V 的上限，
     所以「V 對邊際不敏感」並不精確；精確的說法是「V 相近不代表邊際相近」。

只用標準函式庫；沒有隨機數。執行：python3 verify/06-ooom-marginals-cramersv.py（研究根目錄）
"""

import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "2209.06899.txt")
with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")


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


a = find_line(r"^Table 16 presents the descriptive statistics")
b = find_line(r"^Table 16: Study 3 Descriptive Statistics", a)
T = {}
for r in blocks(a, b):
    if len(r) == 9 and r[1] in ("ANES", "GPT-3"):
        T.setdefault(r[0], {})[r[1]] = (int(r[2].replace(",", "")), float(r[3]))
print(f"Table 16（第 {a + 1}–{b + 1} 行）解析出 {len(T)} 個變數")
rows = []
for v, d in T.items():
    (na, ma), (ng, mg) = d["ANES"], d["GPT-3"]
    rows.append((v, na, ma, ng, mg, mg - ma))
binary = [r for r in rows if max(r[2], r[4]) <= 1.0]
print("\n二元變數依 |GPT-3 − ANES| 排序：")
for v, na, ma, ng, mg, d in sorted(binary, key=lambda r: -abs(r[5])):
    print(f"  {v:18s} ANES {ma:.3f}（N={na}）  GPT-3 {mg:.3f}（N={ng}）  差 {d:+.3f}")
print("非二元變數：")
for v, na, ma, ng, mg, d in rows:
    if max(ma, mg) > 1.0:
        print(f"  {v:18s} ANES {ma:.3f}  GPT-3 {mg:.3f}  差 {d:+.3f}")

cited = {"White": (0.803, 0.974), "Graduate Degree": (0.196, 0.002), "Male": (0.481, 0.759),
         "Hispanic": (0.089, 0.001), "Other Voter": (0.078, 0.523)}
ok = all(abs(T[k]["ANES"][1] - x) < 1e-9 and abs(T[k]["GPT-3"][1] - y) < 1e-9 for k, (x, y) in cited.items())
age_ok = round(T["Age"]["ANES"][1], 1) == 50.1 and round(T["Age"]["GPT-3"][1], 1) == 35.5
print(f"\n章節引用的六組數字與 Table 16 {'全部相符' if ok and age_ok else '有不符'}")

t17 = find_line(r"^Table 17: Average Error in Cramer")
blk = " ".join(LINES[t17 - 40:t17])
m17 = re.search(r"\| Mean\s+\| (-?\d\.\d+)\s+\| (-?\d\.\d+)\s+\| (-?\d\.\d+)", blk.replace("\n", " "))
if m17:
    print(f"Table 17（第 {t17 + 1} 行）V 差值平均：Temp 0.001 {m17.group(1)}、0.7 {m17.group(2)}、1.0 {m17.group(3)}")
ln_in = find_line(r"the Cramer’s V is calculated using the ANES “input” variable and the GPT-3 output")
print(f"第 {ln_in + 1} 行：正文的 V 以 ANES 的 input 變數與 GPT-3 的 output 變數計算")


# ---- 構造例子 ----
def v_2x2(a11, r1, c1, n):
    a12, a21 = r1 - a11, c1 - a11
    a22 = n - r1 - c1 + a11
    if min(a11, a12, a21, a22) < 0:
        return None
    return (a11 * a22 - a12 * a21) / math.sqrt(r1 * (n - r1) * c1 * (n - c1))


def closest(p, q, n, target):
    r1, c1 = round(p * n), round(q * n)
    best = None
    for a11 in range(0, min(r1, c1) + 1):
        v = v_2x2(a11, r1, c1, n)
        if v is None:
            continue
        if best is None or abs(v - target) < abs(best[1] - target):
            best = (a11, v)
    a11, v = best
    return r1, c1, a11, v


def phi_max(p, q):
    lo, hi = min(p, q), max(p, q)
    return math.sqrt(lo * (1 - hi) / (hi * (1 - lo)))


N = T["White"]["ANES"][0]
pA, qA = T["White"]["ANES"][1], T["Trump Voter"]["ANES"][1]
pG, qG = T["White"]["GPT-3"][1], T["Trump Voter"]["GPT-3"][1]
capA, capG = phi_max(pA, qA), phi_max(pG, qG)
TARGET = 0.05
print(f"\n構造例子（N = {N}；邊際取自 Table 16）：")
print(f"  ANES 邊際 White {pA}、Trump {qA}：2×2 表的正向 V 上限 {capA:.3f}")
print(f"  GPT-3 邊際 White {pG}、Trump {qG}：2×2 表的正向 V 上限 {capG:.3f}")
res = {}
for name, p, q in (("ANES 邊際", pA, qA), ("GPT-3 邊際", pG, qG)):
    r1, c1, a11, v = closest(p, q, N, TARGET)
    res[name] = v
    a12, a21, a22 = r1 - a11, c1 - a11, N - r1 - c1 + a11
    print(f"  {name}：[[{a11}, {a12}], [{a21}, {a22}]]  White {r1 / N:.3f}、Trump {c1 / N:.3f}、V = {v:.4f}")
dv = abs(res["ANES 邊際"] - res["GPT-3 邊際"])
print(f"  兩張表的 V 相差 {dv:.4f}，White 邊際相差 {pG - pA:.3f}、Trump 邊際相差 {qA - qG:.3f}")

print(f"\n結論：Table 16 的數字與章節引用相符，GPT-3 的邊際分佈大幅偏移（White 差 {pG - pA:+.3f}、Other Voter 差 "
      f"{T['Other Voter']['GPT-3'][1] - T['Other Voter']['ANES'][1]:+.3f}）；構造例子中兩組邊際的 V 只差 {dv:.4f}，證實「V 相近不代表邊際相近」。"
      f"但 GPT-3 邊際下 V 的上限只有 {capG:.3f}（ANES 邊際為 {capA:.3f}），極端邊際會壓低 V 可達的範圍，"
      "所以精讀時「V 對邊際偏移較不敏感」的說法要收窄成「V 的差值接近零，不代表邊際分佈一致」。")
