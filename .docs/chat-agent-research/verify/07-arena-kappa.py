#!/usr/bin/env python3
"""驗證：Chatbot Arena §6.3 的群眾／專家同意率做了機會校正後還剩多少，以及這個結論依賴哪些假設。

主張（章節 07-agent-evaluation.md〈陷阱四〉Chatbot Arena 那一條）：
  精讀時依 Table 3、Table 4 把勝率視為二元選擇粗估：群眾對專家 1（對 Llama-2-13b）的機會同意率是
  0.812 × 0.894 + (1 − 0.812) × (1 − 0.894) ≈ 0.746，觀察值 72.8% 反而更低，κ 約 −0.07；其餘群眾
  對專家的 κ 約 0.18–0.42，專家彼此約 0.16–0.51。驗證用的兩組配對都是實力懸殊的
  （GPT-4-Turbo 勝率 76.3%–89.4%）。
出處：[arXiv:2403.04132] 精讀筆記 notes/2403.04132.json 的 limitations_observed。

輸入從哪來（全部由程式從 .cache/text/2403.04132.txt 解析並印出行號，不手抄）：
  - Table 3：兩組配對（對 Llama-2-13b、對 GPT-3.5-Turbo）各 6 個兩兩同意率。
  - Table 4：GPT-4-Turbo 在兩組配對中，被群眾、專家 1、專家 2、GPT-4 判勝的比例。
  - §3：投票介面另有「tie」與「both are bad」兩個按鈕（所以票不一定是二元）。

方法與假設（這一段是本程式最重要的部分）：
  A. 基準假設（精讀筆記的算法）：把每位評分者的判定看成二元「GPT-4-Turbo 勝／不勝」，機會同意率
     p_e = pA·pB + (1 − pA)(1 − pB)，κ = (p_o − p_e)/(1 − p_e)。
  B. 敏感度一：票其實有第三類（平手或兩者皆差）。若兩位評分者「不勝」的票裡都有比例 t 是平手，
     且平手與輸在機會模型下也各自獨立，則 p_e = pA·pB + (1 − pA)(1 − pB)·[(1 − t)^2 + t^2]。
     t 越大、p_e 越小、κ 越高。論文沒報平手比例，所以掃 t = 0、0.25、0.5。
  C. 敏感度二：以二元邊際算，兩人同意率的上限是 1 − |pA − pB|；觀察值若超過上限，代表二元假設
     本身不成立（例如同意率是在排除平手後的子集上算的）。本程式逐格檢查。
  D. 若 Table 3 的同意率其實只在「兩人都給出勝負」的子集上算，而 Table 4 的勝率含平手，兩者的
     分母不同，A 的算法就不是同一個量。本程式用「能不能寫成 k/160」檢查分母：每格值只印到小數點
     後一位，所以容差是 ±0.05 個百分點；160 來自 §6.3「randomly selected 160 battles」。

沒有用到隨機數。只用標準函式庫。執行：python3 07-arena-kappa.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TXT = os.path.join(ROOT, ".cache", "text", "2403.04132.txt")
PCT = re.compile(r"^\|\s*([0-9.]+)%\s*$")


def load_lines():
    with open(TXT, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def cells_after(lines, i, hi):
    """從第 i 行（列名）往下收連續的百分比格，遇到 '-' 跳過、遇到空行或別的就停。"""
    vals = []
    j = i + 1
    while j < hi:
        s = lines[j].strip()
        m = PCT.match(s)
        if m:
            vals.append((float(m.group(1)) / 100, j + 1))
        elif s == "| -":
            vals.append((None, j + 1))
        else:
            break
        j += 1
    return vals


def parse(lines):
    t3 = find_line(lines, r"^Table 3: Pairwise agreement rate between crowd-user")
    t4 = find_line(lines, r"^Table 4: GPT-4-Turbo’s win-rate across crowd-user", t3)
    t4_end = find_line(lines, r"^## 7 Experiments", t4)
    raters = ["Crowd", "Expert 1", "Expert 2", "GPT-4"]
    agree = {}
    block = None
    for i in range(t3, t4):
        s = lines[i].strip().lstrip("|").strip()
        if s in ("Llama-2-13b", "GPT-3.5-Turbo"):
            block = s
            agree[block] = {}
            continue
        if block and s in ("Crowd", "Expert 1", "Expert 2"):
            vals = cells_after(lines, i, t4)
            if not vals:  # 表頭那一列（Llama-2-13b｜Expert 1｜Expert 2｜GPT-4）
                continue
            others = raters[1:]  # 欄：Expert 1、Expert 2、GPT-4
            assert len(vals) == 3, (s, vals)
            for other, (v, ln) in zip(others, vals):
                if v is not None:
                    agree[block][(s, other)] = (v, ln)
    win = {}
    for i in range(t4, t4_end):
        s = lines[i].strip().lstrip("|").strip()
        if s in ("Llama-2-13b", "GPT-3.5-Turbo"):
            vals = cells_after(lines, i, t4_end)
            assert len(vals) == 4, (s, vals)
            win[s] = {r: v for r, v in zip(raters, vals)}
    return t3 + 1, t4 + 1, agree, win


def kappa(po, pa, pb, t=0.0):
    pe = pa * pb + (1 - pa) * (1 - pb) * ((1 - t) ** 2 + t ** 2)
    return pe, (po - pe) / (1 - pe)


def main():
    lines = load_lines()
    i_tie = find_line(lines, r"we also present two buttons, “tie” or “both are bad\.”")
    print(f"第 {i_tie + 1} 行：投票介面另有「tie」與「both are bad」兩個按鈕，所以票不一定是二元")
    t3, t4, agree, win = parse(lines)
    print(f"Table 3 在第 {t3} 行起、Table 4 在第 {t4} 行起")

    # 自檢：每組配對 6 個同意率、4 個勝率，都在 0–1
    for b in ("Llama-2-13b", "GPT-3.5-Turbo"):
        assert len(agree[b]) == 6, agree[b]
        assert len(win[b]) == 4, win[b]
        for (v, _) in list(agree[b].values()) + list(win[b].values()):
            assert 0 < v < 1
    allwin = [v for b in win for (v, _) in win[b].values()]
    print(f"自檢：兩組各 6 個同意率、4 個勝率。GPT-4-Turbo 的勝率範圍 {min(allwin):.1%}–{max(allwin):.1%}")

    print()
    print("A. 基準假設（二元）與敏感度（t = 平手占「不勝」票的比例）")
    print(f"{'配對':<15}{'評分者':<22}{'p_o':>7}{'pA':>7}{'pB':>7}{'上限':>7}{'p_e':>7}{'κ(t=0)':>8}{'κ(.25)':>8}{'κ(.5)':>8}")
    summary = {"crowd_expert": [], "expert_expert": [], "other": []}
    over_cap = []
    for b in ("Llama-2-13b", "GPT-3.5-Turbo"):
        for (ra, rb), (po, ln) in agree[b].items():
            pa, _ = win[b][ra]
            pb, _ = win[b][rb]
            cap = 1 - abs(pa - pb)
            pe0, k0 = kappa(po, pa, pb, 0.0)
            _, k25 = kappa(po, pa, pb, 0.25)
            _, k50 = kappa(po, pa, pb, 0.5)
            name = f"{ra} 對 {rb}"
            print(f"{b:<15}{name:<22}{po:>7.3f}{pa:>7.3f}{pb:>7.3f}{cap:>7.3f}{pe0:>7.3f}{k0:>8.2f}{k25:>8.2f}{k50:>8.2f}"
                  f"  （第 {ln} 行）")
            if po > cap + 1e-9:
                over_cap.append(f"{b} {name}：{po:.3f} > {cap:.3f}")
            kind = "crowd_expert" if ra == "Crowd" and rb.startswith("Expert") else \
                   "expert_expert" if ra.startswith("Expert") and rb.startswith("Expert") else "other"
            summary[kind].append((b, name, k0, k25, k50))

    ex = [x for x in summary["crowd_expert"] if x[0] == "Llama-2-13b" and "Expert 1" in x[1]][0]
    pa, pb = win["Llama-2-13b"]["Crowd"][0], win["Llama-2-13b"]["Expert 1"][0]
    print()
    print(f"例：群眾對專家 1（對 Llama-2-13b）：p_e = {pa} × {pb} + (1 − {pa}) × (1 − {pb}) = "
          f"{pa * pb + (1 - pa) * (1 - pb):.4f}；p_o = {agree['Llama-2-13b'][('Crowd', 'Expert 1')][0]}，κ = {ex[2]:.3f}")

    print()
    for kind, label in (("crowd_expert", "群眾對專家"), ("expert_expert", "專家彼此"), ("other", "含 GPT-4 評審")):
        ks0 = [x[2] for x in summary[kind]]
        ks50 = [x[4] for x in summary[kind]]
        print(f"{label}（{len(ks0)} 格）：κ(t=0) {min(ks0):.2f} 到 {max(ks0):.2f}；κ(t=0.5) {min(ks50):.2f} 到 {max(ks50):.2f}")
    others_ce = [x[2] for x in summary["crowd_expert"] if x is not ex]
    print(f"群眾對專家、扣掉上面那一格的其餘 3 格：κ(t=0) {min(others_ce):.2f} 到 {max(others_ce):.2f}")

    print()
    print("C. 觀察同意率是否超過二元邊際允許的上限 1 − |pA − pB|：" + ("、".join(over_cap) if over_cap else "沒有一格超過"))

    print()
    i160 = find_line(lines, r"randomly selected 160 battles")
    print(f"D. 分母檢查（第 {i160 + 1} 行：每組配對隨機抽 160 場）。值只到小數點後一位，容差 ±0.05 個百分點")

    def fits(v, n):
        return any(abs(100 * k / n - 100 * v) <= 0.05 + 1e-9 for k in range(n + 1))

    w_fit = [(b, r, v) for b in win for r, (v, _) in win[b].items() if fits(v, 160)]
    print(f"  Table 4 勝率：{len(w_fit)}/8 格可寫成 k/160")
    a_fit, a_miss = [], []
    for b in ("Llama-2-13b", "GPT-3.5-Turbo"):
        for (ra, rb), (v, ln) in agree[b].items():
            (a_fit if fits(v, 160) else a_miss).append((b, ra, rb, v, ln))
    print(f"  Table 3 同意率：{len(a_fit)}/12 格可寫成 k/160；不行的 {len(a_miss)} 格：")
    for b, ra, rb, v, ln in a_miss:
        alt = [n for n in range(140, 160) if fits(v, n)]
        print(f"    {b} {ra} 對 {rb}：{v:.1%}（第 {ln} 行），140–159 之間相容的分母 {alt}")
    llama_miss = sum(1 for x in a_miss if x[0] == "Llama-2-13b")

    print()
    neg50 = [x for x in summary["crowd_expert"] if x[4] < 0]
    print("結論：部分證實（方向成立，個別值不穩）。κ(t=0) 的數字與精讀筆記一致："
          f"群眾對專家 1（Llama）約 {ex[2]:.2f}，其餘群眾對專家 {min(others_ce):.2f}–{max(others_ce):.2f}，"
          f"專家彼此 {min(x[2] for x in summary['expert_expert']):.2f}–{max(x[2] for x in summary['expert_expert']):.2f}。"
          f"敏感度：若「不勝」的票裡有一半是平手（t=0.5），κ 全部上升，群眾對專家 1（Llama）變成 {ex[4]:.2f}；"
          f"κ 仍 < 0 的格數 {len(neg50)}。所以「機會校正後遠低於 72%–83% 的字面印象」這個方向不依賴 t。"
          f"但分母檢查顯示 Table 4 的勝率 {len(w_fit)}/8 格是 k/160，Table 3 的同意率只有 {len(a_fit)}/12 格是"
          f"（Llama 那組 6 格有 {llama_miss} 格不是），同意率很可能是在排除某些票後的子集上算的，"
          "與勝率不是同一個分母；個別 κ 值（尤其 −0.07 那一格）只是二元假設下的粗估，不能當成精確值。")


if __name__ == "__main__":
    main()
