"""驗證：2310.10176 Table 5 的 ChatGPT GID 欄其實是 IND/OOD=3:1 的數字。

主張（章節 01-goal-intent.md 的「開放世界意圖」一條）：
  Table 5 表頭說所有 LLM 都在 IND/OOD=3:2 下比較，但 ChatGPT 的 GID 欄
  68.44／75.33／70.17 其實是 3:1 的數字（與 Table 2 的 3:1 GID-DC 相同）；
  照 3:2 比，「Claude 在 GID 較弱」站不太住。

出處：[arXiv:2310.10176]，筆記 notes/2310.10176.json 的 limitations_observed 第 5 條。

輸入數字全部取自 .cache/text/2310.10176.txt：
  - Table 5（Comparison of different LLMs）：四個模型的 OOD discovery ACC／NMI／ARI
    與 GID 的 IND ACC／OOD ACC／ALL ACC；表頭「All LLMs use DC and GID-DC methods under IND/OOD=3:2」。
  - Table 2（Performance comparison on GID）：五個方法在 3:1、3:2、1:1 下的
    IND F1／IND ACC／OOD F1／OOD ACC／ALL F1／ALL ACC（本程式只用 ACC）。
  - Table 1（OOD intent discovery）：ChatGPT(DC) 在 3:2 的 ACC／NMI／ARI。
  - §4.1：15 個 IND 類，OOD 類 5（3:1）、10（3:2）、15（1:1）；GID 每類抽 10 句測試。
  - §5.6 的結論句「Claude … is weaker on GID」。

檢查：
  0. 校準：Table 2 每一列的 ALL ACC 是否等於 w·IND ACC + (1−w)·OOD ACC，
     w 依比例取 0.75（3:1）、0.6（3:2）、0.5（1:1），容差 0.05。
     這一步確認恆等式與權重在這篇論文的表上真的成立，再拿去判 Table 5。
  1. Table 5 每一列分別用 w = 0.6 與 w = 0.75 預測 ALL ACC，看吻合哪一個。
     預期：ChatGPT 只吻合 0.75，其他三列吻合 0.6。
  2. ChatGPT 列的 GID 三欄是否與 Table 2 GID-DC 的 3:1 逐欄相同、與 3:2 不同；
     順帶確認它的 OOD discovery 三欄與 Table 1 的 3:2 DC 相同（表頭只錯在 GID）。
  3. 補充：三次執行合計的樣本數（IND 450；OOD 150 或 300）下，ACC 換回答對句數是否為整數。
  4. 補充：Claude 對 ChatGPT 的差距，論文實際比的（ChatGPT 用 3:1）與照 3:2 比的各是多少。

執行：python3 01-gid-table5-ratio.py（只用標準函式庫，無隨機數）。
"""

import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", ".cache", "text", "2310.10176.txt")
TOL = 0.05
WEIGHTS = {"3:1": 0.75, "3:2": 0.6, "1:1": 0.5}
RUNS = 3
N_IND_PER_RUN = 15 * 10  # 15 個 IND 類 × 每類 10 句
N_OOD_PER_RUN = {"3:1": 5 * 10, "3:2": 10 * 10, "1:1": 15 * 10}

# --- 輸入（取自 .cache/text/2310.10176.txt） ---
# 每列保留原文字串（同時當錨點），數字由字串解析，避免抄錄與錨點各寫一份。
# Table 2：每個比例依序是 IND F1, IND ACC, OOD F1, OOD ACC, ALL F1, ALL ACC
TABLE2_RAW = {
    "DeepAligned-GID": "95.36 | 94.50 | 97.00 | 97.00 | 95.77 | 95.12 | 94.49 | 92.67 | 85.99 | 86.00 | 91.09 | 90.00 | 94.16 | 91.50 | 76.38 | 77.33 | 85.27 | 84.42",
    "E2E": "96.13 | 95.50 | 97.00 | 97.00 | 96.35 | 95.88 | 95.21 | 93.33 | 78.69 | 80.5 | 88.602 | 88.2 | 94.22 | 92.17 | 71.92 | 74.00 | 83.07 | 83.08",
    "ChatGPT(GID-DC)": "67.41 | 68.44 | 70.26 | 75.33 | 67.96 | 70.17 | 62.15 | 64.67 | 57.53 | 61.33 | 60.30 | 63.33 | 63.06 | 66.44 | 59.72 | 62.00 | 61.39 | 64.22",
    "ChatGPT(GID-ZSD)": "64.47 | 65.11 | 61.50 | 70.00 | 63.73 | 66.33 | 55.14 | 58.22 | 46.83 | 50.33 | 51.81 | 55.07 | 53.94 | 57.78 | 52.20 | 57.57 | 53.07 | 57.67",
    "ChatGPT(GID-FSD)": "72.77 | 79.11 | 20.27 | 17.33 | 59.65 | 63.67 | 68.74 | 74.89 | 50.75 | 52.00 | 61.54 | 65.73 | 68.29 | 74.89 | 52.57 | 51.78 | 60.43 | 63.33",
}
# Table 5：OOD discovery ACC, NMI, ARI, GID IND ACC, OOD ACC, ALL ACC
TABLE5_RAW = {
    "text-davinci-002": "38.00 | 39.11 | 9.577 | 31.56 | 28.67 | 30.40",
    "text-davinci-003": "71.33 | 72.12 | 49.84 | 59.56 | 63.33 | 61.07",
    "Claude": "70.00 | 84.27 | 62.24 | 56.67 | 70.00 | 62.00",
    "ChatGPT": "78.00 | 78.20 | 55.32 | 68.44 | 75.33 | 70.17",
}
# Table 1：ChatGPT(DC)，依序 3:1 ACC/NMI/ARI、3:2 ACC/NMI/ARI、1:1 ACC/NMI/ARI
TABLE1_RAW = {"ChatGPT(DC)": "88.00 | 84.62 | 73.36 | 78.00 | 78.20 | 55.32 | 58.22 | 65.30 | 28.21"}


def parse(raw):
    return {name: [float(x) for x in row.split("|")] for name, row in raw.items()}


TABLE2 = parse(TABLE2_RAW)
TABLE5 = parse(TABLE5_RAW)
TABLE1_CHATGPT_DC = parse(TABLE1_RAW)["ChatGPT(DC)"]

ANCHORS = [
    "Table 5: Comparison of different LLMs. All LLMs use DC and GID-DC methods under IND/OOD=3:2.",
    "the OOD category quantity is 5 (IND/OOD=3:1), 10 (IND/OOD=3:2), and 15 (IND/OOD=1:1)",
    "For GID, we randomly sample 10 queries from the test set for testing",
    "Claude shows competitive performance with ChatGPT on OOD discovery, but is weaker on GID.",
] + [f"| {name} | {row}" for raw in (TABLE5_RAW, TABLE2_RAW, TABLE1_RAW) for name, row in raw.items()]


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
    for a in ANCHORS:
        hit = a in flat
        ok = ok and hit
        print(f"[錨點] {'找到' if hit else '缺少'}：{a[:100]}{'…' if len(a) > 100 else ''}")
    return ok


def acc_triplet(row, ratio):
    base = {"3:1": 0, "3:2": 6, "1:1": 12}[ratio]
    return row[base + 1], row[base + 3], row[base + 5]  # IND ACC, OOD ACC, ALL ACC


def main():
    anchors_ok = check_anchors()
    print()

    print(f"[校準] Table 2：ALL ACC 是否等於 w·IND + (1−w)·OOD（容差 {TOL}）")
    calib_ok = True
    for name, row in TABLE2.items():
        cells = []
        for ratio, w in WEIGHTS.items():
            ind, ood, all_ = acc_triplet(row, ratio)
            pred = w * ind + (1 - w) * ood
            hit = abs(pred - all_) <= TOL
            calib_ok = calib_ok and hit
            cells.append(f"{ratio} 預測 {pred:.3f} 報告 {all_:.2f}{'✓' if hit else '✗'}")
        print(f"  {name:17s} " + "｜".join(cells))
    print(f"  Table 2 十五格全部吻合各自的權重：{'是' if calib_ok else '否'}")
    print()

    print("[判讀] Table 5：GID 的 ALL ACC 吻合哪個權重")
    fits = {}
    for name, row in TABLE5.items():
        ind, ood, all_ = row[3], row[4], row[5]
        matched = []
        cells = []
        for ratio in ("3:2", "3:1"):
            w = WEIGHTS[ratio]
            pred = w * ind + (1 - w) * ood
            hit = abs(pred - all_) <= TOL
            if hit:
                matched.append(ratio)
            cells.append(f"w={w}（{ratio}）預測 {pred:.3f}，差 {all_ - pred:+.3f}{'✓' if hit else '✗'}")
        fits[name] = matched
        print(f"  {name:17s} ALL {all_:.2f}：" + "；".join(cells) + f" → 吻合 {matched or '無'}")
    fit_ok = fits["ChatGPT"] == ["3:1"] and all(fits[m] == ["3:2"] for m in TABLE5 if m != "ChatGPT")
    print(f"  ChatGPT 只吻合 3:1、其他三列只吻合 3:2：{'是' if fit_ok else '否'}")
    print()

    print("[比對] ChatGPT 列與 Table 2 GID-DC、Table 1 DC")
    chatgpt_gid = tuple(TABLE5["ChatGPT"][3:])
    dc = TABLE2["ChatGPT(GID-DC)"]
    same = {ratio: acc_triplet(dc, ratio) == chatgpt_gid for ratio in WEIGHTS}
    for ratio in WEIGHTS:
        print(f"  Table 2 GID-DC {ratio} 的 IND/OOD/ALL ACC = {acc_triplet(dc, ratio)}　與 Table 5 ChatGPT GID 相同：{'是' if same[ratio] else '否'}")
    ood_disc = tuple(TABLE5["ChatGPT"][:3])
    t1 = {"3:1": tuple(TABLE1_CHATGPT_DC[0:3]), "3:2": tuple(TABLE1_CHATGPT_DC[3:6]), "1:1": tuple(TABLE1_CHATGPT_DC[6:9])}
    for ratio, vals in t1.items():
        print(f"  Table 1 DC {ratio} 的 ACC/NMI/ARI = {vals}　與 Table 5 ChatGPT OOD discovery 相同：{'是' if vals == ood_disc else '否'}")
    match_ok = same["3:1"] and not same["3:2"] and t1["3:2"] == ood_disc
    print(f"  GID 欄只與 3:1 相同、OOD discovery 欄與 3:2 相同：{'是' if match_ok else '否'}")
    print()

    print(f"[補充] 三次執行合計的樣本數：IND {RUNS * N_IND_PER_RUN}；OOD 3:1 {RUNS * N_OOD_PER_RUN['3:1']}、3:2 {RUNS * N_OOD_PER_RUN['3:2']}")
    print("  ACC × 樣本數 → 答對句數；IND＋OOD 句數要等於 ALL 的句數")
    for name, row in TABLE5.items():
        ind, ood, all_ = row[3], row[4], row[5]
        n_ind = RUNS * N_IND_PER_RUN
        c_ind = ind * n_ind / 100
        cells = []
        for ratio in ("3:2", "3:1"):
            n_ood = RUNS * N_OOD_PER_RUN[ratio]
            c_ood = ood * n_ood / 100
            c_all = all_ * (n_ind + n_ood) / 100
            consistent = abs(round(c_ind) + round(c_ood) - c_all) < 0.5 and abs(c_all - round(c_all)) < 0.05
            cells.append(f"{ratio}：OOD {c_ood:.2f}、ALL {c_all:.2f}（IND＋OOD {round(c_ind) + round(c_ood)}）{'✓' if consistent else '✗'}")
        print(f"  {name:17s} IND {c_ind:.2f}；" + "；".join(cells))
    print()

    print("[補充] Claude − ChatGPT（GID，三個 ACC）")
    claude = TABLE5["Claude"][3:]
    paper = chatgpt_gid
    matched = acc_triplet(dc, "3:2")
    labels = ("IND ACC", "OOD ACC", "ALL ACC")
    print("  論文實際比的（ChatGPT 用 3:1）：" + "，".join(f"{l} {c - p:+.2f}" for l, c, p in zip(labels, claude, paper)))
    print("  照 3:2 比（ChatGPT 用 Table 2 的 3:2 GID-DC）：" + "，".join(f"{l} {c - p:+.2f}" for l, c, p in zip(labels, claude, matched)))
    sizes = (
        RUNS * N_IND_PER_RUN,
        RUNS * N_OOD_PER_RUN["3:2"],
        RUNS * (N_IND_PER_RUN + N_OOD_PER_RUN["3:2"]),
    )
    print("  照 3:2 比的差距換成句數與粗估標準誤（兩比例差，假設兩模型樣本獨立）：")
    for label, c, m, n in zip(labels, claude, matched, sizes):
        p_bar = (c + m) / 200
        se = math.sqrt(2 * p_bar * (1 - p_bar) / n) * 100
        diff = c - m
        print(f"    {label}：差 {diff:+.2f} 點 ≈ {diff / 100 * n:+.0f} 句（每模型 {n} 句），SE {se:.2f}，= {diff / se:+.2f} SE")
    print()

    claim = calib_ok and fit_ok and match_ok
    if anchors_ok is False:
        verdict = "無法判定（輸入數字與原文錨點對不上）"
    elif claim:
        verdict = "證實"
    else:
        verdict = "推翻"
    print(f"結論：{verdict}")
    d = [c - m for c, m in zip(claude, matched)]
    print(
        f"  Table 5 的 ChatGPT GID 欄是 3:1 的數字；照 3:2 比，Claude 的 ALL ACC 差 {d[2]:+.2f}、"
        f"OOD ACC 差 {d[1]:+.2f}、IND ACC 差 {d[0]:+.2f}。"
    )
    print("  「站不太住」屬判斷；數字面的前提（表頭與數字不一致、照 3:2 比差距大幅縮小）成立。")
    return 0 if verdict == "證實" else 1


if __name__ == "__main__":
    sys.exit(main())
