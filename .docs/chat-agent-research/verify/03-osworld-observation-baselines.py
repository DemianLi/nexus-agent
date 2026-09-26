#!/usr/bin/env python3
"""驗證：OS-ATLAS 的 OSWorld 表（Table 3）與 OSWorld 原論文的關係，以及「一律回 FAIL」地板。

主張（章節 03-agent-observation.md 的 OS-ATLAS 段、評估表、〈爭議〉反證之二、未解問題 1）：
  (1) GPT-4o 在 OSWorld 的四種觀測設定：accessibility tree 11.36、截圖＋a11y tree 11.21、
      只看截圖 5.03、加 SoM 4.59（精讀筆記 2410.23218 的 limitations_observed）。
  (2) OS-ATLAS 表中 GPT-4o 的基線（只看截圖 5.03、加 SoM 4.59）連分項都與 OSWorld 原論文同值，
      是直接引用（精讀時推測）。
  (3) OS-ATLAS 沒交代 OSWorld 版本與任務數，兩邊可能不是同一版任務集（精讀筆記的保留）。
  (4) T7 已驗證的地板 30/369＝8.13%（verify/07-osworld-fail-floor.py）能不能直接套到 OS-ATLAS 的表上。
出處：[arXiv:2410.23218] 筆記 limitations_observed；[arXiv:2404.07972] Table 5、Table 10、Table 14。

輸入（全部由程式從快取全文解析並印出行號，不手抄）：
  - .cache/text/2410.23218.txt 的 OSWorld 表（§4.3「grounding mode」之後，以「| Models」「Avg.」為錨點）。
  - .cache/text/2404.07972.txt 的 Table 5（各設定的 Overall）、Table 10（各應用題數與 infeasible 題數）、
    Table 14（各應用的分項成功率）。

方法：
  1. 解析 OSWorld Table 10，斷言 10 個應用的題數加總 369、infeasible 加總 30。
  2. 解析 OSWorld Table 5，取 GPT-4o 與 Gemini-Pro-1.5 在四種設定的 Overall；斷言四組列數 8／6／6／6。
  3. 解析 OSWorld Table 14，取每一列 10 個應用分項；GPT-4o 應出現 4 次。用 Table 10 的題數把每列
     加權平均，和 Table 5 同設定的 Overall 比對，藉此確認 Table 14 的第幾個 GPT-4o 列屬於哪個設定
     （不靠版面猜）。
  4. 解析 OS-ATLAS 的表（6 列 × 10 分項＋Avg），斷言表頭應用順序與 OSWorld Table 14 相同。
  5. 逐格比對：OS-ATLAS 的「GPT-4o」列與「GPT-4o + SoM」列 vs OSWorld Table 14 的對應列；Avg vs Table 5。
  6. 任務集相容性：對 OS-ATLAS 自己跑的三列（+SeeClick、+OS-Atlas-Base-4B、+7B），檢查每一格是否等於
     k/n（n 取 OSWorld Table 10 的應用題數，k 為整數，四捨五入到兩位），並檢查以題數加權的平均能否
     重算回 Avg。格點一致只能說「與 369 題相容」，不能證明是同一批題目。
  7. 地板：30/369 與各列 Avg 的差；各應用自己的地板（infeasible／題數）與各列分項的比較。

沒有用到隨機數。只用標準函式庫。執行：python3 verify/03-osworld-observation-baselines.py（從研究根目錄）
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
OSW = os.path.join(ROOT, ".cache", "text", "2404.07972.txt")
ATL = os.path.join(ROOT, ".cache", "text", "2410.23218.txt")

NUM = re.compile(r"^-?\d+(?:\.\d+)?%?$")
APPS = ["OS", "Calc", "Impress", "Writer", "VLC", "TB", "Chrome", "VSC", "GIMP", "Workflow"]


def load(p):
    with open(p, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit("找不到：" + pattern)


def tokens(lines, lo, hi):
    out = []
    for i in range(lo, hi):
        s = lines[i].strip()
        if s.startswith("|"):
            s = s[1:].strip()
        if s:
            out.append((i + 1, s))
    return out


def num(t):
    return float(t.rstrip("%"))


def rows_from_tokens(toks, width):
    """名稱後面緊跟 width 個數字的，視為一列；其餘非數字 token 視為標籤。"""
    rows, labels = [], []
    j = 0
    while j < len(toks):
        ln, t = toks[j]
        nxt = [toks[j + d][1] for d in range(1, width + 1) if j + d < len(toks)]
        if not NUM.match(t) and len(nxt) == width and all(NUM.match(x) for x in nxt):
            rows.append((t, [num(x) for x in nxt], ln, list(labels)))
            j += width + 1
            continue
        if not NUM.match(t):
            labels.append(t)
        j += 1
    return rows


def parse_table10(lines):
    lo = find_line(lines, r"^Table 10:")
    hi = find_line(lines, r"^Table 11:", lo)
    toks = tokens(lines, lo + 1, hi)
    ex = next(k for k, (_, t) in enumerate(toks) if t == "Examples")
    inf = next(k for k, (_, t) in enumerate(toks) if t == "#Infeasible")
    examples = [int(num(t)) for _, t in toks[ex + 1:ex + 12]]
    infeas = [int(num(t)) for _, t in toks[inf + 1:inf + 12]]
    header = [t for _, t in toks[:ex] if not NUM.match(t)]
    header = header[header.index("OS"):]  # 表題可能跨兩行，從第一個應用名開始
    return lo + 1, header, examples, infeas, toks[ex][0], toks[inf][0]


def parse_table5(lines):
    lo = find_line(lines, r"^Table 5:")
    hi = find_line(lines, r"^\|?\s*Human Performance", lo)
    toks = tokens(lines, lo + 1, hi)
    k = next(j for j, (_, t) in enumerate(toks) if t == "Overall")
    toks = toks[k + 1:]
    groups = []
    j = 0
    while j < len(toks):
        ln, t = toks[j]
        nxt = [toks[j + d][1] for d in range(1, 7) if j + d < len(toks)]
        if len(nxt) == 6 and all(NUM.match(x) for x in nxt) and not NUM.match(t):
            groups[-1][1].append((t, [num(x) for x in nxt], ln))
            j += 7
            continue
        if t.startswith("+"):
            label, rows = groups[-1]
            groups[-1] = (label + " " + t, rows)
        else:
            groups.append((t, []))
        j += 1
    return lo + 1, groups


def parse_table14(lines):
    lo = find_line(lines, r"^Table 14:")
    hi = find_line(lines, r"^\|?\s*Human Performance", lo)
    toks = tokens(lines, lo + 1, hi + 40)
    rows = rows_from_tokens(toks, 10)
    return lo + 1, rows


def parse_atlas(lines):
    lo = find_line(lines, r"^### 4\.3 Application: grounding mode")
    hi = find_line(lines, r"^\|?\s*Human\s*$", lo)
    toks = tokens(lines, lo + 1, hi + 40)
    k = next(j for j, (_, t) in enumerate(toks) if t == "Models")
    head = []
    j = k + 1
    while not toks[j][1].startswith("GPT-4o"):
        head.append(toks[j][1])
        j += 1
    rows = rows_from_tokens(toks[j:], 11)
    return lo + 1, head, rows


def main():
    osw = load(OSW)
    atl = load(ATL)

    # ---- 1. OSWorld Table 10 ----
    t10, header, examples, infeas, ex_ln, inf_ln = parse_table10(osw)
    apps10 = header[:10]
    assert header[10] == "Overall", header
    assert sum(examples[:10]) == examples[10] == 369, examples
    assert sum(infeas[:10]) == infeas[10] == 30, infeas
    n = dict(zip(APPS, examples[:10]))
    f = dict(zip(APPS, infeas[:10]))
    print("=== OSWorld Table 10（第 %d 行起）===" % t10)
    print("  表頭應用：" + "、".join(apps10))
    print("  題數（第 %d 行）：%s，合計 %d" % (ex_ln, examples[:10], examples[10]))
    print("  infeasible（第 %d 行）：%s，合計 %d" % (inf_ln, infeas[:10], infeas[10]))
    floor = 30 / 369 * 100
    print("  一律回 FAIL 的地板 = 30/369 = %.4f%%（%.2f%%）" % (floor, floor))

    # ---- 2. OSWorld Table 5 ----
    t5, groups = parse_table5(osw)
    sizes = [len(r) for _, r in groups]
    print("\n=== OSWorld Table 5（第 %d 行起）===" % t5)
    print("  設定與列數：" + "；".join("%s：%d" % (g, len(r)) for g, r in groups))
    assert sizes == [8, 6, 6, 6], sizes
    overall = {}
    for g, rows in groups:
        for m, v, ln in rows:
            overall[(g, m)] = (v[5], ln)
    settings = [g for g, _ in groups]
    for m in ("GPT-4o", "Gemini-Pro-1.5"):
        print("  %s：" % m + "；".join("%s %.2f%%（第 %d 行）" % (g, overall[(g, m)][0], overall[(g, m)][1])
                                    for g in settings))

    # ---- 3. OSWorld Table 14 ----
    t14, rows14 = parse_table14(osw)
    print("\n=== OSWorld Table 14（第 %d 行起）===" % t14)
    print("  解析到 %d 列（每列 10 個應用分項）" % len(rows14))
    gpt4o_14 = [(v, ln) for m, v, ln, _ in rows14 if m == "GPT-4o"]
    human14 = [(v, ln) for m, v, ln, _ in rows14 if m == "Human Performance"]
    assert len(gpt4o_14) == 4, len(gpt4o_14)
    assert len(human14) == 1

    def wavg(v):
        return sum(x * n[a] for a, x in zip(APPS, v)) / 369

    # 用加權平均把 Table 14 的 GPT-4o 列對到 Table 5 的設定
    t14_by_setting = {}
    for v, ln in gpt4o_14:
        w = wavg(v)
        best = min(settings, key=lambda g: abs(overall[(g, "GPT-4o")][0] - w))
        diff = abs(overall[(best, "GPT-4o")][0] - w)
        print("  GPT-4o 列（第 %d 行）加權平均 %.3f → 對到 Table 5「%s」%.2f（差 %.3f）"
              % (ln, w, best, overall[(best, "GPT-4o")][0], diff))
        assert diff < 0.02, (ln, w)
        assert best not in t14_by_setting
        t14_by_setting[best] = (v, ln)

    # ---- 4. OS-ATLAS 表 ----
    ta, head, rows_a = parse_atlas(atl)
    print("\n=== OS-ATLAS 的 OSWorld 表（§4.3，第 %d 行起）===" % ta)
    print("  表頭：" + " ".join(head))
    assert [h for h in head if h not in ("Successful Rate", "Avg.")] == \
        ["OS", "Calc", "Impress", "Writer", "VLC", "TB", "Chrome", "VSC", "GIMP", "WF"], head
    names = [m for m, _, _, _ in rows_a]
    print("  列：" + "、".join("%s（第 %d 行）" % (m, ln) for m, _, ln, _ in rows_a))
    assert names == ["GPT-4o + SoM", "GPT-4o", "+ SeeClick", "+ OS-Atlas-Base-4B", "+ OS-Atlas-Base-7B",
                     "Human"], names
    A = {m: v for m, v, _, _ in rows_a}

    # ---- 5. 逐格比對：GPT-4o 兩列是否照抄 OSWorld ----
    print("\n=== 逐格比對：OS-ATLAS 的 GPT-4o 基線 vs OSWorld ===")
    shot_key = [g for g in settings if g == "Screenshot"][0]
    som_key = [g for g in settings if g == "Set-of-Mark"][0]
    copy_ok = True
    for mname, key in (("GPT-4o", shot_key), ("GPT-4o + SoM", som_key)):
        v14, ln14 = t14_by_setting[key]
        same = [abs(a - b) < 1e-9 for a, b in zip(A[mname][:10], v14)]
        avg_same = abs(A[mname][10] - overall[(key, "GPT-4o")][0]) < 1e-9
        copy_ok = copy_ok and all(same) and avg_same
        print("  %-13s 10 個分項與 Table 14「%s」列（第 %d 行）相同：%d/10；Avg %.2f 與 Table 5 %.2f %s"
              % (mname, key, ln14, sum(same), A[mname][10], overall[(key, "GPT-4o")][0],
                 "相同" if avg_same else "不同"))
    hv, hln = human14[0]
    hsame = sum(abs(a - b) < 1e-9 for a, b in zip(A["Human"][:10], hv))
    print("  Human 列 10 個分項與 Table 14 Human Performance（第 %d 行）相同：%d/10" % (hln, hsame))
    # 非格點值：部分給分或筆誤才會出現，連這些都一樣就不是巧合
    offgrid = []
    for mname in ("GPT-4o", "GPT-4o + SoM"):
        for a, x in zip(APPS, A[mname][:10]):
            k = x * n[a] / 100
            if abs(round(round(k) / n[a] * 100, 2) - x) > 0.011:
                offgrid.append("%s %s %.2f（=%.3f/%d）" % (mname, a, x, k, n[a]))
    print("  其中不在 k/n 格點上（部分給分或筆誤才會出現）的格：" + "；".join(offgrid))

    print("\n  另外三個觀測設定（Table 5）：GPT-4o accessibility tree %.2f、截圖＋a11y tree %.2f"
          % (overall[("A11y tree", "GPT-4o")][0], overall[("Screenshot + A11y tree", "GPT-4o")][0]))
    four = (overall[("Screenshot", "GPT-4o")][0], overall[("Set-of-Mark", "GPT-4o")][0],
            overall[("A11y tree", "GPT-4o")][0], overall[("Screenshot + A11y tree", "GPT-4o")][0])
    four_ok = four == (5.03, 4.59, 11.36, 11.21)
    print("  章節的四個數字 5.03／4.59／11.36／11.21：" + ("全部相符" if four_ok else "不符 %s" % (four,)))

    # ---- 6. 任務集相容性：OS-ATLAS 自己跑的三列 ----
    print("\n=== OS-ATLAS 自己跑的三列：分項是否落在 OSWorld 369 題的 k/n 格點上 ===")
    compat = {}
    for mname in ("+ SeeClick", "+ OS-Atlas-Base-4B", "+ OS-Atlas-Base-7B"):
        ks, bad = [], []
        for a, x in zip(APPS, A[mname][:10]):
            k = x * n[a] / 100
            kr = round(k)
            ks.append(kr)
            if abs(round(kr / n[a] * 100, 2) - x) > 0.011:
                bad.append("%s %.2f（×%d/100 = %.3f；最近格點 %d/%d = %.2f）"
                           % (a, x, n[a], k, kr, n[a], kr / n[a] * 100))
        w = wavg(A[mname][:10])
        kavg = sum(ks) / 369 * 100
        compat[mname] = (bad, w, kavg)
        print("  %-19s 不在格點的格：%s" % (mname, "；".join(bad) if bad else "無"))
        print("  %-19s 以題數加權的平均 %.3f、取最近格點後 %d/369 = %.3f，表列 Avg %.2f"
              % ("", w, sum(ks), kavg, A[mname][10]))

    # ---- 7. 地板 ----
    print("\n=== 與地板 30/369 = %.2f%% 的距離（Avg − 地板）===" % floor)
    for mname in ("GPT-4o + SoM", "GPT-4o", "+ SeeClick", "+ OS-Atlas-Base-4B", "+ OS-Atlas-Base-7B"):
        print("  %-19s %.2f − %.2f = %+.2f" % (mname, A[mname][10], round(floor, 2), A[mname][10] - round(floor, 2)))
    for g in settings:
        print("  Table 5 GPT-4o %-22s %.2f − %.2f = %+.2f" % (g, overall[(g, "GPT-4o")][0], round(floor, 2),
                                                           overall[(g, "GPT-4o")][0] - round(floor, 2)))
    print("\n=== 補充：各應用自己的地板（infeasible／題數）===")
    for a in APPS:
        fl = f[a] / n[a] * 100
        above = [m for m in ("GPT-4o + SoM", "GPT-4o", "+ SeeClick", "+ OS-Atlas-Base-4B", "+ OS-Atlas-Base-7B")
                 if A[m][APPS.index(a)] > round(fl, 2) + 1e-9]
        eq = [m for m in ("GPT-4o + SoM", "GPT-4o", "+ SeeClick", "+ OS-Atlas-Base-4B", "+ OS-Atlas-Base-7B")
              if abs(A[m][APPS.index(a)] - round(fl, 2)) < 1e-9]
        print("  %-8s %2d/%3d = %6.2f%%；高過它的列：%s%s" % (a, f[a], n[a], fl, "、".join(above) if above else "無",
                                                        "；剛好等於它：" + "、".join(eq) if eq else ""))

    # ---- 結論 ----
    only4b = (compat["+ SeeClick"][0] == [] and compat["+ OS-Atlas-Base-7B"][0] == []
              and len(compat["+ OS-Atlas-Base-4B"][0]) == 1)
    avg_ok = all(abs(compat[m][1] - A[m][10]) < 0.02 for m in compat)
    print("\n=== 結論 ===")
    print("  (1) 四個數字：" + ("證實" if four_ok else "不符"))
    print("  (2) GPT-4o 兩列照抄 OSWorld：" + ("證實（分項連非格點值也逐格相同，Avg 等於 Table 5）"
                                              if copy_ok else "不成立"))
    print("  (3) 任務集：OS-ATLAS 自己跑的三列" + ("只有 4B 的 Calc 一格不在格點上，其餘都落在 369 題的格點上，"
                                               if only4b else "格點檢查結果見上，") +
          ("三列的題數加權平均都能重算回 Avg" if avg_ok else "加權平均有列重算不回 Avg") +
          "；與同一版 369 題相容，但不是證明")
    print("  (4) 地板 8.13 可以當參考線：OS-ATLAS 表的平均就是 369 題的等權平均；"
          "只看截圖的 GPT-4o（5.03）與加 SoM（4.59）都在地板以下")
    verdict = four_ok and copy_ok and avg_ok
    print("結論：" + ("主張 1、2 證實；主張 3 改為「與 369 題相容」；地板可套用" if verdict else "有子主張不成立，見上")
          + "  DONE 03-osworld-observation-baselines.py")


if __name__ == "__main__":
    main()
