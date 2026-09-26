#!/usr/bin/env python3
"""驗證：process reward 子領域三張表的重算（Qwen PRM Table 5、OmegaPRM Table 1、Lightman Table 1）。

章節 04-agent-trajectory.md 有三處從表格抽數重算，check_chapter.py 只驗得到算式本身的算術，
驗不到輸入數字是否取自正確的格子。這支程式直接從快取全文解析表格，重做一次。

主張 A（〈彙總與正規化方式會改變頭條〉Qwen 一條）[arXiv:2501.07301]：
  Table 5「答案對、過程錯」子集的四個子集分別有 7／94／161／259 題，Avg. 欄是四者的算術平均；
  改以 521 題合併計算，Skywork-PRM-7B 與 EurusPRM-Stage2 從 27.8 對 27.4 變成約 16.5 對 21.5，排名對調。
主張 B（〈best-of-N 的最終答案正確率〉「增益多半來自投票」與〈人工對自動〉兩條）[arXiv:2406.06592]：
  OmegaPRM 在四組 policy × 資料集上，比多數決只多 2.2／3.5／0.9／1.6 點，比 PRM800K 只多 1.8／1.0／0.7／0.5 點。
主張 C（〈論文正文與自己的表格對不上〉Lightman 一列）[arXiv:2305.20050]：
  正文說 OOD 有 224 題，Table 1 各科相加是 45 + 60 + 45 + 84 = 234；按題數重算 ORM 合計約 63.50，表中卻是 63.8。
  另問：PRM 與多數決兩欄的合計（72.9、61.3）能不能分辨出表格用的是四捨五入還是捨去。

輸入從哪來（全部由程式直接從 .cache/text/<id>.txt 解析，不手抄）：
  A：2501.07301.txt，「Table 5: The accuracy in identifying erroneous steps」caption 之前的表格。
  B：2406.06592.txt，「Table 1: The performance comparison of PRMs」caption 之後、正文「Table 1 and Fig. 3」之前的表格。
  C：2305.20050.txt，「## 5 OOD Generalization」之後、「Table 1: We measure out-of-distribution」caption 之前的表格，
     以及正文「held-out set of 224 STEM questions」。
  表格在轉換後的全文裡是一組組以「| 」開頭的連續行，組與組之間空一行。

方法：
  A：(1) 檢查每一列的 Avg. 是否等於四欄的算術平均（容許 0.05 的捨入）；
     (2) 檢查每一格能否寫成 k/n（n 是該子集題數），以確認 # samples 真的是分母；
     (3) 以 k 加總後除以 521 算合併正確率，比較兩種彙總下的排名，列出所有對調的配對。
  B：逐欄計算 OmegaPRM − MajorityVote@64 與 OmegaPRM − PRM800K。
  C：(1) 各科題數加總；(2) 檢查每一格能否寫成 k/n；
     (3) 三欄各自按題數加權平均：能寫成 k/n 的格子用精確分數 k/n，不能的格子用表上的一位小數，
         並給 ±0.05 的捨入誤差，得到合計的區間；
     (4) 區間與 Aggregate 比對：四捨五入相容的條件是區間與 [t − 0.05, t + 0.05) 有交集，
         捨去相容的條件是區間與 [t, t + 0.1) 有交集；結論字串一律由這兩個布林值決定；
     (5) 對照：直接拿表上的一位小數加權（W4 第一輪的做法），看結論會不會因此不同；
     (6) 若 ORM 只錯一格，哪個 k/n 值能讓加權平均的區間對上 63.8（其他格照 (3) 處理）。

只用標準函式庫；沒有隨機數。執行：python3 04-prm-table-recompute.py（從任何目錄都可以）
"""

import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "..", ".cache", "text")
NUM = re.compile(r"-?\d+(?:\.\d+)?")


def load(pid):
    with open(os.path.join(CACHE, pid + ".txt"), encoding="utf-8") as f:
        return f.read().split("\n")


def find(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def blocks(lines, a, b):
    out, cur = [], []
    for ln in lines[a:b]:
        if ln.startswith("|"):
            cur.append(ln[1:].strip())
        elif cur:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def is_kn(v, n, tol=0.05 + 1e-9):
    k = round(v * n / 100)
    return abs(100 * k / n - v) <= tol, k


def r1(x):  # 四捨五入到一位小數（half up）
    return math.floor(x * 10 + 0.5 + 1e-9) / 10


def t1(x):  # 無條件捨去到一位小數
    return math.floor(x * 10 + 1e-9) / 10


# ============ A：Qwen Table 5 ============
print("A｜Qwen2.5-Math-PRM 論文 Table 5 [arXiv:2501.07301]")
L = load("2501.07301")
cap = find(L, r"^Table 5: The accuracy in identifying erroneous steps")
start = find(L, r"^\| # samples", cap - 150)
bl = blocks(L, start - 10, cap)
ns, rows = None, {}
for b in bl:
    if b[0] == "# samples":
        ns = [int(x) for x in b[1:5]]
        continue
    vals = [x for x in b[1:] if NUM.fullmatch(x)]
    if len(vals) == 5:
        name = b[0].replace("$\\bigstar$", "★").strip()
        rows[name] = [float(x) for x in vals]
print(f"  表格位置：第 {start + 1}–{cap + 1} 行；子集題數 {ns}，合計 {' + '.join(map(str, ns))} = {sum(ns)}")
avg_ok = []
for name, v in rows.items():
    mean = sum(v[:4]) / 4
    avg_ok.append(abs(mean - v[4]) <= 0.05 + 1e-9)
print(f"  (1) Avg. 欄 = 四欄算術平均：{sum(avg_ok)}/{len(avg_ok)} 列成立")
bad_kn = [(name, v[i], ns[i]) for name, v in rows.items() for i in range(4) if not is_kn(v[i], ns[i])[0]]
print(f"  (2) 每格都能寫成 k/n：{len(rows) * 4 - len(bad_kn)}/{len(rows) * 4} 格成立；不成立的格：{bad_kn}")
pooled = {}
for name, v in rows.items():
    ks = [is_kn(v[i], ns[i])[1] for i in range(4)]
    pooled[name] = 100 * sum(ks) / sum(ns)
sky, eur = "Skywork-PRM-7B", "EurusPRM-Stage2"
print(f"  (3) {sky}：算術平均 {rows[sky][4]}，合併 {pooled[sky]:.2f}（命中 {[is_kn(rows[sky][i], ns[i])[1] for i in range(4)]}）")
print(f"      {eur}：算術平均 {rows[eur][4]}，合併 {pooled[eur]:.2f}（命中 {[is_kn(rows[eur][i], ns[i])[1] for i in range(4)]}）")
names = list(rows)
swaps = []
for i in range(len(names)):
    for j in range(i + 1, len(names)):
        a, b = names[i], names[j]
        da = rows[a][4] - rows[b][4]
        dp = pooled[a] - pooled[b]
        if da * dp < 0:
            swaps.append((a, rows[a][4], round(pooled[a], 1), b, rows[b][4], round(pooled[b], 1)))
print(f"      全部 {len(names)} 個 PRM、{len(names) * (len(names) - 1) // 2} 組配對中，兩種彙總排名相反的有 {len(swaps)} 組：")
for s in swaps:
    print(f"        {s[0]}（算術 {s[1]}，合併 {s[2]}） 對 {s[3]}（算術 {s[4]}，合併 {s[5]}）")
A_ok = (ns == [7, 94, 161, 259] and all(avg_ok) and not bad_kn
        and rows[sky][4] > rows[eur][4] and pooled[sky] < pooled[eur]
        and abs(pooled[sky] - 16.5) < 0.1 and abs(pooled[eur] - 21.5) < 0.1)
print(f"  → 主張 A {'證實' if A_ok else '需複核'}")

# ============ B：OmegaPRM Table 1 ============
print("\nB｜OmegaPRM Table 1 [arXiv:2406.06592]")
L = load("2406.06592")
cap = find(L, r"^Table 1: The performance comparison of PRMs trained with different process supervision datasets")
end = find(L, r"^Table 1 and Fig\. 3 presents", cap)
bl = blocks(L, cap + 1, end)
cols = [b for b in bl if b and b[0] == "" and len(b) == 5 and "Gemini Pro" in b]
tab = {}
for b in bl:
    vals = [x for x in b[1:] if NUM.fullmatch(x)]
    if len(vals) == 4 and b[0]:
        tab[b[0].strip()] = [float(x) for x in vals]
print(f"  表格位置：第 {cap + 1}–{end} 行；欄：MATH500（Gemini Pro、Gemma 2 27B）、GSM8K（Gemini Pro、Gemma 2 27B）")
for k, v in tab.items():
    print(f"    {k:<28}{v}")
om, mv, h = tab["+ OmegaPRM"], tab["MajorityVote@64"], tab["+ PRM800K"]
d_mv = [round(a - b, 1) for a, b in zip(om, mv)]
d_h = [round(a - b, 1) for a, b in zip(om, h)]
print(f"  OmegaPRM − 多數決 = {d_mv}；OmegaPRM − PRM800K = {d_h}")
B_ok = d_mv == [2.2, 3.5, 0.9, 1.6] and d_h == [1.8, 1.0, 0.7, 0.5]
print(f"  → 主張 B {'證實' if B_ok else '需複核'}")

# ============ C：Lightman Table 1 ============
print("\nC｜Lightman et al. Table 1（OOD）[arXiv:2305.20050]")
L = load("2305.20050")
sec = find(L, r"^## 5 OOD Generalization")
cap = find(L, r"^Table 1: We measure out-of-distribution generalization", sec)
bl = blocks(L, sec + 1, cap)
header = bl[0]
assert header[1:] == ["ORM", "PRM", "Majority Vote", "# Problems"], header
subj, agg = {}, None
for b in bl[1:]:
    vals = [float(m.group()) for x in b[1:] for m in [NUM.search(x)] if m]
    if b[0] == "Aggregate":
        agg = vals
    else:
        subj[b[0]] = vals
txt = "\n".join(L)
m224 = re.search(r"held-out set of (\d+) STEM questions", txt)
counts = [int(v[3]) for v in subj.values()]
N = sum(counts)
names_s = list(subj)
print(f"  表格位置：第 {sec + 1}–{cap + 1} 行；正文說 {m224.group(1)} 題，表中 {' + '.join(map(str, counts))} = {N}，Aggregate 列寫 {int(agg[3])}")
colnames = ["ORM", "PRM", "Majority Vote"]
HALF = 0.05  # 表上一位小數的最大捨入誤差


def cell(s, ci):
    """回傳（用來加權的值, 誤差, 說明）：能寫成 k/n 就用精確分數，否則用表上的值並給 ±0.05。"""
    v, n = subj[s][ci], int(subj[s][3])
    ok, k = is_kn(v, n)
    if ok:
        return 100 * k / n, 0.0, f"{k}/{n}"
    return v, HALF, f"{v}±{HALF}"


def interval(vals_errs):
    w = sum(v * subj[s][3] for s, (v, e) in zip(names_s, vals_errs)) / N
    d = sum(e * subj[s][3] for s, (v, e) in zip(names_s, vals_errs)) / N
    return w, w - d, w + d


def compat(lo, hi, t):
    rnd = hi >= t - 0.05 - 1e-9 and lo < t + 0.05 - 1e-9
    trn = hi >= t - 1e-9 and lo < t + 0.1 - 1e-9
    return rnd, trn


def verdict(rnd, trn):
    if rnd and trn:
        return "四捨五入與捨去都相容，分辨不出捨入方式"
    if rnd:
        return "只有四捨五入相容"
    if trn:
        return "只有捨去相容"
    return "四捨五入與捨去都對不上"


print("  (2) 各格能否寫成 k/n：")
for s in names_s:
    n = int(subj[s][3])
    flags = []
    for ci, cn in enumerate(colnames):
        ok, k = is_kn(subj[s][ci], n)
        flags.append(f"{cn} {subj[s][ci]}{'=' + str(k) + '/' + str(n) if ok else '（不是 k/' + str(n) + '）'}")
    print(f"    {s:<13} " + "；".join(flags))
print("  (3)(4) 精確分數加權（非 k/n 的格子給 ±0.05）：")
res = {}
for ci, cn in enumerate(colnames):
    ve = [cell(s, ci)[:2] for s in names_s]
    parts = " + ".join(f"{cell(s, ci)[2]}×{int(subj[s][3])}" for s in names_s)
    w, lo, hi = interval(ve)
    rnd, trn = compat(lo, hi, agg[ci])
    res[cn] = (w, lo, hi, rnd, trn)
    print(f"    {cn:<14} ({parts})/{N} = {w:.3f}，區間 {lo:.3f}–{hi:.3f}；表中 {agg[ci]} → {verdict(rnd, trn)}")
print("  (5) 對照：直接拿表上的一位小數加權（不給誤差）：")
disp = {}
for ci, cn in enumerate(colnames):
    w = sum(subj[s][ci] * subj[s][3] for s in names_s) / N
    rnd, trn = abs(r1(w) - agg[ci]) < 1e-9, abs(t1(w) - agg[ci]) < 1e-9
    disp[cn] = (rnd, trn)
    print(f"    {cn:<14} {w:.3f}，四捨五入 {r1(w)}、捨去 {t1(w)}；表中 {agg[ci]} → {verdict(rnd, trn)}")
changed = [cn for cn in colnames if disp[cn] != res[cn][3:]]
print(f"    與精確分數的結論不同的欄：{changed if changed else '無'}")
# (6) 若 ORM 只錯一格，哪個 k/n 能讓合計的區間對上 Aggregate
cands = []
for si, s in enumerate(names_s):
    n = int(subj[s][3])
    for k in range(n + 1):
        ve = [cell(x, 0)[:2] if x != s else (100 * k / n, 0.0) for x in names_s]
        w, lo, hi = interval(ve)
        if any(compat(lo, hi, agg[0])):
            cands.append((s, f"{k}/{n}", round(100 * k / n, 2), round(w, 3)))
print(f"  (6) 若 ORM 只錯一格，能讓合計對上 {agg[0]} 的 k/n：{cands}")
amc_kn = [is_kn(subj['AMC10/12'][ci], 84)[0] for ci in range(3)]
orm_w, orm_lo, orm_hi, orm_rnd, orm_trn = res["ORM"]
C_ok = (int(m224.group(1)) == 224 and N == 234 and agg[0] == 63.8
        and abs(orm_w - 63.50) < 0.01 and not orm_rnd and not orm_trn)
prm_v = verdict(*res["PRM"][3:])
mv_v = verdict(*res["Majority Vote"][3:])
print(f"  → 主張 C {'證實' if C_ok else '需複核'}：ORM 精確分數加權 {orm_w:.3f}（區間 {orm_lo:.3f}–{orm_hi:.3f}）對表中 {agg[0]}，"
      f"{verdict(orm_rnd, orm_trn)}。")
print(f"     PRM：{prm_v}；多數決：{mv_v}。")
print(f"     AMC10/12 三欄都不是 k/84（{amc_kn}），可見各格未必是單純的「答對題數 ÷ 題數」，"
      f"所以上面 {len(cands)} 個「只錯一格」的候選都只是與數字相容的可能，不能當結論。")

print("\n結論：")
print(f"  A（Qwen Table 5 合併重算、排名對調）：{'證實' if A_ok else '需複核'}；兩種彙總排名相反的配對共 {len(swaps)} 組。")
print(f"  B（OmegaPRM 比多數決與 PRM800K 的差距）：{'證實' if B_ok else '需複核'}。")
print(f"  C（Lightman OOD：224 對 234、ORM 合計約 63.50 對 63.8）：{'證實' if C_ok else '需複核'}；PRM 欄{prm_v}，多數決欄{mv_v}。")
print(f"  判定：{'三項全部證實' if (A_ok and B_ok and C_ok) else '有項目需人工複核'}")
