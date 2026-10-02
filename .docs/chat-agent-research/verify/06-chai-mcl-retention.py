#!/usr/bin/env python3
"""驗證：2303.06135（Chai，Rewarding Chatbots for Real-World Engagement with Millions of Users）
裡「對話長度（MCL）是投入度的代理」能不能撐住它自己的留存資料，以及幾個總結數字的可追溯性。

主張（精讀筆記 notes/2303.06135.json 的 limitations_observed）：
  a. Table 4 裡三種獎勵模型的 MCL 名次和 D30 留存名次不一致；retries 標籤的留存約是 continues 的兩倍。
  b. §5 規定只有 MCL 勝過先前最佳的系統才做留存實驗。
  c. 看起來是同一個 GPT-2 small both RM，在 Table 6 與 Pygmalion 實驗裡差約 9 個百分點，遠大於各自報的 ±。
  d. 摘要說 MCL 最多 +70%，內文最大是 +54.33%。
  e. 星等分布極度偏高；≥2 星標籤的正例比例。
  f. 資料量每 ×10 的效益是參數量每 ×10 的兩倍多。
  g. Table 2 與 Table 3 完全重複；正文留有佔位字。
出處：[arXiv:2303.06135]

輸入（全部由程式從 .cache/text/2303.06135.txt 解析）：Table 2–6、§6.4 的留存 ±、§6.5 的星等結果、§6.6 的 Pygmalion 句子、摘要、§5 的流程句。

方法：
  1. 名次直接比對；3 個 RM 的 Kendall τ 用逆序對數算。
  2. 兩個獨立實驗的差用 z = 差 ÷ √(±₁² + ±₂²)，把論文報的 ± 當標準誤（論文沒交代 ± 是標準誤還是信賴區間；
     若是 95% 信賴區間，z 要再乘約 1.96，結論方向不變）。
  3. 星等的「存活比例」由分布逐格累加重算，對照 Table 5 的欄位。

只用標準函式庫；沒有隨機數。執行：python3 verify/06-chai-mcl-retention.py（研究根目錄）
"""

import math
import os
import re
from itertools import combinations

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "..", ".cache", "text", "2303.06135.txt")
TEXT = open(PATH, encoding="utf-8").read()
L = TEXT.split("\n")


def find_line(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(L)):
        if rx.search(L[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def pipe_blocks(a, b):
    out, cur = [], []
    for i in range(a, b):
        s = L[i]
        if s.startswith("|"):
            c = s[1:].strip()
            if c:
                cur.append(c)
        elif not s.strip() and cur:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


PM = re.compile(r"\$?([+-][\d.]+)(?:\\pm\s*([\d.]+))?\\?%?\$?")


def val(cell):
    m = PM.search(cell)
    return float(m.group(1)), (float(m.group(2)) if m.group(2) else None)


# ---------------- 摘要與 §5 ----------------
la = find_line(r"increases the MCL by up to 70%")
lsel = find_line(r"For systems where the improvement in the mean conversation length is better than")
l5 = find_line(r"requests user ratings for 5% of responses")
print(f"第 {la + 1} 行（摘要）：MCL 最多 +70%、留存 +30% 以上")
print(f"第 {lsel + 1} 行（§5）：只有 MCL 勝過先前最佳 RM 的系統才做第二階段的留存實驗")
print(f"第 {l5 + 1} 行：平台只對 5% 的回覆請求評分")

# ---------------- Table 2／3 ----------------
t2 = find_line(r"^Table 2: Percentage improvement of MCL")
t3 = find_line(r"^Table 3: Percentage improvement of MCL", t2)
t1c = find_line(r"^Table 1: Percentage improvement of MCL")
b2 = pipe_blocks(t1c + 1, t2)
b3 = pipe_blocks(t2 + 1, t3)
b2 = [b for b in b2 if b[0] in ("Last response", "Retries")]
b3 = [b for b in b3 if b[0] in ("Last response", "Retries")]
print(f"\nTable 2（第 {t2 + 1} 行）與 Table 3（第 {t3 + 1} 行）的 {len(b2)} 列內容完全相同：{b2 == b3 and len(b2) == 5}；"
      f"三張表去掉表號後的標題字樣也相同：{L[t1c].split(':', 1)[1] == L[t2].split(':', 1)[1] == L[t3].split(':', 1)[1]}（都寫 GPT-2 large，而 Table 1 比的是 RoBERTa 與 GPT2 small）")
last12 = val(b2[0][2])

# ---------------- Table 4 與留存 ± ----------------
t4 = find_line(r"^Table 4: Improvement in metrics observed in the A/B experiment")
T4 = {}
for b in pipe_blocks(t4 - 30, t4):
    if b[0] in ("Continues", "Retries", "Both"):
        T4[b[0]] = [val(x)[0] for x in b[1:4]]
assert list(T4) == ["Continues", "Retries", "Both"], T4
lr = find_line(r"increases retention by \$\+12\.1\\pm 4\.4\\%\$")
ret_pm = [float(x) for x in re.findall(r"retention by \$\+[\d.]+\\pm ([\d.]+)\\%\$", L[lr] + " " + L[lr + 1])]
assert len(ret_pm) == 3, ret_pm
labels = list(T4)
mcl = [T4[k][0] for k in labels]
retry = [T4[k][1] for k in labels]
ret = [T4[k][2] for k in labels]
print(f"\nTable 4（第 {t4 + 1} 行；留存的 ± 取自第 {lr + 1}–{lr + 2} 行）：")
for k, pm in zip(labels, ret_pm):
    print(f"  {k:9s} MCL {T4[k][0]:+.1f}%  重抽率 {T4[k][1]:+.1f}%  D30 留存 {T4[k][2]:+.1f}±{pm}%")
o_mcl = sorted(labels, key=lambda k: -T4[k][0])
o_ret = sorted(labels, key=lambda k: -T4[k][2])
disc = sum((mcl[i] - mcl[j]) * (ret[i] - ret[j]) < 0 for i, j in combinations(range(3), 2))
tau = (3 - 2 * disc) / 3
print(f"  MCL 名次 {o_mcl}；留存名次 {o_ret}；逆序 {disc}/3 對，Kendall τ = (3 − 2 × {disc}) ÷ 3 = {tau:+.3f}")
print(f"  retries 的留存 ÷ continues 的留存 = {T4['Retries'][2]} ÷ {T4['Continues'][2]} = {T4['Retries'][2] / T4['Continues'][2]:.2f}；"
      f"MCL 則是 {T4['Continues'][0]} ÷ {T4['Retries'][0]} = {T4['Continues'][0] / T4['Retries'][0]:.1f} 倍反過來")
zr = (T4["Retries"][2] - T4["Continues"][2]) / math.sqrt(ret_pm[1] ** 2 + ret_pm[0] ** 2)
print(f"  留存差 retries − continues 的 z = ({T4['Retries'][2]} − {T4['Continues'][2]}) ÷ √({ret_pm[1]}² + {ret_pm[0]}²) = {zr:.2f}")
print(f"  重抽率降最多的是 {min(labels, key=lambda k: T4[k][1])}（不是以 no-retry 為目標的 Retries）")
# §5 的規則比的是「先前最佳 RM」的 MCL，不是 Table 4 三者互比；門檻 t 未知，所以列出每一種 t 下過得了關的集合
print(f"  §5 的規則（第 {lsel + 1} 行）比的是先前最佳 RM 的 MCL，不是三者互比；不論門檻 t 是多少，過關的一定是 MCL 排前幾名的：")
for k in range(4):
    adm = o_mcl[:k]
    lo = T4[o_mcl[k]][0] if k < 3 else None
    hi = T4[o_mcl[k - 1]][0] if k > 0 else None
    rng = (f"t ≥ {T4[o_mcl[0]][0]}" if k == 0 else
           f"{lo} ≤ t < {hi}" if k < 3 else f"t < {hi}")
    print(f"    {rng}：過關 {adm or '無'}" + (f"，其中留存最好的是 {max(adm, key=lambda x: T4[x][2])}" if adm else ""))
best_ret = o_ret[0]
need = o_mcl[:o_mcl.index(best_ret) + 1]
print(f"  留存最好的 {best_ret} 要過關，MCL 比它高的 {[x for x in need if x != best_ret]} 也一定過關；"
      f"門檻落在 {T4[best_ret][0]} 與 {T4[o_mcl[0]][0]} 之間時，只有留存最低的 {o_mcl[0]} 過得了")
print(f"  若先前最佳是 Table 2 的 12M 列 {last12[0]:+.2f}%，三者的 MCL 都低於它，照字面三者都進不了留存實驗")
lrun = find_line(r"We ran an A/B test of these three reward models plus the baseline")
print(f"  第 {lrun + 1} 行：Table 4 的三個 RM 其實都跑了 30 天的 A/B 並量了留存，這組實驗沒有照字面經過 §5 的閘門")
print(f"  同一個「延續」標籤：Table 2 的 12M 列 MCL {last12[0]:+.2f}±{last12[1]}%，Table 4 的 Continues {T4['Continues'][0]:+.1f}%，"
      f"相差 {last12[0] - T4['Continues'][0]:.2f} 個百分點（訓練量與量測期間論文沒交代是否相同）")

# ---------------- Table 6 與 Pygmalion ----------------
t6 = find_line(r"^Table 6: Percent improvement in mean conversation length")
T6 = {}
for b in pipe_blocks(t6 - 20, t6):
    if re.match(r"^[\d.]+[MB]$", b[0]):
        T6[b[0]] = val(b[1])
assert list(T6) == ["124M", "355M", "774M", "1.5B"], T6
lp = find_line(r"Pygmalion GPT-J chatbot gave an MCL improvement")
pyg = re.findall(r"\$\+([\d.]+)\\pm ([\d.]+)\\%\$", L[lp] + " " + L[lp + 1])
pyg = [(float(a), float(b)) for a, b in pyg]
assert len(pyg) == 3, pyg
own_rm, pyg_rm = pyg[1], pyg[2]
small = T6["124M"]
z = (own_rm[0] - small[0]) / math.sqrt(own_rm[1] ** 2 + small[1] ** 2)
print(f"\nTable 6（第 {t6 + 1} 行）：" + "、".join(f"{k} {v[0]:+.2f}±{v[1]}%" for k, v in T6.items()))
print(f"第 {lp + 1}–{lp + 2} 行（同一個 GPT-2 small RM 加在自家 GPT-J 上）：{own_rm[0]:+.2f}±{own_rm[1]}%")
print(f"  兩次的差 {own_rm[0]} − {small[0]} = {own_rm[0] - small[0]:.2f}；z = {own_rm[0] - small[0]:.2f} ÷ √({own_rm[1]}² + {small[1]}²) = {z:.2f}"
      f"（把 ± 當標準誤；兩次實驗的差超過各自報的不確定度）")
mx = max([pyg_rm[0], own_rm[0], last12[0]] + [v[0] for v in T6.values()])
print(f"  內文最大的 MCL 增幅 {mx:+.2f}%（Pygmalion 加 RM），摘要寫最多 +70%：內文{'有' if mx >= 70 else '沒有'}單一實驗到 70%")
lsc = find_line(r"increasing the number of parameters by a factor of ten gives an MCL improvement")
sc_txt = L[lsc] + " " + L[lsc + 1]
par10 = float(re.search(r"factor of ten gives an MCL improvement\s+of \$\+([\d.]+)\\pm", sc_txt).group(1))
dat10 = float(re.search(r"\$\+([\d.]+)\\pm [\d.]+\\%\$ increase in MCL improvement from increasing the dataset size", sc_txt).group(1))
print(f"第 {lsc + 1}–{lsc + 2} 行：資料量每 ×10 是 +{dat10}%、參數量每 ×10 是 +{par10}%，比值 {dat10} ÷ {par10} = {dat10 / par10:.2f}")

# ---------------- 星等 ----------------
t5 = find_line(r"^Table 5: The distribution of user ratings")
cells = [L[i][1:].strip() for i in range(t5 - 20, t5) if L[i].startswith("|") and L[i][1:].strip().endswith("%")]
frac = [float(c[:-1]) for c in cells[0::2]]
surv = [float(c[:-1]) for c in cells[1::2]]
assert len(frac) == 4 and len(surv) == 4, cells
calc = [round(sum(frac[i:]), 1) for i in range(4)]
print(f"\nTable 5（第 {t5 + 1} 行）：1–4 星比例 {frac}（合計 {sum(frac):.1f}%）；存活比例 {surv}；由分布從高星往下累加的存活比例 {calc}"
      f"（逐格差 ≤ 0.2，屬四捨五入：{all(abs(a - b) <= 0.2001 for a, b in zip(calc, surv))}）")
print(f"  ≥2 星標籤的正例比例 = 100 − {frac[0]} = {100 - frac[0]:.1f}%；≥3 星 = {surv[2]}%；4 星 = {surv[3]}%")
lst = find_line(r"two stars or more reward model improved the MCL by")
st = re.findall(r"\$\+([\d.]+)\\pm ([\d.]+)\\%\$", L[lst] + " " + L[lst + 1] + " " + L[lst + 2])
print(f"第 {lst + 1} 行起：≥2 星 / ≥3 星 / 4 星的 MCL {[float(a) for a, _ in st]}；"
      f"同一時期 Table 4 的 Continues 是 {T4['Continues'][0]}（星等 RM 的訓練列數論文沒報）")

# ---------------- 佔位字 ----------------
holders = {"can add a line here": r"can add a line here", "X M samples": r"X M\s+samples", "X% improvement": r"X% improvement",
           "section X": r"section X\b", "±X": r"\\pm X"}
found = {h: len(re.findall(rx, TEXT)) for h, rx in holders.items()}
print(f"\n佔位字出現次數：{found}")

print(f"\n結論：Table 4 的 MCL 名次 {o_mcl} 與留存名次 {o_ret} 有 {disc}/3 對逆序（τ = {tau:+.2f}），retries 的留存是 continues 的 "
      f"{T4['Retries'][2] / T4['Continues'][2]:.2f} 倍；§5 的規則比的是先前最佳 RM，照字面若先前最佳是 Table 2 的 {last12[0]:+.2f}%，"
      f"三者都進不了留存實驗，而 Table 4 三者其實都做了，這組實驗沒有照字面執行這條規則；同一 RM 兩次 A/B 相差 "
      f"{own_rm[0] - small[0]:.2f} 個百分點（z = {z:.2f}），± 低估了實驗間變異；內文最大 {mx:+.2f}%，摘要的 70% 沒有單一實驗支撐；"
      f"≥2 星標籤 {100 - frac[0]:.1f}% 是正例；Table 2／3 重複、佔位字 {sum(1 for v in found.values() if v)} 種仍在。")
