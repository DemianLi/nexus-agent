#!/usr/bin/env python3
"""驗證：Lost in Simulation 的 ECE_Human-LLM 與真人成功率之間的機械關係。

主張（章節 06-user-simulator-feedback.md「標準答案本身就可疑」一段，修訂前）：
  撰寫時依 ECE 定義補一條三角不等式：各箱權重近似相等時，ECE 的下界約是真人成功率與 50 的差，
  AAVE 為 50 − 39.4 = 10.6，所以真人成功率越低的族群，ECE 會被機械地推高。
critic 的反駁（缺口 C15）：下界對 50 對稱、只是下界；AAVE 實際 20.3 約是下界的兩倍，
  SAE 的 11.7 對上的下界只有 0.6；前提「各箱權重近似相等」也沒核對。
出處：[arXiv:2601.17087]。

輸入（由程式從 .cache/text/2601.17087.txt 解析）：
  - ECE 定義：w_i 是第 i 箱真人完成次數的比例，ECE = Σ w_i |s_i(Human) − s_i(LLM)|。
  - 分箱：GPT-4o 自我對弈 5 次，箱值 0、20、40、60、80、100%；每箱挑 3 題、共 18 題。
  - 指派：每位受試者做 4 題，2 題來自 0–40% 的箱、2 題來自 60–100% 的箱。
  - 「Success rate is averaged across difficulty levels」：表列成功率是跨難度箱平均。
  - 美國整體：45.2%、ECE 15.1；最難的 0% 箱真人 30.8%、60% 箱真人 39.0%，兩箱合計 ECE 25.9。
  - Table 2（SAE／AAVE × 年齡）、Table 3（18–34 歲的國家比較）。
  - 附錄：同一組 18 題重跑模擬時，整體成功率從 50.0% 降到 46.7%（50.0% 就是箱值的設計平均）。

方法：
  1. 兩箱核對：若 s = 0 與 60、兩箱權重相等，(|30.8 − 0| + |39.0 − 60|) ÷ 2 應等於 25.9。
  2. 權重相等時，三角不等式給 ECE ≥ |Σ w_i h_i − Σ w_i s_i| = |H − 50|（H 為表列成功率）；
     逐列算下界、ECE − 下界，並比較 AAVE 與 SAE 的 ECE 差與下界差。
  3. 權重不相等時：設計只保證「難的三箱」與「易的三箱」各佔一半，Σ w_i s_i 可以落在
     0.5 × 0 + 0.5 × 60 = 30 到 0.5 × 40 + 0.5 × 100 = 70 之間，下界就不再是 |H − 50|。
  4. 描述性：在 9 個不重疊的子群（SAE、AAVE 各三個年齡層，印度、肯亞、奈及利亞）上，
     算 |H − 50| 與 ECE 的 Kendall τ；並列出 H 的觀察範圍與 ECE − 下界的範圍。
  注意：「下界差大於實際 ECE 差」代表方言差距可能整段來自機械效果，不是「下界只解釋一部分」的證據；
     「只解釋一部分」的依據是各列 ECE 的水準都高出下界不少。

只用標準函式庫；沒有隨機數。執行：python3 verify/06-lis-ece-bound.py（研究根目錄）
"""

import os
import re
from itertools import combinations

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "2601.17087.txt")
with open(TEXT, encoding="utf-8") as f:
    LINES = f.read().split("\n")
FLAT = re.sub(r"\s+", " ", " ".join(LINES))


def must(pattern, text=FLAT):
    m = re.search(pattern, text)
    if not m:
        raise SystemExit(f"找不到：{pattern}")
    return m


def line_no(pattern):
    rx = re.compile(pattern)
    for i, s in enumerate(LINES):
        if rx.search(s):
            return i + 1
    return None


must(r"Let \$w_\{i\}\$ denote the proportion of human task completions at level")
print(f"第 {line_no(r'denote the proportion of human task completions')} 行：w_i = 第 i 箱真人完成次數的比例")
m = must(r"0/5, 1/5, 2/5, 3/5, 4/5, 5/5 = (\d+)%, (\d+)%, (\d+)%, (\d+)%, (\d+)%, (\d+)%")
BINS = [int(x) for x in m.groups()]
must(r"select (\d) tasks for each difficulty level \((\d+) total\)")
must(r"2 from higher difficulty levels \(0-40% success rate\) and 2 from lower difficulty levels \(60-100% success rate\)")
must(r"Success rate is averaged across difficulty levels to obtain a single value")
m = must(r"overall success decreases from (\d+\.\d)% to (\d+\.\d)%")
SIM_MEAN_18 = float(m.group(1))
print(f"箱值 {BINS}，平均 {sum(BINS) / len(BINS):.1f}；附錄重跑前 18 題的模擬整體成功率 {SIM_MEAN_18}%（與設計平均一致）")
print("每箱 3 題、共 18 題；每位受試者 2 題難（0–40%）、2 題易（60–100%）；表列成功率是跨難度箱平均")

m = must(r"achieve a \$(\d+\.\d)\\%\$ success rate with US participants and an \$ECE_\{\\text\{Human-+LLM\}\}\$ of \$(\d+\.\d)\$")
US_H, US_E = float(m.group(1)), float(m.group(2))
m = must(r"with \$ECE_\{\\text\{Human-+LLM\}\}=(\d+\.\d)\$ across the two bins")
TWO = float(m.group(1))
m = must(r"hardest tasks \(success with human users: \$(\d+\.\d)\\%\$ \)")
H0 = float(m.group(1))
m = must(r"moderate tasks \(success with human users: \$(\d+\.\d)\\%\$ \)")
H60 = float(m.group(1))
calc = (abs(H0 - 0) + abs(H60 - 60)) / 2
print(f"\n步驟 1：美國整體 {US_H}%、ECE {US_E}；0% 箱真人 {H0}%、60% 箱真人 {H60}%，論文說兩箱 ECE {TWO}")
print(f"  (|{H0} − 0| + |{H60} − 60|) ÷ 2 = {calc:.2f} → {'相符' if abs(calc - TWO) < 0.051 else '不符'}（這兩箱的箱值與等權重得到印證）")


def table_rows(caption_pat, n_before=60):
    end = None
    for i, s in enumerate(LINES):
        if re.search(caption_pat, s):
            end = i
            break
    seg = " ".join(LINES[end - n_before:end])
    return seg


seg2 = table_rows(r"^Table 2: Success Rate \(%\) and Expected Calibration Error")
seg3 = table_rows(r"^Table 3: Success Rate \(%\) and Expected Calibration Error")
ROWS = []
toks = [t.strip() for t in re.split(r"\|", seg2) if t.strip()]
grp = None
i = 0
while i < len(toks):
    t = toks[i]
    if t in ("SAE", "AAVE"):
        grp = t
    elif grp and t in ("All", "18–34", "35–54", "55+") and i + 2 < len(toks):
        ROWS.append((f"{grp} {t}", float(toks[i + 1]), float(toks[i + 2])))
        i += 2
    i += 1
toks = [t.strip() for t in re.split(r"\|", seg3) if t.strip()]
for i, t in enumerate(toks):
    if t in ("India", "Kenya", "Nigeria") and i + 2 < len(toks):
        ROWS.append((f"{t} 18–34", float(toks[i + 1]), float(toks[i + 2])))
ROWS.insert(0, ("US 整體", US_H, US_E))

print("\n步驟 2：假設六箱權重相等時的下界 |H − 50|")
print(f"  {'群組':12s} {'H':>5s} {'ECE':>5s} {'下界':>5s} {'ECE−下界':>8s}")
for name, h, e in ROWS:
    lb = abs(h - 50)
    print(f"  {name:12s} {h:5.1f} {e:5.1f} {lb:5.1f} {e - lb:8.1f}")
d = {n: (h, e) for n, h, e in ROWS}
dE = d["AAVE All"][1] - d["SAE All"][1]
dL = abs(d["AAVE All"][0] - 50) - abs(d["SAE All"][0] - 50)
print(f"  AAVE 與 SAE：ECE 差 {d['AAVE All'][1]} − {d['SAE All'][1]} = {dE:.1f}；下界差 {abs(d['AAVE All'][0] - 50):.1f} − {abs(d['SAE All'][0] - 50):.1f} = {dL:.1f}")

print("\n步驟 3：權重只保證難易兩半各佔一半時，Σ w_i s_i 的範圍")
lo = 0.5 * min(BINS[:3]) + 0.5 * min(BINS[3:])
hi = 0.5 * max(BINS[:3]) + 0.5 * max(BINS[3:])
print(f"  Σ w_i s_i ∈ [{lo:.0f}, {hi:.0f}]；此時下界是 |Σ w_i h_i − Σ w_i s_i|，而且 Σ w_i h_i 也不必等於表列的跨箱平均 H")

sub = [r for r in ROWS if r[0] not in ("US 整體", "SAE All", "AAVE All")]
conc = disc = ties = 0
for (_, h1, e1), (_, h2, e2) in combinations(sub, 2):
    s = (abs(h1 - 50) - abs(h2 - 50)) * (e1 - e2)
    conc += s > 0
    disc += s < 0
    ties += s == 0
npairs = len(sub) * (len(sub) - 1) // 2
tau = (conc - disc) / npairs
print(f"\n步驟 4：{len(sub)} 個不重疊子群、共 {npairs} 對上，|H − 50| 與 ECE 的 Kendall τ = ({conc} − {disc}) ÷ {npairs} = {tau:.2f}"
      f"（一致 {conc} 對、不一致 {disc} 對、同分 {ties} 對）")
ind = d["India 18–34"]
print(f"  例：印度 H {ind[0]}、下界 {abs(ind[0] - 50):.1f}，ECE 卻是 {ind[1]}")

Hs = [h for _, h, _ in ROWS]
above = [n for n, h, _ in ROWS if h > 50]
ex = sorted(((e - abs(h - 50), n) for n, h, e in ROWS))
print(f"\n觀察範圍：各列 H 介於 {min(Hs)} 到 {max(Hs)}；高於 50 的只有 {len(above)} 列（{'、'.join(above)}）")
print(f"ECE − 下界：最小 {ex[0][1]} {ex[0][0]:.1f}，最大 {ex[-1][1]} {ex[-1][0]:.1f}")

print(f"\n結論：兩箱核對相符，箱值與等權重的前提在 0% 與 60% 兩箱得到印證，其餘四箱的權重全文沒有數字可核，以下都以等權重為條件。"
      f"等權重下 ECE ≥ |H − 50|，這條下界對 50 對稱，所以原句「成功率越低、ECE 被機械推高」收窄成「偏離 50 越遠、下界越高」；"
      f"論文觀察到的 H 介於 {min(Hs)} 到 {max(Hs)}，高於 50 的只有 SAE 幾列而且只略高，在這個範圍內原句的方向大致成立。"
      f"各列 ECE 都比下界高出 {ex[0][0]:.1f} 到 {ex[-1][0]:.1f}，下界撐不起 ECE 的全部水準；"
      f"但 AAVE 與 SAE 的 ECE 差 {dE:.1f} 小於兩者下界的差 {dL:.1f}，方言之間的差距整段落在機械下界可能造成的範圍內，"
      f"子群上 τ = {tau:.2f} 也支持有機械成分。方言間的 ECE 差距實際有多少是機械的，沒有逐箱資料無法判定。")
