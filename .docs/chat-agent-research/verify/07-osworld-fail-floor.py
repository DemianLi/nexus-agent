#!/usr/bin/env python3
"""驗證：OSWorld「一律回 FAIL」的 agent 可拿 30/369 = 8.13%，Table 5 的 26 組中只有 5 組高過它。

主張（章節 07-agent-evaluation.md 第 71、338 行）：
  agent 第一步就回 FAIL 就能拿到 30/369 = 8.13%；Table 5 的 26 組模型×設定中只有 5 組高過這個值，
  純截圖設定最高 5.80%，全部低於它。
出處：[arXiv:2404.07972] 精讀筆記 notes/2404.07972.json 的 limitations_observed[0]。

輸入從哪來（全部由程式從 .cache/text/2404.07972.txt 解析並印出行號，不手抄）：
  - Table 10（「Table 10:」到「Table 11:」之間）：各應用的 Examples 與 #Infeasible。
  - Table 5（「Table 5:」到「Human Performance」列）：26 個模型×設定的五類分數與 Overall。
  - Table 5 caption：五大類與應用的對應（Office = Calc/Impress/Writer 等）。
  - §2.1 的 reward 定義（「accurately predicts failure for an infeasible task」與「In all other
    scenarios, it returns 0」）。
  - 第 518 行「totaling 30 tasks or 8.1%」與 Table 6 的 Infeasible「% of Total」。

方法：
  1. 解析 Table 10，斷言各應用 Examples 加總 = Overall = 369、#Infeasible 加總 = Overall = 30。
  2. 解析 Table 5，斷言四組輸入設定分別 8／6／6／6 列、共 26 列、每列 6 個百分比，任一不符就中止。
  3. 前提檢查：依 caption 的分組，用 Table 10 的題數算出五類權重（OS 24、Office 117、Daily 78、
     Profess. 49、Workflow 101），對 26 列重算加權 Overall，看 Overall 是不是 369 題的等權平均
     （捨入誤差上限 0.01）。若是，拿 Overall 與 30/369 比才是同一個量。對不上的列逐一列出。
  4. 數 Overall > 30/369 的列數（報告值與重算值各數一次），取 Screenshot 組（純截圖）的最大值。
  5. 補充：一律 FAIL 的 agent 在五大類各自的分數，與各類最佳模型相比。

沒有用到隨機數。只用標準函式庫。執行：python3 07-osworld-fail-floor.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TXT = os.path.join(ROOT, ".cache", "text", "2404.07972.txt")

PCT = re.compile(r"^(\d+(?:\.\d+)?)%$")


def load_lines():
    with open(TXT, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def cells(lines, lo, hi):
    """把 [lo, hi) 內的 markdown 表格行轉成 (行號, 內容) 的 token 串，丟掉空白與單獨的 '|'。"""
    out = []
    for i in range(lo, hi):
        s = lines[i].strip()
        if s.startswith("|"):
            s = s[1:].strip()
        if s:
            out.append((i + 1, s))
    return out


def parse_table10(lines):
    lo = find_line(lines, r"^Table 10:")
    hi = find_line(lines, r"^Table 11:", lo)
    # 以空白行切成列：每列是一串 cell
    rows, cur = [], []
    for i in range(lo + 2, hi):
        s = lines[i].strip()
        if not s:
            if cur:
                rows.append(cur)
                cur = []
            continue
        cur.append((i + 1, s[1:].strip() if s.startswith("|") else s))
    if cur:
        rows.append(cur)
    header = [c for _, c in rows[0] if c]
    table = {}
    for r in rows[1:]:
        label = r[0][1]
        vals = [float(c) for _, c in r[1:]]
        table[label] = (r[0][0], vals)
    return lo + 1, header, table


def parse_table5(lines):
    lo = find_line(lines, r"^Table 5:")
    hi = find_line(lines, r"^\|?\s*Human Performance", lo)
    toks = cells(lines, lo + 1, hi + 40)
    # 從表頭 "Overall" 之後開始
    k = next(j for j, (_, t) in enumerate(toks) if t == "Overall")
    toks = toks[k + 1:]
    groups = []  # [(label, [(model, [6 values], lineno)])]
    j = 0
    human = None
    while j < len(toks):
        ln, t = toks[j]
        nxt = [toks[j + d][1] for d in range(1, 7) if j + d < len(toks)]
        is_row = len(nxt) == 6 and all(PCT.match(x) for x in nxt)
        if t == "Human Performance":
            human = [float(PCT.match(x).group(1)) for x in nxt]
            break
        if is_row:
            vals = [float(PCT.match(x).group(1)) for x in nxt]
            if not groups:
                raise SystemExit(f"第 {ln} 行的模型列前面沒有設定標籤")
            groups[-1][1].append((t, vals, ln))
            j += 7
            continue
        if PCT.match(t):
            raise SystemExit(f"第 {ln} 行出現落單的百分比 {t}，解析錯位")
        if t.startswith("+"):
            # 「Screenshot」「+ A11y tree」被切成兩格，第二格落在該組第一列之後
            label, rows = groups[-1]
            groups[-1] = (label + " " + t, rows)
        else:
            groups.append((t, []))
        j += 1
    return lo + 1, hi + 1, groups, human


def main():
    lines = load_lines()

    # --- reward 定義與論文自己的比例 ---
    print("=== 原文：reward 定義與 infeasible 比例 ===")
    for pat in (r"accurately predicts failure for an infeasible task",
                r"In all other scenarios, it returns 0",
                r"totaling 30 tasks or 8\.1%"):
        i = find_line(lines, pat)
        print(f"  第 {i + 1} 行：{lines[i].strip()[:150]}")
    i6 = find_line(lines, r"^Table 6:")
    t6 = cells(lines, i6 + 1, i6 + 60)
    k = next(j for j, (_, t) in enumerate(t6) if t == "Infeasible")
    print(f"  Table 6（第 {t6[k][0]} 行起）：Infeasible 的 % of Total = {t6[k + 1][1]}，GPT-4V (SoM) 的 SR = {t6[k + 2][1]}")

    # --- Table 10 ---
    t10_line, header, t10 = parse_table10(lines)
    apps = header[:-1]
    assert header[-1] == "Overall", header
    ex_line, examples = t10["Examples"]
    inf_line, infeas = t10["#Infeasible"]
    assert len(examples) == len(apps) + 1 and len(infeas) == len(apps) + 1
    n_total = sum(examples[:-1])
    n_inf = sum(infeas[:-1])
    print(f"\n=== Table 10（第 {t10_line} 行起）===")
    print("  應用：    " + " ".join(f"{a:>11}" for a in apps))
    print("  Examples：" + " ".join(f"{int(v):>11}" for v in examples[:-1]) + f"   （第 {ex_line} 行）")
    print("  #Infeas.：" + " ".join(f"{int(v):>11}" for v in infeas[:-1]) + f"   （第 {inf_line} 行）")
    print(f"  Examples 加總 = {int(n_total)}，Overall 欄 = {int(examples[-1])}")
    print(f"  #Infeasible 加總 = {int(n_inf)}，Overall 欄 = {int(infeas[-1])}")
    assert n_total == examples[-1] == 369
    assert n_inf == infeas[-1] == 30
    floor = n_inf / n_total
    print(f"  一律 FAIL 的地板 = {int(n_inf)}/{int(n_total)} = {floor * 100:.4f}%（四捨五入 {floor * 100:.2f}%）")

    # --- Table 5 ---
    t5_lo, t5_hi, groups, human = parse_table5(lines)
    print(f"\n=== Table 5（第 {t5_lo}–{t5_hi} 行）===")
    sizes = [(g, len(r)) for g, r in groups]
    print("  設定與列數：" + "；".join(f"{g}：{n}" for g, n in sizes))
    assert [n for _, n in sizes] == [8, 6, 6, 6], sizes
    all_rows = [(g, m, v, ln) for g, rows in groups for (m, v, ln) in rows]
    assert len(all_rows) == 26
    cap = find_line(lines, r"grouped by task categories: OS, Office \(LibreOffice Calc, Impress, Writer\), Daily")
    print(f"  caption 分組（第 {cap + 1} 行）：{lines[cap].strip()[:170]}…")

    # --- 前提：Overall 是 369 題的等權平均 ---
    idx = {a: i for i, a in enumerate(apps)}
    cat_apps = {
        "OS": ["OS"],
        "Office": ["Calc", "Impress", "Writer"],
        "Daily": ["Chrome", "VLC", "Thunderbird"],
        "Profess.": ["VSCode", "GIMP"],
        "Workflow": ["Workflow"],
    }
    w = {c: sum(examples[idx[a]] for a in al) for c, al in cat_apps.items()}
    f = {c: sum(infeas[idx[a]] for a in al) for c, al in cat_apps.items()}
    assert sum(w.values()) == 369 and sum(f.values()) == 30
    print("\n=== 前提檢查：Overall 是否為五類以題數加權的平均 ===")
    print("  五類題數：" + "、".join(f"{c} {int(n)}" for c, n in w.items()) + f"（合計 {int(sum(w.values()))}）")
    cats = list(cat_apps)
    # 各類分數四捨五入到 0.01，加權後誤差 ≤ 0.005；Overall 本身再 ±0.005，所以捨入最多 0.01
    tol = 0.01
    recs, bad = {}, []
    for g, m, v, ln in all_rows:
        rec = sum(v[i] * w[c] for i, c in enumerate(cats)) / 369
        recs[(g, m)] = rec
        if abs(rec - v[5]) > tol:
            bad.append((g, m, v[5], rec, ln))
    n_ok = 26 - len(bad)
    print(f"  26 列中 {n_ok} 列的重算值與報告的 Overall 差在 {tol} 以內（捨入誤差上限）")
    for g, m, rep, rec, ln in sorted(bad, key=lambda b: -abs(b[3] - b[2])):
        print(f"    不一致：{m}（{g}，第 {ln} 行）報告 {rep:.2f}，重算 {rec:.3f}，差 {rec - rep:+.3f}")
    ok_weight = n_ok >= 20
    print("  → 多數列（" + str(n_ok) + "/26）符合「Overall = 369 題等權平均」；少數列表內自身不一致，下面用報告值與重算值各數一次")

    # --- 主判定 ---
    thr = floor * 100
    above = [(g, m, v[5]) for g, m, v, _ in all_rows if v[5] > thr]
    print(f"\n=== 26 列中 Overall > {thr:.4f}% 的列 ===")
    for g, m, s in sorted(above, key=lambda x: -x[2]):
        print(f"  {s:6.2f}%  {m}（{g}）")
    print(f"  共 {len(above)} 列；其餘 {26 - len(above)} 列都 ≤ 地板")
    above_rec = [(g, m) for g, m, v, _ in all_rows if recs[(g, m)] > thr]
    print(f"  改用重算的加權 Overall 再數一次：{len(above_rec)} 列" +
          ("，名單相同" if set(above_rec) == {(g, m) for g, m, _ in above} else "，名單不同"))
    near = min(all_rows, key=lambda r: abs(r[2][5] - thr))
    print(f"  報告值最接近地板的一列：{near[1]}（{near[0]}）{near[2][5]:.2f}%，距地板 {near[2][5] - thr:+.2f} 個百分點")
    below_sorted = sorted([(v[5], m, g) for g, m, v, _ in all_rows if v[5] <= thr], reverse=True)
    print(f"  地板以下最高的一列：{below_sorted[0][1]}（{below_sorted[0][2]}）{below_sorted[0][0]:.2f}%")

    shot = [rows for g, rows in groups if g == "Screenshot"]
    assert len(shot) == 1
    shot_best = max(shot[0], key=lambda r: r[1][5])
    print(f"\n=== 純截圖（Screenshot）組 ===")
    for m, v, ln in shot[0]:
        print(f"  {m:<16} Overall {v[5]:5.2f}%（第 {ln} 行）")
    print(f"  最高 = {shot_best[0]} {shot_best[1][5]:.2f}%，" + ("全部低於地板" if shot_best[1][5] < thr else "有高於地板者"))

    # --- 補充：各類的地板 ---
    print("\n=== 補充：一律 FAIL 在五大類各自的分數 vs 該類 26 列中的最高分 ===")
    for i, c in enumerate(cats):
        fl = f[c] / w[c] * 100
        best = max(all_rows, key=lambda r: r[2][i])
        n_above = sum(1 for r in all_rows if r[2][i] > fl)
        print(f"  {c:<9} 地板 {int(f[c])}/{int(w[c])} = {fl:5.2f}%；最高 {best[2][i]:5.2f}%（{best[1]}，{best[0]}）；高過地板 {n_above}/26 列")
    print(f"  人類（Human Performance 列）Overall = {human[5]:.2f}%")

    # --- 結論 ---
    ok = (abs(thr - 8.13) < 0.005 and len(above) == 5 and len(above_rec) == 5
          and abs(shot_best[1][5] - 5.80) < 1e-9 and shot_best[1][5] < thr and ok_weight)
    print("\n=== 結論 ===")
    print(f"  30/369 = {thr:.2f}%：{'相符' if abs(thr - 8.13) < 0.005 else '不符'}")
    print(f"  高過地板的列數 = {len(above)}（主張 5）：{'相符' if len(above) == 5 else '不符'}")
    print(f"  純截圖最高 = {shot_best[1][5]:.2f}%（主張 5.80%，且低於地板）："
          f"{'相符' if abs(shot_best[1][5] - 5.80) < 1e-9 and shot_best[1][5] < thr else '不符'}")
    print("  主張" + ("證實" if ok else "不成立或部分不成立"))
    print("  註：8.13% 是「一律回 FAIL」的下限，前提是沒有 feasible 題在初始狀態就被判成功（本程式無法檢查評估腳本）。")


if __name__ == "__main__":
    main()
