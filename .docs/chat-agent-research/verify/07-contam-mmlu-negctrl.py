#!/usr/bin/env python3
"""驗證：黑盒污染檢定（2310.17623）的 MMLU 過濾規則與負對照的旗標比例。

主張（章節 07-agent-evaluation.md〈陷阱十〉與〈爭議十八〉黑盒污染檢定那幾條）：
  精讀時以 p<0.05 重算 Appendix D 的 Table 4：56 個 MMLU 子集裡，兩個負對照（GPT-2 XL、BioMedLM）
  至少一個 p<0.05 的有 13 個（23%），p<0.01 的有 9 個；56 − 13 = 43 與正文「保留 43 個」吻合，
  正文「排除 14 個」要把表中缺席的 Professional Law 也算進去才對得上。
出處：[arXiv:2310.17623] 精讀筆記的 limitations_observed。

這支程式另外檢查兩件論文沒寫明的事：
  1. 過濾規則：正文只說排除「我們的檢定把 BioMedLM 或 GPT-2 判為污染」的檔案，沒寫門檻。若門檻是
     「任一負對照 p<0.05」，剩下的 43 個子集以 Fisher 法合併後，應該重現 Table 2 MMLU† 列的
     LLaMA2-7B 0.014、Mistral-7B 0.011、Pythia-1.4B 0.362。重現只代表與這個門檻一致，不代表唯一。
  2. 13/56 有多不尋常：在 H0 下每個檔案的兩個負對照「至少一個 p<0.05」的機率，依聯集上界最多是
     0.05 + 0.05 = 10%，不論兩者相關與否（兩者獨立時是 1 − 0.95 × 0.95 = 9.75%）。假設各檔之間
     獨立，算 56 個檔案裡出現 13 個以上的二項尾機率上界。

輸入從哪來（全部由程式從 .cache/text/2310.17623.txt 解析並印出行號，不手抄）：
  - Appendix D 的 Table 4：56 列 × 5 個模型的 p 值。
  - §4.3 的 Table 2：MMLU† 列的三個合併 p 值。
  - §4.3 正文：「exclude those 14 test files」「43 remaining」。
  - Table 1：MMLU Pro. Law 的大小（用來說明它是注入實驗用的子集）。

方法與保留條件：
  - Table 4 的 p 值只印到小數第三位，所以每個輸入的真值落在 ±0.0005 內（下限截在 0.0005）。
    Fisher 合併 p 值的上下界取「所有輸入同時推到一端」，是保守的最寬範圍。
  - Fisher 統計量 X = −2 Σ ln p，在 H0 下服從自由度 2k 的卡方分佈；自由度是偶數時，
    尾機率有閉式 e^(−x/2) Σ_{i<k} (x/2)^i / i!，只用標準函式庫。
  - 二項尾機率假設各 MMLU 檔案之間的檢定彼此獨立；同一檔案內兩個負對照的相關不影響聯集上界。
  - 結論字串全部由算出的變數組成；精讀主張的 13、9 與正文的 43、14 逐一和算出值比對，
    任一不符時結論的開頭改印「不符」，不會照印「證實」。

沒有用到隨機數。只用標準函式庫。執行：python3 07-contam-mmlu-negctrl.py
"""

import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TXT = os.path.join(ROOT, ".cache", "text", "2310.17623.txt")


def load_lines():
    with open(TXT, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def cells_between(lines, start, end):
    """回傳 (行號, 內容) 的串列：start 與 end 之間每一個以 '| ' 開頭的儲存格。"""
    out = []
    for i in range(start, end):
        s = lines[i]
        if s.startswith("| "):
            out.append((i + 1, s[2:].strip()))
    return out


def chi2_sf_even(x, df):
    assert df % 2 == 0
    k, t = df // 2, x / 2.0
    term, total = 1.0, 0.0
    for i in range(k):
        if i > 0:
            term *= t / i
        total += term
    return math.exp(-t) * total


def fisher(ps):
    x = -2.0 * sum(math.log(p) for p in ps)
    return x, chi2_sf_even(x, 2 * len(ps))


def binom_tail(n, p, k):
    return sum(math.comb(n, j) * p ** j * (1 - p) ** (n - j) for j in range(k, n + 1))


def main():
    lines = load_lines()

    # --- Table 4 ---
    t4 = find_line(lines, r"^Table 4: Full MMLU results")
    f4 = find_line(lines, r"^Figure 4: Empirical CDFs", t4)
    print(f"Table 4 caption 在第 {t4 + 1} 行，表身到第 {f4} 行為止")
    cells = cells_between(lines, t4, f4)
    header = [c for _, c in cells[:7]]
    assert header == ["Dataset", "Size", "LLaMA2-7B", "Mistral-7B", "Pythia-1.4B", "GPT-2 XL", "BioMedLM"], header
    body = cells[7:]
    assert len(body) % 7 == 0, f"表身儲存格數 {len(body)} 不是 7 的倍數，解析錯位"
    rows = []
    for j in range(0, len(body), 7):
        line_no = body[j][0]
        name = body[j][1]
        size = int(body[j + 1][1])
        ps = [float(body[j + k][1]) for k in range(2, 7)]
        assert all(0 < p <= 1 for p in ps), (name, ps)
        rows.append((line_no, name, size, ps))
    print(f"自檢：Table 4 共 {len(rows)} 列，每列 7 欄，p 值都落在 (0, 1]")
    assert len(rows) == 56, len(rows)
    law = [r for r in rows if r[1] == "Professional-Law"]
    assert not law, "Table 4 竟然有 Professional-Law"
    print("自檢：Table 4 沒有 Professional-Law 這一列（International-Law 是另一個子集）")

    t1 = find_line(lines, r"^\| MMLU Pro\. Law$")
    print(f"Table 1 第 {t1 + 1} 行：MMLU Pro. Law，大小 {lines[t1 + 1][2:].strip()}（注入實驗用的子集）")

    # --- 正文的 14 與 43 ---
    ex = find_line(lines, r"exclude those 14 test files")
    rem = find_line(lines, r"each of the 43 remaining test files")
    print(f"正文第 {ex + 1} 行：exclude those 14 test files；第 {rem + 1} 行：43 remaining test files")

    # --- Table 2 的 MMLU† 列 ---
    t2 = find_line(lines, r"^Table 2: P-values for contamination tests")
    m = find_line(lines, r"^\| MMLU†$", t2)
    vals = [lines[m + k][2:].strip() for k in range(1, 7)]
    assert vals[0] == "–" and vals[4] == "–" and vals[5] == "–", vals
    reported = {"LLaMA2-7B": float(vals[1]), "Mistral-7B": float(vals[2]), "Pythia-1.4B": float(vals[3])}
    print(f"Table 2 第 {m + 1} 行 MMLU†：{reported}")

    # --- 負對照的旗標 ---
    def flagged(r, thr, strict=True):
        g, b = r[3][3], r[3][4]
        return (g < thr or b < thr) if strict else (g <= thr or b <= thr)

    f05 = [r for r in rows if flagged(r, 0.05)]
    f05le = [r for r in rows if flagged(r, 0.05, strict=False)]
    f01 = [r for r in rows if flagged(r, 0.01)]
    print()
    print(f"任一負對照 p<0.05：{len(f05)} / {len(rows)} = {len(f05) / len(rows):.1%}")
    for r in f05:
        print(f"  第 {r[0]} 行 {r[1]}：GPT-2 XL {r[3][3]}、BioMedLM {r[3][4]}")
    print(f"任一負對照 p≤0.05：{len(f05le)}（與 <0.05 {'相同' if len(f05le) == len(f05) else '不同'}）")
    print(f"任一負對照 p<0.01：{len(f01)} / {len(rows)}")
    kept = [r for r in rows if not flagged(r, 0.05)]
    print(f"保留：{len(rows)} − {len(f05)} = {len(kept)}；正文寫 43。排除數 {len(f05)} 加上表中缺席的 Professional-Law 是 {len(f05) + 1}，正文寫 14")
    assert all(min(r[3][:3]) > 1e-30 for r in kept), "保留的子集裡有 1e-38"
    print("自檢：保留的 43 列裡，受測三個模型都沒有 1e-38 這種下限值")

    # --- Fisher 合併 ---
    print()
    print("以保留的 43 個子集做 Fisher 合併（自由度 86）：")
    verdicts = []
    for j, name in enumerate(["LLaMA2-7B", "Mistral-7B", "Pythia-1.4B"]):
        ps = [r[3][j] for r in kept]
        x, p = fisher(ps)
        lo_in = [max(q - 0.0005, 0.0005) for q in ps]
        hi_in = [min(q + 0.0005, 1.0) for q in ps]
        _, p_lo = fisher(lo_in)
        _, p_hi = fisher(hi_in)
        rep = reported[name]
        rep_lo, rep_hi = rep - 0.0005, rep + 0.0005
        overlap = p_lo <= rep_hi and rep_lo <= p_hi
        verdicts.append(overlap)
        print(f"  {name}：X = {x:.2f}，合併 p = {p:.4f}；輸入取位範圍內 {p_lo:.4f}–{p_hi:.4f}；"
              f"報告 {rep}（{rep_lo:.4f}–{rep_hi:.4f}）→ {'範圍重疊' if overlap else '對不上'}")

    # --- 13/56 有多不尋常 ---
    print()
    p_ind = 1 - 0.95 * 0.95
    p_union = 0.05 + 0.05
    k = len(f05)
    tail_union = binom_tail(len(rows), p_union, k)
    tail_ind = binom_tail(len(rows), p_ind, k)
    print(f"H0 下每檔「任一負對照 p<0.05」的機率：獨立時 1 − 0.95 × 0.95 = {p_ind:.4f}，聯集上界 {p_union:.2f}")
    print(f"56 檔中 ≥{k} 檔被旗標的機率：以 {p_union:.2f} 計 {tail_union:.4f}，以 {p_ind:.4f} 計 {tail_ind:.4f}（假設各檔之間獨立）")

    # --- 精讀主張的計數逐一比對：結論只由算出的變數組成，對不上就印「不符」 ---
    print()
    claimed = {"任一負對照 p<0.05": (13, len(f05)), "任一負對照 p<0.01": (9, len(f01)),
               "保留子集數（正文）": (43, len(kept)), "排除數＋缺席的 Professional-Law（正文）": (14, len(f05) + 1)}
    for what, (want, got) in claimed.items():
        print(f"比對：{what} 主張 {want}，算出 {got} → {'相符' if want == got else '不符'}")
    counts_ok = all(want == got for want, got in claimed.values())
    ok_filter = all(verdicts)
    n, k05, k01, nk = len(rows), len(f05), len(f01), len(kept)

    print()
    head = ("證實並補一項" if counts_ok and ok_filter else
            "計數證實，但過濾規則對不上" if counts_ok else
            "不符：精讀主張的計數與 Table 4 重算的結果對不上，見上方「比對」各行")
    print(f"結論：{head}。Table 4 有 {n} 列，任一負對照 p<0.05 的有 {k05} 個（{k05 / n:.1%}），"
          f"p<0.01 的有 {k01} 個，{n} − {k05} = {nk}，正文寫保留 43 個；"
          f"排除數 {k05} 加上表中缺席的 Professional-Law 是 {k05 + 1}，正文寫排除 14 個。"
          + (f"以「任一負對照 p<0.05」為過濾規則，剩下 {nk} 個子集的 Fisher 合併 p 值與 Table 2 的 "
             + "／".join(f"{v:g}" for v in reported.values())
             + " 在取位範圍內重疊，與正文沒寫的門檻是 0.05 一致（這不排除別的規則也得到同一組子集）。"
             if ok_filter else
             "但以這個規則合併的 p 值對不上 Table 2，過濾規則另有其他。")
          + f"即使用每檔 10% 的聯集上界，{n} 檔裡出現 {k05} 檔以上的機率也只有約 {tail_union:.3f}"
          "（假設各檔獨立），所以這些負對照的顯著不像偶然；成因可能是子集不可交換、負對照讀過來源考題，"
          "或檢定的漸近近似在小檔案上失準，這支程式分不開。")


if __name__ == "__main__":
    main()
