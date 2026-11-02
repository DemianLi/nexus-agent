#!/usr/bin/env python3
"""驗證：Mem0／Hindsight 表上標為 Open Domain 的那一欄，是不是 LoCoMo 論文定義的 open-domain 題。

主張（章節 02-dialogue-state-tracking.md〈記憶系統的評估〉與〈程式驗證〉4d）：
  原稿把「LoCoMo 總分由 Open Domain 主導」判為無法判定，理由是要拿 LoCoMo 資料集的 category 欄位
  才能對照欄名。缺口 C20／G7 指出：T7 已精讀的 LoCoMo 筆記有全集五類題數，拿來和 02-locomo-weights.py
  反推的四欄題數比，就能大幅縮小範圍。本程式做兩件確定性的檢查：
  (1) 題數上限：公開版只保留 50 段中的 10 段。若公開版的題目是論文 7,512 題的子集、類別標籤沒被改過，
      那麼任何一欄的題數都不能超過全集同一類的題數。照欄名對應時，逐欄檢查這條上限。
  (2) 比例配對：列舉 4! = 24 種「欄名 → LoCoMo 原始類別」的對應，找出滿足上限、而且比例最接近
      全集（排除 adversarial）的對應。

輸入從哪來：
  - notes/2402.17753.json（T7 計入的 LoCoMo 筆記）method 的「評估任務（§4）」QA 一項：
    single-hop 2,705、multi-hop 1,104、temporal 1,547、open-domain 285、adversarial 1,871，共 7,512 題。
    程式直接從筆記文字抽這幾個數，不手抄。
  - notes/2402.17753.json reproducibility.data：公開的 locomo10.json 只有 10 段對話（保留最長的 10 段）。
    這是精讀時依 LoCoMo 的 GitHub README 查到的，不是論文的內容。
  - 282／96／841／321（Single-Hop／Multi-Hop／Open Domain／Temporal）：Mem0 與 Hindsight 表的加權題數，
    由 02-locomo-weights.py 以加權重現、最小平方與整數題數三種方法確立，兩份全文都沒寫明。
  - .cache/text/2504.19413.txt 第 194–195 行：Mem0 排除了 adversarial 類（用來確認比較的分母要排除它）。

限制：公開版是「最長的 10 段」，不是隨機抽樣，所以 (2) 的比例距離只是描述，不是統計檢定。
(1) 的結論依賴一個快取無法驗證的前提：公開版的題目沒有被重新出題或重新標類別。

只用標準函式庫；沒有隨機數。執行（從研究根目錄）：python3 verify/02-locomo-category-map.py
"""

import itertools
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
note = json.load(open(os.path.join(ROOT, "notes", "2402.17753.json"), encoding="utf-8"))
qa_text = note["method"]["評估任務（§4）"]["QA"]
repro = note["reproducibility"]["data"]
mem0_txt = open(os.path.join(ROOT, ".cache", "text", "2504.19413.txt"), encoding="utf-8").read()


def grab(label):
    m = re.search(re.escape(label) + r"\s*([\d,]+)", qa_text)
    assert m, label
    return int(m.group(1).replace(",", ""))


FULL = {
    "single-hop": grab("single-hop"),
    "multi-hop": grab("multi-hop"),
    "temporal": grab("temporal"),
    "open-domain": grab("open-domain"),
    "adversarial": grab("adversarial"),
}
total_m = re.search(r"([\d,]+)\s*題", qa_text)
TOTAL = int(total_m.group(1).replace(",", ""))
assert sum(FULL.values()) == TOTAL, (FULL, TOTAL)
assert "10 段" in repro and "最長的 10 段" in repro
assert "adversarial" in mem0_txt and "excluded from our evaluation" in mem0_txt

ORIG = ("single-hop", "multi-hop", "temporal", "open-domain")
N_FULL = sum(FULL[c] for c in ORIG)

COLS = ("Single-Hop", "Multi-Hop", "Open Domain", "Temporal")
SUB = dict(zip(COLS, (282, 96, 841, 321)))
N_SUB = sum(SUB.values())
NAMED = {"Single-Hop": "single-hop", "Multi-Hop": "multi-hop", "Open Domain": "open-domain", "Temporal": "temporal"}

print("=" * 76)
print("一、兩組題數")
print("=" * 76)
print(f"LoCoMo 全集（筆記，50 段）：{FULL}，合計 {TOTAL}")
print(f"排除 adversarial 後 {N_FULL} 題：")
for c in ORIG:
    print(f"  {c:<12} {FULL[c]:>5}  {FULL[c] / N_FULL:6.1%}")
print(f"Mem0／Hindsight 的四欄（反推，公開版 10 段）合計 {N_SUB} 題：")
for c in COLS:
    print(f"  {c:<12} {SUB[c]:>5}  {SUB[c] / N_SUB:6.1%}")
print(f"公開版占全集非 adversarial 題的 {N_SUB}/{N_FULL} = {N_SUB / N_FULL:.1%}；占對話數 10/50 = 20.0%")

print()
print("=" * 76)
print("二、照欄名對應時的題數上限（子集題數不能超過全集同類題數）")
print("=" * 76)
named_ok = True
for c in COLS:
    o = NAMED[c]
    ok = SUB[c] <= FULL[o]
    named_ok &= ok
    print(f"  {c:<12} {SUB[c]:>5} ≤ 全集 {o:<12} {FULL[o]:>5} ？ {'成立' if ok else '不成立'}"
          f"（占全集同類 {SUB[c] / FULL[o]:.1%}）")
print(f"→ 照欄名對應是否可能：{named_ok}")

print()
print("=" * 76)
print("三、24 種「欄名 → 原始類別」對應：上限可行性與比例距離")
print("=" * 76)
rows = []
for perm in itertools.permutations(ORIG):
    mapping = dict(zip(COLS, perm))
    feasible = all(SUB[c] <= FULL[mapping[c]] for c in COLS)
    # 比例距離：Σ (p_sub − p_full)² / p_full（描述用，非檢定）
    dist = sum((SUB[c] / N_SUB - FULL[mapping[c]] / N_FULL) ** 2 / (FULL[mapping[c]] / N_FULL) for c in COLS)
    shares = [SUB[c] / FULL[mapping[c]] for c in COLS]
    rows.append((dist, feasible, mapping, min(shares), max(shares)))
rows.sort(key=lambda r: r[0])
n_feasible = sum(r[1] for r in rows)
print(f"滿足上限的對應：{n_feasible}／24")
print(f"{'名次':<4} {'可行':<4} {'距離':>7}  {'各欄占全集同類的比例（最小–最大）':<22} 對應")
for i, (dist, feas, mp, lo, hi) in enumerate(rows[:6], 1):
    desc = "，".join(f"{c}→{mp[c]}" for c in COLS)
    print(f"{i:<4} {'是' if feas else '否':<4} {dist:7.3f}  {lo:6.1%}–{hi:6.1%}            {desc}")
identity_rank = [i for i, r in enumerate(rows, 1) if all(r[2][c] == NAMED[c] for c in COLS)][0]
print(f"照欄名的對應排第 {identity_rank}／24，距離 {rows[identity_rank - 1][0]:.3f}")
od_targets = {}
for dist, feas, mp, lo, hi in rows:
    if feas:
        od_targets.setdefault(mp["Open Domain"], []).append(round(dist, 3))
print("可行對應裡，Open Domain 欄被對到哪一類（各對應的距離）：")
for o, ds in od_targets.items():
    print(f"  → {o:<12} {len(ds)} 種，距離 {ds}")
top1, top2 = rows[0][2], rows[1][2]
same_cols = [c for c in COLS if top1[c] == top2[c]]
diff_cols = [c for c in COLS if top1[c] != top2[c]]
swapped = (len(diff_cols) == 2 and top1[diff_cols[0]] == top2[diff_cols[1]]
           and top1[diff_cols[1]] == top2[diff_cols[0]])
print("前兩名相同的欄：" + ("、".join(f"{c}→{top1[c]}" for c in same_cols) or "無"))
print("前兩名不同的欄：" + ("；".join(f"{c}（第 1 名→{top1[c]}，第 2 名→{top2[c]}）" for c in diff_cols) or "無")
      + ("，這兩欄的歸屬在前兩名之間互換，比例配對分不清" if swapped else ""))

best = rows[0]
print()
print("最佳對應下，各欄占全集同類題數的比例：")
for c in COLS:
    o = best[2][c]
    print(f"  {c:<12} {SUB[c]:>4} ／ {o:<12} {FULL[o]:>5} = {SUB[c] / FULL[o]:.1%}")
print(f"  （公開版整體占 {N_SUB / N_FULL:.1%}；10 段最長對話分到的題數比例偏高是可預期的）")

# 依名次配對（大配大）是不是就是最佳對應
by_rank_sub = sorted(COLS, key=lambda c: SUB[c], reverse=True)
by_rank_full = sorted(ORIG, key=lambda o: FULL[o], reverse=True)
rank_map = dict(zip(by_rank_sub, by_rank_full))
print(f"依題數名次配對：{rank_map}；與最佳對應相同：{rank_map == best[2]}")

print()
print("=" * 76)
print("結論")
print("=" * 76)
od = best[2]["Open Domain"]
od_share = SUB["Open Domain"] / N_SUB
violations = [c for c in COLS if SUB[c] > FULL[NAMED[c]]]
if named_ok:
    print("照欄名對應不違反題數上限，這一步否定不了照欄名的解讀。")
else:
    for c in violations:
        print(f"照欄名解讀不可能成立：標為 {c} 的欄有 {SUB[c]} 題，但 LoCoMo 全集 50 段的 {NAMED[c]} 只有 "
              f"{FULL[NAMED[c]]} 題（前提：公開版題目是全集的子集、類別沒被改標）。")
print(f"比例配對最接近的對應是 {best[2]}，")
print(f"四欄各占全集同類的 {best[3]:.1%}–{best[4]:.1%}，接近整體的 {N_SUB / N_FULL:.1%}。")
od_robust = "Open Domain" in same_cols
print(f"標為 Open Domain 的欄占總分權重 {od_share:.1%}；最佳對應把它對到原始 {od}"
      + ("，前兩名在這一欄一致" if od_robust else "，但前兩名在這一欄不一致") + "。")
if od != "open-domain":
    print(f"所以那一欄很可能是原始的 {od}，「總分由 open-domain 題主導」不成立；這是強旁證不是證明，")
else:
    print("所以最佳對應與欄名一致，「總分由 open-domain 題主導」沒有被這一步推翻；")
print("前提與實際欄位對照仍要 LoCoMo 資料集的 category 欄位才能確認。")
verdict_named = "照欄名否定（在子集前提下）" if not named_ok else "照欄名的解讀沒有被題數上限否定"
print(f"結論：{verdict_named}，最可能的對應是 Open Domain 欄＝原始 {od}。")
