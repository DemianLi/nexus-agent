#!/usr/bin/env python3
"""驗證：多代理辯論 Table 1／Table 2 的 ± 與 n=100 的二項標準誤是否吻合。

主張（章節 05-self-correction-reflection.md 第 410–411 行），分兩個來源：
  (A) 精讀筆記的原主張：Arithmetic 辯論列 81.8±2.3 與 n≈100、p≈0.82 的二項標準誤（約 3.9）對不上，
      其他列大致吻合。
      出處：[arXiv:2305.14325] notes/2305.14325.json 的 limitations_observed 第 4 條。
  (B) 組章時延伸的新主張（與筆記「其他列大致吻合」相反）：Chess Move Validity 三列 ±2.6／2.9／2.9 也對不上，
      29.3、38.8、45.2 的公式值約 4.55、4.87、4.98，三列都大於 4.5；Arithmetic、GSM8K、MMLU 其餘 10 個
      比例格與公式值相差都不超過 0.1。
      出處：章節第 411 行（「本章用同一個公式 √(p(1−p)/100) 再核」），不是筆記欄位。

輸入從哪來：
  - Table 1、Table 2 的「值 $\\pm$ 誤差」全部由本程式從 .cache/text/2305.14325.txt 解析，
    錨點是表題「Table 1: Multiagent Debate Improves Reasoning」與「Table 2: Multiagent Debate Improves Factual
    Accuracy」，輸出附行號。
  - 各任務題數取自同一份全文附錄 A.2（程式印出原句）：Arithmetic、GSM8K、MMLU、Chess Validity 都寫
    one hundred；Chess（ΔPS）是 300 盤、不是比例，排除；Biographies 是按條列點計的比例、不是對 100 題
    計算，排除。

方法：
  1. 每個比例格算 100×√(p(1−p)/100)，列出與表上 ± 的差。
  2. 反推：若 ± 是二項標準誤，n = p(1−p)/(±/100)²。p 取 ±0.05、± 取 ±0.05 的捨入區間，得出 n 的可能範圍。
  3. 檢查 Chess Validity 三列的 n 範圍有沒有交集，以及交集（或各自範圍）內有沒有 n 能讓 p 落在 k/n 的格點上。
  4. 在全文搜尋可能定義 ± 的字眼（standard error／deviation、std、seed、runs、trials、confidence interval、
     error bar、variance），印出命中的行，確認論文有沒有把 ± 定義成別的量。

無隨機數，不需種子。只用標準函式庫。執行：python3 05-debate-binomial-se.py
"""

import math
import re
import sys
from fractions import Fraction
from pathlib import Path

TEXT = Path(__file__).resolve().parent.parent / ".cache" / "text" / "2305.14325.txt"
CELL = re.compile(r"^\| (\d+\.\d) \$\\pm\$ (\d+\.\d)$")


def parse(lines, caption_prefix, expected_cols):
    cap = [i for i, l in enumerate(lines) if l.startswith(caption_prefix)]
    assert len(cap) == 1, f"表題 {caption_prefix!r} 應恰好一次，實際 {len(cap)}"
    cap = cap[0]
    head = next(i for i in range(cap - 1, -1, -1) if lines[i].strip() == "| Model")
    groups, cur = [], []
    for i in range(head, cap):
        s = lines[i].strip()
        if not s:
            if cur:
                groups.append(cur)
                cur = []
            continue
        cur.append((i + 1, s))
    if cur:
        groups.append(cur)
    header = [s.lstrip("|").strip() for _, s in groups[0][1:]]
    assert header == expected_cols, f"表頭不符：{header}"
    rows = {}
    for g in groups[1:]:
        name = g[0][1].lstrip("|").strip()
        cells = []
        for ln, s in g[1:]:
            m = CELL.match(s)
            assert m, f"第 {ln} 行格式不符：{s!r}"
            cells.append((m.group(1), m.group(2), ln))
        assert len(cells) == len(expected_cols), f"{name} 格數不符"
        rows[name] = dict(zip(expected_cols, cells))
    return cap + 1, rows


def pq_range(p_lo, p_hi):
    vals = [p_lo * (1 - p_lo), p_hi * (1 - p_hi)]
    if p_lo <= 0.5 <= p_hi:
        vals.append(0.25)
    return min(vals), max(vals)


def n_range(p_s, se_s):
    p, se = float(p_s) / 100, float(se_s) / 100
    lo_pq, hi_pq = pq_range(p - 0.0005, p + 0.0005)
    n_lo = lo_pq / (se + 0.0005) ** 2
    n_hi = hi_pq / (se - 0.0005) ** 2
    return n_lo, n_hi


def on_grid(p_s, n):
    """是否存在整數 k 使 100k/n 四捨五入到一位小數等於 p（閉區間，偏寬鬆）。"""
    X = Fraction(p_s)
    lo, hi = X - Fraction(1, 20), X + Fraction(1, 20)
    kmin = -(-(lo * n) // 100)
    return kmin * 100 <= hi * n


def main():
    lines = TEXT.read_text(encoding="utf-8").splitlines()
    print(f"來源：{TEXT}")
    for task, pat in (("Arithmetic", "one\nhundred generated arithmetic"), ("GSM8K", "one hundred grade school math"),
                      ("MMLU", "one hundred selected MMLU"), ("Chess Validity", "one hundred selected chess validity"),
                      ("Chess ΔPS", "three hundred selected chess games")):
        text = "\n".join(lines)
        idx = text.find(pat)
        ln = text.count("\n", 0, idx) + 1 if idx >= 0 else None
        print(f"  題數依據 {task:<15} 「{pat.replace(chr(10), ' ')}」在第 {ln} 行")

    c1, t1 = parse(lines, "Table 1: Multiagent Debate Improves Reasoning",
                   ["Arithmetic (%) $\\uparrow$", "Grade School Math (%) $\\uparrow$", "Chess ( $\\Delta$ PS) $\\uparrow$"])
    c2, t2 = parse(lines, "Table 2: Multiagent Debate Improves Factual Accuracy",
                   ["Biographies", "MMLU", "Chess Move Validity"])
    print(f"  Table 1 表題第 {c1} 行、Table 2 表題第 {c2} 行")

    cells = []
    for row, d in t1.items():
        cells.append(("Arithmetic", row, *d["Arithmetic (%) $\\uparrow$"]))
        cells.append(("GSM8K", row, *d["Grade School Math (%) $\\uparrow$"]))
    for row, d in t2.items():
        cells.append(("MMLU", row, *d["MMLU"]))
        cells.append(("Chess Validity", row, *d["Chess Move Validity"]))
    order = ["Arithmetic", "GSM8K", "MMLU", "Chess Validity"]
    cells.sort(key=lambda c: order.index(c[0]))
    print(f"  納入的比例格：{len(cells)} 格（排除 Chess ΔPS 4 格、Biographies 3 格）")

    print(f"\n{'任務':<15}{'方法':<27}{'p':>6}{'表上±':>7}{'公式值':>8}{'差(公式−表)':>12}  {'反推 n 範圍':<16}{'p 在 1/100 格點?':<16}{'行號'}")
    res = []
    for task, row, p_s, se_s, ln in cells:
        p = float(p_s)
        f = 100 * math.sqrt((p / 100) * (1 - p / 100) / 100)
        diff = f - float(se_s)
        nlo, nhi = n_range(p_s, se_s)
        g100 = on_grid(p_s, 100)
        print(f"{task:<15}{row:<27}{p_s:>6}{se_s:>7}{f:>8.2f}{diff:>+12.2f}  [{nlo:6.1f}, {nhi:6.1f}]  {'是' if g100 else '否':<16}{ln}")
        res.append(dict(task=task, row=row, p=p_s, se=se_s, f=f, diff=diff, nlo=nlo, nhi=nhi, ln=ln))

    chess = [r for r in res if r["task"] == "Chess Validity"]
    arith_debate = [r for r in res if r["task"] == "Arithmetic" and "Debate" in r["row"]][0]
    others = [r for r in res if r["task"] != "Chess Validity" and r is not arith_debate]

    print("\n=== Chess Validity 三列的 n 範圍是否有共同的 n ===")
    lo = max(math.ceil(r["nlo"]) for r in chess)
    hi = min(math.floor(r["nhi"]) for r in chess)
    print(f"  三列 n 範圍的交集：{'[' + str(lo) + ', ' + str(hi) + ']' if lo <= hi else '空集合'}")
    for r in chess:
        ns = [n for n in range(math.ceil(r["nlo"]), math.floor(r["nhi"]) + 1) if on_grid(r["p"], n)]
        print(f"  {r['row']:<27} p={r['p']}：範圍內能讓 p 落在 k/n 格點上的 n 共 {len(ns)} 個"
              f"{'，例如 ' + str(ns[:6]) if ns else ''}；n=300 在格點上？{'是' if on_grid(r['p'], 300) else '否'}")
    ns_ar = [n for n in range(math.ceil(arith_debate['nlo']), math.floor(arith_debate['nhi']) + 1) if on_grid(arith_debate['p'], n)]
    print(f"  （對照）Arithmetic 辯論列 p=81.8 反推 n 範圍 [{arith_debate['nlo']:.1f}, {arith_debate['nhi']:.1f}]，"
          f"其中在格點上的 n 共 {len(ns_ar)} 個")

    print("\n=== 全文搜尋 ± 的定義 ===")
    pats = [r"standard error", r"standard deviation", r"\bstd\b", r"\bseeds?\b", r"\bruns\b", r"\btrials?\b",
            r"confidence interval", r"error bar", r"\bvariance\b", r"\bconfidence\b"]
    for pat in pats:
        hits = [i + 1 for i, l in enumerate(lines) if re.search(pat, l, re.I)]
        print(f"  /{pat}/i：{len(hits)} 行 {hits}")
    for i, l in enumerate(lines):
        if re.search(r"\bconfidence\b", l, re.I):
            print(f"    第 {i + 1} 行：{l.strip()[:120]}")
    pm_outside = [i + 1 for i, l in enumerate(lines) if "\\pm" in l and not CELL.match(l.strip())]
    print(f"  表格儲存格以外出現 $\\pm$ 的行：{pm_outside or '無'}")

    print("\n=== 結論 ===")
    ok_others = all(abs(r["diff"]) <= 0.1 for r in others)
    print(f"其餘 {len(others)} 格（Arithmetic 3、GSM8K 4、MMLU 3）|公式−表| 最大值：{max(abs(r['diff']) for r in others):.3f}"
          f" → {'都不超過 0.1' if ok_others else '有超過 0.1 的'}；反推 n 範圍涵蓋 100 的格數："
          f"{sum(r['nlo'] <= 100 <= r['nhi'] for r in others)}/{len(others)}")
    print(f"子主張 4a（筆記原主張：Arithmetic 辯論列 ±2.3 對不上，公式約 3.9）："
          f"{'證實' if arith_debate['diff'] > 1.0 else '推翻'}（公式 {arith_debate['f']:.2f}，差 {arith_debate['diff']:+.2f}）")
    chess_ok = all(r["f"] > 4.5 and r["diff"] > 1.5 for r in chess)
    fs = ", ".join("%.2f" % r["f"] for r in chess)
    ds = ", ".join("%+.2f" % r["diff"] for r in chess)
    print(f"子主張 4b（本章延伸：Chess Validity 三列公式值都 > 4.5、差都 > 1.5）："
          f"{'證實' if chess_ok else '推翻'}（公式 {fs}；差 {ds}）")
    print(f"子主張 4c（其餘 10 格差都不超過 0.1，唯一例外是 Arithmetic 辯論列）：{'證實' if ok_others and len(others) == 10 else '推翻'}")
    off_grid_ok = [r["p"] for r in others if not on_grid(r["p"], 100)]
    print(f"子主張 4d（成因是 ± 算錯）：無法判定。這四格的 ± 與附錄的 n=100 不一致，但論文沒有定義 ±。"
          f"反推 n 約 270–320；Chess 三列沒有共同的 n；扣題只會讓 ± 變大，方向相反。"
          f"「不在 1/100 格點上」分不出來：吻合的 10 格中也有 {off_grid_ok} 不在格點上。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
