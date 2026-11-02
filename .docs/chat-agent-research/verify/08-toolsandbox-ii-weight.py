#!/usr/bin/env python3
"""驗證：ToolSandbox 的 II 類別裡，無 milestone 的基底情境讓「什麼都不做的 agent」光靠 II 就拿到約 20.2 分。

主張（章節 08-task-completion-score.md 第 185、317、446 行）：
  28 個 Insufficient Information（II）基底情境中有 26 個沒有 milestone；評分程式在 milestone
  為空時把 milestone 分數預設為 1，所以只要沒踩到 minefield 就是滿分。組章時據此推論，
  一個什麼都不做的 agent 光靠 II 就可能拿到總分 26×8/1032 ≈ 20.2 分。
出處：[arXiv:2408.04682] 精讀筆記 notes/2408.04682.json 的 limitations_observed 第 1 條
  （28、26、16 這三個計數，以及「預設為 1」的讀碼結果）與第 5 條（129 個基底 × 8 種擴增）；
  20.2 分的推論是組章時延伸的。

輸入從哪來：
  - .cache/text/2408.04682.txt 的 Table 6（B.4 節，caption「Table 6: Number of test scenarios per
    category」）：各類別情境數，程式直接解析。
  - .cache/text/2408.04682.txt 的 Table 5（第 4 節，caption「Table 5: Comparing the average
    similarity score」）：13 個模型 × 16 欄（Avg、7 個類別、8 種工具擴增），程式直接解析。
  - .cache/text/2408.04682.txt 第 3 節的 Insufficient Information 定義段與 Figure 3 caption：
    minefield 在 II 裡定義成「不該呼叫的工具」。
  - 28、26 取自 notes/2408.04682.json 的 limitations_observed 第 1 條；那是精讀 agent 讀 repo
    （apple/ToolSandbox）數出來的，本程式依規則不下載 repo，所以無法驗證這兩個計數本身，
    也無法驗證「milestone 為空時預設為 1」與實跑 do-nothing agent 的分數。

方法：
  1. Table 6：各類別數能不能被 8 整除（8 種擴增）；STC＋MTC＋II 是否剛好等於 1032，
     也就是這三類是否把全部情境切成互斥的三塊。
  2. Table 5：逐模型檢查 Avg 能不能由「情境數加權」重算出來：
       (a) Avg ≈ (152·STC＋656·MTC＋224·II) / 1032
       (b) Avg ≈ 8 個擴增欄的簡單平均（每種擴增 129 個情境）
     兩者都在四捨五入誤差內成立，才表示 Avg 是對 1032 個情境的等權平均，II 的權重是 224/1032。
  3. 算術：26×8/1032；do-nothing agent 在 II 類的分數下限 26/28；對照 Table 5 的 II 欄。
  4. 讀論文對 II minefield 的描述，看「什麼都不做不會觸發 minefield」有沒有文字依據。

只用標準函式庫；沒有隨機數。執行：python3 08-toolsandbox-ii-weight.py
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TEXT = os.path.join(ROOT, ".cache", "text", "2408.04682.txt")
NOTE = os.path.join(ROOT, "notes", "2408.04682.json")

with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")


def find_line(pattern, start=0):
    for i in range(start, len(LINES)):
        if re.search(pattern, LINES[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


# ---------------------------------------------------------------- Table 6
cap6 = find_line(r"^Table 6: Number of test scenarios per category")
hdr6 = find_line(r"Test Scenario Count")
t6 = {}
i = hdr6
while i < cap6:
    m = re.match(r"^\| ([A-Z_]+)$", LINES[i])
    if m and i + 1 < cap6:
        n = re.match(r"^\| (\d+)$", LINES[i + 1])
        if n:
            t6[m.group(1)] = int(n.group(1))
    i += 1
print(f"== Table 6（第 {hdr6 + 1}–{cap6 + 1} 行）==")
for k, v in t6.items():
    print(f"  {k:<24} {v:>4}   ÷8 = {v / 8:g}")
TOTAL = 1032
tot_line = find_line(r"ToolSandbox contains 1032")
print(f"  總情境數 1032：第 {tot_line + 1} 行「ToolSandbox contains 1032 ...」")
all_div8 = all(v % 8 == 0 for v in t6.values())
print(f"  全部可被 8 整除：{all_div8}；1032 ÷ 8 = {TOTAL // 8}")
stc, mtc, ii = t6["SINGLE_TOOL_CALL"], t6["MULTIPLE_TOOL_CALL"], t6["INSUFFICIENT_INFORMATION"]
print(f"  STC＋MTC＋II = {stc}＋{mtc}＋{ii} = {stc + mtc + ii}（等於 1032：{stc + mtc + ii == TOTAL}）")
print(f"  基底數 STC＋MTC＋II = {stc // 8}＋{mtc // 8}＋{ii // 8} = {(stc + mtc + ii) // 8}")
print(f"  II 基底數 = {ii} ÷ 8 = {ii // 8}")

# ---------------------------------------------------------------- Table 5
cap5 = find_line(r"^Table 5: Comparing the average similarity score")
start5 = find_line(r"^## 4 Evaluation Results")
COLS = ["Avg", "STC", "MTC", "SUT", "MUT", "SD", "C", "II",
        "0DT", "3DT", "10DT", "AT", "TNS", "TDS", "ADS", "ATS"]
rows = {}
i = start5
while i < cap5:
    m = re.match(r"^\| ([A-Za-z][A-Za-z0-9 .+\-]+)$", LINES[i])
    if m and i + 16 < cap5 + 1:
        vals = []
        ok = True
        for j in range(1, 17):
            n = re.match(r"^\| (\d+\.\d)$", LINES[i + j])
            if not n:
                ok = False
                break
            vals.append(float(n.group(1)))
        if ok:
            rows[m.group(1)] = dict(zip(COLS, vals))
            i += 17
            continue
    i += 1
print(f"\n== Table 5（第 {start5 + 1}–{cap5 + 1} 行）解析到 {len(rows)} 個模型 ==")
assert len(rows) == 13, "Table 5 應有 13 個模型"

print(f"  {'模型':<28}{'Avg':>6}{'加權(a)':>9}{'差':>7}{'擴增平均(b)':>12}{'差':>7}{'II':>6}")
max_da = max_db = 0.0
for name, r in rows.items():
    a = (stc * r["STC"] + mtc * r["MTC"] + ii * r["II"]) / TOTAL
    b = sum(r[c] for c in COLS[8:]) / 8
    da, db = a - r["Avg"], b - r["Avg"]
    max_da, max_db = max(max_da, abs(da)), max(max_db, abs(db))
    print(f"  {name:<28}{r['Avg']:>6.1f}{a:>9.2f}{da:>+7.2f}{b:>12.2f}{db:>+7.2f}{r['II']:>6.1f}")
# 每格四捨五入到 0.1，最壞誤差：(a) 為 0.05×(1 + 1)=0.10；(b) 為 0.05 + 0.05 = 0.10
print(f"  最大 |差|：(a) {max_da:.3f}，(b) {max_db:.3f}；四捨五入容許上限各約 0.10")
weight_ok = max_da <= 0.10 + 1e-9 and max_db <= 0.10 + 1e-9
print(f"  Avg 是 1032 個情境的等權平均、II 權重 224/1032 = {ii / TOTAL:.4f}：{weight_ok}")

# ---------------------------------------------------------------- 筆記裡的計數
with open(NOTE, encoding="utf-8") as f:
    lim = json.load(f)["limitations_observed"]
need = ["定義了 28 個 II 基底情境", "其中 26 個沒有任何 milestone", "預設為 1"]
print("\n== 筆記 limitations_observed[0] 的計數（讀 repo 得來，本程式無法重數）==")
for s in need:
    print(f"  「{s}」在筆記中：{s in lim[0]}")
print(f"  「129 × 8＝1032」在 limitations_observed[4]：{'129 × 8＝1032' in lim[4]}")
N_BASE_II, N_EMPTY = 28, 26
assert N_BASE_II == ii // 8, "筆記的 28 應等於 Table 6 的 224 ÷ 8"

# ---------------------------------------------------------------- 算術
contrib = N_EMPTY * 8 / TOTAL * 100
ii_floor = N_EMPTY / N_BASE_II * 100
print("\n== 算術 ==")
print(f"  26×8/1032×100 = {contrib:.3f}（章節寫 ≈20.2：{round(contrib, 1) == 20.2}）")
print(f"  do-nothing 在 II 類的分數下限 26/28 = {ii_floor:.2f}")
best_ii = max(rows.items(), key=lambda kv: kv[1]["II"])
print(f"  Table 5 的 II 最高是 {best_ii[0]} 的 {best_ii[1]['II']}，GPT-4o 是 {rows['GPT-4o-2024-05-13']['II']}")
above = [n for n, r in rows.items() if r["II"] >= ii_floor]
print(f"  II ≥ {ii_floor:.2f} 的受測模型：{above if above else '沒有'}")
m7 = rows["Mistral-7B-Instruct-v0.3"]
print(f"  Mistral-7B：Avg {m7['Avg']}，其中 II 貢獻 224×{m7['II']}/1032 = {ii * m7['II'] / TOTAL:.2f}")
low = min(rows.items(), key=lambda kv: kv[1]["Avg"])
print(f"  do-nothing 單靠 II 的 {contrib:.1f} 分，是 Table 5 總分最低的 {low[0]}（{low[1]['Avg']}）的 "
      f"{contrib / low[1]['Avg'] * 100:.0f}%；總分低於 {contrib:.1f} 的受測模型："
      f"{sum(1 for r in rows.values() if r['Avg'] < contrib)} 個")

# ---------------------------------------------------------------- minefield 的文字依據
print("\n== 論文對 II minefield 的描述 ==")
for pat in (r"minefields are defined to evaluate if tools that would imply hallucination",
            r"should never\s*$|should never call",
            r"score\}=\\text\{score\}_\{M\+\}\\times"):
    k = find_line(pat)
    print(f"  第 {k + 1} 行：{LINES[k].strip()[:150]}")

print("\n== 結論 ==")
print(f"  可由論文推出的部分：II = {ii} = 28×8，STC＋MTC＋II = 1032；Avg 是等權平均（Table 5 十三列全部"
      f"在四捨五入內重算得出），所以 II 的每個情境佔總分 1/1032，26×8/1032 = {contrib:.2f}。算術與加權前提證實。")
print("  論文把 II 的 minefield 描述為「不該被呼叫的工具」，一個不呼叫工具的 agent 按這個描述不會觸發；"
      "但這是描述，不是逐一清點。")
print("  「26 個沒有 milestone」「空 milestone 預設為 1」與 do-nothing 的實跑分數都要 repo，本程式無法判定。")
