#!/usr/bin/env python3
"""驗證：Llama Guard 的比較不對等（自家測試集同分佈、Azure 閾值挑 AP 最高）。

主張（章節 03-agent-observation.md 第 149、331 行）：
  (4a) 內部測試集是同分佈結果：訓練與測試是同一批資料的隨機切分，prompt 來自同一個 Anthropic 資料集、response
       來自同一個內部 Llama checkpoint、標註者是同一個紅隊。
  (4b) 論文寫了 Azure API 的閾值是在 1–6 之間挑 average precision 最高的那個。
  (4c) Azure 實際用的閾值就是依 average precision 在各資料集上挑出來的。
  (4d) 章節同句順帶提到：未微調的 Llama2-7b 零樣本輸出格式錯誤，被直接記為 AUPRC 0。
  出處：[arXiv:2312.06674] notes/2312.06674.json 的 limitations_observed 第 1、5、10 條。

這是文字主張，沒有數字可以重算；本程式做的是確定性的原文錨點檢查：
  - 每個錨點句必須在 .cache/text/2312.06674.txt 裡剛好出現一次，印出行號與所在章節標題。
  - 另外解析 Table 2（AUPRC 主表）與附錄 B 的 Table 5／6，確認 Azure 出現在哪幾張表、評在哪個資料集上，
    並找出論文對 Azure 閾值的其他說法，檢查是否彼此一致。
「同分佈」是把四項事實合起來的判讀，程式只能確認那四項事實在原文裡。

只用標準函式庫、沒有隨機數。
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TXT = ROOT / ".cache" / "text" / "2312.06674.txt"


def find_once(lines, needle):
    hits = [i for i, s in enumerate(lines) if needle in s]
    assert len(hits) == 1, f"錨點 {needle!r} 應剛好出現一次，實際 {len(hits)} 次"
    return hits[0]


def section_of(lines, i):
    for j in range(i, -1, -1):
        if lines[j].startswith("#"):
            return lines[j].lstrip("#").strip()
    return "（無）"


def show(lines, label, needle):
    i = find_once(lines, needle)
    print(f"  [{label}] 第 {i + 1} 行，§「{section_of(lines, i)}」：…{needle}…")
    return i


def main():
    lines = TXT.read_text(encoding="utf-8").splitlines()

    print("== (4a) 同分佈的四項事實（§3.3）==")
    anchors_a = [
        ("prompt 來源", "We leverage the human preference data about harmlessness from Anthropic"),
        ("只取第一個人類訊息", "we pick the first human prompt and discard the corresponding response"),
        ("response 來源", "we use one of our internal Llama checkpoints to generate a mix of cooperating and refusing responses"),
        ("標註者", "We employ our expert, in-house red team to label the prompt and response pairs"),
        ("資料量", "The final dataset comprises of 13,997 prompts and responses"),
        ("隨機切分", "we perform a random split of 3:1 ratio between fine-tuning and evaluation"),
    ]
    idx_a = [show(lines, lab, nd) for lab, nd in anchors_a]
    secs = {section_of(lines, i) for i in idx_a}
    assert secs == {"3.3 Data Collection"}, secs
    # 論文自己把自家測試集的結果定位為 in-policy
    show(lines, "作者自述", "showing a very high ceiling for this approach in building guardrail models in the in-policy setup")
    # Table 2：自家測試集的 AUPRC
    cap2 = find_once(lines, "Table 2: Evaluation results on various benchmarks (metric: AUPRC")
    sec44 = find_once(lines, "### 4.4 Overall Results")
    region = "\n".join(lines[sec44:cap2])
    lg = re.search(r"\| Llama Guard\s*\n\|\s*([\d.]+)\s*\n\|\s*([\d.]+)\s*\n\|\s*([\d.]+)\s*\n\|\s*([\d.]+)", region)
    assert lg, "解析不到 Table 2 的 Llama Guard 列"
    print(f"  [Table 2，表題第 {cap2 + 1} 行] Llama Guard AUPRC：Our Test Set (Prompt) {lg.group(1)}、OpenAI Mod "
          f"{lg.group(2)}、ToxicChat {lg.group(3)}、Our Test Set (Response) {lg.group(4)}")
    print("  → 四項事實都在原文 §3.3；自家測試集＝同一批 13,997 筆的 1/4 隨機切分。(4a) 證實。")

    print("\n== (4b)(4c) Azure 閾值：論文裡的三種說法 ==")
    i1 = show(lines, "§4.3.2 說法一", "We tested setting the threshold as 1 - 6 to binarize the max integer")
    assert "selected the threshold that provided the highest average precision for the dataset" in lines[i1 + 1]
    print(f"      接續第 {i1 + 2} 行：…selected the threshold that provided the highest average precision for the dataset.")
    show(lines, "§4.3.3 說法二", "it is infeasible to compute average precision for Azure API and GPT-4")
    i3 = show(lines, "附錄 B 說法三", "set every threshold to 0.5 and compute Precision, Recall and F1 Score")

    # Azure 出現在哪幾張結果表
    azure_lines = [i + 1 for i, s in enumerate(lines) if "Azure" in s]
    print(f"  全文含「Azure」的行：{azure_lines}")
    assert "Azure" not in region, "Table 2 裡出現了 Azure"
    print(f"  Table 2（AUPRC 主表，第 {sec44 + 1}–{cap2 + 1} 行）沒有 Azure 列。")
    for cap_prefix in ("Table 5: Prompt classification performance breakdown", "Table 6: Response classification performance breakdown"):
        c = find_once(lines, cap_prefix)
        # 往回找表頭（以 '|' 單獨一行開頭的那組）
        j = c - 1
        while j >= 0 and (lines[j].startswith("|") or lines[j].strip() == ""):
            j -= 1
        block = [s[1:].strip() for s in lines[j + 1:c] if s.startswith("|")]
        header = block[:6]
        assert header == ["", "Llama Guard", "OpenAI Mod API", "Azure API", "Perspective API", "GPT-4"], header
        ov = block.index("Overall")
        overall = dict(zip(header[1:], block[ov + 1:ov + 6]))
        cap_text = lines[c]
        print(f"  [{cap_prefix.split(':')[0]}，表題第 {c + 1} 行] 表題含「in our dataset」：{'in our dataset' in cap_text}；"
              f"含「threshold is set to be 0.5」：{'threshold is set to be 0.5' in cap_text}")
        print(f"      Overall P/R/F1：Llama Guard {overall['Llama Guard']}、Azure API {overall['Azure API']}")
        assert "in our dataset" in cap_text and "threshold is set to be 0.5" in cap_text
    print("  → (4b) 說法一（挑 AP 最高）確實在原文。(4c) 但說法二（Azure 算不了 AP）與它直接矛盾；說法三（附錄 B 閾值全是 0.5）")
    print("    對 0–6 的整數分數等同「≥1 判 unsafe」，可能與說法一等價也可能不同，分不出來。")
    print("    Azure 只出現在附錄 B 的 Table 5／6，而兩張都評在自家測試集上，所以「各資料集」實際上只有一個資料集。")
    print("    挑閾值若真的發生，偏袒的是 Azure；同分佈偏袒的是 Llama Guard。兩個不對等方向相反。")

    print("\n== (4d) Llama2-7b 零樣本記為 AUPRC 0 ==")
    i4 = show(lines, "§4.5.2", "LLama2-7b only produced malformed outputs")
    assert "its AUPRC as zero" in lines[i4 + 1]
    print(f"      接續第 {i4 + 2} 行：…its AUPRC as zero…")

    print("\n結論：(4a) 證實；(4b) 證實（原文確有此句）；(4c) 無法判定（論文自相矛盾）；(4d) 證實。")
    print("DONE 03-llamaguard-eval-parity")


if __name__ == "__main__":
    sys.exit(main())
