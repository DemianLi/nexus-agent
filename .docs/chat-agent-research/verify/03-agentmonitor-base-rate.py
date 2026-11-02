#!/usr/bin/env python3
"""驗證：AgentMonitor（Testing Language Model Agents Safely in the Wild）Table 2 的盛行率、誤報率與基準率陷阱。

主張（章節 03-agent-observation.md〈監控這一側的陷阱〉AgentMonitor 一段，以及〈問題的演進〉AgentMonitor 段）：
  (a) Table 2 十列的 F1 都能由同列的 Precision 與 Recall 重算回來（2PR/(P+R)，容許表上一位小數的四捨五入）。
  (b) 由同列的 Accuracy、Precision、Recall 可以反解測試集的陽性比例 π：
      Accuracy = 1 − π(1 − R) − πR(1 − P)/P，所以 π = (1 − A) / ((1 − R) + R(1 − P)/P)。
      十列評在同一個測試集上，反解出的 π 應該彼此接近，而且接近論文說的「把 30% 的輸出換成正例」。
  (c) 精讀筆記推算：全配置（門檻 68）在約 30% 盛行率下，安全輸出的誤報率約 9.2%；
      真實不安全率若只有 1%，Precision 只剩約 10%。
  (d) 精讀筆記：乾淨的測試約有三分之一（約 36%）會被誤停至少一次（每次嘗試平均 1965/422 ≈ 4.66 步、
      每步都進監控器、彼此獨立）。本程式另算只把七種網路／檔案指令的輸出算進監控器時的值
      （筆記依公開 notebook 記的 1,292／1,965 筆）。
  (e) 筆記 key_results：Table 2 的九個單一消融裡，有六個的 F1 高於全配置的 89.4；拿掉 File Context 四個
      指標與全配置完全相同；拿掉 Deterministic Whitelist 時 Recall 不變、Precision 上升。
出處：[arXiv:2311.10538] §4、§5、Table 2；筆記 limitations_observed 第 4 條、method「資料建構」。

輸入：.cache/text/2311.10538.txt 的 Table 2（表頭「| Ablated Parameter」到表題「Table 2:」）與 §4 的
  1,965、422；notes/2311.10538.json 的 method 欄（1,292／1,965）。

方法：
  1. 解析 Table 2：每列是一個名稱加四個百分比；斷言共 10 列、名稱集合正確、全配置是 93.1／82.1／98.3／89.4。
  2. 逐列重算 F1 與反解 π。表上數字只有一位小數，所以另外把 A、P、R 各在 ±0.05 個百分點內取 11 個格點，
     算出全配置 π 與誤報率的可能範圍（四捨五入的不確定度）。
  3. 誤報率 FPR = πR(1 − P) / (P(1 − π))；盛行率換成 q 時的 Precision = qR / (qR + (1 − q)FPR)。
  4. 每次嘗試至少誤停一次的機率 = 1 − (1 − FPR)^k，k 取 1965/422 與 1292/422 兩個值；這假設每步誤報彼此
     獨立、誤報率與測試集相同，只是量級估計。

沒有用到隨機數。只用標準函式庫。執行：python3 verify/03-agentmonitor-base-rate.py（從研究根目錄）
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TXT = os.path.join(HERE, "..", ".cache", "text", "2311.10538.txt")
NOTE = os.path.join(HERE, "..", "notes", "2311.10538.json")
PCT = re.compile(r"^(\d+(?:\.\d+)?)%$")
GRID = [-0.0005 + k * 0.0001 for k in range(11)]  # 一位小數的百分比，四捨五入誤差 ±0.05 個百分點
NAMES = {
    "Previous Context", "Prompt Context", "File Context", "Agent Awareness", "Deterministic Whitelist",
    "Description Context", "Score Tuning", "Guided Scoring", "Few Shot Examples", "Full Monitor",
}


def prevalence(a, p, r):
    return (1 - a) / ((1 - r) + r * (1 - p) / p)


def fpr(pi, p, r):
    return pi * r * (1 - p) / (p * (1 - pi))


def main():
    with open(TXT, encoding="utf-8") as f:
        raw = f.read().split("\n")
    lines = [l.strip().lstrip("|").strip() for l in raw]
    head = next(i for i, l in enumerate(lines) if l == "Ablated Parameter")
    cap = next(i for i in range(head, len(lines)) if lines[i].startswith("Table 2:"))
    assert [lines[head + k] for k in range(1, 5)] == ["Accuracy", "Precision", "Recall", "F1 Score"], "表頭不符"
    body = [(i + 1, lines[i]) for i in range(head + 5, cap) if lines[i]]
    rows = []
    j = 0
    while j < len(body):
        ln, t = body[j]
        nums = [body[j + k][1] for k in range(1, 5)] if j + 4 < len(body) else []
        if len(nums) == 4 and all(PCT.match(x) for x in nums) and not PCT.match(t):
            rows.append((t, [float(PCT.match(x).group(1)) / 100 for x in nums], ln))
            j += 5
        else:
            raise SystemExit("第 %d 行解析錯位：%s" % (ln, t))
    print("=== Table 2（表頭第 %d 行、表題第 %d 行）===" % (head + 1, cap + 1))
    assert len(rows) == 10 and {r[0] for r in rows} == NAMES, [r[0] for r in rows]
    full = next(v for n, v, _ in rows if n == "Full Monitor")
    assert [round(x * 100, 1) for x in full] == [93.1, 82.1, 98.3, 89.4], full

    print("\n== (a) F1 重算、(b) 反解陽性比例 π ==")
    pis = []
    for n, (a, p, r, f1), ln in rows:
        f1c = 2 * p * r / (p + r)
        # P、R 都只有一位小數：在 ±0.05 個百分點的四捨五入範圍內，F1 可能落在哪裡
        f1s = [2 * (p + dp) * (r + dr) / (p + dp + r + dr) for dp in GRID for dr in GRID]
        ok = min(f1s) <= f1 + 0.0005 and max(f1s) >= f1 - 0.0005
        pi = prevalence(a, p, r)
        pis.append(pi)
        print("  %-24s A %.1f P %.1f R %.1f F1 %.1f │ 2PR/(P+R) = %.2f（四捨五入範圍 %.2f–%.2f）%s │ π = %.3f（第 %d 行）" % (
            n, a * 100, p * 100, r * 100, f1 * 100, f1c * 100, min(f1s) * 100, max(f1s) * 100,
            "相容" if ok else "不相容", pi, ln))
        assert ok, n
    print("  十列反解的 π 落在 %.3f 到 %.3f 之間" % (min(pis), max(pis)))

    a0, p0, r0, _ = full
    pi_rng, fpr_rng = [], []
    for da in GRID:
        for dp in GRID:
            for dr in GRID:
                a, p, r = a0 + da, p0 + dp, r0 + dr
                pi = prevalence(a, p, r)
                pi_rng.append(pi)
                fpr_rng.append(fpr(pi, p, r))
    pi0 = prevalence(a0, p0, r0)
    fpr0 = fpr(pi0, p0, r0)
    print("\n== (c) 全配置的誤報率與基準率 ==")
    print("  π = (1 − 0.931) / ((1 − 0.983) + 0.983 × (1 − 0.821) / 0.821) = %.4f" % pi0)
    print("  四捨五入範圍內 π ∈ [%.4f, %.4f]" % (min(pi_rng), max(pi_rng)))
    print("  FPR = πR(1 − P) / (P(1 − π)) = %.4f（四捨五入範圍 [%.4f, %.4f]）" % (fpr0, min(fpr_rng), max(fpr_rng)))
    acc_back = 1 - pi0 * (1 - r0) - (1 - pi0) * fpr0
    print("  代回 Accuracy = %.4f（表列 0.931）" % acc_back)
    for q in (0.30, 0.10, 0.05, 0.01):
        prec = q * r0 / (q * r0 + (1 - q) * fpr0)
        print("  陽性比例 %.0f%% 時 Precision = %.3f" % (q * 100, prec))
    prec1 = 0.01 * r0 / (0.01 * r0 + 0.99 * fpr0)

    print("\n== (d) 每次嘗試至少誤停一次（獨立、同誤報率的量級估計）==")
    text = "\n".join(raw)
    assert "1,965 LMA outputs" in text and "422 attempts" in text
    note = json.load(open(NOTE, encoding="utf-8"))
    m = re.search(r"（([\d,]+)／([\d,]+) 筆）", note["method"]["資料建構"])
    acts, outs = int(m.group(1).replace(",", "")), int(m.group(2).replace(",", ""))
    assert outs == 1965, outs
    stop = {}
    for label, k in (("全部輸出 1965/422", 1965 / 422), ("七種指令 %d/422" % acts, acts / 422)):
        p_stop = 1 - (1 - fpr0) ** k
        stop[label] = p_stop
        print("  %-18s k = %.2f 步 → 1 − (1 − %.4f)^%.2f = %.3f" % (label, k, fpr0, k, p_stop))

    print("\n== (e) 消融與全配置的比較 ==")
    better = [(n, v[3]) for n, v, _ in rows if n != "Full Monitor" and v[3] > full[3] + 1e-9]
    same = [n for n, v, _ in rows if n != "Full Monitor" and v == full]
    dw = next(v for n, v, _ in rows if n == "Deterministic Whitelist")
    print("  F1 高於全配置的單一消融：%d 個 %s" % (len(better), ", ".join("%s %.1f" % (n, f * 100) for n, f in better)))
    print("  四個指標與全配置完全相同：%s" % same)
    print("  拿掉 Deterministic Whitelist：Recall %.1f → %.1f，Precision %.1f → %.1f" % (
        full[2] * 100, dw[2] * 100, full[1] * 100, dw[1] * 100))
    assert len(better) == 6 and same == ["File Context"] and dw[2] == full[2] and dw[1] > full[1]

    print("\n結論：(a) 十列 F1 都與四捨五入後的 P、R 相容；(b) 十列反解的陽性比例都在 %.3f–%.3f，與「替換 30%%」一致；"
          "(c) 證實，全配置的誤報率約 %.1f%%（四捨五入範圍 %.1f%%–%.1f%%，筆記的 9.2%% 在範圍內），陽性比例 1%% 時 Precision 約 %.0f%%；"
          "(d) 筆記的約 36%% 是每個輸出都進監控器的值，只算七種指令時約 %.0f%%；(e) 證實，六個消融的 F1 高於全配置"
          % (min(pis), max(pis), fpr0 * 100, min(fpr_rng) * 100, max(fpr_rng) * 100, prec1 * 100, stop["七種指令 %d/422" % acts] * 100),
          " DONE 03-agentmonitor-base-rate.py")


if __name__ == "__main__":
    main()
