"""驗證：2311.09469（Clarify When Necessary）Table 4 的全表計數。

主張（章節 01-goal-intent.md）：
  (a)〈爭議〉十一：Intent-Sim 在 b=10% 的增益占比是 13%、24%、14%、17%、6%、11%，
     六格平均 (13+24+14+17+6+11)÷6≈14.2%，只有一個組合達到隨機（10%）的兩倍；
     v1 摘要卻說 10% 預算下增益是隨機的兩倍。
  (b)〈爭議〉十一：v1 §6.3 說兩種熵方法在所有預算下都贏隨機，但 18 格裡 Intent-Sim 有 6 格低於隨機；
     Semantic Entropy 也有 8 格低於、1 格等於隨機，所以那句話對兩種熵方法都不成立。
  (c)〈方法比較〉〈陷阱一〉與未解問題 3：Intent-Sim 的 AUROC 在 0.501–0.628，六個組合中四個最高；
     六個組合各自最佳方法的 AUROC 落在 0.531–0.628；
     四種方法全部算進來有 5 格低於隨機（0.5），下限 0.371 是 Self-Ask 在 MT GPT-3。

出處：[arXiv:2311.09469]；筆記 notes/2311.09469.json 的 limitations_observed 第 1、2 條。

輸入數字全部取自 .cache/text/2311.09469.txt 的 Table 4（六個「任務 × 模型」組合 × 四種方法，
每格有 AUROC 與 b=10%、20%、30% 三個預算下的「表現（占總增益百分比）」）。
表中把本文方法標成 "User Sim"：§6.2 Baselines 只列 Likelihood、Self-Ask 與 Semantic Entropy，
所以第四個方法就是 §6.1 的 Intent-Sim。
隨機基準：§6.3 寫明隨機挑 b% 發問時，占總增益的百分比等於 b。

檢查：
  1. 六個組合的表格文字要依序出現在全文裡（錨點）；每格 AUROC 與三個占比由那串字解析。
  2. (a) Intent-Sim b=10% 六格、平均、達到 2×10%＝20% 的組合數。
  3. (b) Intent-Sim 18 格中占比 < b 的格數；Semantic Entropy 同樣計數（低於與等於分開）。
  4. (c) Intent-Sim AUROC 範圍、每個組合的最佳 AUROC 與最佳方法、各組合最佳的範圍、
     Intent-Sim 在幾個組合最高、全表 AUROC 最小值、全表 < 0.5 的格數。
  以上每一項都和下面 CLAIM 裡章節寫的值比對，全部相符才判「證實」；結論字串由算出的值組成。

執行：python3 verify/01-intentsim-table4-counts.py（只用標準函式庫，無隨機數）。
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", ".cache", "text", "2311.09469.txt")
BUDGETS = [10, 20, 30]
METHODS = ["Likelihood", "Self-Ask", "Sem. Ent", "User Sim"]

# --- 輸入（取自 .cache/text/2311.09469.txt 的 Table 4，依全文順序） ---
BLOCKS = [
    ("MT GPT-3", "| MT | GPT-3 | Likelihood | 0.547 | 76.1 (6%) | 78.1 (17%) | 79.8 (27%) | Self-Ask | 0.371 | 77.3 (13%) | 79.5 (25%) | 81.5 (37%) | Sem. Ent | 0.531 | 76.4 (11%) | 78.4 (19%) | 80.4 (30%) | User Sim | 0.512 | 77.3 (13%) | 78.7 (21%) | 79.3 (24%) |"),
    ("NLI LLaMA-2 7B Chat", "| NLI | LLaMA-2 7B Chat | Likelihood | 0.416 | 41.2 (1%) | 40.0 (-7%) | 39.4 (-11%) | Self-Ask | 0.477 | 41.6 (4%) | 41.9 (7%) | 42.5 (11%) | Sem. Ent | 0.467 | 43.9 (21%) | 44.1 (22%) | 43.7 (19%) | User Sim | 0.531 | 44.3 (24%) | 44.3 (24%) | 43.1 (15%) |"),
    ("NLI LLaMA-2 13B Chat", "| LLaMA-2 13B Chat | Likelihood | 0.526 | 31.0 (14%) | 33.0 (24%) | 33.8 (27%) | Self-Ask | 0.462 | 28.2 (1%) | 30.6 (12%) | 34.0 (28%) | Sem. Ent | 0.525 | 29.8 (8%) | 33.0 (24%) | 33.8 (27%) | User Sim | 0.544 | 31.0 (14%) | 32.8 (23%) | 34.8 (32%) |"),
    ("QA GPT-3", "| QA | GPT-3 | Likelihood | 0.590 | 55.4 (14%) | 55.9 (25%) | 56.3 (35%) | Self-Ask | 0.538 | 55.1 (6%) | 55.6 (18%) | 56.2 (32%) | Sem. Ent | 0.625 | 55.5 (17%) | 56.1 (29%) | 57.0 (49%) | User Sim | 0.628 | 55.5 (17%) | 56.1 (29%) | 57.0 (49%) |"),
    ("QA LLaMA-2 7B Chat", "| LLaMA-2 7B Chat | Likelihood | 0.510 | 38.4 (-1%) | 39.1 (14%) | 39.7 (28%) | Self-Ask | 0.510 | 38.9 (10%) | 39.3 (17%) | 39.9 (32%) | Sem. Ent | 0.532 | 39.1 (13%) | 39.3 (19%) | 40.1 (36%) | User Sim | 0.501 | 38.7 (6%) | 39.3 (19%) | 39.7 (26%) |"),
    ("QA LLaMA-2 13B Chat", "| LLaMA-2 13B Chat | Likelihood | 0.551 | 41.1 (8%) | 41.7 (21%) | 41.8 (24%) | Self-Ask | 0.546 | 41.0 (6%) | 41.6 (20%) | 42.1 (30%) | Sem. Ent | 0.552 | 41.0 (6%) | 41.4 (14%) | 42.0 (28%) | User Sim | 0.570 | 41.3 (11%) | 41.5 (17%) | 42.8 (37%)"),
]
TEXT_ANCHORS = [
    "| Task | Model | Method | AUROC | $b=10\\%$ | $b=20\\%$ | $b=30\\%$ |",
    "Table 4: Results for determining when to clarify.",
    "our system is able to double the performance gains over randomly selecting examples to clarify.",
    "achieves percent gain in performance equal to the budget value $b$",
    "outperform the random baseline under all interaction budgets.",
    "### 6.2 Baselines #### Likelihood",
]
# 章節寫的值（判定只拿算出的值和這些比）
CLAIM = {
    "b10": [13, 24, 14, 17, 6, 11],  # Intent-Sim 在 b=10% 的六格，依組合順序
    "b10_mean": 14.2,
    "doubled": 1,  # 達到 2×10% 的組合數
    "us_below": 6,  # Intent-Sim 18 格中低於隨機的格數
    "se_below_equal": (8, 1),  # Semantic Entropy 18 格中低於、等於隨機的格數
    "us_range": (0.501, 0.628),
    "best_range": (0.531, 0.628),  # 各組合最佳方法的 AUROC 範圍
    "us_top": 4,  # Intent-Sim 在幾個組合 AUROC 最高
    "min_cell": (0.371, "MT GPT-3", "Self-Ask"),
    "below_half": 5,  # 全表 AUROC < 0.5 的格數
}


def parse_block(raw):
    out = {}
    for m in METHODS:
        pat = re.escape(m) + r" \| ([0-9.]+) \| " + r" \| ".join([r"[0-9.]+ \((-?\d+)%\)"] * 3)
        g = re.search(pat, raw)
        out[m] = {"auroc": float(g.group(1)), "gain": [int(g.group(i)) for i in (2, 3, 4)]}
    return out


def flatten(path):
    with open(path, encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]
    return re.sub(r"\s+", " ", " ".join(lines))


def check_anchors():
    if not os.path.exists(SOURCE):
        print(f"[錨點] 找不到 {SOURCE}，略過錨點檢查（.cache/ 不進版控）")
        return None
    flat = flatten(SOURCE)
    ok = True
    pos = -1
    for name, raw in BLOCKS:
        p = flat.find(raw, pos + 1)
        hit = p > pos
        ok = ok and hit
        pos = p if hit else pos
        print(f"[錨點] {'找到' if hit else '缺少'}（依序）：Table 4 {name} 四列")
    for a in TEXT_ANCHORS:
        hit = a in flat
        ok = ok and hit
        print(f"[錨點] {'找到' if hit else '缺少'}：{a[:80]}")
    return ok


def main():
    anchors_ok = check_anchors()
    print()
    table = [(name, parse_block(raw)) for name, raw in BLOCKS]

    got = {}  # 算出的值，逐項和 CLAIM 比

    print("[a] Intent-Sim（表中 User Sim）在 b=10% 的增益占比；隨機基準＝10%")
    b10 = [t["User Sim"]["gain"][0] for _, t in table]
    for (name, _), g in zip(table, b10):
        print(f"  {name:22s} {g}%")
    mean = sum(b10) / len(b10)
    doubled = [name for (name, _), g in zip(table, b10) if g >= 2 * BUDGETS[0]]
    print(f"  ({'+'.join(map(str, b10))})÷6＝{mean:.2f}%；達到 2×10%＝20% 的組合：{len(doubled)} 個（{'、'.join(doubled)}）")
    got["b10"], got["b10_mean"], got["doubled"] = b10, round(mean, 1), len(doubled)
    print()

    print("[b] 18 格中占比低於隨機（< b）的格數")
    counts = {}
    for m in ("User Sim", "Sem. Ent"):
        below, equal = [], []
        for name, t in table:
            for b, g in zip(BUDGETS, t[m]["gain"]):
                if g < b:
                    below.append(f"{name} b={b}% {g}%")
                elif g == b:
                    equal.append(f"{name} b={b}% {g}%")
        counts[m] = (below, equal)
        label = "Intent-Sim" if m == "User Sim" else "Semantic Entropy"
        print(f"  {label}：低於 {len(below)} 格，等於 {len(equal)} 格")
        for x in below:
            print(f"    低於：{x}")
        for x in equal:
            print(f"    等於：{x}")
    got["us_below"] = len(counts["User Sim"][0])
    got["se_below_equal"] = (len(counts["Sem. Ent"][0]), len(counts["Sem. Ent"][1]))
    print()

    print("[c] AUROC（隨機＝0.5）")
    us = [t["User Sim"]["auroc"] for _, t in table]
    print(f"  Intent-Sim 範圍 {min(us):.3f}–{max(us):.3f}")
    best, top_count = [], 0
    for name, t in table:
        m_best = max(METHODS, key=lambda m: t[m]["auroc"])
        best.append(t[m_best]["auroc"])
        top_count += m_best == "User Sim"
        print(f"  {name:22s} 最佳 {m_best} {t[m_best]['auroc']:.3f}")
    print(f"  各組合最佳方法的 AUROC 範圍 {min(best):.3f}–{max(best):.3f}；Intent-Sim 在 {top_count} 個組合最高")
    allv = [(t[m]["auroc"], name, m) for name, t in table for m in METHODS]
    lo = min(allv)
    below_half = [f"{m} {name} {v:.3f}" for v, name, m in allv if v < 0.5]
    print(f"  全表最小 {lo[0]:.3f}（{lo[2]}，{lo[1]}）；低於 0.5 的共 {len(below_half)} 格：{'；'.join(below_half)}")
    got["us_range"] = (round(min(us), 3), round(max(us), 3))
    got["best_range"] = (round(min(best), 3), round(max(best), 3))
    got["us_top"] = top_count
    got["min_cell"] = (lo[0], lo[1], lo[2])
    got["below_half"] = len(below_half)
    print()

    print("[判定] 逐項與章節寫的值比對")
    mismatch = []
    for k, want in CLAIM.items():
        ok = got[k] == want
        if not ok:
            mismatch.append(k)
        print(f"  {k:15s} 章節 {want}　算出 {got[k]}　{'相符' if ok else '不符'}")
    claim = not mismatch
    print()

    summary = (
        f"b=10% 平均 {got['b10_mean']}%、{got['doubled']} 個組合達兩倍；"
        f"Intent-Sim 18 格中 {got['us_below']} 格低於隨機，"
        f"Semantic Entropy {got['se_below_equal'][0]} 格低於、{got['se_below_equal'][1]} 格等於；"
        f"AUROC Intent-Sim {got['us_range'][0]:.3f}–{got['us_range'][1]:.3f}、"
        f"各組合最佳 {got['best_range'][0]:.3f}–{got['best_range'][1]:.3f}、"
        f"Intent-Sim 在 {got['us_top']} 個組合最高、"
        f"{got['below_half']} 格低於 0.5、全表下限 {got['min_cell'][0]:.3f}（{got['min_cell'][2]}，{got['min_cell'][1]}）"
    )
    if anchors_ok is False:
        verdict = "無法判定（輸入數字與原文錨點對不上）"
    elif claim:
        verdict = f"證實（{summary}）"
    else:
        verdict = f"推翻（不符：{'、'.join(mismatch)}；算出 {summary}）"
    print(f"結論：{verdict}")
    return 0 if claim and anchors_ok is not False else 1


if __name__ == "__main__":
    sys.exit(main())
