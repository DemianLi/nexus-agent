#!/usr/bin/env python3
"""驗證：GenTUS 的交叉模型模擬評估與真人試驗排名互相矛盾。

主張（章節 06-user-simulator-feedback.md 第 31、154、227 行）：
  筆記版：Table 5 中 GenTUS 訓練的 DS 列平均 success 約 0.55（0.68／0.43／0.53），是三者最低，
  ABUS-T 訓練的約 0.64；Table 6 真人試驗卻是 GenTUS 訓練的 DS 最高（0.86 對 0.75／0.79），
  交叉模型的模擬評估預測不了真人排名。
  章節收窄版：以 ABUS-T 測（0.78／0.74／0.68）與以 ABUS-S 測（0.63／0.57／0.43）兩欄的順序
  與真人完全相反，只有以 GenTUS 測的那一欄（0.53 對 0.50）不相反。
出處：[arXiv:2208.10817] 精讀筆記 notes/2208.10817.json 的 limitations_observed 第 1 條。

輸入從哪來（全部由程式直接從 .cache/text/2208.10817.txt 解析，不手抄）：
  - 「### 5.4 Cross-model Evaluation」到「Table 5:」caption 之間的表格：3×3 success 矩陣。
  - 第 430–432 行正文的三個差值（15%、28%、17%）：用來釘死「列＝訓練、欄＝測試」的方向。
  - 「### 5.5 Interactive Human Trial」到「Table 6:」caption 之間的表格：三個真人 success。
  - 第 250 行：真人端每種模擬器只挑「在自己訓練模擬器上最好」的策略、每個 DS 300 場。
  - Table 5 caption：每格 400 段 × 5 個 seed = 2K 段。
  - 第 519 行：作者自己說 ABUS-T 與 ABUS-S 的真人差異不顯著。

方法：
  1. 解析兩張表，用正文三個差值確認方向（轉置後三個差值對不上）。
  2. 列平均：含對角線與不含對角線各算一次，看 GenTUS 列是否最低。
  3. 逐欄排序，與真人排序比對，算 Kendall τ（τ = −1 表示完全相反）。
  4. 補充：把真人端（每系統 300 場）與模擬端（每格 2K 段）各自當成獨立二項樣本，
     做兩比例 z 檢定，看「相反」的每一半有沒有統計上撐得住的差距。模擬端忽略 seed 間變異，
     所以算出的標準誤是下限、z 是上限。
  判定「round(x,2)=v」一律以 |x − v| ≤ 0.005 為準。

只用標準函式庫；沒有隨機數。執行：python3 06-gentus-sim-vs-human-rank.py
"""

import math
import os
import re
from itertools import combinations

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "2208.10817.txt")
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
    """回傳 [a, b) 行之間的表格列；每列是一串 cell 字串。"""
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


def norm_sf(z):
    return 0.5 * math.erfc(z / math.sqrt(2))


def two_prop_z(p1, n1, p2, n2):
    pooled = (p1 * n1 + p2 * n2) / (n1 + n2)
    se_p = math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
    se_u = math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2)
    return (p1 - p2) / se_p, (p1 - p2) / se_u


def kendall_tau(xs, ys):
    conc = disc = 0
    for i, j in combinations(range(len(xs)), 2):
        s = (xs[i] - xs[j]) * (ys[i] - ys[j])
        if s > 0:
            conc += 1
        elif s < 0:
            disc += 1
    n = len(xs) * (len(xs) - 1) // 2
    return (conc - disc) / n


US = ["ABUS-T", "ABUS-S", "GenTUS"]

# ---- 解析 Table 5 ----
s54 = find_line(r"^### 5\.4 Cross-model Evaluation")
t5 = find_line(r"^Table 5: The success rates")
M = {}
for row in blocks_between(s54, t5):
    if row[0] in US and len(row) == 4:
        M[row[0]] = [float(x) for x in row[1:]]
hdr = [r for r in blocks_between(s54, t5) if r[0] == "training"][0]
assert hdr[1:] == US, f"Table 5 欄順序不符：{hdr}"
assert set(M) == set(US), f"Table 5 列不齊：{M}"
print(f"Table 5（第 {s54 + 1}–{t5 + 1} 行；列＝訓練用模擬器，欄＝測試用模擬器 {US}）：")
for u in US:
    print(f"  {u:7s} 訓練：{M[u]}")
cap5 = LINES[t5]
m = re.search(r"evaluated by (\d+) dialogues on (\d+) seeds, which is (\d+)K", cap5)
N_SIM = int(m.group(1)) * int(m.group(2))
assert N_SIM == int(m.group(3)) * 1000
print(f"  caption：每格 {m.group(1)} 段 × {m.group(2)} 個 seed = {N_SIM} 段")

# ---- 用正文差值釘死方向 ----
body = " ".join(LINES[s54:t5])
d = [int(x) for x in re.findall(r"\$(\d+)\\%\$ absolute", body)]
print(f"\n正文（第 430–432 行）提到的差值：{d}（%）")
col = {u: i for i, u in enumerate(US)}


def cell(train, test, mat=M):
    return mat[train][col[test]]


checks = [
    ("GenTUS 訓練：ABUS-T 測 − GenTUS 測", cell("GenTUS", "ABUS-T") - cell("GenTUS", "GenTUS"), 0.15),
    ("ABUS-T 訓練：ABUS-T 測 − GenTUS 測", cell("ABUS-T", "ABUS-T") - cell("ABUS-T", "GenTUS"), 0.28),
    ("ABUS-S 訓練：ABUS-T 測 − ABUS-S 測", cell("ABUS-S", "ABUS-T") - cell("ABUS-S", "ABUS-S"), 0.17),
]
assert d == [round(c[2] * 100) for c in checks], f"正文差值與預期不符：{d}"
ok_dir = all(abs(v - e) <= 1e-6 for _, v, e in checks)
MT = {u: [M[v][col[u]] for v in US] for u in US}  # 轉置
ok_T = all(
    abs(v - e) <= 1e-6
    for (_, _, e), v in zip(
        checks,
        [
            cell("GenTUS", "ABUS-T", MT) - cell("GenTUS", "GenTUS", MT),
            cell("ABUS-T", "ABUS-T", MT) - cell("ABUS-T", "GenTUS", MT),
            cell("ABUS-S", "ABUS-T", MT) - cell("ABUS-S", "ABUS-S", MT),
        ],
    )
)
for name, v, e in checks:
    print(f"  {name} = {v:.2f}（正文 {e:.2f}）")
print(f"  列＝訓練的讀法三個差值全對：{ok_dir}；轉置後的讀法全對：{ok_T}")
assert ok_dir and not ok_T

# ---- 解析 Table 6 ----
s55 = find_line(r"^### 5\.5 Interactive Human Trial")
t6 = find_line(r"^Table 6: ")
H = {}
for row in blocks_between(s55, t6):
    if row[0] in US and len(row) == 3:
        H[row[0]] = float(row[1])
assert set(H) == set(US)
m6 = re.search(r"evaluated by (\d+) dialogues", LINES[t6])
N_HUM = int(m6.group(1))
print(f"\nTable 6（第 {s55 + 1}–{t6 + 1} 行）真人 success：{H}，每系統 {N_HUM} 場")
l250 = find_line(r"we select the DS policy performing best on the US it was trained on")
print(f"  第 {l250 + 1} 行：真人端每種模擬器只挑「在自己訓練模擬器上表現最好」的一個策略")
l519 = find_line(r"cannot observe statistically significant differences between ABUS-T and ABUS-S")
print(f"  第 {l519 + 1} 行：作者說 ABUS-T 與 ABUS-S 的真人差異不顯著")

# ---- (1) 列平均 ----
print("\n(1) 列平均")
avg_all = {u: sum(M[u]) / 3 for u in US}
avg_off = {u: sum(M[u][j] for j in range(3) if j != col[u]) / 2 for u in US}
for u in US:
    print(f"  {u:7s} 訓練：含對角 {avg_all[u]:.4f}，不含對角 {avg_off[u]:.4f}")
low_all = min(avg_all, key=avg_all.get)
low_off = min(avg_off, key=avg_off.get)
print(f"  含對角最低：{low_all}；不含對角最低：{low_off}")
print(f"  GenTUS 列含對角 ≈ 0.55：{abs(avg_all['GenTUS'] - 0.55) <= TOL}；"
      f"ABUS-T 列 ≈ 0.64：{abs(avg_all['ABUS-T'] - 0.64) <= TOL}")
print(f"  不含對角時 GenTUS {avg_off['GenTUS']:.3f} 對 ABUS-T {avg_off['ABUS-T']:.3f}，"
      f"只差 {avg_off['ABUS-T'] - avg_off['GenTUS']:.3f}；ABUS-S 變成最高 {avg_off['ABUS-S']:.3f}")

# ---- (2) 逐欄排序對真人 ----
print("\n(2) 逐欄排序與真人排序比對（Kendall τ：+1 一致、−1 完全相反）")
hum_vec = [H[u] for u in US]
hum_order = sorted(US, key=lambda u: -H[u])
print(f"  真人排序：{' > '.join(hum_order)}")
tau_col = {}
for t in US:
    vec = [M[u][col[t]] for u in US]
    order = sorted(US, key=lambda u: -M[u][col[t]])
    tau_col[t] = kendall_tau(vec, hum_vec)
    print(f"  以 {t:7s} 測：{' > '.join(order)}  值 {vec}  τ = {tau_col[t]:+.3f}")
tau_all = kendall_tau([avg_all[u] for u in US], hum_vec)
tau_off = kendall_tau([avg_off[u] for u in US], hum_vec)
print(f"  列平均（含對角）τ = {tau_all:+.3f}；列平均（不含對角）τ = {tau_off:+.3f}")

# ---- (3) 兩邊的差距各自撐不撐得住 ----
print(f"\n(3) 補充：各差距當成獨立二項樣本的兩比例 z 檢定（雙尾）")
print(f"  真人端（每系統 n={N_HUM}；success × n 是否為整數："
      f"{[round(H[u] * N_HUM, 6) for u in US]}）")
for a, b in [("GenTUS", "ABUS-S"), ("GenTUS", "ABUS-T"), ("ABUS-S", "ABUS-T")]:
    zp, zu = two_prop_z(H[a], N_HUM, H[b], N_HUM)
    print(f"    {a} 對 {b}：差 {H[a] - H[b]:+.2f}，z(合併) {zp:.2f} p={2 * norm_sf(abs(zp)):.4f}；"
          f"z(不合併) {zu:.2f} p={2 * norm_sf(abs(zu)):.4f}")
print(f"  模擬端（每格 n={N_SIM}，忽略 seed 間變異，z 是上限）：")
for t in US:
    order = sorted(US, key=lambda u: -M[u][col[t]])
    for a, b in [(order[0], order[1]), (order[1], order[2])]:
        pa, pb = M[a][col[t]], M[b][col[t]]
        zp, zu = two_prop_z(pa, N_SIM, pb, N_SIM)
        print(f"    以 {t} 測：{a} {pa:.2f} 對 {b} {pb:.2f}，z(合併) {zp:.2f} p={2 * norm_sf(abs(zp)):.4f}")

# ---- 結論 ----
print("\n結論：")
print(f"  筆記版「GenTUS 列平均約 0.55 最低、ABUS-T 約 0.64」：證實"
      f"（{avg_all['GenTUS']:.4f} 與 {avg_all['ABUS-T']:.4f}）；不含對角時 GenTUS 仍最低，但只比 ABUS-T 低 0.01。")
print(f"  列平均排序對真人 τ = {tau_all:+.0f}（完全相反），「模擬評估預測不了真人排名」在這三個系統上證實。")
print(f"  章節收窄版：以 ABUS-T、ABUS-S 測的兩欄 τ = {tau_col['ABUS-T']:+.0f}／{tau_col['ABUS-S']:+.0f}（完全相反），證實；"
      f"以 GenTUS 測那欄 τ = {tau_col['GenTUS']:+.3f}，不相反但也不一致（ABUS-T 與 ABUS-S 對調）。")
print("  限制：每欄的三組兩兩比較裡，GenTUS 對兩個 ABUS 的兩組在真人端與模擬端都顯著，反向撐得住；"
      "ABUS-S 對 ABUS-T 那一組的真人差距不顯著（作者自己也這麼說），這一組的「相反」不能當證據。")
print("  另外，以 GenTUS 測那欄 GenTUS 0.53 對 ABUS-T 0.50 的 z 即使忽略 seed 變異也只有約 1.9，"
      "「GenTUS 在自己測試下排第一」本身也不穩。")
