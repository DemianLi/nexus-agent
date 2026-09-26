"""驗證：2305.07157 Table 5 裡 top-5 意圖過濾對 in-scope accuracy 與 OOS recall 的方向。

主張（章節 01-goal-intent.md〈爭議〉十一「描述式 zero-shot」條）：
  意圖過濾在 in-scope accuracy 上八格中六格下降（例如 MASSIVE 73.3→68.6、73.9→69.2），
  例外是 B02 的 Flan-T5-XXL 從 69 升到 69.7，以及 B01 的 Flan-T5-XXL 持平在 86.5；
  「過濾能提升 OOS recall」只對 GPT-3 成立，Flan-T5-XXL 反而下降（B01 0.48→0.43、B02 0.7→0.65）。

出處：[arXiv:2305.07157]；「多半降分」出自筆記 notes/2305.07157.json 的 limitations_observed，
六格、例外與 OOS recall 方向是本章對照全文 Table 5 的結果。

輸入數字全部取自 .cache/text/2305.07157.txt 的 Table 5。表中每個資料集有兩組列：
「LLM Intents」欄為 5 的是 top-5 檢索過濾後的提示，為該資料集意圖總數（60／27／9／13）的是全意圖提示。
MASSIVE 與 OOTB 的 OOS recall 欄是「-」（沒有 OOS 測試樣本）。
另以正文兩句當錨點：過濾的結果是 3 個隨機種子的平均；以及作者說過濾能提升 OOS recall、舉的是 Benchmark02。

檢查：
  1. 四個資料集 × 兩個模型＝八格 in-scope accuracy，逐格比「過濾」對「全意圖」：下降、持平、上升各幾格。
  2. B01、B02 × 兩個模型＝四格 OOS recall 的方向，看是否只有 GPT-3 上升。
  3. 補充：列出每個資料集提示裡的意圖數由多少縮到 5。

執行：python3 verify/01-intent-filter-table5.py（只用標準函式庫，無隨機數）。
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", ".cache", "text", "2305.07157.txt")

# --- 輸入（取自 .cache/text/2305.07157.txt 的 Table 5） ---
ROWS = {
    "MASSIVE": "| MASSIVE (60 intents) | 5 | Flan-T5-XXL | 68.6 | - | GPT-3 | 69.2 | - | 60 | Flan-T5-XXL | 73.3 | - | GPT-3 | 73.9 | - |",
    "OOTB": "| OOTB-dataset (27 intents) | 5 | Flan-T5-XXL | 83.7 | - | GPT-3 | 83.4 | - | 27 | Flan-T5-XXL | 86.3 | - | GPT-3 | 84.9 | - |",
    "B01": "| Benchmark01 (9 intents) | 5 | Flan-T5-XXL | 86.5 | 0.43 | GPT-3 | 84.6 | 0.97 | 9 | Flan-T5-XXL | 86.5 | 0.48 | GPT-3 | 89.3 | 0.67 |",
    "B02": "| Benchmark02 (13 intents) | 5 | Flan-T5-XXL | 69.7 | 0.65 | GPT-3 | 60.6 | 0.87 | 13 | Flan-T5-XXL | 69 | 0.7 | GPT-3 | 61.3 | 0.67 Table 5",
}
TEXT_ANCHORS = [
    "| Dataset | LLM Intents | Model | In-Scope Accuracy | Out-of-scope Recall |",
    "Table 5: Results for zero-shot prediction on 3 internal datasets along with MASSIVE with GPT-3 and Flan-T5-XXL.",
    "The results with filtering are averaged over 3 runs using different random seeds",
    "filtering can also improve the out-of-scope recall as in the case of Benchmark02 dataset.",
]
MODELS = ["Flan-T5-XXL", "GPT-3"]


def parse(raw):
    total = int(re.search(r"\((\d+) intents\)", raw).group(1))
    cells = re.findall(r"\| (\d+) \| Flan-T5-XXL \| ([\d.]+) \| ([\d.-]+) \| GPT-3 \| ([\d.]+) \| ([\d.-]+)", raw)
    out = {}
    for k, f_acc, f_oos, g_acc, g_oos in cells:
        key = "filtered" if int(k) == 5 else "all"
        out[key] = {
            "Flan-T5-XXL": (float(f_acc), None if f_oos == "-" else float(f_oos)),
            "GPT-3": (float(g_acc), None if g_oos == "-" else float(g_oos)),
        }
        if key == "all" and int(k) != total:
            raise ValueError(f"全意圖列的意圖數 {k} 與資料集標題 {total} 不符")
    return total, out


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
    for a in list(ROWS.values()) + TEXT_ANCHORS:
        hit = a in flat
        ok = ok and hit
        print(f"[錨點] {'找到' if hit else '缺少'}：{a[:90]}")
    return ok


def main():
    anchors_ok = check_anchors()
    print()
    data = {name: parse(raw) for name, raw in ROWS.items()}

    print("[in-scope accuracy] 過濾（top-5）對全意圖")
    down, flat_, up = [], [], []
    for name, (total, d) in data.items():
        for m in MODELS:
            a_all, a_f = d["all"][m][0], d["filtered"][m][0]
            if a_f < a_all:
                down.append(f"{name} {m} {a_all}→{a_f}")
            elif a_f == a_all:
                flat_.append(f"{name} {m} {a_all}→{a_f}")
            else:
                up.append(f"{name} {m} {a_all}→{a_f}")
    print(f"  下降 {len(down)} 格：{'；'.join(down)}")
    print(f"  持平 {len(flat_)} 格：{'；'.join(flat_)}")
    print(f"  上升 {len(up)} 格：{'；'.join(up)}")
    acc_ok = (len(down), len(flat_), len(up)) == (6, 1, 1) and up == ["B02 Flan-T5-XXL 69.0→69.7"] and flat_ == ["B01 Flan-T5-XXL 86.5→86.5"]
    print(f"  與章節寫的「六降、B01 Flan-T5-XXL 持平、B02 Flan-T5-XXL 上升」一致：{'是' if acc_ok else '否'}")
    print()

    print("[OOS recall] 過濾（top-5）對全意圖（只有 B01、B02 有 OOS 測試樣本）")
    rose, fell = set(), set()
    for name, (total, d) in data.items():
        for m in MODELS:
            r_all, r_f = d["all"][m][1], d["filtered"][m][1]
            if r_all is None:
                continue
            (rose if r_f > r_all else fell).add(m)
            print(f"  {name} {m:12s} {r_all}→{r_f}（{'升' if r_f > r_all else '降' if r_f < r_all else '平'}）")
    oos_ok = rose == {"GPT-3"} and fell == {"Flan-T5-XXL"}
    print(f"  只有 GPT-3 上升、Flan-T5-XXL 兩格都下降：{'是' if oos_ok else '否'}")
    print()

    print("[補充] 提示裡的意圖數：" + "；".join(f"{name} {total}→5" for name, (total, _) in data.items()))
    print()

    claim = acc_ok and oos_ok
    if anchors_ok is False:
        verdict = "無法判定（輸入數字與原文錨點對不上）"
    elif claim:
        verdict = "證實（in-scope accuracy 八格中六格下降、一格持平、一格上升；OOS recall 只有 GPT-3 上升）"
    else:
        verdict = "推翻"
    print(f"結論：{verdict}")
    return 0 if claim and anchors_ok is not False else 1


if __name__ == "__main__":
    sys.exit(main())
