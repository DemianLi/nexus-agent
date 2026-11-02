#!/usr/bin/env python3
"""驗證：Olausson et al.（2306.09896）人寫回饋實驗的 Table 1 由附錄 E 重算，以及 competition 欄由單一程式主導。

主張（章節 05-self-correction-reflection.md，精讀筆記 limitations_observed 的分析）：
  A. 附錄 E 的逐程式計數（每格是 25 個修復候選中通過全部測試的個數）加總後，逐難度重現 Table 1 的
     GPT-4 回饋與人寫回饋成功率，以及正文「整體 1.58 倍」。
  B. competition 欄人類 44/300、GPT-4 11/300；其中人類 35 次、GPT-4 8 次來自任務 3286 的程式 A 一個程式。
     去掉這個程式後是人類 9/250（3.6%）對 GPT-4 3/250（1.2%）。
  C. 整體成功率有 70% 的權重來自 introductory（14 題 / 20 題）。
  D. 同一個程式、同一方的兩則回饋，有不少組一則幾乎全過、一則幾乎全不過（門檻：一則 ≥ 20/25、另一則 ≤ 5/25）。

輸入：.cache/text/2306.09896.txt（Table 1 在「Table 1: Success rate of repair」之後；附錄 E 在
「## Appendix E」與「## Appendix F」之間）、notes/2306.09896.json（核對筆記寫下的重算數字）。
無隨機數，不需種子。只用標準函式庫。執行（研究根目錄）：python3 verify/05-selfrepair-human-study.py
"""

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
text = (ROOT / ".cache" / "text" / "2306.09896.txt").read_text(encoding="utf-8")
lines = text.splitlines()
note = json.loads((ROOT / "notes" / "2306.09896.json").read_text(encoding="utf-8"))
note_s = json.dumps(note, ensure_ascii=False)
verdicts = []


def verdict(tag, ok, msg):
    verdicts.append((tag, ok))
    print(f"  [{tag}] {'證實' if ok else '不成立'}：{msg}")


def find_line(pat, start=0):
    for i in range(start, len(lines)):
        if re.search(pat, lines[i]):
            return i
    raise SystemExit(f"找不到：{pat}")


# ---------- Table 1 ----------
print("== Table 1（論文表格） ==")
t1 = find_line(r"^Table 1: Success rate of repair")
gi = find_line(r"^\| GPT-4 Feedback", t1)
hi = find_line(r"^\| Human Feedback", t1)
DIFFS = ["introductory", "interview", "competition", "overall"]
t1_gpt = [float(lines[gi + 1 + k].strip("| %")) for k in range(4)]
t1_hum = [float(lines[hi + 1 + k].strip("| %")) for k in range(4)]
print(f"  第 {gi + 1} 行起 GPT-4：{t1_gpt}")
print(f"  第 {hi + 1} 行起 人類：{t1_hum}")
r158 = find_line(r"increased by \$1\.58\\times\$")
print(f"  第 {r158 + 1} 行：正文寫 1.58 倍")

# ---------- 附錄 E ----------
print("\n== 附錄 E（逐程式計數） ==")
e0 = find_line(r"^## Appendix E ")
e1 = find_line(r"^## Appendix F ", e0)
tok = [ln.strip()[1:].strip() for ln in lines[e0:e1] if ln.strip().startswith("|")]
hdr = tok.index("Human #2")
tok = tok[hdr + 1:]
rows = []  # (task, difficulty, program, g1, g2, h1, h2)
i = 0
task = diff = None
while i < len(tok):
    if re.fullmatch(r"\d{4}", tok[i]):
        task, diff = tok[i], tok[i + 1]
        i += 2
    prog = tok[i]
    assert prog in ("A", "B"), (i, tok[i])
    vals = [int(x) for x in tok[i + 1:i + 5]]
    rows.append((task, diff, prog, *vals))
    i += 5
tasks = sorted({r[0] for r in rows})
print(f"  第 {e0 + 1}–{e1} 行解析出 {len(rows)} 個程式、{len(tasks)} 題")

agg = defaultdict(lambda: [0, 0, 0])  # difficulty -> [gpt4, human, n_programs]
for t, d, p, g1, g2, h1, h2 in rows:
    for key in (d, "overall"):
        agg[key][0] += g1 + g2
        agg[key][1] += h1 + h2
        agg[key][2] += 1
ok_a = True
for k, d in enumerate(DIFFS):
    g, h, n = agg[d]
    denom = n * 2 * 25
    pg, ph = 100 * g / denom, 100 * h / denom
    same = round(pg, 2) == t1_gpt[k] and round(ph, 2) == t1_hum[k]
    ok_a &= same
    print(f"  {d:12s} 程式 {n:2d} 個：GPT-4 {g}/{denom} = {pg:.2f}%（表 {t1_gpt[k]}%）；"
          f"人類 {h}/{denom} = {ph:.2f}%（表 {t1_hum[k]}%）；比值 {ph / pg:.2f}")
ratio = t1_hum[3] / t1_gpt[3]
print(f"  整體比值 {t1_hum[3]} ÷ {t1_gpt[3]} = {ratio:.4f}")
verdict("A", ok_a and round(ratio, 2) == 1.58,
        "附錄 E 逐難度加總重現 Table 1 的八個數字，整體比值 52.60 ÷ 33.30 ≈ 1.58")

# ---------- B. competition 由 3286 A 主導 ----------
print("\n== B. competition 欄 ==")
comp = [r for r in rows if r[1] == "competition"]
for r in comp:
    print(f"    {r[0]} {r[2]}：GPT-4 {r[3]}+{r[4]}，人類 {r[5]}+{r[6]}")
cg, ch, cn = agg["competition"]
cden = cn * 50
big = [r for r in comp if r[0] == "3286" and r[2] == "A"][0]
bg, bh = big[3] + big[4], big[5] + big[6]
rg, rh, rden = cg - bg, ch - bh, cden - 50
print(f"  competition：人類 {ch}/{cden}、GPT-4 {cg}/{cden}；3286 A 一個程式佔人類 {bh}、GPT-4 {bg}")
print(f"  去掉 3286 A：人類 {rh}/{rden} = {100 * rh / rden:.1f}%，GPT-4 {rg}/{rden} = {100 * rg / rden:.1f}%，"
      f"差 {100 * (rh - rg) / rden:.1f} 個百分點")
verdict("B", (ch, cg, cden, bh, bg, rh, rg, rden) == (44, 11, 300, 35, 8, 9, 3, 250)
        and "9/250" in note_s and "3/250" in note_s,
        "人類 44/300、GPT-4 11/300 中 35 與 8 次來自 3286 A；去掉後是 9/250 對 3/250（與筆記一致）")

# ---------- C. introductory 的權重 ----------
print("\n== C. 整體成功率的權重 ==")
n_intro, n_all = agg["introductory"][2], agg["overall"][2]
share = n_intro / n_all
print(f"  introductory 程式 {n_intro} / 全部 {n_all} = {share:.0%}"
      f"（{len([t for t in tasks if any(r[0] == t and r[1] == 'introductory' for r in rows)])} 題 / {len(tasks)} 題）")
verdict("C", abs(share - 0.70) < 1e-9, "整體成功率有 70% 權重來自 introductory")

# ---------- D. 同一方兩則回饋的落差 ----------
print("\n== D. 同一程式、同一方的兩則回饋 ==")
split = []
for t, d, p, g1, g2, h1, h2 in rows:
    for side, a, b in (("GPT-4", g1, g2), ("人類", h1, h2)):
        if max(a, b) >= 20 and min(a, b) <= 5:
            split.append((t, p, side, a, b))
for s in split:
    print(f"    {s[0]} {s[1]} {s[2]}：{s[3]} 對 {s[4]}")
n_pairs = len(rows) * 2
print(f"  {len(split)} / {n_pairs} 組「同一程式、同一方」的兩則回饋，一則 ≥ 20/25、另一則 ≤ 5/25")
verdict("D", len(split) > 0, f"同一程式、同一方的兩則回饋有 {len(split)} / {n_pairs} 組兩極（一則 ≥ 20/25、另一則 ≤ 5/25）")

ok = all(v for _, v in verdicts)
print(f"\n結論：{sum(v for _, v in verdicts)}/{len(verdicts)} 項證實；Table 1 可由附錄 E 重現，"
      f"但 competition 欄的人寫回饋優勢主要來自 3286 A 一個程式（去掉後 {rh}/{rden} 對 {rg}/{rden}），"
      f"整體 1.58 倍有 {share:.0%} 權重在 introductory。")
sys.exit(0 if ok else 1)
