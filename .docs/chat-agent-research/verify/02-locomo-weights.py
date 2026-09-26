#!/usr/bin/env python3
"""驗證：LoCoMo 總分以 282／96／841／321 題加權，Open Domain 占約 54.6%；Zep 列對不起來；
Hindsight 表中 Mem0、Mem0-Graph、LangMem、OpenAI 四列與 Mem0 論文逐格相同。

主張（章節 02-dialogue-state-tracking.md「LoCoMo 的總分由 Open Domain 主導」與「Mem0、Zep 與
Hindsight 的比較表」兩段）：
  (a) 以 Single-Hop／Multi-Hop／Open Domain／Temporal 各 282／96／841／321 題加權，可重現 Hindsight
      Table 4 除了 Zep 以外所有列的總分（誤差 ≤ 0.01），也能重現 Mem0 論文 Table 2 的 Overall J；
      Open Domain 權重約 54.6%。
  (b) Zep 在 Hindsight 表上的總分 75.14 與其分項加權（約 71.30）對不起來。
  (c) Hindsight 表中 Mem0、Mem0-Graph、LangMem、OpenAI 四列的分項與總分，與 Mem0 論文
      Table 1（J 分項）／Table 2（Overall J）逐格相同。
出處：[arXiv:2512.12818] notes/2512.12818.json limitations_observed 第 6 條；
      [arXiv:2504.19413] 章節撰寫時的比對（Mem0 筆記沒有這條，章節標「撰寫第 4 組草稿時」）。

輸入從哪來：
  - .cache/text/2512.12818.txt 約第 1194–1271 行：Hindsight Table 4（四個分項＋Overall）。
  - .cache/text/2504.19413.txt 約第 278–458 行：Mem0 Table 1（各方法 J 分項，含 ± 標準差，這裡只取平均）。
  - .cache/text/2504.19413.txt 約第 502–700 行：Mem0 Table 2（Overall J）。
    注意 Table 2 的列名是「A-Mem」，Table 1 帶 J 分項的是「A-Mem*」（作者重跑版），這裡把兩者對上。
  - .cache/text/2504.19413.txt 第 193–194 行：LOCOMO 10 段對話、平均每段約 200 題（用來排除題數的倍數）。
  - Zep 部落格的 75.14 ± 0.17 取自 notes/2504.19413.json limitations_observed 第 7 條（部落格原表不在快取裡）。
  - 282／96／841／321 在兩份快取全文裡都查不到（grep 282、841、321、1540 無結果），是精讀時反推的權重，
    不是論文寫明的題數。本程式另外做最小平方擬合與「整數題數」檢查，看資料本身能不能支撐這組權重。

只用標準函式庫；沒有隨機數。執行：python3 02-locomo-weights.py
"""

W = (282, 96, 841, 321)  # Single-Hop, Multi-Hop, Open Domain, Temporal
NW = sum(W)
COLS = ("Single-Hop", "Multi-Hop", "Open Domain", "Temporal")

# Hindsight Table 4：(SH, MH, OD, TMP, Overall)
HINDSIGHT = {
    "Backboard": (89.36, 75.00, 91.20, 91.90, 90.00),
    "Memobase (v0.0.37)": (70.92, 46.88, 77.17, 85.05, 75.78),
    "Zep": (74.11, 66.04, 67.71, 79.79, 75.14),
    "Mem0-Graph": (65.71, 47.19, 75.71, 58.13, 68.44),
    "Mem0": (67.13, 51.15, 72.93, 55.51, 66.88),
    "LangMem": (62.23, 47.92, 71.12, 23.43, 58.10),
    "OpenAI": (63.79, 42.92, 62.29, 21.71, 52.90),
    "Hindsight (OSS-20B)": (74.11, 64.58, 90.96, 76.32, 83.18),
    "Hindsight (OSS-120B)": (76.79, 62.50, 93.68, 79.44, 85.67),
    "Hindsight (Gemini-3)": (86.17, 70.83, 95.12, 83.80, 89.61),
}

# Mem0 Table 1 的 J 分項（SH, MH, OD, TMP）
MEM0_T1_J = {
    "A-Mem*": (39.79, 18.85, 54.05, 49.91),
    "LangMem": (62.23, 47.92, 71.12, 23.43),
    "Zep": (61.70, 41.35, 76.60, 49.31),
    "OpenAI": (63.79, 42.92, 62.29, 21.71),
    "Mem0": (67.13, 51.15, 72.93, 55.51),
    "Mem0g": (65.71, 47.19, 75.71, 58.13),
}
# Mem0 Table 2 的 Overall J（列名照原表；A-Mem 對應 Table 1 的 A-Mem*）
MEM0_T2_OVERALL = {
    "A-Mem*": 48.38,  # Table 2 列名為 A-Mem
    "LangMem": 58.10,
    "Zep": 65.99,
    "OpenAI": 52.90,
    "Mem0": 66.88,
    "Mem0g": 68.44,
}


def weighted(sub, w=W):
    return sum(wi * si for wi, si in zip(w, sub)) / sum(w)


print("=" * 72)
print(f"一、權重 {W}，合計 {NW}；Open Domain 占 {W[2]}/{NW} = {W[2] / NW:.4f}")
print("=" * 72)

print("\n(a1) Hindsight Table 4：加權總分 vs 報告的 Overall")
print(f"{'列':<22} {'加權':>8} {'報告':>7} {'誤差':>8}")
max_err_nonzep = 0.0
for name, row in HINDSIGHT.items():
    wv = weighted(row[:4])
    err = wv - row[4]
    if name != "Zep":
        max_err_nonzep = max(max_err_nonzep, abs(err))
    print(f"{name:<22} {wv:>8.4f} {row[4]:>7.2f} {err:>+8.4f}{'   ← Zep' if name == 'Zep' else ''}")
print(f"→ 除 Zep 外最大 |誤差| = {max_err_nonzep:.4f}（≤ 0.01：{max_err_nonzep <= 0.01}）")
zep_w = weighted(HINDSIGHT["Zep"][:4])
print(f"→ Zep：加權 {zep_w:.4f}，報告 75.14，差 {75.14 - zep_w:.2f} 分")

print("\n(a2) Mem0 論文：Table 1 J 分項加權 vs Table 2 Overall J")
print(f"{'列':<10} {'加權':>8} {'Table 2':>8} {'誤差':>8}")
max_err_mem0 = 0.0
for name, sub in MEM0_T1_J.items():
    wv = weighted(sub)
    err = wv - MEM0_T2_OVERALL[name]
    max_err_mem0 = max(max_err_mem0, abs(err))
    print(f"{name:<10} {wv:>8.4f} {MEM0_T2_OVERALL[name]:>8.2f} {err:>+8.4f}")
print(f"→ 最大 |誤差| = {max_err_mem0:.4f}（≤ 0.01：{max_err_mem0 <= 0.01}）")

print()
print("=" * 72)
print("二、這組權重是不是資料自己要的？")
print("=" * 72)


def solve3(a, b):
    """3×3 線性方程組，高斯消去（部分主元）。"""
    m = [row[:] + [bi] for row, bi in zip(a, b)]
    for c in range(3):
        p = max(range(c, 3), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        for r in range(3):
            if r != c:
                f = m[r][c] / m[c][c]
                for j in range(c, 4):
                    m[r][j] -= f * m[c][j]
    return [m[i][3] / m[i][i] for i in range(3)]


def fit_props(rows):
    """最小平方：Σ_i p_i s_ri ≈ O_r，Σ p_i = 1。以 p4 = 1−p1−p2−p3 代入後解正規方程。"""
    X = [[s[i] - s[3] for i in range(3)] for s, _ in rows]
    y = [o - s[3] for s, o in rows]
    ata = [[sum(X[r][i] * X[r][j] for r in range(len(X))) for j in range(3)] for i in range(3)]
    aty = [sum(X[r][i] * y[r] for r in range(len(X))) for i in range(3)]
    p = solve3(ata, aty)
    p.append(1 - sum(p))
    return p


rows_h = [(v[:4], v[4]) for k, v in HINDSIGHT.items() if k != "Zep"]
rows_m = [(MEM0_T1_J[k], MEM0_T2_OVERALL[k]) for k in MEM0_T1_J]
for label, rows in (("Hindsight 除 Zep 的 9 列", rows_h), ("Mem0 論文 6 列", rows_m),
                    ("兩者合併 15 列", rows_h + rows_m)):
    p = fit_props(rows)
    print(f"(b) 最小平方擬合比例（{label}）：")
    print("    " + "、".join(f"{c} {pi:.4f}（×{NW} = {pi * NW:.1f}）" for c, pi in zip(COLS, p)))
print(f"    對照 282／96／841／321 的比例：" + "、".join(f"{w / NW:.4f}" for w in W))

p_h_with_zep = fit_props([(v[:4], v[4]) for v in HINDSIGHT.values()])
print("    若把 Hindsight 的 Zep 列也放進去擬合：" + "、".join(f"{pi * NW:.1f}" for pi in p_h_with_zep)
      + "（Zep 一列就把擬合拉偏）")

print("\n(c) 整數題數檢查：m = round(s×n/100)，看 round(100m/n, 2) 是否等於 s")
print("    單次計分的分項若恰為 m/n，就代表題數 n 是真的，不只是比例；多次平均的分項則不一定。")


def on_grid(s, n):
    m = round(s * n / 100)
    return abs(round(100 * m / n, 2) - s) < 1e-9, m


print(f"{'列':<22} " + " ".join(f"{c:>13}" for c in COLS) + "   總分 /1540")
for name, row in list(HINDSIGHT.items()) + [(f"[Mem0 T1] {k}", v + (MEM0_T2_OVERALL[k],))
                                             for k, v in MEM0_T1_J.items()]:
    cells = []
    for s, n in zip(row[:4], W):
        ok, m = on_grid(s, n)
        cells.append(f"{'是' if ok else '否'} {m:>4}/{n:<4}")
    ok_o, m_o = on_grid(row[4], NW)
    print(f"{name:<22} " + " ".join(f"{c:>13}" for c in cells) + f"   {'是' if ok_o else '否'} {m_o}")
print("    （「是」代表該分數恰好是某個整數題數除以 n 再四捨五入到兩位。）")

import math as _m
share = {n: len({round(100 * m / n, 2) for m in range(n + 1)}) / 10001 for n in W}
p_row = _m.prod(share.values())
full_rows = [k for k, v in HINDSIGHT.items() if all(on_grid(s, n)[0] for s, n in zip(v[:4], W))]
print(f"    巧合機率：兩位小數的分數隨機落在整數格上的比例 "
      + "、".join(f"n={n} {share[n]:.4f}" for n in W)
      + f"；一列四格同時落格約 {p_row:.1e}。")
print(f"    四格同時落格的列：{full_rows}（{len(full_rows)} 列），不太可能是巧合。")
g = _m.gcd(*W)
print(f"    限制：整數格對題數的公倍數（n 同乘 k）照樣成立。282／96／841／321 的最大公因數是 {g}，")
print(f"    所以不存在更小的整數組；k=2 需要 {2 * NW} 題，而 Mem0 論文寫 10 段對話、平均每段約 200 題")
print(f"    （約 2000 題，還含被排除的 adversarial），容不下 {2 * NW} 題 → 倍數被排除。")

print("    OSS-120B 列的 Single-Hop、Open Domain 與總分不在整數格上，但加權仍重現總分；")
print("    可能是多次平均或題目集合略有不同，本程式不判定。")

print("\n(d) Zep 列：把四個分項換到不同欄位（24 種排列），哪一種能重現 75.14？")
from itertools import permutations

zep = HINDSIGHT["Zep"][:4]
hits = []
print(f"    {'排列（依 SH, MH, OD, TMP 欄取值）':<40} {'加權':>8} {'誤差':>8} {'四格整數格?':>10}")
for perm in permutations(range(4)):
    vals = tuple(zep[i] for i in perm)
    wv = weighted(vals)
    grid = all(on_grid(s, n)[0] for s, n in zip(vals, W))
    mark = abs(wv - 75.14) <= 0.01
    if mark:
        hits.append((vals, wv, grid))
    if mark or perm == (0, 1, 2, 3) or grid:
        print(f"    {str(vals):<40} {wv:>8.4f} {wv - 75.14:>+8.4f} {str(grid):>10}"
              f"{'   ← 原表順序' if perm == (0, 1, 2, 3) else ''}")
n_grid = sum(1 for perm in permutations(range(4))
             if all(on_grid(zep[i], n)[0] for i, n in zip(perm, W)))
print(f"    24 種排列中，加權落在 75.14±0.01 的有 {len(hits)} 種；四格都落在整數格上的有 {n_grid} 種。")
if len(hits) == 1:
    v, wv, grid = hits[0]
    counts = [on_grid(s, n)[1] for s, n in zip(v, W)]
    print(f"    唯一解：SH {v[0]}、MH {v[1]}、OD {v[2]}、TMP {v[3]}；題數 {counts}，"
          f"合計 {sum(counts)}/1540 = {100 * sum(counts) / NW:.4f}")
    print("    也就是說，把原表 Zep 列的後三欄輪換後就對得上：列在 Multi-Hop 的 66.04 輪換到 Temporal、")
    print("    列在 Open Domain 的 67.71 輪換到 Multi-Hop、列在 Temporal 的 79.79 輪換到 Open Domain。")
    print("    快取分不出這是抄錯，還是那一列的來源用了不同的類別排序或命名。")
    print("    整數題數的合計給 75.13，與報告的 75.14 差 0.01；報告值可能是多次平均（筆記記的是 75.14 ± 0.17）。")

print()
print("=" * 72)
print("三、Hindsight 表 vs Mem0 論文：逐格比對")
print("=" * 72)
pairs = {"Mem0": "Mem0", "Mem0-Graph": "Mem0g", "LangMem": "LangMem", "OpenAI": "OpenAI", "Zep": "Zep"}
all_same_four = True
for h, m in pairs.items():
    hrow = HINDSIGHT[h]
    mrow = MEM0_T1_J[m] + (MEM0_T2_OVERALL[m],)
    same = [abs(a - b) < 1e-9 for a, b in zip(hrow, mrow)]
    if h != "Zep":
        all_same_four &= all(same)
    print(f"{h:<11} Hindsight {hrow}")
    print(f"{'':<11} Mem0      {mrow}   逐格相同：{all(same)}（{sum(same)}/5）")
print(f"→ Mem0、Mem0-Graph、LangMem、OpenAI 四列 20 格全部相同：{all_same_four}")
print("→ Zep 列兩篇不同：Hindsight 的 75.14 恰好是筆記記下的 Zep 部落格更正值（75.14 ± 0.17），")
print("  但分項加權只有約 71.30；Mem0 論文的 Zep 分項加權則重現 65.99。")

print()
print("=" * 72)
print("結論")
print("=" * 72)
print(f"(a) 證實：除 Zep 外 Hindsight 9 列最大誤差 {max_err_nonzep:.4f}；Mem0 論文 6 列最大誤差 "
      f"{max_err_mem0:.4f}；Open Domain 權重 {W[2] / NW:.4f}。")
print(f"(b) 照原表欄位證實：Zep 加權 {zep_w:.2f}，與報告的 75.14 差 {75.14 - zep_w:.2f} 分。")
print("    但後三欄輪換後加權 75.13、四格都落在整數題數上，24 種排列中唯一如此：Zep 列的類別對應")
print("    與其他列不一致。原因是抄錯還是來源的類別排序不同，快取分不出（Zep 部落格原表不在快取裡）。")
print(f"(c) 證實：四列 20 格逐格相同。")
print("無法判定：這組權重是反推的；各欄的標籤（例如 Open Domain）是否對應 LoCoMo 原始資料的類別，")
print("  兩份快取都無法確立，要拿 LoCoMo 資料集的 category 欄位逐一對照各論文的欄名才能判定。")
print("  所以「總分由 Open Domain 主導」只在「欄名正確」的前提下成立。")
print("  （推論）若 (b) 的輪換成立，表上至少有一列的欄名對應與其他列不同，所以欄名可不可信")
print("  不只是理論上的疑慮；同一個 category 對照檢查可以同時解 (b) 與這一條。")
