#!/usr/bin/env python3
"""驗證：R-Judge 的 F1 基準率陷阱，以及子集隨機 F1 寫反。

主張（章節 03-agent-observation.md 第 302–307 行）：
  (1a) 兩個子集的正負例是 Intended 200 unsafe／214 safe、Unintended 100 unsafe／55 safe；用這組整數從 Table 1 的
       Recall 與 Specificity 重算 11 × 3 = 33 個 F1，全部與論文吻合。
  (1b) 「全判 unsafe」的全集 F1 是 2×300÷(300+569)≈69.04，子集是 65.15 與 78.43；Table 1 的 11 個模型只有
       GPT-4o（74.45）高於 69.04；GPT-4o 在 Unintended 的 80.90 只比 78.43 高 2.47。
  (1c) 子集的隨機 F1 寫反了：照 Recall＝Specificity＝50% 重算，Intended 是 200÷(200+414÷2)≈49.14、
       Unintended 是 100÷(100+155÷2)≈56.34，論文寫成 56.34 與 49.14；ChatGPT 在 Unintended 的 55.63 照正確值
       低於隨機；「只有 GPT-4o 在兩個子集都高於隨機」不受影響。
  (1d) 延伸：GPT-4o balanced accuracy≈(85.00+51.67)/2≈68.3；Meta-Llama-Guard-2-8B 71.84 只比 69.04 高一點；
       Finance 的全判 unsafe F1 47.27（GPT-4o 48.44）、IoT 77.55（GPT-4o 68.75）。
  出處：[arXiv:2401.10019] notes/2401.10019.json 的 limitations_observed 第 1、2、9 條；章節第 303–307、405 行。

輸入從哪來（全部由本程式從 .cache/text/2401.10019.txt 解析，輸出附行號，不手抄）：
  - Table 1（表題「Table 1: Main results(%)」）：11 個模型＋Random 的 All F1、兩個子集的 F1／Recall／Spec。
  - Table 3（表題「Table 3: Result(%) of Llama and Llama Guard.」）：全集層級的 F1／Recall／Spec。
  - Table 5（表題「Table 5: Statistics of R-Judge Datasets」）：五個類別的 # Unsafe／#Safe，加總得 300／269。
  - Table 8（表題「Table 8: F1 scores of all models in each category」）：GPT-4o 各類別 F1。
  - §3.4 原句：Intended Attacks 414 筆、Unintended Risks 155 筆。
  - 子集內的 unsafe／safe 拆分（200／214、100／55）論文沒有直接給；本程式把 P_I 當唯一的自由參數，
    從 145 掃到 300，找出能讓 Table 1 全部 Recall／Spec 落在格點上、且 33 個 F1 全部吻合的 P_I。

只用標準函式庫、沒有隨機數。
"""

import re
import sys
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TXT = ROOT / ".cache" / "text" / "2401.10019.txt"


def r2(x):
    """把 Fraction 四捨五入（half-up）到小數兩位，回傳 Fraction。"""
    return Fraction((x * 100 + Fraction(1, 2)).__floor__(), 100)


def t2(x):
    """把 Fraction 無條件捨去到小數兩位，回傳 Fraction（用來判斷論文的捨入慣例）。"""
    return Fraction((x * 100).__floor__(), 100)


def fmt(x):
    return f"{float(x):.4f}"


def table_before_caption(lines, caption_prefix):
    """回傳表題之前那張表的各列：[(行號, [cells])]；表格是每格一行、以 '| ' 開頭、列與列之間空一行。"""
    cap = [i for i, s in enumerate(lines) if s.startswith(caption_prefix)]
    assert len(cap) == 1, f"表題 {caption_prefix!r} 應剛好出現一次，實際 {len(cap)}"
    i = cap[0] - 1
    while i >= 0 and (lines[i].startswith("|") or lines[i].strip() == ""):
        i -= 1
    start = i + 1
    rows, cur, cur_ln = [], [], None
    for j in range(start, cap[0]):
        s = lines[j]
        if s.startswith("|"):
            if not cur:
                cur_ln = j + 1
            cur.append(s[1:].strip())
        elif cur:
            rows.append((cur_ln, cur))
            cur = []
    if cur:
        rows.append((cur_ln, cur))
    return cap[0] + 1, rows


def on_grid(value_str, denom):
    """找整數 k 使 round(k/denom×100, 2) == value；回傳所有符合的 k。"""
    v = Fraction(value_str)
    if denom == 0:
        return []
    return [k for k in range(denom + 1) if r2(Fraction(100 * k, denom)) == v]


def f1(tp, fp, fn):
    return Fraction(200 * tp, 2 * tp + fp + fn) if (2 * tp + fp + fn) else Fraction(0)


def main():
    lines = TXT.read_text(encoding="utf-8").splitlines()

    # ---------- 子集總數（§3.4）與 Table 5 的 unsafe／safe 總數 ----------
    m_i = [(n + 1, s) for n, s in enumerate(lines) if "contributed 414 samples to the data of Intended Attacks" in s]
    m_u = [(n + 1, s) for n, s in enumerate(lines) if re.search(r"^155 data of Unintended Risks", s)]
    assert len(m_i) == 1 and len(m_u) == 1, "找不到 §3.4 的 414／155 原句"
    N_INT, N_UNI = 414, 155
    src_parts = [int(x) for x in re.findall(r"(\d+) samples", m_i[0][1])]
    print(f"[§3.4 第 {m_i[0][0]}、{m_u[0][0]} 行] Intended Attacks = {N_INT}，Unintended Risks = {N_UNI}")
    print(f"  旁註：同段列出的 Unintended 來源 {src_parts[1:]}（ToolEmu／AgentMonitor／人工）加總 "
          f"{sum(src_parts[1:])}，不等於 155；414+155 = {N_INT + N_UNI}")

    cap5, t5 = table_before_caption(lines, "Table 5: Statistics of R-Judge Datasets")
    assert t5[0][1] == ["Scenario", "Sum", "# Unsafe", "#Safe", "Average Turn", "Average Word Number"], t5[0]
    body5 = t5[1:]
    assert len(body5) == 5, f"Table 5 應有 5 列，實際 {len(body5)}"
    cat = {c[0]: (int(c[1]), int(c[2]), int(c[3])) for _, c in body5}
    for name, (s, u, f) in cat.items():
        assert s == u + f, f"{name} 的 Sum≠Unsafe+Safe"
    P_ALL = sum(u for _, u, _ in cat.values())
    N_ALL = sum(f for _, _, f in cat.values())
    print(f"[Table 5，表題第 {cap5} 行] 五類 unsafe 加總 {P_ALL}、safe 加總 {N_ALL}、合計 {P_ALL + N_ALL}"
          f"；unsafe 比例 {100 * P_ALL / (P_ALL + N_ALL):.2f}%")
    assert P_ALL + N_ALL == N_INT + N_UNI == 569

    # ---------- Table 1 ----------
    cap1, t1 = table_before_caption(lines, "Table 1: Main results(%)")
    assert t1[0][1] == ["Models", "All", "Intended Attacks", "Unintended Risks"], t1[0]
    assert t1[1][1] == ["F1", "F1", "Recall", "Spec", "Effect", "F1", "Recall", "Spec", "Effect"], t1[1]
    body1 = t1[2:]
    assert len(body1) == 12, f"Table 1 應有 12 列（11 模型＋Random），實際 {len(body1)}"
    assert all(len(c) == 10 for _, c in body1)
    rows = {c[0]: dict(ln=ln, all_f1=c[1], i_f1=c[2], i_rec=c[3], i_spec=c[4], u_f1=c[6], u_rec=c[7], u_spec=c[8])
            for ln, c in body1}
    random_row = rows.pop("Random")
    models = list(rows)
    assert len(models) == 11
    print(f"[Table 1，表題第 {cap1} 行] 解析到 {len(models)} 個模型＋Random 列")

    # ---------- (1a) 唯一性搜尋：P_I 從 145 掃到 300 ----------
    print("\n== (1a) 子集拆分的唯一性搜尋 ==")
    survivors_grid, survivors_f1 = [], []
    detail = {}
    for P_I in range(0, P_ALL + 1):
        N_I = N_INT - P_I
        P_U = P_ALL - P_I
        N_U = N_UNI - P_U
        if min(N_I, P_U, N_U) < 0 or 0 in (P_I, N_I, P_U, N_U):
            continue
        ok_grid, ok_f1, per = True, True, {}
        for name in models:
            r = rows[name]
            ks = [on_grid(r["i_rec"], P_I), on_grid(r["i_spec"], N_I), on_grid(r["u_rec"], P_U), on_grid(r["u_spec"], N_U)]
            if any(len(k) != 1 for k in ks):
                ok_grid = ok_f1 = False
                break
            tp_i, tn_i, tp_u, tn_u = (k[0] for k in ks)
            fi = f1(tp_i, N_I - tn_i, P_I - tp_i)
            fu = f1(tp_u, N_U - tn_u, P_U - tp_u)
            fa = f1(tp_i + tp_u, (N_I - tn_i) + (N_U - tn_u), (P_I - tp_i) + (P_U - tp_u))
            per[name] = (fa, fi, fu, tp_i, tn_i, tp_u, tn_u)
            if (r2(fa), r2(fi), r2(fu)) != (Fraction(r["all_f1"]), Fraction(r["i_f1"]), Fraction(r["u_f1"])):
                ok_f1 = False
        if ok_grid:
            survivors_grid.append(P_I)
        if ok_grid and ok_f1:
            survivors_f1.append(P_I)
            detail[P_I] = per
    print(f"  可行範圍內，44 個 Recall／Spec 全部落在格點上的 P_I：{survivors_grid}")
    print(f"  其中 33 個 F1 也全部吻合的 P_I：{survivors_f1}")
    assert survivors_f1 == [200], "唯一解不是 200，主張 (1a) 不成立"
    P_I, N_I, P_U, N_U = 200, N_INT - 200, P_ALL - 200, N_UNI - (P_ALL - 200)
    print(f"  → 唯一解：Intended {P_I} unsafe／{N_I} safe，Unintended {P_U} unsafe／{N_U} safe")

    n_round = n_trunc = 0
    print(f"\n  {'模型':<26}{'All 重算':>10}{'表':>8}{'I 重算':>10}{'表':>8}{'U 重算':>10}{'表':>8}")
    for name in models:
        fa, fi, fu, *_ = detail[200][name]
        r = rows[name]
        for calc, tab in ((fa, r["all_f1"]), (fi, r["i_f1"]), (fu, r["u_f1"])):
            n_round += r2(calc) == Fraction(tab)
            n_trunc += t2(calc) == Fraction(tab)
        print(f"  {name:<26}{fmt(fa):>10}{r['all_f1']:>8}{fmt(fi):>10}{r['i_f1']:>8}{fmt(fu):>10}{r['u_f1']:>8}"
              f"   (第 {r['ln']} 行)")
    print(f"  33 個 F1：四捨五入吻合 {n_round}/33，無條件捨去吻合 {n_trunc}/33 → 論文用四捨五入")

    # Table 3：全集層級 Recall／Spec，直接對 300／269 的格點
    cap3, t3 = table_before_caption(lines, "Table 3: Result(%) of Llama and Llama Guard.")
    assert t3[0][1] == ["Models", "F1", "Recall", "Spec"], t3[0]
    assert len(t3) == 5
    print(f"\n  對照組 [Table 3，表題第 {cap3} 行]：全集層級 Recall／Spec 直接對 {P_ALL}／{N_ALL} 的格點")
    t3rows = {}
    for ln, c in t3[1:]:
        kr, ks = on_grid(c[2], P_ALL), on_grid(c[3], N_ALL)
        assert len(kr) == 1 and len(ks) == 1, f"{c[0]} 的 Recall／Spec 不在 300／269 格點上"
        calc = f1(kr[0], N_ALL - ks[0], P_ALL - kr[0])
        t3rows[c[0]] = Fraction(c[1])
        print(f"    {c[0]:<26} TP={kr[0]:>3} TN={ks[0]:>3}  F1 重算 {fmt(calc)}  表 {c[1]:>6}  "
              f"{'吻合' if r2(calc) == Fraction(c[1]) else '不吻合'}  (第 {ln} 行)")
        assert r2(calc) == Fraction(c[1])

    # ---------- (1b) 全判 unsafe ----------
    print("\n== (1b) 全判 unsafe 的 F1 與各模型比較 ==")
    all_unsafe = {"All": Fraction(200 * P_ALL, 2 * P_ALL + N_ALL),
                  "Intended": Fraction(200 * P_I, 2 * P_I + N_I),
                  "Unintended": Fraction(200 * P_U, 2 * P_U + N_U)}
    for k, v in all_unsafe.items():
        print(f"  全判 unsafe {k:<10} = {fmt(v)} → {float(r2(v)):.2f}")
    assert (float(r2(all_unsafe["All"])), float(r2(all_unsafe["Intended"])), float(r2(all_unsafe["Unintended"]))) \
        == (69.04, 65.15, 78.43)
    above_all = [m for m in models if Fraction(rows[m]["all_f1"]) > all_unsafe["All"]]
    above_i = [m for m in models if Fraction(rows[m]["i_f1"]) > all_unsafe["Intended"]]
    above_u = [m for m in models if Fraction(rows[m]["u_f1"]) > all_unsafe["Unintended"]]
    print(f"  Table 1 全集 F1 高於 69.04 的模型：{above_all}（{len(above_all)}/11）")
    print(f"  Intended F1 高於 65.15：{above_i}")
    print(f"  Unintended F1 高於 78.43：{above_u}")
    gap = Fraction(rows["GPT-4o"]["u_f1"]) - r2(all_unsafe["Unintended"])
    print(f"  GPT-4o Unintended 80.90 − 78.43 = {float(gap):.2f}")
    print(f"  Table 3：Meta-Llama-Guard-2-8B {float(t3rows['Meta-Llama-Guard-2-8B']):.2f} − 69.04 = "
          f"{float(t3rows['Meta-Llama-Guard-2-8B'] - r2(all_unsafe['All'])):.2f}；"
          f"LlamaGuard-7b {float(t3rows['LlamaGuard-7b']):.2f}")
    assert above_all == ["GPT-4o"]

    # ---------- (1c) 隨機 F1 ----------
    print("\n== (1c) 隨機 F1（Recall＝Specificity＝50%）：P/(1.5P+0.5N) ==")
    rand = {"All": (P_ALL, N_ALL, random_row["all_f1"]), "Intended": (P_I, N_I, random_row["i_f1"]),
            "Unintended": (P_U, N_U, random_row["u_f1"])}
    rand_calc = {}
    for k, (p, n, tab) in rand.items():
        v = Fraction(p) / (Fraction(3, 2) * p + Fraction(1, 2) * n) * 100
        rand_calc[k] = v
        print(f"  {k:<10} 重算 {fmt(v)} → 四捨五入 {float(r2(v)):.2f}、捨去 {float(t2(v)):.2f}；"
              f"論文 {tab}（第 {random_row['ln']} 行起）")
    swapped = (r2(rand_calc["Intended"]) == Fraction(random_row["u_f1"])
               and r2(rand_calc["Unintended"]) == Fraction(random_row["i_f1"]))
    print(f"  兩個子集的值是否恰好對調：{swapped}")
    print(f"  全集：四捨五入是 {float(r2(rand_calc['All'])):.2f}，論文 {random_row['all_f1']}（末位差 "
          f"{float(r2(rand_calc['All']) - Fraction(random_row['all_f1'])):.2f}；只有捨去才得到 51.32）")
    chat_u = Fraction(rows["ChatGPT"]["u_f1"])
    print(f"  ChatGPT Unintended {float(chat_u):.2f}：對論文值 {random_row['u_f1']} "
          f"{'高於' if chat_u > Fraction(random_row['u_f1']) else '低於'}，對重算值 {float(r2(rand_calc['Unintended'])):.2f} "
          f"{'高於' if chat_u > rand_calc['Unintended'] else '低於'}")
    both_correct = [m for m in models if Fraction(rows[m]["i_f1"]) > rand_calc["Intended"]
                    and Fraction(rows[m]["u_f1"]) > rand_calc["Unintended"]]
    both_paper = [m for m in models if Fraction(rows[m]["i_f1"]) > Fraction(random_row["i_f1"])
                  and Fraction(rows[m]["u_f1"]) > Fraction(random_row["u_f1"])]
    print(f"  兩個子集都高於隨機：用重算值 {both_correct}；用論文值 {both_paper}")

    # ---------- (1d) 延伸 ----------
    print("\n== (1d) 延伸數字 ==")
    _, _, _, tp_i, tn_i, tp_u, tn_u = detail[200]["GPT-4o"]
    rec_all = Fraction(100 * (tp_i + tp_u), P_ALL)
    spec_all = Fraction(100 * (tn_i + tn_u), N_ALL)
    print(f"  GPT-4o 全集 Recall {tp_i + tp_u}/{P_ALL} = {fmt(rec_all)}，Spec {tn_i + tn_u}/{N_ALL} = {fmt(spec_all)}，"
          f"balanced accuracy = {fmt((rec_all + spec_all) / 2)}")
    print(f"  GPT-4o Intended Spec {rows['GPT-4o']['i_spec']} → 誤判 safe 為 unsafe 的比例 "
          f"{100 - float(rows['GPT-4o']['i_spec']):.2f}%")
    cap8, t8 = table_before_caption(lines, "Table 8: F1 scores of all models in each category")
    assert t8[0][1] == ["Model", "ALL", "Software", "Finance", "IoT", "Program", "Web"], t8[0]
    g8 = [c for _, c in t8 if c[0] == "GPT-4o"]
    assert len(g8) == 1
    g8 = dict(zip(t8[0][1][1:], g8[0][1:]))
    for c in ("Finance", "IoT"):
        _, u, f = cat[c]
        base = Fraction(200 * u, 2 * u + f)
        print(f"  {c:<8} unsafe {u}／safe {f}：全判 unsafe F1 = {fmt(base)}；GPT-4o = {g8[c]}（Table 8，表題第 {cap8} 行）"
              f"；差 {float(Fraction(g8[c]) - base):+.2f}")

    print("\n結論：(1a) 唯一解 200／214、100／55，33 個 F1 全部吻合；(1b) 只有 GPT-4o 高於 69.04；"
          "(1c) 子集隨機 F1 對調，全集 51.32 與四捨五入值 51.33 差 0.01。")
    print("DONE 03-rjudge-f1-base-rate")


if __name__ == "__main__":
    sys.exit(main())
