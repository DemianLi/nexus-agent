#!/usr/bin/env python3
"""驗證：Agent-as-a-Judge Table 3 的需求層級百分比，分母比較像 366 而不是論文說的 365。

主張（章節 07-agent-evaluation.md〈爭議、矛盾與反證〉第十八節 Agent-as-a-Judge 那一條）：
  依全文 Table 3 重算，需求層級的達成率與一致率沒有一個只符合 k/365；除了幾個很小的偏移值與
  93.98% 同時落在兩種分母上，其餘都只落在某個 k/366 的 0.01 個百分點以內，例如
  0.9044 × 366 ≈ 331.0。所以每個受測 agent 實際判定的需求數可能是 366 條。
出處：[arXiv:2410.10934]。原主張是組章時的重算；本程式照 critic 的做法寫成可重跑的檢查，
  並另外用較嚴的捨入容差（0.005 個百分點）再數一次，順便核對陷阱四引用的「全部判未達成」基線。

輸入從哪來（全部由程式從 .cache/text/2410.10934.txt 解析並印出行號，不手抄）：
  - 第 82、211、580 行：「365 hierarchical user requirements」與 Alignment Rate 的定義
    （across all 365 requirements）。
  - Table 2（Human-as-a-Judge）：人評共識的 Requirements Met (I) 等四列。
  - Table 3：LLM-as-a-Judge 與 Agent-as-a-Judge 在 black-box／gray-box 下的各列，每格寫成
    「值% (偏移%)」；以及人類評審的一致率各列。

方法：
  1. 解析 Table 2 與 Table 3 的每一格，記下列名、欄（受測 agent）與行號。
  2. 依列名分成三類：
       需求層級（Requirements Met、Alignment Rate 的單一評審列與 Majority Vote）；
       任務層級（Task Solve Rate、Self-Termination，分母應是 55 題）；
       不是比例的（Average of individuals 是三人平均，不檢查）。
     括號裡的偏移值（Shift）是兩個比例相減，另列一組，不和主值混算。
  3. 對每個需求層級的值 v，檢查是否存在整數 k 使 |100k/365 − v| ≤ tol，366 同理；
     tol 取兩種：0.01（critic 的容差）與 0.005（兩位小數的捨入上限）。
  4. 任務層級的值檢查 k/55。
  5. 附帶：陷阱四引用的「全部判未達成」基線 100 − 人評 Requirements Met (I)，
     與 LLM-as-a-Judge black-box 在 MetaGPT 的 84.15 − 77.87 = 6.28 點。
  6. 最後把章節與 07-results.md 引用的每個值（格數、93.98、331.0、44.80 的取位、自檢發現的那一格
     加回偏移後對上哪一欄的人評值、77.87 與 6.28）和本程式算出的值逐一比對；任何一項不符就印出
     差異並以非零碼退出。結論句裡的數字全部由程式算出的變數代入，不寫死。

沒有用到隨機數。只用標準函式庫。執行：python3 07-aaaj-denominator.py
"""

import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TXT = os.path.join(ROOT, ".cache", "text", "2410.10934.txt")

CELL = re.compile(r"^\|\s*([0-9.]+)%\s*(?:\(([0-9.]+)%\))?\s*$")
AGENTS = ["MetaGPT", "GPT-Pilot", "OpenHands"]


def load_lines():
    with open(TXT, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def parse_block(lines, lo, hi):
    """回傳 [(區段, 列名, 欄, 值, 偏移或 None, 行號)]。區段是表內的小標（LLM-as-a-Judge 等）。"""
    out = []
    section = ""
    i = lo
    while i < hi:
        s = lines[i].strip()
        if s.startswith("|") and ("Judge" in s) and "%" not in s and "Metric" not in s:
            section = s.strip("| ").strip()
            i += 1
            continue
        label = s.lstrip("|").strip()
        if s.startswith("|") and label and "%" not in label and "Metric" not in label:
            vals = []
            j = i + 1
            while j < hi and len(vals) < 3:
                m = CELL.match(lines[j].strip())
                if not m:
                    break
                vals.append((float(m.group(1)), float(m.group(2)) if m.group(2) else None, j + 1))
                j += 1
            if len(vals) == 3:
                for col, (v, sh, ln) in zip(AGENTS, vals):
                    out.append((section, label, col, v, sh, ln))
                i = j
                continue
        i += 1
    return out


def fits(v, n, tol):
    k = round(v * n / 100.0)
    return abs(100.0 * k / n - v) <= tol + 1e-12, k


def fits_trunc(v, n):
    """無條件捨去到兩位小數：存在 k 使 v ≤ 100k/n < v + 0.01。"""
    for k in (int(v * n / 100.0), int(v * n / 100.0) + 1):
        x = 100.0 * k / n
        if v - 1e-9 <= x < v + 0.01 - 1e-9:
            return True
    return False


def main():
    lines = load_lines()
    for pat in (r"a total of 365 hierarchical user requirements",
                r"for a total of \$365\$ requirements",
                r"across all \$365\$ requirements"):
        i = find_line(lines, pat)
        print(f"第 {i + 1} 行：論文寫 365 條需求（{pat.replace(chr(92), '')[:50]}…）")

    t2_lo = find_line(lines, r"^## 3 Human-as-a-Judge")
    t2_hi = find_line(lines, r"^Table 2:", t2_lo)
    t3_hi = find_line(lines, r"^Table 3:", t2_hi)
    t3_lo = find_line(lines, r"^\| Metric", t2_hi)
    t2 = parse_block(lines, t2_lo, t2_hi)
    t3 = parse_block(lines, t3_lo, t3_hi)
    print(f"Table 2：第 {t2_lo + 1}–{t2_hi + 1} 行，{len(t2)} 格；Table 3：第 {t3_lo + 1}–{t3_hi + 1} 行，{len(t3)} 格")

    # 自檢：Table 2 四列 × 3 欄；Table 3 有 4 個 AI 評審區段 × 4 列 + 人類 6 列 = 22 列 × 3 欄
    assert len(t2) == 12, len(t2)
    assert len(t3) == 66, len(t3)
    human_rm = {c: v for (_, lab, c, v, _, _) in t2 if lab.startswith("(A) Requirements Met (I)")}
    assert set(human_rm) == set(AGENTS), human_rm
    # 自檢：AI 評審各列「值 − 偏移」或「值 + 偏移」應回到人評共識（Table 2）的同一列
    human = {}
    for (_, lab, c, v, _, _) in t2:
        key = "RM(I)" if "Requirements Met (I)" in lab else "RM(D)" if "Requirements Met (D)" in lab else \
              "TSR" if "Task Solve" in lab else "ST"
        human[(key, c)] = v
    bad = 0
    anomalies = []  # (區段, 列名, 欄, 值, 偏移, 行號, 該欄人評, [(v±偏移 對得上的欄, 人評值)])
    for (sec, lab, c, v, sh, ln) in t3:
        if sh is None:
            continue
        key = "RM(I)" if "Requirements Met (I)" in lab else "RM(D)" if "Requirements Met (D)" in lab else \
              "TSR" if "Task Solve" in lab else None
        if key is None:
            continue
        h = human[(key, c)]
        if min(abs(v - sh - h), abs(v + sh - h)) > 0.02:
            bad += 1
            # 回不到自己那一欄時，找 v ± 偏移 對得上同一列的哪一欄人評值
            other = []
            for c2 in AGENTS:
                hv = human[(key, c2)]
                for sign, back in (("+", v + sh), ("−", v - sh)):
                    if abs(back - hv) <= 0.02:
                        other.append((c2, hv, sign, back))
            anomalies.append((sec, lab, c, v, sh, ln, h, other))
            hit = "；".join(f"{v:.2f} {s} {sh:.2f} = {b:.2f}，是 {c2} 的人評 {hv:.2f}"
                           for c2, hv, s, b in other) or "加減偏移後對不上任何一欄的人評"
            print(f"  自檢警告：第 {ln} 行 {sec}/{lab}/{c} 的 {v} ± {sh} 回不到本欄人評 {h}；{hit}")
    print(f"自檢：Table 3 的偏移值有 {bad} 格回不到 Table 2 的人評共識（容差 0.02）")

    groups = {"need": [], "task": [], "shift": [], "skip": []}
    for rec in t2 + t3:
        sec, lab, c, v, sh, ln = rec
        if "Average of individuals" in lab:
            groups["skip"].append(rec)
        elif "Task Solve" in lab or "Self-Termination" in lab:
            groups["task"].append(rec)
        else:
            groups["need"].append(rec)
        if sh is not None and ("Requirements Met" in lab):
            groups["shift"].append((sec, lab + "〔偏移〕", c, sh, None, ln))

    print()
    tol_summary = {}  # tol -> (只符合 365, 只符合 366, 兩者都符合, 都不符合, 兩者都符合的值)
    for tol in (0.01, 0.005):
        c365 = c366 = both = neither = 0
        only365, neither_list, both_list = [], [], []
        both_vals = []
        for (sec, lab, c, v, sh, ln) in groups["need"]:
            a, _ = fits(v, 365, tol)
            b, _ = fits(v, 366, tol)
            if a and b:
                both += 1
                both_list.append(f"{v}")
                both_vals.append(v)
            elif a:
                c365 += 1
                only365.append(f"{sec}/{lab}/{c}={v}（第 {ln} 行）")
            elif b:
                c366 += 1
            else:
                neither += 1
                neither_list.append(f"{sec}/{lab}/{c}={v}（第 {ln} 行）")
        print(f"需求層級主值 {len(groups['need'])} 格，容差 {tol}：只符合 k/365 {c365}、只符合 k/366 {c366}、"
              f"兩者都符合 {both}、都不符合 {neither}")
        if only365:
            print("  只符合 365 的：" + "；".join(only365))
        if both_list:
            print("  兩者都符合的值：" + "、".join(both_list))
        if neither_list:
            print("  都不符合的：" + "；".join(neither_list))
        tol_summary[tol] = (c365, c366, both, neither, both_vals)

        s365 = s366 = sboth = sneither = 0
        for (sec, lab, c, v, _, ln) in groups["shift"]:
            a, _ = fits(v, 365, tol)
            b, _ = fits(v, 366, tol)
            if a and b:
                sboth += 1
            elif a:
                s365 += 1
            elif b:
                s366 += 1
            else:
                sneither += 1
        print(f"  偏移值 {len(groups['shift'])} 格：只符合 365 {s365}、只符合 366 {s366}、兩者都符合 {sboth}、"
              f"都不符合 {sneither}（偏移是兩個比例相減，不必是 k/n，只作參考）")

    c365 = c366 = both = neither = 0
    neither_list = []
    for (sec, lab, c, v, sh, ln) in groups["need"]:
        a, b = fits_trunc(v, 365), fits_trunc(v, 366)
        if a and b:
            both += 1
        elif a:
            c365 += 1
        elif b:
            c366 += 1
        else:
            neither += 1
            neither_list.append(f"{sec}/{lab}/{c}={v}（第 {ln} 行）")
    print(f"需求層級主值 {len(groups['need'])} 格，假設「無條件捨去到兩位小數」：只符合 k/365 {c365}、"
          f"只符合 k/366 {c366}、兩者都符合 {both}、都不符合 {neither}")
    if neither_list:
        print("  都不符合的：" + "；".join(neither_list))
    trunc_summary = (c365, c366, both, neither)

    # 例：人評 GPT-Pilot 的 44.80%。由表格取值，算出 k/366 與它四捨五入、捨去後的兩位小數。
    ex2 = [(v, ln) for (sec, lab, c, v, _, ln) in t2 if c == "GPT-Pilot" and "Requirements Met (I)" in lab]
    if len(ex2) != 1:
        raise SystemExit(f"找不到人評 GPT-Pilot 的 Requirements Met (I)：{ex2}")
    gp_val, gp_ln = ex2[0]
    gp_k = round(gp_val * 366 / 100.0)
    gp_x = 100.0 * gp_k / 366
    gp_round = round(gp_x, 2)
    gp_floor = math.floor(gp_x * 100 + 1e-9) / 100
    gp_365 = [100.0 * k / 365 for k in (math.floor(gp_val * 3.65), math.floor(gp_val * 3.65) + 1)]
    print(f"  例：人評 GPT-Pilot 的 {gp_val:.2f}%（第 {gp_ln} 行）：{gp_k}/366 = {gp_x:.4f}，"
          f"四捨五入是 {gp_round:.2f}、捨去是 {gp_floor:.2f}；"
          + "、".join(f"{math.floor(gp_val * 3.65) + i}/365 = {x:.4f}" for i, x in enumerate(gp_365))
          + f"，都不是 {gp_val:.2f}")

    # 表格看起來混用取位法：對每格找出落在 ±0.01 內的 k/366，看它是四捨五入、捨去還是進位得到的。
    mode = {"四捨五入": 0, "捨去（非四捨五入）": 0, "進位（非四捨五入）": 0}
    ceil_only = []
    for (sec, lab, c, v, sh, ln) in groups["need"]:
        k = round(v * 366 / 100.0)
        x = 100.0 * k / 366
        if abs(round(x, 2) - v) < 1e-9:
            mode["四捨五入"] += 1
        elif abs(math.floor(x * 100 + 1e-9) / 100 - v) < 1e-9:
            mode["捨去（非四捨五入）"] += 1
        elif abs(math.ceil(x * 100 - 1e-9) / 100 - v) < 1e-9:
            mode["進位（非四捨五入）"] += 1
            ceil_only.append(f"{v}（{k}/366 = {x:.4f}，第 {ln} 行）")
    print("以 k/366 還原時各格的取位方向：" + "、".join(f"{m} {n} 格" for m, n in mode.items()))
    if ceil_only:
        print("  只能靠進位對上的：" + "；".join(ceil_only))
    for v in tol_summary[0.01][4]:
        k5, k6 = round(v * 3.65), round(v * 3.66)
        x5, x6 = 100.0 * k5 / 365, 100.0 * k6 / 366
        d5 = "四捨五入" if abs(round(x5, 2) - v) < 1e-9 else ("要進位" if x5 < v else "要捨去")
        d6 = "四捨五入" if abs(round(x6, 2) - v) < 1e-9 else ("要進位" if x6 < v else "要捨去")
        print(f"  例：{v:.2f}% 在容差 0.01 下兩種分母都符合：{k5}/365 = {x5:.4f}（{d5}）、{k6}/366 = {x6:.4f}（{d6}）")

    t_ok = sum(1 for (_, _, _, v, _, _) in groups["task"] if fits(v, 55, 0.01)[0])
    print(f"任務層級 {len(groups['task'])} 格：{t_ok} 格符合 k/55（容差 0.01）")

    ex = [r for r in groups["need"] if r[3] == 90.44 and r[2] == "OpenHands" and "Alignment" in r[1]]
    if not ex:
        raise SystemExit("找不到 OpenHands 的 90.44%")
    oh_val, oh_ln = ex[0][3], ex[0][5]
    oh_365, oh_366 = oh_val * 3.65, oh_val * 3.66
    print(f"例：OpenHands 的 {oh_val}%：×365 = {oh_365:.2f}，×366 = {oh_366:.2f}（第 {oh_ln} 行）")

    print()
    print("附帶：陷阱四的「全部判未達成」基線（100 − 人評 Requirements Met (I)，Table 2）")
    for c in AGENTS:
        print(f"  {c}：100 − {human_rm[c]} = {100 - human_rm[c]:.2f}%")
    llm_blocks = [r for r in t3 if r[0].startswith("LLM-as-a-Judge") and "Alignment" in r[1] and r[2] == "MetaGPT"]
    llm_meta = llm_blocks[0]
    base_meta = 100 - human_rm["MetaGPT"]
    gain_meta = llm_meta[3] - base_meta
    print(f"  LLM-as-a-Judge（第一個區段，black-box）在 MetaGPT 的一致率 {llm_meta[3]}%，比基線多 "
          f"{llm_meta[3]} − {base_meta:.2f} = {gain_meta:.2f} 點（第 {llm_meta[5]} 行）")

    # 自檢發現的那一格屬於第幾個 LLM-as-a-Judge 區段（表內第一個是 black-box、第二個是 gray-box；
    # 第一個區段 MetaGPT 的一致率就是章節引用為 black-box 的 84.15%）。每個區段的最後一列是
    # Alignment Rate，所以行號不超過第一個區段 Alignment Rate 那一列的，屬於第一個區段。
    if len(llm_blocks) != 2:
        raise SystemExit(f"LLM-as-a-Judge 區段應有 2 個，解析到 {len(llm_blocks)} 個")
    first_llm_end = min(r[5] for r in llm_blocks)

    def box_of(ln):
        return "black-box" if ln <= first_llm_end else "gray-box"

    # ---- 與章節、07-results.md 引用的值逐一比對 ----
    mismatches = []
    n_checked = [0]

    def expect(name, got, want):
        n_checked[0] += 1
        if got != want:
            mismatches.append(f"{name}：程式算出 {got!r}，章節／結果檔寫 {want!r}")

    n_need = len(groups["need"])
    s01, s005 = tol_summary[0.01], tol_summary[0.005]
    expect("需求層級主值格數", n_need, 57)
    expect("容差 0.01（只 365、只 366、兩者、都不）", s01[:4], (0, 56, 1, 0))
    expect("容差 0.01 下兩種分母都符合的值", s01[4], [93.98])
    expect("容差 0.005（只 365、只 366、兩者、都不）", s005[:4], (0, 29, 0, 28))
    expect("捨去（只 365、只 366、兩者、都不）", trunc_summary, (0, 50, 0, 7))
    expect("取位方向（四捨五入、捨去、進位）", tuple(mode.values()), (29, 24, 4))
    expect("任務層級（格數、符合 k/55）", (len(groups["task"]), t_ok), (18, 18))
    expect("0.9044 × 366", f"{oh_366:.1f}", "331.0")
    expect("人評 GPT-Pilot 的值", f"{gp_val:.2f}", "44.80")
    expect("人評 GPT-Pilot 的 k", gp_k, 164)
    expect("164 ÷ 366", f"{gp_x:.3f}", "44.809")
    expect("44.80 是捨去而非四捨五入的值", (gp_floor == gp_val, gp_round == gp_val), (True, False))
    expect("MetaGPT 全部判未達成的基線", f"{base_meta:.2f}", "77.87")
    expect("LLM-as-a-Judge black-box MetaGPT 的一致率", llm_meta[3], 84.15)
    expect("比基線多幾點", f"{gain_meta:.2f}", "6.28")
    expect("偏移回不到人評的格數", bad, 1)
    if len(anomalies) == 1:
        sec, lab, c, v, sh, ln, h, other = anomalies[0]
        expect("自檢發現那一格（區段、欄、值、偏移、本欄人評）",
               (sec, box_of(ln), c, v, sh, h), ("LLM-as-a-Judge", "gray-box", "GPT-Pilot", 38.79, 4.1, 44.8))
        expect("加減偏移後對得上的欄與值", [(c2, f"{b:.2f}") for c2, _, _, b in other], [("OpenHands", "42.89")])

    print()
    if mismatches:
        print(f"與章節或結果檔不符（{len(mismatches)}／{n_checked[0]} 項）：")
        for m in mismatches:
            print("  " + m)
        sys.exit(1)
    print(f"比對：章節與 07-results.md 引用的 {n_checked[0]} 項值全部與程式算出的一致")

    a_sec, a_lab, a_c, a_v, a_sh, a_ln, a_h, a_other = anomalies[0]
    a_c2, a_hv, a_sign, a_back = a_other[0]
    print()
    print(f"結論：證實。以 critic 的容差 0.01 計（表格混用四捨五入 {mode['四捨五入']} 格、捨去 "
          f"{mode['捨去（非四捨五入）']} 格與進位 {mode['進位（非四捨五入）']} 格，所以不能用更窄的單一取位規則），"
          f"{n_need} 格需求層級主值沒有一格只符合 k/365（實算 {s01[0]} 格），只符合 k/366 的有 {s01[1]} 格，"
          f"兩種分母都符合的只有 {'、'.join(f'{x:.2f}' for x in s01[4])}（{s01[2]} 格）；"
          f"任務層級 {len(groups['task'])} 格有 {t_ok} 格符合 k/55。論文寫 365 條需求，表格的分母是 366；"
          f"成因（多一條需求、某條被重複計入或別的算法）從表格分不出來。附帶發現：{a_sec} {box_of(a_ln)} 在 {a_c} 的 "
          f"{a_v:.2f} {a_sign} 偏移 {a_sh:.2f} = {a_back:.2f}，是 {a_c2} 的人評值，不是 {a_c} 的 {a_h:.2f}。")


if __name__ == "__main__":
    main()
