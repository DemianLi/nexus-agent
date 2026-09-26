"""驗證：IN3 的模糊判斷準確率低於「一律判模糊」的多數類基準。

主張（章節 01-goal-intent.md 的「IN3 的模糊判斷準確率低於多數類」）：
  IN3 測試集 108 題中 95 題模糊，一律判模糊就有 95/108 = 87.96%，
  高於 Mistral-Interact 的 85.19%（92/108）與 GPT-4 的 82.41%（89/108），
  所以這張表無法說明模型學會「何時不該問」。

出處：[arXiv:2402.09205]，筆記 notes/2402.09205.json 的 limitations_observed 第 1 條。

輸入數字全部取自 .cache/text/2402.09205.txt：
  - Table 1（IN3 統計）：Test 欄 Task 108、Vague 95、Clear 13。
  - Table 3：Vagueness Judgement Accuracy 列，Mistral-7B 49.07、LLaMA-2-7B 79.63、
    GPT-4 82.41、Mistral-Interact 85.19。
  - 附錄 E.3 式 (1)：J_acc = (1/|T|) * sum_T (j == j_truth)，分母是全部測試題 |T|。

檢查：
  1. 95 + 13 = 108。
  2. 各模型準確率 × 108 是否落在整數上（確認分母真的是 108）。
  3. 多數類基準 95/108 是否高於表中每個模型。
  4. 補充：答對 k 題時，「清楚題放行幾題」的可行範圍。範圍涵蓋 0 到 13，
     就代表這個數字分不出模型有沒有學會「何時不該問」。

執行：python3 01-in3-vagueness-majority.py（只用標準函式庫，無隨機數）。
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", ".cache", "text", "2402.09205.txt")

# --- 輸入（取自 .cache/text/2402.09205.txt） ---
# 保留原文字串（同時當錨點），數字由字串解析，避免抄錄與錨點各寫一份。
TABLE1_TEST_RAW = "108 | 95 | 13"  # Table 1, Test 欄：Task, - Vague, - Clear
TABLE3_HEADER_RAW = "Mistral-7B | LLaMA-2-7B | GPT-4 | Mistral-Interact"
TABLE3_ACC_RAW = "49.07 | 79.63 | 82.41 | 85.19"  # ↑Vagueness Judgement Accuracy (%)

N_TEST, N_VAGUE, N_CLEAR = (int(x) for x in TABLE1_TEST_RAW.split("|"))
ACC = dict(
    zip(
        (x.strip() for x in TABLE3_HEADER_RAW.split("|")),
        (float(x) for x in TABLE3_ACC_RAW.split("|")),
    )
)

ANCHORS = [
    "| Split | Training | Test",
    "| - Vague | - Clear",
    "| " + TABLE1_TEST_RAW,
    "| Metrics | " + TABLE3_HEADER_RAW,
    "| ↑Vagueness Judgement Accuracy (%) | " + TABLE3_ACC_RAW,
    r"$J_{acc}\ =\ \frac{1}{|T|}\sum_{T}(j==j_{truth})$",
]


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
        print(f"[錨點] {'找到' if hit else '缺少'}：{a}")
    return ok


def main():
    anchors_ok = check_anchors()
    print()

    total_ok = N_VAGUE + N_CLEAR == N_TEST
    print(f"[組成] {N_VAGUE} + {N_CLEAR} = {N_VAGUE + N_CLEAR}（應為 {N_TEST}）：{'符合' if total_ok else '不符'}")

    majority = N_VAGUE / N_TEST * 100
    always_clear = N_CLEAR / N_TEST * 100
    print(f"[基準] 一律判模糊 = {N_VAGUE}/{N_TEST} = {majority:.2f}%")
    print(f"[基準] 一律判清楚 = {N_CLEAR}/{N_TEST} = {always_clear:.2f}%")
    print()

    print("[整數檢查] 準確率 × 108 → 答對題數（round(k/108*100, 2) 要等於表中數字）")
    counts = {}
    integer_ok = True
    for model, acc in ACC.items():
        raw = acc * N_TEST / 100
        k = round(raw)
        back = round(k / N_TEST * 100, 2)
        hit = abs(back - acc) < 1e-9
        integer_ok = integer_ok and hit
        counts[model] = k
        print(f"  {model:17s} {acc:6.2f}% × 108 = {raw:7.3f} → k = {k:3d}；{k}/108 = {back:.2f}%　{'吻合' if hit else '不吻合'}")
    print()

    print("[比較] 多數類基準 − 模型準確率")
    below_all = True
    for model, acc in ACC.items():
        gap = majority - acc
        below_all = below_all and gap > 0
        print(f"  {model:17s} {majority:.2f} − {acc:.2f} = {gap:+.2f}")
    print(f"  所有模型都低於多數類基準：{'是' if below_all else '否'}")
    print()

    print("[可行範圍] 答對 k 題時，清楚題放行（判為清楚）幾題、模糊題抓到幾題")
    print("  答對 = 清楚題判清楚（TN）＋ 模糊題判模糊（TP），TN ∈ [max(0, k−95), min(13, k)]")
    for model, k in counts.items():
        tn_lo, tn_hi = max(0, k - N_VAGUE), min(N_CLEAR, k)
        tp_hi, tp_lo = k - tn_lo, k - tn_hi
        print(
            f"  {model:17s} k={k:3d}：清楚題放行 {tn_lo}–{tn_hi} 題"
            f"（{tn_lo / N_CLEAR * 100:.0f}%–{tn_hi / N_CLEAR * 100:.0f}%），"
            f"模糊題抓到 {tp_lo}–{tp_hi} 題"
        )
    mi_lo = max(0, counts["Mistral-Interact"] - N_VAGUE)
    mi_hi = min(N_CLEAR, counts["Mistral-Interact"])
    full_range = mi_lo == 0 and mi_hi == N_CLEAR
    print(f"  Mistral-Interact 的清楚題放行數可以是 0 到 13 任一個：{'是' if full_range else '否'}")
    print()

    claim = total_ok and integer_ok and below_all and full_range
    if anchors_ok is False:
        verdict = "無法判定（輸入數字與原文錨點對不上）"
    elif claim:
        verdict = "證實"
    else:
        verdict = "推翻"
    print(f"結論：{verdict}")
    print(
        f"  多數類 {majority:.2f}% 高於最佳模型 Mistral-Interact {ACC['Mistral-Interact']:.2f}%"
        f"（{majority - ACC['Mistral-Interact']:.2f} 點，約 {N_VAGUE - counts['Mistral-Interact']} 題）；"
        "答對 92 題與清楚題全放行或全不放行都相容。"
    )
    return 0 if verdict == "證實" else 1


if __name__ == "__main__":
    sys.exit(main())
