#!/usr/bin/env python3
"""驗證：GiGPO（Group-in-Group Policy Optimization）的表格換算與幾處自述數字。

主張（章節 04-agent-trajectory.md 中 GiGPO 的段落、〈頭條數字〉表與〈論文正文與自己的表格對不上〉）：
  A. 摘要與 §5.2 的「> 12%」「> 9%」是百分點差：1.5B 的 ALFWorld 整體 86.1 − 72.8 = 13.3、WebShop 成功率
     67.4 − 56.8 = 10.6；7B 是 90.2 − 77.6 = 12.6、75.2 − 66.1 = 9.1（GiGPO w/o std 對 GRPO）[arXiv:2505.10978]。
  B. §5.6 的新增計算時間：(0.01 + 0.53) ÷ 362.83 ≈ 0.15%，不是引言與 §5.6 寫的 < 0.002%（精讀時發現）。
     摘要只說幾乎不增加時間，沒有這個百分比（筆記把出處寫成「摘要、引言與 §5.6」，摘要那一處是錯的）。
  C. 附錄 E.5 的 ω = 1.0 那一列（83.5／67.4）與 Table 1 的 1.5B GiGPO w/o std WebShop 3 seed 平均完全相同；
     ω = 0.8 與 1.0 的成功率只差 68.3 − 67.4 = 0.9，小於 Table 1 該格的標準差 4.5（精讀時發現）。
  D. 附錄 E.4：DAPO 的 WebShop 分數 84.6 高於 Table 1 的 GiGPO w/o std 83.5；成功率只差 67.4 − 66.1 = 1.3（精讀時發現）。
  E. 1.5B 的 PPO 54.4 遠低於 7B 的 80.4，而 1.5B 的 GRPO 是 72.8（精讀時據此懷疑 PPO 沒調參）。
  F. 附錄 F.1 的 ALFWorld 範例裡，第 4 步與第 10 步走到 countertop 1 時，環境回傳的觀測一字不差，
     但兩步的持有物不同（第 10 步已拿著加熱過的蛋）；論文的 anchor state 以觀測相同為準（精讀時指出的混疊例子）。

輸入從哪來（全部由程式直接從 .cache/text/2505.10978.txt 解析，不手抄）：摘要、引言、Table 1、§5.6、Table 4（E.4）、
Table 5（E.5）、附錄 F.1。

只用標準函式庫；沒有隨機數。執行：python3 verify/04-gigpo-tables.py（從研究根目錄或任何目錄都可以）
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "..", ".cache", "text", "2505.10978.txt"), encoding="utf-8") as f:
    L = f.read().split("\n")
TXT = "\n".join(L)
VAL = re.compile(r"^(\d+(?:\.\d+)?)(?:±(\d+(?:\.\d+)?))?$")


def find(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(L)):
        if rx.search(L[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


ok_all = True


def check(cond, msg):
    global ok_all
    print(("  ✓ " if cond else "  ✗ ") + msg)
    ok_all = ok_all and cond


def parse_rows(a, b, k):
    """回傳 [(區段標題, 方法名, [(值, 標準差或 None)...])]；區段標題是「Qwen2.5-…」這種單格列。"""
    cs = [ln[1:].strip() for ln in L[a:b] if ln.startswith("|")]
    out, sect, i = [], None, 0
    while i < len(cs):
        c = cs[i]
        if c.startswith("Qwen2.5") and (i + 1 >= len(cs) or cs[i + 1] == ""):
            sect = c
            i += 2
            continue
        if not VAL.match(c) and i + k < len(cs) and all(VAL.match(x) for x in cs[i + 1:i + 1 + k]):
            vals = []
            for x in cs[i + 1:i + 1 + k]:
                m = VAL.match(x)
                vals.append((float(m.group(1)), float(m.group(2)) if m.group(2) else None))
            out.append((sect, c, vals))
            i += 1 + k
        else:
            i += 1
    return out


# ---------- Table 1 ----------
a = find(r"^Table 1: Performance on ALFWorld and WebShop")
b = find(r"^Table 1 demonstrates", a)
t1 = parse_rows(a, b, 9)
COLS = ["Pick", "Look", "Clean", "Heat", "Cool", "Pick2", "ALFWorld All", "WebShop Score", "WebShop Succ."]
T = {(s, m): v for s, m, v in t1}
print(f"[Table 1] 第 {a + 1}–{b} 行，解析出 {len(t1)} 列")
check("Results are averaged over 3 random seeds" in L[a], "表註寫明 RL 結果是 3 個 seed 的平均")
print("\n[A] GiGPO w/o std 對 GRPO 的差（百分點）")
claims = {("Qwen2.5-1.5B-Instruct", 6): 13.3, ("Qwen2.5-1.5B-Instruct", 8): 10.6,
          ("Qwen2.5-7B-Instruct", 6): 12.6, ("Qwen2.5-7B-Instruct", 8): 9.1}
for (sect, j), want in claims.items():
    g = T[(sect, "GiGPOw/o std")][j][0]
    r = T[(sect, "GRPO")][j][0]
    d = round(g - r, 1)
    print(f"  {sect} {COLS[j]}：{g} − {r} = {d}（相對 ({g} − {r}) ÷ {r} = {(g - r) / r * 100:.1f}%）")
    check(abs(d - want) < 1e-9, f"差 {want} 個百分點")
check("> 12% on ALFWorld and > 9% on WebShop over GRPO" in TXT, "摘要寫的是「> 12%」「> 9%」")
check("surpasses GRPO by 13.3% on ALFWorld and 10.6% on WebShop at 1.5B, and by 12.6% and 9.1%" in TXT.replace("\n", " "),
      "§5.2 把百分點差寫成百分比")

# ---------- B：計算時間 ----------
print("\n[B] §5.6 的新增計算時間")
m = re.search(r"reaches ([\d.]+)s per iteration", TXT)
total = float(m.group(1))
m1 = re.search(r"takes only ([\d.]+)s per iteration", TXT)
m2 = re.search(r"adds just\s+([\d.]+)s", TXT)
extra = float(m1.group(1)) + float(m2.group(1))
ratio = extra / total * 100
print(f"  ({m1.group(1)} + {m2.group(1)}) ÷ {total} = {ratio:.3f}%；若分母含新增部分：{extra / (total + extra) * 100:.3f}%")
check("< 0.002% of the total per-iteration training time" in TXT.replace("\n", " "), "§5.6 原文寫 < 0.002%")
# 「< 0.002%」出現在哪幾段：摘要、引言、§5.6
ab = find(r"^###### Abstract")
ia = find(r"^## 1 Introduction", ab)
ib = find(r"^## 2 ", ia)
s56 = find(r"^### 5\.6 ")
s56b = find(r"^## 6 ", s56)
hits = [i + 1 for i, ln in enumerate(L) if "0.002" in ln]
print(f"  「0.002」出現在第 {hits} 行；摘要第 {ab + 1}–{ia} 行、引言第 {ia + 1}–{ib} 行、§5.6 第 {s56 + 1}–{s56b} 行")
check(not any(ab <= h - 1 < ia for h in hits), "摘要段落裡沒有 0.002")
check(any(ia <= h - 1 < ib for h in hits) and any(s56 <= h - 1 < s56b for h in hits), "引言與 §5.6 各有一處")
check("little to no additional time cost" in "\n".join(L[ab:ia]).replace("\n", " "), "摘要只說幾乎不增加時間")
check(ratio > 0.002 * 50, f"實際比例 {ratio:.2f}% 是 0.002% 的 {ratio / 0.002:.0f} 倍")

# ---------- C：ω 敏感度 ----------
print("\n[C] 附錄 E.5 的 ω 敏感度")
a5 = find(r"^Table 5: Sensitivity analysis")
b5 = find(r"^As shown in Table 5", a5)
cs = [ln[1:].strip() for ln in L[a5:b5] if ln.startswith("|")]
omegas = [float(x) for x in cs[1:9]]
score = [float(x) for x in cs[10:18]]
succ = [float(x) for x in cs[19:27]]
print(f"  ω：{omegas}\n  Score：{score}\n  Succ.：{succ}")
i10, i08 = omegas.index(1.0), omegas.index(0.8)
g15 = T[("Qwen2.5-1.5B-Instruct", "GiGPOw/o std")]
check(score[i10] == g15[7][0] and succ[i10] == g15[8][0],
      f"ω = 1.0 的 {score[i10]}／{succ[i10]} 與 Table 1 的 1.5B GiGPO w/o std {g15[7][0]}／{g15[8][0]} 相同")
d = round(succ[i08] - succ[i10], 1)
print(f"  ω = 0.8 對 1.0 的成功率：{succ[i08]} − {succ[i10]} = {d}；Table 1 該格標準差 ±{g15[8][1]}")
check(d < g15[8][1], "差距小於一個標準差")
check("set to $1$ with no further tuning" in TXT or "fixed at 1 without further tuning" in TXT, "正文說 ω = 1 沒有調")

# ---------- D：DAPO ----------
print("\n[D] 附錄 E.4 與 DAPO")
a4 = find(r"^Table 4: Performance on WebShop using Qwen2.5-1.5B-Instruct")
b4 = find(r"^### E\.5", a4)
t4 = {m_: v for _, m_, v in parse_rows(a4, b4, 2)}
print(f"  Table 4：{ {k: [x[0] for x in v] for k, v in t4.items()} }")
dapo = t4["DAPO"]
check(dapo[0][0] > g15[7][0], f"DAPO 分數 {dapo[0][0]} 高於 GiGPO w/o std 的 {g15[7][0]}")
print(f"  成功率差：{g15[8][0]} − {dapo[1][0]} = {round(g15[8][0] - dapo[1][0], 1)}（GiGPO 標準差 ±{g15[8][1]}、DAPO ±{dapo[1][1]}）")
check(abs(round(g15[8][0] - dapo[1][0], 1) - 1.3) < 1e-9, "成功率只差 1.3")

# ---------- E：PPO ----------
print("\n[E] PPO 在兩個尺寸的 ALFWorld 整體成功率")
p15 = T[("Qwen2.5-1.5B-Instruct", "PPO (with critic)")][6][0]
p7 = T[("Qwen2.5-7B-Instruct", "PPO (with critic)")][6][0]
r15 = T[("Qwen2.5-1.5B-Instruct", "GRPO")][6][0]
r7 = T[("Qwen2.5-7B-Instruct", "GRPO")][6][0]
print(f"  PPO 1.5B {p15}、7B {p7}；GRPO 1.5B {r15}、7B {r7}")
check(p15 < r15 and p7 > r7, "PPO 在 1.5B 低於 GRPO、在 7B 高於 GRPO")
check("all RL training methods (including ours and the baselines) use exactly the same hyperparameter configurations" in TXT.replace("\n", " "),
      "正文說所有 RL 方法用完全相同的超參數")

# ---------- F：附錄 F.1 的觀測混疊 ----------
print("\n[F] 附錄 F.1 第 4 步與第 10 步的觀測")
s4 = find(r"^Environment \(Step 4\)")
s10 = find(r"^Environment \(Step 10\)", s4)


def obs(i):
    t = L[i].split(")", 1)[1].strip()
    j = i + 1
    while L[j].strip():
        t += " " + L[j].strip()
        j += 1
    return t


o4, o10 = obs(s4), obs(s10)
print(f"  第 4 步：{o4[:70]}…（{len(o4)} 字元）\n  第 10 步：{o10[:70]}…（{len(o10)} 字元）")
check(o4 == o10, "兩步的環境觀測一字不差")
check("You pick up the egg 1" in "\n".join(L[s4:s10]) and "You heat the egg 1" in "\n".join(L[s4:s10]),
      "第 4 步到第 10 步之間 agent 拿起蛋並加熱，兩步的持有物不同")

print()
print("判定：" + ("證實（A–F 全部成立）" if ok_all else "有主張不成立，見上方 ✗"))
