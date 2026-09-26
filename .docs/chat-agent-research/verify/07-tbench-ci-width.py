#!/usr/bin/env python3
"""驗證：Terminal-Bench Table 2 的 ± 值，能不能全是「逐次獨立試跑」的 95% 二項區間。

主張（章節 07-agent-evaluation.md〈陷阱八〉Terminal-Bench 那一條）：
  假設 ± 值是把每次試跑當成獨立樣本的 95% 二項區間（Wald 近似），逐列所需試跑數加總後
  超過全文報告的 32,155 次；所以這組 ± 值不可能全是逐次獨立的二項區間。
出處：[arXiv:2601.11868]。原主張是組章時的重算，本程式把它寫成可重跑的檢查，並補上
  critic 提出的兩個問題：(a) 若 ± 其實是 1 個標準誤，結論會不會翻過來；(b) 以「每個組合
  至少跑 5 次」當下限時，是否有些列本身就和獨立二項區間相容。

輸入從哪來（全部由程式從 .cache/text/2601.11868.txt 解析並印出行號，不手抄）：
  - Table 2：每列「模型｜agent｜p% ± h%｜輸入 token｜輸出 token」。
  - Table 2 caption：「95% confidence intervals」與「running all 74 tasks」。
  - §3（第 4187 行附近）：「at least five times」與「32,155 trials」。
  - 題數的兩種說法：正文 89 題（第 4045 行附近）與 Table 2 caption 的 74 題。

方法：
  1. 解析 Table 2 的每一列，斷言列數、每列 p 與 h 都在 0–100 之間。
  2. 對每列算兩種解讀下「要讓區間半寬等於 h 所需的獨立試跑數」：
       Wald 95%：n = z^2 p(1-p) / h^2，z = 1.96（95% 雙尾常態分位數，不是論文數字）。
       1 個標準誤：n = p(1-p) / h^2。
     h 只印到小數點後一位，所以另算寬鬆版：用 h + 0.05 代入，得到最少可能需要的次數。
  3. 下限：每個組合至少 5 次，每次跑全部題目。以 74 題計是 5 × 74 = 370 次；以 89 題計是 445 次。
     每列實際試跑數至少是這個下限，所以「全表都是獨立二項區間」所需的總數是
     Σ max(n_i, 下限)，拿它和 32,155 比。
  4. 列出所需次數不超過下限的列：這些列即使只跑了 5 輪，也和獨立二項區間相容。

沒有用到隨機數。只用標準函式庫。執行：python3 07-tbench-ci-width.py
"""

import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TXT = os.path.join(ROOT, ".cache", "text", "2601.11868.txt")

Z95 = 1.96  # 95% 雙尾常態分位數（數學常數，不是論文數字）
RATE = re.compile(r"^\|\s*([0-9.]+)%\s*\$\\pm\$\s*([0-9.]+)%\s*$")


def load_lines():
    with open(TXT, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def parse_table2(lines):
    lo = find_line(lines, r"The results for every agent and model combination are shown in Table 2")
    hi = find_line(lines, r"^Table 2: Trial results for all agent-model combinations", lo)
    rows = []
    i = lo
    while i < hi:
        m = RATE.match(lines[i].strip())
        if m:
            model = lines[i - 2].strip().lstrip("|").strip()
            agent = lines[i - 1].strip().lstrip("|").strip()
            rows.append({"model": model, "agent": agent, "p": float(m.group(1)),
                         "h": float(m.group(2)), "line": i + 1})
        i += 1
    return lo + 1, hi + 1, rows


def main():
    lines = load_lines()
    lo, cap, rows = parse_table2(lines)
    print(f"Table 2：第 {lo}–{cap} 行，解析到 {len(rows)} 列")
    print(f"  caption（第 {cap} 行）：{lines[cap - 1].strip()[:200]}")
    assert "95% confidence intervals" in lines[cap - 1], "caption 沒有寫 95% confidence intervals"
    assert "all 74 tasks" in lines[cap - 1], "caption 沒有寫 all 74 tasks"

    i_at = find_line(lines, r"at least five times, resulting in a total of 32,155 trials")
    print(f"  第 {i_at + 1} 行：…{lines[i_at].strip()[lines[i_at].find('For each'):][:160]}…")
    i_89 = find_line(lines, r"composed of 89 tasks")
    print(f"  第 {i_89 + 1} 行：正文寫 Terminal-Bench 2.0「composed of 89 tasks」")
    TOTAL = 32155

    # 自檢：列數、數值範圍、模型與 agent 欄不是空的
    assert len(rows) == 55, f"預期 55 列，實際 {len(rows)}"
    for r in rows:
        assert 0 < r["p"] < 100 and 0 < r["h"] < 50, r
        assert r["model"] and r["agent"] and "%" not in r["model"], r
    print("  自檢：55 列，p 與 h 都在合理範圍，模型與 agent 欄都有值")

    for r in rows:
        p, h = r["p"] / 100, r["h"] / 100
        hl = (r["h"] + 0.05) / 100
        r["n_wald"] = Z95 * Z95 * p * (1 - p) / (h * h)
        r["n_wald_lo"] = Z95 * Z95 * p * (1 - p) / (hl * hl)
        r["n_se"] = p * (1 - p) / (h * h)
        r["n_se_lo"] = p * (1 - p) / (hl * hl)

    print()
    print("逐列所需的獨立試跑數（前 5 列與後 3 列；完整清單見最後）")
    print(f"{'模型':<22}{'agent':<16}{'p':>6}{'h':>5}{'Wald95':>9}{'Wald95寬鬆':>11}{'1SE':>7}")
    show = rows[:5] + rows[-3:]
    for r in show:
        print(f"{r['model'][:21]:<22}{r['agent'][:15]:<16}{r['p']:>6.1f}{r['h']:>5.1f}"
              f"{r['n_wald']:>9.0f}{r['n_wald_lo']:>11.0f}{r['n_se']:>7.0f}")

    s_wald = sum(r["n_wald"] for r in rows)
    s_wald_lo = sum(r["n_wald_lo"] for r in rows)
    s_se = sum(r["n_se"] for r in rows)
    s_se_lo = sum(r["n_se_lo"] for r in rows)
    print()
    print("加總（不套下限）")
    print(f"  Wald 95%：{s_wald:,.0f}（h 以寬鬆版 h+0.05 代入：{s_wald_lo:,.0f}）；報告總數 {TOTAL:,}")
    print(f"  1 個標準誤：{s_se:,.0f}（寬鬆版：{s_se_lo:,.0f}）")

    print()
    print("套上「每個組合至少 5 次、每次跑全部題目」的下限")
    verdicts = {}
    for ntask in (74, 89):
        floor = 5 * ntask
        need_wald = sum(max(r["n_wald"], floor) for r in rows)
        need_wald_lo = sum(max(r["n_wald_lo"], floor) for r in rows)
        need_se = sum(max(r["n_se"], floor) for r in rows)
        compat = [r for r in rows if r["n_wald"] <= floor]
        compat_lo = [r for r in rows if r["n_wald_lo"] <= floor]
        print(f"  以 {ntask} 題計，每列下限 5 × {ntask} = {floor}；55 列下限合計 {55 * floor:,}")
        print(f"    Wald 95% 所需總數 Σmax(n, {floor}) = {need_wald:,.0f}（寬鬆版 {need_wald_lo:,.0f}）"
              f" → {'超過' if need_wald_lo > TOTAL else '不超過'} {TOTAL:,}")
        print(f"    1 個標準誤所需總數 Σmax(n, {floor}) = {need_se:,.0f} → "
              f"{'超過' if need_se > TOTAL else '不超過'} {TOTAL:,}")
        print(f"    Wald 所需次數不超過下限的列（{len(compat)} 列；寬鬆版 {len(compat_lo)} 列）：")
        for r in compat_lo:
            flag = "" if r in compat else "（只在寬鬆版相容）"
            print(f"      {r['model']} + {r['agent']}：{r['p']}% ± {r['h']}%，"
                  f"需 {r['n_wald']:.0f} 次（寬鬆 {r['n_wald_lo']:.0f}），第 {r['line']} 行{flag}")
        # 在總預算 TOTAL 之內，最多能有幾列「同時」是獨立 Wald 區間：
        # 其餘列只給下限 floor 次，挑所需次數最少的列優先（貪婪法對這個問題是最佳的，
        # 因為每列多花的成本 max(n_i, floor) − floor 彼此獨立、只受總和限制）。
        extra = sorted(max(r["n_wald_lo"], floor) - floor for r in rows)
        budget = TOTAL - 55 * floor
        k, used = 0, 0.0
        for e in extra:
            if used + e <= budget:
                used += e
                k += 1
            else:
                break
        print(f"    預算 {TOTAL:,} − 下限合計 {55 * floor:,} = {budget:,} 次可分給「要更窄區間」的列；"
              f"以寬鬆版計，最多 {k} 列能同時是獨立 Wald 95% 區間，其餘 {55 - k} 列不可能是")
        verdicts[ntask] = (need_wald_lo > TOTAL, need_se > TOTAL, len(compat), len(compat_lo), k)

    print()
    print("完整清單（Wald 95% 所需次數，由大到小）")
    for r in sorted(rows, key=lambda r: -r["n_wald"]):
        print(f"  {r['n_wald']:>6.0f}  {r['model']} + {r['agent']}  {r['p']}% ± {r['h']}%（第 {r['line']} 行）")

    print()
    w74, s74, c74, cl74, k74 = verdicts[74]
    w89, s89, c89, cl89, k89 = verdicts[89]
    if w74 and w89 and not s74 and not s89:
        print(f"結論：證實，範圍收窄。若 ± 是逐次獨立的 Wald 95% 區間，連寬鬆版在內所需總數都超過 "
              f"{TOTAL:,}，所以不可能全表都是；在總預算內最多只有 {k74} 列（74 題計）或 {k89} 列（89 題計）"
              f"能同時是。另一個解讀同樣與報告相容：± 其實是 1 個標準誤卻標成 95% 區間，所需總數在 "
              f"{TOTAL:,} 以內。兩個解讀分不開，只靠表格無法判定是哪一個。")
    else:
        print(f"結論：需要改寫。Wald74 超過={w74}、1SE74 超過={s74}、Wald89 超過={w89}、1SE89 超過={s89}。")


if __name__ == "__main__":
    main()
