#!/usr/bin/env python3
"""驗證：AgenTracer Table 1（Who&When 兩子集）的逐格比較與分母。

主張（章節 04-agent-trajectory.md 的 AgenTracer 段落與〈樣本小到一條軌跡就值好幾個百分點〉一條）[arXiv:2509.03312]：
  1. 八格（兩子集 × agent／step 層級 × 有／無 GT）中有六格是 AgenTracer 最高；automated 無 GT 的兩格不是：
     agent-level 63.73 低於 DeepSeek-R1 的 65.08，step-level 37.30 低於 Claude-Sonnet-4 的 38.83。
  2. handcraft 欄中 Qwen3-8B 42.10、Qwen3-32B 44.80 不是任何 k/58；表中 3.45 與 3.44 並存、都對應 2/58，可見捨入方式不一。
  3. AgenTracer 的 handcraft step-level 20.68 約是 12/58。
  這幾條原本只寫「本章對照全文」，沒有程式驗證，這支程式就是複核。

輸入從哪來（全部由程式直接從 .cache/text/2509.03312.txt 解析，不手抄）：
  「Table 1: Performance comparison on the Who&When benchmark」caption 之後、「## 5 Experiments」之前的表格。
  每列是模型名稱加四格「有 GT／無 GT」，欄序為 handcraft agent、handcraft step、automated agent、automated step。
  Who&When 的 hand-crafted 子集有 58 條、algorithm-generated（automated）子集有 126 條，取自 notes/2505.00212.json
  「資料集建構」欄；Who&When 全文只寫總數 184，程式另從 .cache/text/2505.00212.txt 找出這句，確認 58 + 126 = 184。

方法：
  1. 逐格找出最高與第二高，數 AgenTracer 在八格中拿最高的格數，列出不是最高的格。
  2. 每格檢查能否寫成 k/n（handcraft n = 58、automated n = 126），四捨五入與無條件捨去到兩位小數都試，
     列出兩種都對不上的格。
  3. 找出所有對應 2/58 的格，看是否同時出現 3.45（四捨五入）與 3.44（捨去）。

只用標準函式庫；沒有隨機數。執行：python3 04-agentracer-table1.py（從任何目錄都可以）
"""

import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "..", ".cache", "text")
with open(os.path.join(CACHE, "2509.03312.txt"), encoding="utf-8") as f:
    L = f.read().split("\n")
with open(os.path.join(CACHE, "2505.00212.txt"), encoding="utf-8") as f:
    WW = f.read()


def find(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(L)):
        if rx.search(L[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


cap = find(r"^Table 1: Performance comparison on the Who&When benchmark")
end = find(r"^## 5 Experiments", cap)
cells = [ln[1:].strip() for ln in L[cap:end] if ln.startswith("|")]
rows = {}
i = 0
PAIR = re.compile(r"^(\d+\.\d+)/(\d+\.\d+)$")
while i < len(cells):
    if i + 4 < len(cells) and all(PAIR.match(c) for c in cells[i + 1:i + 5]) and not PAIR.match(cells[i]):
        rows[cells[i]] = [tuple(float(x) for x in PAIR.match(c).groups()) for c in cells[i + 1:i + 5]]
        i += 5
    else:
        i += 1
COLS = ["handcraft agent", "handcraft step", "automated agent", "automated step"]
print(f"[0] Table 1 位置：第 {cap + 1}–{end} 行；解析出 {len(rows)} 列：{list(rows)}")

# 子集大小：取自 Who&When 的精讀筆記，再用全文的總數 184 對帳
import json
with open(os.path.join(HERE, "..", "notes", "2505.00212.json"), encoding="utf-8") as f:
    WN = json.dumps(json.load(f), ensure_ascii=False)
n_hand = int(re.search(r"hand-crafted（(\d+) 條）", WN).group(1))
n_alg = int(re.search(r"algorithm-generated（(\d+) 條）", WN).group(1))
m184 = re.search(r"culminating in (\d+) distinct failure annotation tasks", WW)
N = {"handcraft": n_hand, "automated": n_alg}
print(f"    Who&When 筆記：hand-crafted {n_hand} 條、algorithm-generated {n_alg} 條；全文總數 {m184.group(1)}；"
      f"{n_hand} + {n_alg} = {n_hand + n_alg}，{'相符' if n_hand + n_alg == int(m184.group(1)) else '不符'}")

# ---- 1. 逐格最高 ----
print("\n[1] 逐格最高（八格＝四欄 × 有／無 GT）")
best_count = 0
not_best = []
for ci, cn in enumerate(COLS):
    for gi, gn in enumerate(["有 GT", "無 GT"]):
        vals = sorted(((v[ci][gi], name) for name, v in rows.items()), reverse=True)
        top, second = vals[0], vals[1]
        ours = rows["AgenTracer"][ci][gi]
        is_best = top[1] == "AgenTracer"
        best_count += is_best
        if not is_best:
            not_best.append((cn, gn, ours, top[1], top[0]))
        print(f"    {cn:<16}{gn}：最高 {top[1]} {top[0]}，次高 {second[1]} {second[0]}；AgenTracer {ours}")
print(f"    AgenTracer 最高的格數 = {best_count}/8；不是最高的：{not_best}")


# ---- 2. k/n ----
def fits(v, n):
    out = []
    for k in range(n + 1):
        x = 100 * k / n
        if abs(math.floor(x * 100 + 0.5 + 1e-9) / 100 - v) < 1e-9:
            out.append((k, "四捨五入"))
        if abs(math.floor(x * 100 + 1e-9) / 100 - v) < 1e-9:
            out.append((k, "捨去"))
    return out


print("\n[2] 每格能否寫成 k/n（兩位小數，四捨五入或捨去）")
misfit = {"handcraft": [], "automated": []}
two58 = []
for name, v in rows.items():
    for ci, cn in enumerate(COLS):
        sub = cn.split()[0]
        for gi, gn in enumerate(["有 GT", "無 GT"]):
            f = fits(v[ci][gi], N[sub])
            if not f:
                misfit[sub].append((name, cn, gn, v[ci][gi]))
            if sub == "handcraft" and any(k == 2 for k, _ in f):
                two58.append((name, cn, gn, v[ci][gi], [how for k, how in f if k == 2]))
for sub in ("handcraft", "automated"):
    total = len(rows) * 4
    print(f"    {sub}（n = {N[sub]}）：{total - len(misfit[sub])}/{total} 格相容；對不上的 {len(misfit[sub])} 格：")
    for x in misfit[sub]:
        print(f"      {x[0]:<16}{x[1]:<17}{x[2]} {x[3]}")
print(f"    對應 2/58 的格：{two58}")

# ---- 3. 20.68 ≈ 12/58 ----
f2068 = fits(20.68, 58)
print(f"\n[3] 20.68 能寫成：{f2068}（12/58 = {100 * 12 / 58:.4f}）")

print("\n結論：")
q8 = rows["Qwen3-8B"][0][0]
q32 = rows["Qwen3-32B"][0][0]
claim1 = best_count == 6 and {(c, g) for c, g, *_ in not_best} == {("automated agent", "無 GT"), ("automated step", "無 GT")}
claim2 = (any(x[3] == q8 for x in misfit["handcraft"]) and any(x[3] == q32 for x in misfit["handcraft"])
          and {x[3] for x in two58} >= {3.45, 3.44})
claim3 = any(k == 12 for k, _ in f2068)
print(f"  - 八格中 AgenTracer 最高 {best_count} 格；不是最高的兩格：{[(c, g, o, who, t) for c, g, o, who, t in not_best]}。")
print(f"  - handcraft 欄對不上 k/58 的有 {len(misfit['handcraft'])} 格（不只 Qwen3-8B {q8} 與 Qwen3-32B {q32}）；"
      f"automated 欄對不上 k/126 的有 {len(misfit['automated'])} 格。")
print(f"  - 3.45 與 3.44 並存且都對應 2/58：{ {x[3] for x in two58} >= {3.45, 3.44} }；20.68 對應 12/58（捨去）：{claim3}。")
print(f"  判定：{'三條主張都證實，另發現 handcraft 欄還有其他格不是 k/58' if (claim1 and claim2 and claim3) else '需人工複核'}")
