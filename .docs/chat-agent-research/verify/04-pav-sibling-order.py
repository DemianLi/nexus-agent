#!/usr/bin/env python3
"""驗證：Setlur et al. 的 PAV beam search 中，兄弟步驟用有效獎勵排序與只用 Q^π 排序是否完全相同。

主張（章節 04-agent-trajectory.md〈Setlur 的 advantage 證據比篇幅薄〉一條）：
  依 App D 的讀法，BoK 的 Q 值由同一個 Q^π 模型以 1 − (1 − Q^π)^K 換算；從同一個父狀態展開的兄弟步驟共用父項，
  而 q + α(1 − (1 − q)^K) 對 q 嚴格遞增，所以兄弟之間用有效獎勵排序和只用 Q^π 排序完全相同，
  「相對 Q^π beam search 省 8×」只能來自跨父狀態時 beam 名額的重新分配。
出處：[arXiv:2410.08146]。精讀筆記 notes/2410.08146.json 指出 App D 的換算；「兄弟排序不變」是撰寫本章時的推論，
  沒有經過複核，這支程式就是複核。

輸入從哪來（全部由程式直接從 .cache/text/2410.08146.txt 找出原句，不手抄）：
  前提 1：App D 的換算式 Q^{BoK(π)}(s,a) = 1 − (1 − Q^π(s,a))^K。
  前提 2：beam search 在每一步從 beam 裡所有狀態各取 C 個動作，替所有新狀態打分，只保留前 B 名（跨父狀態比較）。
  前提 3：Eq. 2 的 advantage 是差分形 A(s_h,a_h) = Q(s_h,a_h) − Q(s_{h−1},a_{h−1})，父項對兄弟相同。
  前提 4：有效獎勵是 Q^π + α·A^μ，beam search 的 α 取 0.5（2B、9B）與 0.2（27B），prover 是 Bo4(π)，也就是 K = 4。
  衝突句：§4 說「訓練一個 process advantage verifier 預測 A^μ」，與 App D 的換算讀法不同。

方法：
  1. 逐條在全文找出上面五句，印出行號；找不到就停。
  2. 單調性：f(q) = q + α(1 − (1 − q)^K)，導數 1 + αK(1 − q)^(K−1) > 0。另在 q ∈ {0, 1/1000, …, 1} 上以分數
     精確計算，檢查 α ∈ {0.2, 0.5}、K ∈ {1, 2, 4, 8, 16, 32} 時嚴格遞增（涵蓋 §4 掃過的 K 範圍）。
     步驟 3、4 只是示範，改用浮點數以求在十秒內跑完。
  3. 兄弟排序：在 q 的格點（0, 0.05, …, 1）上窮舉三個兄弟的所有組合、父項取 0 到 1 的格點，
     比較依有效獎勵與依 q 的排序是否相同。
  4. 跨父狀態：窮舉兩個父狀態各兩個子步驟、B = 2 的情形，找出依有效獎勵與依 q 選出的 beam 不同的例子，
     證明差別確實存在、而且只可能出現在跨父狀態的比較。

只用標準函式庫；沒有隨機數。執行：python3 04-pav-sibling-order.py（從任何目錄都可以）
"""

import os
import re
from fractions import Fraction as F
from itertools import product

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "2410.08146.txt")
with open(TEXT, encoding="utf-8") as f:
    RAW = f.read()


def where(pattern, label):
    m = re.search(pattern, RAW, re.S)
    if not m:
        raise SystemExit(f"找不到{label}：{pattern}")
    ln = RAW[:m.start()].count("\n") + 1
    snippet = re.sub(r"\s+", " ", m.group(0))[:110]
    print(f"    第 {ln} 行 {label}：{snippet}")
    return ln


print("[1] 前提在全文中的位置")
where(r"Q\^\{\\mathrm\{BoK\}\(\\pi\)\}\(\\mathbf\{s\},a\)=1-\(1-Q\^\{\\pi\}\(\\mathbf\{s\},a\)\)\^\{K\}", "前提 1（App D 換算式）")
where(r"Process rewards from PRMs assign a score to every new state.{0,120}?only the states\s+corresponding to the top \$B\$ values are retained", "前提 2（跨父狀態取前 B 名）")
where(r"A\^\{\\pi\}\(\\mathbf\{s\}_\{h\},a_\{h\}\)\\coloneqq Q\^\{\\pi\}\(\\mathbf\{s\}_\{h\},a_\{h\}\)-V\^\{\\pi\}\(\\mathbf\{s\}_\{h\}\)=Q\^\{\\pi\}\(\\mathbf\{s\}_\{h\},a_\{h\}\)-Q\^\{\\pi\}\(\\mathbf\{s\}_\{h-1\},a_\{h-1\}\)", "前提 3（Eq. 2 差分形）")
where(r"\\alpha=0\.5\$ worked best for Gemma 2B and 9B base policies, while a lower value of \$\\alpha=0\.2\$ was optimal for\s+Gemma 27B", "前提 4a（beam search 的 α）")
where(r"We use \$\\mathrm\{BoK\}\(\\pi\)\$ with \$K=4\$ as the prover policy for all base policies", "前提 4b（K = 4）")
where(r"we train a process advantage verifier to predict\s+\$A\^\{\\mu\}\$ , along with a process reward model \$Q\^\{\\pi\}\$", "衝突句（§4 另訓 PAV）")

# ---- 單調性 ----
print("\n[2] f(q) = q + α(1 − (1 − q)^K) 在 q 格點上是否嚴格遞增（分數精確計算）")
grid = [F(i, 1000) for i in range(1001)]
mono_ok = True
for a in (F(1, 5), F(1, 2)):
    for K in (1, 2, 4, 8, 16, 32):
        vals = [q + a * (1 - (1 - q) ** K) for q in grid]
        ok = all(vals[i] < vals[i + 1] for i in range(len(vals) - 1))
        mono_ok &= ok
    print(f"    α = {a}：K ∈ {{1, 2, 4, 8, 16, 32}} 全部嚴格遞增 = {mono_ok}")
print("    （解析上：導數 1 + αK(1 − q)^(K−1) 在 α ≥ 0 時恆大於 0，格點檢查只是確認沒有寫錯式子）")


def eff(q, parent_q, a, K):
    qmu = lambda x: 1 - (1 - x) ** K
    return q + a * (qmu(q) - qmu(parent_q))


# ---- 兄弟排序 ----
print("\n[3] 兄弟步驟（共用父狀態）的排序：有效獎勵 對 只用 Q^π")
g = [i / 20 for i in range(21)]  # 步驟 3、4 用浮點數即可（步驟 2 已用分數確認嚴格遞增）
checked = diff = 0
for a in (0.2, 0.5):
    for K in (4,):
        for parent in g:
            for trio in product(g, repeat=3):
                if len(set(trio)) < 3:
                    continue
                by_q = sorted(range(3), key=lambda i: trio[i])
                by_e = sorted(range(3), key=lambda i: eff(trio[i], parent, a, K))
                checked += 1
                diff += by_q != by_e
print(f"    檢查 {checked} 組（α ∈ {{0.2, 0.5}}、K = 4、父項 21 個格點、兄弟三個互異 q），排序不同的組數 = {diff}")

# ---- 跨父狀態 ----
print("\n[4] 跨父狀態（兩個父狀態各兩個子步驟、B = 2）：兩種打分選出的 beam 是否可能不同")
example = None
a, K = 0.5, 4
for p1, p2 in product(g, repeat=2):
    if p1 >= p2:
        continue
    for c11, c12, c21, c22 in product(g[::2], repeat=4):
        kids = [(1, c11, p1), (1, c12, p1), (2, c21, p2), (2, c22, p2)]
        qs = [k[1] for k in kids]
        es = [eff(k[1], k[2], a, K) for k in kids]
        if len(set(qs)) < 4 or len(set(es)) < 4:
            continue
        # 讓例子合理：父狀態的值 V(s) = E_a Q(s,a)，應落在它兩個子步驟的 Q 之間
        if not (min(c11, c12) <= p1 <= max(c11, c12) and min(c21, c22) <= p2 <= max(c21, c22)):
            continue
        top_q = set(sorted(range(4), key=lambda i: -qs[i])[:2])
        top_e = set(sorted(range(4), key=lambda i: -es[i])[:2])
        if top_q != top_e:
            example = (p1, p2, kids, qs, es, top_q, top_e)
            break
    if example:
        break
if example:
    p1, p2, kids, qs, es, top_q, top_e = example
    print(f"    α = 1/2、K = 4、父狀態 Q^π：s1 = {float(p1):.2f}、s2 = {float(p2):.2f}")
    for i, (par, q, _) in enumerate(kids):
        print(f"      子步驟 {i}（父 s{par}）：Q^π = {float(q):.2f}，有效獎勵 = {float(es[i]):.4f}")
    print(f"    只用 Q^π 選 {sorted(top_q)}，用有效獎勵選 {sorted(top_e)}")

print("\n結論：")
ok = mono_ok and diff == 0 and example is not None
print(f"  - 四個前提都在全文找到；在 App D 的讀法下，兄弟之間的排序與只用 Q^π 完全相同（{checked} 組中 {diff} 組不同）。")
print("  - 兩種打分只在跨父狀態比較時選出不同的 beam，所以「相對 Q^π beam search 省 8×」只能來自 beam 名額在父狀態之間的重新分配。")
print("  - 但 §4 同時寫「另訓一個 PAV 預測 A^μ」；若實驗用的是那個獨立模型，兄弟排序就不必相同，這個結論只在 App D 的讀法下成立。")
print(f"  判定：{'在 App D 讀法下證實' if ok else '需人工複核'}")
