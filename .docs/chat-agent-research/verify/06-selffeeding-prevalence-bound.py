#!/usr/bin/env python3
"""驗證：Self-feeding chatbot 的不確定度基線可能接近「全部判為錯誤」的平凡解。

主張：
  筆記版：Uncertainty Top 在 recall 0.99 時 precision 為 0.39，可推知測試集中「不滿意」約佔 38%–39%；
  0.56 的 F1 已接近「全部判為錯誤」這個平凡解的水準；Table 4 的比較條件也不對等（事後判斷對事前預測）。
  章節修正版（06-user-simulator-feedback.md 第 203、270 行）：盛行率 π 不超過 precision ÷ recall，
  Uncertainty Gap 的 0.38 ÷ 1.00 給出 π 最多約 0.38；平凡解 F1 = 2π／(1+π)，π 取上限時約 0.55，
  等於 Gap 的表列值，Top 的 0.56 只高 0.01；「38% 只是上限；論文沒報 π，勝過平凡解多少無法從表中確定」。
出處：[arXiv:1901.05415] 精讀筆記 notes/1901.05415.json 的 limitations_observed 第 5 條。

輸入從哪來（全部由程式直接從 .cache/text/1901.05415.txt 解析，不手抄）：
  - 「Table 4: The maximum F1 score」caption 之前的表格：十列的 Pr.／Re.／F1。
  - 「Table 1: The number of examples」caption 之前的表格：Satisfaction 測試集 1000 筆。
  - 第 295–296 行：rating 1 → negative class（dissatisfied），3–5 → positive class（satisfied），2 丟掉。
  - §5.2：不確定度方法「predict a mistake when the confidence ... is below some threshold」；
    regex「identify user dissatisfaction」；門檻「tuned ... to achieve maximum F1 score」；
    不確定度用的是 131k 模型。
  - 第 288–290 行與 §5.2 開頭：事後（看使用者下一句）對事前（bot 開口前）的文字證據。

方法：
  1. 上限：TP = R·π·N、TP／P = 預測為正例的筆數 ≤ N，所以 π ≤ P／R。逐列算 P／R 取最小值；
     再把兩位小數的捨入算進去：π ≤ (P+0.005)／(R−0.005)，R=1.00 時分母取 0.995。
  2. 平凡解（全判為正例）的 F1 = 2π／(1+π)，在上限處與表列 0.55／0.56 比較。
  3. 整數列舉：測試集 N=1000，對每個 Npos=1..1000，逐列找整數 TP ≤ Npos、TP ≤ PP ≤ 1000，
     使捨入後的 P、R、F1 都等於表列值（容差 ±0.005）。十列共用同一個測試集，取交集，
     得到 π 的可行集合，看它是不是只貼在 0.38 附近。
  4. 附條件的第二條上限：若門檻掃描包含「全判為正例」，最大 F1 ≥ 2π／(1+π)，推得 π ≤ F1／(2−F1)。
  5. 把「被偵測的那一類」寫明：論文 §3.2 把 satisfied 定為 positive class，但 Table 4 的方法都在
     偵測錯誤／不滿意；上限的算式對「被偵測的那一類」都成立，只是那一類是不是「不滿意」屬於推論。

只用標準函式庫；沒有隨機數。執行：python3 06-selffeeding-prevalence-bound.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "1901.05415.txt")
TOL = 0.005 + 1e-9

with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")


def find_line(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(LINES)):
        if rx.search(LINES[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def blocks_between(a, b):
    rows, cur = [], []
    for i in range(a, b):
        s = LINES[i]
        if s.startswith("| "):
            cur.append(s[2:].strip())
        elif s.strip() == "":
            if cur:
                rows.append(cur)
                cur = []
    if cur:
        rows.append(cur)
    return rows


# ---- Table 1：Satisfaction 測試集大小 ----
t1 = find_line(r"^Table 1: The number of examples")
start1 = max(i for i in range(t1) if LINES[i].startswith("Table 1 reports"))
sat = [r for r in blocks_between(start1, t1) if r[0] == "Satisfaction"][0]
hdr1 = [r for r in blocks_between(start1, t1) if r[0] == "Task"][0]
N = int(sat[hdr1.index("Test")])
print(f"Table 1（第 {t1 + 1} 行 caption）：Satisfaction 列 {sat}，測試集 N = {N}")

# ---- Table 4 ----
t4 = find_line(r"^Table 4: The maximum F1 score")
start4 = max(i for i in range(t4) if LINES[i].startswith("| Method"))
rows = []
last = None
for r in blocks_between(start4, t4):
    if r[0] == "Method":
        continue
    name = r[0]
    if name.startswith("("):
        name = f"{last} (Pr≥0.5)"
    else:
        last = name
    rows.append((name, float(r[1]), float(r[2]), float(r[3])))
print(f"Table 4（第 {start4 + 1}–{t4 + 1} 行）：")
for name, p, r, f in rows:
    f_calc = 2 * p * r / (p + r)
    print(f"  {name:32s} P={p:.2f} R={r:.2f} F1={f:.2f}（由 P、R 回算 {f_calc:.4f}）")
test_line = find_line(r"Table 4 reports the maximum F1 scores achieved by each method on the Satisfaction test set")
print(f"  第 {test_line + 1} 行：Table 4 是在 Satisfaction 測試集上量的")

# ---- (1) 上限 π ≤ P/R ----
print("\n(1) 上限 π ≤ P/R（逐列；右欄把兩位小數捨入算進去）")
bounds = []
for name, p, r, f in rows:
    b = p / r
    b_round = (p + 0.005) / min(1.0, r - 0.005) if r - 0.005 > 0 else float("inf")
    b_round = min(b_round, 1.0)
    bounds.append((name, b, b_round))
    print(f"  {name:32s} P/R = {b:.4f}   捨入後最大 {b_round:.4f}")
bmin = min(bounds, key=lambda t: t[1])
bmin_r = min(bounds, key=lambda t: t[2])
print(f"  → 最緊上限：{bmin[0]} 的 {bmin[1]:.4f}；計入捨入後最緊是 {bmin_r[0]} 的 {bmin_r[2]:.4f}")
print(f"  筆記用的 Top 0.39/0.99 = {0.39 / 0.99:.4f}，比 Gap 的上限鬆")

# ---- (2) 平凡解 F1 ----
print("\n(2) 平凡解（全判為正例）F1 = 2π/(1+π)")
for pi in (bmin[1], bmin_r[2], 0.39 / 0.99):
    print(f"  π = {pi:.4f} → 平凡解 F1 = {2 * pi / (1 + pi):.4f}")
top = [x for x in rows if x[0] == "Uncertainty Top"][0]
gap = [x for x in rows if x[0] == "Uncertainty Gap"][0]
triv_at_bound = 2 * bmin[1] / (1 + bmin[1])
print(f"  表列 Gap F1 {gap[3]:.2f}、Top F1 {top[3]:.2f}；π=0.38 時平凡解 {triv_at_bound:.4f}："
      f"Gap 與它相差 {gap[3] - triv_at_bound:+.4f}，Top 相差 {top[3] - triv_at_bound:+.4f}")

# ---- (3) 整數列舉 ----
print(f"\n(3) 整數列舉：N = {N}，十列共用同一個測試集")


def feasible(npos, p, r, f):
    """回傳 (TP, PP) 的一組解或 None。"""
    tp_lo = max(0, int((r - TOL) * npos) - 1)
    tp_hi = min(npos, int((r + TOL) * npos) + 1)
    for tp in range(tp_lo, tp_hi + 1):
        if abs(tp / npos - r) > TOL:
            continue
        if tp == 0:
            continue
        pp_lo = max(tp, int(tp / (p + TOL)) - 1)
        pp_hi = min(N, int(tp / max(p - TOL, 1e-12)) + 1)
        for pp in range(pp_lo, pp_hi + 1):
            if pp < tp or pp > N:
                continue
            if abs(tp / pp - p) > TOL:
                continue
            if abs(2 * tp / (pp + npos) - f) > TOL:
                continue
            return tp, pp
    return None


per_row = {}
for name, p, r, f in rows:
    per_row[name] = {npos for npos in range(1, N + 1) if feasible(npos, p, r, f)}
    s = per_row[name]
    print(f"  {name:32s} 可行 Npos {len(s):4d} 個，範圍 {min(s)}–{max(s)}")
common = set.intersection(*per_row.values())
cs = sorted(common)
print(f"  → 十列交集：{len(cs)} 個 Npos，最小 {cs[0]}（π={cs[0] / N:.3f}），最大 {cs[-1]}（π={cs[-1] / N:.3f}）")
# 分段列出，看是不是只貼在 0.38 附近
bins = {}
for x in cs:
    bins.setdefault(x // 50 * 50, 0)
    bins[x // 50 * 50] += 1
print("  依 50 筆一段計數：" + "，".join(f"{k}–{k + 49}:{v}" for k, v in sorted(bins.items())))
print("  幾個代表點（Uncertainty Gap 那列的解與平凡解 F1）：")
for x in [cs[0], cs[len(cs) // 4], cs[len(cs) // 2], cs[3 * len(cs) // 4], cs[-1]]:
    tp, pp = feasible(x, *gap[1:])
    pi = x / N
    print(f"    Npos={x:4d}（π={pi:.3f}）：Gap 列 TP={tp} PP={pp}（預測為正例佔 {pp / N:.1%}），"
          f"平凡解 F1={2 * pi / (1 + pi):.3f}，Top 0.56 高出 {top[3] - 2 * pi / (1 + pi):+.3f}")

# ---- (4) 附條件的第二條上限 ----
print("\n(4) 附條件：若門檻掃描包含「全判為正例」，最大 F1 ≥ 2π/(1+π) ⇒ π ≤ F1/(2−F1)")
for row in (top, gap):
    f_hi = row[3] + 0.005
    print(f"  {row[0]}：F1 上捨入 {f_hi:.3f} ⇒ π ≤ {f_hi / (2 - f_hi):.4f}")
print("  論文只說門檻「tuned ... to achieve maximum F1 score」，沒說掃描範圍，所以這條只當補充。")

# ---- (5) 文字證據 ----
print("\n(5) 文字證據")
for pat in [
    r"Contexts with rating 1 were mapped to the negative class",
    r"predict a mistake when the confidence in the top rated response is below",
    r"common ways of expressing dissatisfaction",
    r"much easier using the human’s response to the utterance",
    r"easier to recognize that a mistake has already been made",
    r"asking for feedback whenever the model is most uncertain what to say next",
    r"one trained on the full 131k training examples",
]:
    i = find_line(pat)
    m = re.search(pat, LINES[i])
    print(f"  第 {i + 1} 行：…{LINES[i][max(0, m.start() - 20):m.end() + 40]}…")

print("\n結論：")
print(f"  - π 的上限：最緊的是 Gap 的 0.38（計入捨入後 {bmin_r[2]:.3f}）；筆記用 Top 得到 0.39。"
      "「38%–39%」當上限成立，當估計值不成立：「可推知約佔 38%–39%」這一步推論推翻。")
print(f"  - 整數列舉：Npos 可以從 {cs[0]} 到 {cs[-1]}（π 約 {cs[0] / N:.2f}–{cs[-1] / N:.2f}），"
      "表格決定不了 π，π 的實際值無法判定。")
print(f"  - 「0.56 接近平凡解」只在 π 貼近上限時成立；π 越小平凡解 F1 越低，Top 勝過它的幅度可到 "
      f"{top[3] - 2 * cs[0] / N / (1 + cs[0] / N):.2f}。章節「勝過平凡解多少無法從表中確定」證實。")
print("  - 「事後判斷對事前預測」：第 288–290 行與 §5.2 開頭的文字證實（文字證據，不是算出來的）。")
print("  - 假設：Table 4 的 P／R 以「不滿意（錯誤）」為被偵測類，是由方法描述推得；論文 §3.2 把 satisfied 定為 positive class。")
