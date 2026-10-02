#!/usr/bin/env python3
"""驗證：IPR（Watch Every Step!）的表格換算，以及它的 Table 2 與 ETO Table 2 的逐格對照。

主張（章節 04-agent-trajectory.md 中 IPR 的段落、〈頭條數字〉表與〈對前作的描述與前作自己的數字不符〉）：
  A. IPR 對 ETO 的差距是 WebShop 71.3 − 67.4 = 3.9、InterCodeSQL 61.3 − 57.2 = 4.1、ALFWorld seen 70.3 − 68.6 = 1.7、
     unseen 74.7 − 72.4 = 2.3、平均 69.4 − 66.4 = 3.0；論文寫的 5.8%／7.2%／2.5%／3.2%／4.5% 是相對比例，
     不是百分點 [arXiv:2406.11176]。Average 欄是四欄的算術平均。這幾個百分比出現在引言（只列 5.8%、7.2%、3.2%）
     與 §4.2（五個都有），摘要段落裡沒有任何百分比。
  F. （本章對照全文）§4.1 寫「The iteration cap is set to 4.」，Table 4 的消融卻有 Iteration=5 那一列。
  B. Table 4 的逐輪結果：WebShop 第 1、2 輪（63.6、63.7）都低於 ETO 的 67.4；各欄的最佳輪數不同
     （WebShop 第 4 輪、ALFWorld unseen 第 3 輪），Table 2 的 IPR 列就是逐欄取最佳；w/o s-DPO 的 WebShop 66.4 低於 ETO。
  C. ALFWorld unseen 的 +2.3 分在 134 題上約 2.3 × 134 ÷ 100 ≈ 3.1 題（主指標在 ALFWorld 是 0/1 的平均）。
  D. 附錄 C 的訓練時間 5.3 ÷ 2.5 ≈ 2.1 倍，對照 §5.3 的「三倍」與附錄 C 的「不到三倍」。
  E. （本章比對，筆記沒有寫）IPR Table 2 與 ETO Table 2 在 WebShop、ALFWorld seen、unseen 三欄重疊的
     七列（GPT-4、GPT-3.5-Turbo、未訓練 Llama-2-7B(-Chat)、SFT、RFT、PPO、ETO）共 21 格中，只有 SFT 的
     WebShop 不同（IPR 60.2、ETO 63.1），其餘 20 格一字不差 [arXiv:2406.11176][arXiv:2403.02502]。
     ETO 自己寫明固定輪數（WebShop 2 輪、ALFWorld 1 輪），IPR 的表註卻說 ETO 取各輪最佳。
     ETO 全文沒有 InterCode，所以 IPR 表中 PPO 的 InterCodeSQL 那一格不可能沿用自 ETO；IPR 的 Baselines 段
     說 SFT 是其他基線的起點。

輸入從哪來（全部由程式直接從快取全文解析，不手抄）：
  .cache/text/2406.11176.txt 的摘要、引言、§4.1、Table 1（資料集大小）、Table 2、Table 4、附錄 C；
  .cache/text/2403.02502.txt 的 Table 2 與「number of iterations」那一句。

只用標準函式庫；沒有隨機數。執行：python3 verify/04-ipr-tables.py（從研究根目錄或任何目錄都可以）
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "..", ".cache", "text")


def load(pid):
    with open(os.path.join(CACHE, pid + ".txt"), encoding="utf-8") as f:
        return f.read().split("\n")


IPR = load("2406.11176")
ETO = load("2403.02502")
NUM = re.compile(r"^-?\d+(?:\.\d+)?$")


def find(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def cells(lines, a, b):
    return [ln[1:].strip() for ln in lines[a:b] if ln.startswith("|")]


def rows_of(cs, k):
    """把「標籤＋k 個數字」的連續儲存格切成列。"""
    out = {}
    i = 0
    while i < len(cs):
        if not NUM.match(cs[i]) and i + k < len(cs) and all(NUM.match(c) for c in cs[i + 1:i + 1 + k]):
            out[cs[i]] = [float(c) for c in cs[i + 1:i + 1 + k]]
            i += 1 + k
        else:
            i += 1
    return out


ok_all = True


def check(cond, msg):
    global ok_all
    print(("  ✓ " if cond else "  ✗ ") + msg)
    ok_all = ok_all and cond


# ---------- IPR Table 2 ----------
s = find(IPR, r"^### 4\.2 Results")
e = find(IPR, r"^Table 2: Performance of different methods", s)
t2 = rows_of(cells(IPR, s, e), 5)
print(f"[IPR Table 2] 第 {s + 1}–{e + 1} 行，解析出 {len(t2)} 列：{list(t2)}")
COLS = ["WebShop", "InterCodeSQL", "ALFWorld seen", "ALFWorld unseen", "Average"]
ipr = t2["Llama-2-7B + IPR (ours)"]
eto = t2["Llama-2-7B + ETO (Song et al., 2024)"]
print("\n[A] IPR − ETO 與相對比例")
claimed = [5.8, 7.2, 2.5, 3.2, 4.5]
for j, c in enumerate(COLS):
    d = round(ipr[j] - eto[j], 1)
    rel = (ipr[j] - eto[j]) / eto[j] * 100
    print(f"  {c}: {ipr[j]} − {eto[j]} = {d}；相對 ({ipr[j]} − {eto[j]}) ÷ {eto[j]} = {rel:.2f}%（論文寫 {claimed[j]}%）")
    check(abs(round(rel, 1) - claimed[j]) < 0.051, f"{c} 的論文百分比是相對比例")
txt = "\n".join(IPR)
check("5.8%, 7.2%, 2.5% and 3.2%" in txt and "average improvement of 4.5%" in txt, "§4.2 原文寫的是這五個百分比")
# 這些百分比出現在哪幾段：摘要、引言、§4.2
abs_a = find(IPR, r"^###### Abstract")
intro_a = find(IPR, r"^## 1 Introduction", abs_a)
intro_b = find(IPR, r"^## 2 ", intro_a)
s42 = find(IPR, r"^### 4\.2 Results")
s42_b = find(IPR, r"^## 5 ", s42)
PCT = re.compile(r"\d+(?:\.\d+)?%")
abs_pct = PCT.findall("\n".join(IPR[abs_a:intro_a]))
intro_pct = PCT.findall("\n".join(IPR[intro_a:intro_b]))
s42_pct = PCT.findall("\n".join(IPR[s42:s42_b]))
print(f"  摘要（第 {abs_a + 1}–{intro_a} 行）的百分比：{abs_pct}")
print(f"  引言（第 {intro_a + 1}–{intro_b} 行）的百分比：{intro_pct}")
print(f"  §4.2（第 {s42 + 1}–{s42_b} 行）的百分比：{s42_pct}")
check(abs_pct == [], "摘要段落裡沒有任何百分比")
check(intro_pct == ["5.8%", "7.2%", "3.2%"], "引言只列 5.8%、7.2%、3.2% 三個")
check({"5.8%", "7.2%", "2.5%", "3.2%", "4.5%"} <= set(s42_pct), "§4.2 五個都有")
print("  Average 欄是否等於四欄算術平均：")
for name, v in t2.items():
    m = sum(v[:4]) / 4
    # 表上一位小數；29.65、41.95 這類剛好在 .x5 的值以「四捨五入（半數進位）」比對，所以容許 ±0.05
    good = abs(m - v[4]) <= 0.05 + 1e-9
    print(f"    {name}: ({' + '.join(str(x) for x in v[:4])}) ÷ 4 = {m:.3f}，表上 {v[4]} {'✓' if good else '✗'}")
    ok_all = ok_all and good

# ---------- IPR Table 4 ----------
s4 = find(IPR, r"^### 5\.2 Ablation Study")
e4 = find(IPR, r"^Table 4: Ablation study", s4)
t4 = rows_of(cells(IPR, s4, e4), 3)
print(f"\n[B] IPR Table 4，第 {s4 + 1}–{e4 + 1} 行，解析出 {list(t4)}")
its = {k: v for k, v in t4.items() if k.startswith("Iteration=")}
for j, c in enumerate(["WebShop", "InterCodeSQL", "ALFWorld unseen"]):
    seq = [its[f"Iteration={r}"][j] for r in range(1, 6)]
    best = max(range(5), key=lambda r: seq[r]) + 1
    print(f"  {c} 第 1–5 輪：{seq}，最佳是第 {best} 輪（{max(seq)}）")
check(its["Iteration=1"][0] < eto[0] and its["Iteration=2"][0] < eto[0],
      f"WebShop 第 1、2 輪 {its['Iteration=1'][0]}、{its['Iteration=2'][0]} 都低於 ETO 的 {eto[0]}")
check(its["Iteration=4"][0] == ipr[0] and its["Iteration=3"][2] == ipr[3] and its["Iteration=4"][2] < ipr[3],
      f"Table 2 的 WebShop {ipr[0]} 是第 4 輪、ALFWorld unseen {ipr[3]} 是第 3 輪（第 4 輪只有 {its['Iteration=4'][2]}）")
check(t4["w/o s-DPO"][0] < eto[0], f"w/o s-DPO 的 WebShop {t4['w/o s-DPO'][0]} 低於 ETO 的 {eto[0]}")
print(f"  w/o SFT 的 InterCodeSQL {t4['w/o SFT'][1]}，對照 Table 2 的 SFT {t2['Llama-2-7B + SFT (Chen et al., 2023)'][1]}："
      f"{t2['Llama-2-7B + SFT (Chen et al., 2023)'][1]} − {t4['w/o SFT'][1]} = "
      f"{t2['Llama-2-7B + SFT (Chen et al., 2023)'][1] - t4['w/o SFT'][1]:.1f}")

# ---------- C：ALFWorld unseen 題數 ----------
print("\n[C] ALFWorld unseen 的題數換算")
m = re.search(r"divided into (\d+) seen cases and (\d+) unseen cases", txt)
unseen = int(m.group(2))
d = ipr[3] - eto[3]
print(f"  unseen 共 {unseen} 題；({ipr[3]} − {eto[3]}) × {unseen} ÷ 100 = {d * unseen / 100:.2f} 題")
check(abs(d * unseen / 100 - 3.1) < 0.05, "約 3.1 題")

# ---------- D：訓練時間 ----------
print("\n[D] 訓練時間")
m = re.search(r"SFT requires (\d+) hour, ETO requires ([\d.]+) hours, and IPR requires ([\d.]+) hours", txt)
sft_h, eto_h, ipr_h = (float(x) for x in m.groups())
print(f"  附錄 C：SFT {sft_h}、ETO {eto_h}、IPR {ipr_h} 小時；{ipr_h} ÷ {eto_h} = {ipr_h / eto_h:.2f}")
check("three times the ETO training duration" in txt and "less than three times that of ETO" in txt,
      "§5.3 寫「三倍」、附錄 C 寫「不到三倍」，兩句都在全文")
check("after three rounds of iteration, we use the time for three rounds" in txt.replace("\n", " "),
      "附錄 C 量的是 3 輪，而 Table 4 的 WebShop 最佳在第 4 輪")

# ---------- E：與 ETO Table 2 對照 ----------
print("\n[E] IPR Table 2 與 ETO Table 2 的重疊格")
se = find(ETO, r"^#### Training Setup")
ee = find(ETO, r"^Table 2:", se)
et2 = rows_of(cells(ETO, se, ee), 5)
print(f"  ETO Table 2，第 {se + 1}–{ee + 1} 行，解析出 {list(et2)}")
# ETO 欄：WebShop, SciWorld seen, SciWorld unseen, ALFWorld seen, ALFWorld unseen
pairs = [
    ("GPT-4 (Achiam et al., 2023)", "GPT-4"),
    ("GPT-3.5-Turbo (Ouyang et al., 2022)", "GPT-3.5-Turbo"),
    ("Llama-2-7B (Touvron et al., 2023)", "Llama-2-7B-Chat"),
    ("Llama-2-7B + SFT (Chen et al., 2023)", "Llama-2-7B-Chat + SFT"),
    ("Llama-2-7B + RFT (Yuan et al., 2023)", "Llama-2-7B-Chat + RFT"),
    ("Llama-2-7B + PPO (Schulman et al., 2017)", "Llama-2-7B-Chat + PPO"),
    ("Llama-2-7B + ETO (Song et al., 2024)", "Llama-2-7B-Chat + ETO (ours)"),
]
same = diff = 0
diffs = []
for a, b in pairs:
    x, y = t2[a], et2[b]
    trip = [(x[0], y[0], "WebShop"), (x[2], y[3], "ALFWorld seen"), (x[3], y[4], "ALFWorld unseen")]
    for u, v, c in trip:
        if u == v:
            same += 1
        else:
            diff += 1
            diffs.append(f"{b} 的 {c}：IPR {u}、ETO {v}")
    print(f"  {b:32s} IPR {x[0]}/{x[2]}/{x[3]}  ETO {y[0]}/{y[3]}/{y[4]}")
print(f"  共 {same + diff} 格，相同 {same} 格，不同 {diff} 格：{diffs}")
check(same == 20 and diff == 1 and diffs == ["Llama-2-7B-Chat + SFT 的 WebShop：IPR 60.2、ETO 63.1"],
      "21 格中只有 SFT 的 WebShop 不同")
etxt = "\n".join(ETO)
check("The number of iterations of ETO is set to 2 for WebShop and ScienceWorld, 1 for ALFWorld" in etxt,
      "ETO 全文寫明固定輪數：WebShop 2、ALFWorld 1")
check("For ETO and IPR, we report the best performance across all iterations" in txt,
      "IPR 的表註寫 ETO 與 IPR 都取各輪最佳")
check("Llama-2-7B-Chat" in etxt and "We utilize Llama-2-7B (Touvron et al., 2023) as the base model" in txt,
      "ETO 用 Llama-2-7B-Chat，IPR 寫 Llama-2-7B")
# PPO 列的 InterCodeSQL 那一格：ETO 全文沒有 InterCode，所以這一格不可能沿用自 ETO
check("InterCode" not in etxt, f"ETO 全文沒有 InterCode，IPR 表中 PPO 的 InterCodeSQL {t2['Llama-2-7B + PPO (Schulman et al., 2017)'][1]} 來源不明")
check("which is the base agent of other baselines" in txt.replace("\n", " "),
      "IPR 的 Baselines 段說 SFT 是其他基線的起點（但 IPR 的 SFT WebShop 與 ETO 的不同）")

# ---------- F：迭代上限與 Table 4 ----------
print("\n[F] §4.1 的迭代上限與 Table 4 的輪數")
s41 = find(IPR, r"^### 4\.1 Experiment Settings")
cap_line = find(IPR, r"The iteration cap is set to (\d+)\.", s41)
cap = int(re.search(r"The iteration cap is set to (\d+)\.", IPR[cap_line]).group(1))
max_it = max(int(k.split("=")[1]) for k in its)
print(f"  §4.1 第 {cap_line + 1} 行：迭代上限 {cap}；Table 4 的迭代列：{sorted(its)}，最大是 {max_it}")
check(cap == 4 and max_it == 5, "§4.1 寫上限 4 輪，Table 4 卻報到第 5 輪")

print()
print("判定：" + ("證實（A–F 全部成立；E、F 是本章比對的新發現）" if ok_all else "有主張不成立，見上方 ✗"))
