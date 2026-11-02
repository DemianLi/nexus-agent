#!/usr/bin/env python3
"""驗證：GUI-R1 Table 3 的 GPT-4o、OS-Atlas-4B、OS-Atlas-7B 三列，與 OS-ATLAS 原論文逐位相同。

主張（章節 03-agent-observation.md〈爭議〉「照抄的基線」）：
  GUI-R1 的表註說所有實驗在同一個零樣本提示下進行；精讀時對照 OS-Atlas 原論文發現，Table 3 的
  GPT-4o、OS-Atlas-4B、OS-Atlas-7B 三列共 18 個數字逐位相同，是直接引用。
出處：[arXiv:2504.10458] 筆記 limitations_observed；[arXiv:2410.23218] Table 5。

輸入（程式從快取全文解析並印出行號）：
  - .cache/text/2504.10458.txt 的 Table 3（AndroidControl-High 與 GUI-Odyssey 的 Type／GR／SR，外加 Overall）。
  - .cache/text/2410.23218.txt 的 Table 5（AndroidControl-Low、AndroidControl-High、GUI-Odyssey 各 Type／
    Grounding／SR），含分組標題（Zero-shot OOD Setting／Supervised Fine-tuning Setting）。

方法：
  1. 兩張表都以表題當錨點，把「名稱＋固定個數的數字」組成列；斷言列名與欄數。
  2. GUI-R1 每列前 6 個數字（High 的三欄、Odyssey 的三欄）對 OS-ATLAS 同名列的第 4–9 個數字逐位比對。
     OS-ATLAS 的 OS-Atlas-4B／7B 在零樣本與微調兩組各出現一次，兩組都比，看 GUI-R1 抄的是哪一組。
  3. 對照組：GUI-R1 自己跑的列（QwenVL2.5-3B／7B、GUI-R1-3B／7B）的數字，在 OS-ATLAS Table 5 裡出現幾個。
  4. 記下兩邊的分組標題：GUI-R1 把這些列放在哪一組、OS-ATLAS 原本放在哪一組；以及 GUI-R1 表題的
     「same zero-shot prompt」原文。兩邊的分組不在同一個軸上：GUI-R1 依模型的訓練方式分組（SFT 組裡也有
     在 GUI-R1-3K 上微調的 QwenVL2.5*），OS-ATLAS 依評估設定分組（有沒有在 AndroidControl／GUI-Odyssey 上
     微調）。所以這一段只陳列事實，不判定分組對錯。

沒有用到隨機數。只用標準函式庫。執行：python3 verify/03-guir1-osatlas-copy.py（從研究根目錄）
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
GUIR1 = os.path.join(ROOT, ".cache", "text", "2504.10458.txt")
ATLAS = os.path.join(ROOT, ".cache", "text", "2410.23218.txt")
NUM = re.compile(r"^\d+(?:\.\d+)?$")


def load(p):
    with open(p, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit("找不到：" + pattern)


def toks(lines, lo, hi):
    out = []
    for i in range(lo, hi):
        s = lines[i].strip()
        if s.startswith("|"):
            s = s[1:].strip()
        if s:
            out.append((i + 1, s))
    return out


def rows(tk, width, group_labels):
    out, group = [], None
    j = 0
    while j < len(tk):
        ln, t = tk[j]
        if t in group_labels:
            group = t
            j += 1
            continue
        nxt = [tk[j + d][1] for d in range(1, width + 1) if j + d < len(tk)]
        if not NUM.match(t) and len(nxt) == width and all(NUM.match(x) for x in nxt):
            out.append((t, nxt, ln, group))
            j += width + 1
            continue
        j += 1
    return out


def main():
    g = load(GUIR1)
    a = load(ATLAS)

    # ---- GUI-R1 Table 3 ----
    g_lo = find_line(g, r"^Table 3: GUI high-level task accuracy")
    g_hi = find_line(g, r"^### 4\.3 Ablation Study", g_lo)
    caption = g[g_lo].strip()
    g_groups = {"Supervised Fine-Tuning", "Zero Shot", "Reinforcement Fine-Tuning"}
    g_rows = rows(toks(g, g_lo + 1, g_hi), 7, g_groups)
    print("=== GUI-R1 Table 3（第 %d–%d 行）===" % (g_lo + 1, g_hi))
    m = re.search(r"All experiments are conducted under the same zero-shot prompt for fair comparison", caption)
    print("  表題原文含「same zero-shot prompt for fair comparison」：" + ("是" if m else "否"))
    for name, v, ln, grp in g_rows:
        print("  [%s] %-15s %s（第 %d 行）" % (grp, name, " ".join(v), ln))
    names = [r[0] for r in g_rows]
    assert names == ["OS-Atlas-4B", "OS-Atlas-7B", "QwenVL2.5-3B*", "QwenVL2.5-7B*", "GPT-4o", "QwenVL2.5-3B",
                     "QwenVL2.5-7B", "UI-R1-3B", "GUI-R1-3B", "GUI-R1-7B"], names

    # ---- OS-ATLAS Table 5 ----
    a_cap = find_line(a, r"^Table 5: Results on mobile tasks")
    a_lo = find_line(a, r"Zero-shot OOD Setting", a_cap - 120)
    a_groups = {"Zero-shot OOD Setting", "Supervised Fine-tuning Setting"}
    a_rows = rows(toks(a, a_lo, a_cap), 9, a_groups)
    print("\n=== OS-ATLAS Table 5（第 %d–%d 行，表題在第 %d 行）===" % (a_lo + 1, a_cap, a_cap + 1))
    for name, v, ln, grp in a_rows:
        print("  [%s] %-13s %s（第 %d 行）" % (grp, name, " ".join(v), ln))
    assert len(a_rows) == 8, len(a_rows)

    # ---- 逐位比對 ----
    print("\n=== 逐位比對：GUI-R1 前 6 格 vs OS-ATLAS 第 4–9 格（AndroidControl-High、GUI-Odyssey）===")
    total_same = 0
    copied_from = {}
    for name in ("GPT-4o", "OS-Atlas-4B", "OS-Atlas-7B"):
        gv = next(v for n, v, _, _ in g_rows if n == name)[:6]
        cands = [(v[3:9], grp, ln) for n, v, ln, grp in a_rows if n == name]
        for av, grp, ln in cands:
            same = sum(1 for x, y in zip(gv, av) if x == y)
            print("  %-12s vs OS-ATLAS［%s］第 %d 行：%d/6 逐位相同" % (name, grp, ln, same))
            if same == 6:
                copied_from[name] = grp
        total_same += max(sum(1 for x, y in zip(gv, av) if x == y) for av, _, _ in cands)
    print("  三列合計逐位相同：%d/18" % total_same)

    # ---- 對照組 ----
    print("\n=== 對照組：GUI-R1 自己跑的列，數字在 OS-ATLAS Table 5 出現幾個 ===")
    pool = {x for _, v, _, _ in a_rows for x in v}
    for name in ("QwenVL2.5-3B", "QwenVL2.5-7B", "UI-R1-3B", "GUI-R1-3B", "GUI-R1-7B"):
        gv = next(v for n, v, _, _ in g_rows if n == name)[:6]
        hit = [x for x in gv if x in pool]
        print("  %-13s 6 格中出現在 OS-ATLAS Table 5 的：%d%s" % (name, len(hit), "（%s）" % "、".join(hit) if hit else ""))

    # ---- 分組 ----
    print("\n=== 分組標題（只陳列事實）===")
    for grp_name in ("Supervised Fine-Tuning", "Zero Shot", "Reinforcement Fine-Tuning"):
        members = [n for n, _, _, grp in g_rows if grp == grp_name]
        print("  GUI-R1［%s］組：%s" % (grp_name, "、".join(members)))
    star = re.search(r"\* denotes [^.]*\.", caption)
    print("  GUI-R1 表題的星號註記：%s" % (star.group(0) if star else "找不到"))
    for name in ("GPT-4o", "OS-Atlas-4B", "OS-Atlas-7B"):
        ggrp = next(grp for n, _, _, grp in g_rows if n == name)
        print("  %-12s GUI-R1 放在［%s］；抄自 OS-ATLAS 的［%s］" % (name, ggrp, copied_from.get(name, "找不到逐位相同的列")))
    sft = [(n, v[3:9]) for n, v, _, grp in a_rows if grp == "Supervised Fine-tuning Setting" and n.startswith("OS-Atlas")]
    for n, v in sft:
        print("  OS-ATLAS 微調後的 %s：High SR %s、Odyssey SR %s" % (n, v[2], v[5]))

    ok = total_same == 18 and all(copied_from.get(n) == "Zero-shot OOD Setting"
                                  for n in ("GPT-4o", "OS-Atlas-4B", "OS-Atlas-7B"))
    print("\n結論：" + ("證實。三列 18 個數字與 OS-ATLAS Table 5 的零樣本組逐位相同，是直接引用。"
                      "GUI-R1 依訓練方式把兩列 OS-Atlas 歸在「Supervised Fine-Tuning」組，引用的是 OS-ATLAS "
                      "未在 AndroidControl／GUI-Odyssey 上微調的零樣本數字"
                      if ok else "不成立或部分不成立，見上") + "  DONE 03-guir1-osatlas-copy.py")


if __name__ == "__main__":
    main()
