#!/usr/bin/env python3
"""驗證：pass@k 與 pass^k 是同一個估計式的兩面，以及 1909.03004 的 Eq. 8 代入 0/1 後的形式與偏誤。

主張（章節 08-task-completion-score.md「問題的演進」的「pass@k 與 pass^k 是同一個估計式的兩面」、
τ-bench 段落、1909.03004 段落與陷阱四「拿有放回抽樣估 best-of-n」）：
  1. τ-bench 的 pass^k = E[C(c,k)/C(n,k)]、pass@k = 1 − E[C(n−c,k)/C(n,k)]，k=1 時兩者相等。
  2. 兩個式子都是無偏估計（τ-bench 與 Codex 都這樣稱）。
  3. pass@k 等於「把 pass^k 套在失敗次數上」再取補數，所以兩者是同一個估計式的兩面（組章時的說法）。
  4. 1909.03004 的 Eq. 8 代入 0/1 成敗、N 次中成功 c 次時，化成 1−(1−c/N)^n（精讀時推導）。
  5. 這個式子就是 Codex 附錄點名會低估 pass@k 的那個式子，偏誤是負的（Codex 附錄 A；精讀時指出）。
  6. trivial agent 是決定性的，所以它的分數對任何 k 的 pass^k 與 pass@k 都一樣（ABC 段落）。
  另外檢查 Codex 對先前做法的描述：Kulal et al.（2019）每題只生成 k 個樣本、看有沒有一個對，
  Codex 說那種經驗估計無偏，但變異高。

出處：[arXiv:2406.12045] 全文的 pass^k 定義；[arXiv:2107.03374] 全文的無偏估計式、Kulal et al.
  的描述與附錄 A；[arXiv:1909.03004] 全文的 Eq. 6–8；notes/1909.03004.json 的 limitations_observed
  （Eq. 8 化簡）。

方法：
  - 先從 .cache/text 找出三篇的原文公式並印出行號，確認驗的式子與論文寫的一致。
  - 全部用 fractions.Fraction 做精確有理數運算，不用浮點近似：
    (a) 恆等式：對 1≤n≤30、0≤c≤n、1≤k≤n，逐一檢查 pass@k(n,c,k) == 1 − pass^k(n, n−c, k)，
        以及 k=1 時兩者都等於 c/n。
    (b) 無偏性：c ~ Binomial(n, p)，p ∈ {1/10, 1/4, 1/3, 1/2, 2/3, 9/10}，1≤k≤n≤14，
        精確算 E[C(c,k)/C(n,k)] 是否等於 p^k、E[1−C(n−c,k)/C(n,k)] 是否等於 1−(1−p)^k。
    (c) Eq. 8：照原文 Σ_v v·(P̂(V≤v)^n − P̂(V<v)^n) 實作，餵 N−c 個 0 與 c 個 1，
        檢查是否等於 1−(1−c/N)^n（1≤N≤30、0≤c≤N、1≤n≤30）。
    (d) 偏誤：同一組 (N, c, n≤N)，逐點比較 1−(1−c/N)^n 與無偏式 1−C(N−c,n)/C(N,n)；
        再對 c ~ Binomial(N, p) 取期望，算 E[1−(1−c/N)^n] − (1−(1−p)^n)。
    (e) Kulal 式的變異：每題只抽 k 個樣本、看有沒有一個對，這個指標是無偏的，變異是 q(1−q)，
        q = 1−(1−p)^k；和「抽 n 個、用無偏式」的精確變異比較。
    (f) 決定性 agent：c 只能是 0 或 n 時，pass^k 與 pass@k 對任何 k 都等於同一個 0/1。

只用標準函式庫；沒有隨機數。執行：python3 verify/08-passk-estimators.py
"""

import os
import re
from fractions import Fraction as F
from math import comb

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")


def lines_of(pid):
    with open(os.path.join(ROOT, ".cache", "text", pid + ".txt"), encoding="utf-8") as f:
        return f.read().split("\n")


def show(pid, pattern, width=230):
    ls = lines_of(pid)
    for i, s in enumerate(ls):
        if re.search(pattern, s):
            print(f"  [{pid} 第 {i + 1} 行] {s.strip()[:width]}")
            return i
    raise SystemExit(f"找不到原文：{pid} /{pattern}/")


print("== 原文錨點 ==")
show("2406.12045", r"pass\\textasciicircum k\}=\\mathbb\{E\}")
show("2406.12045", r"pass\^1=pass@1")
show("2107.03374", r"^Kulal et al\. \(2019\) evaluate functional correctness")
show("2107.03374", r"computing pass@ \$k\$ in this way can have high variance")
show("2107.03374", r"binom\{n-c\}\{k\}")
show("2107.03374", r"only the empirical estimate used by Kulal")
show("2107.03374", r"consistent underestimate")
show("1909.03004", r"hat\{\\E\}\[V\^\{\\ast\}_\{n\}")


# ---------------------------------------------------------------- 定義
def pass_hat_k(n, c, k):
    """τ-bench 的 pass^k 單題估計：C(c,k)/C(n,k)。"""
    return F(comb(c, k), comb(n, k))


def pass_at_k(n, c, k):
    """τ-bench／Codex 的 pass@k 單題估計：1 − C(n−c,k)/C(n,k)。"""
    return 1 - F(comb(n - c, k), comb(n, k))


def binom_pmf(n, p):
    return [comb(n, c) * p ** c * (1 - p) ** (n - c) for c in range(n + 1)]


# ---------------------------------------------------------------- (a) 恆等式
bad_id = bad_k1 = checked = 0
for n in range(1, 31):
    for c in range(n + 1):
        for k in range(1, n + 1):
            checked += 1
            if pass_at_k(n, c, k) != 1 - pass_hat_k(n, n - c, k):
                bad_id += 1
        if not (pass_hat_k(n, c, 1) == pass_at_k(n, c, 1) == F(c, n)):
            bad_k1 += 1
print(f"\n== (a) 恆等式（1≤n≤30、0≤c≤n、1≤k≤n，共 {checked} 組）==")
print(f"  pass@k(n,c,k) ≠ 1 − pass^k(n, n−c, k) 的組數：{bad_id}")
print(f"  k=1 時 pass^1 ≠ pass@1 ≠ c/n 的組數：{bad_k1}")
ok_a = bad_id == 0 and bad_k1 == 0

# ---------------------------------------------------------------- (b) 無偏性
PS = [F(1, 10), F(1, 4), F(1, 3), F(1, 2), F(2, 3), F(9, 10)]
bad_hat = bad_at = cnt_b = 0
for p in PS:
    for n in range(1, 15):
        pmf = binom_pmf(n, p)
        for k in range(1, n + 1):
            cnt_b += 1
            e_hat = sum(pmf[c] * pass_hat_k(n, c, k) for c in range(n + 1))
            e_at = sum(pmf[c] * pass_at_k(n, c, k) for c in range(n + 1))
            bad_hat += e_hat != p ** k
            bad_at += e_at != 1 - (1 - p) ** k
print(f"\n== (b) 無偏性（6 個 p × 1≤k≤n≤14，共 {cnt_b} 組，精確有理數）==")
print(f"  E[C(c,k)/C(n,k)] ≠ p^k 的組數：{bad_hat}")
print(f"  E[1−C(n−c,k)/C(n,k)] ≠ 1−(1−p)^k 的組數：{bad_at}")
ok_b = bad_hat == 0 and bad_at == 0


# ---------------------------------------------------------------- (c) Eq. 8
def eq8(values, n):
    """1909.03004 Eq. 8：Σ_v v·(P̂(V≤v)^n − P̂(V<v)^n)，P̂ 是 N 點的經驗 CDF（Eq. 7）。"""
    N = len(values)
    total = F(0)
    for v in sorted(set(values)):
        le = F(sum(1 for x in values if x <= v), N)
        lt = F(sum(1 for x in values if x < v), N)
        total += v * (le ** n - lt ** n)
    return total


bad_c = cnt_c = 0
for N in range(1, 31):
    for c in range(N + 1):
        vals = [0] * (N - c) + [1] * c
        for n in range(1, 31):
            cnt_c += 1
            if eq8(vals, n) != 1 - (1 - F(c, N)) ** n:
                bad_c += 1
print(f"\n== (c) Eq. 8 代入 0/1（1≤N≤30、0≤c≤N、1≤n≤30，共 {cnt_c} 組）==")
print(f"  Eq. 8 ≠ 1−(1−c/N)^n 的組數：{bad_c}")
ok_c = bad_c == 0

# ---------------------------------------------------------------- (d) 偏誤
above = strict = cnt_d = 0
for N in range(1, 31):
    for c in range(N + 1):
        for n in range(1, N + 1):
            cnt_d += 1
            plug = 1 - (1 - F(c, N)) ** n
            unb = pass_at_k(N, c, n)
            above += plug > unb
            strict += plug < unb
print(f"\n== (d) 偏誤（1≤n≤N≤30、0≤c≤N，共 {cnt_d} 組，逐點比較）==")
print(f"  1−(1−c/N)^n 高於無偏式 1−C(N−c,n)/C(N,n) 的組數：{above}")
print(f"  嚴格低於無偏式的組數：{strict}（其餘相等：n=1、c=0 或 c=N 等情形）")
worst = None
for N in (10, 20, 30):
    for p in (F(1, 10), F(3, 10), F(1, 2)):
        pmf = binom_pmf(N, p)
        for n in (1, 2, 5, N // 2, N):
            bias = sum(pmf[c] * (1 - (1 - F(c, N)) ** n) for c in range(N + 1)) - (1 - (1 - p) ** n)
            if bias > 0:
                raise SystemExit(f"反例：N={N} p={p} n={n} bias={float(bias)}")
            if worst is None or bias < worst[0]:
                worst = (bias, N, p, n)
print(f"  對 c ~ Bin(N,p) 取期望後，45 組 (N,p,n) 的偏誤全部 ≤ 0；最負的是 N={worst[1]}、p={worst[2]}、"
      f"n={worst[3]}：E[估計] − 真值 = {float(worst[0]):+.4f}")
ex = {}
for k, n in ((10, 51), (10, 101), (10, 201)):
    p = F(1, 10)
    pmf = binom_pmf(n, p)
    e = sum(pmf[c] * (1 - (1 - F(c, n)) ** k) for c in range(n + 1))
    ex[n] = float(e - (1 - (1 - p) ** k))
print("  Codex 附錄說 n>5k 時差距也沒有完全消失：p=0.1、k=10 時，"
      + "、".join(f"n={n} 的偏誤 {b:+.4f}" for n, b in ex.items()))
ok_d = above == 0 and all(b < 0 for b in ex.values())

# ---------------------------------------------------------------- (e) Kulal 式的變異
print("\n== (e) 每題只抽 k 個（Kulal 式）與抽 n 個用無偏式的變異 ==")
rows_e = []
for p in (F(1, 10), F(3, 10), F(1, 2)):
    for k, n in ((1, 10), (5, 50), (10, 100)):
        q = 1 - (1 - p) ** k
        var_kulal = q * (1 - q)
        pmf = binom_pmf(n, p)
        m1 = sum(pmf[c] * pass_at_k(n, c, k) for c in range(n + 1))
        m2 = sum(pmf[c] * pass_at_k(n, c, k) ** 2 for c in range(n + 1))
        var_unb = m2 - m1 ** 2
        rows_e.append((p, k, n, float(var_kulal), float(var_unb), m1 == q))
        print(f"  p={str(p):>5} k={k:>2} n={n:>3}：Kulal 式變異 {float(var_kulal):.4f}，"
              f"n 樣本無偏式變異 {float(var_unb):.4f}，無偏式期望等於 q：{m1 == q}")
ok_e = all(r[4] <= r[3] and r[5] for r in rows_e)

# ---------------------------------------------------------------- (f) 決定性 agent
bad_f = 0
for n in range(1, 31):
    for c in (0, n):
        for k in range(1, n + 1):
            v = F(1 if c == n else 0)
            bad_f += not (pass_hat_k(n, c, k) == pass_at_k(n, c, k) == v)
print(f"\n== (f) 決定性 agent（c 只能是 0 或 n）==\n  pass^k 或 pass@k 不等於同一個 0/1 的組數：{bad_f}")
ok_f = bad_f == 0

print("\n== 結論 ==")
print(f"  (a) pass@k = 1 − pass^k（套在失敗次數上），k=1 時兩者相等：{'證實' if ok_a else '推翻'}")
print(f"  (b) 兩個估計式都無偏：{'證實' if ok_b else '推翻'}")
print(f"  (c) Eq. 8 代入 0/1 等於 1−(1−c/N)^n：{'證實' if ok_c else '推翻'}")
print(f"  (d) 1−(1−c/N)^n 相對無偏式是負偏誤，n>5k 仍未消失：{'證實' if ok_d else '推翻'}")
print(f"  (e) Kulal 式無偏但變異較高（n 樣本無偏式的變異都不大於它）：{'證實' if ok_e else '推翻'}")
print(f"  (f) 決定性 agent 的 pass^k 與 pass@k 對任何 k 都相同：{'證實' if ok_f else '推翻'}")
allok = all((ok_a, ok_b, ok_c, ok_d, ok_e, ok_f))
print(f"結論：{'證實' if allok else '部分推翻'}——pass@k 與 pass^k 是同一個無偏估計式的兩面，"
      f"Eq. 8 的 0/1 形式就是 Codex 點名的負偏誤式")
