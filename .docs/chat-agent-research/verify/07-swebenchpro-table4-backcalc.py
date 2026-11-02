#!/usr/bin/env python3
"""驗證：SWE-Bench Pro 的 Table 4（失敗模式計數）能不能和論文其他表的解出率對上。

主張（章節 07-agent-evaluation.md〈爭議十八〉SWE-Bench Pro 那一條）：
  Table 4 只收未解決的實例（§6.3「filter to only unresolved instances」），所以
  「731 − 已提交失敗數 − 未提交失敗數」應等於該模型解出的題數。以此回推，只有 GPT-5 (high)
  對得上 Table 5；除 GPT-5 以外，Table 4 的計數對不上任何一張已報告的表。另有兩個附帶主張：
  GPT-4o 的 569 + 220 = 789 大於 public set 的 731 題；正文說 Opus 4.1 的 wrong solution 佔
  35.9%，但 Table 4 以已提交群為分母是 257÷511 ≈ 50.3%，以全部失敗為分母是 257÷689 ≈ 37.3%，
  兩者都不是 35.9%。
出處：[arXiv:2509.16941]。前兩項是組章時的重算，最後一項是精讀筆記的 limitations_observed；
  critic（C18）要求改成可重跑的程式。

輸入從哪來（全部由程式從 .cache/text/2509.16941.txt 解析並印出行號，不手抄）：
  - Table 4：每個模型一列 11 個百分比（Submitted、Not-Submitted，再來是已提交群的 6 類、
    未提交群的 3 類），下一段是同樣 11 個括號計數。
  - Table 1（N=731，SWE-Agent，無回合上限的主設定）與 Table 5（N=731，50 回合、$2 上限，
    §6 說分析都用這個設定）的解出率。Table 3 的兩個預設設定數字與 Table 5 相同，不另列。
  - §6.3 正文 Results 段裡對 Table 4 的百分比敘述。

方法：
  1. 自檢 Table 4 的內部一致：已提交群 6 類加總等於 Submitted 計數、未提交群 3 類加總等於
     Not-Submitted 計數；每個百分比等於「計數 ÷ 所屬群」四捨五入到小數點後一位。
  2. 回推：解出題數 = 731 − Submitted − Not-Submitted。與 Table 1、Table 5 的解出率換算成的
     題數比較（解出率 × 731）。表格只印到小數點後一位，所以一題的差（1/731 ≈ 0.14 個百分點）
     內都算對得上。
  3. 正文的百分比：對 Table 4 的每個計數，以兩種分母（所屬群、全部失敗）算出百分比，看正文
     寫的數字對不對得上任一種；再逐格算正文值與兩種重算值的絕對差，數出幾格比較接近「全部失敗」
     分母，並印出與全部失敗分母差距的最小值與最大值（07-results.md 的範圍照這一行寫）。

沒有用到隨機數。只用標準函式庫。執行：python3 07-swebenchpro-table4-backcalc.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TXT = os.path.join(ROOT, ".cache", "text", "2509.16941.txt")
N = 731
PCT = re.compile(r"^([0-9.]+)%$")
CNT = re.compile(r"^\((\d+)\)$")
SUB = ["Wrong Solution", "Syntax Error", "Incorrect File", "Instruction Following", "Edge Case", "Other"]
NOT = ["Tool-Use", "Long-Context", "Stuck in Loop"]


def load_lines():
    with open(TXT, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def parse_table4(lines):
    lo = find_line(lines, r"^Overall$")
    hi = find_line(lines, r"^Table 4: Failure mode analysis", lo)
    rows = []
    i = lo
    while i < hi:
        s = lines[i].strip()
        # 模型名稱行後面緊接 11 個百分比
        if s and not PCT.match(s) and not CNT.match(s) and i + 11 < hi and all(
                PCT.match(lines[i + k].strip()) for k in range(1, 12)):
            pcts = [float(PCT.match(lines[i + k].strip()).group(1)) for k in range(1, 12)]
            j = i + 12
            extra = []
            while not CNT.match(lines[j].strip()):
                if lines[j].strip():
                    extra.append(lines[j].strip())  # 例如 "Pro Preview"（模型名的第二行）
                j += 1
            cnts = [int(CNT.match(lines[j + k].strip()).group(1)) for k in range(11)]
            name = " ".join([s] + extra)
            rows.append({"name": name, "pcts": pcts, "cnts": cnts, "line": i + 1})
            i = j + 11
            continue
        i += 1
    return lo + 1, hi + 1, rows


def parse_resolve_table(lines, caption_rx):
    cap = find_line(lines, caption_rx)
    rows = {}
    j = cap - 1
    while j > 0:
        s = lines[j].strip()
        if s == "| Model":
            break
        m = re.match(r"^\|\s*([0-9.]+)$", s)
        if m:
            name = lines[j - 1].strip().lstrip("|").strip()
            rows[name] = (float(m.group(1)), j + 1)
        j -= 1
    return cap + 1, rows


def norm(name):
    n = name.lower().replace("openai ", "").replace("-", "").replace(" ", "")
    return n


def main():
    lines = load_lines()
    i_filter = find_line(lines, r"filter to only unresolved instances")
    print(f"第 {i_filter + 1} 行：Table 4 只收未解決的實例（filter to only unresolved instances）")
    lo, cap4, rows = parse_table4(lines)
    print(f"Table 4：第 {lo}–{cap4} 行，解析到 {len(rows)} 個模型：{', '.join(r['name'] for r in rows)}")
    assert len(rows) == 6, rows

    # 1. 內部一致
    bad = []
    for r in rows:
        c, p = r["cnts"], r["pcts"]
        s_, ns = c[0], c[1]
        if sum(c[2:8]) != s_:
            bad.append(f"{r['name']}：已提交 6 類加總 {sum(c[2:8])} ≠ {s_}")
        if sum(c[8:11]) != ns:
            bad.append(f"{r['name']}：未提交 3 類加總 {sum(c[8:11])} ≠ {ns}")
        denoms = [s_ + ns, s_ + ns] + [s_] * 6 + [ns] * 3
        for k in range(11):
            got = round(100 * c[k] / denoms[k], 1) if denoms[k] else 0.0
            if abs(got - p[k]) > 0.051:
                bad.append(f"{r['name']} 第 {k + 1} 欄：{c[k]}/{denoms[k]} = {got} ≠ 表上 {p[k]}")
    print("自檢（Table 4 內部一致）：" + ("全部吻合，每個百分比都是「計數 ÷ 所屬群」" if not bad else "；".join(bad)))
    assert not bad

    # 2. 回推解出率
    c1, t1 = parse_resolve_table(lines, r"^Table 1: Model performance on the public set of SWE-Bench Pro \(N=731\)")
    c5, t5 = parse_resolve_table(lines, r"^Table 5: Model performance on the public set of SWE-Bench Pro \(N=731\)")
    print(f"Table 1（第 {c1} 行，主設定）：{len(t1)} 列；Table 5（第 {c5} 行，50 回合、$2）：{len(t5)} 列")
    i_cfg = find_line(lines, r"analysis is done on trajectories with a max turn limit of 50")
    print(f"第 {i_cfg + 1} 行：§6 的分析用 50 回合、$2 的設定，對應 Table 5")
    print()
    print(f"{'模型':<24}{'已提交':>7}{'未提交':>7}{'失敗合計':>9}{'回推解出':>9}{'回推%':>8}{'Table 1':>9}{'Table 5':>9}  判定")
    matches = []
    over = []
    for r in rows:
        s_, ns = r["cnts"][0], r["cnts"][1]
        fail = s_ + ns
        solved = N - fail
        pct = 100 * solved / N
        if fail > N:
            over.append(f"{r['name']} {s_}+{ns}={fail}")
        cells = []
        hit = []
        for tname, tab in (("Table 1", t1), ("Table 5", t5)):
            m = [v for k, v in tab.items() if norm(k) == norm(r["name"])]
            if m:
                val, ln = m[0]
                cells.append(f"{val:>8.1f}")
                # 一題之差（1/731）加上表格四捨五入的 0.05 個百分點內都算對得上
                if abs(val - pct) <= 100 / N + 0.05:
                    hit.append(f"{tname}（第 {ln} 行）")
            else:
                cells.append(f"{'—':>8}")
        verdict = "對得上 " + "、".join(hit) if hit else "都對不上"
        if hit:
            matches.append(r["name"])
        print(f"{r['name']:<24}{s_:>7}{ns:>7}{fail:>9}{solved:>9}{pct:>8.1f} {cells[0]} {cells[1]}  {verdict}")
    print()
    print("失敗數超過 731 題的模型：" + ("、".join(over) if over else "沒有"))

    # 3. 正文百分比
    i_res = find_line(lines, r"^Results\. Table 4 shows the results\.")
    text = " ".join(lines[i_res:i_res + 6])
    claims = [
        ("Claude Opus 4.1", "Wrong Solution", r"wrong solutions accounting for ([0-9.]+)% of failures"),
        ("Claude Opus 4.1", "Syntax Error", r"syntax errors\s+at ([0-9.]+)%"),
        ("Claude Sonnet 4", "Long-Context", r"context overflow as its primary failure mode \(([0-9.]+)%\)"),
        ("Claude Sonnet 4", "Stuck in Loop", r"endless file reading behaviors \(([0-9.]+)%\)"),
        ("Gemini 2.5 Pro Preview", "Tool-Use", r"tool errors \(([0-9.]+)%\)"),
        ("Gemini 2.5 Pro Preview", "Syntax Error", r"syntax errors \(([0-9.]+)%\), and wrong"),
        ("Gemini 2.5 Pro Preview", "Wrong Solution", r"wrong solutions \(([0-9.]+)%\)"),
        ("Qwen3 32B", "Tool-Use", r"highest tool error rate \(([0-9.]+)%\)"),
    ]
    cats = SUB + NOT
    print()
    print(f"正文（第 {i_res + 1} 行起）的百分比，對 Table 4 計數以兩種分母重算：")
    ok = 0
    gaps = []        # (正文 − 全部失敗分母重算值 的絕對差, 模型, 類別)
    closer_all = 0   # 正文比較接近「全部失敗」分母的格數
    for model, cat, rx in claims:
        m = re.search(rx, text)
        assert m, rx
        said = float(m.group(1))
        r = [x for x in rows if x["name"] == model][0]
        k = cats.index(cat)
        cnt = r["cnts"][2 + k]
        grp = r["cnts"][0] if cat in SUB else r["cnts"][1]
        allf = r["cnts"][0] + r["cnts"][1]
        a, b = 100 * cnt / grp, 100 * cnt / allf
        hit = abs(a - said) <= 0.051 or abs(b - said) <= 0.051
        ok += hit
        gaps.append((abs(said - b), model, cat))
        closer_all += abs(said - b) < abs(said - a)
        print(f"  {model} {cat}：正文 {said}%；{cnt}÷{grp}（所屬群）= {a:.1f}%，{cnt}÷{allf}（全部失敗）= {b:.1f}%"
              f" → {'對得上' if hit else '都對不上'}；與全部失敗分母差 {abs(said - b):.1f}、與所屬群差 {abs(said - a):.1f} 個百分點")
    gmin, gmax = min(gaps), max(gaps)
    print(f"正文值比較接近「全部失敗」分母的有 {closer_all}／{len(claims)} 格；與全部失敗分母的差距最小 "
          f"{gmin[0]:.1f}（{gmin[1]} {gmin[2]}）、最大 {gmax[0]:.1f}（{gmax[1]} {gmax[2]}）個百分點")

    print()
    print(f"結論：證實。Table 4 內部一致（每個百分比都是計數 ÷ 所屬群），但以「731 減失敗數」回推解出率，"
          f"6 個模型中只有 {len(matches)} 個（{'、'.join(matches)}）對得上 Table 1 或 Table 5；"
          f"{'、'.join(over)} 超過 731 題。正文引用 Table 4 的 {len(claims)} 個百分比，"
          f"以所屬群或全部失敗為分母，只有 {ok} 個對得上；{closer_all} 個比較接近全部失敗分母的值，"
          f"差距 {gmin[0]:.1f} 到 {gmax[0]:.1f} 個百分點。Table 4 的計數很可能來自論文沒報告的另一批軌跡，"
          "正文的百分比又可能來自再另一批；只靠論文無法判定是哪一批。")


if __name__ == "__main__":
    main()
