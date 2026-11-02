#!/usr/bin/env python3
"""驗證：Chatbot Arena Table 5 把欄方向的比例當成真陽性率，正文的「90% TP、60–70% TN」以標準定義不成立。

主張（章節 07-agent-evaluation.md 第 584 行）：
  Table 5 把欄方向的比例當成真陽性率：α=0.1 時的 93%（13/14）其實是精確率，依標準定義的召回率只有
  13/25 = 52%、真陰性率 24/25 = 96%；正文「90% true positive、60–70% true negative」在任何一個 α 下
  都無法同時以標準定義成立。
出處：[arXiv:2403.04132] 精讀筆記 notes/2403.04132.json 的 limitations_observed[0]。

輸入從哪來（全部由程式從 .cache/text/2403.04132.txt 解析並印出行號，不手抄）：
  - §7.2：「manually identifying 25 anomalous users」與「randomly sample 25 normal users」。
  - §7.2 正文：「reaching 90% true positive and 60-70% true negative rate」。
  - Table 5：α=0.1 與 α=0.3 兩個 2×2 表，每格寫成「分子/分母」。

方法：
  1. 解析 Table 5 的 8 個分數。
  2. 證明分母是「欄和」：每欄兩格分母相同，且等於該欄兩個分子相加；每列分子相加等於 §7.2 的 25 人。
     這組檢查就是「表中比例是沿欄方向（以預測結果為分母）計算」的直接證據。
  3. 逐 α 重建 TP/FN/FP/TN，算 precision、recall（TPR）、TNR（specificity）、NPV，並列出表中
     欄方向比例，對照正文的 90%／60–70%。
  4. 檢查每個 α 能否同時滿足「recall 約 90%」與「TNR 落在 60–70%」。主判準用原文的 reaching：
     recall ≥ 90%；另外列出 recall 容差 ±5、±6 個百分點時的結果，讓讀者看到結論依賴哪個門檻。
  5. 表上只有兩個 α。未報告的 α 無法從論文數字推得，本程式只判定這兩個。

沒有用到隨機數。只用標準函式庫。執行：python3 07-arena-anomaly-confusion.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TXT = os.path.join(ROOT, ".cache", "text", "2403.04132.txt")

FRAC = re.compile(r"^(\d+)/(\d+)$")


def load_lines():
    with open(TXT, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def parse_table5(lines):
    lo = find_line(lines, r"^Table 5: Confusion matrix of different")
    hi = find_line(lines, r"^## 8 Discussion", lo)
    tables = {}
    cur_alpha, cur_row = None, None
    for i in range(lo + 1, hi):
        s = lines[i].strip().lstrip("|").strip()
        if not s:
            continue
        m = re.match(r"^\$\\alpha=([0-9.]+)\$$", s)
        if m:
            cur_alpha = float(m.group(1))
            tables[cur_alpha] = {"line": i + 1}
            continue
        if s in ("Actual Positive", "Actual Negative"):
            cur_row = s
            tables[cur_alpha][cur_row] = []
            continue
        f = FRAC.match(s)
        if f:
            tables[cur_alpha][cur_row].append((int(f.group(1)), int(f.group(2)), i + 1))
    return lo + 1, tables


def pct(a, b):
    return 100.0 * a / b


def main():
    lines = load_lines()

    print("=== 原文 ===")
    i_pos = find_line(lines, r"manually identifying 25 anomalous users")
    i_neg = find_line(lines, r"randomly sample 25 normal users")
    i_txt = find_line(lines, r"reaching 90% true positive and 60-70% true negative")
    n_pos = int(re.search(r"identifying (\d+) anomalous", lines[i_pos]).group(1))
    n_neg = int(re.search(r"sample (\d+) normal", lines[i_neg]).group(1))
    print(f"  第 {i_pos + 1} 行：異常使用者 {n_pos} 人")
    print(f"  第 {i_neg + 1} 行：正常使用者 {n_neg} 人")
    snippet = re.search(r"We find the detection method.*?rate\)\.", lines[i_txt]).group(0)
    print(f"  第 {i_txt + 1} 行：{snippet}")

    t5_line, tables = parse_table5(lines)
    print(f"\n=== Table 5（第 {t5_line} 行起）===")
    assert sorted(tables) == [0.1, 0.3], tables.keys()

    results = {}
    for a in sorted(tables):
        t = tables[a]
        (tp, dpp, l1), (fn, dpn, l2) = t["Actual Positive"]
        (fp, dpp2, l3), (tn, dpn2, l4) = t["Actual Negative"]
        print(f"\n  α={a}（第 {t['line']} 行）")
        print(f"                     Pred. Positive   Pred. Negative")
        print(f"    Actual Positive  {tp:>3}/{dpp:<3}（第 {l1} 行）  {fn:>3}/{dpn:<3}（第 {l2} 行）")
        print(f"    Actual Negative  {fp:>3}/{dpp2:<3}（第 {l3} 行）  {tn:>3}/{dpn2:<3}（第 {l4} 行）")

        # 分母結構檢查
        col_pos_ok = dpp == dpp2 == tp + fp
        col_neg_ok = dpn == dpn2 == fn + tn
        row_pos_ok = tp + fn == n_pos
        row_neg_ok = fp + tn == n_neg
        print(f"    分母＝欄和？Pred.Pos 欄：{dpp}={dpp2}={tp}+{fp} → {col_pos_ok}；"
              f"Pred.Neg 欄：{dpn}={dpn2}={fn}+{tn} → {col_neg_ok}")
        print(f"    列分子和＝§7.2 人數？Actual Pos：{tp}+{fn}={tp + fn}（應為 {n_pos}）→ {row_pos_ok}；"
              f"Actual Neg：{fp}+{tn}={fp + tn}（應為 {n_neg}）→ {row_neg_ok}")
        assert col_pos_ok and col_neg_ok and row_pos_ok and row_neg_ok

        prec, npv = pct(tp, tp + fp), pct(tn, tn + fn)
        rec, tnr = pct(tp, tp + fn), pct(tn, tn + fp)
        print(f"    表中欄方向比例：「TP」格 {tp}/{dpp} = {pct(tp, dpp):.1f}%，「TN」格 {tn}/{dpn} = {pct(tn, dpn):.1f}%")
        print(f"    標準定義：precision = TP/(TP+FP) = {tp}/{tp + fp} = {prec:.1f}%")
        print(f"              recall(TPR) = TP/(TP+FN) = {tp}/{tp + fn} = {rec:.1f}%")
        print(f"              TNR = TN/(TN+FP) = {tn}/{tn + fp} = {tnr:.1f}%")
        print(f"              NPV = TN/(TN+FN) = {tn}/{tn + fn} = {npv:.1f}%")
        results[a] = dict(prec=prec, npv=npv, rec=rec, tnr=tnr,
                          col_tp=pct(tp, dpp), col_tn=pct(tn, dpn))

    print("\n=== 正文數字從哪來 ===")
    for a, r in results.items():
        match = r["col_tp"] >= 90 and 60 <= r["col_tn"] <= 70
        print(f"  α={a}：欄方向比例 {r['col_tp']:.1f}% / {r['col_tn']:.1f}% → "
              f"{'對上' if match else '對不上'}正文「90% TP、60–70% TN」")

    print("\n=== 以標準定義能否同時成立（TNR 須落在 [60, 70]）===")
    criteria = [("recall ≥ 90（原文 reaching）", lambda r: r >= 90.0),
                ("recall 在 90±5", lambda r: abs(r - 90.0) <= 5.0),
                ("recall 在 90±6", lambda r: abs(r - 90.0) <= 6.0)]
    verdict_main = None
    hits_by = {}
    for name, ok_rec in criteria:
        hits = [a for a, r in results.items() if ok_rec(r["rec"]) and 60.0 <= r["tnr"] <= 70.0]
        hits_by[name] = hits
        print(f"  {name}：成立的 α = {hits if hits else '無'}")
        if verdict_main is None:
            verdict_main = not hits

    print("\n=== 結論 ===")
    r1 = results[0.1]
    print(f"  α=0.1：13/14 = {r1['prec']:.1f}% 是 precision；recall {r1['rec']:.0f}%、TNR {r1['tnr']:.0f}%"
          f"（主張 52%、96%）：{'相符' if round(r1['rec']) == 52 and round(r1['tnr']) == 96 else '不符'}")
    r3 = results[0.3]
    print(f"  α=0.3：recall {r3['rec']:.0f}%、TNR {r3['tnr']:.0f}%、precision {r3['prec']:.1f}%")
    print("  在報告的兩個 α 下，以原文的「reaching 90%」為準：" +
          ("沒有一個 α 能同時成立 → 主張成立" if verdict_main else "有 α 同時成立 → 主張不成立"))
    loose = hits_by["recall 在 90±6"]
    if loose:
        a = loose[0]
        print(f"  但放寬到 recall 90±6 時 α={a} 就同時成立（recall {results[a]['rec']:.0f}% / TNR "
              f"{results[a]['tnr']:.0f}%），所以結論依賴「約 90%」怎麼讀。")
    print("  表上只有 α=0.1 與 0.3，未報告的 α 無法從論文數字判定；「任何 α」只能收窄為「報告的兩個 α」。")


if __name__ == "__main__":
    main()
