#!/usr/bin/env python3
"""驗證：Who&When 的瑣碎常數基準能追上或贏過 Table 1 的方法（只驗能從論文數字推出的部分）。

主張（章節 04-agent-trajectory.md 的比較表 Who&When 那一列）：
  algorithm-generated 子集（126 條）中有 34 條 mistake_step=1，一律猜第 1 步的 step-level 為
  34/126 ≈ 26.98%，高於 Table 1 在該子集的最佳值（step-by-step 有 GT 的 25.51）；
  hand-crafted 58 條一律猜 WebSurfer 的 agent-level 為 33/58（現行標籤）或 31/58（論文當時標籤），
  與 all-at-once 的 55.17／53.44 相當。
出處：[arXiv:2505.00212] 精讀筆記 notes/2505.00212.json 的 limitations_observed 第 1 條。

輸入從哪來：
  - .cache/text/2505.00212.txt 第 217 行：「184 distinct failure annotation tasks」（總筆數）。
  - .cache/text/2505.00212.txt 第 325–391 行：Table 1（caption 在第 392 行），程式直接解析，
    順序為 Random、All-at-Once、Step-by-Step、Binary Search，每種方法兩列（Agent-Level、
    Step-Level），每列四欄（有 GT 的 alg-gen、hand-crafted；無 GT 的 alg-gen、hand-crafted）。
  - 34、33、31 這三個計數取自 notes/2505.00212.json 的 limitations_observed 第 1 條，
    是精讀 agent 依公開 repo 標註數出來的；本程式依規則不下載資料集，所以無法驗證這三個計數本身，
    只驗算術、比較，以及論文自己的數字能不能佐證「同子集」這個前提。

方法：
  1. 由 hand-crafted 各格推分母：看每格能寫成 k/d 的 d（同時試「四捨五入」與「截斷」到兩位小數）。
  2. 126 = 184 − 58；檢查 alg-gen 各格能不能寫成 k/126，並在 d ≤ 3000 找共同分母。
  3. 算術與比較：34/126、33/58、31/58；26.98 與 alg-gen 所有 step-level 格比；
     要贏過 25.51 最少需要幾條 mistake_step=1（穩健度）。

只用標準函式庫；沒有隨機數。執行：python3 04-whowhen-trivial-baseline.py
"""

import json
import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TEXT = os.path.join(ROOT, ".cache", "text", "2505.00212.txt")
NOTE = os.path.join(ROOT, "notes", "2505.00212.json")

with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")

# ---- 總筆數 ----
tot_line = next(i for i, s in enumerate(LINES) if re.search(r"184 distinct failure annotation tasks", s))
N_TOTAL = 184
print(f"總筆數 184：第 {tot_line + 1} 行「...culminating in 184 distinct failure annotation tasks」")

# ---- 計數來自筆記 ----
with open(NOTE, encoding="utf-8") as f:
    lim = json.load(f)["limitations_observed"][0]
for needle in ("34 條的 mistake_step=1", "26.98%", "56.9%（33 條）", "53.4%（31 條"):
    assert needle in lim, needle
print("計數 34／33／31 與 26.98% 出現在 notes/2505.00212.json limitations_observed[0]（精讀時依 repo 標註數出）")

# ---- 解析 Table 1 ----
cap = next(i for i, s in enumerate(LINES) if s.startswith("Table 1: Performance of the three failure attribution"))
start = max(i for i in range(cap) if "With Ground Truth" in LINES[i])
nums = [float(x) for x in re.findall(r"\d+\.\d+", "\n".join(LINES[start:cap]))]
assert len(nums) == 32, len(nums)
METHODS = ["Random", "All-at-Once", "Step-by-Step", "Binary Search"]
COLS = ["alg_gt", "hc_gt", "alg_nogt", "hc_nogt"]
T1 = {}
it = iter(nums)
for m in METHODS:
    for metric in ("agent", "step"):
        for c in COLS:
            T1[(m, metric, c)] = next(it)
print(f"\nTable 1（第 {start + 1}–{cap} 行，caption 第 {cap + 1} 行）：")
print(f"  {'':<14}{'':<7}" + "".join(f"{c:>10}" for c in COLS))
for m in METHODS:
    for metric in ("agent", "step"):
        print(f"  {m:<14}{metric:<7}" + "".join(f"{T1[(m, metric, c)]:>10.2f}" for c in COLS))


def fits(v, d):
    """回傳 (k, 方式)：100k/d 四捨五入或截斷到兩位小數等於 v。"""
    out = []
    base = math.floor(v * d / 100)
    for k in range(max(base - 1, 0), min(base + 2, d) + 1):
        x = 100 * k / d
        if abs(x - v) <= 0.005 + 1e-9:
            out.append((k, "四捨五入"))
        if math.floor(x * 100 + 1e-9) / 100 == v:
            out.append((k, "截斷"))
    return out


# ---- 1. hand-crafted 分母 ----
print("\n[1] hand-crafted 各格可相容的分母（d ≤ 184）：")
for m in METHODS[1:]:
    for metric in ("agent", "step"):
        for c in ("hc_gt", "hc_nogt"):
            v = T1[(m, metric, c)]
            ds = [d for d in range(1, N_TOTAL + 1) if fits(v, d)]
            f58 = fits(v, 58)
            f57 = fits(v, 57)
            print(f"  {m:<14}{metric:<6}{c:<8}{v:>6.2f}  最小 d={ds[:4]}  "
                  f"58→{f58 if f58 else '✗'}  57→{f57 if f57 else '✗'}")
agent_hc = [T1[(m, "agent", c)] for m in METHODS[1:] for c in ("hc_gt", "hc_nogt")]
all_agent_58 = all(fits(v, 58) for v in agent_hc)
hc_all = [T1[(m, metric, c)] for m in METHODS[1:] for metric in ("agent", "step") for c in ("hc_gt", "hc_nogt")]


def ways(v):
    f = fits(v, 58) or fits(v, 57)
    return {w for _, w in f}


trunc_only = sorted({v for v in hc_all if ways(v) == {"截斷"}})
round_only = sorted({v for v in hc_all if ways(v) == {"四捨五入"}})
N_HC = 58
N_ALG = N_TOTAL - N_HC
print(f"  hand-crafted 的 agent-level 六格全部是 k/58：{all_agent_58}")
print(f"  只能用「截斷」解釋的格：{trunc_only}；只能用「四捨五入」解釋的格：{round_only}")
print("  → 論文的捨入方式不一致（同一張表兩種都有），所以相容判定兩種都要試。")
print(f"  → hand-crafted = 58，alg-gen = 184 − 58 = {N_ALG}")

# ---- 2. alg-gen 分母 ----
print(f"\n[2] alg-gen 各格能否寫成 k/{N_ALG}：")
alg_cells = {(m, metric, c): T1[(m, metric, c)] for m in METHODS for metric in ("agent", "step") for c in ("alg_gt", "alg_nogt")}
any126 = False
for key, v in alg_cells.items():
    f = fits(v, N_ALG)
    if key[0] != "Random":  # Random 是解析出的期望值，不是命中筆數，本來就不必是 k/126，不列入證據
        any126 |= bool(f)
    lo = math.floor(v * N_ALG / 100)
    ds = [d for d in range(100, 260) if fits(v, d)]
    print(f"  {key[0]:<14}{key[1]:<6}{key[2]:<9}{v:>6.2f}  k/{N_ALG}: {f if f else '✗'}"
          f"（夾在 {lo}/{N_ALG}={100 * lo / N_ALG:.2f} 與 {lo + 1}/{N_ALG}={100 * (lo + 1) / N_ALG:.2f} 之間）"
          f"  d∈[100,260) 相容：{ds[:6]}" + ("  ← 期望值，不列入證據" if key[0] == "Random" else ""))
method_cells = {k: v for k, v in alg_cells.items() if k[0] != "Random"}
common = [d for d in range(1, 3001) if all(fits(v, d) for v in method_cells.values())]
print(f"  三種方法的 alg-gen {len(method_cells)} 格：能寫成 k/{N_ALG} 的有 {sum(bool(fits(v, N_ALG)) for v in method_cells.values())} 格；"
      f"d ≤ 3000 的共同分母：{common if common else '沒有'}")
sbs = {k: v for k, v in method_cells.items() if k[0] == "Step-by-Step"}
common_sbs = [d for d in range(1, 400) if all(fits(v, d) for v in sbs.values())]
print(f"  只看 Step-by-Step 四格，d < 400 的共同分母：{common_sbs}")

# ---- 3. 算術與比較 ----
print("\n[3] 算術與比較")
k_step1 = 34
acc = 100 * k_step1 / N_ALG
print(f"  一律猜第 1 步：{k_step1}/{N_ALG} = {acc:.4f}%（主張寫 26.98%）")
step_alg = {k: v for k, v in alg_cells.items() if k[1] == "step"}
best_key, best = max(step_alg.items(), key=lambda kv: kv[1])
print(f"  alg-gen 所有 step-level 格：{sorted(step_alg.values(), reverse=True)}；最大 {best}（{best_key[0]}，{best_key[2]}）")
need = math.floor(best * N_ALG / 100) + 1
print(f"  要在 {N_ALG} 條上超過 {best}，最少需要 {need} 條 mistake_step=1（{need}/{N_ALG} = {100 * need / N_ALG:.2f}%）；"
      f"主張的 {k_step1} 條比門檻多 {k_step1 - need} 條")
aao = (T1[("All-at-Once", "agent", "hc_gt")], T1[("All-at-Once", "agent", "hc_nogt")])
for k, label in ((33, "現行標籤"), (31, "論文當時標籤")):
    print(f"  一律猜 WebSurfer（{label}）：{k}/{N_HC} = {100 * k / N_HC:.4f}%")
print(f"  all-at-once 的 hand-crafted agent-level：有 GT {aao[0]}（= {fits(aao[0], 58)[0][0]}/58），"
      f"無 GT {aao[1]}（= {fits(aao[1], 58)[0][0]}/58）")
print("  → 論文當時標籤的 31/58 與 all-at-once 無 GT 同為 31 條命中，比有 GT 少 1 條；現行標籤的 33/58 比兩者多 1–2 條。")

print("\n結論：")
print(f"  - 算術成立：34/126 = {acc:.2f}% > {best}；33/58 = {100 * 33 / 58:.2f}%、31/58 = {100 * 31 / 58:.2f}% 與 55.17／53.44 相當。")
print(f"  - 穩健度：只要 126 條中有 ≥ {need} 條 mistake_step=1 就成立。")
print(f"  - 34、33、31 三個計數要資料集才能驗，本程式依規則不下載 → 無法判定。")
print(f"  - 三種方法的 alg-gen {len(method_cells)} 格{'有格' if any126 else '沒有一格'}能寫成 k/{N_ALG}，也找不到共同分母（Random 是期望值，不列入）；")
print(f"    hand-crafted 卻乾淨地落在 k/58（step-level 有兩種方法是 k/57）。所以「與 Table 1 同子集、同條件」")
print(f"    這個前提無法由論文數字確認：Table 1 的 alg-gen 格不是單次、在 {N_ALG} 條上算出的簡單比例。")
print("  判定：無法判定（算術與比較成立，但核心計數與同子集前提都無法由允許的來源確認）")
