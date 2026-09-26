#!/usr/bin/env python3
"""驗證：GAIA 的 human score 能不能由 Table 3 的驗證統計重建，以及它在建構上的下限。

主張（章節 07-agent-evaluation.md〈評估方式〉人類基準「用評估器篩出來，或與題目定義互相循環」那一條）：
  GAIA 的 human score 只在有效題上計算；精讀時依 Table 3 重建 (55×2+13)÷(68×2) ≈ 90.4%，接近報告
  的 92%，並指出依 Table 3 腳註的定義，有效題至少有一位驗證者答對，所以這個分數在建構上就有 50%
  的下限。
出處：[arXiv:2311.12983] 精讀筆記的 limitations_observed；critic（C18）要求改成可重跑的程式。

輸入從哪來（全部由程式從 .cache/text/2311.12983.txt 解析並印出行號，不手抄）：
  - Table 3：兩位新標註者都同意原答案 55%、一同意一不同意 27%、都不同意 18%、有效題 68%，
    以及 human score（整體 92%，各 Level 94%／92%／87%）與各 Level 的有效題比例。
  - Table 3 caption 的兩個腳註：有效題的定義、human score 的定義。

方法與假設：
  假設每位新標註者對每題只給一個答案（腳註寫「all tentative」，若允許多次嘗試，這個重建就不適用）。
  依腳註，有效題 = 兩人都答對的題（比例 a）＋一人答對、另一人「made a mistake」的題（v − a），
  所以 human score = (2a + (v − a)) / (2v) = 1/2 + a/(2v)，這個式子自己就說明了下限是 50%。
  1. 以表上的 a = 55%、v = 68% 代入。
  2. 表上的百分比都印成整數，所以 a、v 各有 ±0.5 個百分點的進位範圍；算出重建值的最大與最小可能。
  3. 反解：若 92% 是對的，a 要是多少；與表上的 55% 比較。

沒有用到隨機數。只用標準函式庫。執行：python3 07-gaia-human-score.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TXT = os.path.join(ROOT, ".cache", "text", "2311.12983.txt")


def load_lines():
    with open(TXT, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def cell(lines, label_rx, start):
    i = find_line(lines, label_rx, start)
    m = re.match(r"^\|\s*(\d+)%$", lines[i + 1].strip())
    assert m, lines[i + 1]
    return float(m.group(1)), i + 1


def main():
    lines = load_lines()
    cap = find_line(lines, r"^Table 3: Statistics on the validation phase")
    lo = cap - 45
    print(f"Table 3 caption 在第 {cap + 1} 行")
    for rx in (r"a valid question is a question for which two", r"the human baseline is computed as the fraction of correct"):
        i = find_line(lines, rx, cap)
        print(f"  第 {i + 1} 行（腳註）：…{lines[i].strip()[-120:]}")

    a, la = cell(lines, r"^\| Two new annotators agree with original answer$", lo)
    one, lo1 = cell(lines, r"^\| One new annotator agree with original answer, other disagree$", lo)
    none, ln = cell(lines, r"^\| Two new annotators disagree with original answer$", lo)
    v, lv = cell(lines, r"^\| Valid questions \(aggregated\)\*$", lo)
    h, lh = cell(lines, r"^\| Human score \(aggregated\)\*\*$", lo)
    lv_levels = [cell(lines, rf"^\| Valid Level {k} questions$", lo) for k in (1, 2, 3)]
    lh_levels = [cell(lines, rf"^\| Human score for Level {k}$", lo) for k in (1, 2, 3)]
    print(f"  兩人都同意 {a}%（第 {la} 行）、一同意一不同意 {one}%（第 {lo1} 行）、都不同意 {none}%（第 {ln} 行）")
    print(f"  有效題 {v}%（第 {lv} 行）、human score {h}%（第 {lh} 行）")
    assert a + one + none == 100, (a, one, none)
    assert a <= v <= a + one, (a, v, one)
    print(f"自檢：{a} + {one} + {none} = 100；{a} ≤ 有效題 {v} ≤ {a} + {one}，所以一人答對的有效題佔 {v} − {a} = {v - a:.0f}%")

    print()
    rebuilt = (2 * a + (v - a)) / (2 * v)
    print(f"方法 1：({a:.0f}×2 + {v - a:.0f}) ÷ ({v:.0f}×2) = {2 * a + (v - a):.0f}/{2 * v:.0f} = {rebuilt:.2%}；報告值 {h:.0f}%")

    corners = [(a + da, v + dv) for da in (-0.5, 0.5) for dv in (-0.5, 0.5)]
    vals = [0.5 + x / (2 * y) for x, y in corners]
    h_lo = (h - 0.5) / 100
    print(f"方法 2：a、v 各在 ±0.5 的進位範圍內，重建值介於 {min(vals):.2%} 與 {max(vals):.2%}；"
          f"報告的 {h:.0f}% 本身也是整數，最低可能是 {h_lo:.1%}，"
          f"{'仍高於重建值的上限' if h_lo > max(vals) else '與重建範圍重疊'}")

    need_a = (h / 100 - 0.5) * 2 * v
    print(f"方法 3：若 human score 真是 {h:.0f}%，兩人都答對的比例要是 ({h:.0f}% − 50%)×2×{v:.0f}% = {need_a:.1f}%（表上是 {a:.0f}%）")
    print("  各 Level 依同一式子反推兩人都答對的比例（表上沒有這一格，只作參考）：")
    for k, ((vv, _), (hh, _)) in enumerate(zip(lv_levels, lh_levels), 1):
        print(f"    Level {k}：有效題 {vv:.0f}%、human score {hh:.0f}% → ({hh:.0f}% − 50%)×2×{vv:.0f}% = {(hh / 100 - 0.5) * 2 * vv:.1f}%")

    print()
    print(f"結論：證實，並收緊。在「每位標註者每題一個答案」的假設下，human score = 1/2 + a/(2v)，建構上的下限是 50%；"
          f"以表上的數字重建得 {rebuilt:.1%}，即使把兩個整數百分比推到進位範圍的兩端，最多也只有 {max(vals):.1%}，"
          f"而報告的 {h:.0f}% 最低也有 {h - 0.5:.1f}%，兩者不重疊；要得到 {h:.0f}%，兩人都答對的比例得是 {need_a:.1f}% 而不是 {a:.0f}%。"
          "差距的來源可能是腳註「all tentative」允許多次嘗試，論文沒有說明。")


if __name__ == "__main__":
    main()
