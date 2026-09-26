#!/usr/bin/env python3
"""驗證：Turpin et al. Table 9 裡，CoT 設定下 biased context 不低於 unbiased 的格數。

主張（章節 03-agent-observation.md〈監控論文自述與自家表格對不上〉Turpin 條）：
  論文 §3.2 說下降趨勢「對每個 task 個別成立」；綜合階段依 Table 9 重數，Answer is Always A 的 CoT 設定
  13 × 2 = 26 格中，有 4 格 biased 不低於 unbiased，例如 Logical Deduction 的 GPT-3.5 從 62.0 變成 64.7。
出處：[arXiv:2305.04388] §3.2、Table 9（附錄，bias-contradicting 標籤的逐 task 準確率）。

輸入：.cache/text/2305.04388.txt 的 Table 9（表題在表的上方，到「Table 10:」為止）。

方法：
  1. 解析 Table 9：每個 task 有三列（Sugg. Ans. ZS、Sugg. Ans. FS、Ans. A FS），每列 8 個數字，依序是
     GPT-3.5 No-CoT UB/B、GPT-3.5 CoT UB/B、Claude 1.0 No-CoT UB/B、Claude 1.0 CoT UB/B。斷言 13 個 task、
     39 列、每列 8 個數字。
  2. 兩種偏誤都數（§3.2 那句前後同時談 Suggested Answer 與 Answer is Always A）：
     - Answer is Always A 的 CoT：13 task × 2 模型 = 26 格；
     - Suggested Answer 的 CoT：13 task × 2 模型 × 2（ZS、FS）= 52 格。
     「不低於」的判準是 B ≥ UB；另外也列出 B > UB（嚴格上升）與 B = UB。
  3. 找出 §3.2 的原句。

沒有用到隨機數。只用標準函式庫。執行：python3 verify/03-turpin-table9-count.py（從研究根目錄）
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TXT = os.path.join(HERE, "..", ".cache", "text", "2305.04388.txt")
NUM = re.compile(r"^\d+(?:\.\d+)?$")


def main():
    with open(TXT, encoding="utf-8") as f:
        raw = f.read().split("\n")
    lines = [l.strip().lstrip("|").strip() for l in raw]
    lo = next(i for i, l in enumerate(lines) if l.startswith("Table 9: Accuracy on BBH broken down by task"))
    hi = next(i for i in range(lo, len(lines)) if lines[i].startswith("Table 10:"))
    tk = [(i + 1, lines[i]) for i in range(lo + 1, hi) if lines[i]]
    # 跳過表頭（到第一個 task 名之前）：表頭最後一個 token 是第 4 個 "B"
    k = 0
    seen_b = 0
    while seen_b < 4:
        if tk[k][1] == "B":
            seen_b += 1
        k += 1
    tk = tk[k:]
    tasks = []
    name_parts, bias = [], None
    j = 0
    while j < len(tk):
        ln, t = tk[j]
        if t in ("Sugg. Ans.", "Ans. A"):
            bias = t
            j += 1
            continue
        if t in ("ZS", "FS"):
            vals = [x for _, x in tk[j + 1:j + 9]]
            assert len(vals) == 8 and all(NUM.match(x) for x in vals), (ln, vals)
            if name_parts:
                tasks.append((" ".join(name_parts), []))
                name_parts = []
            tasks[-1][1].append((bias, t, [float(x) for x in vals], ln))
            j += 9
            continue
        if NUM.match(t):
            raise SystemExit("第 %d 行出現落單的數字 %s" % (ln, t))
        name_parts.append(t)
        j += 1
    print("=== Table 9（第 %d–%d 行）===" % (lo + 1, hi))
    print("  task 數：%d；每個 task 的列數：%s" % (len(tasks), sorted({len(r) for _, r in tasks})))
    assert len(tasks) == 13 and all(len(r) == 3 for _, r in tasks)

    def count(bias_label, shot):
        cells = []
        for name, rs in tasks:
            for b, s, v, ln in rs:
                if b != bias_label or s not in shot:
                    continue
                for model, ub, bb in (("GPT-3.5", v[2], v[3]), ("Claude 1.0", v[6], v[7])):
                    cells.append((name, s, model, ub, bb, ln))
        return cells

    print("\n=== Answer is Always A，CoT（FS）===")
    a = count("Ans. A", ("FS",))
    ge = [c for c in a if c[4] >= c[3]]
    for name, s, model, ub, bb, ln in a:
        mark = "  ← 不低於" if bb >= ub else ""
        print("  %-38s %-10s UB %5.1f → B %5.1f%s（第 %d 行起）" % (name, model, ub, bb, mark, ln))
    print("  共 %d 格；B ≥ UB 的 %d 格（其中嚴格上升 %d 格、持平 %d 格）"
          % (len(a), len(ge), sum(1 for c in ge if c[4] > c[3]), sum(1 for c in ge if c[4] == c[3])))

    print("\n=== Suggested Answer，CoT（ZS 與 FS）===")
    s_cells = count("Sugg. Ans.", ("ZS", "FS"))
    s_ge = [c for c in s_cells if c[4] >= c[3]]
    print("  共 %d 格；B ≥ UB 的 %d 格%s" % (len(s_cells), len(s_ge),
                                         "：" + "；".join("%s %s %s %.1f→%.1f" % (c[0], c[1], c[2], c[3], c[4]) for c in s_ge)
                                         if s_ge else ""))
    closest = min(s_cells, key=lambda c: c[3] - c[4])
    print("  降幅最小的一格：%s %s %s %.1f → %.1f（降 %.1f）" % (closest[0], closest[1], closest[2], closest[3],
                                                     closest[4], closest[3] - closest[4]))

    for i, l in enumerate(lines):
        if "holds for all tasks individually" in l:
            m = re.search(r"This trend holds for all tasks individually", l)
            print("\n  §3.2 原句（第 %d 行）：%s" % (i + 1, m.group(0) if m else l[:120]))

    ok = len(a) == 26 and len(ge) == 4 and len(s_cells) == 52
    print("\n結論：" + ("證實。Answer is Always A 的 CoT 26 格中有 %d 格 B ≥ UB；Suggested Answer 的 CoT 52 格有 %d 格，"
                      "所以「每個 task 都下降」的反例只出在 Answer is Always A" % (len(ge), len(s_ge))
                      if ok else "與章節不符，見上") + "  DONE 03-turpin-table9-count.py")


if __name__ == "__main__":
    main()
