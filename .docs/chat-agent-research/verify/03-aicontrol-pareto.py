#!/usr/bin/env python3
"""驗證：AI Control Table 7 裡，哪些 untrusted monitoring（UM）點被列出的 trusted editing（TE）點支配。

主張（章節 03-agent-observation.md〈爭議〉「AI Control 的 Pareto 宣稱」）：
  §3.5 說 trusted editing Pareto 支配 untrusted monitoring。綜合階段逐點比對 Table 7：UM 0%（79%／96%）與
  UM 5%（82%／95%）被 TE 10%（85%／96%）支配，UM 10%（92%／92%）被 TE 20%（92%／94%）支配，只有 UM 20%
  （98%／85%）沒有被任何列出的 TE 點支配；精讀時指出 TE 列出的最高 safety 只有 96%（TE 50%，usefulness 89%）。
出處：[arXiv:2312.06942] 筆記 limitations_observed；Table 7、§3.5。

輸入：.cache/text/2312.06942.txt 的 Table 7（表題「Table 7: Detailed Safety and Usefulness Results」在表的
  下方，所以往上找到表頭「Protocol / Safety / Scaled Usefulness」為止）。

方法：
  1. 解析 Table 7 的每一列：協定名稱、safety、scaled usefulness；斷言共 15 列，其中 UM 4 列、TE 4 列。
  2. 支配的定義：TE 點 (s, u) 支配 UM 點 (s', u')，若 s ≥ s' 且 u ≥ u'，且至少一項嚴格大於。
     只看列出的點，不做內插（論文的曲線圖若有更多點，本程式看不到）。
  3. 逐一列出每個 UM 點被哪些 TE 點支配；並找出 §3.5 的原句。

沒有用到隨機數。只用標準函式庫。執行：python3 verify/03-aicontrol-pareto.py（從研究根目錄）
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TXT = os.path.join(HERE, "..", ".cache", "text", "2312.06942.txt")
PCT = re.compile(r"^(\d+)%$")


def main():
    with open(TXT, encoding="utf-8") as f:
        lines = [l.strip().lstrip("|").strip() for l in f.read().split("\n")]
    cap = next(i for i, l in enumerate(lines) if l.startswith("Table 7: Detailed Safety and Usefulness"))
    head = max(i for i in range(cap) if lines[i].strip() == "Protocol")
    assert lines[head + 1].strip() == "Safety" and lines[head + 2].strip() == "Scaled Usefulness"
    body = [(i + 1, lines[i].strip()) for i in range(head + 3, cap) if lines[i].strip()]
    rows = []
    j = 0
    while j < len(body):
        ln, t = body[j]
        if j + 2 < len(body) and PCT.match(body[j + 1][1]) and PCT.match(body[j + 2][1]) and not PCT.match(t):
            rows.append((t, int(PCT.match(body[j + 1][1]).group(1)), int(PCT.match(body[j + 2][1]).group(1)), ln))
            j += 3
        else:
            raise SystemExit("第 %d 行解析錯位：%s" % (ln, t))
    print("=== Table 7（表頭第 %d 行、表題第 %d 行）===" % (head + 1, cap + 1))
    for name, s, u, ln in rows:
        print("  %-45s safety %3d%%  usefulness %3d%%（第 %d 行）" % (name, s, u, ln))
    assert len(rows) == 15, len(rows)
    um = [(n, s, u) for n, s, u, _ in rows if n.startswith("Untrusted monitoring")]
    te = [(n, s, u) for n, s, u, _ in rows if n.startswith("Trusted editing")]
    assert len(um) == 4 and len(te) == 4

    def dom(a, b):
        return a[1] >= b[1] and a[2] >= b[2] and (a[1] > b[1] or a[2] > b[2])

    print("\n=== 逐點比對：每個 UM 點被哪些列出的 TE 點支配 ===")
    undominated = []
    for p in um:
        ds = [q for q in te if dom(q, p)]
        print("  %-42s (%d%%, %d%%)：%s" % (p[0], p[1], p[2],
                                          "、".join("%s (%d%%, %d%%)" % q for q in ds) if ds else "沒有任何 TE 點支配它"))
        if not ds:
            undominated.append(p[0])
    best_te = max(te, key=lambda q: q[1])
    print("\n  TE 列出的最高 safety：%s（%d%%／%d%%）" % best_te)
    for i, l in enumerate(lines):
        if re.search(r"Pareto", l) and re.search(r"untrusted monitoring", l, re.I):
            print("  §3.5 相關原句（第 %d 行）：%s" % (i + 1, l.strip()[:220]))

    expected = {"Untrusted monitoring; defer to trusted 20%"}
    ok = set(undominated) == expected and best_te[1] == 96
    print("\n結論：" + ("證實。4 個 UM 點中 3 個被列出的 TE 點支配，只有 UM 20%（98%／85%）沒有；"
                      "TE 列出的最高 safety 是 96%，所以「TE Pareto 支配 UM」在高安全端不成立"
                      if ok else "與章節不符，見上") + "  DONE 03-aicontrol-pareto.py")


if __name__ == "__main__":
    main()
