#!/usr/bin/env python3
"""驗證：MemoryBank 公開程式碼的遺忘式 exp(-t/5*S)，依運算順序會讓召回越多次的記憶忘得越快。

主張（章節 02-dialogue-state-tracking.md〈2023 年 5 月：分層摘要加遺忘曲線〉與跨子領域表 MemoryBank 列）：
  論文的保留率是 R = e^(−t/S)，記憶被召回一次 S 加 1、t 歸零，所以召回越多次忘得越慢；
  精讀時發現公開程式碼寫成 exp(-t/5*S)，依運算順序等於 exp(−t·S/5)，方向相反。
出處：[arXiv:2305.10250] notes/2305.10250.json limitations_observed 第 2 條（精讀時的分析）。
缺口 C23：這條主張有兩半。算術那一半（運算子優先順序與單調性）可以確定性地驗；程式碼那一行
本身只來自筆記的轉述，快取沒有程式碼，這一半無法判定。和 SUMBT 那條（02-sumbt-floor-div.py）同樣處理。

輸入從哪來：
  - .cache/text/2305.10250.txt §2.3：R=e^{-\\frac{t}{S}}、S 初始為 1、召回時 S 加 1 並把 t 歸零。
  - notes/2305.10250.json limitations_observed（含「exp(」的那一條）：程式碼寫法「exp(-t/5*S)」、筆記照程式碼
    寫法算出的兩個數（S=3、t=7 天時 R≈0.015；S=1 時 R≈0.247），以及照論文公式 S=1、t=7 天時 R≈0.0009。
    程式用正則從筆記原句抽出程式碼寫法、三個數字，以及它們對應的 S 與 t，不手抄。

只用標準函式庫；沒有隨機數。執行（從研究根目錄）：python3 verify/02-memorybank-forgetting.py
"""

import ast
import json
import math
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
txt = open(os.path.join(ROOT, ".cache", "text", "2305.10250.txt"), encoding="utf-8").read()
note = json.load(open(os.path.join(ROOT, "notes", "2305.10250.json"), encoding="utf-8"))
obs = next(x for x in note["limitations_observed"] if "exp(" in x)

assert r"R=e^{-\frac{t}{S}}" in txt, "論文公式"
assert "We increase $S$ by 1 and reset $t$ to 0" in txt, "召回時 S 加 1、t 歸零"
code = re.search(r"exp\(([^)]*)\)", obs).group(1)
print(f"筆記轉述的程式碼寫法：exp({code})")
print("論文公式（快取全文 §2.3）：R = e^(−t/S)；S 初始 1，召回一次 S 加 1、t 歸零")

print()
print("=" * 72)
print("一、運算子優先順序：用 Python 的語法樹看 -t/5*S 怎麼結合")
print("=" * 72)
tree = ast.parse(code, mode="eval").body
print(ast.dump(tree))
is_left_assoc = (isinstance(tree, ast.BinOp) and isinstance(tree.op, ast.Mult)
                 and isinstance(tree.left, ast.BinOp) and isinstance(tree.left.op, ast.Div)
                 and isinstance(tree.right, ast.Name) and tree.right.id == "S")
print(f"結合方式是 ((−t)/5)*S：{is_left_assoc}（也就是 −t·S/5，不是 −t/(5·S)）")
# 同為左結合、同優先序的 * 與 / 在 C、Java、JavaScript 也一樣；numpy 只是逐元素套用同一條式子。

code_R = lambda t, S: math.exp(eval(code, {}, {"t": t, "S": S}))
paper_R = lambda t, S: math.exp(-t / S)
alt_R = lambda t, S: math.exp(-t / (5 * S))  # 若本意是 5·S 在分母

print()
print("=" * 72)
print("二、t = 7（天）時，S 從 1 到 5 的保留率")
print("=" * 72)
print(f"{'S':>3}{'程式碼 exp(-t/5*S)':>22}{'論文 e^(−t/S)':>16}{'若是 exp(-t/(5S))':>20}")
for S in range(1, 6):
    print(f"{S:>3}{code_R(7, S):22.4f}{paper_R(7, S):16.6f}{alt_R(7, S):20.4f}")

Ss = range(1, 11)
ts = [0.5, 1, 3, 7, 14, 30]
code_dec = all(code_R(t, S + 1) < code_R(t, S) for t in ts for S in Ss)
paper_inc = all(paper_R(t, S + 1) > paper_R(t, S) for t in ts for S in Ss)
alt_inc = all(alt_R(t, S + 1) > alt_R(t, S) for t in ts for S in Ss)
print()
print(f"t ∈ {ts}、S = 1..11：程式碼寫法隨 S 嚴格遞減：{code_dec}；論文公式隨 S 嚴格遞增：{paper_inc}；"
      f"exp(-t/(5S)) 隨 S 嚴格遞增：{alt_inc}")

print()
print("=" * 72)
print("三、核對筆記算出的數字")
print("=" * 72)
# 從筆記原句抽數字：「S=3、t=7 天時 R≈0.015，S=1 時是 0.247」與「S=1 的記憶 7 天後 R≈0.0009」
m_code = re.search(r"S=(\d+)、t=(\d+) 天時 R≈([\d.]+)，S=(\d+) 時是 ([\d.]+)", obs)
m_paper = re.search(r"照論文公式.*?S=(\d+) 的記憶 (\d+) 天後 R≈([\d.]+)", obs)
assert m_code and m_paper, "筆記原句的格式變了"
s_a, t_code, r_a, s_b, r_b = m_code.groups()
s_p, t_p, r_p = m_paper.groups()
checks = [(f"程式碼 S={s_a}、t={t_code}", code_R(int(t_code), int(s_a)), r_a),
          (f"程式碼 S={s_b}、t={t_code}", code_R(int(t_code), int(s_b)), r_b),
          (f"論文 S={s_p}、t={t_p}", paper_R(int(t_p), int(s_p)), r_p)]
print(f"從筆記抽出的三個數字：{[c[2] for c in checks]}")
all_ok = True
for lab, v, claimed in checks:
    digits = len(claimed.split(".")[1])
    ok = round(v, digits) == float(claimed)
    all_ok &= ok
    print(f"  {lab}：{v:.6f}，筆記寫 ≈{claimed}，四捨五入到同位數後相符：{ok}")

print()
print("=" * 72)
print("結論")
print("=" * 72)
print(f"算術那一半證實：exp({code}) 依運算順序是 exp(−t·S/5)，隨召回次數 S 遞減（{code_dec}），")
print(f"與論文 e^(−t/S) 隨 S 遞增（{paper_inc}）方向相反；筆記的三個數字都重現（{all_ok}）。")
print("程式碼那一行本身無法判定：快取只有論文全文，沒有 MemoryBank 的程式碼，這一半只來自筆記的轉述。")
print("結論：算術證實、程式碼原文無法判定。")
