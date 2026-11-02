#!/usr/bin/env python3
"""驗證：爭議第九條裡四條「推翻或修正論文原文」的重算。

主張（章節 08-task-completion-score.md 爭議第九條表格與其下的算式，另見 2411.00640 段、爭議第四條）：
  A. 2411.00640：均勻分數、相關係數 0.5 時，成對分析讓變異從 1/6 降到 1/12，不是文中的 1/9；
     代入式 9，所需題數約 727 而不是 969（精讀時重算，組章時核對原文確實寫 1/9 與 969）。
  B. ABC 附錄 F：印出的區間中心是正向式 μ = e + (1−2e)·p0，榜首中心 0.691 吻合 [66.8, 71.4]；
     從觀測值推回真實成功率應反解，榜首是 (74.9 − 11.65) / (100 − 2 × 11.65) = 82.5%；
     T5-Base 觀測 6.3%、印出 [14.6, 18.4]，區間不含觀測值，反解為負。
  C. TheAgentCompany：Score = 0.5×平均進度 + 0.5×Success，平均進度 = 2×Score − Success；
     依 Table 1 改用回推進度重排 13 列，只有 OWL RolePlay 與 Qwen-2.5-72b 這一對相鄰名次對調；
     失敗任務上的平均進度 Gemini-2.5-Pro ≈ 25.8%、Claude-3.7-Sonnet ≈ 27.4%。
  D. ToolSandbox：拿掉 II 類後（STC、MTC 以 152、656 加權），Claude-3-Opus 從第 2 名掉到第 4 名、
     Mistral-7B 從第 10 名掉到第 12 名；Mistral-7B 的 29.8 中約 16.7 分來自 II。
出處：A [arXiv:2411.00640] 全文 §4.2 與式 9、式 10；B [arXiv:2507.02825] 全文附錄 F（R.9 與 BIRD 表）；
  C [arXiv:2412.14161] 全文 Table 1；D [arXiv:2408.04682] 全文 Table 5、Table 6。

方法：全部從 .cache/text 解析原文數字與式子；常態分位數用 statistics.NormalDist。
  A 用 fractions 精確算變異，再代入式 9。
  B 解析 BIRD 表每一列，逐列比較區間中心與正向式（容許：區間端點各 ±0.05、觀測值 ±0.05 經放大後
    約 ±0.09 個百分點），並由半寬反推每列的 N。
  C 兩種排序都跨 API 與開放權重兩群一起排，列出所有順序相反的配對。
  D 重用 08-toolsandbox-ii-weight.py 的解析方式，兩種排序都印出完整名次。

只用標準函式庫；沒有隨機數。執行：python3 verify/08-reanalysis-recompute.py
"""

import os
import re
from fractions import Fraction as F
from statistics import NormalDist

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")


def lines_of(pid):
    with open(os.path.join(ROOT, ".cache", "text", pid + ".txt"), encoding="utf-8") as f:
        return f.read().split("\n")


def find(L, pat, start=0, end=None):
    for i in range(start, end if end is not None else len(L)):
        if re.search(pat, L[i]):
            return i
    raise SystemExit("找不到：" + pat)


verdicts = {}

# ================================================================ A. 2411.00640
L = lines_of("2411.00640")
ia = find(L, r"Cov\}\(x_\{A\},x_\{B\}\)=0\.5\\sqrt")
ib = find(L, r"from 1/6 to 1/9 in", ia - 2)
i9 = find(L, r"z_\{0\.025\}\+z_\{0\.20\}\)\^\{2\}\(1/9\)/\(0\.03\)\^\{2\}\\approx 969")
i10 = find(L, r"increasing \$K_\{A\}=K_\{B\}\$ from 1 to 10 reduces the Minimum Detectable Effect from 13\.2% to 7\.5%")
print("== A. 2411.00640 的成對變異與所需題數 ==")
print(f"  原文第 {ia + 1} 行：Var(s_A)=Var(s_B)=1/12、Cov=0.5·√(Var·Var)=1/24")
print(f"  原文第 {ib + 1} 行：「from 1/6 to 1/9」；第 {i9 + 1} 行：n = (z_0.025+z_0.20)²(1/9)/0.03² ≈ 969")
var_s = F(1, 12)
cov = F(1, 2) * var_s  # 0.5·√(1/12·1/12) = 0.5·1/12
unpaired = 2 * var_s
paired = unpaired - 2 * cov
print(f"  unpaired = 1/12 + 1/12 = {unpaired}；paired = {unpaired} − 2 × {cov} = {paired}；"
      f"相對降幅 = 1 − ({paired})/({unpaired}) = {1 - paired / unpaired}（原文寫 1/3）")
z = NormalDist().inv_cdf
zz = (z(1 - 0.025) + z(1 - 0.20)) ** 2
n_paper = zz * (1 / 9) / 0.03 ** 2
n_fix = zz * float(paired) / 0.03 ** 2
print(f"  (z_0.025 + z_0.20)² = ({z(0.975):.4f} + {z(0.80):.4f})² = {zz:.4f}")
print(f"  代入 1/9：{zz:.4f} × (1/9) / 0.0009 = {n_paper:.1f}（重現原文 969）")
print(f"  代入 1/12：{zz:.4f} × (1/12) / 0.0009 = {n_fix:.1f} → 約 {round(n_fix)} 題")
mde = lambda w, s, k, n: (z(0.975) + z(0.80)) * ((w + 2 * s / k) / n) ** 0.5
print(f"  旁證（原文第 {i10 + 1} 行的式 10 例子，σ²=1/6、n=198）：ω²=1/9 時 K=1、10 的 MDE 為 "
      f"{mde(1/9, 1/6, 1, 198):.4f}、{mde(1/9, 1/6, 10, 198):.4f}（原文 13.2%、7.5%）；"
      f"ω² 改 1/12 時為 {mde(1/12, 1/6, 1, 198):.4f}、{mde(1/12, 1/6, 10, 198):.4f}")
verdicts["A"] = paired == F(1, 12) and round(n_paper) == 969 and round(n_fix) == 727

# ================================================================ B. ABC 附錄 F
L = lines_of("2507.02825")
ie = find(L, r"we found 11\.65%")
ifm = find(L, r"\\mu=e\+\(1-2e\)p_\{0\}")
ist = find(L, r"label = tab:bird-data")
print("\n== B. ABC 附錄 F 的 BIRD 區間 ==")
print(f"  原文第 {ie + 1} 行：e = 11.65%；第 {ifm + 1} 行：μ = e + (1−2e)·p0、σ² = μ(1−μ)")
e = 0.1165
rows = []
for i in range(ist, min(ist + 200, len(L))):
    m = re.search(r"(\d{1,2}\.\d)\[(\d+\.\d), (\d+\.\d)\]", L[i])
    if m:
        rows.append((i + 1, L[i][:m.start()].strip(), float(m.group(1)), float(m.group(2)), float(m.group(3))))
print(f"  解析到 {len(rows)} 列（第 {rows[0][0]}–{rows[-1][0]} 行）")
worst = 0.0
Ns = []
for ln, name, p0, lo, hi in rows:
    mu = (e + (1 - 2 * e) * p0 / 100) * 100
    ctr = (lo + hi) / 2
    worst = max(worst, abs(mu - ctr))
    hw = (hi - lo) / 2
    Ns.append(1.96 ** 2 * (mu / 100) * (1 - mu / 100) / (hw / 100) ** 2)
print(f"  逐列 |正向式 μ − 區間中心| 的最大值：{worst:.3f} 個百分點（容許約 0.09）")
print(f"  由半寬反推的 N：最小 {min(Ns):.0f}、最大 {max(Ns):.0f}（半寬只印到 0.05，N 的反推很粗）")
top = rows[0]
mu_top = e + (1 - 2 * e) * top[2] / 100
inv_top = (top[2] - 11.65) / (100 - 2 * 11.65) * 100
print(f"  榜首 {top[1]}：正向式 0.1165 + (1 − 2 × 0.1165) × {top[2] / 100:.3f} = {mu_top:.3f}；"
      f"印出區間中心 ({top[3]} + {top[4]}) / 2 = {(top[3] + top[4]) / 2:.1f}")
print(f"  榜首反解：({top[2]} − 11.65) / (100 − 2 × 11.65) = {inv_top:.2f}%")
t5 = [r for r in rows if r[1].startswith("T5-Base")][0]
inv_t5 = (t5[2] - 11.65) / (100 - 2 * 11.65) * 100
print(f"  T5-Base：觀測 {t5[2]}%、印出 [{t5[3]}, {t5[4]}]，區間含觀測值：{t5[3] <= t5[2] <= t5[4]}；"
      f"反解 ({t5[2]} − 11.65) / 76.7 = {inv_t5:.2f}%")
verdicts["B"] = worst <= 0.09 and round(inv_top, 1) == 82.5 and not (t5[3] <= t5[2] <= t5[4]) and inv_t5 < 0

# ================================================================ C. TheAgentCompany
L = lines_of("2412.14161")
cap = find(L, r"^Table 1: Performance comparison of various foundation models on TheAgentCompany")
end = find(L, r"^### 7\.1 Result Overview", cap)
tac = []
i = cap
while i < end:
    if re.match(r"^\| (OpenHands|OWL)", L[i]) and i + 3 < end:
        model = L[i + 1][2:].strip()
        s = re.match(r"^\| (\d+\.\d)%$", L[i + 2])
        sc = re.match(r"^\| (\d+\.\d)%$", L[i + 3])
        if s and sc:
            label = "OWL RolePlay" if L[i].startswith("| OWL") else model
            tac.append((label, float(s.group(1)), float(sc.group(1))))
            i += 4
            continue
    i += 1
print(f"\n== C. TheAgentCompany Table 1（第 {cap + 1} 行起，解析到 {len(tac)} 列）==")
assert len(tac) == 13
by_score = sorted(tac, key=lambda r: -r[2])
prog = {r[0]: 2 * r[2] - r[1] for r in tac}
by_prog = sorted(tac, key=lambda r: -prog[r[0]])
print(f"  {'Score 名次':<10}{'模型':<22}{'Success':>8}{'Score':>7}{'回推進度 2×Score−Success':>26}{'進度名次':>8}")
rank_p = {r[0]: k + 1 for k, r in enumerate(by_prog)}
for k, r in enumerate(by_score):
    print(f"  {k + 1:<10}{r[0]:<22}{r[1]:>8.1f}{r[2]:>7.1f}{f'2×{r[2]}−{r[1]}={prog[r[0]]:.1f}':>26}{rank_p[r[0]]:>8}")
disc = [(a[0], b[0]) for x, a in enumerate(by_score) for b in by_score[x + 1:]
        if prog[a[0]] < prog[b[0]]]
print(f"  兩種排序相反的配對：{disc}")
adjacent = len(disc) == 1 and abs(by_score.index([r for r in tac if r[0] == disc[0][0]][0])
                                   - by_score.index([r for r in tac if r[0] == disc[0][1]][0])) == 1
g = [r for r in tac if r[0] == "Gemini-2.5-Pro"][0]
c = [r for r in tac if r[0] == "Claude-3.7-Sonnet"][0]
fg = (prog[g[0]] - g[1]) / (100 - g[1]) * 100
fc = (prog[c[0]] - c[1]) / (100 - c[1]) * 100
print(f"  失敗任務的平均進度：Gemini-2.5-Pro ({prog[g[0]]:.1f}−{g[1]})/(100−{g[1]}) = {fg:.1f}%；"
      f"Claude-3.7-Sonnet ({prog[c[0]]:.1f}−{c[1]})/(100−{c[1]}) = {fc:.1f}%")
verdicts["C"] = (len(disc) == 1 and set(disc[0]) == {"OWL RolePlay", "Qwen-2.5-72b"} and adjacent
                 and round(fg, 1) == 25.8 and round(fc, 1) == 27.4)

# ================================================================ D. ToolSandbox
L = lines_of("2408.04682")
cap5 = find(L, r"^Table 5: Comparing the average similarity score")
start5 = find(L, r"^## 4 Evaluation Results")
COLS = ["Avg", "STC", "MTC", "SUT", "MUT", "SD", "C", "II",
        "0DT", "3DT", "10DT", "AT", "TNS", "TDS", "ADS", "ATS"]
ts = {}
i = start5
while i < cap5:
    m = re.match(r"^\| ([A-Za-z][A-Za-z0-9 .+\-]+)$", L[i])
    if m:
        vals = [re.match(r"^\| (\d+\.\d)$", L[i + j]) for j in range(1, 17)]
        if all(vals):
            ts[m.group(1)] = dict(zip(COLS, (float(v.group(1)) for v in vals)))
            i += 17
            continue
    i += 1
assert len(ts) == 13
cap6 = find(L, r"^Table 6: Number of test scenarios per category")
t6 = {}
for j in range(find(L, r"Test Scenario Count"), cap6):
    m = re.match(r"^\| ([A-Z_]+)$", L[j])
    if m and re.match(r"^\| (\d+)$", L[j + 1]):
        t6[m.group(1)] = int(L[j + 1][2:])
stc, mtc, ii = t6["SINGLE_TOOL_CALL"], t6["MULTIPLE_TOOL_CALL"], t6["INSUFFICIENT_INFORMATION"]
print(f"\n== D. ToolSandbox：拿掉 II 類之後的排名（STC {stc}、MTC {mtc}、II {ii}）==")
wo = {k: (stc * v["STC"] + mtc * v["MTC"]) / (stc + mtc) for k, v in ts.items()}
r_avg = {k: n + 1 for n, k in enumerate(sorted(ts, key=lambda k: -ts[k]["Avg"]))}
r_wo = {k: n + 1 for n, k in enumerate(sorted(ts, key=lambda k: -wo[k]))}
print(f"  {'模型':<28}{'Avg':>6}{'名次':>5}{'無 II':>8}{'名次':>5}{'II 貢獻 224×II/1032':>22}")
for k in sorted(ts, key=lambda k: r_avg[k]):
    print(f"  {k:<28}{ts[k]['Avg']:>6.1f}{r_avg[k]:>5}{wo[k]:>8.1f}{r_wo[k]:>5}{ii * ts[k]['II'] / 1032:>22.1f}")
opus = [k for k in ts if k.startswith("Claude-3-Opus")][0]
mis = [k for k in ts if k.startswith("Mistral-7B")][0]
g35 = [k for k in ts if k.startswith("GPT-3.5")][0]
g4 = [k for k in ts if k.startswith("GPT-4-")][0]
print(f"  Claude-3-Opus：(152×{ts[opus]['STC']}＋656×{ts[opus]['MTC']})/808 = {wo[opus]:.1f}，名次 {r_avg[opus]} → {r_wo[opus]}")
print(f"  GPT-3.5：{wo[g35]:.1f}；GPT-4：{wo[g4]:.1f}")
print(f"  Mistral-7B：無 II {wo[mis]:.1f}，II 貢獻 224×{ts[mis]['II']}/1032 = {ii * ts[mis]['II'] / 1032:.1f}，"
      f"名次 {r_avg[mis]} → {r_wo[mis]}")
verdicts["D"] = (r_avg[opus], r_wo[opus], r_avg[mis], r_wo[mis]) == (2, 4, 10, 12) and \
    (round(wo[opus], 1), round(wo[g35], 1), round(wo[g4], 1), round(wo[mis], 1)) == (72.5, 77.6, 72.8, 16.8)

print("\n== 結論 ==")
names = {"A": "2411.00640：1/9→1/12、969→727", "B": "ABC 附錄 F：區間用正向式、反解 82.5%、T5-Base 反解為負",
         "C": "TheAgentCompany：回推進度重排只有 OWL／Qwen-2.5-72b 一對相鄰對調",
         "D": "ToolSandbox：拿掉 II 後 Claude-3-Opus 2→4、Mistral-7B 10→12"}
for k, v in verdicts.items():
    print(f"  {names[k]}：{'證實' if v else '推翻'}")
print(f"結論：{'四條全部證實' if all(verdicts.values()) else '有未證實的項目，見上方'}")
