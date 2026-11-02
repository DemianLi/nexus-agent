#!/usr/bin/env python3
"""驗證：SOM-DST Table 5 的操作次數換算成回合數與占比，以及 Table 4 的錯誤傳遞占比。

主張（章節 02-dialogue-state-tracking.md〈2019 年 11 月：上一輪狀態當顯式記憶〉〈JGA 量的到底是什麼〉
〈本子領域的跨輪維護〉與〈程式驗證〉）：
  (a) Table 5 每個 split 的四種操作次數加總都能被 30 整除，也就是每回合恰好對 30 個 slot 各記一次操作；
      換算的回合數是 train 54,984、valid 7,371、test 7,368。
  (b) delete 只占全部 slot 操作的極小一部分：train 1,224 ÷ 1,649,520 ≈ 0.074%，test 109 ÷ 221,040 ≈ 0.049%。
  (c) 含 delete 的回合最多占 test 的 109 ÷ 7,368 ≈ 1.48%（每個 delete 都落在不同回合時才達到這個上限）。
      所以在「餵 gold 上一輪狀態」的設定下，模型就算一個 delete 都不預測，JGA 因此少掉的也不超過 1.48 個百分點；
      模型吃自己預測的狀態時，漏刪的舊值可能被 carryover 帶到後面的回合，這個上限不成立（程式只印出提醒，不量）。
  (d) Table 4：改餵 gold 的上一輪狀態，錯誤率從 100 − 53.01 = 46.99 降到 100 − 81.00 = 19.00，
      少了 (46.99 − 19.00) ÷ 46.99 ≈ 59.6%；等價於論文的「錯誤放大 2.47 倍」（1 − 1/2.47）。
出處：[arXiv:1911.03906] 的 Table 4、Table 5；notes/1911.03906.json 的 method.ground_truth_operation_derivation
  （操作標籤由相鄰兩回合的金標狀態導出，依官方程式碼；論文本身沒寫）與 limitations_observed（delete 標籤可能多半是
  標註前後不一致，而不是使用者真的撤回）。

輸入從哪來：
  - .cache/text/1911.03906.txt 的 Table 5 區塊（「Table 5:」到「Error propagation」之間）：四種操作在 train／valid／test
    的次數與 test F1。程式從文字抽出，不手抄；抽出後與筆記 key_results 裡的 train 次數交叉核對。
  - 同一份全文的 Table 4 區塊：53.01、81.00，以及正文的 2.47 算式。
  - 全文 §4.1：「the number of slots $J$ is 30」。

只用標準函式庫；沒有隨機數。執行（從研究根目錄）：python3 verify/02-somdst-op-share.py
"""

import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
txt = open(os.path.join(ROOT, ".cache", "text", "1911.03906.txt"), encoding="utf-8").read()
note = json.load(open(os.path.join(ROOT, "notes", "1911.03906.json"), encoding="utf-8"))

assert "the number of slots $J$ is 30" in txt, "§4.1 的 J=30"
J = 30

# ---- Table 5：操作次數 ----
start = txt.index("Table 5: Statistics of the number of state operations")
end = txt.index("Error propagation that comes from", start)
block = txt[start:end]
ops = {}
for name in ("carryover", "update", "dontcare", "delete"):
    m = re.search(r"\|\s*" + name + r"\s*\n\|\s*([\d,]+)\s*\n\|\s*([\d,]+)\s*\n\|\s*([\d,]+)\s*\n\|\s*([\d.]+)", block)
    assert m, f"Table 5 抽不到 {name}"
    tr, va, te = (int(x.replace(",", "")) for x in m.groups()[:3])
    ops[name] = {"train": tr, "valid": va, "test": te, "f1": float(m.group(4))}

# 與筆記 key_results 交叉核對 train 次數與 F1
kr = next(k for k in note["key_results"] if "類別嚴重不平衡" in k["claim"])["numbers"]
for name in ops:
    m = re.search(name + r" ([\d,]+)", kr)
    assert m and int(m.group(1).replace(",", "")) == ops[name]["train"], f"筆記與全文的 {name} 次數不一致"
    m = re.search(name + r" ([\d.]+)（?", kr.split("測試 F1")[1])
    assert m and float(m.group(1)) == ops[name]["f1"], f"筆記與全文的 {name} F1 不一致"

print("=" * 72)
print("一、Table 5（快取全文）")
print("=" * 72)
print(f"{'操作':<10}{'train':>12}{'valid':>10}{'test':>10}{'test F1':>10}")
for name, v in ops.items():
    print(f"{name:<10}{v['train']:>12,}{v['valid']:>10,}{v['test']:>10,}{v['f1']:>10.2f}")
print("（與筆記 key_results 的 train 次數、test F1 逐項相同）")

print()
print("=" * 72)
print("二、(a) 每個 split 的操作總數 ÷ 30 是否為整數")
print("=" * 72)
turns = {}
all_int = True
for split in ("train", "valid", "test"):
    tot = sum(v[split] for v in ops.values())
    q, r = divmod(tot, J)
    all_int &= (r == 0)
    turns[split] = q
    print(f"{split:<6} 總數 {tot:>10,}  ÷ {J} = {tot / J:,.4f}  餘數 {r}  → 回合數 {q:,}")
print(f"三個 split 都整除：{all_int}（每回合恰好對 {J} 個 slot 各記一次操作）")

print()
print("=" * 72)
print("三、(b) 各操作占全部 slot 操作的比例")
print("=" * 72)
for split in ("train", "test"):
    tot = sum(v[split] for v in ops.values())
    cells = "、".join(f"{n} {ops[n][split]:,}/{tot:,} = {100 * ops[n][split] / tot:.3f}%" for n in ops)
    print(f"{split}: {cells}")

print()
print("=" * 72)
print("四、(c) 含某種操作的回合最多占多少（每個操作都落在不同回合時的上限）")
print("=" * 72)
for split in ("train", "test"):
    for n in ("delete", "dontcare"):
        print(f"{split} {n}: {ops[n][split]:,} ÷ {turns[split]:,} = {100 * ops[n][split] / turns[split]:.2f}%")
del_bound = 100 * ops["delete"]["test"] / turns["test"]
print(f"→ 餵 gold 上一輪狀態時，一個 delete 都不預測，test JGA 最多少 {del_bound:.2f} 個百分點。")
print("  模型吃自己預測的狀態時，漏刪的舊值可能被 carryover 帶到後面的回合，這個上限不成立；錯值實際留幾個回合，論文沒有量。")

print()
print("=" * 72)
print("五、(d) Table 4：錯誤傳遞占錯誤的比例")
print("=" * 72)
pred, gold = 53.01, 81.00
t4 = txt[txt.index("Table 4:"):txt.index("Table 5:")]
assert "| 53.01" in t4 and "| 81.00" in t4, "Table 4 的兩個 JGA"
assert r"\frac{100-53.01}{100-81.00}" in txt and "2.47" in txt, "正文的 2.47 算式"
e_pred, e_gold = 100 - pred, 100 - gold
share = (e_pred - e_gold) / e_pred
print(f"錯誤率：預測 B_t-1 {e_pred:.2f}、gold B_t-1 {e_gold:.2f}；放大倍數 {e_pred / e_gold:.3f}（論文寫 2.47）")
print(f"改餵 gold 後少掉的錯誤占比：({e_pred:.2f} − {e_gold:.2f}) ÷ {e_pred:.2f} = {100 * share:.1f}%"
      f"（＝ 1 − 1/{e_pred / e_gold:.3f} = {100 * (1 - e_gold / e_pred):.1f}%）")
assert abs(e_pred / e_gold - 2.47) < 0.005

print()
ok = all_int and turns["test"] == 7368 and abs(del_bound - 1.48) < 0.005 and abs(100 * share - 59.6) < 0.05
print("結論：" + ("證實。" if ok else "不符，見上。") +
      f"Table 5 三個 split 的操作總數{'都' if all_int else '沒有都'}被 {J} 整除（test {turns['test']:,} 回合）；delete 占 test slot 操作 "
      f"{100 * ops['delete']['test'] / sum(v['test'] for v in ops.values()):.3f}%，含 delete 的回合最多 {del_bound:.2f}%"
      f"（只在餵 gold 上一輪狀態時是 JGA 損失的上限）；改餵 gold 上一輪狀態少掉 {100 * share:.1f}% 的錯誤。")
