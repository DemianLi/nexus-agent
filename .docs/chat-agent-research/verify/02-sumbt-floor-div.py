#!/usr/bin/env python3
"""驗證：SUMBT 的 joint accuracy 算式在地板除法與真除法下的差異。

主張（章節 02-dialogue-state-tracking.md「評估程式本身會改變指標（SUMBT）」一段）：
  官方評估程式把 joint accuracy 寫成 sum(torch.sum(accuracy, 1) / slot_dim)，依賴舊版 PyTorch
  對整數張量做地板除法；PyTorch 1.7 起改成真除法後，同一行會變成每回合 slot 準確率的平均，
  恆大於等於 JGA，只有每一回合都全對或全錯時兩者才相等，所以換 torch 版本會讓分數靜默虛高。
出處：[arXiv:1907.07421] 精讀筆記 notes/1907.07421.json 的 limitations_observed 第 10 條
      （「評估程式碼有重現風險：joint accuracy 寫成 sum(torch.sum(accuracy, 1) / slot_dim)…」）。

輸入從哪來：
  - 那一行程式碼、accuracy 是整數張量、PyTorch 1.6 報錯／1.7 起改真除法，都只來自上述筆記的轉述；
    .cache/text/1907.07421.txt 是論文全文，不含評估程式碼。本機也沒有 torch，而且規則不允許下載。
    所以本程式只驗「算術」那一半：把逐回合答對 slot 數 k_t 分別做 ⌊k_t/S⌋ 與 k_t/S 後加總。
  - S 取 3、5、30、35：30 是 TRADE 的 pair 數（.cache/text/1905.08743.txt Table 1），
    35 是筆記寫的 SUMBT 7 領域 slot 數；3、5 只是小例子。回合數與 k_t 的分布是人造的。

只用標準函式庫；隨機數固定種子 20260926。執行：python3 02-sumbt-floor-div.py
"""

import random

SEED = 20260926
rng = random.Random(SEED)

print("=" * 72)
print("一、單回合列舉：k = 0..S 時 ⌊k/S⌋ 與 k/S 何時相等")
print("=" * 72)
for S in (3, 5, 30, 35):
    equal_ks = [k for k in range(S + 1) if (k // S) == k / S]
    print(f"S={S:>2}：⌊k/S⌋ = k/S 的 k 只有 {equal_ks}（預期 [0, {S}]）→ {equal_ks == [0, S]}")

print()
print("=" * 72)
print("二、隨機回合：floor_sum = Σ⌊k_t/S⌋，true_sum = Σ k_t/S")
print("=" * 72)
T = 2000
print(f"每組 T={T} 回合；k_t 的分布有三種：均勻 0..S、偏向全對（每個 slot 獨立答對機率 q）、只有 0 或 S")
print(f"{'S':>3} {'分布':<16} {'全對回合數':>10} {'floor_sum':>10} {'true_sum':>10} "
      f"{'floor=全對?':>11} {'true≥floor?':>11} {'相等?':>6} {'全為0或S?':>9}")
all_ok = True
for S in (3, 5, 30, 35):
    dists = {
        "均勻 0..S": lambda: rng.randint(0, S),
        "逐 slot q=0.97": lambda: sum(1 for _ in range(S) if rng.random() < 0.97),
        "只有 0 或 S": lambda: rng.choice((0, S)),
    }
    for name, draw in dists.items():
        ks = [draw() for _ in range(T)]
        floor_sum = sum(k // S for k in ks)
        true_sum = sum(k / S for k in ks)
        n_full = sum(1 for k in ks if k == S)
        only_extreme = all(k in (0, S) for k in ks)
        eq = abs(true_sum - floor_sum) < 1e-9
        c1 = floor_sum == n_full
        c2 = true_sum >= floor_sum - 1e-9
        c3 = eq == only_extreme  # 相等若且唯若全為 0 或 S
        all_ok &= c1 and c2 and c3
        print(f"{S:>3} {name:<16} {n_full:>10} {floor_sum:>10} {true_sum:>10.2f} "
              f"{str(c1):>11} {str(c2):>11} {str(eq):>6} {str(only_extreme):>9}")
print(f"\n→ 三個性質在所有組合都成立：{all_ok}")

print()
print("=" * 72)
print("三、虛高幅度的示意（人造分布，不是 SUMBT 的實際數字）")
print("=" * 72)
print("假設每個 slot 獨立、以機率 q 答對，除以 T 後：floor 版 = JGA，true 版 = 平均 slot 準確率")
for S in (30, 35):
    for q in (0.95, 0.97, 0.99):
        ks = [sum(1 for _ in range(S) if rng.random() < q) for _ in range(T)]
        jga = sum(k // S for k in ks) / T
        mean_acc = sum(k / S for k in ks) / T
        print(f"  S={S} q={q}：floor 版 {jga:.4f}，true 版 {mean_acc:.4f}，差 {mean_acc - jga:+.4f}")
print("→ 在 slot 數多、單一 slot 準確率高的設定下，兩個版本可以差到數十個百分點。")

print()
print("=" * 72)
print("結論")
print("=" * 72)
print("算術部分證實：Σ⌊k_t/S⌋ 恰等於全對回合數（即 JGA×T）；Σk_t/S 恆 ≥ 它；")
print("  兩者相等若且唯若每回合都是全對或全錯。")
print("無法判定的部分：那一行程式碼是否如筆記所寫、accuracy 是否為整數張量、")
print("  PyTorch 1.6 報錯／1.7 起改真除法的版本行為——快取裡沒有程式碼，本機沒有 torch，")
print("  標準函式庫程式驗不到。")
