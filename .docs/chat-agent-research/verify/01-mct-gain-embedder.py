"""驗證：2010.05256 的 MCT 增益要看拿哪一個「不含 MCT」當對照，而且 Table 4 只有 Electra。

主張（章節 01-goal-intent.md〈爭議〉十一「多意圖偵測的 MCT 增益」）：
  以主表 MPN+ALR（Electra）為對照，MCT 增益是
    TourSG 51.07−33.46＝17.61、52.63−32.98＝19.65（1-shot、5-shot），
    StanfordLU 42.51−35.93＝6.58、50.82−47.11＝3.71；
  Table 4 的去 MCT 差值是 12.52／16.70／10.12／17.45。
  所以筆記「MCT 的真實增益遠小於 Table 4」只在 StanfordLU 成立，TourSG 反而較大；
  而且 Table 4 隱含的「不含 MCT」分數與主表 MPN+ALR 逐欄都不同。

出處：[arXiv:2010.05256]；筆記 notes/2010.05256.json 的 limitations_observed 第 2 條
（筆記的「+2.10～+6.20」是 BERT 主表的差值，本程式另外印出，說明它和 Electra 的 Table 4 不能直接比）。

輸入數字全部取自 .cache/text/2010.05256.txt：
  - Table 2（1-shot）與 Table 3（5-shot）的 +E、+B 兩段裡 MPN+ALR 與 Ours 兩列。
    欄位依序是 TourSG 六個領域、TourSG Ave.、StanfordLU 三個領域、StanfordLU Ave.。
    表格列在附錄會重複出現，所以列一律在「+E | TransferM | 起始值」到「+B | TransferM | 起始值」
    這段位置裡找，不只做子字串比對。
  - Table 4：Ours 列與「- MCT」列（欄位 TourSG 1-shot、5-shots、StanfordLU 1-shot、5-shots）。
  - 三句原文：消融用 "vanilla threshold tuned on source domains"；基線 MPN 用 "fixed threshold tuned on dev set"；
    "Our model can be regarded as MPN+ALR+MCT"。

檢查：
  1. 校準：每列六個（或三個）領域分數的簡單平均，要等於同列的 Ave.（容差 0.01）；
     這確認欄位切得對。
  2. Table 4 的 Ours 列要與主表 +E 的 Ours Ave. 四格相同，確認 Table 4 是 Electra。
  3. 主表對照的 MCT 增益＝Ours − MPN+ALR（+E），逐格與 Table 4 的去 MCT 差值比較：
     判準是 TourSG 兩格主表增益較大、StanfordLU 兩格主表增益較小。
  4. Table 4 隱含的「不含 MCT」＝Ours − 去 MCT 差值，與主表 MPN+ALR 逐欄比較（依位置，不依集合），
     四格都不同才算「兩個不含 MCT 對不上」。
  5. 同法算 +B（BERT）的增益，範圍要等於章節寫的 2.10 到 6.20（筆記的依據）；
     而且 Table 4 的 Ours 列要與主表 +B 的 Ours Ave. 不同，確認 Table 4 沒有 BERT 版，BERT 增益不能拿來和它比。
  以上五項全部成立才判「證實」；結論字串由算出的值組成。

執行：python3 verify/01-mct-gain-embedder.py（只用標準函式庫，無隨機數）。
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", ".cache", "text", "2010.05256.txt")

# --- 輸入（取自 .cache/text/2010.05256.txt） ---
# 每段的起訖錨點與段內的兩列；欄位：It Ac At Fo Tr Sh Ave. | Sc Na We Ave.
SEGMENTS = {
    ("1-shot", "+E"): {
        "start": "| +E | TransferM | 14.34 |",
        "end": "| +B | TransferM | 16.78 |",
        "MPN+ALR": "28.74 | 34.94 | 35.06 | 34.62 | 35.53 | 31.87 | 33.46 | 33.35 | 28.88 | 45.58 | 35.93",
        "Ours": "39.98 | 51.55 | 55.16 | 52.16 | 55.36 | 52.20 | 51.07 | 40.61 | 40.76 | 46.16 | 42.51",
    },
    ("1-shot", "+B"): {
        "start": "| +B | TransferM | 16.78 |",
        "end": "Table 2: F1 scores on 1-shot multi-label intent detection.",
        "MPN+ALR": "40.99 | 51.57 | 54.91 | 51.90 | 54.87 | 50.76 | 50.83 | 38.81 | 41.08 | 54.16 | 44.68",
        "Ours": "44.58 | 57.11 | 60.34 | 56.49 | 60.18 | 55.60 | 55.72 | 42.55 | 56.95 | 53.14 | 50.88",
    },
    ("5-shot", "+E"): {
        "start": "| +E | TransferM | 14.72 |",
        "end": "| +B | TransferM | 17.98 |",
        "MPN+ALR": "29.74 | 30.91 | 34.28 | 33.61 | 35.90 | 33.44 | 32.98 | 44.52 | 42.39 | 54.42 | 47.11",
        "Ours": "44.21 | 51.37 | 55.76 | 54.50 | 55.37 | 54.55 | 52.63 | 51.83 | 46.44 | 54.17 | 50.82",
    },
    ("5-shot", "+B"): {
        "start": "| +B | TransferM | 17.98 |",
        "end": "Table 3: F1 score results on 5-shot multi-label intent detection.",
        "MPN+ALR": "45.51 | 53.71 | 58.16 | 56.91 | 57.62 | 54.86 | 54.46 | 51.30 | 47.80 | 60.08 | 53.06",
        "Ours": "46.80 | 54.79 | 59.95 | 59.11 | 60.13 | 58.56 | 56.56 | 52.17 | 60.36 | 59.63 | 57.39",
    },
}
# Table 4：| Setting | TourSG 1-shot | TourSG 5-shots | StanfordLU 1-shot | StanfordLU 5-shots |
TABLE4_RAW = "| Ours | 51.07 | 52.63 | 42.51 | 50.82 | - ALR | -38.53 | -31.33 | -11.33 | -10.31 | - MCT | -12.52 | -16.70 | -10.12 | -17.45 Table 4:"
TEXT_ANCHORS = [
    "we conduct 1-shot/5-shots ablation study with Electra embedding in Table 4.",
    "For our model without MCT, we use a vanilla threshold tuned on source domains.",
    "uses a fixed threshold tuned on dev set.",
    "Our model can be regarded as MPN+ALR+MCT.",
]
CELLS = [("TourSG", "1-shot"), ("TourSG", "5-shot"), ("StanfordLU", "1-shot"), ("StanfordLU", "5-shot")]
# 章節寫的 BERT（+B）主表 MCT 增益範圍（筆記「+2.10～+6.20」）
CLAIM_BERT_RANGE = (2.10, 6.20)


def parse_row(raw):
    v = [float(x) for x in raw.split("|")]
    return {"TourSG": v[:6], "TourSG_ave": v[6], "StanfordLU": v[7:10], "StanfordLU_ave": v[10]}


def parse_table4(raw):
    ours = re.search(r"\| Ours \| ([^A-Za-z]+?) \| - ALR", raw).group(1)
    mct = re.search(r"\| - MCT \| ([^A-Za-z]+?) Table 4", raw).group(1)
    return [float(x) for x in ours.split("|")], [-float(x) for x in mct.split("|")]


def flatten(path):
    with open(path, encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]
    return re.sub(r"\s+", " ", " ".join(lines))


def check_anchors():
    if not os.path.exists(SOURCE):
        print(f"[錨點] 找不到 {SOURCE}，略過錨點檢查（.cache/ 不進版控）")
        return None
    flat = flatten(SOURCE)
    ok = True
    for (shot, emb), seg in SEGMENTS.items():
        s = flat.find(seg["start"])
        e = flat.find(seg["end"], s + 1) if s >= 0 else -1
        part = flat[s:e] if s >= 0 and e > s else ""
        for row in ("MPN+ALR", "Ours"):
            hit = f"| {row} | {seg[row]}" in part
            ok = ok and hit
            print(f"[錨點] {'找到' if hit else '缺少'}：{shot} {emb} 段內的 {row} 列")
    for a in [TABLE4_RAW] + TEXT_ANCHORS:
        hit = a in flat
        ok = ok and hit
        print(f"[錨點] {'找到' if hit else '缺少'}：{a[:80]}")
    return ok


def main():
    anchors_ok = check_anchors()
    print()
    rows = {k: {r: parse_row(seg[r]) for r in ("MPN+ALR", "Ours")} for k, seg in SEGMENTS.items()}

    print("[校準] 各領域簡單平均是否等於同列 Ave.")
    calib_ok = True
    for (shot, emb), rr in rows.items():
        for name, r in rr.items():
            for ds in ("TourSG", "StanfordLU"):
                m = sum(r[ds]) / len(r[ds])
                ok = abs(m - r[ds + "_ave"]) <= 0.01
                calib_ok = calib_ok and ok
                if not ok:
                    print(f"  不符：{shot} {emb} {name} {ds} 平均 {m:.3f} 對 Ave. {r[ds + '_ave']}")
    print(f"  16 組平均全部吻合（容差 0.01）：{'是' if calib_ok else '否'}")
    print()

    t4_ours, t4_mct = parse_table4(TABLE4_RAW)

    def ave(shot, emb, name, ds):
        return rows[(shot, emb)][name][ds + "_ave"]

    main_ours_e = [ave(shot, "+E", "Ours", ds) for ds, shot in CELLS]
    same = all(abs(a - b) < 1e-9 for a, b in zip(t4_ours, main_ours_e))
    print(f"[嵌入器] Table 4 的 Ours 列 {t4_ours} 與主表 +E（Electra）Ours 的 Ave. {main_ours_e} 相同：{'是' if same else '否'}")
    main_ours_b = [ave(shot, "+B", "Ours", ds) for ds, shot in CELLS]
    same_b = all(abs(a - b) < 1e-9 for a, b in zip(t4_ours, main_ours_b))
    print(f"  與主表 +B（BERT）Ours 相同：{'是' if same_b else '否'}")
    print()

    print("[比較] MCT 增益：以主表 MPN+ALR（+E）為對照，對 Table 4 的去 MCT 差值")
    gain_main = []
    for (ds, shot), t4 in zip(CELLS, t4_mct):
        o, m = ave(shot, "+E", "Ours", ds), ave(shot, "+E", "MPN+ALR", ds)
        g = o - m
        gain_main.append(g)
        rel = "較大" if g > t4 else "較小"
        print(f"  {ds:10s} {shot}：{o:.2f}−{m:.2f}＝{g:.2f}，Table 4 為 {t4:.2f}，主表對照{rel}")
    toursg_bigger = all(g > t for g, t, (ds, _) in zip(gain_main, t4_mct, CELLS) if ds == "TourSG")
    stanford_smaller = all(g < t for g, t, (ds, _) in zip(gain_main, t4_mct, CELLS) if ds == "StanfordLU")
    print(f"  TourSG 兩格主表對照較大：{'是' if toursg_bigger else '否'}；StanfordLU 兩格主表對照較小：{'是' if stanford_smaller else '否'}")
    print()

    print("[對照組] Table 4 隱含的「不含 MCT」＝Ours − 去 MCT 差值，對主表 MPN+ALR（+E），逐欄比")
    all_differ = True
    implied = []
    for (ds, shot), o, t4 in zip(CELLS, t4_ours, t4_mct):
        x = o - t4
        implied.append(x)
        m = ave(shot, "+E", "MPN+ALR", ds)
        differ = abs(x - m) > 0.005
        all_differ = all_differ and differ
        print(f"  {ds:10s} {shot}：{o:.2f}−{t4:.2f}＝{x:.2f}，主表 MPN+ALR {m:.2f}，差 {x - m:+.2f}")
    print(f"  四格逐欄都不同：{'是' if all_differ else '否'}")
    mains = {round(ave(shot, "+E", "MPN+ALR", ds), 2) for ds, shot in CELLS}
    coincide = [f"{ds} {shot} 的 {x:.2f}" for (ds, shot), x in zip(CELLS, implied) if round(x, 2) in mains]
    if coincide:
        print(f"  注意：{'、'.join(coincide)} 恰好等於主表另一格的 MPN+ALR；只做集合比對會誤判成一致")
    print()

    print("[BERT] 同法算 BERT（+B）主表的 MCT 增益")
    gain_b = []
    for ds, shot in CELLS:
        o, m = ave(shot, "+B", "Ours", ds), ave(shot, "+B", "MPN+ALR", ds)
        gain_b.append(o - m)
        print(f"  {ds:10s} {shot}：{o:.2f}−{m:.2f}＝{o - m:.2f}")
    bert_range = (round(min(gain_b), 2), round(max(gain_b), 2))
    bert_ok = bert_range == CLAIM_BERT_RANGE
    print(f"  範圍 {bert_range[0]:.2f} 到 {bert_range[1]:.2f}，章節寫 {CLAIM_BERT_RANGE[0]:.2f} 到 {CLAIM_BERT_RANGE[1]:.2f}：{'相符' if bert_ok else '不符'}")
    print(f"  Table 4 不是 BERT 版（Ours 列與主表 +B 不同）：{'是' if not same_b else '否'}；所以這組數字不能與 Table 4 直接比")
    print()

    checks = {
        "欄位校準": calib_ok,
        "Table 4 是 Electra": same,
        "TourSG 主表對照較大": toursg_bigger,
        "StanfordLU 主表對照較小": stanford_smaller,
        "兩個不含 MCT 逐欄不同": all_differ,
        "BERT 增益範圍": bert_ok,
        "Table 4 不是 BERT 版": not same_b,
    }
    claim = all(checks.values())
    gaps = [x - ave(shot, "+E", "MPN+ALR", ds) for (ds, shot), x in zip(CELLS, implied)]
    gains = "、".join(f"{ds} {shot} {g:.2f}（Table 4 {t:.2f}）" for (ds, shot), g, t in zip(CELLS, gain_main, t4_mct))
    summary = (
        f"主表對照的 MCT 增益 {gains}"
        f"；兩個「不含 MCT」差 {'／'.join(f'{d:+.2f}' for d in gaps)}"
        f"；BERT 主表增益 {bert_range[0]:.2f} 到 {bert_range[1]:.2f}，Table 4 {'不是' if not same_b else '是'} BERT 版"
    )
    if anchors_ok is False:
        verdict = "無法判定（輸入數字與原文錨點對不上）"
    elif claim:
        verdict = f"證實（{summary}）"
    else:
        verdict = f"推翻（不成立：{'、'.join(k for k, v in checks.items() if not v)}；算出 {summary}）"
    print(f"結論：{verdict}")
    return 0 if claim and anchors_ok is not False else 1


if __name__ == "__main__":
    sys.exit(main())
