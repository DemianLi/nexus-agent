#!/usr/bin/env python3
"""驗證：Agent-FLAN Table 3 的 w/o NS 列 H_Score 與自己的子指標對不上。

主張（章節 04-agent-trajectory.md「Agent-FLAN 的幻覺改善有一部分是指標送的」一段）：
  依 H_ReAct 15.6、H_General 13.5 重算，w/o NS 的 H_Score 應為 85.45，表中卻是 84.5；
  同一公式能算回其他列，所以是單列不一致而不是公式讀錯；負樣本的實際效果可能只有
  89.1 − 85.45 = 3.65 分，而非 89.1 − 84.5 = 4.6 分。
出處：[arXiv:2403.12881] 精讀筆記 notes/2403.12881.json 的 limitations_observed 第 2 條。

輸入從哪來（全部由程式直接從 .cache/text/2403.12881.txt 解析，不手抄）：
  - 第 345–348 行：H_Score 的定義與式 (1)。文字說是兩項指標的「reverse average」，
    式 (1) 卻把兩項都寫成 H_ReAct（筆誤）。
  - 第 363–396 行：Table 3（Method、T-Eval、H_ReAct、H_General、H_Score）。
  - 第 179–255 行：Table 1（Held-In、HotpotQA、SciWorld、WebArena、T-Eval、Agent-H、Overall），
    用來核對 Table 1 的 AgentTuning* Agent-H 與 Table 3 的差異。

方法：
  1. 以 H_Score = 0.5 × ((100 − H_ReAct) + (100 − H_General)) 重算四列。
     表內數字都四捨五入到 0.1，所以重算值本身有 ±0.05 的不確定，表值也有 ±0.05，
     兩者合計容忍 0.1：|重算 − 表值| ≤ 0.1 才算相容。
  2. 列舉其他讀法（式 (1) 字面的 100 − H_ReAct、只用 H_General、取較大者、兩項相加），
     看有沒有哪一種讀法能同時對上四列；若沒有，而「兩項平均」對上其中三列，就是單列不一致。
  3. 反推：若 84.5 是對的，H_ReAct + H_General 要是多少；若子指標是對的，H_Score 應是多少。
  4. 附帶核對 Table 1：Overall 是否為五個 Held-Out 欄的平均，以及 AgentTuning* 的 Agent-H
     用 84.5（Table 1）或 83.9（Table 3）時 Overall 是否都相容。

只用標準函式庫；沒有隨機數。執行：python3 04-agentflan-hscore.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "2403.12881.txt")

with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")


def find_line(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(LINES)):
        if rx.search(LINES[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def rows_between(a, b):
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


# ---- 式 (1) ----
eq = find_line(r"H\}_\{\\text\{Score\}\}=0\.5")
print(f"式 (1)（第 {eq + 1} 行）：{LINES[eq].strip()}")
print("  兩項都寫成 H_ReAct；前一段文字說 H_Score 是 H_ReAct 與 H_General 兩項的 reverse average。\n")

# ---- Table 3 ----
t3 = find_line(r"^Table 3: Experimental results on Agent-H")
end3 = find_line(r"^## 5 Analysis", t3)
table3 = {}
for r in rows_between(t3 + 1, end3):
    if len(r) == 5 and all(re.fullmatch(r"[\d.]+", x) for x in r[1:]):
        table3[r[0]] = tuple(float(x) for x in r[1:])  # T-Eval, H_ReAct, H_General, H_Score
print(f"Table 3（第 {t3 + 1}–{end3} 行）：")
print(f"  {'Method':<14}{'T-Eval':>8}{'H_ReAct':>9}{'H_General':>11}{'H_Score':>9}")
for m, v in table3.items():
    print(f"  {m:<14}{v[0]:>8}{v[1]:>9}{v[2]:>11}{v[3]:>9}")

TOL = 0.1 + 1e-9
READINGS = {
    "兩項平均 0.5×((100−R)+(100−G))": lambda R, G: 0.5 * ((100 - R) + (100 - G)),
    "式 (1) 字面 100−R": lambda R, G: 100 - R,
    "只用 100−G": lambda R, G: 100 - G,
    "100−max(R,G)": lambda R, G: 100 - max(R, G),
    "100−(R+G)": lambda R, G: 100 - (R + G),
}

print("\n[1][2] 各種讀法重算 H_Score（|重算 − 表值| ≤ 0.1 為相容）：")
fits = {}
for name, fn in READINGS.items():
    cells, ok_rows = [], []
    for m, (_, R, G, H) in table3.items():
        x = fn(R, G)
        ok = abs(x - H) <= TOL
        cells.append(f"{m} {x:.2f}{'✓' if ok else '✗'}")
        if ok:
            ok_rows.append(m)
    fits[name] = ok_rows
    print(f"  {name:<30} " + "  ".join(cells))
print("  各讀法相容的列：")
for name, rows in fits.items():
    print(f"    {name:<30} {len(rows)}/4 {rows}")
any_all4 = [n for n, r in fits.items() if len(r) == 4]
avg_name = "兩項平均 0.5×((100−R)+(100−G))"

_, R, G, H = table3["w/o NS"]
avg = READINGS[avg_name](R, G)
print("\n[3] w/o NS 列：")
print(f"  依子指標重算 = {avg:.2f}（區間 {avg - 0.05:.2f}–{avg + 0.05:.2f}），表值 {H}，差 {avg - H:.2f}")
print(f"  若 84.5 為真，H_ReAct + H_General 應為 {2 * (100 - H):.1f}（表中 {R} + {G} = {R + G:.1f}）")
lit = 100 - R
print(f"  附記（成因假設，未證實）：照式 (1) 字面 100 − H_ReAct 算這一列得 {lit:.1f}，"
      f"與表值 {H} 相差 {abs(lit - H):.1f}，落在容忍 0.1 的邊界內；但同一讀法對不上其他三列。")
flan = table3["Agent-FLAN"][3]
print(f"  負樣本效果：照表值 {flan} − {H} = {flan - H:.2f}；照重算 {flan} − {avg:.2f} = {flan - avg:.2f}")

# ---- Table 1 附帶核對 ----
t1 = find_line(r"^Table 1: Main results of Agent-FLAN")
t1_end = find_line(r"^Experimental Setup", t1)
table1 = {}
for r in rows_between(t1 + 1, t1_end):
    if len(r) == 8 and r[0] != "Model":
        vals = [None if x == "-" else float(x) for x in r[1:]]
        table1[r[0]] = vals  # Held-In, HotpotQA, SciWorld, WebArena, T-Eval, Agent-H, Overall
print(f"\n[4] Table 1（第 {t1 + 1}–{t1_end} 行）：Overall 是否為五個 Held-Out 欄的平均")
# 容忍：四個一位小數欄 ±0.05、WebArena 兩位小數 ±0.005，平均後 ±(4×0.05+0.005)/5，表值再 ±0.05
tol_overall = (4 * 0.05 + 0.005) / 5 + 0.05 + 1e-9
all_overall_ok = True
for m, v in table1.items():
    mean = sum(v[1:6]) / 5
    ok = abs(mean - v[6]) <= tol_overall
    all_overall_ok &= ok
    print(f"  {m:<34} 平均 {mean:.3f}  表值 {v[6]}  {'相容' if ok else '不相容'}")
at_key = next(k for k in table1 if k.startswith("AgentTuning*"))
at = table1[at_key]
for agent_h in (at[5], table3["AgentTuning"][3]):
    mean = (sum(at[1:5]) + agent_h) / 5
    print(f"  AgentTuning* 的 Agent-H 用 {agent_h}：五欄平均 {mean:.3f}，表值 {at[6]}，"
          f"差 {abs(mean - at[6]):.3f}（容忍 {tol_overall:.3f}）→ {'相容' if abs(mean - at[6]) <= tol_overall else '不相容'}")
print(f"  Table 1 AgentTuning* 的 Agent-H = {at[5]}，Table 3 AgentTuning 的 H_Score = {table3['AgentTuning'][3]}；"
      f"T-Eval 兩表都是 {at[4]} / {table3['AgentTuning'][0]}")

print("\n結論：")
print(f"  - 能同時對上四列的讀法：{any_all4 if any_all4 else '沒有'}。")
print(f"  - 「兩項平均」對上 {len(fits[avg_name])}/4 列，唯一對不上的是 w/o NS（重算 {avg:.2f} 對表值 {H}）。")
print("  - 主張寫「算回 Llama2-7B 的 78.65」：重算值是 78.65，表上印的是 78.7，兩者在捨入容忍內相容。")
print(f"  - 負樣本效果 3.65 分只是在「子指標正確、H_Score 印錯」這個前提下成立；")
print("    表格本身分辨不出錯的是 H_Score 還是兩個子指標，所以這一層只能判「可能」。")
single_row = (not any_all4) and fits[avg_name] == [m for m in table3 if m != "w/o NS"]
print(f"  判定：單列不一致{'證實' if single_row else '需人工複核'}；「實際效果約 3.65 分」無法由表格單獨判定。")
