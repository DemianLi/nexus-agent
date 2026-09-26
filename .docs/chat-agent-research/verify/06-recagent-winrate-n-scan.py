#!/usr/bin/env python3
"""驗證：RecAgent 生成實驗的 win rate 45.0% 對 33.3%，在什麼樣本數下才會顯著。

主張（章節 06-user-simulator-feedback.md「怎麼評模擬器本身」一節）：
  論文正文稱 RecAgent 的 win rate（45.0%）顯著高於 RecSim（33.3%），但沒寫檢定、也沒寫 n。
  撰寫時推算：若每組是 20 位使用者各由 3 位標註者判斷，27 ÷ 60 = 45.0%、20 ÷ 60 ≈ 33.3%，
  雙比例 z 檢定 z ≈ 1.31、p 約 0.19，並不顯著，而且同一位使用者的 3 次判斷並不獨立。
出處：[arXiv:2306.02552]。

輸入（由程式從 .cache/text/2306.02552.txt 解析）：
  - 「we first sample 20 users」：辨別實驗抽 20 位使用者；生成實驗寫「follow the above experiment settings」。
  - 「we recruit three human annotators to make comparisons on RecAgent v.s. RB and RecSim v.s. RB」。
  - 「the win rate of RecAgent (45.0%) is significantly better than that of RecSim (33.3%)」。

方法：
  1. 掃描每組的獨立判斷數 n = 1…400，找出能讓某個整數 k 使 k ÷ n 四捨五入到一位小數後，
     同時等於 45.0% 與 33.3% 的 n（兩組取同一個 n）。
  2. 每個相容的 n 做兩種雙尾檢定：兩比例 z 檢定（合併變異數）與 Fisher 精確檢定（math.comb 整數運算）。
  3. 找出最小的、p < 0.05 的相容 n；印出 n = 60（20 位 × 3 位，視為彼此獨立）的結果。
  4. 群聚：若同一位使用者的 3 次判斷完全相關，資訊量等於 n = 20；在比例固定為 0.45 與 0.333 時，
     以 z 檢定估算 n = 20 的 p 值，當作另一端的上界情境。
  兩組比的是各自對參考行為（RB）的勝率，不是 RecAgent 與 RecSim 直接對比，所以沒有配對資料可做 McNemar。

只用標準函式庫；沒有隨機數。執行：python3 verify/06-recagent-winrate-n-scan.py（研究根目錄）
"""

import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "2306.02552.txt")
with open(TEXT, encoding="utf-8") as f:
    RAW = f.read()
LINES = RAW.split("\n")


def line_of(pattern):
    rx = re.compile(pattern)
    for i, s in enumerate(LINES):
        m = rx.search(s)
        if m:
            return i + 1, m
    raise SystemExit(f"找不到：{pattern}")


ln_u, m_u = line_of(r"we first sample (\d+) users")
N_USERS = int(m_u.group(1))
ln_a, m_a = line_of(r"we recruit (three) human annotators to make comparisons on RecAgent v\.s\. RB")
N_ANN = {"three": 3}[m_a.group(1)]
ln_w, m_w = line_of(r"win rate of RecAgent \((\d+\.\d)\\?%\) is significantly better than that of RecSim \((\d+\.\d)\\?%\)")
P_A, P_B = float(m_w.group(1)), float(m_w.group(2))
print(f"第 {ln_u} 行：抽 {N_USERS} 位使用者；第 {ln_a} 行：{N_ANN} 位標註者；第 {ln_w} 行：win rate RecAgent {P_A}% 對 RecSim {P_B}%")
print("全文沒有寫生成實驗每組的判斷數，也沒有寫用了什麼檢定。")


def compat_k(p, n):
    return [k for k in range(n + 1) if round(1000 * k / n) == round(p * 10)]


def z_pooled(k1, n1, k2, n2):
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    z = (k1 / n1 - k2 / n2) / se
    return z, math.erfc(abs(z) / math.sqrt(2))


def fisher_two_sided(k1, n1, k2, n2):
    K, N = k1 + k2, n1 + n2
    denom = math.comb(N, K)

    def prob(a):
        return math.comb(n1, a) * math.comb(n2, K - a)

    obs = prob(k1)
    lo, hi = max(0, K - n2), min(K, n1)
    return sum(prob(a) for a in range(lo, hi + 1) if prob(a) <= obs * (1 + 1e-9)) / denom


rows = []
for n in range(1, 401):
    ka, kb = compat_k(P_A, n), compat_k(P_B, n)
    if ka and kb:
        k1, k2 = ka[0], kb[0]
        z, pz = z_pooled(k1, n, k2, n)
        pf = fisher_two_sided(k1, n, k2, n)
        rows.append((n, k1, k2, z, pz, pf))

print(f"\n在 n = 1…400 中，能同時重現 {P_A}% 與 {P_B}% 的 n 共 {len(rows)} 個，最小幾個：")
for n, k1, k2, z, pz, pf in rows[:8]:
    print(f"  n={n:3d}：{k1}/{n} 對 {k2}/{n}，z={z:.2f}，z 檢定 p={pz:.3f}，Fisher p={pf:.3f}")

n60 = [r for r in rows if r[0] == N_USERS * N_ANN]
if n60:
    n, k1, k2, z, pz, pf = n60[0]
    print(f"\nn = {N_USERS} × {N_ANN} = {n}（判斷彼此獨立）：{k1}/{n} 對 {k2}/{n}，z={z:.2f}，z 檢定 p={pz:.3f}，Fisher p={pf:.3f}")
print(f"n = {N_USERS} 是否相容：{'是' if any(r[0] == N_USERS for r in rows) else f'否（{P_B}% × {N_USERS} = {P_B * N_USERS / 100:.2f} 不是整數）'}")

# 群聚的另一端：3 次判斷完全相關，等於只有 20 個獨立單位
pa, pb = P_A / 100, P_B / 100
pp = (pa + pb) / 2
se20 = math.sqrt(pp * (1 - pp) * 2 / N_USERS)
z20 = (pa - pb) / se20
print(f"若同一位使用者的 {N_ANN} 次判斷完全相關（有效 n = {N_USERS}）：z={z20:.2f}，p={math.erfc(abs(z20) / math.sqrt(2)):.3f}")

sig_z = [r for r in rows if r[4] < 0.05]
sig_f = [r for r in rows if r[5] < 0.05]
first_z = sig_z[0][0] if sig_z else None
first_f = sig_f[0][0] if sig_f else None
print(f"\n最小的、z 檢定 p < 0.05 的相容 n：{first_z}；Fisher p < 0.05：{first_f}")
max_design = N_USERS * N_ANN
print(f"\n結論：若生成實驗沿用 {N_USERS} 位使用者、由 {N_ANN} 位標註者各判一次，即使把判斷當成彼此獨立（n = {max_design}），差距仍不顯著；"
      f"每組要有至少 {first_z} 個獨立判斷（Fisher 亦為 {first_f}）才會達到雙尾 0.05，是這個設計最多能提供的 {max_design} 個的兩倍以上。"
      "章節「並不顯著」的判讀在這個前提下證實；論文沒寫 n 與檢定，所以「顯著」的說法無法由全文重現。")
