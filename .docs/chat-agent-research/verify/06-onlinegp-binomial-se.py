#!/usr/bin/env python3
"""驗證：On-line active reward learning 的 Table 1 ± 值，是不是把對話當獨立樣本算的二項標準誤。

主張（章節 06-user-simulator-feedback.md「統計」一節）：
  精讀時懷疑標準誤把對話當獨立樣本。撰寫時試算：把 3 條策略在區間內的對話合起來，
  兩個區間的樣本數是 (500 − 400) × 3 = 300 與 (850 − 500) × 3 = 1050，以二項比例標準誤代入
  Table 1 的六個成功率，六格的 ± 值全部吻合到小數第一位；這撐住了「± 值沒有計入策略之間的變異」。
  修訂前的章節自承這一步沒有另寫程式複核。
出處：[arXiv:1605.07669]。

輸入（由程式從 .cache/text/1605.07669.txt 解析）：
  - Table 1 的六列「區間、獎勵模型、成功率 ± 值」。
  - 「averaged results obtained between 400-500 training dialogues ... along with one standard error」。
  - 「averaged across the three policies」與「three reward models were learnt each with 850 dialogues」。

方法：
  1. 以 n = (區間長度) × 3 代入 sqrt(p(1 − p) / n)，四捨五入到一位小數，與表上 ± 值比對。
  2. 特異性：對 n = 50…3000 逐一代入，列出能讓同一區間所有格都吻合的 n 範圍，看 300 與 1050
     是不是落在裡面、範圍有多窄。
  3. 以同樣的標準誤，重算 500–850 區間 on-line GP 對 Subj 的兩比例 z 值，對照論文標的 p < 0.05。

只用標準函式庫；沒有隨機數。執行：python3 verify/06-onlinegp-binomial-se.py（研究根目錄）
"""

import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "1605.07669.txt")
with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")
FLAT = re.sub(r"\s+", " ", " ".join(LINES))

a = next(i for i, s in enumerate(LINES) if s.startswith("Table 1: Subjective evaluation"))
b = next(i for i in range(a, len(LINES)) if LINES[i].startswith("### 4.4"))
toks = [s[1:].strip() for s in LINES[a:b] if s.strip().startswith("|") and s[1:].strip()]
rows, span = [], None
for i, t in enumerate(toks):
    if re.match(r"^\d+-\d+$", t):
        span = tuple(int(x) for x in t.split("-"))
    m = re.match(r"^(\d+\.\d) \$\\pm\$ (\d+\.\d)(\*?)$", t)
    if m:
        rows.append((span, toks[i - 1], float(m.group(1)), float(m.group(2)), m.group(3)))
print(f"Table 1（第 {a + 1}–{b} 行）：")
for s, name, p, pm, star in rows:
    print(f"  {s[0]}–{s[1]}  {name:12s} {p} ± {pm}{star}")
assert re.search(r"averaged across the three policies", FLAT)
assert re.search(r"three reward models were learnt each with 850 dialogues", FLAT)
assert re.search(r"along with one standard error", FLAT)
POL = 3
print(f"全文：每種設定訓練 {POL} 條策略；表上 ± 是「one standard error」")


def se(p, n):
    return 100 * math.sqrt((p / 100) * (1 - p / 100) / n)


print("\n步驟 1：n = 區間長度 × 3")
all_ok = True
for s, name, p, pm, _ in rows:
    n = (s[1] - s[0]) * POL
    v = se(p, n)
    ok = abs(round(v, 1) - pm) < 1e-9
    all_ok &= ok
    print(f"  {s[0]}–{s[1]} {name:12s} n = ({s[1]} − {s[0]}) × {POL} = {n}：sqrt({p / 100:.3f} × {1 - p / 100:.3f} ÷ {n}) = {v:.2f} → {'吻合' if ok else '不吻合'}（表上 {pm}）")

print("\n步驟 2：哪些 n 能讓同一區間所有格都吻合")
for s in sorted({r[0] for r in rows}):
    cells = [r for r in rows if r[0] == s]
    good = [n for n in range(50, 3001) if all(abs(round(se(p, n), 1) - pm) < 1e-9 for _, _, p, pm, _ in cells)]
    target = (s[1] - s[0]) * POL
    rng = f"{good[0]}–{good[-1]}" if good else "無"
    print(f"  {s[0]}–{s[1]}（{len(cells)} 格）：n ∈ {rng}，共 {len(good)} 個；{target} {'在內' if target in good else '不在內'}")

g = [r for r in rows if r[0] == (500, 850)]
subj = next(r for r in g if r[1] == "Subj")
gp = next(r for r in g if r[1] == "on-line GP")
z = (gp[2] - subj[2]) / math.sqrt(gp[3] ** 2 + subj[3] ** 2)
legend = next((i for i in range(a, b) if re.search(r"^\|\s*\*\s*\$p<0\.05\$", LINES[i])), None)
assert legend is not None, "找不到 Table 1 的 * p<0.05 說明"
print(f"\n步驟 3：500–850 區間 on-line GP 對 Subj：z = ({gp[2]} − {subj[2]}) ÷ sqrt({gp[3]}² + {subj[3]}²) = {z:.2f}，"
      f"雙尾 p = {math.erfc(z / math.sqrt(2)):.4f}（第 {legend + 1} 行 Table 1 以 * 標 p<0.05；on-line GP 這格"
      f"{'有' if gp[4] else '沒有'} *）")

print(f"\n結論：六格 ± 值{'全部' if all_ok else '並非全部'}等於以 n = 300 與 1050 的對話為獨立樣本算出的二項標準誤，章節的試算證實；"
      "這表示 ± 只反映對話層級的抽樣，沒有計入三條策略之間的變異。論文的 t-test 是否也以對話為單位，表上沒有足夠資訊判定。")
