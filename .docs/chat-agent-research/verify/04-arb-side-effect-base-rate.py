#!/usr/bin/env python3
"""驗證：AgentRewardBench 的副作用（side effect）金標只有約 72 條，judge 的 precision 貼近基率。

主張（章節 04-agent-trajectory.md「AgentRewardBench 只比 precision」一段）：
  Table 7 各 judge 的副作用 recall 都能寫成 k/72，推得測試集（1106 條）中只有約 72 條
  （約 6.5%）被標為有副作用；GPT-4o mini (A) 的副作用 precision 7.2 幾乎等於這個基率，
  最佳 precision 只有 14.1（Claude 3.7 (S)）。
出處：[arXiv:2504.08942] 精讀筆記 notes/2504.08942.json 的 limitations_observed 第 3 條。

輸入從哪來（全部由程式直接從 .cache/text/2504.08942.txt 解析，不手抄）：
  - 第 224 行與第 1247 行：「1106 are in the test split」。
  - 第 1413–1571 行：Table 7（Results over all benchmarks by judge），caption 在第 1572 行。
  - 第 1573–2309 行：Table 8（Finegrained results by benchmark and judge for all agents），
    caption 在第 2310 行。
  - 第 1285–1411 行：Table 6（Success Rate by evaluation type），caption 在第 1412 行；
    第 1244–1246 行：Llama 3.3 不跑 VisualWebArena、WebArena 少兩題。
  - 每個 agent 在各基準的測試筆數（AB 27、VWA 92、WA 78、WorkArena 16、WorkArena++ 87）
    取自 notes/2504.08942.json 的 limitations_observed[4]（精讀時由 Table 3／6 反推），
    本程式只把它當假設，再檢查它能不能讓 Table 6 每格都是 k/n、加總是否為 1106。
  轉換後的全文把 caption 放在表格之後，表格每列是一組以「| 」開頭的連續行，列與列之間空一行。

方法：
  1. 只看 recall：對 d = 1..1106 找出每個 recall 都能寫成 round(100k/d, 1) 的 d。
     每個一位小數的百分比都能寫成 k/1000，所以這一步必然會有很多 d 相容（72 的倍數全部相容），
     72 只是最小的那個，不能單憑這一步說「只有 72 條」。
  2. 加上 precision 與 F1 約束：對每個 judge 要找得到整數 TP 與「預測為有副作用」的筆數 pred，
     滿足 TP ≤ pred ≤ 1106、round(100·TP/d,1)=R、round(100·TP/pred,1)=P、
     round(200·TP/(pred+d),1)=F1。pred 不能超過測試集大小，這一條把大的 d 都排除掉。
  3. 獨立佐證：Table 8 各基準的副作用 recall 各自有最小分母，加總應為 72；
     每個 judge 跨基準的 TP 加總應等於 Table 7 在 d=72 時的 k。
  4. 原文沒有明說 Table 7／8 用哪個 split，改用表格之間的鏈確認：Table 6 各格筆數加總是否為 1106，
     且 Table 8 各基準「成功」recall 的分母是否等於 Table 6 專家判為成功的條數加總；
     另把 pred 上限放寬到 1302（含開發集）再跑一次唯一性。
  5. 算基率 72/1106，並列出每個 judge 的 precision ÷ 基率（隨機亂標的 precision 期望值就是基率）。
  「round(x,1)=v」一律以 |x − v| ≤ 0.05 判定（容許四捨五入在 .x5 邊界上的任一方向）。

只用標準函式庫；沒有隨機數。執行：python3 04-arb-side-effect-base-rate.py
"""

import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "2504.08942.txt")
TOL = 0.05 + 1e-9

with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")


def find_line(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(LINES)):
        if rx.search(LINES[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def rows_between(a, b):
    """回傳 [a, b) 行之間的表格列：每列是一串 cell 字串。"""
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


def num(s):
    return None if s in ("–", "-", "") else float(s)


# ---- 讀入 test split 大小 ----
test_lines = [i + 1 for i, s in enumerate(LINES) if re.search(r"1106 (are )?in the test split", s)]
N_TEST = 1106
print(f"test split 大小 1106：出現在第 {test_lines} 行")
assert test_lines, "全文裡找不到 1106 in the test split"

# ---- 解析 Table 7 ----
t6 = find_line(r"^Table 6: ")
t7 = find_line(r"^Table 7: ")
t8 = find_line(r"^Table 8: ")
table7 = {}
for r in rows_between(t6 + 1, t7):
    if len(r) == 10 and r[0] not in ("Judge", "P"):
        vals = [num(x) for x in r[1:]]
        table7[r[0]] = vals  # Success P R F1, Side P R F1, Rep P R F1
side7 = {j: (v[3], v[4], v[5]) for j, v in table7.items() if v[3] is not None}
print(f"\nTable 7（第 {t6 + 2}–{t7} 行）副作用欄，共 {len(side7)} 個 judge：")
print(f"  {'judge':<20}{'P':>6}{'R':>7}{'F1':>7}")
for j, (p, r, f1) in side7.items():
    print(f"  {j:<20}{p:>6}{r:>7}{f1:>7}")


def ks_for(value, d):
    """回傳所有使 100k/d 四捨五入到一位小數等於 value 的整數 k。"""
    lo = math.floor((value - 0.05) * d / 100) - 1
    hi = math.ceil((value + 0.05) * d / 100) + 1
    return [k for k in range(max(lo, 0), min(hi, d) + 1) if abs(100 * k / d - value) <= TOL]


# ---- 步驟 1：只看 recall ----
recall_ok = [d for d in range(1, N_TEST + 1) if all(ks_for(r, d) for (_, r, _) in side7.values())]
print(f"\n[1] 只看 recall：d ∈ 1..{N_TEST} 中相容的有 {len(recall_ok)} 個")
print(f"    最小的前 12 個：{recall_ok[:12]}")
print(f"    72 在其中：{72 in recall_ok}；72 的倍數全部相容："
      f"{all(m in recall_ok for m in range(72, N_TEST + 1, 72))}")


# ---- 步驟 2：加上 precision 與 F1 ----
def feasible(d, p, r, f1):
    """回傳所有可行的 (TP, pred)。"""
    out = []
    for k in ks_for(r, d):
        if k == 0:
            # recall 0 → TP=0，precision 必為 0（或未定義），F1 為 0
            if p == 0.0 and f1 == 0.0:
                out.append((0, None))
            continue
        lo = math.floor(100 * k / (p + 0.05)) - 1 if p + 0.05 > 0 else k
        hi = math.ceil(100 * k / (p - 0.05)) + 1 if p - 0.05 > 0 else N_TEST
        for pred in range(max(lo, k), min(hi, N_TEST) + 1):
            if abs(100 * k / pred - p) <= TOL and abs(200 * k / (pred + d) - f1) <= TOL:
                out.append((k, pred))
    return out


both_ok = [d for d in recall_ok if all(feasible(d, *v) for v in side7.values())]
print(f"\n[2] 再加上 precision 與 F1 約束（pred ≤ {N_TEST}）：相容的 d = {both_ok}")
# 找出把 72 以外的 d 排除掉的是哪個 judge
for d in (144, 216):
    bad = [j for j, v in side7.items() if not feasible(d, *v)]
    print(f"    d={d} 被排除：{bad}")

D = 72
print(f"\n    d={D} 時每個 judge 的 TP 與 pred（預測為有副作用的筆數）：")
tp72 = {}
for j, v in side7.items():
    sols = feasible(D, *v)
    ks = sorted({k for k, _ in sols})
    preds = sorted({pr for _, pr in sols})
    tp72[j] = ks
    print(f"      {j:<20} TP={ks}  pred={preds[0]}..{preds[-1]}"
          f"（佔 test split {100 * preds[0] / N_TEST:.1f}%–{100 * preds[-1] / N_TEST:.1f}%）")

# ---- 步驟 3：Table 8 佐證 ----
print(f"\n[3] Table 8（第 {t7 + 2}–{t8} 行）逐基準佐證")
bench_rows = {}
bench = None
for r in rows_between(t7 + 1, t8):
    if r[0] in ("Benchmark", "P"):
        continue
    if len(r) == 11:
        bench = r[0]
        r = r[1:]
    if len(r) != 10:
        continue
    vals = [num(x) for x in r[1:]]
    if vals[4] is not None:
        bench_rows.setdefault(bench, {})[r[0]] = vals[4]
sum_min = 0
tp_by_judge = {j: 0 for j in side7}
for b, rec in bench_rows.items():
    dmin = next(d for d in range(1, 1000) if all(ks_for(v, d) for v in rec.values()))
    sum_min += dmin
    tps = {j: ks_for(v, dmin) for j, v in rec.items()}
    for j, ks in tps.items():
        assert len(ks) == 1, (b, j, ks)
        tp_by_judge[j] += ks[0]
    print(f"    {b:<16} 最小分母 {dmin:>3}；各 judge 的 TP = {[ks[0] for ks in tps.values()]}")
print(f"    各基準最小分母加總 = {sum_min}")
print("    每個 judge 跨基準的 TP 加總 vs Table 7 在 d=72 的 k：")
all_match = True
for j in side7:
    ok = [tp_by_judge[j]] == tp72[j]
    all_match &= ok
    print(f"      {j:<20} Table 8 加總 {tp_by_judge[j]:>3}  Table 7 k {tp72[j]}  {'一致' if ok else '不一致'}")

# ---- 步驟 4：Table 7／8 是不是在 test split 上算的 ----
# 原文沒有明說 Table 7／8 用哪個 split（1302 = 開發 196 + 測試 1106）。用表格之間的鏈來確認：
#   (a) Table 6（Success Rate by evaluation type）每個 agent 的筆數，依筆記推得的
#       AB 27、VWA 92、WA 78（Llama 3.3 少兩題 → 76）、WorkArena 16、WorkArena++ 87，
#       Llama 3.3 不跑 VWA（第 1244–1246 行），加總應為 1106；並檢查 Table 6 的 Expert 與 LLM Judge
#       每一格都能寫成 k/n。
#   (b) Table 8 各基準的「成功」recall 分母 = 該基準專家判為成功的條數，
#       應等於 Table 6 各 agent 的專家成功條數加總。
print("\n[4] Table 7／8 是否在 test split 上算")
t6_start = max(i for i in range(t6) if LINES[i] == "| Benchmark" and LINES[i + 1] == "| Agent")
N_PER = {"AssistantBench": 27, "VisualWebArena": 92, "WebArena": 78, "WorkArena": 16, "WorkArena++": 87}
table6 = {}
bench = None
for r in rows_between(t6_start, t6):
    if r[0] == "Benchmark":
        continue
    if len(r) == 5:
        bench = r[0]
        r = r[1:]
    if len(r) == 4 and bench != "Overall":
        table6[(bench, r[0])] = (float(r[1]), float(r[2]))  # Expert, LLM Judge
n_total = 0
expert_pos = {}
t6_fit, t6_miss = 0, []
for (b, a), (e, j) in table6.items():
    n = N_PER[b] - (2 if (b == "WebArena" and a.startswith("Llama")) else 0)
    n_total += n
    ke = ks_for(e, n)
    expert_pos[b] = expert_pos.get(b, 0) + (ke[0] if ke else 0)
    for label, v in (("Expert", e), ("LLM Judge", j)):
        if ks_for(v, n):
            t6_fit += 1
        else:
            t6_miss.append((b, a, label, v, n, bool(ks_for(v, n - 1))))
print(f"    (a) Table 6（第 {t6_start + 1}–{t6} 行）共 {len(table6)} 個 (基準, agent) 格；每格筆數加總 = {n_total}")
print(f"        Expert／LLM Judge 共 {2 * len(table6)} 個值，{t6_fit} 個是 k/n；例外：")
for b, a, label, v, n, fit_m1 in t6_miss:
    print(f"          {b} {a} {label} {v}：不是 k/{n}，{'但是' if fit_m1 else '也不是'} k/{n - 1}（少一條）")
succ_rec = {}
bench = None
for r in rows_between(t7 + 1, t8):
    if r[0] in ("Benchmark", "P"):
        continue
    if len(r) == 11:
        bench = r[0]
        r = r[1:]
    if len(r) == 10:
        succ_rec.setdefault(bench, []).append((r[0], float(r[2])))
chain_ok = True
for b, recs in succ_rec.items():
    d = expert_pos[b]
    fit = [j for j, v in recs if ks_for(v, d)]
    miss = [(j, v, bool(ks_for(v, d - 1))) for j, v in recs if not ks_for(v, d)]
    chain_ok &= all(m1 for _, _, m1 in miss) and len(fit) > len(recs) / 2
    extra = "；例外：" + "、".join(f"{j} {v}（{'是' if m1 else '不是'} k/{d - 1}）" for j, v, m1 in miss) if miss else ""
    print(f"    (b) {b:<16} Table 6 專家成功條數加總 {d:>3}；Table 8 成功 recall 是 k/{d} 的 judge {len(fit)}/{len(recs)}{extra}")
on_test = n_total == N_TEST and all(m1 for *_, m1 in t6_miss) and chain_ok
print(f"    → {'Table 7／8 與 Table 6 是同一批 1106 條 test split 軌跡；例外都是「少一條」，像是個別 judge 輸出無法解析' if on_test else '無法綁到 test split'}")

# 保守起見，把 pred 的上限放寬到全部 1302 條再跑一次唯一性
N_TEST_SAVED = N_TEST
N_TEST = 1302
both_ok_1302 = [d for d in range(1, N_TEST + 1)
                if all(ks_for(r, d) for (_, r, _) in side7.values()) and all(feasible(d, *v) for v in side7.values())]
N_TEST = N_TEST_SAVED
print(f"    上限放寬到 1302（含開發集）時，相容的 d = {both_ok_1302}")

# ---- 步驟 5：基率與 precision ----
base = 100 * D / N_TEST
print(f"\n[5] 基率 = {D}/{N_TEST} = {base:.2f}%")
print(f"    {'judge':<20}{'P':>6}{'P÷基率':>9}")
for j, (p, _, _) in sorted(side7.items(), key=lambda kv: -kv[1][0]):
    print(f"    {j:<20}{p:>6}{p / base:>9.2f}")
best = max(side7.items(), key=lambda kv: kv[1][0])
mini_a = side7.get("GPT-4o Mini (A)")

print("\n結論：")
print(f"  - 只看 recall，d ≤ {N_TEST} 有 {len(recall_ok)} 個相容，72 是最小的，但單憑 recall 分辨不出 72 與 144、216…")
print(f"  - 加上 precision／F1 與 pred ≤ {N_TEST}，只剩 d = {both_ok}。")
print(f"  - Table 8 五個基準的最小分母加總 = {sum_min}，逐 judge 的 TP 加總與 Table 7 {'全部一致' if all_match else '有不一致'}。")
print(f"  - 基率 {base:.2f}%（主張寫約 6.5%）；GPT-4o Mini (A) 的 P = {mini_a[0]}，"
      f"是基率的 {mini_a[0] / base:.2f} 倍；最佳 P = {best[1][0]}（{best[0]}）。")
print(f"  - Table 7／8 與 Table 6 同在 1106 條 test split 上：{on_test}；pred 上限放寬到 1302 時相容的 d = {both_ok_1302}。")
verdict = both_ok == [72] and both_ok_1302 == [72] and on_test and all_match and abs(base - 6.5) < 0.05 and mini_a[0] == 7.2 and best == ("Claude 3.7 S. (S)", side7["Claude 3.7 S. (S)"]) and best[1][0] == 14.1
print(f"  判定：{'證實' if verdict else '需人工複核'}")
