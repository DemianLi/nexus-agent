#!/usr/bin/env python3
"""驗證：MT-Bench-101 Table 3 的平均列有 TS、CC、MR、GR 四欄與表身 18 列的算術平均差約 0.59–0.60。

主張（章節 07-agent-evaluation.md 第 579 行）：
  以表身 18 列重算 Table 3 平均列，TS、CC、MR、GR 四欄與報告值差約 0.59–0.60，例如 MR 報告 3.61、
  重算 3.01，CC 報告 8.24、重算 8.83；正文「CC 與 FR 相對容易」與重算值相符、與平均列反而不符。
出處：[arXiv:2402.14762] 精讀筆記 notes/2402.14762.json 的 limitations_observed[0]。

輸入從哪來（全部由程式從 .cache/text/2402.14762.txt 解析並印出行號，不手抄）：
  - Table 3：表頭（Avg. | CM | SI | AR | TS | CC | CR | FR | SC | SA | MR | GR | IC | PI）、
    18 個模型列、最後的 Avg. 列。快取來源是 arxiv-html，快取 metadata 沒有記錄版本；
    筆記說它依 arXiv HTML v3，PDF 版未核對。
  - §4.2 正文：「content confusion and format rephrasing are relatively less difficult, while the
    mathematical reasoning task is the most challenging」。

方法：
  1. 以縮寫表頭為錨解析表身，斷言 18 列、每列 14 個數；平均列也要 14 個數。
  2. 解析自檢：每個模型列的 Avg. 應等於該列 13 個任務的平均（捨入誤差上限約 0.01）。
  3. 逐欄算 18 列的算術平均，與平均列的報告值相減，列出差距超過 0.05 的欄與正負號。
  4. 補充：差值是否互相抵銷（平均列的 Avg. 仍一致）；依報告值與重算值各排一次最容易／最難的任務，
     對照 §4.2 那句話。

沒有用到隨機數。只用標準函式庫。執行：python3 07-mtbench101-avg-row.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TXT = os.path.join(ROOT, ".cache", "text", "2402.14762.txt")

COLS = ["Avg.", "CM", "SI", "AR", "TS", "CC", "CR", "FR", "SC", "SA", "MR", "GR", "IC", "PI"]
NUM = re.compile(r"^\d+(?:\.\d+)?$")


def load_lines():
    with open(TXT, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def parse_table3(lines):
    cap = find_line(lines, r"^Table 3: The performance of different LLMs on the 13 multi-turn")
    # 往回找最近的「| Model」
    start = max(i for i in range(cap) if lines[i].strip() == "| Model")
    toks = []
    for i in range(start, cap):
        s = lines[i].strip()
        if s.startswith("|"):
            s = s[1:].strip()
        if s:
            toks.append((i + 1, s))
    words = [t for _, t in toks]
    # 以縮寫表頭為錨：找連續 14 個 token 等於 COLS 的位置
    anchor = None
    for j in range(len(words) - len(COLS) + 1):
        if words[j:j + len(COLS)] == COLS:
            anchor = j
            break
    if anchor is None:
        raise SystemExit("找不到縮寫表頭 Avg. | CM | … | PI")
    header_line = toks[anchor][0]
    j = anchor + len(COLS)
    rows, avg_row = [], None
    while j < len(toks):
        ln, name = toks[j]
        vals = [t for _, t in toks[j + 1:j + 1 + len(COLS)]]
        if len(vals) != len(COLS) or not all(NUM.match(v) for v in vals):
            raise SystemExit(f"第 {ln} 行的「{name}」後面不是 14 個數字，解析錯位：{vals}")
        vals = [float(v) for v in vals]
        if name == "Avg.":
            avg_row = (ln, vals)
            j += 1 + len(COLS)
            break
        rows.append((name, vals, ln))
        j += 1 + len(COLS)
    if avg_row is None:
        raise SystemExit("找不到平均列")
    return start + 1, header_line, cap + 1, rows, avg_row


def main():
    lines = load_lines()
    t_start, header_line, cap_line, rows, (avg_line, avg_rep) = parse_table3(lines)
    print(f"=== Table 3（第 {t_start}–{cap_line} 行；縮寫表頭在第 {header_line} 行；平均列在第 {avg_line} 行）===")
    print(f"  模型列數 = {len(rows)}")
    assert len(rows) == 18, len(rows)
    for name, vals, ln in rows:
        assert len(vals) == 14
    print("  模型：" + "、".join(n for n, _, _ in rows))

    # 解析自檢：每列 Avg. = 13 個任務平均
    print("\n=== 解析自檢：每列 Avg. 是否等於 13 個任務的平均 ===")
    max_err, worst = 0.0, None
    for name, vals, ln in rows:
        rec = sum(vals[1:]) / 13
        err = abs(rec - vals[0])
        if err > max_err:
            max_err, worst = err, (name, vals[0], rec)
    print(f"  18 列最大誤差 = {max_err:.4f}（{worst[0]}：報告 {worst[1]:.2f}，重算 {worst[2]:.4f}）")
    parse_ok = max_err <= 0.011
    print("  → " + ("各列 Avg. 與任務平均一致，欄位沒有錯位" if parse_ok else "有列對不上，解析或表身可能有誤"))

    # 逐欄比較
    print("\n=== 逐欄：18 列算術平均 vs 平均列報告值 ===")
    print(f"  {'欄':<5}{'報告':>7}{'重算':>9}{'差(報告−重算)':>15}")
    rec_cols = []
    flagged = []
    for k, c in enumerate(COLS):
        rec = sum(v[k] for _, v, _ in rows) / len(rows)
        rec_cols.append(rec)
        d = avg_rep[k] - rec
        mark = "  ←" if abs(d) > 0.05 else ""
        print(f"  {c:<5}{avg_rep[k]:>7.2f}{rec:>9.3f}{d:>+15.3f}{mark}")
        if abs(d) > 0.05:
            flagged.append((c, avg_rep[k], rec, d))
    ok_cols = [c for c in COLS if c not in {f[0] for f in flagged}]
    print(f"\n  差距 > 0.05 的欄：{[f[0] for f in flagged]}")
    print(f"  一致的欄（差距 ≤ 0.05）：{ok_cols}（{len(ok_cols)} 欄）")
    if flagged:
        ds = [abs(f[3]) for f in flagged]
        print(f"  這幾欄的差距範圍：{min(ds):.3f}–{max(ds):.3f}")
        print("  正負號：" + "；".join(f"{c} 報告{'偏高' if d > 0 else '偏低'} {abs(d):.2f}" for c, _, _, d in flagged))
        net = sum(f[3] for f in flagged)
        print(f"  四欄差值相加 = {net:+.3f}（互相抵銷，所以平均列的 Avg. 仍與 18 列平均一致："
              f"報告 {avg_rep[0]:.2f}、重算 {rec_cols[0]:.3f}）")
        # 平均列自身：Avg. 是否等於平均列 13 格的平均
        self_avg = sum(avg_rep[1:]) / 13
        print(f"  平均列 13 格的平均 = {self_avg:.3f}，平均列的 Avg. 報告 {avg_rep[0]:.2f}")

    # 補充：難易排序
    i_txt = find_line(lines, r"content confusion and format rephrasing are relatively less difficult")
    print(f"\n=== 補充：§4.2 的難易說法（第 {i_txt + 1} 行）===")
    print("  " + re.search(r"Among all the tasks.*?challenging\.", lines[i_txt]).group(0))
    tasks = list(range(1, 14))
    by_rep = sorted(tasks, key=lambda k: -avg_rep[k])
    by_rec = sorted(tasks, key=lambda k: -rec_cols[k])
    print("  依報告的平均列，由易到難：" + " > ".join(f"{COLS[k]}({avg_rep[k]:.2f})" for k in by_rep))
    print("  依重算的 18 列平均，由易到難：" + " > ".join(f"{COLS[k]}({rec_cols[k]:.2f})" for k in by_rec))
    top2_rep = {COLS[k] for k in by_rep[:2]}
    top2_rec = {COLS[k] for k in by_rec[:2]}
    print(f"  最容易的兩項：報告值 {sorted(top2_rep)}，重算值 {sorted(top2_rec)}；正文說 CC 與 FR")
    print(f"  最難的一項：報告值 {COLS[by_rep[-1]]}，重算值 {COLS[by_rec[-1]]}；正文說 MR")

    # 結論
    want = {"TS", "CC", "MR", "GR"}
    got = {f[0] for f in flagged}
    in_range = all(0.585 <= abs(f[3]) <= 0.605 for f in flagged)
    mr = next(f for f in flagged if f[0] == "MR") if "MR" in got else None
    cc = next(f for f in flagged if f[0] == "CC") if "CC" in got else None
    print("\n=== 結論 ===")
    print(f"  對不上的欄 = {sorted(got)}（主張 TS、CC、MR、GR）：{'相符' if got == want else '不符'}")
    print(f"  差距都在 0.59–0.60（容許 ±0.005 的捨入）：{'相符' if in_range else '不符'}")
    if mr and cc:
        print(f"  MR 報告 {mr[1]:.2f}、重算 {mr[2]:.2f}（主張 3.61 / 3.01）；CC 報告 {cc[1]:.2f}、重算 {cc[2]:.2f}（主張 8.24 / 8.83）")
    print(f"  正文「CC 與 FR 相對容易」：與重算值{'相符' if top2_rec == {'CC', 'FR'} else '不符'}、"
          f"與平均列{'相符' if top2_rep == {'CC', 'FR'} else '不符'}")
    ok = parse_ok and got == want and in_range
    print("  主張" + ("證實" if ok else "不成立或部分不成立") + "（只驗快取的 arxiv-html 版本，PDF 版未核對）")


if __name__ == "__main__":
    main()
