#!/usr/bin/env python3
"""驗證：SWE-agent 消融差距的顯著性，以及論文自報標準差 0.49 與變異下界是否對得上。

主張（章節 03-agent-observation.md 第 295 行）：
  (3a) 在 [0,1] 上 5p(1−p) ≥ 1−(1−p)^6−p；因此若每題每次以固定機率 p_i 獨立解出，單次解題數 X 的變異
       Var(X)=Σp_i(1−p_i) ≥ (E[pass@6 題數] − E[X]) / 5。
  (3b) 代入 Table 10 的 pass@1 17.94% 與 pass@6 32.67%（單次觀測值，不是期望值），下界是
       (32.67×3 − 17.94×3)/5 ≈ 8.84，標準差至少約 3 題、約 1 個百分點。
  (3c) 在這個模型下，無示範那一格的 1.7 個百分點不到 2 個標準差（z≈1.72），不顯著；無搜尋與完整歷史兩格要看
       消融設定的變異假設。
  (3d) 論文自報六次執行的標準差 0.49 點低於這個下界。
  (3e) 兩者對不上（自報變異與獨立解題的模型矛盾）。
  出處：[arXiv:2405.15793] notes/2405.15793.json 的 limitations_observed 第 1 條（1.7／2.3 點未必顯著）；
        (3a)–(3e) 的下界分析是章節綜合階段加的，不是筆記欄位。

輸入從哪來（全部由本程式從 .cache/text/2405.15793.txt 解析，輸出附行號）：
  - Table 10（錨點「Table 10:」，§B.5）：六次執行的 Resolve %、Avg. 欄（全文轉換把「17.94±0.49」黏成
    「17.940.49」，本程式依兩位小數拆開）、Pass@1..Pass@6。
  - Table 3（錨點「Table 3:」接「SWE-bench Lite performance under ablations」）：各消融格的 % Resolved 與下降值。
  - SWE-bench Lite 題數 300：§5 原句「18.00 % ( 54 / 300 ) of the Lite」。

隨機數：(3e) 的模擬用 random.Random(20260926)，20,000 次、每次 6 回，數秒內跑完。
只用標準函式庫。
"""

import math
import random
import re
import statistics
import sys
from collections import Counter
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TXT = ROOT / ".cache" / "text" / "2405.15793.txt"
SEED = 20260926
N_SIM = 20000


def cells_after(lines, start, first_cell):
    """從 start 往後找以 '| first_cell' 開頭的一組表格列，回傳 (行號, cells)。"""
    for i in range(start, len(lines)):
        if lines[i].startswith("|") and lines[i][1:].strip() == first_cell:
            cells, j = [], i
            while j < len(lines) and lines[j].startswith("|"):
                cells.append(lines[j][1:].strip())
                j += 1
            return i + 1, cells
    raise AssertionError(f"找不到以 {first_cell!r} 開頭的列")


def chi2_5_cdf(x):
    """自由度 5 的卡方分配 CDF（奇數自由度的封閉式）。"""
    return math.erf(math.sqrt(x / 2)) - math.sqrt(2 * x / math.pi) * math.exp(-x / 2) * (1 + x / 3)


def chi2_5_cdf_numeric(x, steps=20000):
    """用 Simpson 法積分 pdf 交叉檢查封閉式。"""
    k = 5
    c = 1 / (2 ** (k / 2) * math.gamma(k / 2))
    f = lambda t: c * t ** (k / 2 - 1) * math.exp(-t / 2) if t > 0 else 0.0
    h = x / steps
    s = f(0) + f(x) + sum((4 if i % 2 else 2) * f(i * h) for i in range(1, steps))
    return s * h / 3


def main():
    lines = TXT.read_text(encoding="utf-8").splitlines()

    # ---------- 題數 ----------
    lite = [(i + 1, s) for i, s in enumerate(lines) if re.search(r"\(\s*\$54\$\s*/\s*\$300\$\s*\) of the Lite", s)]
    assert len(lite) == 1
    N = 300
    print(f"[§5 第 {lite[0][0]} 行] SWE-bench Lite 題數 N = {N}")

    # ---------- Table 10 ----------
    t10 = [i for i, s in enumerate(lines) if s.strip() == "Table 10:"]
    assert len(t10) == 1
    assert "6 separate runs of SWE-agent with GPT-4 on SWE-bench Lite" in lines[t10[0] + 1]
    ln_r, rc = cells_after(lines, t10[0], "Resolve %")
    ln_h, hc = cells_after(lines, t10[0], "")
    assert rc[0] == "Resolve %" and len(rc) == 8, rc
    runs = [Fraction(x) for x in rc[1:7]]
    m = re.fullmatch(r"(\d+\.\d{2})(\d+\.\d{2})", rc[7])
    assert m, f"Avg. 欄格式不符：{rc[7]!r}"
    avg_rep, sd_rep = Fraction(m.group(1)), Fraction(m.group(2))
    ln_k, kc = cells_after(lines, t10[0], "Pass $@$ k")
    assert len(kc) == 7
    passk = [Fraction(x) for x in kc[1:]]
    print(f"[Table 10 第 {ln_r} 行] 六次 Resolve % = {[float(r) for r in runs]}，Avg. 欄原文 {rc[7]!r} → "
          f"{float(avg_rep)} ± {float(sd_rep)}")
    print(f"[Table 10 第 {ln_k} 行] Pass@1..6 = {[float(p) for p in passk]}")

    counts = []
    for r in runs:
        k = [c for c in range(N + 1) if round(c * 10000 / N) == round(r * 100)]
        assert len(k) == 1, f"{r} 不在 1/300 格點上"
        counts.append(k[0])
    k6 = [c for c in range(N + 1) if round(c * 10000 / N) == round(passk[5] * 100)]
    assert len(k6) == 1
    P6 = k6[0]
    mean_c = Fraction(sum(counts), 6)
    print(f"  換成題數：六次 = {counts}，平均 {float(mean_c):.4f} 題（= {float(mean_c * 100 / N):.4f}%，表 "
          f"{float(avg_rep)}）；pass@6 = {P6} 題")
    assert abs(float(mean_c * 100 / N) - float(avg_rep)) < 0.005
    assert abs(float(passk[0]) - float(avg_rep)) < 1e-9, "Pass@1 應等於六次平均"

    # ---------- (3a) 不等式 ----------
    print("\n== (3a) 5p(1−p) ≥ 1−(1−p)^6−p 在 [0,1] 上成立 ==")
    grid = 10000
    min_g, argmin, zeros, fact_ok = None, None, [], True
    for i in range(grid + 1):
        p = Fraction(i, grid)
        g = 5 * p * (1 - p) - (1 - (1 - p) ** 6 - p)
        # 代數分解：g = (1−p)·[5p − 1 + (1−p)^5]，方括號即 Bernoulli 不等式 (1−p)^5 ≥ 1−5p
        fact_ok &= g == (1 - p) * (5 * p - 1 + (1 - p) ** 5)
        if min_g is None or g < min_g:
            min_g, argmin = g, p
        if g == 0:
            zeros.append(float(p))
    print(f"  格點 p = k/{grid}（Fraction 精確計算）：min(LHS−RHS) = {float(min_g)}，發生在 p = {float(argmin)}；"
          f"等號只在 p ∈ {zeros}")
    print(f"  代數分解 LHS−RHS = (1−p)[5p−1+(1−p)^5] 在所有格點上精確成立：{fact_ok}")
    for p in (Fraction(1, 100), Fraction(1, 10), Fraction(1, 2), Fraction(9, 10)):
        lhs, rhs = 5 * p * (1 - p), 1 - (1 - p) ** 6 - p
        print(f"    p={float(p):<5} 5p(1−p)={float(lhs):.4f}  1−(1−p)^6−p={float(rhs):.4f}  比值 {float(lhs / rhs):.3f}")
    assert min_g >= 0 and fact_ok
    print("  → 成立；只在 p→0 時接近等號，p 居中時下界很鬆（真實變異只會更大）。")

    # ---------- (3b) 下界 ----------
    print("\n== (3b) 單次解題數的變異下界 ==")
    lb_chapter = (passk[5] * 3 - passk[0] * 3) / 5
    lb_counts = (P6 - mean_c) / 5
    sd_lb = math.sqrt(float(lb_counts))
    print(f"  章節算式 (32.67×3 − 17.94×3)/5 = {float(lb_chapter):.4f}")
    print(f"  用整數題數 ({P6} − {float(mean_c):.4f})/5 = {float(lb_counts):.4f} 題²")
    print(f"  標準差下界 = {sd_lb:.3f} 題 = {sd_lb * 100 / N:.3f} 個百分點")
    assert round(float(lb_chapter), 2) == 8.84

    # ---------- (3c) 消融差距 ----------
    print("\n== (3c) 消融差距對應的 z 值 ==")
    t3 = [i for i, s in enumerate(lines) if s.strip() == "Table 3:"
          and lines[i + 1].startswith("SWE-bench Lite performance under ablations")]
    assert len(t3) == 1
    abl = {}
    for name in ("Last 5 Obs.", "w/o demo.", "No search", "Full history"):
        ln, c = cells_after(lines, t3[0], name)
        mm = re.fullmatch(r"(\d+\.\d)(?: \$\\downarrow\$ (\d+\.\d))?", c[1])
        assert mm, c
        abl[name] = (ln, float(mm.group(1)), float(mm.group(2)) if mm.group(2) else None)
    base = abl["Last 5 Obs."][1]
    sd_pp = sd_lb * 100 / N
    print(f"  [Table 3] 基準（Last 5 Obs.）{base}（第 {abl['Last 5 Obs.'][0]} 行）")
    print(f"  {'格':<14}{'值':>6}{'差':>6}{'題數':>6}{'z≤(只用基準變異)':>18}{'z≤(兩邊都≥下界)':>18}{'要 z<2 時消融變異至少':>22}")
    for name in ("w/o demo.", "No search", "Full history"):
        ln, v, drop = abl[name]
        assert abs((base - v) - drop) < 1e-9, f"{name} 的下降值與相減不符"
        z1 = drop / sd_pp
        z2 = drop / (sd_pp * math.sqrt(2))
        need = (drop * N / 100 / 2) ** 2 - float(lb_counts)
        print(f"  {name:<14}{v:>6}{drop:>6}{drop * 3:>6.1f}{z1:>18.2f}{z2:>18.2f}{max(need, 0):>18.2f} 題²"
              f"  (第 {ln} 行)")
    print("  說明：Var(差) = Var(基準) + Var(消融) ≥ 下界，所以「只用基準變異」那欄是 z 的上界，不需要任何消融變異的假設。")
    print("  → 1.7 點：z ≤ 1.72 < 2，無論消融變異多少都不到 2 個標準差；2.3 與 3.0 點要看消融變異。")

    # ---------- (3d) 自報標準差 ----------
    print("\n== (3d)(3e) 自報標準差 0.49 與下界 ==")
    runs_f = [float(r) for r in runs]
    sd_pop = statistics.pstdev(runs_f)
    sd_smp = statistics.stdev(runs_f)
    print(f"  六次 Resolve % 的母體標準差（÷6）= {sd_pop:.4f}，樣本標準差（÷5）= {sd_smp:.4f}；論文 {float(sd_rep)}"
          f" → 論文用的是母體標準差")
    print(f"  點估計：{float(sd_rep)} 點 < 下界 {sd_pp:.3f} 點，比值 {float(sd_rep) / sd_pp:.3f}")
    ss = float(sum((c - mean_c) ** 2 for c in counts))
    stat = ss / float(lb_counts)
    p_closed = chi2_5_cdf(stat)
    p_num = chi2_5_cdf_numeric(stat)
    assert abs(p_closed - p_num) < 1e-6
    print(f"  χ² 檢定（常態近似、σ² 取下界）：Σ(c−c̄)² = {ss:.4f} 題²，統計量 {stat:.4f}，"
          f"P(χ²₅ ≤ {stat:.3f}) = {p_closed:.4f}（數值積分 {p_num:.4f}）")
    print("  σ² 若大於下界，這個機率只會更小，所以它是上界。")

    # 模擬：兩點族（n1 題必解、m 題以 q 解、其餘不會解）中，讓 Var(X) 最小、且吻合 E[X]、E[pass@6] 的母體
    mean_x, target6 = float(mean_c), float(P6)
    best = None
    for m_ in range(1, N + 1):
        # 對固定 m 解 q：m·[(1−(1−q)^6) − q] = target6 − mean_x
        lo, hi = 1e-9, 0.5
        f = lambda q: m_ * ((1 - (1 - q) ** 6) - q) - (target6 - mean_x)
        if f(hi) < 0:
            continue
        for _ in range(100):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if f(mid) < 0 else (lo, mid)
        q = (lo + hi) / 2
        n1 = mean_x - m_ * q
        if n1 < 0 or n1 + m_ > N:
            continue
        var = m_ * q * (1 - q)
        if best is None or var < best[0]:
            best = (var, m_, q, n1)
    var_min, m_best, q_best, n1_best = best
    n1_int = round(n1_best)
    print(f"\n  模擬母體（兩點族中變異最小者，最有利於自報的小標準差）：{n1_int} 題必解、{m_best} 題各以 q={q_best:.4f} 解、"
          f"{N - n1_int - m_best} 題不會解；Var(X) = {var_min:.3f} 題²（下界 {float(lb_counts):.3f}）")

    rng = random.Random(SEED)
    patterns = list(range(64))
    bits = [[(pt >> j) & 1 for j in range(6)] for pt in patterns]
    weights = [q_best ** sum(b) * (1 - q_best) ** (6 - sum(b)) for b in bits]
    cum, acc = [], 0.0
    for w in weights:
        acc += w
        cum.append(acc)
    obs_ratio = float(sd_rep) / sd_pp
    n_sd_le, n_below_plugin, n_ratio_le = 0, 0, 0
    bounds = []
    for _ in range(N_SIM):
        cnt = Counter(rng.choices(patterns, cum_weights=cum, k=m_best))
        run_c = [n1_int + sum(cnt[pt] * bits[pt][j] for pt in cnt) for j in range(6)]
        solved_any = n1_int + (m_best - cnt.get(0, 0))
        mu = sum(run_c) / 6
        popsd_pp = statistics.pstdev(run_c) * 100 / N
        b = (solved_any - mu) / 5
        bounds.append(b)
        sd_b_pp = math.sqrt(max(b, 0)) * 100 / N
        n_sd_le += popsd_pp <= float(sd_rep) + 1e-12
        n_below_plugin += popsd_pp < sd_b_pp
        n_ratio_le += sd_b_pp > 0 and popsd_pp / sd_b_pp <= obs_ratio
    bounds.sort()
    q_ = lambda a: bounds[int(a * (N_SIM - 1))]
    print(f"  模擬 {N_SIM} 次（種子 {SEED}）：")
    print(f"    代入式下界本身的分佈：5% {q_(0.05):.2f}、中位數 {q_(0.5):.2f}、95% {q_(0.95):.2f} 題²")
    print(f"    六次母體標準差 ≤ {float(sd_rep)} 點的比例：{n_sd_le / N_SIM:.4f}")
    print(f"    六次母體標準差 < 代入式下界標準差的比例：{n_below_plugin / N_SIM:.4f}")
    print(f"    兩者比值 ≤ 觀測比值 {obs_ratio:.3f} 的比例：{n_ratio_le / N_SIM:.4f}")

    print("\n結論：(3a) 證實；(3b) 8.84 證實；(3c) 1.7 點 z ≤ 1.72 證實且不依賴消融變異假設；"
          "(3d) 點估計確實低於下界；(3e) 只有 6 次執行，在兩點族中變異最小的母體下仍有約 7% 的機率低到這個程度，屬中度張力，無法判定為矛盾。")
    print("DONE 03-sweagent-variance-bound")


if __name__ == "__main__":
    sys.exit(main())
