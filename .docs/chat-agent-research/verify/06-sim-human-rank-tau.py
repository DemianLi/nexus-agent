#!/usr/bin/env python3
"""驗證：本章讀過的論文裡，「同一批系統」同時有模擬器分數與真人分數的比較，最多有幾個系統、
名次一致到什麼程度、樣本量給得出多強的證據。

主張（章節 06-user-simulator-feedback.md，修訂前）：
  - 「模擬器 vs 真人」的比較裡，規模最大的也只有 4 個系統。
  - 「模擬器排出的名次能不能保住真人的名次」沒有直接證據。
critic 的反駁（缺口 C1、C18、G5）：MetaSim 的 Table 5 有 7 個變體同時有模擬與真人分數；
  其他節點的 AlpacaFarm 有 10 個系統；GATE（2310.11589）附錄 D 也做過名次比較。
出處：[arXiv:2204.00763]、[arXiv:2305.13112]、[arXiv:2208.10817]、[arXiv:1805.06966]、
  [arXiv:2309.13233]（📖）、[arXiv:2305.14387]（T7 節點）。

輸入（全部由程式從 .cache/text/<id>.txt 解析，不手抄）：
  - MetaSim Table 5（MultiWOZ，7 個受控降級變體）：與 MetaSim 互動的 Success、真人 Success、
    測試集 Success（靜態指標，當對照）。
  - MetaSim Table 10（3 個第三方系統）：與 MetaSim 互動的 Success、Sat.，真人 Sat.。
  - iEvaLM Table 8（4 個 CRS、ReDial 隨機 100 例）：模擬與真人的 Recall@10、Persuasiveness。
  - GenTUS Table 5／Table 6（3 個策略）：三個測試用模擬器各一欄，對真人 success。
  - NUS Table 2 的 NUS-best／ABUS-best 列與 Table 4 的四個真人成功率（每個模擬器只有兩個策略可比）。
  - 2309.13233 Table 3（PPTOD、SOLOIST 兩個系統）：Human、Ours、ConvLab2 TUS 的 GSR。
  - AlpacaFarm Table 2（10 個系統兩欄都有值）：模擬勝率、真人勝率；caption 說明兩欄的意義；
    論文報的 Spearman 0.98（全部系統）與 0.94（拿掉未訓練的系統）；SFT 10k／52k 的定義句。

方法：
  1. 每組算 Kendall τ（沒有同分時 τ = 1 − 4 × 逆序對數 ÷ (n(n − 1))），以及「名次一致」方向的
     精確單尾 p：在 n! 個排列等機率下，逆序對數 ≤ 觀察值的機率（用 Mahonian 數的動態規劃算）。
     同時列出 n 個系統能達到的最小 p = 1 ÷ n!，看樣本量本身給不給得出證據。
  2. MetaSim Table 5 另外列出拿掉 β=0.1、γ=0.01 兩格（精讀筆記指出與設計前提矛盾）之後的 τ，
     明確標出這是事後排除。
  3. AlpacaFarm 另算 Spearman，與從全文解析出的 0.98、0.94 比對，並用 caption 釘住兩欄的意義；
     再依 SFT 10k／52k 的定義句（兩者都不經成對回饋）拿掉這兩列，只留模擬回饋訓練對真人回饋重訓的方法再算一次 τ。
  GATE（2310.11589）附錄 D 的名次比較只在圖上、沒有數字；Lost in Simulation（2601.17087）只測
  一個 agent，沒有「多個系統的名次」可比。這兩篇本程式不算。

只用標準函式庫；沒有隨機數。執行：python3 verify/06-sim-human-rank-tau.py（研究根目錄）
"""

import math
import os
import re
from itertools import combinations

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "..", ".cache", "text")


def load(aid):
    with open(os.path.join(CACHE, f"{aid}.txt"), encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def blocks(lines, a, b):
    rows, cur = [], []
    for i in range(a, b):
        s = lines[i]
        if s.startswith("| "):
            cur.append(s[2:].strip())
        elif s.strip() == "":
            if cur:
                rows.append(cur)
                cur = []
    if cur:
        rows.append(cur)
    return rows


def mahonian(n):
    """回傳長度 n(n−1)/2+1 的串列：n 個元素的排列中逆序對數恰為 k 的個數。"""
    row = [1]
    for m in range(2, n + 1):
        new = [0] * (len(row) + m - 1)
        for k, c in enumerate(row):
            for j in range(m):
                new[k + j] += c
        row = new
    return row


def tau_stats(xs, ys):
    n = len(xs)
    conc = disc = ties = 0
    for i, j in combinations(range(n), 2):
        s = (xs[i] - xs[j]) * (ys[i] - ys[j])
        if s > 0:
            conc += 1
        elif s < 0:
            disc += 1
        else:
            ties += 1
    pairs = n * (n - 1) // 2
    tau = (conc - disc) / pairs
    p = None
    if ties == 0:
        m = mahonian(n)
        p = sum(m[: disc + 1]) / math.factorial(n)
    return tau, disc, ties, p, 1 / math.factorial(n)


def spearman(xs, ys):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: -v[i])
        r = [0] * len(v)
        for k, i in enumerate(order):
            r[i] = k + 1
        return r
    rx, ry = ranks(xs), ranks(ys)
    n = len(xs)
    d2 = sum((a - b) ** 2 for a, b in zip(rx, ry))
    return 1 - 6 * d2 / (n * (n * n - 1)), d2


RESULTS = []


def report(label, names, sim, hum, note=""):
    tau, disc, ties, p, pmin = tau_stats(sim, hum)
    ptxt = (f"單尾精確 p = {p:.4f}" if p >= 0.001 else f"單尾精確 p = {p:.2e}") if p is not None else "有同分，不算精確 p"
    print(f"  {label}：n = {len(names)}，τ = {tau:+.3f}（逆序 {disc} 對、同分 {ties} 對），{ptxt}，n 個系統的最小可能 p = 1/{len(names)}! = {pmin:.4g}{note}")
    RESULTS.append((label, len(names), tau, p, pmin))
    return tau, p


# ---------------- MetaSim Table 5 ----------------
ML = load("2204.00763")
t5 = find_line(ML, r"^Table 5\. Evaluation results of variants on the MultiWOZ")
t6 = find_line(ML, r"^Table 6\. Evaluation results of variants on the ReDial", t5)
V = {}
for r in blocks(ML, t5, t6):
    if len(r) == 10 and re.match(r"^\d+\.\d+$", r[1]):
        name = r[0].replace("$", "").replace("\\", "")
        V[name] = [float(x) for x in r[1:]]
sub = [r for r in blocks(ML, t5, t6) if len(r) == 9 and r[0] == "BLEU"]
assert sub and sub[0] == ["BLEU", "Success", "Slot", "Success", "Dist", "Sat.", "Success", "Eff.", "Nat."], sub
print(f"MetaSim Table 5（第 {t5 + 1}–{t6} 行）子欄位：{sub[0]}；index 1 = 測試集 Success、3 = 與 MetaSim 互動 Success、6 = 真人 Success")
names = list(V)
IS = [V[k][3] for k in names]
HS = [V[k][6] for k in names]
TS = [V[k][1] for k in names]
for k in names:
    print(f"    {k:12s} 互動 Success {V[k][3]:6.2f}  真人 Success {V[k][6]:6.2f}  測試集 Success {V[k][1]:6.2f}")
assert len(names) == 7
print("  —— MetaSim 互動 Success 對真人 Success")
report("MetaSim T5 全部 7 個變體", names, IS, HS)
for drop in (["beta=0.1"], ["gamma=0.01"], ["beta=0.1", "gamma=0.01"]):
    keep = [i for i, k in enumerate(names) if k not in drop]
    report(f"MetaSim T5 拿掉 {'、'.join(drop)}（事後排除）", [names[i] for i in keep], [IS[i] for i in keep], [HS[i] for i in keep])
print("  —— 對照：靜態測試集 Success 對真人 Success（不經模擬器）")
report("MetaSim T5 測試集 Success，7 個變體", names, TS, HS)
keep = [i for i, k in enumerate(names) if k not in ("beta=0.1", "gamma=0.01")]
report("MetaSim T5 測試集 Success，拿掉兩格", [names[i] for i in keep], [TS[i] for i in keep], [HS[i] for i in keep])

# ---------------- MetaSim Table 10 ----------------
t10 = find_line(ML, r"^Table 10\. Evaluation results of dialogue systems on MultiWOZ")
e10 = find_line(ML, r"^Test results of third-party dialogue systems", t10)
T10 = {}
for r in blocks(ML, t10, e10):
    if len(r) == 12 and re.match(r"^\d+\.\d+$", r[1]):
        T10[r[0].split(" (")[0]] = [float(x) for x in r[1:]]
sub10 = [r for r in blocks(ML, t10, e10) if r and r[0] == "Inform"][0]
assert sub10 == ["Inform", "Success", "BLEU", "Combine", "Success", "Distinct", "Sat.", "Combine", "Sat.", "Effic.", "Natural."], sub10
n10 = list(T10)
print(f"\nMetaSim Table 10（第 {t10 + 1}–{e10} 行）：真人端只有 Sat.、Effic.、Natural.，沒有 Success")
for k in n10:
    print(f"    {k:8s} 互動 Success {T10[k][4]:6.2f}  互動 Sat. {T10[k][6]:.2f}  真人 Sat. {T10[k][8]:.2f}")
report("MetaSim T10 互動 Success 對真人 Sat.", n10, [T10[k][4] for k in n10], [T10[k][8] for k in n10])
report("MetaSim T10 互動 Sat. 對真人 Sat.", n10, [T10[k][6] for k in n10], [T10[k][8] for k in n10])

# ---------------- iEvaLM Table 8 ----------------
IL = load("2305.13112")
c8 = find_line(IL, r"^Table 8: The evaluation results using simulated and real users")
s8 = find_line(IL, r"^\| Evaluation Approach", c8 - 60)
rows = blocks(IL, s8, c8)
hdr8 = rows[0][1:]
cur, T8 = None, {}
for r in rows[1:]:
    if r[0] in ("iEvaLM", "Human"):
        cur = r[0]
        r = r[1:]
    T8[(cur, r[0])] = [float(x) for x in r[1:]]
print(f"\niEvaLM Table 8（第 {s8 + 1}–{c8 + 1} 行）系統：{hdr8}；caption：ReDial 隨機 100 例")
for key, v in T8.items():
    print(f"    {key[0]:6s} {key[1]:14s} {v}")
for metric in ("Recall@10", "Persuasiveness"):
    report(f"iEvaLM T8 {metric}", hdr8, T8[("iEvaLM", metric)], T8[("Human", metric)])

# ---------------- GenTUS ----------------
GL = load("2208.10817")
s54 = find_line(GL, r"^### 5\.4 Cross-model Evaluation")
g5 = find_line(GL, r"^Table 5: The success rates")
US = ["ABUS-T", "ABUS-S", "GenTUS"]
M = {r[0]: [float(x) for x in r[1:]] for r in blocks(GL, s54, g5) if r[0] in US and len(r) == 4}
s55 = find_line(GL, r"^### 5\.5 Interactive Human Trial")
g6 = find_line(GL, r"^Table 6: ")
H = {r[0]: float(r[1]) for r in blocks(GL, s55, g6) if r[0] in US and len(r) == 3}
print(f"\nGenTUS Table 5（第 {s54 + 1}–{g5 + 1} 行，列＝訓練、欄＝測試）與 Table 6（第 {s55 + 1}–{g6 + 1} 行）真人 {H}")
for j, t in enumerate(US):
    report(f"GenTUS 以 {t} 測", US, [M[u][j] for u in US], [H[u] for u in US])

# ---------------- NUS ----------------
NL = load("1805.06966")
n2 = find_line(NL, r"^Table 2: Results for policies trained for 4000 dialogues")
s61 = find_line(NL, r"^### 6\.1 Cross-Model Evaluation")
T2 = {r[0]: r[1:] for r in blocks(NL, s61, n2) if r[0] in ("NUS-best", "ABUS-best", "NUS-avg", "ABUS-avg")}
num = lambda x: float(x.split()[0])
n4 = find_line(NL, r"^Table 4: Real User Evaluation")
hum = {}
for r in blocks(NL, n4 - 30, n4):
    m = re.search(r"mathcal\{([NA])\}_\{(\d)\}", r[0])
    if m and len(r) == 3:
        hum[m.group(1) + m.group(2)] = float(r[2])
cap4 = NL[n4]
assert "performed best on the NUS" in cap4 and "performed best on the ABUS" in cap4
print(f"\nNUS Table 2（第 {s61 + 1}–{n2 + 1} 行）best 列：NUS-best {T2['NUS-best']}、ABUS-best {T2['ABUS-best']}；"
      f"Table 4（第 {n4 + 1} 行）真人 Suc.：{hum}")
print("  Table 4 caption：N1、A1 是在 NUS 上最好的，N2、A2 是在 ABUS 上最好的；Table 2 的 NUS-best 測 ABUS 那格沒標 N2，依 caption 推定是 N2")
report("NUS 以 NUS 測（N1 對 A1）", ["N1", "A1"], [num(T2["NUS-best"][1]), num(T2["ABUS-best"][1])], [hum["N1"], hum["A1"]])
report("NUS 以 ABUS 測（N2 對 A2）", ["N2", "A2"], [num(T2["NUS-best"][3]), num(T2["ABUS-best"][3])], [hum["N2"], hum["A2"]])

# ---------------- 2309.13233 ----------------
PL = load("2309.13233")
c3 = find_line(PL, r"^Table 3: Comparison of our proposed method to human, MetaSim, and Convlab2TUS")
s3 = find_line(PL, r"^PPTOD$", c3 - 60)
seg = [s.strip() for s in PL[s3:c3] if s.strip()]
pp = seg[1:13]
so = seg[seg.index("SOLOIST") + 1: seg.index("SOLOIST") + 13]
print(f"\n2309.13233 Table 3（第 {s3 + 1}–{c3 + 1} 行，📖）GSR：PPTOD Human {pp[0]}、Ours {pp[3]}、MetaSim {pp[6]}、TUS {pp[9]}；"
      f"SOLOIST Human {so[0]}、Ours {so[3]}、MetaSim {so[6]}、TUS {so[9]}")
report("2309.13233 Ours（LLM 模擬器）", ["PPTOD", "SOLOIST"], [float(pp[3]), float(so[3])], [float(pp[0]), float(so[0])])
report("2309.13233 ConvLab2 TUS", ["PPTOD", "SOLOIST"], [float(pp[9]), float(so[9])], [float(pp[0]), float(so[0])])

# ---------------- AlpacaFarm Table 2 ----------------
AL = load("2305.14387")
ca = find_line(AL, r"^Table 2: AlpacaFarm evaluation results on baseline and LHF methods")
ea = find_line(AL, r"^\| LLaMA 7B", ca)
cap = " ".join(AL[ca:ca + 4])
assert "train and evaluate in simulation" in cap and "train and evaluate with human feedback" in cap
A = []
for r in blocks(AL, ca, ea + 4):
    if len(r) == 3 and r[1].startswith("$"):
        sim = float(re.search(r"\$(\d+\.\d)", r[1]).group(1))
        hum_v = None if r[2] == "-" else float(re.search(r"\$(\d+\.\d)", r[2]).group(1))
        A.append((r[0], sim, hum_v, "*" in r[0]))
assert "not trained by us so the left and right columns respectively show simulated and human evaluation" in cap
both = [a for a in A if a[2] is not None]
trained = [a for a in both if not a[3]]
print(f"\nAlpacaFarm Table 2（第 {ca + 1} 行起）共 {len(A)} 列，兩欄都有值 {len(both)} 列，其中自己訓練的 {len(trained)} 列")
print("  caption（程式已比對原文）：沒有 * 的方法，左欄在模擬中訓練與評估，右欄用真人回饋訓練與評估；"
      "有 * 的不是作者訓練的，兩欄分別是模擬評估與真人評估")
# SFT 兩列只用示範資料微調，不經成對回饋
l_sft10 = find_line(AL, r"As a baseline and starting point for LPF methods, we fine-tuned LLaMA 7B .* on the 10k SFT split")
l_sft52 = find_line(AL, r"finetuned on the concatenation of all data splits, denoted SFT 52k")
SFT = {"SFT 10k", "SFT 52k"}
assert SFT <= {a[0] for a in trained}, [a[0] for a in trained]
print(f"  第 {l_sft10 + 1} 行：SFT 10k 是以 10k SFT split 微調的 LLaMA 7B，當作 LPF 方法的起點；"
      f"第 {l_sft52 + 1} 行：SFT 52k 以全部資料 split 微調。兩者都不經成對回饋訓練，"
      "精讀筆記（2305.14387 的 limitations_observed）據此指出這兩列兩欄只差在評估者")
for a in both:
    tag = "  （未訓練）" if a[3] else ("  （SFT，不經回饋）" if a[0] in SFT else "")
    print(f"    {a[0]:20s} 模擬 {a[1]:5.1f}  真人 {a[2]:5.1f}{tag}")
lpf = [a for a in trained if a[0] not in SFT]
report("AlpacaFarm 10 個系統", [a[0] for a in both], [a[1] for a in both], [a[2] for a in both])
report("AlpacaFarm 6 個自己訓練的方法", [a[0] for a in trained], [a[1] for a in trained], [a[2] for a in trained])
report(f"AlpacaFarm {len(lpf)} 個模擬回饋訓練對真人回饋重訓的方法", [a[0] for a in lpf], [a[1] for a in lpf], [a[2] for a in lpf])
rs10, d10 = spearman([a[1] for a in both], [a[2] for a in both])
rs6, d6 = spearman([a[1] for a in trained], [a[2] for a in trained])
l411 = find_line(AL, r"rankings have a Spearman correlation of 0\.98")
P098 = float(re.search(r"Spearman correlation of (\d\.\d+)", AL[l411]).group(1))
l368 = find_line(AL, r"Spearman Correlation of \$0\.94\$")
P094 = float(re.search(r"Spearman Correlation of \$(\d\.\d+)\$", AL[l368]).group(1))
print(f"  論文：第 {l411 + 1} 行 Spearman {P098}（全部系統）；第 {l368 + 1} 行拿掉未訓練的灰點後 Spearman {P094}")
print(f"  重算：10 個系統 1 − 6 × {d10} ÷ (10 × 99) = {rs10:.4f} → 四捨五入 {round(rs10, 2)}，與 {P098} {'相符' if round(rs10, 2) == P098 else '不符'}；"
      f"6 個 1 − 6 × {d6} ÷ (6 × 35) = {rs6:.4f} → 四捨五入 {round(rs6, 2)}，與 {P094} {'相符' if round(rs6, 2) == P094 else '不符'}")
m11 = find_line(AL, r"We use the same 11 systems as displayed in Figure 3")
print(f"  第 {m11 + 1} 行說 Figure 3 有 11 個系統，Table 2 兩欄都有值的只有 {len(both)} 個；若第 11 個點不增加對調，"
      f"1 − 6 × {d10} ÷ (11 × 120) = {1 - 6 * d10 / (11 * 120):.4f} → 四捨五入 {round(1 - 6 * d10 / (11 * 120), 2)}")
l412 = find_line(AL, r"we point out the two rank mismatches")
mm = [find_line(AL, r"The first comparison is SFT10k against SFT52k", l412), find_line(AL, r"The other mismatch is ChatGPT against PPO", l412)]
print(f"  第 {l412 + 1} 行起作者自己點名兩處名次對調：第 {mm[0] + 1} 行 SFT10k／SFT52k、第 {mm[1] + 1} 行 ChatGPT／PPO")

# ---------------- 總結 ----------------
t6_rows = [r for r in RESULTS if not r[0].startswith("AlpacaFarm")]
big = max(t6_rows, key=lambda r: r[1])
sig = [r for r in RESULTS if r[3] is not None and r[3] < 0.05]
print("\n名次一致方向的單尾 p < 0.05 的組：" + ("；".join(f"{r[0]}（n = {r[1]}，p = {r[3]:.3g}）" for r in sig) or "無"))
t5all = next(r for r in RESULTS if r[0] == "MetaSim T5 全部 7 個變體")
t5drop = next(r for r in RESULTS if r[0] == "MetaSim T5 拿掉 beta=0.1、gamma=0.01（事後排除）")
af10 = next(r for r in RESULTS if r[0] == "AlpacaFarm 10 個系統")
aflpf = next(r for r in RESULTS if r[0].startswith(f"AlpacaFarm {len(lpf)} 個"))
print(f"\n結論：T6 本身就有 {big[1]} 個系統的比較（{big[0]}），「最多 4 個系統」不成立；但 MetaSim 7 個變體的 τ = {t5all[2]:+.3f}，"
      f"只有事後拿掉 β=0.1 與 γ=0.01 兩格後才到 τ = {t5drop[2]:+.1f}（p = {t5drop[3]:.3f}），而那兩格正是與設計前提矛盾的格；"
      f"其餘 T6 比較只有 2–4 個系統，最小可能 p 分別是 1/2、1/6、1/24，其中只有 iEvaLM 的 τ = +1 碰到 1/24 < 0.05；"
      f"跨節點的 AlpacaFarm 以 {af10[1]} 個系統得到 τ = {af10[2]:+.3f}（Spearman {rs10:.2f}，與論文相符），"
      f"但它模擬的是單輪偏好標註者；其中 {sum(a[3] for a in both)} 個是未訓練的參照模型、{len(SFT)} 個 SFT 不經回饋，兩欄都只差在評估者，"
      f"真正是模擬回饋訓練對真人回饋重訓的 {aflpf[1]} 個方法 τ = {aflpf[2]:+.0f}，而 {aflpf[1]} 個系統完全排對的機率本來就有 1/{math.factorial(aflpf[1])}。")
