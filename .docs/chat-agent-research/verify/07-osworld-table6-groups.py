#!/usr/bin/env python3
"""驗證：OSWorld Table 6 的三組分群，各自加權後能不能兜回 Table 5 的 GPT-4V (SoM) 整體分數。

主張（章節 07-agent-evaluation.md〈爭議十八〉OSWorld 那一條）：
  可行性分組兜不回整體：infeasible 16.67% 與 feasible 13.34% 分別以 30 題與 369 − 30 題加權，
  得到 (16.67×30 + 13.34×(369 − 30))/369 ≈ 13.61，但 Table 5 同一設定的整體是 11.77%；同一張
  Table 6 的單一應用 13.74% 與多應用 6.57% 以 268 題與 101 題加權，得到 ≈ 11.78，和 11.77% 吻合。
  對不上的只有可行性那一組。
出處：[arXiv:2404.07972]。組章時的重算；critic（C18）要求改成可重跑的程式。

輸入從哪來（全部由程式從 .cache/text/2404.07972.txt 解析並印出行號，不手抄）：
  - Table 6：7 個子集的「% of Total」與 GPT-4V (SoM) 的 SR。
  - Table 5：Set-of-Mark 組 GPT-4V 那一列的五類分數與 Overall。Table 5 與 Table 10 的解析直接
    借用既有的 verify/07-osworld-fail-floor.py（以 importlib 載入它的函式，不修改它）。
  - Table 10：369 題、30 題 infeasible。
  - 第 1707 行附近：除非另外說明，分析都用 GPT-4V 的 Set-of-Mark 設定（所以 Table 6 對應 Table 5 的這一列）。

方法：
  1. 由「% of Total × 369」算出每個子集的題數，檢查是不是整數（容差 0.05 題）；檢查三組分群的
     百分比各自加總是否為 100%。
  2. 三組分群（難度、可行性、應用數）各自以題數加權 SR，和 Table 5 的 Overall 比；差在 0.05 以內
     算兜得回。
  3. 對兜不回的那一組，反解：若另一格不變，這一格要是多少才兜得回。
  4. 交叉核對：Table 6 的 Multi-App Workflow 應該就是 Table 5 的 Workflow 類（題數都是 101）。

注意：OSWorld 的 reward 在 [0, 1] 之間、可以是部分分數（第 138 行附近），所以子集的 SR 不必是
  「整數題 ÷ 題數」；本程式只檢查題數是不是整數，不檢查 SR。

沒有用到隨機數。只用標準函式庫。執行：python3 07-osworld-table6-groups.py
"""

import importlib.util
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("osw", os.path.join(HERE, "07-osworld-fail-floor.py"))
osw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(osw)

TOTAL = 369
PCT = re.compile(r"^(\d+(?:\.\d+)?)%$")


def parse_table6(lines):
    i6 = osw.find_line(lines, r"^Table 6: Success rate \(SR\) of GPT-4V \(SoM\)")
    toks = osw.cells(lines, i6 + 1, i6 + 40)
    out = {}
    for j, (ln, t) in enumerate(toks):
        if j + 2 < len(toks) and PCT.match(toks[j + 1][1]) and PCT.match(toks[j + 2][1]) and not PCT.match(t):
            out[t] = (float(PCT.match(toks[j + 1][1]).group(1)), float(PCT.match(toks[j + 2][1]).group(1)), ln)
    return i6 + 1, out


def main():
    lines = osw.load_lines()
    i_def = osw.find_line(lines, r"conducted using GPT-4V under the Set-of-Mark setting")
    print(f"第 {i_def + 1} 行：除非另外說明，分析都用 GPT-4V 的 Set-of-Mark 設定")
    i_r = osw.find_line(lines, r"awards a value of 1 or a positive decimal under 1")
    print(f"第 {i_r + 1} 行：reward 可以是 1 或小於 1 的正小數（部分分數）")

    _, header, t10 = osw.parse_table10(lines)
    assert header[-1] == "Overall", header
    ex, inf = t10["Examples"][1][-1], t10["#Infeasible"][1][-1]
    assert ex == TOTAL and inf == 30, (ex, inf)
    print(f"Table 10：Overall {ex:.0f} 題、infeasible {inf:.0f} 題")

    cap6, t6 = parse_table6(lines)
    print(f"Table 6（第 {cap6} 行）：解析到 {len(t6)} 個子集：{', '.join(t6)}")
    assert len(t6) == 7, t6

    _, _, groups, _ = osw.parse_table5(lines)
    som = [g for g in groups if g[0].startswith("Set-of-Mark")]
    assert len(som) == 1, [g[0] for g in groups]
    g4 = [r for r in som[0][1] if r[0] == "GPT-4V"]
    assert len(g4) == 1, som[0][1]
    name, vals, ln = g4[0]
    overall = vals[5]
    print(f"Table 5 Set-of-Mark 組 GPT-4V（第 {ln} 行）：OS {vals[0]}、Office {vals[1]}、Daily {vals[2]}、"
          f"Profess. {vals[3]}、Workflow {vals[4]}、Overall {overall}")

    print()
    print("方法 1：子集題數 = % of Total × 369")
    sizes = {}
    for k, (share, sr, l) in t6.items():
        n = share * TOTAL / 100
        sizes[k] = n
        print(f"  {k}：{share}% × {TOTAL} = {n:.2f} 題{'' if abs(n - round(n)) <= 0.05 else '（不是整數）'}；SR {sr}%（第 {l} 行）")
    parts = {"難度": ["Easy", "Medium", "Hard"], "可行性": ["Infeasible", "Feasible"],
             "應用數": ["Single-App", "Multi-App Workflow"]}
    for pname, ks in parts.items():
        s = sum(t6[k][0] for k in ks)
        print(f"  {pname}分群的 % of Total 加總：{' + '.join(str(t6[k][0]) for k in ks)} = {s:.2f}%")

    print()
    print(f"方法 2：各分群以題數加權 SR，與 Table 5 Overall {overall} 比")
    verdict = {}
    for pname, ks in parts.items():
        ns = [round(sizes[k]) for k in ks]
        w = sum(t6[k][1] * n for k, n in zip(ks, ns)) / sum(ns)
        ok = abs(w - overall) <= 0.05
        verdict[pname] = (ok, w, ns)
        expr = " + ".join(f"{t6[k][1]}×{n}" for k, n in zip(ks, ns))
        print(f"  {pname}：({expr})/{sum(ns)} = {w:.2f} → {'兜得回' if ok else '兜不回'}")
    # 難度那組題數加總不是 369，另以「Hard = 369 − Easy − Medium」再算一次
    e, m = round(sizes["Easy"]), round(sizes["Medium"])
    h = TOTAL - e - m
    w2 = (t6["Easy"][1] * e + t6["Medium"][1] * m + t6["Hard"][1] * h) / TOTAL
    print(f"  難度（改以 Hard = 369 − {e} − {m} = {h} 題，對應 {100 * h / TOTAL:.2f}%）：{w2:.2f} → "
          f"{'兜得回' if abs(w2 - overall) <= 0.05 else '兜不回'}")
    # 不經整數題數，直接以 % of Total 加權（分母是三格百分比的加總）
    dk = parts["難度"]
    w3 = sum(t6[k][1] * t6[k][0] for k in dk) / sum(t6[k][0] for k in dk)
    print(f"  難度（直接以百分比加權）：({' + '.join(f'{t6[k][1]} × {t6[k][0]}' for k in dk)}) ÷ "
          f"{sum(t6[k][0] for k in dk):.2f} = {w3:.2f} → {'兜得回' if abs(w3 - overall) <= 0.05 else '兜不回'}")

    print()
    print("方法 3：可行性那組若要兜回 Overall，另一格需要是多少")
    ni, nf = round(sizes["Infeasible"]), round(sizes["Feasible"])
    need_f = (overall * TOTAL - t6["Infeasible"][1] * ni) / nf
    need_i = (overall * TOTAL - t6["Feasible"][1] * nf) / ni
    print(f"  infeasible 維持 {t6['Infeasible'][1]}% 時，feasible 要是 ({overall}×{TOTAL} − {t6['Infeasible'][1]}×{ni})/{nf} = {need_f:.2f}%"
          f"（表上是 {t6['Feasible'][1]}%）")
    print(f"  feasible 維持 {t6['Feasible'][1]}% 時，infeasible 要是 {need_i:.2f}%"
          f"{'（負值，不可能）' if need_i < 0 else ''}")
    print(f"  infeasible 的 {t6['Infeasible'][1]}% 對應 {t6['Infeasible'][1] * ni / 100:.2f}/{ni} 題（恰好是整數，與「正確預測失敗才給分」相容）")

    print()
    cross = abs(t6["Multi-App Workflow"][1] - vals[4]) <= 0.005
    print(f"方法 4：Table 6 的 Multi-App Workflow {t6['Multi-App Workflow'][1]}% 與 Table 5 的 Workflow {vals[4]}% "
          f"{'相同' if cross else '不同'}；題數 {round(sizes['Multi-App Workflow'])} 與 Table 10 的 workflow 題數一致與否見 07-osworld-fail-floor.py")

    print()
    bad = [p for p, (ok, _, _) in verdict.items() if not ok]
    print(f"結論：部分推翻。可行性那組兜不回屬實，但「對不上的只有可行性那一組」不成立："
          f"三組分群中兜不回 Table 5 Overall {overall}% 的是：{'、'.join(bad)}。"
          f"可行性那組算得 {verdict['可行性'][1]:.2f}；若 feasible 是 {need_f:.2f}% 就兜得回，與表上 "
          f"{t6['Feasible'][1]}% 只差一個數字，但這只是相容，不是證據。應用數那組算得 {verdict['應用數'][1]:.2f}，吻合。"
          f"難度那組的 % of Total 加總只有 {sum(t6[k][0] for k in parts['難度']):.2f}%，Hard 的 {t6['Hard'][0]}% 換算成 "
          f"{sizes['Hard']:.2f} 題不是整數，加權後 {verdict['難度'][1]:.2f}（以 Hard = {h} 題計 {w2:.2f}，"
          f"直接以百分比加權 {w3:.2f}），也兜不回。")


if __name__ == "__main__":
    main()
