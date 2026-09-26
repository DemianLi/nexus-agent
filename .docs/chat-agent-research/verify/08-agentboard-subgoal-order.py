#!/usr/bin/env python3
"""驗證：AgentBoard 的 r^subgoal「論文寫依序，程式碼不檢查順序」（只驗論文那一半）。

主張（章節 08-task-completion-score.md 第 172 行）：
  AgentBoard 官方程式碼 main @bb7255e 在 AlfWorld 與 Jericho 上，只要任一觀測符合任一子目標
  regex 就永久記一分，不檢查論文所說的子目標順序。
出處：[arXiv:2401.13178] 精讀筆記 notes/2401.13178.json 的 limitations_observed 第 6 條
  （「論文說子目標『一個接一個』，但實作是無序集合」），以及 method 欄「實作上的真實語意」。

輸入從哪來：
  - .cache/text/2401.13178.txt 的 §2 progress rate 段落：Eq. (2) 的 LaTeX 原文、
    「sequence of subgoals ... with each subgoal leading into the next」、「unique subgoal sequence」。
  - .cache/text/2401.13178.txt 的附錄 L.1（「Unique」Subgoal Sequence 的說明）、L.2 Alfworld 與 L.5 Jericho。
  - 程式碼那一半（bb7255e 的評分函式）需要 hkust-nlp/AgentBoard repo，本程式依規則不下載，
    所以不處理；結論標「無法判定」。

方法：
  1. 在全文找出論文描述子目標「有順序」的句子，與描述成「集合」的句子。
  2. 解析 Eq. (2) 的 r^subgoal：檢查式子裡有沒有任何依賴子目標索引順序的項
     （例如 g_{k-1}、前綴條件、k 的上下界依賴 i）。只有「max over i」與「Σ_k f(s_i, g_k)」時，
     式子對 k 的任意排列不變，也就是式子本身不檢查順序。
  3. 用一條合成軌跡具體示範：照 Eq. (2) 字面實作（每步只看該步狀態 s_i），以及照筆記描述的
     「曾經命中的子目標集合 / K」實作，各餵正序與逆序兩條觀測序列，比較 PR。
     這一步只示範「兩種讀法都與順序無關」，不是在驗官方程式碼。

只用標準函式庫；沒有隨機數。執行：python3 08-agentboard-subgoal-order.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TEXT = os.path.join(ROOT, ".cache", "text", "2401.13178.txt")

with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")


def hits(pattern):
    return [(i + 1, LINES[i]) for i in range(len(LINES)) if re.search(pattern, LINES[i], re.I)]


def show(label, pattern, width=170):
    hs = hits(pattern)
    print(f"  [{label}] 樣式 /{pattern}/：{len(hs)} 處")
    for ln, s in hs:
        m = re.search(pattern, s, re.I)
        a = max(0, m.start() - 60)
        print(f"    第 {ln} 行：…{s[a:a + width].strip()}…")
    return hs


print("== 1. 論文怎麼描述子目標之間的關係 ==")
order_hits = []
order_hits += show("有序", r"sequence of subgoals")
order_hits += show("有序", r"leading into the next")
order_hits += show("有序", r"unique subgoal sequence")
set_hits = show("集合", r"sets? of (N )?subgoals|single-set subgoals")
show("順序檢查字樣", r"\b(in order|ordered|one by one|chronolog|topolog)\b")

print("\n== 2. Eq. (2) 的 r^subgoal ==")
eq_ln = next(i for i, s in enumerate(LINES) if "r_{t}^{\\text{subgoal}}=" in s)
eq = LINES[eq_ln]
print(f"  第 {eq_ln + 1} 行：{eq.strip()}")
body = eq.split("r_{t}^{\\text{subgoal}}=", 1)[1]
indices = sorted(set(re.findall(r"[a-z]_\{([^}]*)\}", body)))
print(f"  式子裡出現的下標：{indices}")
order_terms = [t for t in ("k-1", "k+1", "k^{\\prime}", "\\leq k", "<k", "prefix") if t in body]
print(f"  依賴索引先後的項（k-1、k+1、prefix…）：{order_terms if order_terms else '沒有'}")
only_sym = ("\\sum_{k=1}^{K}f(s_{i},g_{k})" in body and "\\max_{i,0\\leq i\\leq t}" in body)
print(f"  結構只有 max_i 與 Σ_k f(s_i, g_k)：{only_sym} → 對子目標的任意排列不變")

print("\n== 3. 合成軌跡示範（不是官方程式碼）==")
# 以論文 §2 的例子為子目標：「clean an egg and put it in microwave」
SUBGOALS = [r"You open the fridge", r"You pick up the egg", r"You clean the egg", r"You put the egg .* microwave"]
K = len(SUBGOALS)
FWD = ["You open the fridge 1.", "You pick up the egg 1 from the fridge 1.",
       "You clean the egg 1 using the sinkbasin 1.", "You put the egg 1 in/on the microwave 1."]
REV = list(reversed(FWD))  # 物理上不可能的順序：先放微波爐、最後才開冰箱


def f(obs, g):
    return 1 if re.search(g, obs) else 0


def pr_eq2_literal(obs_seq):
    """Eq. (2) 字面：r_t = max_i (1/K) Σ_k f(s_i, g_k)，s_i 只取第 i 步的觀測。"""
    return max(sum(f(s, g) for g in SUBGOALS) / K for s in obs_seq)


def pr_union(obs_seq):
    """筆記描述的實作語意：曾經命中的子目標集合 / K（永久記分，不看順序）。"""
    hit = set()
    for s in obs_seq:
        hit |= {k for k, g in enumerate(SUBGOALS) if f(s, g)}
    return len(hit) / K


def pr_ordered(obs_seq):
    """若真的檢查順序：只有依序命中的前綴才算。"""
    nxt = 0
    for s in obs_seq:
        if nxt < K and f(s, SUBGOALS[nxt]):
            nxt += 1
    return nxt / K


for name, fn in (("Eq.(2) 字面", pr_eq2_literal), ("集合聯集", pr_union), ("有序前綴（對照）", pr_ordered)):
    a, b = fn(FWD), fn(REV)
    print(f"  {name:<14} 正序 {a:.2f}  逆序 {b:.2f}  相同：{a == b}")

print("\n== 結論 ==")
order_lines = sorted({h[0] for h in order_hits})
print(f"  論文有 {len(order_lines)} 行把子目標寫成序列（第 {'、'.join(map(str, order_lines))} 行），"
      f"另有 {len(set_hits)} 處寫成集合（L.1 第 {'、'.join(str(h[0]) for h in set_hits[:-1])} 行、L.2 第 {set_hits[-1][0]} 行）；"
      "L.1 說「unique subgoal sequence」的改寫只限制「多組不同子目標集合」的題目。")
print("  Eq. (2) 只有 max_i 與 Σ_k f(s_i, g_k)，沒有任何順序項：論文自己的式子就不檢查順序，"
      "逆序軌跡與正序拿同分；只有額外加上「有序前綴」才會分出差異。")
print("  所以「論文寫依序」只對正文敘述成立，對論文的計分公式不成立。")
print("  官方程式碼 bb7255e 是否「任一觀測符合任一 regex 就永久記一分」需要 repo，本程式無法判定。")
