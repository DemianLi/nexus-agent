#!/usr/bin/env python3
"""驗證：三條「論文自己的數字寫錯」的主張（缺口 C12）。

主張（章節 05-self-correction-reflection.md 陷阱一、陷阱三、陷阱九）：
  A. RISE（2407.18219）Table 2 自我蒸餾版 Mistral 那一列標 +6.6 與 +15.9，
     但同列 m1@t1 是 36.8，39.5 − 36.8 = 2.7、48.7 − 36.8 = 11.9；引言「Mistral-7B 提升 6.6%」就來自這一格。
  B. SCoRe（2409.12917）§6.1：
     B1「修好 14.5%、base 9.5%」：依 Table 2，base 應為 4.6 ÷ (100 − 52.6) ≈ 9.7；
     B2「相對 Pair-SFT 分別提升 10.2% 與 2.6%」（依序 Δ 與 Acc@t2）順序反了；
     B3 HumanEval 的 Δ 增益依 Table 3 是 12.2 − 3.0 = 9.2，摘要寫 9.1。
  C. Self-Refine（2303.17651）Table 7 標為 Self-Refine 的 GSM8K 94.5，高於 Table 9 的 oracle 版 93.8。
出處：各篇精讀筆記 notes/<id>.json 的 limitations_observed。

輸入從哪來：全部由本程式從 .cache/text/<id>.txt 解析；以表題為錨點，對表頭與列名做 assert，
輸出附行號。這類表格在快取裡是「以空行分組、每組第一行是列名、其後一行一格」的格式。

對照組（證明解析沒有比錯欄，不計入子主張）：
  - RISE Table 2 的 Llama-3-8B 兩列、Mistral 基礎列，括號差值都應等於「該格 − 同列 m1@t1」（寫在 A1 裡）。
  - RISE 引言同一句的「LLaMa3-8B 提升 8.2%」應等於 Llama-3 自我蒸餾列 m1@t5 的括號值，而且那一格自洽（A2c）。
  - SCoRe §6.1 同一句的「Δ 提升 15.6%、Acc@t2 提升 23.0%」（對 base）應與 Table 2 相符（B0）；
    摘要與引言的 MATH「15.6%」也應等於 Table 2 算出的值（寫在 B3 裡）。

判定分三種：證實、不成立、無法判定。「無法判定」只用在前提由資料確認、但表格本身分不出答案的子主張（A3）。
退出碼：沒有任何子主張「不成立」、而且對照組全部吻合，才回 0。

無隨機數，不需種子。只用標準函式庫。執行：python3 verify/05-author-table-errors.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXT = ROOT / ".cache" / "text"
NUM = re.compile(r"^(-?\d+(?:\.\d+)?)%?(?:\s*\(\s*(?:\$\\uparrow\$\s*)?([+-]?\d+(?:\.\d+)?)\s*\))?$")
verdicts = []


def load(pid):
    return (TEXT / f"{pid}.txt").read_text(encoding="utf-8").splitlines()


def find_line(lines, prefix, start=0):
    hits = [i for i in range(start, len(lines)) if lines[i].startswith(prefix)]
    assert hits, f"找不到以 {prefix!r} 開頭的行"
    return hits[0]


def groups(lines, a, b):
    """把 lines[a:b] 依空行切組；回傳 [(列名, 列名行號, [(值, 括號差, 行號), ...])]。"""
    out, cur = [], []
    for i in range(a, b):
        s = lines[i].strip()
        if not s:
            if cur:
                out.append(cur)
                cur = []
            continue
        cur.append((i + 1, s))
    if cur:
        out.append(cur)
    res = []
    for g in out:
        if not g[0][1].startswith("|"):
            continue
        label = g[0][1].lstrip("|").strip()
        cells = []
        for ln, s in g[1:]:
            m = NUM.match(s.lstrip("|").strip())
            if m:
                cells.append((float(m.group(1)), float(m.group(2)) if m.group(2) else None, ln))
        res.append((label, g[0][0], cells))
    return res


def verdict(tag, status, text, control=False):
    """status：True／False 或 "無法判定"。control=True 的是對照組，不計入子主張。"""
    if status is True:
        label = "對照組吻合" if control else "證實"
    elif status is False:
        label = "對照組不吻合" if control else "不成立"
    else:
        label = status
    verdicts.append((tag, label, control))
    print(f"  [{tag}] {label}：{text}")


# ---------- A. RISE Table 2 ----------
print("== A. RISE（2407.18219）Table 2：自我蒸餾版 ==")
L = load("2407.18219")
cap = find_line(L, "Table 2: RISE with self-distillation on GSM8K")
head = max(i for i in range(cap) if L[i].strip() == "| RISE (Self)")
g = groups(L, head, cap)
hdr = [s for s in (L[i].strip() for i in range(head, head + 12)) if s.startswith("| ")]
assert "| m1@t1" in [h for h in hdr] or any("m1@t1" in h for h in hdr), "表頭找不到 m1@t1"
# 同名「+ Iteration 1」出現兩次，依出現順序拆開
seq = [(lab, cells) for lab, _, cells in g if len(cells) == 4]
names = ["Mistral-7B", "Mistral-7B + Iter1（自我蒸餾）", "Llama-3-8B", "Llama-3-8B + Iter1（自我蒸餾）"]
assert [lab for lab, _ in seq] == ["Mistral-7B", "+ Iteration 1", "Llama-3-8B", "+ Iteration 1"], [lab for lab, _ in seq]
cols = ["m1@t1", "m5@t1", "m1@t5", "p1@t5"]
bad_rows = []
for name, (_, cells) in zip(names, seq):
    base = cells[0][0]
    parts = []
    mism = []
    for c, (v, d, ln) in zip(cols[1:], cells[1:]):
        calc = round(v - base, 1)
        ok = d is not None and abs(calc - d) < 0.051
        parts.append(f"{c} {v}（第 {ln} 行）括號 {d:+} ，實算 {v} − {base} = {calc:+}{'' if ok else '  ← 不符'}")
        if not ok:
            mism.append(c)
    print(f"  {name}：m1@t1 = {base}（第 {cells[0][2]} 行）")
    for p in parts:
        print("     ", p)
    if mism:
        bad_rows.append((name, mism))
print(f"  括號差值對不上的列：{bad_rows}")
verdict("A1", bad_rows == [("Mistral-7B + Iter1（自我蒸餾）", ["m1@t5", "p1@t5"])],
        "只有自我蒸餾版 Mistral 列的 m1@t5（+6.6 對 39.5 − 36.8 = 2.7）與 p1@t5（+15.9 對 48.7 − 36.8 = 11.9）"
        "對不上；同列的 m5@t1（+7.6）與 Llama-3 兩列、Mistral 基礎列全部自洽（對照組）")
intro = [i for i, l in enumerate(L) if "RISE improves the performance of LLaMa3-8B by" in l]
assert len(intro) == 1, f"引言句應恰好一處，找到 {len(intro)} 處"
im = re.search(r"LLaMa3-8B by (\d+(?:\.\d+)?)% and Mistral-7B by (\d+(?:\.\d+)?)%", L[intro[0]])
assert im, "引言句的兩個數字解析不到"
intro_llama, intro_mistral = float(im.group(1)), float(im.group(2))
print(f"  引言第 {intro[0] + 1} 行：LLaMa3-8B 提升 {intro_llama}%、Mistral-7B 提升 {intro_mistral}%")
mis_t5 = seq[1][1][2]   # 自我蒸餾版 Mistral 的 m1@t5：(值, 括號差, 行號)
mis_base = seq[1][1][0][0]
mis_calc = round(mis_t5[0] - mis_base, 1)
verdict("A2", intro_mistral == mis_t5[1] and mis_t5[1] != mis_calc,
        f"引言的 {intro_mistral}% 等於 Table 2 自我蒸餾版 Mistral m1@t5 的括號值 {mis_t5[1]:+}（第 {mis_t5[2]} 行），"
        f"不等於同列絕對值算出的 {mis_t5[0]} − {mis_base} = {mis_calc:+}；所以引言沿用的是這一格的括號值")
lla_t5 = seq[3][1][2]   # 自我蒸餾版 Llama-3 的 m1@t5
lla_base = seq[3][1][0][0]
lla_calc = round(lla_t5[0] - lla_base, 1)
verdict("A2c", intro_llama == lla_t5[1] and abs(lla_t5[1] - lla_calc) < 0.051,
        f"同一句的 LLaMa3-8B {intro_llama}% 等於 Llama-3 自我蒸餾列 m1@t5 的括號值 {lla_t5[1]:+}（第 {lla_t5[2]} 行），"
        f"而那一格自洽（{lla_t5[0]} − {lla_base} = {lla_calc:+}）；引言兩個數字取的是同一欄", control=True)
# A3：哪一個錯。前提：矛盾只在 m1@t5／p1@t5，而同列 m5@t1 與 m1@t1 自洽
m5 = seq[1][1][1]
m5_ok = abs(round(m5[0] - mis_base, 1) - m5[1]) < 0.051
premise = m5_ok and dict(bad_rows).get("Mistral-7B + Iter1（自我蒸餾）") == ["m1@t5", "p1@t5"]
verdict("A3", "無法判定" if premise else False,
        f"同列 m5@t1 {m5[0]} − {mis_base} = {round(m5[0] - mis_base, 1):+} 與括號 {m5[1]:+} 自洽，m1@t1 可信；"
        "矛盾只在 m1@t5／p1@t5 的絕對值或它們的括號值，兩者至少一個錯，表格本身分不出是哪一個。若絕對值正確，提升只有 "
        f"{mis_calc}")

# ---------- B. SCoRe §6.1 ----------
print("\n== B. SCoRe（2409.12917）§6.1 與 Table 2、Table 3 ==")
L = load("2409.12917")
c2 = find_line(L, "Table 2: Performance of SCoRe on MATH")
c3 = find_line(L, "Table 3: Performance of SCoRe on HumanEval")
t2 = {lab: cells for lab, _, cells in groups(L, c2 + 1, c2 + 45) if len(cells) == 5}
assert set(t2) >= {"Base model", "SCoRe (Ours)"} and any(k.startswith("Pair-SFT") for k in t2), list(t2)
pair = [k for k in t2 if k.startswith("Pair-SFT")][0]
b, s, p = t2["Base model"], t2["SCoRe (Ours)"], t2[pair]
# 欄位：Acc@t1, Acc@t2, Δ, Δi→c, Δc→i
print(f"  Table 2：Base {[c[0] for c in b]}（第 {b[0][2]}–{b[-1][2]} 行）")
print(f"           SCoRe {[c[0] for c in s]}（第 {s[0][2]}–{s[-1][2]} 行）")
print(f"           Pair-SFT {[c[0] for c in p]}（第 {p[0][2]}–{p[-1][2]} 行）")
sent = [i for i, l in enumerate(L) if "by 10.2% and 2.6% respectively" in l]
fix = [i for i, l in enumerate(L) if "14.5%, compared to 9.5% for base" in l]
assert sent and fix, "§6.1 原句找不到"
print(f"  §6.1 第 {sent[0] + 1} 行：{L[sent[0]][:150]}…")
print(f"  §6.1 第 {fix[0] + 1} 行：…{L[fix[0]][L[fix[0]].index('(14.5%'):][:40]}…")
# 對照組：對 base 的 15.6 與 23.0
d_base = round(s[2][0] - b[2][0], 1)
a_base = round(s[1][0] - b[1][0], 1)
verdict("B0", d_base == 15.6 and a_base == 23.0,
        f"Δ 提升 {s[2][0]} − ({b[2][0]}) = {d_base}、Acc@t2 提升 {s[1][0]} − {b[1][0]} = {a_base}，與 §6.1 的 15.6%、23.0% 相符，欄位解析正確",
        control=True)
score_rate = round(s[3][0] / (100 - s[0][0]) * 100, 2)
base_rate = round(b[3][0] / (100 - b[0][0]) * 100, 2)
print(f"  B1：SCoRe {s[3][0]} ÷ (100 − {s[0][0]}) = {score_rate}%；base {b[3][0]} ÷ (100 − {b[0][0]}) = {base_rate}%")
verdict("B1", abs(score_rate - 14.5) < 0.05 and abs(base_rate - 9.5) > 0.15,
        f"14.5% 吻合，base 以同一分母算是 {base_rate:.1f}%，不是 9.5%")
alt = round(b[3][0] / (100 - b[1][0]) * 100, 2)
print(f"      （旁證：若誤用 Acc@t2 當分母，{b[3][0]} ÷ (100 − {b[1][0]}) = {alt}%，也不是 9.5%）")
d_pair = round(s[2][0] - p[2][0], 1)
a_pair = round(s[1][0] - p[1][0], 1)
print(f"  B2：相對 Pair-SFT，Δ 多 {s[2][0]} − {p[2][0]} = {d_pair}，Acc@t2 多 {s[1][0]} − {p[1][0]} = {a_pair}")
verdict("B2", d_pair == 2.6 and a_pair == 10.2, "原句依序寫「Δ、Acc@t2 分別提升 10.2% 與 2.6%」，實際是 2.6 與 10.2，順序寫反")
t3 = {lab: cells for lab, _, cells in groups(L, c3 + 1, c3 + 50) if len(cells) == 6}
assert set(t3) >= {"Base model", "SCoRe (Ours)"}, list(t3)
hb, hs = t3["Base model"], t3["SCoRe (Ours)"]
he = round(hs[3][0] - hb[3][0], 1)
print(f"  B3：Table 3 的 Δ：SCoRe {hs[3][0]}（第 {hs[3][2]} 行）− base {hb[3][0]}（第 {hb[3][2]} 行）= {he}")
# 摘要句跨行，先把前 130 行併成一段再解析
head_txt = " ".join(l.strip() for l in L[:130])
ma = re.search(r"improving the base models’ self-correction by (\d+\.\d)% and (\d+\.\d)% respectively on MATH and HumanEval", head_txt)
mi = re.search(r"absolute (\d+\.\d)% gain on self-correction for reasoning problems from MATH.{0,80}?absolute (\d+\.\d)% gain on coding problems from", head_txt)
assert ma and mi, "摘要或引言的 MATH／HumanEval 數字解析不到"
claims = {"摘要": (float(ma.group(1)), float(ma.group(2))), "引言": (float(mi.group(1)), float(mi.group(2)))}
for where, (vm, vh) in claims.items():
    print(f"      {where}：MATH {vm}%、HumanEval {vh}%")
math_ok = all(vm == d_base for vm, _ in claims.values())
he_wrong = all(vh != he for _, vh in claims.values())
verdict("B3", math_ok and he_wrong,
        f"摘要與引言的 MATH 數字都等於 Table 2 算出的 {d_base}（同句對照），HumanEval 都寫 "
        f"{'／'.join(str(vh) for _, vh in claims.values())}，依 Table 3 是 {hs[3][0]} − {hb[3][0]} = {he}（§6.1 另寫「9% higher」）")

# ---------- C. Self-Refine Table 7 vs Table 9 ----------
print("\n== C. Self-Refine（2303.17651）Table 7 對 Table 9 ==")
L = load("2303.17651")
c7 = find_line(L, "Table 7: Performance comparison of models on math reasoning")
c9 = find_line(L, "Table 9: Self-Refine results on Math Reasoning")
t7 = {lab: cells for lab, _, cells in groups(L, c7 - 40, c7) if len(cells) == 1}
t9 = {lab: cells for lab, _, cells in groups(L, c9 - 30, c9) if len(cells) == 6}
assert "Self-Refine w/ GPT-4" in t7 and "Math Reasoning (Oracle)" in t9 and "Math Reasoning" in t9, (list(t7), list(t9))
sr7 = {m: t7[f"Self-Refine w/ {m}"][0] for m in ("GPT-3.5", "ChatGPT", "GPT-4")}
orc = t9["Math Reasoning (Oracle)"]
non = t9["Math Reasoning"]
t9sr = {"GPT-3.5": (non[1], orc[1]), "ChatGPT": (non[3], orc[3]), "GPT-4": (non[5], orc[5])}
for m in sr7:
    v7, l7 = sr7[m][0], sr7[m][2]
    (vn, _, ln), (vo, _, lo) = t9sr[m]
    print(f"  {m}：Table 7 Self-Refine {v7}（第 {l7} 行）；Table 9 非 oracle {vn}（第 {ln} 行）、oracle {vo}（第 {lo} 行）")
g4_7, g4_o = sr7["GPT-4"][0], t9sr["GPT-4"][1][0]
verdict("C1", g4_7 > g4_o, f"Table 7 的 GPT-4 {g4_7} 高於 Table 9 的 oracle 版 {g4_o}；oracle 只在答錯時才改寫，照理應是上限")
diff = [m for m in sr7 if abs(sr7[m][0] - t9sr[m][0][0]) > 0.05]
verdict("C2", len(diff) == 3, f"三個模型的 Table 7 數字都不等於 Table 9 的非 oracle 版（{', '.join(diff)}），兩張表標同一個方法卻是不同的數")

from collections import Counter
claims_c = Counter(label for _, label, ctl in verdicts if not ctl)
ctl = [(t, label) for t, label, c in verdicts if c]
ctl_ok = all(label == "對照組吻合" for _, label in ctl)
parts = "、".join(f"{n} 個{k}" for k, n in claims_c.items())
undecided = [t for t, label, c in verdicts if not c and label == "無法判定"]
print(f"\n結論：{sum(claims_c.values())} 個子主張中 {parts}（無法判定：{', '.join(undecided) or '無'}）；"
      f"另有 {len(ctl)} 組對照組，{sum(label == '對照組吻合' for _, label in ctl)} 組吻合（{', '.join(t for t, _ in ctl)}）。")
sys.exit(0 if claims_c.get("不成立", 0) == 0 and ctl_ok else 1)
