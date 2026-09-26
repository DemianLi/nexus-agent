#!/usr/bin/env python3
"""驗證：本章幾個「沒有消融」「沒有報」「沒有量」的否定性主張，在快取全文裡找不找得到反例。

主張（章節 03-agent-observation.md 的 UI-TARS 段、OmniParser 段、〈感知這一側的陷阱〉汙染條、
〈合起來看〉觀測成本條、未解問題 1 與 2）：
  N1 UI-TARS：N=5 的截圖歷史沒有消融。[arXiv:2501.12326]
  N2 UI-TARS：主實驗的輸入解析度與影像 token 數沒有報告。[arXiv:2501.12326]
  N3 OmniParser：沒有量解析延遲與提示長度。[arXiv:2408.00203]
  N4 UGround：Web-Hybrid 沒有做與 ScreenSpot-Web 或 Mind2Web 網站的去重比對。[arXiv:2410.05243]
  N5 UGround：沒有量解析延遲、提示長度或端到端成本。[arXiv:2410.05243]
出處：各篇精讀筆記的 limitations_observed。

方法：
  - 對每條主張列出「反例關鍵字」（同義詞與寫法變體），在快取全文逐行搜尋，印出每個命中的行號與前後文，
    再依預先寫好的規則判讀：命中的是不是真的反例（例如 UI-TARS 另有一個 Best-of-N 的 N，那個 N 有掃
    1／16／64，但它不是截圖歷史的 N）。
  - 正對照：N1 用來找「歷史長度的其他寫法」的通用關鍵字 HISTORY_KW，原封不動拿去掃已知「有做」歷史消融的
    兩篇：SWE-agent（Last 5 Obs. 對 Full history）與 OSWorld（歷史長度 1、2、3、>3 的曲線）。兩篇都要命中，
    而且命中裡要包含真正的消融列（SWE-agent 的 Full history 表列或「history set to last five observations」、
    OSWorld 的 Figure 7 圖說「length of history」），只命中「history processors」這類順帶提到的句子不算。
    找不到就表示掃描器本身壞了。
  - 正對照的限制：HISTORY_KW 是看過這兩篇的寫法之後才擴充的（第一版的關鍵字在兩篇上都是 0 命中）。所以正對照
    只證明這組關鍵字涵蓋得到這兩種寫法，不代表對其他寫法的召回率。N1 的主要證據仍是 UI-TARS 全文每一處 $N$
    的逐處分類；HISTORY_KW 在 UI-TARS 上的命中也逐處分類，未分類的命中才算反例。
  - 限制：只能說「全文裡找不到」，不能排除論文附帶的程式碼、專案頁或後續版本有報。

沒有用到隨機數。只用標準函式庫。執行：python3 verify/03-negative-claims-scan.py（從研究根目錄）
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TXT = os.path.join(HERE, "..", ".cache", "text")

# N1 與正對照共用的「歷史長度」通用關鍵字。第一版只有下面第一行的前兩個分支與最後一行的「N screenshots of history」，
# 在 SWE-agent 與 OSWorld 上都是 0 命中；修訂時補上 length of history、history (trajectory|encoding) length、
# last/past/previous N observations|rounds、full history、history processing 等寫法。
_NUMW = r"(\d+|\$\d+\$|\$N\$|N|one|two|three|four|five|six|eight|ten)"
HISTORY_KW = (
    r"(history length|number of (history|previous|past|prior) (screenshots|observations|images|steps|rounds|turns)|"
    r"history (trajectory |encoding )?length|length of (the )?history|"
    r"(last|past|previous|prior|recent) " + _NUMW + r" (screenshots|observations|images|rounds|turns)|"
    r"(full|entire|whole|complete) (message |interaction |trajectory )?history|history process|"
    r"with(out)? (the )?history|more (trajectory )?history|"
    r"\b\d+ (screenshots|observations) (of|as) history)"
)


def load(pid):
    with open(os.path.join(TXT, pid + ".txt"), encoding="utf-8") as f:
        return f.read().split("\n")


def scan(lines, pattern):
    rx = re.compile(pattern, re.I)
    return [(i + 1, l.strip()) for i, l in enumerate(lines) if rx.search(l)]


def show(hits, limit=160):
    for ln, l in hits:
        print("      第 %d 行：%s" % (ln, l[:limit]))


def main():
    results = {}

    # ---- 正對照 ----
    print("=== 正對照：N1 的通用關鍵字 HISTORY_KW，對已知有做歷史消融的兩篇要找得到 ===")
    swe = load("2405.15793")
    pos1 = scan(swe, HISTORY_KW)
    print("  SWE-agent：HISTORY_KW → %d 個命中" % len(pos1))
    show(pos1, 200)
    # 命中裡要有真正的消融：Table 的 Full history 列，或 §B.1 的「history set to last five observations」
    pos1_real = [h for h in pos1 if re.search(r"^\|?\s*Full history\s*$|history set to last five observations", h[1])]
    print("  其中是歷史消融本身的：%d 個（其餘是順帶提到 history processor 的句子）" % len(pos1_real))
    osw = load("2404.07972")
    pos2 = scan(osw, HISTORY_KW)
    print("  OSWorld：HISTORY_KW → %d 個命中" % len(pos2))
    show(pos2, 200)
    # 命中裡要有 Figure 7 的圖說（歷史長度 1、2、3、>3 的曲線）
    pos2_real = [h for h in pos2 if re.search(r"effect of length of history on performance", h[1])]
    print("  其中是歷史長度曲線本身的：%d 個" % len(pos2_real))
    # 第一版的關鍵字（只有下面三個分支），留著當對照：它在兩篇上都是 0 命中
    kw_v1 = (r"(history length|number of (history|previous|past) (screenshots|observations|images)|"
             r"(1|2|3|4|8|10) (screenshots|observations) (of|as) history)")
    print("  對照：第一版關鍵字在 SWE-agent 命中 %d 個、在 OSWorld 命中 %d 個"
          % (len(scan(swe, kw_v1)), len(scan(osw, kw_v1))))
    control_ok = len(pos1_real) >= 2 and len(pos2_real) >= 1

    # ---- N1 ----
    ui = load("2501.12326")
    print("\n=== N1 UI-TARS：截圖歷史 N=5 有沒有消融 ===")
    define = scan(ui, r"limit the input to the last \$N\$ observations")
    fixed = scan(ui, r"set the \$N\$ in Eq\. 3 to \$5\$ throughout")
    print("  定義歷史 N 的句子：%d 處" % len(define))
    show(define)
    print("  把歷史 N 固定為 5 的句子：%d 處" % len(fixed))
    show(fixed)
    other_n = [h for h in scan(ui, r"\$N\$") if h not in define and h not in fixed]
    bon = [h for h in other_n if re.search(r"(Best-of-N|candidate outputs|\$N\$ ?=|\$N\$ increases|iteration \$n\$|step \$n\$)", h[1], re.I)]
    rest = [h for h in other_n if h not in bon]
    print("  其他提到 $N$ 的句子：%d 處，其中 %d 處屬於 Best-of-N 取樣或迭代編號（不是截圖歷史）" % (len(other_n), len(bon)))
    show(bon, 120)
    kw = scan(ui, HISTORY_KW)
    print("  歷史長度的其他寫法（HISTORY_KW，與正對照同一組）：%d 處" % len(kw))
    show(kw, 200)
    # 逐處分類：定義句已在上面列過；「The full history of previous actions and thoughts is retained」
    # 說的是 thought 與 action 的文字歷史全部保留，不是截圖歷史 N 的消融
    kw_text_hist = [h for h in kw if re.search(r"full history of previous actions and thoughts", h[1])]
    kw_rest = [h for h in kw if h not in define and h not in fixed and h not in kw_text_hist]
    print("  分類：定義句 %d 處、文字歷史全留的說明 %d 處、未分類 %d 處"
          % (len([h for h in kw if h in define]), len(kw_text_hist), len(kw_rest)))
    results["N1"] = len(define) == 1 and len(fixed) == 1 and not rest and not kw_rest
    print("  判讀：" + ("找不到反例。歷史 N 只在定義處與「整節固定為 5」出現；有掃過的 N 是 Best-of-N 的取樣數；"
                      "HISTORY_KW 的命中也都已分類"
                      if results["N1"] else "有未分類的命中，需要人工判讀：%s" % (rest + kw_rest)))

    # ---- N2 ----
    print("\n=== N2 UI-TARS：主實驗的輸入解析度與影像 token 數有沒有報 ===")
    res_num = scan(ui, r"\d{3,4}\s*(×|x|\\times|\*)\s*\d{3,4}")
    pix = scan(ui, r"(max|min)_pixels|(image|visual) tokens?|tokens per (image|screenshot)")
    res_any = scan(ui, r"resolution")
    print("  寬×高形式的解析度數字：%d 處；max_pixels、image tokens 這類設定：%d 處" % (len(res_num), len(pix)))
    show(res_num + pix)
    print("  所有提到 resolution 的句子：%d 處（逐一列出，供判讀）" % len(res_any))
    show(res_any, 200)
    qual = [h for h in res_any if re.search(r"increasing the input image resolution", h[1])]
    results["N2"] = not res_num and not pix
    print("  判讀：" + ("找不到反例。全文沒有主實驗的解析度數字或影像 token 數；但有 %d 處定性提到「在 ScreenSpot Pro 上"
                      "提高輸入解析度明顯提升表現」，沒有給數字" % len(qual)
                      if results["N2"] else "找到數字形式的解析度或 token 設定，主張不成立"))

    # ---- N3 ----
    om = load("2408.00203")
    print("\n=== N3 OmniParser：有沒有量解析延遲與提示長度 ===")
    lat = scan(om, r"(latenc|\bseconds?\b|\bms\b|\bruntime|inference time|wall[- ]clock|throughput|prompt length|"
                   r"number of tokens|token (count|length)|\bcost\b|\bFLOPs\b)")
    fast = scan(om, r"\bfast\b|efficien|speed")
    print("  延遲、秒數、token 數、成本這類量測字眼：%d 處" % len(lat))
    show(lat)
    print("  「fast」「efficient」「speed」這類定性字眼：%d 處" % len(fast))
    show(fast)
    # 「second」當序數（the second section of the table）不是時間；只有帶單位的數字才算量測
    lat_real = [h for h in lat if re.search(r"(latenc|runtime|inference time|wall[- ]clock|throughput|prompt length|"
                                            r"number of tokens|token (count|length)|\bcost\b|FLOPs)", h[1], re.I)
                or re.search(r"\d+(\.\d+)?\s*(s|ms|seconds?)\b", h[1])]
    results["N3"] = not lat_real
    print("  判讀：" + ("找不到反例。唯一的命中是序數用法（the second section of the table），沒有任何延遲、token 數"
                      "或成本的量測；只有定性說描述模型「fast」" if results["N3"] else "找到量測字眼，需要人工判讀：%s" % lat_real))

    # ---- N4 ----
    ug = load("2410.05243")
    print("\n=== N4 UGround：Web-Hybrid 有沒有和 ScreenSpot-Web 或 Mind2Web 的網站去重 ===")
    dd = scan(ug, r"(dedup|de-dup|overlap|contamina|leak|decontam)")
    excl = scan(ug, r"(exclud|filter(ed)? out|remov).{0,80}(ScreenSpot|Mind2Web|test|benchmark|evaluation)")
    print("  dedup、overlap、contamination、leak 這類字眼：%d 處" % len(dd))
    show(dd, 220)
    print("  「排除／濾掉／移除」後面接 ScreenSpot、Mind2Web、test、benchmark：%d 處" % len(excl))
    show(excl, 220)
    dd_real = [h for h in dd if not re.search(r"data efficiency during training", h[1])]
    results["N4"] = not dd_real and not excl
    print("  判讀：" + ("找不到反例。唯一的 deduplication 出現在「訓練時的資料效率還有改進空間」的未來工作句，"
                      "不是和評估集去重" if results["N4"] else "有未排除的命中，需要人工判讀：%s" % (dd_real + excl)))

    # ---- N5 ----
    print("\n=== N5 UGround：有沒有量延遲、提示長度或端到端成本 ===")
    lat2 = scan(ug, r"(latenc|\bcosts?\b|inference time|wall[- ]clock|throughput|prompt length|GPU hours|"
                    r"\bseconds?\b|\bms\b)")
    print("  命中：%d 處" % len(lat2))
    show(lat2, 200)
    measured = [h for h in lat2 if re.search(r"\d+(\.\d+)?\s*(s|ms|seconds?|\$|USD|GPU hours)\b", h[1])
                and not re.search(r"secs_between_keys|seconds rate|seconds between characters", h[1])]
    results["N5"] = not measured
    print("  判讀：" + ("找不到反例。latency 與 cost 只出現在動機（額外的文字輸入會增加延遲與成本）與「線上評估成本高」"
                      "的說明，沒有量測數字；其餘命中是動作 API 的參數說明" if results["N5"]
                      else "找到帶單位的量測數字，需要人工判讀：%s" % measured))

    ok = control_ok and all(results.values())
    print("\n結論：" + ("正對照兩篇都找得到（用的是 N1 同一組 HISTORY_KW，但它是看過兩篇的寫法後才擴充的）；"
                      "N1–N5 五條否定性主張在快取全文裡都找不到反例（N2 另有一處沒給數字的定性說法）"
                      if ok else "正對照失敗或有主張找到反例：%s" % results) + "  DONE 03-negative-claims-scan.py")


if __name__ == "__main__":
    main()
