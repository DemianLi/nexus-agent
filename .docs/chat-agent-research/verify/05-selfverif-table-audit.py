#!/usr/bin/env python3
"""驗證：Stechly et al.（2402.08115）主表與附錄表的帳目，以及章節引用的幾個差值。

主張（章節 05-self-correction-reflection.md；A、D 的三處帳目錯誤是精讀筆記 limitations_observed 指出的）：
  A. Table 2、A2、A5、A6 裡「分子/分母（百分比）」的格子，差超過 0.1 個百分點的有五格：
     筆記指出的三格——Table A2 Mystery-S 的 FNR「96.1%（149/103）」、Mystery-CoT 的 FNR「72.8%（113/103）」
     （分子大於分母），以及 Table A6 隨機計畫的批評正確「59/100（100%）」——再加上筆記沒列的兩格：
     同兩列的 FPR「1.3%（4/397）」與「3.2%（11/397）」（4/397 約 1.0%、11/397 約 2.8%）。
     另有兩格只差在最後一位的捨入（Blocksworld-S 與 Blocksworld-CoT 的 FPR）。
  B. Mystery-S／Mystery-CoT 的 FN 分子用兩種方法回推會得到不同的數：依百分比是 103 × 96.1% ≈ 99、103 × 72.8% ≈ 75；
     依同列準確率與 FPR 的計數回推（錯誤數 = 500 − 答對數 = FP + FN）是 101 與 80。
  B2. （無法判定）那兩列的 FN 真值是多少：兩種回推法不一致，同列 FPR 又對不上，表內沒有第三個來源可以裁決。
  C. （本章重算）Table 2／A2 各列「準確率 = 1 −（FP + FN）÷ 總數」是否成立（A 已判定帳目有誤的 Mystery-S／CoT 不算）：
     Game of 24、Graph Coloring（含 CoT）、Mystery 成立；Game of 24-CoT 差 1；Blocksworld 三列都不成立
     （例如主表 500 − 64 − 24 = 412，表上寫 359）。附帶印出：主表 Mystery 列可由 A6 的二元判斷完整重建，
     Blocksworld 列由 A5 只重建得出 FN；FP 重建是 49（FPR 49 ÷ 345 ≈ 14.2%），主表寫 64（18.55%）。
  C2. （無法判定）Blocksworld 的驗證準確率是否另有定義：全文只說準確率以 sound verifier 的輸出為準，
     沒有說 Blocksworld 另有算法；表內數字與 FP、FN 計數不相容的原因，無法從表內判定。
  D. Table A4 的 Total 列：Vertex、Edge、Both、None、Correct 五欄等於各列加總；Errors 欄寫 282，
     實際加總 0 + 187 + 0 + 736 + 240 = 1163。
  E. （本章重算）Table 1 與 Table A1 共有的欄位：S.P.、Sampling（k=15）、LLM+LLM 四個領域都一致；
     F.E.F. 在 Mystery Blocksworld 不一致（Table 1 是 8%，Table A1 是 6%，6% 是 Table 1 的 A.E.F.）。
  F. 章節引用的差值：Blocksworld 的 F.E.F. 比 B.F. 高 87 − 60 = 27 個百分點，比 Sampling 高 87 − 68 = 19（k=15）
     與 87 − 72 = 15（k=25）；論文正文卻說三級回饋「差別很小」。
  G. 章節引用的差值：Game of 24 的 LLM+LLM-C 32% 比 F.E.F. 38% 低 6 個百分點，與附錄 A.1 正文的
     「6 percentage point gap」與「17 times」一致。

輸入：.cache/text/2402.08115.txt、notes/2402.08115.json。
無隨機數，不需種子。只用標準函式庫。執行（研究根目錄）：python3 verify/05-selfverif-table-audit.py
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
lines = (ROOT / ".cache" / "text" / "2402.08115.txt").read_text(encoding="utf-8").splitlines()
note_s = json.dumps(json.loads((ROOT / "notes" / "2402.08115.json").read_text(encoding="utf-8")), ensure_ascii=False)
verdicts = []
undecided = []


def verdict(tag, ok, msg):
    verdicts.append((tag, ok))
    print(f"  [{tag}] {'證實' if ok else '不成立'}：{msg}")


def undecidable(tag, msg):
    undecided.append(tag)
    print(f"  [{tag}] 無法判定：{msg}")


def find_line(pat, start=0):
    for i in range(start, len(lines)):
        if re.search(pat, lines[i]):
            return i
    raise SystemExit(f"找不到：{pat}")


def region(a, b):
    return " ".join(lines[a:b])


FR = r"([\d.]+)% \((\d+)/(\d+)\)"

# ---------- Table 2 與 Table A2 ----------
t2 = find_line(r"^Table 2: LLM Verification results")
t2_start = find_line(r"^\| Domain", t2 - 30)
ta2 = find_line(r"^Table A2: LLM Verification results across prompts")
ta2_start = find_line(r"^\| Domain", ta2 - 70)
row_re = re.compile(r"\|\s*([A-Za-z][A-Za-z0-9 \-]*?)\s*\|\s*" + FR + r"\s*\|\s*" + FR + r"\s*\|\s*" + FR)


def parse_verif(a, b):
    out = {}
    for m in row_re.finditer(region(a, b)):
        g = m.groups()
        out[g[0]] = {"acc": (float(g[1]), int(g[2]), int(g[3])),
                     "fpr": (float(g[4]), int(g[5]), int(g[6])),
                     "fnr": (float(g[7]), int(g[8]), int(g[9]))}
    return out


T2 = parse_verif(t2_start, t2)
A2 = parse_verif(ta2_start, ta2)
print(f"== Table 2（第 {t2 + 1} 行）解析 {len(T2)} 列；Table A2（第 {ta2 + 1} 行）解析 {len(A2)} 列 ==")

# ---------- Table A5、A6 ----------
a5 = find_line(r"^Table A5: ")
a6 = find_line(r"^Table A6: ")
a51 = find_line(r"^#### A\.5\.1 ")
plan_re = re.compile(r"\|\s*(Correct|Inexecutable|Non Goal Reaching|Random)\s*\|\s*(\d+)/(\d+) \(([\d.]+)%\)\s*\|\s*"
                     r"(\d+)/(\d+) \(([\d.]+)%\)\s*\|\s*(\d+)/(\d+) \(([\d.]+)%\)")
PLAN_KEYS = ["Correct", "Inexecutable", "Non Goal Reaching", "Random", "LLM Correct", "LLM Inexecutable",
             "LLM Non Goal Reaching"]


def parse_plan(a, b):
    rows = []
    for m in plan_re.finditer(region(a, b)):
        g = m.groups()
        rows.append([(int(g[k]), int(g[k + 1]), float(g[k + 2])) for k in (1, 4, 7)])
    assert len(rows) == 7, len(rows)
    return dict(zip(PLAN_KEYS, rows))


A5 = parse_plan(a51, a5 + 1)
A6 = parse_plan(a5 + 1, a6 + 1)
print(f"== Table A5（第 {a5 + 1} 行）、A6（第 {a6 + 1} 行）各解析 7 列 ==")

# ---------- A. 分數與百分比 ----------
print("\n== A. 分數與百分比是否一致（差超過 0.1 個百分點算對不上，0.05–0.1 算捨入差） ==")
bad, rounding = [], []
n_cells = 0
cells_all = []
for tname, tab in (("Table 2", T2), ("Table A2", A2)):
    for r, cells in tab.items():
        for col, (p, n, d) in cells.items():
            cells_all.append((tname, r, col, n, d, p, f"{p}% ({n}/{d})"))
for tname, tab in (("Table A5", A5), ("Table A6", A6)):
    for r, cells in tab.items():
        for col, (n, d, p) in zip(("binary", "type", "critique"), cells):
            cells_all.append((tname, r, col, n, d, p, f"{n}/{d} ({p}%)"))
for tname, r, col, n, d, p, shown in cells_all:
    n_cells += 1
    gap = abs(100 * n / d - p)
    if gap > 0.1:
        bad.append((tname, r, col, shown, round(100 * n / d, 2)))
    elif gap > 0.05:
        rounding.append((tname, r, col, shown, round(100 * n / d, 2)))
for b in bad:
    print(f"  對不上　{b[0]} {b[1]} {b[2]}：寫成 {b[3]}，分數本身是 {b[4]}%")
for b in rounding:
    print(f"  捨入差　{b[0]} {b[1]} {b[2]}：寫成 {b[3]}，分數本身是 {b[4]}%")
noted = {("Table A2", "Mystery-S", "fnr"), ("Table A2", "Mystery-CoT", "fnr"), ("Table A6", "Random", "critique")}
extra = {("Table A2", "Mystery-S", "fpr"), ("Table A2", "Mystery-CoT", "fpr")}
verdict("A", {(b[0], b[1], b[2]) for b in bad} == noted | extra
        and {(b[0], b[1]) for b in rounding} == {("Table A2", "Blocksworld-S"), ("Table A2", "Blocksworld-CoT")}
        and all(k in note_s for k in ("149/103", "113/103", "59/100")),
        f"{n_cells} 格中有 {len(bad)} 格差超過 0.1 個百分點：筆記指出的三格（A2 兩格 FNR、A6 一格），"
        f"加上筆記沒列的 A2 Mystery-S／Mystery-CoT 兩格 FPR；另 {len(rounding)} 格只差捨入")

# ---------- B. 那兩格的真分子 ----------
print("\n== B. Mystery-S／Mystery-CoT 的 FNR 分子能不能回推 ==")
rec = {}
for r in ("Mystery-S", "Mystery-CoT"):
    acc, fpr, fnr = A2[r]["acc"], A2[r]["fpr"], A2[r]["fnr"]
    by_pct = round(fnr[2] * fnr[0] / 100)
    by_acc = acc[2] - acc[1] - fpr[1]
    rec[r] = (by_pct, by_acc)
    print(f"  {r}：依百分比 {fnr[2]} × {fnr[0]}% ≈ {by_pct}；依計數 {acc[2]} − {acc[1]} − {fpr[1]} = {by_acc}")
verdict("B", rec == {"Mystery-S": (99, 101), "Mystery-CoT": (75, 80)},
        "兩種回推法得到不同分子（99 對 101、75 對 80）")
undecidable("B2", "Mystery-S／Mystery-CoT 兩列的 FN 真值：兩種回推法不一致，同列 FPR 也對不上（見 A），"
            "表內沒有第三個來源可以裁決")

# ---------- C. 準確率恆等式 ----------
print("\n== C. 準確率 = 1 −（FP + FN）÷ 總數（本章重算） ==")
c_res = {}
for r, cells in A2.items():
    if r in ("Mystery-S", "Mystery-CoT"):
        continue
    acc, fpr, fnr = cells["acc"], cells["fpr"], cells["fnr"]
    total = fpr[2] + fnr[2]
    implied = total - fpr[1] - fnr[1]
    c_res[r] = implied - acc[1]
    print(f"  {r:20s} 總數 {acc[2]}（FPR 分母 {fpr[2]} + FNR 分母 {fnr[2]} = {total}）；"
          f"{total} − {fpr[1]} − {fnr[1]} = {implied}，表上答對 {acc[1]}，差 {implied - acc[1]}")
main_same = all(T2[r] == A2[{"Mystery Blocksworld": "Mystery"}.get(r, r)] for r in T2)
print(f"  Table 2 的四列與 Table A2 同名列完全相同：{main_same}")
ok_c = (main_same and all(c_res[r] == 0 for r in ("Game of 24", "Graph Coloring", "Graph Coloring-CoT", "Mystery"))
        and c_res["Game of 24-CoT"] == -1 and all(c_res[r] > 40 for r in ("Blocksworld", "Blocksworld-S", "Blocksworld-CoT")))
verdict("C", ok_c, "Game of 24、Graph Coloring、Mystery 成立；Game of 24-CoT 差 1；Blocksworld 三列都差 40 題以上"
        f"（主表 {T2['Blocksworld']['fpr'][2] + T2['Blocksworld']['fnr'][2]} − {T2['Blocksworld']['fpr'][1]} − "
        f"{T2['Blocksworld']['fnr'][1]} = {500 - 64 - 24}，表上 {T2['Blocksworld']['acc'][1]}）")

# 附帶：主表 Mystery／Blocksworld 列能不能從 A6／A5 的二元判斷重建
print("  附帶：由 A5／A6 的二元判斷重建主表")
for name, tab, row in (("Mystery", A6, "Mystery Blocksworld"), ("Blocksworld", A5, "Blocksworld")):
    pos = ["Correct", "LLM Correct"]
    neg = [k for k in PLAN_KEYS if k not in pos]
    fn = sum(tab[k][0][1] - tab[k][0][0] for k in pos)
    fp = sum(tab[k][0][1] - tab[k][0][0] for k in neg)
    right = sum(tab[k][0][0] for k in PLAN_KEYS)
    t = T2[row]
    print(f"    {name}：FN {fn}（主表 {t['fnr'][1]}），FP {fp}（主表 {t['fpr'][1]}），答對 {right}（主表 {t['acc'][1]}）")
    if name == "Blocksworld":
        neg_total = sum(tab[k][0][1] for k in neg)
        terms = " + ".join(f"({tab[k][0][1]} − {tab[k][0][0]})" for k in neg)
        print(f"    Blocksworld 的 FP 依 A5 重建：{terms} = {fp}；錯誤計畫總數 {neg_total}（主表 FPR 分母 {t['fpr'][2]}）")
        print(f"    Blocksworld 的 FPR：主表 {t['fpr'][1]} ÷ {t['fpr'][2]} ≈ {100 * t['fpr'][1] / t['fpr'][2]:.2f}%"
              f"（表上寫 {t['fpr'][0]}%）；依 A5 重建 {fp} ÷ {neg_total} ≈ {100 * fp / neg_total:.2f}%")
acc_def = find_line(r"measure accuracy compared to the sound verifier")
acc_lines = [i + 1 for i, ln in enumerate(lines) if re.search(r"accuracy", ln, re.I)]
print(f"  全文提到 accuracy 的行：{acc_lines}；第 {acc_def + 1} 行說準確率以 sound verifier 的輸出為準")
undecidable("C2", "Blocksworld 的驗證準確率是否另有定義：論文沒有說 Blocksworld 另有算法，"
            "表內數字與 FP、FN 計數不相容的原因無法從表內判定")

# ---------- D. Table A4 ----------
print("\n== D. Table A4 的 Total 列 ==")
ta4 = find_line(r"^Table A4: ")
ta4_end = find_line(r"^Edge hallucinations are more common", ta4)
a4_re = re.compile(r"\|\s*(Correct|Ablated|Non-optimal|Random|LLM|Total)\s*\|" + r"\s*(\d+)\s*\|" * 5 + r"\s*(\d+)")
A4 = {m.group(1): [int(x) for x in m.groups()[1:]] for m in a4_re.finditer(region(ta4, ta4_end))}
cols = ["Vertex", "Edge", "Both", "None", "Errors", "Correct"]
sums = [sum(A4[r][k] for r in ("Correct", "Ablated", "Non-optimal", "Random", "LLM")) for k in range(6)]
mism = []
for k, c in enumerate(cols):
    flag = "" if sums[k] == A4["Total"][k] else "  ← 對不上"
    if flag:
        mism.append(c)
    print(f"  {c:8s} 各列加總 {sums[k]:5d}，Total 列 {A4['Total'][k]:5d}{flag}")
err_terms = " + ".join(str(A4[r][4]) for r in ("Correct", "Ablated", "Non-optimal", "Random", "LLM"))
print(f"  Errors：{err_terms} = {sums[4]}")
verdict("D", mism == ["Errors"] and sums[4] == 1163 and A4["Total"][4] == 282 and "1163" in note_s,
        "Total 列只有 Errors 欄錯：寫 282，加總 1163；其他五欄都對")

# ---------- E. Table 1 對 Table A1 ----------
print("\n== E. Table 1 與 Table A1 的共同欄位（本章重算） ==")
t1 = find_line(r"^Table 1: Accuracy across prompting schemes")
t1s = find_line(r"^## 5 Examining Self-Verification")
dom1 = ["Game of 24", "Graph Coloring", "Blocksworld", "Mystery Blocksworld"]
seg = "\n".join(lines[t1s:t1])
parts = re.split(r"\n(Game of 24|Graph Coloring|Blocksworld|Mystery Blocksworld)\n", seg)
T1 = {}
for k in range(1, len(parts), 2):
    vals = re.findall(r"(\d+)%|N/A", parts[k + 1])
    toks = re.findall(r"(\d+%|N/A)", parts[k + 1])
    T1[parts[k]] = [None if t == "N/A" else int(t[:-1]) for t in toks[:8]]
T1_COLS = ["S.P.", "LLM+LLM", "B.F.", "F.E.F.", "A.E.F.", "k=15", "k=25", "S.C."]
for d in dom1:
    print(f"  Table 1 {d:20s}：{dict(zip(T1_COLS, T1[d]))}")
ta1 = find_line(r"^Table A1: ")
ta1s = find_line(r"^### A\.1 ")
seg = "\n".join(lines[ta1s:ta1])
parts = re.split(r"\n(Game of 24|Coloring|Blocksworld|Mystery)\n", seg)
A1 = {}
for k in range(1, len(parts), 2):
    toks = re.findall(r"(\d+)%", parts[k + 1])
    A1[parts[k]] = [int(t) for t in toks[:5]]
A1_COLS = ["S.P.", "Sampling", "LLM+LLM", "LLM+LLM-C", "F.E.F."]
pairs = {"Game of 24": "Game of 24", "Graph Coloring": "Coloring", "Blocksworld": "Blocksworld",
         "Mystery Blocksworld": "Mystery"}
diffs = []
for d1, da in pairs.items():
    a = dict(zip(A1_COLS, A1[da]))
    t = dict(zip(T1_COLS, T1[d1]))
    print(f"  Table A1 {da:12s}：{a}")
    for c1, ca in (("S.P.", "S.P."), ("k=15", "Sampling"), ("LLM+LLM", "LLM+LLM"), ("F.E.F.", "F.E.F.")):
        if t[c1] != a[ca]:
            diffs.append((d1, c1, t[c1], a[ca]))
for x in diffs:
    print(f"  不一致：{x[0]} {x[1]}：Table 1 {x[2]}%，Table A1 {x[3]}%")
verdict("E", diffs == [("Mystery Blocksworld", "F.E.F.", 8, 6)] and T1["Mystery Blocksworld"][4] == 6,
        "共同欄位只有 Mystery 的 F.E.F. 不一致（8% 對 6%；6% 等於 Table 1 的 A.E.F.）")

# ---------- F. Blocksworld 的差值 ----------
print("\n== F. Blocksworld：三級回饋與 Sampling ==")
bw = dict(zip(T1_COLS, T1["Blocksworld"]))
d_bf, d15, d25 = bw["F.E.F."] - bw["B.F."], bw["F.E.F."] - bw["k=15"], bw["F.E.F."] - bw["k=25"]
little = find_line(r"very little difference between these three conditions")
print(f"  F.E.F. − B.F. = {bw['F.E.F.']} − {bw['B.F.']} = {d_bf}；F.E.F. − k=15 = {d15}；F.E.F. − k=25 = {d25}")
print(f"  第 {little + 1} 行正文：三級回饋 very little difference")
verdict("F", (d_bf, d15, d25) == (27, 19, 15), "Blocksworld 的 F.E.F. 比 B.F. 高 27、比 Sampling 高 19 與 15 個百分點")

# ---------- G. CoT 驗證的差距 ----------
print("\n== G. Game of 24 的 CoT 驗證 ==")
g = dict(zip(A1_COLS, A1["Game of 24"]))
gap_line = find_line(r"6 percentage point gap")
tok_line = find_line(r"17 times increase in necessary output tokens")
print(f"  LLM+LLM-C {g['LLM+LLM-C']}%，F.E.F. {g['F.E.F.']}%，差 {g['F.E.F.'] - g['LLM+LLM-C']}（第 {gap_line + 1} 行寫 6 個百分點；"
      f"第 {tok_line + 1} 行寫輸出 token 17 倍）")
print(f"  A2：Game of 24-CoT 準確率 {A2['Game of 24-CoT']['acc'][0]}%，FPR {A2['Game of 24-CoT']['fpr'][0]}%，"
      f"FNR {A2['Game of 24-CoT']['fnr'][0]}%")
verdict("G", g["F.E.F."] - g["LLM+LLM-C"] == 6 and g["S.P."] == 5, "CoT 驗證把 Game of 24 拉到 32%，仍比 sound F.E.F. 的 38% 低 6 個百分點")

ok = all(v for _, v in verdicts)
print(f"\n結論：{sum(v for _, v in verdicts)}/{len(verdicts)} 個子主張證實，另有 {len(undecided)} 個無法判定"
      f"（{'、'.join(undecided)}）；筆記指出的帳目錯誤（A2 兩格 FNR、A4 Errors 總計、"
      f"A6 一格）屬實，另有 A2 同兩列的 FPR、Blocksworld 準確率與 FP／FN 計數、Table 1 與 A1 的 Mystery F.E.F. 對不上；"
      f"章節引用的 Table 1／A1 差值（27、19、15、6）可由表重算。")
sys.exit(0 if ok else 1)
