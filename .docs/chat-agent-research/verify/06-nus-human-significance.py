#!/usr/bin/env python3
"""驗證：NUS 真人評估每個策略只有 250 場，差距都不顯著。

主張：
  筆記版：每個策略只有 250 場，差距沒做顯著性檢定，依樣本數推算多半不顯著：N2 對 A1 差 3.4 個百分點，
  兩比例差的標準誤約 2.5 個百分點、z 約 1.4；N1 對 A1、N2 對 N1、A1 對 A2 的 z 都約 0.7，
  都達不到 p<0.05。
  章節修正版（06-user-simulator-feedback.md 第 194 行）：用不合併變異數重算，A1 對 A2 的變異數
  ≈ 0.000767，z ≈ 1.5 / 2.77 ≈ 0.54（比筆記的約 0.7 低）；最大的一對 N2 對 A2 的變異數 ≈ 0.000654，
  z ≈ 4.9 / 2.56 ≈ 1.91，仍未達雙尾 0.05。
出處：[arXiv:1805.06966] 精讀筆記 notes/1805.06966.json 的 limitations_observed 第 1 條。

輸入從哪來（全部由程式直接從 .cache/text/1805.06966.txt 解析，不手抄）：
  - 「Table 4: Real User Evaluation」caption 之前的表格：N1、N2、A1、A2 的 Rew. 與 Suc.。
  - 第 312 行：「1000 dialogues (250 per policy) were gathered」；第 313 行：受試者「randomly allocated」。
  - 第 412 行：「250 dialogues per policy」。
  - 全文檢查有沒有 significan／p-value 字樣。

方法：
  1. 成功次數 = 成功率 × 250。93.4、91.8、88.5 乘 250 都不是整數（233.5、229.5、221.25），
     只有 90.0 是整數（225），所以 N2、N1、A2 三格各取 floor／ceil，共 8 種組合。
  2. 六對都做兩比例 z 檢定（合併與不合併變異數）與 Fisher 精確檢定（雙尾，
     機率 ≤ 觀察值 ×(1+1e-7) 的表加總；math.comb 整數運算）。
  3. 表面值版：直接用表列比例、n=250（不取整），重現筆記與章節的算式。
  4. N 掃描：受試者是隨機分派，每個策略未必剛好 250 場。對每個策略找出 N∈[200,300]（寬）與
     N∈[240,260]（窄）、整數 k 使 round(100k/N, 1) 等於表列值（容差 ±0.05）的所有 (N, k)，
     並要求四個 N 加總 = 1000；六對各報所有可行組合下的最小 p 與跨過 0.05 的組合數。

只用標準函式庫；沒有隨機數。執行：python3 06-nus-human-significance.py
"""

import math
import os
import re
from itertools import combinations, product

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "1805.06966.txt")
ALPHA = 0.05

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


def norm_p2(z):
    return math.erfc(abs(z) / math.sqrt(2))


def z_tests(k1, n1, k2, n2):
    p1, p2 = k1 / n1, k2 / n2
    pp = (k1 + k2) / (n1 + n2)
    se_p = math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2))
    se_u = math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2)
    return (p1 - p2) / se_p, (p1 - p2) / se_u


def fisher_two_sided(a, n1, c, n2):
    K, Ntot = a + c, n1 + n2
    denom = math.comb(Ntot, n1)
    lo, hi = max(0, K - n2), min(K, n1)
    probs = {x: math.comb(K, x) * math.comb(Ntot - K, n1 - x) for x in range(lo, hi + 1)}
    obs = probs[a]
    return sum(v for v in probs.values() if v <= obs * (1 + 1e-7)) / denom


# ---- 解析 Table 4 ----
t4 = find_line(r"^Table 4: Real User Evaluation")
s62 = find_line(r"^### 6\.2 Human Evaluation")
SUC, REW = {}, {}
for r in blocks_between(s62, t4):
    m = re.search(r"\\mathcal\{([NA])\}_\{(\d)\}", r[0])
    if m and len(r) == 3:
        pid = m.group(1) + m.group(2)
        REW[pid], SUC[pid] = float(r[1]), float(r[2])
IDS = ["N2", "N1", "A1", "A2"]
assert set(SUC) == set(IDS), SUC
l312 = find_line(r"1000 dialogues \(250 per policy\) were gathered")
l313 = find_line(r"randomly allocated to one of the four analysed systems")
l412 = find_line(r"Table 4 for 250 dialogues per policy")
N0 = 250
print(f"Table 4（第 {s62 + 1}–{t4 + 1} 行）成功率：{SUC}")
print(f"  第 {l312 + 1} 行：1000 場、每個策略 250 場；第 {l313 + 1} 行：受試者隨機分派；第 {l412 + 1} 行：每個策略 250 場")
sig_lines = [i + 1 for i, s in enumerate(LINES) if re.search(r"signific|p-value|p\s*<|t-test", s, re.I)]
print(f"  全文提到 significan／p-value／t-test 的行：{sig_lines if sig_lines else '沒有'}")

# ---- (1) 成功次數 ----
print(f"\n(1) 成功率 × {N0}")
cand = {}
for pid in IDS:
    x = SUC[pid] * N0 / 100
    fl, cl = math.floor(x + 1e-9), math.ceil(x - 1e-9)
    cand[pid] = sorted({fl, cl})
    print(f"  {pid}: {SUC[pid]}% × {N0} = {x:g}  → 取整候選 {cand[pid]}（{[f'{k / N0:.1%}' for k in cand[pid]]}）")
n_combo = 1
for v in cand.values():
    n_combo *= len(v)
print(f"  共 {n_combo} 種取整組合")

PAIRS = list(combinations(IDS, 2))  # 依成功率高到低排好，差值為正

# ---- (2) 表面值版：重現筆記與章節的算式 ----
print(f"\n(2) 表面值版（表列比例、n={N0}、不取整）")
face = {}
for a, b in PAIRS:
    pa, pb = SUC[a] / 100, SUC[b] / 100
    var_u = pa * (1 - pa) / N0 + pb * (1 - pb) / N0
    pp = (pa + pb) / 2
    var_p = pp * (1 - pp) * 2 / N0
    zu, zp = (pa - pb) / math.sqrt(var_u), (pa - pb) / math.sqrt(var_p)
    face[(a, b)] = (zu, zp)
    print(f"  {a} 對 {b}：差 {100 * (pa - pb):.1f} 點；不合併 var={var_u:.6f} SE={100 * math.sqrt(var_u):.2f} 點 "
          f"z={zu:.3f} p={norm_p2(zu):.4f}；合併 z={zp:.3f} p={norm_p2(zp):.4f}")

print("\n  筆記數字核對：")
note_chk = [
    ("N2 對 A1 的 SE 約 2.5 點", abs(100 * (SUC["N2"] - SUC["A1"]) / 100 / face[("N2", "A1")][0] - 2.5) < 0.05),
    ("N2 對 A1 的 z 約 1.4", abs(face[("N2", "A1")][0] - 1.4) < 0.05),
    ("N1 對 A1 的 z 約 0.7", abs(face[("N1", "A1")][0] - 0.7) < 0.05),
    ("N2 對 N1 的 z 約 0.7", abs(face[("N2", "N1")][0] - 0.7) < 0.05),
    ("A1 對 A2 的 z 約 0.7", abs(face[("A1", "A2")][0] - 0.7) < 0.05),
]
for k, v in note_chk:
    print(f"    {k}：{'成立' if v else '不成立'}")
print(f"    （A1 對 A2 實際 z = {face[('A1', 'A2')][0]:.3f}）")
print("  章節數字核對：")

def chapter_check(a, b, var_ch, se_ch, z_ch):
    """由解析出的 SUC 計算，再與章節第 194 行寫的數字比對。"""
    pa, pb = SUC[a] / 100, SUC[b] / 100
    var = pa * (1 - pa) / N0 + pb * (1 - pb) / N0
    se = 100 * math.sqrt(var)
    diff = SUC[a] - SUC[b]
    z = diff / se
    ok = abs(var - var_ch) < 5e-7 and abs(se - se_ch) < 0.005 and abs(z - z_ch) < 0.01
    print(f"    {a} 對 {b}：差 {diff:.1f}，var = {var:.6f}（章節 ≈ {var_ch}），SE = {se:.2f}（章節 {se_ch}），"
          f"z = {z:.3f}（章節 ≈ {z_ch}），雙尾 p = {norm_p2(z):.4f}；與章節一致：{ok}")
    assert ok
    return z


chapter_check("A1", "A2", 0.000767, 2.77, 0.54)
chapter_check("N2", "A2", 0.000654, 2.56, 1.91)
max_pair = max(PAIRS, key=lambda pr: face[pr][0])
print(f"    表面值下 z 最大的一對：{max_pair[0]} 對 {max_pair[1]}")

# ---- (3) 8 種取整組合 × 六對 × 三種檢定 ----
print(f"\n(3) {n_combo} 種取整組合 × 六對 × 三種檢定（雙尾 p）")
worst = {pr: {"zp": 1.0, "zu": 1.0, "fi": 1.0} for pr in PAIRS}
worst_combo = {pr: {} for pr in PAIRS}
sig_hits = []
for combo in product(*[cand[p] for p in IDS]):
    k = dict(zip(IDS, combo))
    for a, b in PAIRS:
        zp, zu = z_tests(k[a], N0, k[b], N0)
        ps = {"zp": norm_p2(zp), "zu": norm_p2(zu), "fi": fisher_two_sided(k[a], N0, k[b], N0)}
        for t, p in ps.items():
            if p < worst[(a, b)][t]:
                worst[(a, b)][t] = p
                worst_combo[(a, b)][t] = (k[a], k[b])
            if p < ALPHA:
                sig_hits.append((a, b, t, k[a], k[b], p))
print(f"  {'對':10s} {'z 合併 最小 p':>14s} {'z 不合併 最小 p':>16s} {'Fisher 最小 p':>14s}")
for pr in PAIRS:
    w = worst[pr]
    print(f"  {pr[0]} 對 {pr[1]:4s} {w['zp']:14.4f} {w['zu']:16.4f} {w['fi']:14.4f}   "
          f"（z 最極端取整 {worst_combo[pr]['zu']}，Fisher {worst_combo[pr]['fi']}）")
print(f"  跨過雙尾 0.05 的（對, 檢定, 次數）：")
seen = set()
for a, b, t, ka, kb, p in sig_hits:
    key = (a, b, t, ka, kb)
    if key in seen:
        continue
    seen.add(key)
    name = {"zp": "z 合併", "zu": "z 不合併", "fi": "Fisher"}[t]
    print(f"    {a} {ka}/250 對 {b} {kb}/250，{name}，p = {p:.4f}")
if not sig_hits:
    print("    沒有")

# ---- (4) N 掃描 ----
def scan(lo, hi, tag):
    print(f"\n(4{tag}) N 掃描：N∈[{lo},{hi}]、round(100k/N,1) 等於表列值、四個 N 加總 = 1000")
    feas = {}
    for pid in IDS:
        s = SUC[pid]
        feas[pid] = [(n, k) for n in range(lo, hi + 1) for k in range(n + 1)
                     if abs(100 * k / n - s) <= 0.05 + 1e-9]
        ns = sorted({n for n, _ in feas[pid]})
        print(f"  {pid}: 可行 N 有 {len(ns)} 種（{ns[:6]}{' …' if len(ns) > 6 else ''}）；250 在不在裡面：{250 in ns}")
    out = {}
    print(f"  {'對':10s} {'可行組合':>8s} {'z 合併 最小 p':>13s} {'z 不合併 最小 p':>15s} {'Fisher 最小 p':>13s}  p<0.05 組合數（合併／不合併／Fisher）")
    for a, b in PAIRS:
        others = [x for x in IDS if x not in (a, b)]
        sums = {n1 + n2 for (n1, _), (n2, _) in product(feas[others[0]], feas[others[1]])}
        best = {"zp": 1.0, "zu": 1.0, "fi": 1.0}
        cnt = {"zp": 0, "zu": 0, "fi": 0}
        n_ok = 0
        for (na, ka), (nb, kb) in product(feas[a], feas[b]):
            if (1000 - na - nb) not in sums:
                continue
            n_ok += 1
            zp, zu = z_tests(ka, na, kb, nb)
            ps = {"zp": norm_p2(zp), "zu": norm_p2(zu), "fi": fisher_two_sided(ka, na, kb, nb)}
            for t, pv in ps.items():
                best[t] = min(best[t], pv)
                cnt[t] += pv < ALPHA
        out[(a, b)] = (n_ok, best, cnt)
        print(f"  {a} 對 {b:4s} {n_ok:8d} {best['zp']:13.4f} {best['zu']:15.4f} {best['fi']:13.4f}  "
              f"{cnt['zp']}／{cnt['zu']}／{cnt['fi']}")
    return out


SCAN_WIDE = scan(200, 300, "a")
SCAN_NARROW = scan(240, 260, "b")

print("\n結論：")
all_face_ns = all(norm_p2(face[pr][0]) >= ALPHA and norm_p2(face[pr][1]) >= ALPHA for pr in PAIRS)
print(f"  - 表面值版（表列比例、n=250）六對全部未達雙尾 0.05：{all_face_ns}；"
      f"最大的一對 N2 對 A2 z={face[('N2', 'A2')][0]:.2f}、p={norm_p2(face[('N2', 'A2')][0]):.3f}。")
print("  - 筆記：N2 對 A1 z≈1.4、N1 對 A1 z≈0.7、N2 對 N1 z≈0.7 成立；A1 對 A2「約 0.7」不成立（實為約 0.54）。")
print("  - 章節：A1 對 A2 的 0.000767／2.77／0.54 與 N2 對 A2 的 0.000654／2.56／1.91 全部重現。")
print(f"  - 但在 n=250 的 8 種取整組合下，N2 對 A2 的 z 檢定最小 p = {worst[('N2', 'A2')]['zu']:.4f}（不合併）／"
      f"{worst[('N2', 'A2')]['zp']:.4f}（合併），會跨過 0.05；Fisher 最小 p = {worst[('N2', 'A2')]['fi']:.4f}。")
print("    跨過的那個組合是 N2 234/250 = 93.6%，其實重現不了表列的 93.4%。")
print("    「六對全部未達雙尾 0.05」在表面值與 Fisher 下穩健；N2 對 A2 對取整方式與檢定方法敏感，是邊界。")
print("  - 93.4、91.8、88.5 都不能由剛好 250 場整除得到，每個策略的實際場數論文沒交代清楚（受試者是隨機分派）。")
note_pairs = [("N2", "A1"), ("N1", "A1"), ("N2", "N1"), ("A1", "A2")]
robust = all(min(SCAN_WIDE[pr][1].values()) >= ALPHA and min(worst[pr].values()) >= ALPHA for pr in note_pairs)
print(f"  - 筆記點名的四對（N2–A1、N1–A1、N2–N1、A1–A2）在 8 種取整與 N∈[200,300] 掃描下全部未達 0.05：{robust}。")
na = SCAN_NARROW[("N2", "A2")]
print(f"  - N2 對 A2 在 N∈[240,260] 的可行組合裡，z 合併最小 p = {na[1]['zp']:.4f}、Fisher 最小 p = {na[1]['fi']:.4f}"
      f"（z 不合併 {na[1]['zu']:.4f}，{na[2]['zu']}／{na[0]} 個組合跨過）；放寬到 [200,300] 時 Fisher 也有 {SCAN_WIDE[('N2', 'A2')][2]['fi']} 個組合跨過 0.05。")
