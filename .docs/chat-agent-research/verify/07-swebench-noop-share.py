#!/usr/bin/env python3
"""驗證：SWE-bench 附錄 C.5 說「F2P 零 pass 且未解決的案例中 60%–70% 是 No-Op」，與 Table 23 逐模型不符。

主張（章節 07-agent-evaluation.md 第 563 行）：
  C.5 說未解決、而且一個 F2P 都沒過的案例中，60% 到 70% 是 No-Op。依 Table 23 重算：Claude 2 是
  471/(471+436) = 51.9%，GPT-4 是 30/(30+29) = 50.8%，只有 ChatGPT-3.5（174/(174+90) = 65.9%）
  與兩個 SWE-Llama 落在這個區間。
出處：[arXiv:2310.06770] 精讀筆記 notes/2310.06770.json 的 limitations_observed[15]。

輸入從哪來（全部由程式從 .cache/text/2310.06770.txt 解析並印出行號，不手抄）：
  - Table 22（C.5）：6 種結果由「F2P pass 幾個 × P2P pass 幾個」定義。
  - C.5 正文：「the majority ( $60\\%$ to $70\\%$ ) of cases are a No-Op」。
  - Table 23：5 個模型各自的 Applied 與 6 類結果計數。

方法：
  1. 解析 Table 22，由表格結構（不是寫死）找出「F2P = None」那一欄包含哪些結果類別。
     依定義，F2P 零 pass 時不可能是 Resolved，所以「未解決且 F2P 零 pass」＝該欄的類別聯集。
  2. 解析 Table 23，斷言每個模型的 6 類相加 = Applied。
  3. 對每個模型算 No-Op ÷（F2P=None 欄各類的和），檢查是否落在 [60%, 70%]。
  4. 補充：5 個模型合併的比例；C.5 前一句「未解決中多數是 F2P 零 pass」逐模型的比例。

沒有用到隨機數。只用標準函式庫。執行：python3 07-swebench-noop-share.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TXT = os.path.join(ROOT, ".cache", "text", "2310.06770.txt")


def load_lines():
    with open(TXT, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def block_rows(lines, lo, hi):
    """把 [lo, hi) 的 markdown 表格以空白行切列，每列是 (行號, [cells])。"""
    rows, cur, first = [], [], None
    for i in range(lo, hi):
        s = lines[i].strip()
        if not s:
            if cur:
                rows.append((first, cur))
                cur, first = [], None
            continue
        if not s.startswith("|"):
            continue
        if first is None:
            first = i + 1
        cur.append(s[1:].strip())
    if cur:
        rows.append((first, cur))
    return rows


def parse_table22(lines):
    c5 = find_line(lines, r"^### C\.5 F2P, P2P Rate Analysis")
    cap = find_line(lines, r"^Table 22:", c5)
    rows = block_rows(lines, c5, cap)
    # 預期：第 1 列 ["", "# F2P Tests Pass"]；第 2 列 ["# P2P Tests Pass", "All", "Partial", "None"]
    hdr = next(r for _, r in rows if r and r[0] == "# P2P Tests Pass")
    f2p_levels = hdr[1:]
    assert f2p_levels == ["All", "Partial", "None"], f2p_levels
    grid = {}
    for ln, r in rows:
        if r and r[0] in ("All", "Partial", "None") and len(r) == 4:
            grid[r[0]] = dict(zip(f2p_levels, r[1:]))
    assert sorted(grid) == ["All", "None", "Partial"], grid
    return cap + 1, grid


def parse_table23(lines):
    cap = find_line(lines, r"^Table 23:")
    start = max(i for i in range(cap) if lines[i].strip() == "| Model")
    rows = block_rows(lines, start, cap)
    models = rows[0][1][1:]
    data = {}
    for ln, r in rows[1:]:
        data[r[0]] = ([int(x) for x in r[1:]], ln)
        assert len(r) - 1 == len(models), (r, models)
    return start + 1, cap + 1, models, data


def main():
    lines = load_lines()

    t22_line, grid = parse_table22(lines)
    print(f"=== Table 22（第 {t22_line} 行）：列 = P2P pass 數，欄 = F2P pass 數 ===")
    corner = "P2P / F2P"
    print(f"  {corner:<10}{'All':<20}{'Partial':<20}{'None':<20}")
    for p2p in ("All", "Partial", "None"):
        print(f"  {p2p:<10}" + "".join(f"{grid[p2p][f]:<20}" for f in ("All", "Partial", "None")))
    zero_f2p = sorted({grid[p][f] for p in grid for f in ["None"]})
    print(f"  F2P = None 欄的類別：{zero_f2p}")
    assert "Resolved" not in zero_f2p
    assert set(zero_f2p) == {"No-Op", "Regression"}

    i_claim = find_line(lines, r"the majority \( \$60\\%\$ to \$70\\%\$ \) of cases are a No-Op")
    print(f"\n  C.5 原文（第 {i_claim + 1} 行）：{lines[i_claim].strip()}")
    i_prev = find_line(lines, r"do not solve a single F2P test case")
    print(f"  C.5 原文（第 {i_prev + 1} 行）：{lines[i_prev].strip()}")

    t_start, t_cap, models, data = parse_table23(lines)
    print(f"\n=== Table 23（第 {t_start}–{t_cap} 行）===")
    cats = ["Resolved", "Breaking Resolved", "Partially Resolved", "Work in Progress", "No-Op", "Regression"]
    print(f"  {'':<20}" + "".join(f"{m:>15}" for m in models))
    for k in ["Applied"] + cats:
        vals, ln = data[k]
        print(f"  {k:<20}" + "".join(f"{v:>15}" for v in vals) + f"   （第 {ln} 行）")
    print("\n  自檢：6 類相加 = Applied？")
    for j, m in enumerate(models):
        s = sum(data[c][0][j] for c in cats)
        print(f"    {m:<15} {s} vs {data['Applied'][0][j]} → {s == data['Applied'][0][j]}")
        assert s == data["Applied"][0][j]

    print("\n=== No-Op ÷（F2P 零 pass 且未解決 = " + " + ".join(zero_f2p) + "）===")
    inside = []
    tot_noop = tot_zero = 0
    for j, m in enumerate(models):
        noop = data["No-Op"][0][j]
        zero = sum(data[c][0][j] for c in zero_f2p)
        r = 100.0 * noop / zero
        tot_noop += noop
        tot_zero += zero
        ok = 60.0 <= r <= 70.0
        if ok:
            inside.append(m)
        print(f"  {m:<15} {noop}/{zero} = {r:5.1f}%  → {'在' if ok else '不在'} 60%–70%")
    pooled = 100.0 * tot_noop / tot_zero
    print(f"\n  補充：5 個模型合併 = {tot_noop}/{tot_zero} = {pooled:.2f}%（GPT-4 只跑 25% 子集，合併是各模型計數直接相加）")
    ex_claude = 100.0 * (tot_noop - data["No-Op"][0][0]) / (tot_zero - sum(data[c][0][0] for c in zero_f2p))
    print(f"  補充：去掉 Claude 2 後合併 = {ex_claude:.2f}%")

    print("\n=== 補充：C.5 前一句「未解決中多數是 F2P 零 pass」逐模型 ===")
    for j, m in enumerate(models):
        unresolved = data["Applied"][0][j] - data["Resolved"][0][j]
        zero = sum(data[c][0][j] for c in zero_f2p)
        print(f"  {m:<15} {zero}/{unresolved} = {100.0 * zero / unresolved:.1f}%")

    print("\n=== 結論 ===")
    claim_inside = {"ChatGPT-3.5", "SWE-Llama 7b", "SWE-Llama 13b"}
    print(f"  落在 60%–70% 的模型：{inside}")
    print(f"  主張的名單（ChatGPT-3.5 與兩個 SWE-Llama）：{'相符' if set(inside) == claim_inside else '不符'}")
    outside = [(m, 100.0 * data["No-Op"][0][j] / sum(data[c][0][j] for c in zero_f2p))
               for j, m in enumerate(models) if m not in inside]
    print("  不在區間的模型：" + "、".join(f"{m} {r:.1f}%" for m, r in outside))
    if outside:
        print("  → 逐模型看，C.5 的「60% 到 70%」不是每個模型都成立" +
              ("，主張證實" if set(inside) == claim_inside else ""))
    print(f"  但 5 個模型合併是 {pooled:.2f}%，" + ("落在區間下緣" if 60.0 <= pooled <= 70.0 else "不在區間") +
          "；若作者講的是合併值，原文勉強站得住。原文沒說是哪一種。")


if __name__ == "__main__":
    main()
