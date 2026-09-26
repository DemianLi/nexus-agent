#!/usr/bin/env python3
"""驗證：TE（Turing Experiment）的 Milgram 模擬 75/100 對人類 26/40，差距是否顯著、檢定力多大。

主張（章節 06-user-simulator-feedback.md「統計」一節）：
  75/100 對 26/40 沒有檢定，精讀時以雙比例 z 檢定粗算 z≈1.19、p≈0.23，撰寫時重算得到相同結果
  （修訂前的章節自承這一輪沒有另寫程式複核）。精讀筆記另說「以 n=100 對 40 的檢定力也不足以宣稱兩者一致」。
出處：[arXiv:2208.10264]，notes/2208.10264.json 的 limitations_observed。

輸入（由程式從 .cache/text/2208.10264.txt 解析）：
  - Figure 7 說明：「26 out of 40 participants」與「75 out of 100 simulated participants」。

方法：
  1. 兩比例 z 檢定：合併變異數與不合併變異數各一次，雙尾 p。
  2. Fisher 精確檢定（math.comb 整數運算），雙尾。
  3. 檢定力：以人類 0.65 為基準、n = 100 對 40、雙尾 α = 0.05、檢定力 80%，
     用常態近似解出模擬端比例要偏離多少才偵測得到（z_{0.975} = 1.95996、z_{0.8} = 0.84162 取常數）。
  中斷點分佈（模擬 25 位中斷者有 18 位在第 20 級、人類 14 位分散在 6 級）不在快取全文的文字裡（在圖上），
  本程式不驗。

只用標準函式庫；沒有隨機數。執行：python3 verify/06-te-milgram-ztest.py（研究根目錄）
"""

import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "2208.10264.txt")
with open(TEXT, encoding="utf-8") as f:
    FLAT = re.sub(r"\s+", " ", f.read())

m = re.search(r"Milgram \(1963\) Experiment 1, (\d+) out of (\d+) participants followed the experimenter’s instructions until the end", FLAT)
kh, nh = int(m.group(1)), int(m.group(2))
m = re.search(r"Milgram Shock TE, (\d+) out of (\d+) simulated participants followed", FLAT)
ks, ns = int(m.group(1)), int(m.group(2))
print(f"Figure 7 說明：人類 {kh}/{nh}，模擬 {ks}/{ns}")

p1, p2 = ks / ns, kh / nh
pp = (ks + kh) / (ns + nh)
se_p = math.sqrt(pp * (1 - pp) * (1 / ns + 1 / nh))
se_u = math.sqrt(p1 * (1 - p1) / ns + p2 * (1 - p2) / nh)
z_p, z_u = (p1 - p2) / se_p, (p1 - p2) / se_u
pv = lambda z: math.erfc(abs(z) / math.sqrt(2))
print(f"合併比例 ({ks} + {kh}) ÷ ({ns} + {nh}) = {pp:.4f}；合併標準誤 {se_p:.4f}；z = {z_p:.3f}，雙尾 p = {pv(z_p):.3f}")
print(f"不合併標準誤 {se_u:.4f}；z = {z_u:.3f}，雙尾 p = {pv(z_u):.3f}")

K, N = ks + kh, ns + nh
den = math.comb(N, K)
prob = lambda a: math.comb(ns, a) * math.comb(nh, K - a)
obs = prob(ks)
pf = sum(prob(a) for a in range(max(0, K - nh), min(K, ns) + 1) if prob(a) <= obs * (1 + 1e-9)) / den
print(f"Fisher 精確檢定雙尾 p = {pf:.3f}")

Z975, Z80 = 1.95996, 0.84162
# 找最小的 |δ| 使 (|δ| ) / se(0.65+δ, 0.65) ≥ Z975 + Z80
def need(sign):
    d = 0.0
    while d < 0.35:
        q = p2 + sign * d
        se = math.sqrt(q * (1 - q) / ns + p2 * (1 - p2) / nh)
        if d / se >= Z975 + Z80:
            return d
        d += 0.0005
    return None
up, dn = need(+1), need(-1)
print(f"檢定力 80%、雙尾 0.05 下，模擬端要偏離人類 {p2:.2f} 至少 +{up:.3f} 或 −{dn:.3f} 才偵測得到；實際差 {p1 - p2:+.3f}")

print(f"\n結論：z = {z_p:.2f}、雙尾 p = {pv(z_p):.2f}（Fisher p = {pf:.2f}），與精讀及撰寫時的 z≈1.19、p≈0.23 相符，證實差距不顯著；"
      f"但這個樣本量要差到約 {up * 100:.0f} 個百分點以上才有八成把握偵測到，所以「不顯著」也不能讀成「模擬與人類一致」。")
