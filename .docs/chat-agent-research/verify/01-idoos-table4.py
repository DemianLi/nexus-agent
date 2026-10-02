"""驗證：2106.04564 Table 4 的全表計數，以及由 recall、precision 回推的誤拒比例與 precision 的基準率。

主張（章節 01-goal-intent.md〈問題的演進〉2021 段、〈陷阱一〉、〈陷阱四〉、〈程式驗證〉）：
  一、全表計數（5 模型 × 3 資料 × 2 shot＝30 組，ID-OOS 情境對 OOD-OOS 情境）：
      OOS recall 30 組中 28 組 ID-OOS 較低，例外只有 5-shot Banking 的 ALBERT（86.3 對 85.3）與 ELECTRA（89.4 對 87.3）；
      in-scope 準確率 19 組較低、11 組平均與 ± 值完全相同、0 組較高；
      OOS precision 30 組全部 ID-OOS 較低，其中 BANKING77-OOS 的 10 組也全部較低。
  二、回推（精讀時的分析，筆記 limitations_observed 第 2、3 條）：
      被判 OOS 的筆數＝R×N_oos／P，扣掉真 OOS 即為被拒的 in-scope；
      BANKING77-OOS 5-shot ID-OOS 情境下，ALBERT 約 73%、BERT 約 70%、RoBERTa 約 52% 的 in-scope 被判成 OOS，
      同一個 RoBERTa 在 OOD-OOS 情境約 21%；5-shot RoBERTa Banking 兩情境都約 15%。
      五個模型在 5-shot BANKING77-OOS 的 ID-OOS 情境都落在約 52% 到 73% 之間（筆記只列三個，另兩個是本章補算）。
  三、precision 的基準率（隨機拒識的 precision 等於測試集的 OOS 比例）：
      CLINC 單領域 ID-OOS 情境 350／(500＋350)≈41.2%、OOD-OOS 情境 1000／(500＋1000)≈66.7%；
      BANKING77-OOS 1080／(2000＋1080)≈35.1%、1000／(2000＋1000)≈33.3%；
      5-shot BANKING77-OOS ID-OOS 的 precision 39.8–46.3，只比 35.1% 高 4.7–11.2 點。
      5-shot RoBERTa Banking 的 precision 差距 92.9→78.6（14.3 點）拆成「OOS 比例」與「recall」兩部分，
      這是非線性函數的逐段拆分，結果依順序而定，兩種順序都算：
        先換 recall、再換比例：ID-OOS recall 也有 OOD 的 97.0、被拒的 in-scope 筆數不變，precision 約 82.0，
          比例 92.9−82.0＝10.9、recall 82.0−78.6＝3.4；
        先換比例、再換 recall：recall 仍是 78.4、被拒筆數不變，只把 OOS 從 350 筆換成 1000 筆，
          precision＝1000／(1000＋350／0.786−350)≈91.3（recall 在分子分母約掉），比例 91.3−78.6＝12.7、recall 92.9−91.3＝1.6。
      BANKING77-OOS 兩情境的基準率相近，但只在基準率上是乾淨的比較（2026-10-02 稽核後新增）：
        10 組裡只有 5-shot ALBERT 與 10-shot ELECTRA 兩組的 in-scope 準確率（平均與 ± 值）兩情境相同，
        其餘 8 組兩情境選到的操作點不同；precision 差距最小的是 5-shot ALBERT 的 39.9−39.8＝0.1。
  四、名次與 ToD-BERT 的對照（章節〈問題的演進〉2021 段與〈爭議〉二；2026-10-02 稽核後改寫）：
      5-shot BANKING77-OOS ID-OOS 的 in-scope 準確率最低是 ALBERT 20.3、最高是 RoBERTa 43.0；
      10-shot 同一情境最高是 RoBERTa 59.7；這三個名次與次低／次高者的差距都大於兩者表中 ± 值的較大者。
      ToD-BERT 以 BERT-base uncased 初始化（arXiv:2004.06871），所以對照組是 BERT：
        ID-OOS 情境六格（3 資料 × 2 shot）裡，ToD-BERT 的 OOS recall 六格都較低、in-scope 準確率四格較高兩格較低、
        precision 三格較高三格較低。
      ToD-BERT 在 BANKING77-OOS 的 ID-OOS 情境，三個指標 × 兩種 shot 共六格都低於 RoBERTa。
      舊版章節另寫的三個 ToD-BERT 名次（10-shot Credit cards 與 BANKING77-OOS 的 ID-OOS recall 最低、
      10-shot Banking 的 ID-OOS in-scope 最高）只比了平均，差距都落在表中 ± 值之內，章節已刪；
      程式仍印出它們的差距與 ± 值，但不進判定。

出處：[arXiv:2106.04564]。輸入數字全部取自 .cache/text/2106.04564.txt 的 Table 3 與 Table 4，
表格以原文的扁平化字串整段寫在程式裡（含欄位標頭與情境標籤），整段拿去全文快取做錨點比對，
所以數字、欄位順序與每列屬於哪個 shot、哪個情境，都由同一個錨點擋住。

量具校準：被拒的 in-scope 筆數不可能超過答錯的 in-scope 筆數，所以回推的誤拒比例要 ≤ 100−A_in。
60 格逐一檢查；表中數字應是 10 次執行的平均 ± 標準差（論文未明說，精讀時推測），
用平均值回推只是近似，容差 0.5 個百分點。

執行：python3 verify/01-idoos-table4.py（只用標準函式庫，無隨機數）。
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", ".cache", "text", "2106.04564.txt")

# --- 輸入（取自 .cache/text/2106.04564.txt；原文扁平化後的字串，一段不改） ---
TABLE3 = (
    "| CLINC-Single-Domain-OOS | K | Train | Dev. | Test | In-scope | 10 | 500 | 500 | 500 | ID-OOS | - | - | 400 | 350 "
    "| OOD-OOS | - | - | 200 | 1000 | BANKING77-OOS | K | Train | Dev. | Test | In-scope | 50 | 5905 | 1506 | 2000 "
    "| ID-OOS | - | - | 530 | 1080 | OOD-OOS | - | - | 200 | 1000 Table 3:"
)
TABLE4_PIECES = [
    "| | | In-scope accuracy | OOS recall | OOS precision | 5-shot | Banking | Credit cards | BANKING77-OOS | Banking | Credit cards | BANKING77-OOS | Banking | Credit cards | BANKING77-OOS",
    " | ID-OOS",
    " | ALBERT | 54.1 $\\pm$ 6.9 | 55.5 $\\pm$ 8.1 | 20.3 $\\pm$ 2.4 | 86.3 $\\pm$ 8.1 | 75.9 $\\pm$ 11.2 | 89.5 $\\pm$ 1.5 | 57.9 $\\pm$ 3.3 | 55.8 $\\pm$ 4.3 | 39.8 $\\pm$ 0.7",
    " | BERT | 75.2 $\\pm$ 2.9 | 74.1 $\\pm$ 4.6 | 25.4 $\\pm$ 3.6 | 81.8 $\\pm$ 10.5 | 76.5 $\\pm$ 9.7 | 90.9 $\\pm$ 0.6 | 70.8 $\\pm$ 2.5 | 68.1 $\\pm$ 3.2 | 41.3 $\\pm$ 1.4",
    " | ELECTRA | 64.8 $\\pm$ 4.8 | 71.0 $\\pm$ 7.3 | 30.9 $\\pm$ 2.3 | 89.4 $\\pm$ 4.3 | 75.8 $\\pm$ 6.1 | 87.5 $\\pm$ 2.4 | 65.1 $\\pm$ 3.0 | 67.1 $\\pm$ 4.8 | 43.0 $\\pm$ 0.8",
    " | RoBERTa | 83.8 $\\pm$ 1.7 | 64.5 $\\pm$ 5.6 | 43.0 $\\pm$ 2.9 | 78.4 $\\pm$ 6.2 | 86.8 $\\pm$ 5.4 | 83.1 $\\pm$ 4.3 | 78.6 $\\pm$ 1.5 | 63.3 $\\pm$ 3.4 | 46.3 $\\pm$ 1.9",
    " |",
    " | ToD-BERT | 75.1 $\\pm$ 2.3 | 67.4 $\\pm$ 4.2 | 35.5 $\\pm$ 1.5 | 75.8 $\\pm$ 9.5 | 72.3 $\\pm$ 3.4 | 82.7 $\\pm$ 1.8 | 69.4 $\\pm$ 3.6 | 61.3 $\\pm$ 2.3 | 43.8 $\\pm$ 0.1",
    " | OOD-OOS",
    " | ALBERT | 63.1 $\\pm$ 5.7 | 55.5 $\\pm$ 8.1 | 20.3 $\\pm$ 2.4 | 85.3 $\\pm$ 5.4 | 92.5 $\\pm$ 4.0 | 97.3 $\\pm$ 2.5 | 83.4 $\\pm$ 1.7 | 81.5 $\\pm$ 3.1 | 39.9 $\\pm$ 1.3",
    " | BERT | 75.2 $\\pm$ 2.9 | 74.1 $\\pm$ 4.6 | 39.0 $\\pm$ 3.1 | 93.4 $\\pm$ 3.7 | 95.5 $\\pm$ 2.7 | 94.1 $\\pm$ 1.6 | 88.8 $\\pm$ 1.4 | 88.4 $\\pm$ 1.9 | 49.0 $\\pm$ 1.8",
    " | ELECTRA | 75.5 $\\pm$ 4.0 | 71.0 $\\pm$ 7.3 | 39.1 $\\pm$ 2.7 | 87.3 $\\pm$ 4.3 | 87.6 $\\pm$ 4.2 | 93.1 $\\pm$ 4.3 | 88.8 $\\pm$ 2.1 | 87.0 $\\pm$ 2.7 | 48.7 $\\pm$ 1.1",
    " | RoBERTa | 83.8 $\\pm$ 1.7 | 81.2 $\\pm$ 4.0 | 62.1 $\\pm$ 2.9 | 97.0 $\\pm$ 0.9 | 96.7 $\\pm$ 1.4 | 93.9 $\\pm$ 1.4 | 92.9 $\\pm$ 0.6 | 91.4 $\\pm$ 1.8 | 68.7 $\\pm$ 2.2",
    " |",
    " | ToD-BERT | 83.0 $\\pm$ 1.6 | 75.8 $\\pm$ 5.0 | 52.9 $\\pm$ 1.5 | 91.9 $\\pm$ 1.0 | 96.7 $\\pm$ 0.9 | 88.4 $\\pm$ 1.7 | 92.8 $\\pm$ 0.6 | 89.6 $\\pm$ 2.1 | 66.0 $\\pm$ 1.2",
    " | 10-shot | | |",
    " |",
    " | ID-OOS",
    " | ALBERT | 77.8 $\\pm$ 2.7 | 66.7 $\\pm$ 7.8 | 27.3 $\\pm$ 3.4 | 77.6 $\\pm$ 13.0 | 79.8 $\\pm$ 6.4 | 87.6 $\\pm$ 1.3 | 72.2 $\\pm$ 2.9 | 64.0 $\\pm$ 4.1 | 42.4 $\\pm$ 1.3",
    " | BERT | 77.5 $\\pm$ 1.7 | 80.3 $\\pm$ 3.7 | 52.5 $\\pm$ 1.7 | 87.5 $\\pm$ 9.2 | 74.5 $\\pm$ 6.9 | 77.3 $\\pm$ 3.2 | 73.8 $\\pm$ 1.7 | 73.1 $\\pm$ 3.3 | 50.8 $\\pm$ 1.1",
    " | ELECTRA | 79.5 $\\pm$ 2.9 | 78.0 $\\pm$ 2.5 | 40.1 $\\pm$ 2.7 | 85.2 $\\pm$ 9.1 | 86.5 $\\pm$ 5.8 | 84.0 $\\pm$ 1.7 | 75.4 $\\pm$ 2.7 | 73.3 $\\pm$ 2.9 | 46.1 $\\pm$ 1.1",
    " | RoBERTa | 76.6 $\\pm$ 0.9 | 81.0 $\\pm$ 5.5 | 59.7 $\\pm$ 1.2 | 86.4 $\\pm$ 6.3 | 83.9 $\\pm$ 6.9 | 79.1 $\\pm$ 1.7 | 72.7 $\\pm$ 1.5 | 75.8 $\\pm$ 5.2 | 55.8 $\\pm$ 1.1",
    " |",
    " | ToD-BERT | 80.7 $\\pm$ 2.5 | 80.6 $\\pm$ 0.9 | 54.3 $\\pm$ 1.8 | 79.5 $\\pm$ 6.1 | 70.2 $\\pm$ 5.9 | 76.9 $\\pm$ 2.7 | 75.4 $\\pm$ 1.4 | 71.9 $\\pm$ 2.6 | 52.1 $\\pm$ 1.2",
    " | OOD-OOS",
    " | ALBERT | 77.8 $\\pm$ 2.7 | 66.7 $\\pm$ 7.8 | 30.5 $\\pm$ 6.5 | 90.6 $\\pm$ 4.0 | 95.0 $\\pm$ 3.4 | 92.7 $\\pm$ 6.3 | 89.8 $\\pm$ 1.0 | 85.7 $\\pm$ 2.7 | 47.1 $\\pm$ 1.9",
    " | BERT | 77.5 $\\pm$ 1.7 | 90.1 $\\pm$ 1.9 | 64.2 $\\pm$ 0.5 | 96.8 $\\pm$ 1.2 | 91.1 $\\pm$ 4.4 | 91.4 $\\pm$ 3.2 | 90.0 $\\pm$ 0.7 | 95.5 $\\pm$ 1.1 | 68.9 $\\pm$ 1.0",
    " | ELECTRA | 79.5 $\\pm$ 2.9 | 88.6 $\\pm$ 2.1 | 40.1 $\\pm$ 2.7 | 94.8 $\\pm$ 1.7 | 89.1 $\\pm$ 2.2 | 97.6 $\\pm$ 1.0 | 90.7 $\\pm$ 1.2 | 94.2 $\\pm$ 1.1 | 47.9 $\\pm$ 1.4",
    " | RoBERTa | 89.2 $\\pm$ 1.3 | 87.5 $\\pm$ 3.3 | 70.3 $\\pm$ 0.3 | 95.6 $\\pm$ 1.0 | 94.6 $\\pm$ 2.4 | 94.0 $\\pm$ 0.8 | 95.4 $\\pm$ 0.5 | 94.0 $\\pm$ 1.4 | 73.3 $\\pm$ 1.5",
    " |",
    " | ToD-BERT | 86.5 $\\pm$ 2.6 | 86.5 $\\pm$ 0.6 | 60.6 $\\pm$ 1.8 | 96.0 $\\pm$ 0.5 | 96.4 $\\pm$ 0.5 | 94.9 $\\pm$ 0.9 | 94.2 $\\pm$ 1.2 | 93.7 $\\pm$ 0.3 | 63.3 $\\pm$ 0.9 Table 4: Testing results",
]
TABLE4 = "".join(TABLE4_PIECES)
TEXT_ANCHORS = [
    # 指標定義：in-scope 被判 OOS 算錯
    "if an in-scope example is predicted as OOS, it is counted as wrong.",
    # δ 在 dev 上選，目標是 A_in＋R_oos 在多次執行的平均
    "is tuned by using the development set, so as to maximize",
    "train the model ten times for each hyper-parameter set to select the best threshold",
    # 兩情境的 in-scope 準確率只因 δ 不同而不同（論文自己的表註）
    "the in-scope accuracy could be different in the scenarios of OOD-OOS and ID-OOS",
    # dev 含同一批被保留意圖的 ID-OOS 語句
    "we randomly sample 60 examples, add them to the development set",
    "we move the training/validation/test examples of the selected 27 intents",
]

# 章節寫出的數字（逐項和算出的值比，全部相符才判「證實」）
CLAIMS = {
    "recall_lower": 28,
    "recall_exceptions": {("5", "ALBERT", "Banking"), ("5", "ELECTRA", "Banking")},
    "inscope_lower_equal_higher": (19, 11, 0),
    "precision_lower": 30,
    "precision_lower_b77": 10,
    "reject_b77_5shot_id": {"ALBERT": 73, "BERT": 70, "RoBERTa": 52},
    "reject_b77_5shot_id_span": (52, 73),
    "reject_b77_5shot_ood_roberta": 21,
    "reject_banking_5shot_roberta": (15, 15),
    "base_rates": {"CLINC ID": 41.2, "CLINC OOD": 66.7, "B77 ID": 35.1, "B77 OOD": 33.3},
    "b77_5shot_id_precision_range": (39.8, 46.3),
    "b77_5shot_id_precision_margin": (4.7, 11.2),
    "counterfactual_precision": 82.0,
    "gap_split": (10.9, 3.4),  # 先換 recall、再換比例：(比例, recall)
    "counterfactual_precision_ratio_first": 91.3,
    "gap_split_ratio_first": (12.7, 1.6),  # 先換比例、再換 recall：(比例, recall)
    # BANKING77-OOS 兩情境：in-scope 準確率（平均與 ± 值）相同的組，以及 precision 差距最小的一組
    "b77_same_inscope": {("5", "ALBERT"), ("10", "ELECTRA")},
    "b77_min_precision_gap": (("5", "ALBERT"), 0.1),
    # 名次：(shot, 情境, 資料, 欄位) → (最低的模型, 最高的模型)；None 表示章節沒寫那一端。
    # 每個寫出的名次都要與次低／次高者分得開：差距大於兩者表中 ± 值的較大者
    "extremes": {
        ("5", "ID", "BANKING77-OOS", "A"): ("ALBERT", "RoBERTa"),
        ("10", "ID", "BANKING77-OOS", "A"): (None, "RoBERTa"),
    },
    # ToD-BERT 對底座 BERT，ID-OOS 情境六格（3 資料 × 2 shot）：
    # (recall 較低格數, in-scope 較高格數, in-scope 較低格數, precision 較高格數, precision 較低格數)
    "tod_vs_bert_id": (6, 4, 2, 3, 3),
    # ToD-BERT 在 BANKING77-OOS 的 ID-OOS 情境低於 RoBERTa 的格數（3 指標 × 2 shot）
    "tod_below_roberta_b77_id": 6,
}
# 舊版章節寫過、2026-10-02 稽核後刪掉的名次：只印差距與 ± 值，不進判定
DROPPED_EXTREMES = {
    ("10", "ID", "Credit cards", "R"): ("ToD-BERT", None),
    ("10", "ID", "BANKING77-OOS", "R"): ("ToD-BERT", None),
    ("10", "ID", "Banking", "A"): (None, "ToD-BERT"),
}

MODELS = ["ALBERT", "BERT", "ELECTRA", "RoBERTa", "ToD-BERT"]
DATASETS = ["Banking", "Credit cards", "BANKING77-OOS"]
CELL = re.compile(r"([\d.]+) \$\\pm\$ ([\d.]+)")
TOL_CALIB = 0.5


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
    for name, a in [("Table 3", TABLE3), ("Table 4（整段）", TABLE4)] + [("正文", t) for t in TEXT_ANCHORS]:
        hit = a in flat
        ok = ok and hit
        print(f"[錨點] {'找到' if hit else '缺少'}｜{name}：{a[:80]}")
    return ok


def parse_table3():
    def grab(block, label):
        m = re.search(re.escape(label) + r" \| ([\d-]+) \| ([\d-]+) \| ([\d-]+) \| ([\d-]+)", block)
        return int(m.group(4))  # Test 欄

    clinc, b77 = TABLE3.split("| BANKING77-OOS |")
    n = {}
    for key, block in (("CLINC", clinc), ("B77", b77)):
        n[key] = {"in": grab(block, "In-scope"), "ID": grab(block, "ID-OOS"), "OOD": grab(block, "OOD-OOS")}
    return n


def parse_table4():
    """依原文順序掃：遇到 5-shot／10-shot 換 shot，遇到 ID-OOS／OOD-OOS 換情境，模型名後接 9 格。"""
    header = re.search(r"In-scope accuracy \| OOS recall \| OOS precision", TABLE4)
    if not header:
        raise ValueError("Table 4 欄位標頭不是 In-scope accuracy／OOS recall／OOS precision")
    tokens = re.split(r"( \| (?:5-shot|10-shot|ID-OOS|OOD-OOS|ALBERT|BERT|ELECTRA|RoBERTa|ToD-BERT)(?= \|)| \| (?:5-shot|10-shot)\b)", " | " + TABLE4.split("OOS precision | ", 1)[1])
    data, shot, scen, model = {}, None, None, None
    for tok in tokens:
        t = tok.strip(" |")
        if t in ("5-shot", "10-shot"):
            shot = t.split("-")[0]
        elif t in ("ID-OOS", "OOD-OOS"):
            scen = t.split("-")[0]
        elif t in MODELS:
            model = t
        else:
            cells = CELL.findall(tok)
            if not cells:
                continue
            if len(cells) != 9 or None in (shot, scen, model):
                raise ValueError(f"無法解析的列：{tok[:80]}")
            vals = [(float(a), float(b)) for a, b in cells]
            for d_i, d in enumerate(DATASETS):
                data[(shot, scen, model, d)] = {"A": vals[d_i], "R": vals[3 + d_i], "P": vals[6 + d_i]}
            model = None
    if len(data) != 2 * 2 * 5 * 3:
        raise ValueError(f"Table 4 應有 60 格，解析出 {len(data)} 格")
    return data


def rejected_pct(cell, n_in, n_oos):
    r, p = cell["R"][0] / 100, cell["P"][0] / 100
    caught = r * n_oos
    return (caught / p - caught) / n_in * 100


def main():
    anchors_ok = check_anchors()
    print()
    n = parse_table3()
    data = parse_table4()
    print(f"[Table 3] test：CLINC 每領域 in-scope {n['CLINC']['in']}、ID-OOS {n['CLINC']['ID']}、OOD-OOS {n['CLINC']['OOD']}；"
          f"BANKING77-OOS in-scope {n['B77']['in']}、ID-OOS {n['B77']['ID']}、OOD-OOS {n['B77']['OOD']}")

    def sizes(d, scen):
        k = "B77" if d == "BANKING77-OOS" else "CLINC"
        return n[k]["in"], n[k][scen]

    results = {}

    # 一、全表計數
    print("\n[一] ID-OOS 情境對 OOD-OOS 情境（30 組＝5 模型 × 3 資料 × 2 shot）")
    # a_cmp：平均較低／平均與 ± 值都相同／平均較高／平均相同但 ± 值不同
    rec_lower, rec_exc, a_cmp, p_lower, p_lower_b77 = 0, set(), [0, 0, 0, 0], 0, 0
    for shot in ("5", "10"):
        for m in MODELS:
            for d in DATASETS:
                i, o = data[(shot, "ID", m, d)], data[(shot, "OOD", m, d)]
                if i["R"][0] < o["R"][0]:
                    rec_lower += 1
                else:
                    rec_exc.add((shot, m, d))
                    print(f"  recall 例外：{shot}-shot {d} {m} ID {i['R'][0]} 對 OOD {o['R'][0]}；in-scope {i['A'][0]} 對 {o['A'][0]}")
                if i["A"][0] < o["A"][0]:
                    a_cmp[0] += 1
                elif i["A"] == o["A"]:
                    a_cmp[1] += 1
                elif i["A"][0] > o["A"][0]:
                    a_cmp[2] += 1
                else:
                    a_cmp[3] += 1
                if i["P"][0] < o["P"][0]:
                    p_lower += 1
                    p_lower_b77 += d == "BANKING77-OOS"
    print(f"  OOS recall ID 較低：{rec_lower}／30")
    print(f"  in-scope 準確率 較低／平均與 ± 值都相同／較高／平均相同但 ± 值不同：{a_cmp[0]}／{a_cmp[1]}／{a_cmp[2]}／{a_cmp[3]}")
    print(f"  OOS precision ID 較低：{p_lower}／30（BANKING77-OOS {p_lower_b77}／10）")
    gaps = sorted(((data[(s, 'OOD', m, d)]['A'][0] - data[(s, 'ID', m, d)]['A'][0], s, m, d)
                   for s in ("5",) for m in MODELS for d in DATASETS), reverse=True)[:3]
    print("  5-shot in-scope 差距最大的三組：" + "；".join(
        f"{m} {d} {data[(s, 'ID', m, d)]['A'][0]} 對 {data[(s, 'OOD', m, d)]['A'][0]}" for _, s, m, d in gaps))
    results["counts"] = (rec_lower == CLAIMS["recall_lower"] and rec_exc == CLAIMS["recall_exceptions"]
                         and tuple(a_cmp) == CLAIMS["inscope_lower_equal_higher"] + (0,)
                         and p_lower == CLAIMS["precision_lower"] and p_lower_b77 == CLAIMS["precision_lower_b77"])

    # 量具校準
    print(f"\n[校準] 回推的誤拒比例 ≤ 100−A_in（60 格，容差 {TOL_CALIB}）")
    worst = (-1e9, None)
    for key, cell in data.items():
        shot, scen, m, d = key
        n_in, n_oos = sizes(d, scen)
        excess = rejected_pct(cell, n_in, n_oos) - (100 - cell["A"][0])
        if excess > worst[0]:
            worst = (excess, key)
    calib_ok = worst[0] <= TOL_CALIB
    print(f"  超出最多的一格：{worst[1]}，超出 {worst[0]:.2f} 點 → {'成立' if calib_ok else '不成立'}")
    results["calibration"] = calib_ok

    # 二、回推誤拒比例
    print("\n[二] 回推被判成 OOS 的 in-scope 比例（被判 OOS＝R×N_oos／P，扣掉真 OOS）")
    rej = {}
    for m in MODELS:
        n_in, n_oos = sizes("BANKING77-OOS", "ID")
        rej[m] = rejected_pct(data[("5", "ID", m, "BANKING77-OOS")], n_in, n_oos)
        print(f"  5-shot BANKING77-OOS ID-OOS {m:9s} {rej[m]:.1f}%（A_in {data[('5', 'ID', m, 'BANKING77-OOS')]['A'][0]}）")
    n_in, n_oos = sizes("BANKING77-OOS", "OOD")
    rob_ood = rejected_pct(data[("5", "OOD", "RoBERTa", "BANKING77-OOS")], n_in, n_oos)
    print(f"  5-shot BANKING77-OOS OOD-OOS RoBERTa {rob_ood:.1f}%")
    bank = tuple(rejected_pct(data[("5", s, "RoBERTa", "Banking")], *sizes("Banking", s)) for s in ("ID", "OOD"))
    print(f"  5-shot Banking RoBERTa：ID-OOS {bank[0]:.1f}%、OOD-OOS {bank[1]:.1f}%（兩情境 A_in 都是 83.8）")
    span = (min(rej.values()), max(rej.values()))
    print(f"  五個模型的範圍：{span[0]:.1f}%–{span[1]:.1f}%")
    results["rejection"] = (all(round(rej[m]) == v for m, v in CLAIMS["reject_b77_5shot_id"].items())
                            and tuple(round(x) for x in span) == CLAIMS["reject_b77_5shot_id_span"]
                            and round(rob_ood) == CLAIMS["reject_b77_5shot_ood_roberta"]
                            and tuple(round(x) for x in bank) == CLAIMS["reject_banking_5shot_roberta"])

    # 三、precision 的基準率
    print("\n[三] 隨機拒識的 precision＝測試集的 OOS 比例")
    base = {
        "CLINC ID": n["CLINC"]["ID"] / (n["CLINC"]["in"] + n["CLINC"]["ID"]) * 100,
        "CLINC OOD": n["CLINC"]["OOD"] / (n["CLINC"]["in"] + n["CLINC"]["OOD"]) * 100,
        "B77 ID": n["B77"]["ID"] / (n["B77"]["in"] + n["B77"]["ID"]) * 100,
        "B77 OOD": n["B77"]["OOD"] / (n["B77"]["in"] + n["B77"]["OOD"]) * 100,
    }
    print("  " + "；".join(f"{k} {v:.2f}%" for k, v in base.items()))
    ps = [data[("5", "ID", m, "BANKING77-OOS")]["P"][0] for m in MODELS]
    lo, hi = min(ps), max(ps)
    margin = (lo - base["B77 ID"], hi - base["B77 ID"])
    print(f"  5-shot BANKING77-OOS ID-OOS precision {lo}–{hi}，高於基準 {margin[0]:.2f}–{margin[1]:.2f} 點")
    i_cell, o_cell = data[("5", "ID", "RoBERTa", "Banking")], data[("5", "OOD", "RoBERTa", "Banking")]
    caught = i_cell["R"][0] / 100 * n["CLINC"]["ID"]
    rejected_in = caught / (i_cell["P"][0] / 100) - caught
    caught_cf = o_cell["R"][0] / 100 * n["CLINC"]["ID"]
    p_cf = caught_cf / (caught_cf + rejected_in) * 100
    split = (o_cell["P"][0] - round(p_cf, 1), round(p_cf, 1) - i_cell["P"][0])
    print(f"  5-shot RoBERTa Banking：被拒 in-scope 約 {rejected_in:.1f} 筆")
    print(f"  先換 recall、再換比例：ID-OOS recall 若為 {o_cell['R'][0]}，"
          f"precision＝{caught_cf:.1f}／({caught_cf:.1f}＋{rejected_in:.1f})＝{p_cf:.2f}")
    print(f"    {o_cell['P'][0]}→{i_cell['P'][0]} 的 {o_cell['P'][0] - i_cell['P'][0]:.1f} 點差距：比例 {split[0]:.1f}＋recall {split[1]:.1f}")
    # 另一種順序：recall 仍是 ID-OOS 的值、被拒筆數不變，只把 OOS 筆數換成 OOD-OOS 情境的
    caught_rf = i_cell["R"][0] / 100 * n["CLINC"]["OOD"]
    p_rf = caught_rf / (caught_rf + rejected_in) * 100
    split_rf = (round(p_rf, 1) - i_cell["P"][0], o_cell["P"][0] - round(p_rf, 1))
    print(f"  先換比例、再換 recall：recall 仍為 {i_cell['R'][0]}，OOS 換成 {n['CLINC']['OOD']} 筆，"
          f"precision＝{caught_rf:.1f}／({caught_rf:.1f}＋{rejected_in:.1f})＝{p_rf:.2f}"
          f"（等於 {n['CLINC']['OOD']}／({n['CLINC']['OOD']}＋{n['CLINC']['ID']}／{i_cell['P'][0] / 100:.3f}−{n['CLINC']['ID']})，recall 約掉）")
    print(f"    {o_cell['P'][0]}→{i_cell['P'][0]} 的 {o_cell['P'][0] - i_cell['P'][0]:.1f} 點差距：比例 {split_rf[0]:.1f}＋recall {split_rf[1]:.1f}")
    results["base_rate"] = (all(round(base[k], 1) == v for k, v in CLAIMS["base_rates"].items())
                            and (lo, hi) == CLAIMS["b77_5shot_id_precision_range"]
                            and tuple(round(x, 1) for x in margin) == CLAIMS["b77_5shot_id_precision_margin"]
                            and round(p_cf, 1) == CLAIMS["counterfactual_precision"]
                            and tuple(round(x, 1) for x in split) == CLAIMS["gap_split"]
                            and round(p_rf, 1) == CLAIMS["counterfactual_precision_ratio_first"]
                            and tuple(round(x, 1) for x in split_rf) == CLAIMS["gap_split_ratio_first"])

    # BANKING77-OOS 兩情境：基準率相近，但操作點是否相同要另看
    print("\n[三之二] BANKING77-OOS 兩情境（基準率 35.1% 對 33.3%）各組的 in-scope 準確率與 precision")
    same_a, p_gaps = set(), {}
    for shot in ("5", "10"):
        for m in MODELS:
            i, o = data[(shot, "ID", m, "BANKING77-OOS")], data[(shot, "OOD", m, "BANKING77-OOS")]
            if i["A"] == o["A"]:
                same_a.add((shot, m))
            p_gaps[(shot, m)] = round(o["P"][0] - i["P"][0], 1)
            print(f"  {shot:>2}-shot {m:9s} in-scope ID {i['A'][0]}±{i['A'][1]} 對 OOD {o['A'][0]}±{o['A'][1]}"
                  f"{'（相同）' if i['A'] == o['A'] else ''}；precision {i['P'][0]} 對 {o['P'][0]}，差 {p_gaps[(shot, m)]}")
    min_key = min(p_gaps, key=p_gaps.get)
    print(f"  in-scope 準確率（平均與 ± 值）兩情境相同的：{sorted(same_a)}，共 {len(same_a)}／10 組")
    print(f"  precision 差距最小：{min_key} {p_gaps[min_key]} 點")
    results["b77_clean"] = (same_a == CLAIMS["b77_same_inscope"]
                            and (min_key, p_gaps[min_key]) == CLAIMS["b77_min_precision_gap"]
                            and sum(v == p_gaps[min_key] for v in p_gaps.values()) == 1)

    # 四、名次與 ToD-BERT 的對照
    def extreme(s, sc, d, col):
        """回傳（最低, 次低, 最高, 次高）的模型名，以及各模型的 (平均, ± 值)。"""
        cells = {m: data[(s, sc, m, d)][col] for m in MODELS}
        order = sorted(MODELS, key=lambda m: cells[m][0])
        return order[0], order[1], order[-1], order[-2], cells

    def separated(a, b, cells):
        gap = abs(cells[a][0] - cells[b][0])
        pm = max(cells[a][1], cells[b][1])
        return gap, pm, gap > pm

    print("\n[四] 名次（與次低／次高者的差距要大於兩者 ± 值的較大者）")
    ranks_ok = True
    for (s, sc, d, col), (lo_m, hi_m) in CLAIMS["extremes"].items():
        low, low2, high, high2, cells = extreme(s, sc, d, col)
        tie = cells[low][0] == cells[low2][0] or cells[high][0] == cells[high2][0]
        ok = not tie and (lo_m is None or low == lo_m) and (hi_m is None or high == hi_m)
        parts = []
        for want, a, b, tag in ((lo_m, low, low2, "最低"), (hi_m, high, high2, "最高")):
            if want is None:
                continue
            gap, pm, sep = separated(a, b, cells)
            ok = ok and sep
            parts.append(f"{tag} {a} {cells[a][0]}±{cells[a][1]}，次者 {b} {cells[b][0]}±{cells[b][1]}，"
                         f"差 {gap:.1f}、± 較大者 {pm} → {'分得開' if sep else '落在 ± 內'}")
        ranks_ok = ranks_ok and ok
        print(f"  {s}-shot {sc}-OOS {d} {col}：" + "；".join(parts) + f" → {'成立' if ok else '不成立'}")

    print("  章節已刪的名次（只比平均，不進判定）：")
    for (s, sc, d, col), (lo_m, hi_m) in DROPPED_EXTREMES.items():
        low, low2, high, high2, cells = extreme(s, sc, d, col)
        a, b, tag = (low, low2, "最低") if lo_m else (high, high2, "最高")
        gap, pm, sep = separated(a, b, cells)
        print(f"    {s}-shot {sc}-OOS {d} {col}：{tag} {a} {cells[a][0]}±{cells[a][1]}，次者 {b} {cells[b][0]}±{cells[b][1]}，"
              f"差 {gap:.1f}、± 較大者 {pm} → {'分得開' if sep else '落在 ± 內'}")

    print("\n  ToD-BERT（以 BERT-base uncased 初始化）對 BERT，ID-OOS 情境六格：")
    r_low = a_hi = a_lo = p_hi = p_lo = 0
    for s in ("5", "10"):
        for d in DATASETS:
            t, b = data[(s, "ID", "ToD-BERT", d)], data[(s, "ID", "BERT", d)]
            r_low += t["R"][0] < b["R"][0]
            a_hi += t["A"][0] > b["A"][0]
            a_lo += t["A"][0] < b["A"][0]
            p_hi += t["P"][0] > b["P"][0]
            p_lo += t["P"][0] < b["P"][0]
            print(f"    {s:>2}-shot {d:13s} recall {t['R'][0]} 對 {b['R'][0]}；in-scope {t['A'][0]} 對 {b['A'][0]}；"
                  f"precision {t['P'][0]} 對 {b['P'][0]}")
    tvb = (r_low, a_hi, a_lo, p_hi, p_lo)
    tvb_ok = tvb == CLAIMS["tod_vs_bert_id"]
    print(f"    recall 較低 {r_low}／6；in-scope 較高 {a_hi}、較低 {a_lo}；precision 較高 {p_hi}、較低 {p_lo} → {'成立' if tvb_ok else '不成立'}")

    below = 0
    for s in ("5", "10"):
        t, r = data[(s, "ID", "ToD-BERT", "BANKING77-OOS")], data[(s, "ID", "RoBERTa", "BANKING77-OOS")]
        below += sum(t[c][0] < r[c][0] for c in ("A", "R", "P"))
        print(f"  BANKING77-OOS ID-OOS {s:>2}-shot ToD-BERT 對 RoBERTa：in-scope {t['A'][0]} 對 {r['A'][0]}、"
              f"recall {t['R'][0]} 對 {r['R'][0]}、precision {t['P'][0]} 對 {r['P'][0]}")
    tvr_ok = below == CLAIMS["tod_below_roberta_b77_id"]
    print(f"    低於 RoBERTa 的格數 {below}／6 → {'成立' if tvr_ok else '不成立'}")
    results["ranks"] = ranks_ok
    results["tod_bert"] = tvb_ok and tvr_ok

    print()
    for k, v in results.items():
        print(f"[判定] {k}：{'成立' if v else '不成立'}")
    claim = all(results.values())
    if anchors_ok is False:
        verdict = "無法判定（輸入數字與原文錨點對不上）"
    elif claim:
        verdict = (f"證實（recall {rec_lower}／30 組 ID-OOS 較低、in-scope {a_cmp[0]} 低 {a_cmp[1]} 同 {a_cmp[2]} 高、"
                   f"precision {p_lower}／30 較低；5-shot BANKING77-OOS ID-OOS 回推誤拒 ALBERT {rej['ALBERT']:.0f}%、"
                   f"BERT {rej['BERT']:.0f}%、RoBERTa {rej['RoBERTa']:.0f}%，precision 只高於基準率 {base['B77 ID']:.1f}% "
                   f"{margin[0]:.1f}–{margin[1]:.1f} 點；precision 差距兩種拆法 {split[0]:.1f}＋{split[1]:.1f} 與 "
                   f"{split_rf[0]:.1f}＋{split_rf[1]:.1f}；BANKING77-OOS 只有 {len(same_a)}／10 組兩情境 in-scope 相同；"
                   f"ToD-BERT 對 BERT recall {r_low}／6 較低、in-scope {a_hi}／6 較高、precision {p_hi}／6 較高；"
                   f"回推只是近似，60 格校準最多超出 {worst[0]:.2f} 點）")
    else:
        verdict = "推翻（不成立的項：" + "、".join(k for k, v in results.items() if not v) + "）"
    print(f"結論：{verdict}")
    return 0 if claim and anchors_ok is not False else 1


if __name__ == "__main__":
    sys.exit(main())
