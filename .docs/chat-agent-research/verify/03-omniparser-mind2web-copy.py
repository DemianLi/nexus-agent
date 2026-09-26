#!/usr/bin/env python3
"""驗證：OmniParser 的 Mind2Web Table 3 有四列把 Cross-Domain 抄進 Cross-Task，更正後 MindAct 仍領先兩個 split。

主張（章節 03-agent-observation.md 第 355 行）：
  (2a) OmniParser Table 3 裡 MindAct (gen)、MindAct、GPT-3.5-Turbo、Qwen-VL 四列的 Cross-Task 欄，都重複抄了
       Cross-Domain 的數字。
  (2b) 正確值是：MindAct 55.1／75.7／52.0、MindAct (gen) 20.2／52.0／17.5、GPT-3.5-Turbo 20.3／56.6／17.4、
       Qwen-VL 15.9／86.7／13.3（Ele.Acc／Op.F1／Step SR）。
  (2c) 更正後，微調過的 MindAct 在 Cross-Task（Step SR 52.0 對 39.4）與 Cross-Website（38.9 對 36.5）仍領先
       OmniParser，OmniParser 只在 Cross-Domain（42.0 對 39.6）勝出。
  出處：[arXiv:2408.00203] notes/2408.00203.json 的 limitations_observed 第 2 條；
        [arXiv:2401.10935] 作為對照來源（SeeClick Table 4）。

輸入從哪來（全部由本程式解析，輸出附行號，不手抄）：
  - OmniParser Table 3：.cache/text/2408.00203.txt，表題「Table 3: Comparison of different methods across various
    categories on Mind2Web benchmark.」（表題在表之後）。欄序 Cross-Website／Cross-Domain／Cross-Task。
  - SeeClick Table 4：.cache/text/2401.10935.txt，表題「Table 4: Comparsion of methods on Mind2Web.」（表題在表之後）。
    欄序 Cross-Task／Cross-Website／Cross-Domain。
  - 第三來源：Mind2Web 原文 Table 2，.cache/text/2306.06070.txt，表題「Table 2: Main results.」（表題在表之前），
    每個 split 多一欄 SR。Qwen-VL 不在這張表裡，只有 SeeClick 一個來源。
  欄位一律依表頭名稱對應，不依位置。

只用標準函式庫、沒有隨機數。
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "text"
METRICS = ("Ele.Acc", "Op.F1", "Step SR")
SPLITS = ("Cross-Task", "Cross-Website", "Cross-Domain")


def groups(lines, lo, hi):
    """把 [lo, hi) 內每格一行的表格切成列：[(行號, [cells])]。"""
    rows, cur, ln = [], [], None
    for j in range(lo, hi):
        s = lines[j]
        if s.startswith("|"):
            if not cur:
                ln = j + 1
            cur.append(s[1:].strip().replace("$", "").strip())
        elif cur:
            rows.append((ln, cur))
            cur = []
    if cur:
        rows.append((ln, cur))
    return rows


def caption_idx(lines, prefix):
    idx = [i for i, s in enumerate(lines) if s.startswith(prefix)]
    assert len(idx) == 1, f"表題 {prefix!r} 應剛好出現一次，實際 {len(idx)}"
    return idx[0]


def table_before(lines, prefix):
    c = caption_idx(lines, prefix)
    i = c - 1
    while i >= 0 and (lines[i].startswith("|") or lines[i].strip() == ""):
        i -= 1
    return c + 1, groups(lines, i + 1, c)


def table_after(lines, prefix):
    c = caption_idx(lines, prefix)
    i = c + 1
    while i < len(lines) and not lines[i].startswith("|"):
        i += 1
    j = i
    while j < len(lines) and (lines[j].startswith("|") or lines[j].strip() == ""):
        j += 1
    return c + 1, groups(lines, i, j)


def to_split_dict(split_order, metric_order, values):
    """values 依表頭順序排列；回傳 {split: {metric: 字串}}。"""
    per = len(metric_order)
    assert len(values) == per * len(split_order)
    out = {}
    for si, sp in enumerate(split_order):
        out[sp] = {m: values[si * per + mi] for mi, m in enumerate(metric_order)}
    return out


def triple(d, sp):
    return tuple(d[sp][m] for m in METRICS)


def main():
    # ---------- OmniParser Table 3 ----------
    om = (CACHE / "2408.00203.txt").read_text(encoding="utf-8").splitlines()
    cap_o, t_o = table_before(om, "Table 3: Comparison of different methods across various categories on Mind2Web")
    assert t_o[0][1] == ["Methods", "Input Types", "Cross-Website", "Cross-Domain", "Cross-Task"], t_o[0]
    assert t_o[1][1] == ["", "HTML free", "image"] + list(METRICS) * 3, t_o[1]
    om_split_order = t_o[0][1][2:]
    omni = {}
    for ln, c in t_o[2:]:
        assert len(c) == 12, (ln, c)
        omni[c[0]] = dict(ln=ln, d=to_split_dict(om_split_order, METRICS, c[3:]))
    assert len(omni) == 11, f"OmniParser Table 3 應有 11 列，實際 {len(omni)}"
    print(f"[OmniParser Table 3，表題第 {cap_o} 行] {len(omni)} 列；欄序 {om_split_order}")

    # ---------- SeeClick Table 4 ----------
    sc = (CACHE / "2401.10935.txt").read_text(encoding="utf-8").splitlines()
    cap_s, t_s = table_before(sc, "Table 4: Comparsion of methods on Mind2Web.")
    assert t_s[0][1] == ["Methods", "w/o HTML", "Cross-Task", "Cross-Website", "Cross-Domain"], t_s[0]
    assert t_s[1][1] == list(METRICS) * 3, t_s[1]
    sc_split_order = t_s[0][1][2:]
    seeclick = {}
    for ln, c in t_s[2:]:
        assert len(c) == 11, (ln, c)
        seeclick[c[0]] = dict(ln=ln, d=to_split_dict(sc_split_order, METRICS, c[2:]))
    assert len(seeclick) == 6
    print(f"[SeeClick Table 4，表題第 {cap_s} 行] {len(seeclick)} 列；欄序 {sc_split_order}")

    # ---------- Mind2Web 原文 Table 2 ----------
    m2 = (CACHE / "2306.06070.txt").read_text(encoding="utf-8").splitlines()
    cap_m, t_m = table_after(m2, "Table 2: Main results.")
    assert t_m[0][1] == ["", "Cross-Task", "Cross-Website", "Cross-Domain"], t_m[0]
    m2_metrics = ["Ele. Acc", "Op. F1", "Step SR", "SR"]
    assert t_m[1][1] == [""] + m2_metrics * 3, t_m[1]
    m2_split_order = t_m[0][1][1:]
    mind2web = {}
    for ln, c in t_m[2:]:
        if all(x == "" for x in c[1:]):
            continue  # 「MindAct」分組標題列
        assert len(c) == 13, (ln, c)
        d = to_split_dict(m2_split_order, m2_metrics, c[1:])
        d = {sp: {"Ele.Acc": v["Ele. Acc"], "Op.F1": v["Op. F1"], "Step SR": v["Step SR"]} for sp, v in d.items()}
        mind2web[c[0]] = dict(ln=ln, d=d)
    print(f"[Mind2Web Table 2，表題第 {cap_m} 行] 列名 {list(mind2web)}")

    name_map_m2 = {"MindAct (gen)": "Generation", "MindAct": "w/ Flan-T5XL", "GPT-3.5-Turbo": "w/ GPT-3.5",
                   "GPT-4": "w/ GPT-4∗"}
    name_map_sc = {"MindAct (gen)": "MindAct (gen)", "MindAct": "MindAct", "GPT-3.5-Turbo": "GPT-3.5-Turbo",
                   "GPT-4": "GPT-4", "Qwen-VL": "Qwen-VL", "SeeClick": "SeeClick"}
    print(f"  列名對照（OmniParser → Mind2Web）：{name_map_m2}")
    for k, v in name_map_m2.items():
        assert v in mind2web, f"Mind2Web 表中找不到 {v}"

    # ---------- (2a) 只用 OmniParser 自己：哪幾列 CT 三格 == CD 三格 ----------
    print("\n== (2a) OmniParser 表內重複偵測：Cross-Task 三格是否等於 Cross-Domain 三格 ==")
    dup = []
    for name, r in omni.items():
        ct, cd = triple(r["d"], "Cross-Task"), triple(r["d"], "Cross-Domain")
        same = ct == cd
        if same:
            dup.append(name)
        print(f"  {name:<26} CT={'/'.join(ct):<18} CD={'/'.join(cd):<18} {'★ 重複' if same else ''}  (第 {r['ln']} 行)")
    print(f"  CT 與 CD 完全相同的列：{dup}")
    claimed = {"MindAct (gen)", "MindAct", "GPT-3.5-Turbo", "Qwen-VL"}
    assert set(dup) == claimed, "重複的列與主張不符"

    # ---------- (2b) 與 SeeClick、Mind2Web 逐格比對 ----------
    print("\n== (2b) 逐格比對：OmniParser vs SeeClick Table 4 vs Mind2Web Table 2 ==")
    mismatch = []
    for name in ["MindAct (gen)", "MindAct", "GPT-3.5-Turbo", "Qwen-VL", "GPT-4", "SeeClick"]:
        o = omni[name]["d"]
        s = seeclick[name_map_sc[name]]["d"]
        m = mind2web[name_map_m2[name]]["d"] if name in name_map_m2 else None
        for sp in SPLITS:
            ot, st = triple(o, sp), triple(s, sp)
            mt = triple(m, sp) if m else None
            agree_sm = (mt is None) or (st == mt)
            flag = "一致" if ot == st else "不一致"
            if ot != st:
                mismatch.append((name, sp))
            print(f"  {name:<14}{sp:<14} OmniParser {'/'.join(ot):<16} SeeClick {'/'.join(st):<16} "
                  f"Mind2Web {('/'.join(mt) if mt else '（無此列）'):<16} → OmniParser 與 SeeClick {flag}"
                  f"{'' if agree_sm else '；SeeClick 與 Mind2Web 也不一致！'}")
            assert agree_sm, f"SeeClick 與 Mind2Web 在 {name} {sp} 不一致"
        # 抄錯的 CT 是否就是 SeeClick 的 CD
        if name in claimed:
            assert triple(o, "Cross-Task") == triple(s, "Cross-Domain")
    print(f"  OmniParser 與 SeeClick 不一致的格子：{mismatch}")
    assert set(mismatch) == {(n, "Cross-Task") for n in claimed}, "不一致的格子不只 Cross-Task 那四列"
    print("  → 不一致的只有這四列的 Cross-Task；其值等於各自的 Cross-Domain。"
          "GPT-4 與 SeeClick 兩列（對照組）三個 split 全部一致。")

    # ---------- (2c) 更正後的比較 ----------
    print("\n== (2c) 更正後：MindAct（SeeClick／Mind2Web 值）vs OmniParser 最佳列（Step SR）==")
    omni_rows = [k for k in omni if k.startswith("OmniParser")]
    assert len(omni_rows) == 2
    wins = {}
    for sp in SPLITS:
        best = max(omni_rows, key=lambda k: float(omni[k]["d"][sp]["Step SR"]))
        ov = float(omni[best]["d"][sp]["Step SR"])
        mv = float(seeclick["MindAct"]["d"][sp]["Step SR"])
        wins[sp] = "MindAct" if mv > ov else "OmniParser"
        print(f"  {sp:<14} MindAct {mv:>5.1f}  OmniParser 最佳 {ov:>5.1f}（{best}）→ {wins[sp]} 領先 {abs(mv - ov):.1f}")
    assert wins == {"Cross-Task": "MindAct", "Cross-Website": "MindAct", "Cross-Domain": "OmniParser"}
    mis_ct = float(omni["MindAct"]["d"]["Cross-Task"]["Step SR"])
    best_ct = max(float(omni[k]["d"]["Cross-Task"]["Step SR"]) for k in omni_rows)
    print(f"  對照：照 OmniParser 抄錯的值，MindAct Cross-Task 是 {mis_ct}，只比 OmniParser 的 {best_ct} 高 "
          f"{mis_ct - best_ct:.1f}；真值 52.0 高 {52.0 - best_ct:.1f}。抄錯把 {52.0 - best_ct:.1f} 點的差距縮成 {mis_ct - best_ct:.1f} 點。")

    # 但書：測試集大小（兩邊都從原文解析）
    om_ln = [(i + 1, s) for i, s in enumerate(om) if "In total we have" in s]
    assert len(om_ln) == 1
    om_n = re.findall(r"(\d+), (\d+), (\d+) tasks", om_ln[0][1])[0]
    m2_n = {}
    for i, s in enumerate(m2):
        for sp, pat in (("Cross-Domain", r"with \$(\d+)\$ tasks from \$73\$ websites\. Here"),
                        ("Cross-Website", r"containing \$(\d+)\$ tasks"),
                        ("Cross-Task", r"resulting in \$(\d+)\$ tasks")):
            mm = re.search(pat, s)
            if mm:
                m2_n[sp] = (int(mm.group(1)), i + 1)
    assert set(m2_n) == set(SPLITS), m2_n
    print(f"\n  但書（測試集不同）：OmniParser（第 {om_ln[0][0]} 行）CD／CW／CT = {'／'.join(om_n)} 題；"
          f"Mind2Web 原文 CD／CW／CT = {m2_n['Cross-Domain'][0]}／{m2_n['Cross-Website'][0]}／{m2_n['Cross-Task'][0]} 題"
          f"（第 {m2_n['Cross-Domain'][1]} 行起）。兩邊題目集合不同，(2c) 是跨測試集的比較。")

    print("\n結論：(2a)(2b) 證實，四列 Cross-Task 抄成 Cross-Domain；(2c) 更正後 MindAct 在 CT 與 CW 領先、"
          "OmniParser 只在 CD 勝出（跨測試集比較）。")
    print("DONE 03-omniparser-mind2web-copy")


if __name__ == "__main__":
    sys.exit(main())
