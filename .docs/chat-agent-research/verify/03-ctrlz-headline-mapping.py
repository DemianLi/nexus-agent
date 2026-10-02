#!/usr/bin/env python3
"""驗證：Ctrl-Z 摘要的「攻擊成功率從 58% 降到 7%」對應正文哪兩格，以及只換協定時的差距。

主張（章節 03-agent-observation.md〈問題的演進〉Ctrl-Z 段、〈監控這一側的陷阱〉Ctrl-Z 一段）：
  (a) 精讀筆記：摘要的 58% 對應 trusted monitoring 在 100% usefulness 下的 safety 41.8%（100 − 41.8 = 58.2），
      7% 對應 Table 2 的 time travel 加 untrusted monitoring 在 95% usefulness 下的 92.6%（100 − 92.6 = 7.4）；
      兩格同時換了協定與 usefulness，也多了 untrusted monitoring。
      本程式把 Table 1、Table 2 的 UM 列、正文每一句 Result 與 §3.1.2 均勻預算的 safety 數字收進來，檢查四捨五入後
      攻擊成功率等於 58% 與 7% 的是不是只有這兩格；再掃全文每一個百分比（含附錄與圖說），確認沒有別的值落在
      這兩個捨入區間（41.5–42.5、92.5–93.5）。
  (b) 精讀筆記：同為 95% usefulness、只用可信監控時，風險從 defer to trusted 的 27.3% 降到 time travel 的 12.9%。
  (c) 精讀筆記：Table 1 在 95% usefulness 下 DTR、incrimination、三振只差 0.8–1.7 個百分點，90% usefulness 時三者
      同為 89.0%；time travel 對 DTR 的差距約 4 個百分點。
出處：[arXiv:2504.10374] 摘要、§3.1–§3.2、§4、Table 1、Table 2；筆記 key_results 第 1 條、limitations_observed 第 1、3 條。

輸入：.cache/text/2504.10374.txt 的摘要句、正文每一句「Result: A safety score of X% at Y% usefulness」、
  §3.1.2 的均勻預算 22%、Table 1（5 個協定 × 3 個 usefulness）與 Table 2（TM／UM × 3 個協定，95% usefulness）。

方法：
  1. 用表題當錨點解析 Table 1 與 Table 2，斷言格數與列名。
  2. 收集上述 safety 值，算 100 − safety 並四捨五入到整數，找出等於 58 與 7 的格；再掃全文每一個「數字%」，
     列出 100 − 值四捨五入為 58 或 7 的所有出現處。
  3. 依表格重算 (b)(c) 的差值。

沒有用到隨機數。只用標準函式庫。執行：python3 verify/03-ctrlz-headline-mapping.py（從研究根目錄）
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TXT = os.path.join(HERE, "..", ".cache", "text", "2504.10374.txt")
PCT = re.compile(r"^(\d+(?:\.\d+)?)%$")


def cells_before(lines, cap_prefix, n_rows, row_labels):
    cap = next(i for i, l in enumerate(lines) if l.startswith(cap_prefix))
    out = {}
    # 由表題往上找列名，每個列名後面緊接 n 個百分比
    for label in row_labels:
        k = max(j for j in range(cap) if lines[j] == label)
        vals = []
        m = k + 1
        while len(vals) < n_rows and m < cap:
            if PCT.match(lines[m]):
                vals.append(float(PCT.match(lines[m]).group(1)))
            elif lines[m]:
                raise SystemExit("第 %d 行解析錯位：%s" % (m + 1, lines[m]))
            m += 1
        assert len(vals) == n_rows, (label, vals)
        out[label] = (vals, k + 1)
    return out, cap + 1


def main():
    with open(TXT, encoding="utf-8") as f:
        raw = f.read().split("\n")
    lines = [l.strip().lstrip("|").strip() for l in raw]
    text = "\n".join(raw)

    abs_line = next(i for i, l in enumerate(raw) if "from 58% to 7%" in l)
    print("[摘要第 %d 行] …%s…" % (abs_line + 1, raw[abs_line][raw[abs_line].index("reducing"):][:90]))

    t1, cap1 = cells_before(lines, "Table 1: Safety scores for different protocols", 5,
                            ["99% Usefulness", "95% Usefulness", "90% Usefulness"])
    protos = ["Defer to Trusted", "Basic DTR", "DTR with Incrimination", "Auditing after Three Strikes", "Time Travel"]
    print("\n=== Table 1（表題第 %d 行）===" % cap1)
    table1 = {}
    for u, (vals, ln) in t1.items():
        print("  %-15s %s（第 %d 行起）" % (u, "  ".join("%5.1f" % v for v in vals), ln))
        for p, v in zip(protos, vals):
            table1[(p, int(u.split("%")[0]))] = v

    t2, cap2 = cells_before(lines, "Table 2: Comparison at 95% usefulness", 3, ["TM", "UM"])
    print("\n=== Table 2（表題第 %d 行，95%% usefulness）===" % cap2)
    table2 = {}
    for row, (vals, ln) in t2.items():
        print("  %-3s %s（第 %d 行起）" % (row, "  ".join("%5.1f" % v for v in vals), ln))
        for p, v in zip(["Defer to Trusted", "Defer to Resample", "Time Travel"], vals):
            table2[(p, row)] = v
    assert table1[("Defer to Trusted", 95)] == table2[("Defer to Trusted", "TM")] == 72.7
    assert table1[("Basic DTR", 95)] == table2[("Defer to Resample", "TM")] == 83.2
    assert table1[("Time Travel", 95)] == table2[("Time Travel", "TM")] == 87.1

    allv = []
    for (p, u), v in table1.items():
        allv.append(("Table 1 %s @%d%%" % (p, u), v))
    for (p, r), v in table2.items():
        if r == "UM":
            allv.append(("Table 2 %s＋UM @95%%" % p, v))
    for m in re.finditer(r"Result: [Aa] safety score of (\d+(?:\.\d+)?)%(?: safety)? at (\d+)% usefulness", text):
        ln = text[:m.start()].count("\n") + 1
        allv.append(("正文第 %d 行 Result（%s%% usefulness）" % (ln, m.group(2)), float(m.group(1))))
    m = re.search(r"uniform auditing technique instead.*?only achieves (\d+)% safety", text, re.S)
    allv.append(("§3.1.2 均勻稽核預算 @100%", float(m.group(1))))
    m = re.search(r"catching (\d+\.\d+)% of attacks at a 1% auditing budget", text)
    um_catch = float(m.group(1))

    print("\n== (a) 收進的 %d 個 safety 數字中，攻擊成功率四捨五入為 58%% 與 7%% 的格 ==" % len(allv))
    hit58 = sorted({(round(100 - v), v) for _, v in allv if round(100 - v) == 58})
    hit7 = sorted({(round(100 - v), v) for _, v in allv if round(100 - v) == 7})
    for name, v in allv:
        if round(100 - v) in (58, 7):
            print("  %-40s safety %.1f → 攻擊成功率 100 − %.1f = %.1f" % (name, v, v, 100 - v))
    assert [v for _, v in hit58] == [41.8] and [v for _, v in hit7] == [92.6], (hit58, hit7)
    scan = []
    for m in re.finditer(r"(?<![\d.])(\d+(?:\.\d+)?)\s*%", text):
        v = float(m.group(1))
        if round(100 - v) in (58, 7) and v < 100:
            scan.append((text[:m.start()].count("\n") + 1, v))
    print("  全文掃描：100 − 值四捨五入為 58 或 7 的百分比出現處 %s" % scan)
    assert sorted({v for _, v in scan}) == [41.8, 92.6], scan
    print("  另：誠實的 untrusted monitor 在 1%% 稽核預算下抓到 %.1f%% 的攻擊（§4）" % um_catch)

    print("\n== (b) 95% usefulness、只用可信監控時的風險 ==")
    dtt, tt = table2[("Defer to Trusted", "TM")], table2[("Time Travel", "TM")]
    print("  defer to trusted 100 − %.1f = %.1f；time travel 100 − %.1f = %.1f；加 UM 後 100 − %.1f = %.1f" % (
        dtt, 100 - dtt, tt, 100 - tt, table2[("Time Travel", "UM")], 100 - table2[("Time Travel", "UM")]))

    print("\n== (c) Table 1 的差距 ==")
    for u in (99, 95, 90):
        trio = [table1[(p, u)] for p in protos[1:4]]
        print("  %d%%：DTR／incrimination／三振 = %s，極差 %.1f；time travel − DTR = %.1f − %.1f = %.1f" % (
            u, "／".join("%.1f" % x for x in trio), max(trio) - min(trio), table1[("Time Travel", u)],
            table1[("Basic DTR", u)], table1[("Time Travel", u)] - table1[("Basic DTR", u)]))
    d95 = sorted({round(table1[(p, 95)] - table1[("Basic DTR", 95)], 1) for p in protos[2:4]})
    assert d95 == [0.8, 1.7] and len({table1[(p, 90)] for p in protos[1:4]}) == 1

    print("\n結論：(a) 證實，收進的數字與全文掃描都只有 TM＠100%% 的 41.8 與 time travel＋UM＠95%% 的 92.6 對得上 58%% 與 7%%；"
          "(b) 證實，只換可信監控的協定時風險是 %.1f%% → %.1f%%；(c) 證實，95%% 下三者只差 0.8–1.7 點、90%% 下相同，"
          "time travel 對 DTR 在 95%% 是 %.1f 點" % (100 - dtt, 100 - tt, tt - table1[("Basic DTR", 95)]),
          " DONE 03-ctrlz-headline-mapping.py")


if __name__ == "__main__":
    main()
