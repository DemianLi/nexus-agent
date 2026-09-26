"""驗證：Future Turns 的 Ambig Acc 低於「一律判模糊」的多數類基準。

主張（章節 01-goal-intent.md 的「Future Turns 的 Ambig Acc 低於多數類」）：
  Ambig Acc 53.7／54.0／54.3（Llama2／Llama3／Gemma）低於多數類基準
  1,172 ÷ 1,960 ≈ 59.8%；前提是 Ambig Acc 的分母為整個測試集。
  依相同前提，直接回答比例為 p 時隨機決策的期望準確率是
  p × 788/1,960 + (1 − p) × 1,172/1,960，與論文的 Random 相差不到 1 點。

出處：[arXiv:2410.13788]，筆記 notes/2410.13788.json 的 limitations_observed 第 3 條。

輸入數字全部取自 .cache/text/2410.13788.txt：
  - §4（Evaluation）：AmbigQA test n=1960，Unambiguous 788 題、Ambiguous 1,172 題。
  - §5.1：Ambig Acc 的定義（clarify-vs-answer 預測對人工模糊標籤的準確率）與
    Random 基準的做法（固定 DA%，隨機抽 DA% 的題直接回答，其餘提問）。
  - Table 4（Llama2）與 Table 6（Llama3、Gemma）的 DA% 與 A Acc／Ambig Acc 欄。

檢查：
  第一步：1172/1960 是否高於三個 Ours 的 Ambig Acc。
  第二步（驗前提）：以 p × 788/1960 + (1 − p) × 1172/1960 代入各 DA%，
    與對應 Random 的 Ambig Acc 相差是否不到 1 點。
  補充（不影響判定）：
    - Random 本身是一次抽樣，用超幾何分布算出它的標準差，看差距是幾個標準差。
    - 換成其他分母（只算模糊題、只算未模糊題、balanced accuracy）時，
      Random 的期望值會是多少，用三列合併的卡方檢定看哪些能被這組數字排除，
      以及在各分母下「一律提問」的基準是多少、Ours 是否仍低於它。
    - 由 Ours 的 Ambig Acc 反推：直接回答的題中有多少是未模糊題，
      和隨機抽的期望比較（說明提問決策與模糊標籤的關聯有多弱）。

執行：python3 01-ambigqa-ambig-acc-majority.py（只用標準函式庫，無隨機數）。
"""

import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", ".cache", "text", "2410.13788.txt")

# --- 輸入（取自 .cache/text/2410.13788.txt） ---
# 保留原文字串（同時當錨點），數字由字串解析，避免抄錄與錨點各寫一份。
SIZE_RAW = [
    "We evaluate on AmbigQA test set (n=1960)",
    "Unambiguous questions (788 questions with one answer each)",
    "Ambiguous questions (1,172 questions averaging 3.7 answers each)",
]
N = int(re.search(r"n=(\d+)", SIZE_RAW[0]).group(1))
N_UNAMB = int(re.search(r"\((\d+) questions", SIZE_RAW[1]).group(1))
N_AMB = int(re.search(r"\(([\d,]+) questions", SIZE_RAW[2]).group(1).replace(",", ""))

# Table 4（Llama2）欄位：Method (DA%) | Ans F1 | DA Acc | A Acc
# Table 6（Llama3、Gemma）欄位：Method (DA%) | Ans F1 | Direct-Answer Acc | Ambig Acc
TABLE_RAW = {
    "Llama2": ("| ", "Random (44%) | 23.4 | 55.4 | 52.1 | Ours (44%) | 24.3 | 61.9 | 53.7 | Ours w/ ProCoT (35%) | 15.6 | 60.1 | 49.2 | Ours w/ PPDPP (46%) | 23.9 | 57.7 | 59.0"),
    "Llama3": ("| Llama3 | ", "Random (43%) | 24.5 | 55.6 | 51.1 | Ours (43%) | 25.1 | 59.2 | 54.0 | PPDPP (60%) | 22.2 | 45.3 | 53.4"),
    "Gemma": ("| Gemma | ", "Random (38%) | 23.6 | 60.0 | 52.1 | Ours (38%) | 24.6 | 64.1 | 54.3 | PPDPP (54%) | 21.7 | 50.8 | 56.7"),
}
ROW_RE = re.compile(r"([A-Za-z][^|()]*?) \((\d+)%\) \| [\d.]+ \| [\d.]+ \| ([\d.]+)")
# (模型, 方法, DA%, Ambig Acc)
ROWS = [
    (model, m.group(1), int(m.group(2)), float(m.group(3)))
    for model, (_, raw) in TABLE_RAW.items()
    for m in ROW_RE.finditer(raw)
]

ANCHORS = SIZE_RAW + [
    "Ambig Acc: the accuracy of a system’s clarify-vs-answer predictions on the human ambiguous-vs-unambiguous labels",
    "randomly sample DA% of predictions to directly answer",
] + [prefix + raw for prefix, raw in TABLE_RAW.values()]


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
        print(f"[錨點] {'找到' if hit else '缺少'}：{a[:90]}{'…' if len(a) > 90 else ''}")
    return ok


def random_expected_full(p):
    """分母為全集：直接回答比例 p，隨機抽題。答對 = 未模糊題被直接回答 + 模糊題被提問。"""
    return (p * N_UNAMB + (1 - p) * N_AMB) / N * 100


def random_sd_full(p):
    """k = round(p N) 題直接回答、隨機抽；其中未模糊題數 X ~ Hypergeometric(N, 788, k)。
    答對數 = X + (1172 − (k − X)) = 2X + 1172 − k，所以 SD(答對數) = 2 SD(X)。"""
    k = round(p * N)
    var_x = k * (N_UNAMB / N) * (N_AMB / N) * (N - k) / (N - 1)
    return 2 * math.sqrt(var_x) / N * 100


# 各種分母下，Ambig Acc = a + b·X，X = 直接回答中的未模糊題數，k = 直接回答題數
DENOMINATORS = {
    "全集": lambda k: ((N_AMB - k) / N, 2 / N),
    "只算模糊題": lambda k: ((N_AMB - k) / N_AMB, 1 / N_AMB),
    "只算未模糊題": lambda k: (0.0, 1 / N_UNAMB),
    "balanced acc": lambda k: (0.5 * (N_AMB - k) / N_AMB, 0.5 / N_UNAMB + 0.5 / N_AMB),
}


def metric_moments(name, p):
    k = round(p * N)
    mean_x = k * N_UNAMB / N
    sd_x = math.sqrt(k * (N_UNAMB / N) * (N_AMB / N) * (N - k) / (N - 1))
    a, b = DENOMINATORS[name](k)
    return (a + b * mean_x) * 100, abs(b) * sd_x * 100


def chi2_sf_3df(x):
    """自由度 3 的卡方分布右尾機率。"""
    return math.erfc(math.sqrt(x / 2)) + math.sqrt(2 * x / math.pi) * math.exp(-x / 2)


def main():
    anchors_ok = check_anchors()
    print()

    comp_ok = N_UNAMB + N_AMB == N
    print(f"[組成] {N_UNAMB} + {N_AMB} = {N_UNAMB + N_AMB}（應為 {N}）：{'符合' if comp_ok else '不符'}")
    majority = N_AMB / N * 100
    print(f"[基準] 一律判模糊（一律提問）= {N_AMB}/{N} = {majority:.2f}%")
    print()

    print("[第一步] 各方法的 Ambig Acc 與多數類基準比較")
    step1 = True
    for model, method, da, acc in ROWS:
        gap = acc - majority
        mark = "低於" if gap < 0 else "不低於"
        if method == "Ours":
            step1 = step1 and gap < 0
        print(f"  {model:6s} {method:15s} (DA {da:2d}%) Ambig Acc {acc:4.1f}　{gap:+.2f}　{mark}多數類")
    print(f"  三個 Ours 都低於 {majority:.2f}%：{'是' if step1 else '否'}")
    print()

    print("[第二步] 前提檢驗：分母為全集時，Random 的期望 Ambig Acc")
    print("  E(p) = p × 788/1960 + (1 − p) × 1172/1960；SD 由超幾何分布算")
    step2 = True
    randoms = [r for r in ROWS if r[1] == "Random"]
    for model, _, da, acc in randoms:
        p = da / 100
        e = random_expected_full(p)
        sd = random_sd_full(p)
        lo, hi = random_expected_full(p + 0.005), random_expected_full(p - 0.005)
        diff = acc - e
        ok = abs(diff) < 1.0
        step2 = step2 and ok
        print(
            f"  {model:6s} DA {da}%：E = {e:.2f}（DA% 四捨五入帶來的範圍 {lo:.2f}–{hi:.2f}），"
            f"SD = {sd:.2f}；報告 {acc:.1f}，差 {diff:+.2f}（{diff / sd:+.2f} SD）　"
            f"{'相差不到 1 點' if ok else '相差 1 點以上'}"
        )
    print(f"  三個 Random 都與「分母為全集」相容：{'是' if step2 else '否'}")
    print()

    print("[補充] 四種分母各自預測的 Random Ambig Acc（期望 ± SD），以及三列合併的卡方檢定")
    print("  每種指標都是 X（直接回答中的未模糊題數）的一次式 a + bX，所以 E 與 SD 都由超幾何分布直接算。")
    fits = {}
    for name in DENOMINATORS:
        chi2 = 0.0
        cells = []
        for model, _, da, acc in randoms:
            e, sd = metric_moments(name, da / 100)
            z = (acc - e) / sd
            chi2 += z * z
            cells.append(f"{model} E={e:.1f}±{sd:.2f}（差 {acc - e:+.1f}，{z:+.1f} SD）")
        p_val = chi2_sf_3df(chi2)
        fits[name] = p_val
        print(f"  {name:14s} " + "；".join(cells) + f"｜χ²(3) = {chi2:.2f}，p = {p_val:.3g}")
    best = max(fits, key=fits.get)
    print(f"  最吻合的分母：{best}（p = {fits[best]:.3g}）；p < 0.01 視為被這組數字排除：")
    for name, p_val in fits.items():
        print(f"    {name:14s} {'排除' if p_val < 0.01 else '無法排除'}")
    print("  假設 Random 是單次抽樣；若論文取多次平均，SD 會更小，檢定會更嚴。")
    print("  各分母下「一律提問」的基準，以及三個 Ours 是否低於它：")
    ours = [r for r in ROWS if r[1] == "Ours"]
    for name in DENOMINATORS:
        base, _ = metric_moments(name, 0.0)
        below = all(acc < base for _, _, _, acc in ours)
        print(f"    {name:14s} 一律提問 = {base:.2f}；Ours 全部低於它：{'是' if below else '否'}")
    print()

    print("[補充] 由 Ours 的 Ambig Acc 反推（分母為全集）：直接回答的題中有幾題是未模糊題")
    print("  答對 = 2x + 1172 − k，x = 直接回答中的未模糊題數，k = 直接回答題數")
    for model, method, da, acc in ROWS:
        if method != "Ours":
            continue
        k = round(da / 100 * N)
        correct = acc / 100 * N
        x = (correct - N_AMB + k) / 2
        expect_x = k * N_UNAMB / N
        print(
            f"  {model:6s} k = {k}：x ≈ {x:.0f}（占直接回答 {x / k * 100:.1f}%），"
            f"隨機抽的期望 {expect_x:.0f}（{N_UNAMB / N * 100:.1f}%）；"
            f"未模糊題被直接回答的比例 {x / N_UNAMB * 100:.1f}% vs 隨機 {da}%"
        )
    print()

    claim = comp_ok and step1 and step2
    if anchors_ok is False:
        verdict = "無法判定（輸入數字與原文錨點對不上）"
    elif claim:
        verdict = "證實（第二步只證明與前提相容，不是證明前提成立）"
    else:
        verdict = "推翻"
    print(f"結論：{verdict}")
    return 0 if claim and anchors_ok is not False else 1


if __name__ == "__main__":
    sys.exit(main())
