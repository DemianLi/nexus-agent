#!/usr/bin/env python3
"""驗證：CoVe Table 1 的 Wiki-Category 有兩列 Prec. 不等於 Pos./(Pos.+Neg.)。

主張（章節 05-self-correction-reflection.md 第 419 行）：
  micro-averaged precision 應等於 Pos./(Pos.+Neg.)。Wiki-Category 的 two-step 算出
  0.50/(0.50+0.52)=0.490，表中寫 0.21；factored 算出 0.52/(0.52+1.52)=0.255，表中寫 0.22。
  其餘 10 列在四捨五入內吻合。因此這兩列的 Pos./Neg. 不能拿來佐證「正確實體沒有減少」。
出處：[arXiv:2309.11495] 精讀筆記 notes/2309.11495.json 的 limitations_observed 第 1 條。

輸入從哪來：
  - Table 1 全部 12 列（Wikidata 6 列、Wiki-Category 6 列）的 Prec./Pos./Neg. 由本程式從
    .cache/text/2309.11495.txt 解析，以表題「Table 1: Test Precision and average number of positive」為錨點
    往上找表頭，輸出附行號。快取來源是 arxiv-html，快取中沒有記錄 arXiv 版本號（筆記自稱讀的是 v2）。
  - 「micro-averaged」的定義取自同一份全文第 247 行（Wikidata）與第 256 行（Wiki-Category），程式會印出原句。

為什麼這是恆等式：Pos. 與 Neg. 是同一組 N 題的平均正確／錯誤實體數。micro-averaged precision
  = ΣPos_i / (ΣPos_i + ΣNeg_i) = (N·Pos̄) / (N·Pos̄ + N·Neḡ) = Pos̄ / (Pos̄ + Neḡ)。所以三欄必須互相吻合，
  不需要任何資料集。

方法（捨入區間，不用固定容差）：
  Pos.、Neg. 各取 ±半個末位（例如 11.1 取 ±0.05、0.52 取 ±0.005），算出 Pos/(Pos+Neg) 的可能區間；
  Prec. 取 ±0.005。兩區間有交集就算吻合。另外印出「只改一格就能吻合」所需的值，只當參考，
  不據此判定哪一格錯。

無隨機數，不需種子。只用標準函式庫。執行：python3 05-cove-precision-identity.py
"""

import re
import sys
from decimal import Decimal
from pathlib import Path

TEXT = Path(__file__).resolve().parent.parent / ".cache" / "text" / "2309.11495.txt"
CAPTION = "Table 1: Test Precision and average number of positive"
EXPECTED_METHODS = ["Zero-shot", "CoT", "Few-shot", "CoVe (joint)", "CoVe (two-step)", "CoVe (factored)"]


def half_unit(s):
    """字串 s 的半個末位，例如 '0.52'→0.005、'11.1'→0.05。"""
    d = -Decimal(s).as_tuple().exponent
    return 0.5 * 10 ** (-d)


def parse(lines):
    cap = [i for i, l in enumerate(lines) if l.startswith(CAPTION)]
    assert len(cap) == 1, f"表題應恰好一次，實際 {len(cap)}"
    cap = cap[0]
    head = None
    for i in range(cap - 1, -1, -1):
        if lines[i].strip() == "| LLM" and lines[i + 1].strip() == "| Method":
            head = i
            break
    assert head is not None, "找不到表頭 | LLM / | Method"
    # 驗表頭：兩組 Prec./Pos./Neg.
    hdr = [lines[j].strip() for j in range(head, head + 10)]
    assert hdr[2].startswith("| Prec.") and hdr[3] == "| Pos." and hdr[4] == "| Neg.", hdr
    assert hdr[6].startswith("| Prec.") and hdr[7] == "| Pos." and hdr[8] == "| Neg.", hdr
    # 往上確認兩個資料集名稱的順序：Wikidata 在前、Wiki-Category 在後
    title_zone = "\n".join(lines[max(0, head - 30):head])
    assert title_zone.find("Wikidata") < title_zone.find("Wiki-Category"), "資料集欄位順序不是 Wikidata→Wiki-Category"

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
    rows = []
    for g in groups[1:]:
        cells = [(ln, s.lstrip("|").strip()) for ln, s in g]
        llm, method = cells[0][1], cells[1][1]
        rest = cells[2:]
        # 預期：3 個數字、1 個空欄、3 個數字
        assert len(rest) == 7 and rest[3][1] == "", f"{llm}/{method} 格式不符：{rest}"
        for k in (0, 1, 2, 4, 5, 6):
            assert re.fullmatch(r"\d+(\.\d+)?", rest[k][1]), f"第 {rest[k][0]} 行不是數字：{rest[k][1]!r}"
        rows.append(dict(llm=llm, method=method, wd=rest[0:3], wc=rest[4:7]))
    assert [r["method"] for r in rows] == EXPECTED_METHODS, [r["method"] for r in rows]
    return cap + 1, head + 1, rows


def check(prec_s, pos_s, neg_s):
    prec, pos, neg = float(prec_s), float(pos_s), float(neg_s)
    hp, hq, hn = half_unit(prec_s), half_unit(pos_s), half_unit(neg_s)
    point = pos / (pos + neg)
    rmin = (pos - hq) / ((pos - hq) + (neg + hn))
    rmax = (pos + hq) / ((pos + hq) + (neg - hn))
    ok = not (rmax < prec - hp or rmin > prec + hp)
    return point, rmin, rmax, ok


def main():
    lines = TEXT.read_text(encoding="utf-8").splitlines()
    print(f"來源：{TEXT}")
    for ln in (247, 256):
        print(f"  第 {ln} 行：{lines[ln - 1].strip()[:140]}")
    cap_ln, head_ln, rows = parse(lines)
    print(f"  Table 1 表頭在第 {head_ln} 行、表題在第 {cap_ln} 行，共解析 {len(rows) * 2} 列（每個方法 × 兩個資料集）\n")

    print(f"{'資料集':<14}{'方法':<18}{'Prec.':>6}{'Pos.':>6}{'Neg.':>6}  {'Pos/(Pos+Neg)':>13}  {'捨入區間':<17}{'吻合?':<5}{'行號'}")
    bad = []
    for ds, key in (("Wikidata", "wd"), ("Wiki-Category", "wc")):
        for r in rows:
            (lp, p), (lq, q), (ln_, n) = r[key]
            point, rmin, rmax, ok = check(p, q, n)
            print(f"{ds:<14}{r['method']:<18}{p:>6}{q:>6}{n:>6}  {point:>13.3f}  [{rmin:.3f}, {rmax:.3f}]   "
                  f"{'是' if ok else '否':<5}{lp}/{lq}/{ln_}")
            if not ok:
                bad.append((ds, r["method"], p, q, n, point))

    print("\n只改一格就能吻合所需的值（參考用，不代表那一格就是錯的）：")
    for ds, m, p, q, n, point in bad:
        P, Q, N = float(p), float(q), float(n)
        print(f"  {ds} {m}：若 Prec.、Pos. 正確 → Neg. 應為 {Q * (1 - P) / P:.2f}（表上 {n}）；"
              f"若 Prec.、Neg. 正確 → Pos. 應為 {P * N / (1 - P):.2f}（表上 {q}）；"
              f"若 Pos.、Neg. 正確 → Prec. 應為 {point:.2f}（表上 {p}）")

    print("\n=== 結論 ===")
    expect = {("Wiki-Category", "CoVe (two-step)"), ("Wiki-Category", "CoVe (factored)")}
    got = {(d, m) for d, m, *_ in bad}
    print(f"不吻合的列：{sorted(got)}；吻合的列數：{12 - len(bad)}/12")
    two = [b for b in bad if b[1] == "CoVe (two-step)"]
    fac = [b for b in bad if b[1] == "CoVe (factored)"]
    ok_nums = (two and f"{two[0][5]:.3f}" == "0.490" and fac and f"{fac[0][5]:.3f}" == "0.255")
    print(f"子主張 2a（只有 Wiki-Category two-step 算出 0.490／表上 0.21、factored 算出 0.255／表上 0.22 不吻合，其餘 10 列吻合）："
          f"{'證實' if (got == expect and ok_nums) else '推翻'}")
    print("子主張 2b（哪一格錯）：無法判定。三欄至少一欄有誤，但表格本身分不出是哪一欄。")
    print("子主張 2c（這兩列的 Pos./Neg. 不能拿來佐證「正確實體沒有減少」）：是由 2a 推出的判讀；"
          "只要 2a 成立，這兩列的 Pos./Neg. 就不是可單獨採信的證據。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
