#!/usr/bin/env python3
"""驗證：AgentRewardBench Table 3 的排名翻轉，judge 與規則式各顛倒幾組 agent 配對。

主張（章節 04-agent-trajectory.md〈排名翻轉：規則式與 judge 都會〉一節）：
  把 Table 3 的所有 agent 配對都算進來，排除 Llama 3.3 沒跑的 VisualWebArena（VWA）與專家平手的一對後，
  剩 3 + 6 + 5 = 14 組有嚴格順序的配對；GPT-4o judge 顛倒 2 組、規則式顛倒 4 組。
  因此論文「規則式翻轉排名」的說法站得住，精讀筆記「judge 也一樣翻轉」的批評只在 GPT-4o 對 Qwen2.5-VL
  這一對上成立。
出處：[arXiv:2504.08942]。精讀筆記 notes/2504.08942.json 的 limitations_observed[0] 是被重數的批評；
  「14 組、2 組、4 組」是撰寫本章時的換算，沒有經過複核，這支程式就是複核。

輸入從哪來（全部由程式直接從 .cache/text/2504.08942.txt 解析，不手抄）：
  - 「## 5 Revisiting how we evaluate task success rate」之後、「Table 3:」caption 之前的表格。
    表頭依序是 Human、GPT-4o Judge、Rule-based 三組，每組 VWA、WA、Wk++ 三欄；每列 1 個 agent 名稱 + 9 個數字。
  - 「text-only model, it was excluded from VisualWebArena」這句，作為排除 Llama 3.3 × VWA 的依據。
  - 論文自己的敘述「ranks Qwen2.5-VL above GPT-4o on WebArena and WorkArena++ (and equally on VWA)」，
    用來對照程式數出的規則式翻轉。

方法：
  1. 每個基準取所有 agent 兩兩配對；排除沒跑的格（Llama 3.3 × VWA）。
  2. 專家成功率相同的配對沒有「正確順序」，排除。
  3. 其餘配對，judge 或規則式的順序與專家相反記為「顛倒」，相等記為「平手」（平手不算顛倒，但另外列出）。
  4. 依 agent 配對彙總，看 judge 的顛倒是否集中在某一對。

只用標準函式庫；沒有隨機數。執行：python3 04-arb-ranking-flips.py（從任何目錄都可以）
"""

import os
import re
from itertools import combinations

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "2504.08942.txt")

with open(TEXT, encoding="utf-8") as f:
    RAW = f.read()
LINES = RAW.split("\n")


def find_line(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(LINES)):
        if rx.search(LINES[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


# ---- 解析 Table 3 ----
sec = find_line(r"^## 5 Revisiting how we evaluate task success rate")
cap = find_line(r"^Table 3: Success Rate of web agents", sec)
blocks, cur = [], []
for ln in LINES[sec + 1:cap]:
    if ln.startswith("| "):
        cur.append(ln[2:].strip())
    elif cur:
        blocks.append(cur)
        cur = []
if cur:
    blocks.append(cur)

header = blocks[0]
groups = blocks[1]
assert header == ["Agent", "Human", "GPT-4o Judge", "Rule-based"], header
assert groups == ["VWA", "WA", "Wk++"] * 3, groups
BENCH = ["VWA", "WA", "Wk++"]
table = {}
for b in blocks[2:]:
    name, vals = b[0], [float(x) for x in b[1:]]
    assert len(vals) == 9, (name, vals)
    table[name] = {"human": vals[0:3], "judge": vals[3:6], "rule": vals[6:9]}
print(f"[1] Table 3（第 {sec + 1}–{cap + 1} 行）解析出 {len(table)} 個 agent：{list(table)}")
for a, v in table.items():
    print(f"    {a:<14} 專家 {v['human']}  judge {v['judge']}  規則式 {v['rule']}")

# ---- 排除沒跑的格 ----
m = re.search(r"Llama-3\.3 is a text-only model, it was\s+excluded from VisualWebArena", RAW)
assert m, "找不到 Llama 3.3 不跑 VWA 的敘述"
ln = RAW[:m.start()].count("\n") + 1
print(f"\n[2] 第 {ln} 行：Llama-3.3 是純文字模型，不跑 VisualWebArena → 排除 Llama 3.3 × VWA")
skip = {("Llama 3.3", "VWA")}


def sgn(x):
    return (x > 0) - (x < 0)


pairs, human_ties, flips, ties = [], [], {"judge": [], "rule": []}, {"judge": [], "rule": []}
for bi, b in enumerate(BENCH):
    for a, c in combinations(table, 2):
        if (a, b) in skip or (c, b) in skip:
            continue
        h = table[a]["human"][bi] - table[c]["human"][bi]
        if abs(h) < 1e-9:
            human_ties.append((b, a, c))
            continue
        pairs.append((b, a, c))
        for ev in ("judge", "rule"):
            d = table[a][ev][bi] - table[c][ev][bi]
            if abs(d) < 1e-9:
                ties[ev].append((b, a, c))
            elif sgn(d) == -sgn(h):
                flips[ev].append((b, a, c, table[a]["human"][bi], table[c]["human"][bi], table[a][ev][bi], table[c][ev][bi]))

per_bench = [sum(1 for p in pairs if p[0] == b) for b in BENCH]
print(f"\n[3] 有嚴格順序的配對：{' + '.join(map(str, per_bench))} = {len(pairs)}（VWA、WA、Wk++）")
print(f"    專家平手而排除的：{human_ties}")
for ev, label in (("judge", "GPT-4o judge"), ("rule", "規則式")):
    print(f"    {label} 顛倒 {len(flips[ev])} 組：")
    for b, a, c, ha, hc, ea, ec in flips[ev]:
        print(f"      {b:<5} {a} 對 {c}：專家 {ha} 對 {hc}，{label} {ea} 對 {ec}")
    print(f"    {label} 平手 {len(ties[ev])} 組：{ties[ev]}")

# ---- 依配對彙總 ----
print("\n[4] 依 agent 配對彙總（顛倒／平手）：")
by_pair = {}
for ev in ("judge", "rule"):
    for b, a, c, *_ in flips[ev]:
        by_pair.setdefault((a, c), {"judge": [], "rule": [], "judge_tie": [], "rule_tie": []})[ev].append(b)
    for b, a, c in ties[ev]:
        by_pair.setdefault((a, c), {"judge": [], "rule": [], "judge_tie": [], "rule_tie": []})[ev + "_tie"].append(b)
for k, v in by_pair.items():
    print(f"    {k[0]} 對 {k[1]}：judge 顛倒 {v['judge']}、平手 {v['judge_tie']}；規則式顛倒 {v['rule']}、平手 {v['rule_tie']}")

judge_pairs = {(a, c) for _, a, c, *_ in flips["judge"]}
rule_gq = [b for b, a, c, *_ in flips["rule"] if {a, c} == {"GPT-4o", "Qwen2.5-VL"}]
paper = re.search(r"rule-based evaluation ranks Qwen2\.5-VL above GPT-4o on WebArena and\s+WorkArena\+\+ \(and equally on VWA\)", RAW)
print(f"\n[5] 論文原句（規則式把 Qwen2.5-VL 排在 GPT-4o 之上：WA、Wk++，VWA 相等）{'找到' if paper else '找不到'}；"
      f"程式數出的 GPT-4o／Qwen2.5-VL 規則式顛倒在 {rule_gq}，VWA 規則式平手："
      f"{('VWA', 'GPT-4o', 'Qwen2.5-VL') in ties['rule']}")

print("\n結論：")
ok = (len(pairs) == 14 and per_bench == [3, 6, 5] and len(flips["judge"]) == 2 and len(flips["rule"]) == 4
      and judge_pairs == {("GPT-4o", "Qwen2.5-VL")} and paper is not None)
print(f"  - 14 組有嚴格順序的配對（3 + 6 + 5）、judge 顛倒 {len(flips['judge'])} 組、規則式顛倒 {len(flips['rule'])} 組；"
      f"judge 的顛倒全在 {sorted(judge_pairs)}。")
print(f"  - 另有平手：judge {len(ties['judge'])} 組 {ties['judge']}，規則式 {len(ties['rule'])} 組 {ties['rule']}；章節原文沒有提到平手。")
print(f"  判定：{'證實（章節需補上兩組平手）' if ok else '需人工複核'}")
