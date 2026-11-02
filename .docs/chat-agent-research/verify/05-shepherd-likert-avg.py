#!/usr/bin/env python3
"""驗證：Shepherd Table 5（人工 Likert）的 Avg 欄與逐欄數字互相矛盾，Table 6（GPT-4 Likert）則相符。

主張（章節 05-self-correction-reflection.md 第 420 行）：
  Table 5 逐欄重算，Shepherd 約 4.55、ChatGPT 約 4.31，表上卻寫 4.41 與 4.59，高低整個顛倒。
  同一種重算套在 Table 6，平均欄與逐欄相符（ChatGPT 約 6.25），所以出錯的是 Table 5。
  逐欄看，Shepherd 在 6 個公開集中贏了 5 個，只輸 AlpacaFarm（4.38 對 4.56）。
出處：[arXiv:2308.04592] 精讀筆記 notes/2308.04592.json 的 limitations_observed 第 2 條。

輸入從哪來：
  - 全部表格數字都由本程式從 .cache/text/2308.04592.txt 解析：以表題
    「Table 5: Likert score on 1-7 scale given by Human」與「Table 6: Likert score on 1-7 scale given by GPT-4」
    為錨點往上找表頭，輸出時附上每個數字所在的行號。
  - 各資料集題數（6 個公開集各 50 題、CritiqueEval 52 題）取自同一份全文 §4.1（程式也從全文抓那兩句）。
  - 「公開集」的範圍取自 §4.1：6 個公開集＋自建的 CritiqueEval。

方法：
  1. 每列 7 欄算簡單平均，與表上 Avg 比；容差 0.01（表上 Avg 的捨入 0.005 ＋ 各欄捨入造成的平均誤差上限 0.005）。
  2. 排除「Avg 本來就是別種平均」：任何非負加權平均都落在 [七欄最小值, 七欄最大值] 之內（再放寬 0.005 的捨入）。
     表上 Avg 若落在區間外，就沒有任何加權方式能產生它。另外也依題數加權（50×6、52）算一次。
  3. Table 6 用同一套算法當對照組。
  4. 6 個公開集逐欄比較 Shepherd 與 ChatGPT。

無隨機數，不需種子。只用標準函式庫。執行：python3 05-shepherd-likert-avg.py
"""

import re
import sys
from pathlib import Path

TEXT = Path(__file__).resolve().parent.parent / ".cache" / "text" / "2308.04592.txt"
EXPECTED_COLS = ["AlpacaFarm", "FairEval", "CosmosQA", "OBQA", "PIQA", "TruthfulQA", "CritiqueEval", "Avg."]
EXPECTED_ROWS = ["Alpaca 7B", "SelFee 7B", "ChatGPT", "Shepherd 7B"]
PUBLIC = EXPECTED_COLS[:6]
SIZES = {c: 50 for c in PUBLIC}
SIZES["CritiqueEval"] = 52
TOL_AVG = 0.01
HALF = 0.005


def load():
    return TEXT.read_text(encoding="utf-8").splitlines()


def parse_table(lines, caption_prefix):
    cap = [i for i, l in enumerate(lines) if l.startswith(caption_prefix)]
    assert len(cap) == 1, f"表題 {caption_prefix!r} 應恰好出現一次，實際 {len(cap)}"
    cap = cap[0]
    # 往上找表頭（"| AlpacaFarm" 的前一行是空欄 "|"）
    head = None
    for i in range(cap - 1, -1, -1):
        if lines[i].strip() == "| AlpacaFarm":
            head = i - 1
            break
    assert head is not None and lines[head].strip() == "|", "找不到表頭"
    # 以空行切群組
    groups, cur = [], []
    for i in range(head, cap):
        s = lines[i].strip()
        if not s:
            if cur:
                groups.append(cur)
                cur = []
            continue
        cur.append((i + 1, s))  # 行號從 1 起算
    if cur:
        groups.append(cur)
    header = [s.lstrip("|").strip() for _, s in groups[0][1:]]
    assert header == EXPECTED_COLS, f"表頭不符：{header}"
    rows = {}
    for g in groups[1:]:
        name = g[0][1].lstrip("|").strip()
        vals = []
        for ln, s in g[1:]:
            v = s.lstrip("|").strip()
            assert re.fullmatch(r"\d+\.\d\d", v), f"第 {ln} 行不是兩位小數：{v!r}"
            vals.append((float(v), ln))
        assert len(vals) == 8, f"{name} 應有 8 格，實際 {len(vals)}"
        rows[name] = vals
    assert list(rows) == EXPECTED_ROWS, f"列名不符：{list(rows)}"
    return cap + 1, rows


def analyse(title, cap_line, rows):
    print(f"\n=== {title}（表題在第 {cap_line} 行）===")
    print(f"{'列':<12}{'逐欄平均':>9}{'題數加權':>9}{'表上Avg':>9}{'差':>8}  {'七欄區間':<14}{'Avg在區間內?':<12}{'判讀'}")
    out = {}
    for name, vals in rows.items():
        cols = [v for v, _ in vals[:7]]
        avg_listed, avg_ln = vals[7]
        mean = sum(cols) / 7
        wmean = sum(v * SIZES[c] for v, c in zip(cols, EXPECTED_COLS[:7])) / sum(SIZES.values())
        lo, hi = min(cols), max(cols)
        inside = (lo - HALF) <= avg_listed <= (hi + HALF)
        ok = abs(mean - avg_listed) <= TOL_AVG
        verdict = "相符" if ok else ("不符；任何非負加權都到不了" if not inside else "不符")
        print(f"{name:<12}{mean:>9.3f}{wmean:>9.3f}{avg_listed:>9.2f}{avg_listed - mean:>+8.3f}  "
              f"[{lo:.2f}, {hi:.2f}]    {'是' if inside else '否':<12}{verdict}（Avg 在第 {avg_ln} 行）")
        out[name] = dict(mean=mean, listed=avg_listed, ok=ok, inside=inside, cols=cols, lines=[ln for _, ln in vals])
    return out


def main():
    lines = load()
    print(f"來源：{TEXT}")
    for pat in ("we carefully select 6 public datasets", "sample 50 instances", "containing 52 Pushshift"):
        hit = [i + 1 for i, l in enumerate(lines) if pat in l]
        print(f"  題數／公開集依據「{pat}」在第 {hit} 行")

    c5, t5 = parse_table(lines, "Table 5: Likert score on 1-7 scale given by Human")
    c6, t6 = parse_table(lines, "Table 6: Likert score on 1-7 scale given by GPT-4")

    for name in ("ChatGPT", "Shepherd 7B"):
        v = t5[name]
        print(f"  Table 5 {name} 各欄取自第 {v[0][1]}–{v[7][1]} 行：{[x for x, _ in v]}")
    v = t6["ChatGPT"]
    print(f"  Table 6 ChatGPT 各欄取自第 {v[0][1]}–{v[7][1]} 行：{[x for x, _ in v]}")

    r5 = analyse("Table 5 人工 Likert", c5, t5)
    r6 = analyse("Table 6 GPT-4 Likert（對照組）", c6, t6)

    print("\n=== 6 個公開集逐欄比較（Table 5）===")
    s, c = t5["Shepherd 7B"], t5["ChatGPT"]
    wins = 0
    for k, col in enumerate(PUBLIC):
        sv, cv = s[k][0], c[k][0]
        w = "Shepherd" if sv > cv else ("ChatGPT" if cv > sv else "平手")
        wins += sv > cv
        print(f"  {col:<11} Shepherd {sv:.2f}  ChatGPT {cv:.2f}  差 {sv - cv:+.2f}  → {w}")
    print(f"  Shepherd 贏 {wins}/6 個公開集")

    print("\n=== 結論 ===")
    sh, cg = r5["Shepherd 7B"], r5["ChatGPT"]
    flipped = (sh["mean"] > cg["mean"]) and (sh["listed"] < cg["listed"])
    print(f"子主張 1a（Table 5 逐欄 Shepherd≈4.55、ChatGPT≈4.31，表上 4.41／4.59，高低顛倒）："
          f"{'證實' if (round(sh['mean'], 2) == 4.55 and round(cg['mean'], 2) == 4.31 and flipped) else '推翻'}"
          f"（逐欄 {sh['mean']:.3f} 對 {cg['mean']:.3f}；表上 {sh['listed']:.2f} 對 {cg['listed']:.2f}）")
    bad5 = [n for n, r in r5.items() if not r["ok"]]
    print(f"  Table 5 四列中平均欄不符的列：{bad5}")
    out_of_range = [n for n, r in r5.items() if not r["inside"]]
    print(f"  表上 Avg 落在七欄區間外（任何非負加權都到不了）的列：{out_of_range}")
    bad6 = [n for n, r in r6.items() if not r["ok"]]
    print(f"子主張 1b（Table 6 平均欄與逐欄相符，ChatGPT≈6.25）："
          f"{'證實' if (not bad6 and round(r6['ChatGPT']['mean'], 2) == 6.25) else '推翻'}"
          f"（Table 6 不符的列：{bad6 or '無'}；ChatGPT 逐欄 {r6['ChatGPT']['mean']:.3f}）")
    lose = [PUBLIC[k] for k in range(6) if s[k][0] < c[k][0]]
    print(f"子主張 1c（6 個公開集 Shepherd 贏 5 個、只輸 AlpacaFarm 4.38 對 4.56）："
          f"{'證實' if (wins == 5 and lose == ['AlpacaFarm']) else '推翻'}"
          f"（輸的欄：{lose}；最小差距 PIQA {s[4][0] - c[4][0]:+.2f}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
