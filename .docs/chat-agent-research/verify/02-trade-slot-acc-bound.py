#!/usr/bin/env python3
"""驗證：TRADE Table 2 有三格違反 JGA ≥ 1 − J×(1−SA) 這個下界。

主張（章節 02-dialogue-state-tracking.md「slot accuracy 幾乎沒有鑑別力，而且 TRADE Table 2 有三格
與它的定義矛盾」一段）：
  若 slot accuracy（SA）每輪都比全部 J 個 (domain, slot) pair（含 none），每輪平均錯誤數是
  J×(1−SA)；由 Markov 不等式，至少錯一個 pair 的輪次比例 ≤ J×(1−SA)，所以 JGA ≥ 1 − J×(1−SA)。
  Table 2 中恰好三格違反：五領域 GCE、restaurant 單領域的 GLAD 與 GCE；其餘七格不違反。
  這是撰寫章節時的推論，用來挑戰精讀筆記「slot accuracy 被 none 墊高」的解讀。
出處：[arXiv:1905.08743] 精讀筆記 notes/1905.08743.json 的 limitations_observed 第 2 條
      （「GCE 的 slot 98.42 配上 joint 只有 36.27，說明這個指標被大量 none 的 pair 墊高」）。

輸入從哪來（全部取自 .cache/text/1905.08743.txt）：
  - 約第 297–397 行：Table 1，五個領域的 slot 清單，合計 30 個 (domain, slot) pair。
  - 約第 418–421 行：JGA 與 slot accuracy 的定義（slot accuracy 逐個比對 (domain, slot, value) 三元組）。
  - 約第 460–503 行：Table 2，五個模型在 MultiWOZ 五領域與 restaurant 單領域的 Joint／Slot。
前提：restaurant 單領域的 J=7 是假設（取 Table 1 的 restaurant slot 數）；論文沒寫 restaurant-only
      評估比幾個 slot。本程式另外印出每格的臨界值 J* = (1−JGA)/(1−SA)：J 大於 J* 時就不違反。

只用標準函式庫；沒有隨機數。執行：python3 02-trade-slot-acc-bound.py
"""

import math

# Table 1（.cache/text/1905.08743.txt 約第 297–396 行）
TABLE1_SLOTS = {
    "hotel": ["price", "type", "parking", "stay", "day", "people", "area", "stars", "internet", "name"],
    "train": ["destination", "departure", "day", "arrive by", "leave at", "people"],
    "attraction": ["area", "name", "type"],
    "restaurant": ["food", "price", "area", "name", "time", "day", "people"],
    "taxi": ["destination", "departure", "arrive by", "leave by"],
}

# Table 2（.cache/text/1905.08743.txt 約第 460–503 行）：(Joint, Slot)，單位 %
TABLE2 = {
    "MultiWOZ 五領域": {
        "MDBT": (15.57, 89.53),
        "GLAD": (35.57, 95.44),
        "GCE": (36.27, 98.42),
        "SpanPtr": (30.28, 93.85),
        "TRADE": (48.62, 96.92),
    },
    "restaurant 單領域": {
        "MDBT": (17.98, 54.99),
        "GLAD": (53.23, 96.54),
        "GCE": (60.93, 95.85),
        "SpanPtr": (49.12, 87.89),
        "TRADE": (65.35, 93.28),
    },
}

J_TOTAL = sum(len(v) for v in TABLE1_SLOTS.values())
J_REST = len(TABLE1_SLOTS["restaurant"])
print(f"Table 1 slot 數：" + "、".join(f"{d} {len(v)}" for d, v in TABLE1_SLOTS.items())
      + f"；合計 J = {J_TOTAL}（論文 Table 1 標題寫 30）")
assert J_TOTAL == 30 and J_REST == 7

J_OF = {"MultiWOZ 五領域": J_TOTAL, "restaurant 單領域": J_REST}

print()
print("下界 JGA ≥ 1 − J×(1−SA)；J* = (1−JGA)/(1−SA) 是讓這格不違反所需的最小 J")
print(f"{'設定':<12} {'模型':<8} {'J':>3} {'JGA':>7} {'SA':>7} {'下界':>8} {'違反?':>5} {'J*':>7}")
violations = []
for setting, rows in TABLE2.items():
    J = J_OF[setting]
    for model, (jga, sa) in rows.items():
        jga_f, sa_f = jga / 100, sa / 100
        bound = 1 - J * (1 - sa_f)
        viol = bound > jga_f
        jstar = (1 - jga_f) / (1 - sa_f)
        if viol:
            violations.append((setting, model, J, jga, sa, bound, jstar))
        print(f"{setting:<10} {model:<8} {J:>3} {jga_f:>7.4f} {sa_f:>7.4f} {bound:>8.4f} "
              f"{'是' if viol else '否':>5} {jstar:>7.2f}")

print()
print(f"違反的格數：{len(violations)}（預期 3）")
for setting, model, J, jga, sa, bound, jstar in violations:
    print(f"  {setting} {model}：下界 {bound:.4f} > 報告的 JGA {jga / 100:.4f}；要 J ≥ {jstar:.2f} 才不違反")

expected = {("MultiWOZ 五領域", "GCE"), ("restaurant 單領域", "GLAD"), ("restaurant 單領域", "GCE")}
got = {(s, m) for s, m, *_ in violations}
print(f"違反的格子恰好是預期那三格：{got == expected}")

print()
print("敏感度：")
for setting, model, J, jga, sa, bound, jstar in violations:
    if setting == "MultiWOZ 五領域":
        print(f"  {setting} {model}：J* = {jstar:.2f} > 30（Table 1 的 pair 總數），"
              f"不論 J 取 1–30 的哪個值都違反 → 不依賴 J 的假設。")
    else:
        print(f"  {setting} {model}：J* = {jstar:.2f}；J=7 時違反，但若 restaurant-only 評估仍比"
              f" 30 個 pair（或任何 J ≥ {math.ceil(jstar)}），就不違反 → 依賴 J=7 的假設。")

print()
print("旁證（推論，不是證明）：若 restaurant-only 評估比的是 30 個 pair，")
jga, sa = TABLE2["restaurant 單領域"]["MDBT"]
print(f"  MDBT 的 SA {sa} 等於每輪平均錯 {30 * (1 - sa / 100):.2f} 個 pair；若比 7 個，是 {7 * (1 - sa / 100):.2f} 個。")
print("  前者代表在 restaurant 對話裡大量誤報其他領域的值，較不自然，傾向支撐 J 較小，但論文沒寫。")

print()
print("補充：Markov 不等式對「每個錯的 pair 至少記一次錯」的任何計分都成立；")
print("  若某種實作把一個錯值記成兩次錯（漏掉真值＋多出錯值），每輪錯誤數只會更大，下界仍成立。")

print()
print("=" * 72)
print("結論")
print("=" * 72)
print("五領域 GCE（36.27／98.42）：證實違反，且與 J 的假設無關（J* 約 40.3 > 30）。")
print("restaurant 單領域 GLAD、GCE：在 J=7 下證實違反；J* 分別約 13.5 與 9.4，論文沒寫 J，")
print("  所以這兩格的違反是條件式的。其餘七格在所給 J 下都不違反。")
print("「SA 只比非 none 的三元組」或「各列不是同一套程式算的」這個二選一，程式分不出來；")
print("  較一般的說法是：SA 的比對集合比 JGA 要求全對的集合小，或兩欄不是在同一組輪次、同一套程式上算的。")
