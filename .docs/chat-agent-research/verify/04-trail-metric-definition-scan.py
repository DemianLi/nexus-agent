#!/usr/bin/env python3
"""驗證：TRAIL 論文本文沒有定義 Location Accuracy 與 Joint Accuracy（只驗這一半）。

主張（章節 04-agent-trajectory.md「TRAIL 的定位指標只算 recall」一段）：
  TRAIL 的 Location Accuracy 與 Joint Accuracy 只量 recall、不罰誤報：分母是金標集合，
  把所有 span id 都列為預測，理論上可拿到 Location Accuracy 1.0；論文本文沒有定義這些指標。
出處：[arXiv:2505.08638] 精讀筆記 notes/2505.08638.json 的 limitations_observed 第 1 條。

本程式能驗的範圍：
  - 「只量 recall、全部列出可得 1.0」要讀官方 trail-benchmark repo 的 calculate_scores.py，
    本地沒有這支腳本，依規則也不下載，所以這一半無法判定，本程式不碰。
  - 「論文本文沒有定義」這一半可以掃全文：找出所有提到這些指標的地方，
    檢查附近有沒有定義句型。

輸入從哪來：
  - 被掃的檔：.cache/text/2505.08638.txt（arxiv-html 轉出的全文，含附錄）。
  - 正向對照一：同一份檔裡要找得到行內數學式（$...$），證明轉換沒有把數學式整批丟掉。
  - 正向對照二：用同一支掃描器、同一組定義句型，掃 .cache/text/2403.12881.txt 的 H_Score，
    那篇確實有定義（文字加式 (1)），掃描器必須抓得到；抓不到就代表掃描器太鈍，「找不到」不算數。

方法：
  1. 名稱樣式要涵蓋所有寫法：Loc. Acc.、Location Acc、Location Accuracy、Joint、joint accuracy、
     Localization、Cat. F1、Categ. F1、Category F1（第三個指標一併掃，方便對照筆記的「三個指標」）。
  2. 定義句型：defined as、we define、is defined、computed/calculated/measured as、
     we compute/calculate/measure、fraction、proportion、percentage of、ratio、divided、
     number of、行內數學式中的等號、跨行的式子編號 (1)(2)…。
  3. 每個名稱命中都印出行號、該行內容，以及前後各 2 行內有沒有定義句型；有的話把句型與那一行印出來，
     由人判讀（結果寫在 04-results.md）。

只用標準函式庫；沒有隨機數。執行：python3 04-trail-metric-definition-scan.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT_DIR = os.path.join(HERE, "..", ".cache", "text")
TRAIL = os.path.join(TEXT_DIR, "2505.08638.txt")
FLAN = os.path.join(TEXT_DIR, "2403.12881.txt")

NAME_TRAIL = re.compile(
    r"loc(?:\.|ation)?\s*acc(?:\.|uracy)?|joint|locali[sz]ation|cat(?:eg)?(?:\.|ory)?\s*f1",
    re.IGNORECASE,
)
NAME_FLAN = re.compile(r"H\s*\$?\s*\{?\}?_\{\\text\{Score\}\}|H_?Score", re.IGNORECASE)
DEF_CUES = [
    ("defined as", re.compile(r"\bdefined as\b", re.I)),
    ("we define", re.compile(r"\bwe (?:further )?define\b", re.I)),
    ("is defined", re.compile(r"\bis defined\b", re.I)),
    ("X as（computed/calculated/measured）", re.compile(r"\b(?:computed|calculated|measured) as\b", re.I)),
    ("we compute/calculate/measure", re.compile(r"\bwe (?:compute|calculate|measure)\b", re.I)),
    ("fraction", re.compile(r"\bfraction\b", re.I)),
    ("proportion", re.compile(r"\bproportion\b", re.I)),
    ("percentage of", re.compile(r"\bpercentage of\b", re.I)),
    ("ratio", re.compile(r"\bratio\b", re.I)),
    ("divided", re.compile(r"\bdivided\b", re.I)),
    ("number of", re.compile(r"\bnumber of\b", re.I)),
    ("數學式內的等號", re.compile(r"\$[^$]*=[^$]*\$")),
    ("式子編號", re.compile(r"^\|?\s*\(\d+\)\s*$")),
]
WIN = 2


def load(path):
    with open(path, encoding="utf-8") as f:
        return f.read().split("\n")


def scan(lines, name_rx, label):
    hits = [i for i, s in enumerate(lines) if name_rx.search(s)]
    print(f"\n[{label}] 名稱命中 {len(hits)} 處：")
    flagged = []
    for i in hits:
        s = lines[i].strip()
        near = []
        for j in range(max(0, i - WIN), min(len(lines), i + WIN + 1)):
            for cue, rx in DEF_CUES:
                if rx.search(lines[j]):
                    near.append((j, cue))
        tag = "定義句型：" + "、".join(f"{c}@第{j + 1}行" for j, c in near) if near else "附近無定義句型"
        print(f"  第 {i + 1:>4} 行：{s[:110]}{'…' if len(s) > 110 else ''}")
        print(f"             {tag}")
        if near:
            flagged.append((i, near))
    return hits, flagged


trail = load(TRAIL)
flan = load(FLAN)

# ---- 正向對照一：數學式有保留 ----
math_inline = [(i + 1, m) for i, s in enumerate(trail) for m in re.findall(r"\$[^$]+\$", s)]
print(f"[對照一] TRAIL 全文的行內數學式共 {len(math_inline)} 個：{math_inline}")

# ---- 正向對照二：同一掃描器在 Agent-FLAN 抓得到 H_Score 的定義 ----
_, flan_flagged = scan(flan, NAME_FLAN, "對照二：Agent-FLAN 的 H_Score")
flan_cues = {c for _, near in flan_flagged for _, c in near}
ctrl_ok = bool({"數學式內的等號", "number of"} & flan_cues)
print(f"  掃描器在已知有定義的 H_Score 上抓到的句型：{sorted(flan_cues)} → 對照{'成立' if ctrl_ok else '失敗'}")

# ---- 主掃描 ----
hits, flagged = scan(trail, NAME_TRAIL, "主掃描：TRAIL 的 Loc／Joint／Cat. F1")

print("\n需要人工判讀的命中（附近有定義句型的）：")
for i, near in flagged:
    for j, cue in near:
        print(f"  名稱在第 {i + 1} 行；句型「{cue}」在第 {j + 1} 行：{trail[j].strip()[:160]}")
if not flagged:
    print("  （無）")

# ---- 補充掃描：不提指標名稱、但描述「預測與金標比對」的句子 ----
CMP_A = re.compile(r"predict|ground[- ]truth|gold|human[- ]annotat", re.I)
CMP_B = re.compile(r"span|location|categor|match|correct|score", re.I)
cmp_hits = [i for i, s in enumerate(trail) if CMP_A.search(s) and CMP_B.search(s)]
print(f"\n[補充] 同一行同時提到「預測／金標」與「span／location／category／match／correct／score」的共 {len(cmp_hits)} 處（供人工判讀是否為不具名的定義）：")
for i in cmp_hits:
    print(f"  第 {i + 1:>4} 行：{trail[i].strip()[:150]}")

print("\n結論（機械部分）：")
print(f"  - 正向對照：TRAIL 全文保留了 {len(math_inline)} 個行內數學式；同一掃描器在 Agent-FLAN 抓到 H_Score 的定義"
      f"（{'成立' if ctrl_ok else '失敗'}）。")
print(f"  - TRAIL 全文提到 Loc／Joint／Cat. F1 的地方共 {len(hits)} 處，其中 {len(flagged)} 處附近出現定義句型，"
      "逐條內容見上方，判讀寫在 04-results.md。")
print("  - 「只量 recall、列出所有 span 可得 1.0」需要官方 calculate_scores.py，本地沒有、依規則不下載 → 無法判定。")
