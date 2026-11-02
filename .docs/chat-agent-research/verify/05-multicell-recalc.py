#!/usr/bin/env python3
"""驗證：撐起本章判斷、又引用多格數字的三條重算（缺口 C13）。

check_chapter.py 只驗「算式成立」與「數字出現在筆記或全文某處」，不驗運算元是不是取自宣稱的那一格。
這支程式逐格從表格解析，確認每個運算元的列與欄。

主張（章節 05-self-correction-reflection.md）：
  A. 陷阱四、未解問題 2：RISE（2407.18219）宣稱修正比同樣本數的平行多數決「一致高 4%–8%」（GSM8K）、
     「高 6.5%」（MATH、Mistral）。本章依 Table 1 重算 m1@t5 − m5@t1：GSM8K 上 Llama2 Iter1 50.7 − 49.7 = 1.0、
     Iter2 55.0 − 51.0 = 4.0、Mistral Iter1 59.2 − 50.6 = 8.6；MATH 上 9.7 − 8.8 = 0.9、10.4 − 10.4 = 0、18.4 − 9.5 = 8.9。
     另外 §4 那一步「knowledge boosting 占了 64%」用到 Table 1 的 Boost 列 m1@t5 39.2。
  B. 陷阱七：Tyen et al.（2311.08516）Table 5 的全猜錯 naive 基準是 78；GPT-4 有 10／15 格、GPT-4-Turbo 有 6／10 格高於它。
  C. 爭議四：Self-Debugging（2304.05128）Table 2(b) TransCoder 上，只給對錯位元的 Simple 佔全部增益的比例
     Codex 73.6%、GPT-3.5 69.4%、StarCoder 43.9%、GPT-4 27.5%；Table 2(c) 與 Table 3(b) 的 MBPP Codex 61.4→68.2、61.4→57.6。

輸入：全部由本程式從 .cache/text/<id>.txt 解析，以表題為錨點，對表頭、列名與格數做 assert，輸出附行號。

對 A 另做一件事：RISE 原句比的是「第 1 輪與第 5 輪的 maj@5」，Table 1 沒有第 5 輪的 maj@5 欄。
所以程式列舉兩種組合，看有沒有任何一組讓 GSM8K 三列都落在 4–8、讓 Mistral 的 MATH 等於 6.5：
同一列的所有有序欄對（4 欄取 2，共 12 種），以及 Mistral 訓練後對訓練前的跨列欄對（4 × 4 = 16 種）。
搜尋範圍只到這裡，沒有掃 Table 1 的全部格對：全表任兩格的差很容易巧合地落在 4–8 或等於 6.5，那種命中不代表作者比的是那兩格。

判定分三種：證實、不成立、無法判定。A2 在搜尋範圍內找不到對應的兩格時判為「無法判定」（作者比的是哪兩格無法定位），
找到時判為「不成立」（章節「找不到」的說法被推翻）。退出碼：沒有任何子主張「不成立」才回 0。

無隨機數，不需種子。只用標準函式庫。執行：python3 verify/05-multicell-recalc.py
"""

import itertools
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXT = ROOT / ".cache" / "text"
NUM = re.compile(r"^(-?\d+(?:\.\d+)?)%?(?:\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*\))?$")
verdicts = []


def load(pid):
    return (TEXT / f"{pid}.txt").read_text(encoding="utf-8").splitlines()


def find_line(lines, needle, start=0):
    hits = [i for i in range(start, len(lines)) if needle in lines[i]]
    assert hits, f"找不到含 {needle!r} 的行"
    return hits[0]


def groups(lines, a, b):
    out, cur = [], []
    for i in range(a, b):
        s = lines[i].strip()
        if not s:
            if cur:
                out.append(cur)
                cur = []
            continue
        cur.append((i + 1, s))
    if cur:
        out.append(cur)
    res = []
    for g in out:
        if not g[0][1].startswith("|"):
            continue
        label = g[0][1].lstrip("|").strip()
        cells = []
        for ln, s in g[1:]:
            m = NUM.match(s.lstrip("|").strip())
            if m:
                cells.append((float(m.group(1)), ln))
        res.append((label, g[0][0], cells))
    return res


def verdict(tag, status, text):
    """status：True（證實）、False（不成立）或 "無法判定"。"""
    label = "證實" if status is True else ("不成立" if status is False else status)
    verdicts.append((tag, label))
    print(f"  [{tag}] {label}：{text}")


# ---------- A. RISE Table 1 ----------
print("== A. RISE（2407.18219）Table 1：m1@t5 − m5@t1 ==")
L = load("2407.18219")
a = find_line(L, "We also compare maj@K performance at the first turn")
b = find_line(L, "Table 1: RISE vs. other approaches")
seq = [(lab, ln, cells) for lab, ln, cells in groups(L, a, b) if len(cells) == 8]
labels = [lab for lab, _, _ in seq]
assert labels[:4] == ["Llama2 Base", "+Boost", "+Iteration 1", "+Iteration 2"], labels
assert "Mistral-7B" in labels and labels[labels.index("Mistral-7B") + 1] == "+ Iteration 1", labels
cols = ["m1@t1", "m5@t1", "m1@t5", "p1@t5"]
R = {
    "Llama2 Iter1": seq[2],
    "Llama2 Iter2": seq[3],
    "Mistral Iter1": seq[labels.index("Mistral-7B") + 1],
}
boost = seq[1]
claimed = {("GSM8K", "Llama2 Iter1"): 1.0, ("GSM8K", "Llama2 Iter2"): 4.0, ("GSM8K", "Mistral Iter1"): 8.6,
           ("MATH", "Llama2 Iter1"): 0.9, ("MATH", "Llama2 Iter2"): 0.0, ("MATH", "Mistral Iter1"): 8.9}
allok = True
for ds, off in (("GSM8K", 0), ("MATH", 4)):
    for name, (lab, ln, cells) in R.items():
        m5, l5 = cells[off + 1]
        m1t5, l1 = cells[off + 2]
        d = round(m1t5 - m5, 1)
        ok = abs(d - claimed[(ds, name)]) < 0.05
        allok &= ok
        print(f"  {ds} {name}（列名在第 {ln} 行）：m1@t5 {m1t5}（第 {l1} 行）− m5@t1 {m5}（第 {l5} 行）= {d}{'' if ok else '  ← 與章節不符'}")
verdict("A1", allok, "章節六個差值的運算元都取自宣稱的那一列那一欄（Llama2 Iter1／Iter2、Mistral Iter1 的 m1@t5 與 m5@t1），算式正確")

# 列舉同列所有欄對
print("  列舉同一列的所有有序欄對 (x − y)，共 12 種：")
found_gsm, found_math = [], []
for x, y in itertools.permutations(range(4), 2):
    ds = [round(R[n][2][x][0] - R[n][2][y][0], 1) for n in R]
    if all(3.95 <= d <= 8.05 for d in ds):
        found_gsm.append((cols[x], cols[y], ds))
    dm = round(R["Mistral Iter1"][2][4 + x][0] - R["Mistral Iter1"][2][4 + y][0], 1)
    if abs(dm - 6.5) < 0.05:
        found_math.append((cols[x], cols[y], dm))
    print(f"    GSM8K {cols[x]} − {cols[y]}：{ds}；Mistral MATH：{dm}")
mistral_base = seq[labels.index("Mistral-7B")]
cross = []
for i, j in itertools.product(range(4), range(4)):
    v = round(R["Mistral Iter1"][2][4 + i][0] - mistral_base[2][4 + j][0], 1)
    if abs(v - 6.5) < 0.05:
        cross.append((cols[i], cols[j]))
n_cross = 4 * 4
print(f"  讓 GSM8K 三列都落在 4–8 的欄對：{found_gsm or '沒有'}")
print(f"  讓 Mistral MATH 等於 6.5 的同列欄對：{found_math or '沒有'}；Mistral 訓練後對訓練前的 {n_cross} 種跨列欄對：{cross or '沒有'}")
hit = found_gsm or found_math or cross
verdict("A2", False if hit else "無法判定",
        ("在同列 12 種欄對與 Mistral 訓練前後 16 種跨列欄對裡找到能重現的組合，章節「找不到」的說法不成立"
         if hit else
         "在同列 12 種欄對與 Mistral 訓練前後 16 種跨列欄對裡，找不到任何一組能重現「一致 4%–8%」或「MATH 6.5%」；"
         "依本章的讀法（m1@t5 − m5@t1）是 1.0／4.0／8.6 與 8.9，不吻合。原句說比的是第 1 輪與第 5 輪的 maj@5，"
         "Table 1 沒有這一欄，作者比的是哪兩格無法定位；搜尋範圍之外（例如全表任兩格）沒有掃"))

# Boost 列：Table 1 對附錄 Table 4
c4 = find_line(L, "Table 4: Comparison of model performance on GSM8K with different mechanisms")
t4 = [(lab, ln, cells) for lab, ln, cells in groups(L, c4 - 45, c4) if len(cells) == 4]
t4b = [x for x in t4 if x[0] == "Boost"]
assert t4b, [x[0] for x in t4]
_, bl, bc = t4b[0]
print(f"  Boost 列：Table 1（第 {boost[1]} 行）GSM8K = {[c[0] for c in boost[2][:4]]}；附錄 Table 4（第 {bl} 行）= {[c[0] for c in bc]}")
iter1_t4 = [x for x in t4 if x[0] == "+RISE (default)"][0]
same_iter1 = [c[0] for c in iter1_t4[2]] == [c[0] for c in R["Llama2 Iter1"][2][:4]]
verdict("A3", same_iter1 and bc[2][0] != boost[2][2][0],
        f"附錄 Table 4 的 +RISE (default) 列與 Table 1 的 Iter1 逐格相同（對照組），但兩張表的 Boost 列 m1@t5 分別是 "
        f"{boost[2][2][0]} 與 {bc[2][0]}；論文沒說明兩者是否同一設定，本章「boosting 占 64%」用的是前者")

# ---------- B. Tyen et al. Table 5 ----------
print("\n== B. Tyen et al.（2311.08516）Table 5：weighted F1 對 naive 基準 78 ==")
L = load("2311.08516")
a = find_line(L, "### 3.3 Few-shot prompting for mistake location as a proxy for correctness")
b = find_line(L, "Table 5: Weighted average F1 scores")
TASKS = ["Word sorting", "Tracking shuffled objects", "Logical deduction", "Multistep arithmetic", "Dyck languages"]
MODELS = ["GPT-4-Turbo", "GPT-4", "GPT-3.5-Turbo", "Gemini Pro", "PaLM 2 Unicorn"]
toks = []
for i in range(a, b):
    s = L[i].strip()
    if not s or s == "|":
        continue
    toks.append((i + 1, s))
table, task, model = {}, None, None
for ln, s in toks:
    lab = s.lstrip("|").strip()
    if s.startswith("| ") and lab in TASKS:
        task = lab
        continue
    if s.startswith("| ") and lab in MODELS:
        model = lab
        table[(task, model)] = []
        continue
    if model and task and (re.fullmatch(r"\d+\.\d\d", s) or s == "–"):
        table[(task, model)].append((None if s == "–" else float(s), ln))
assert len(table) == 25 and all(len(v) == 3 for v in table.values()), {k: len(v) for k, v in table.items()}
base_line = find_line(L, "achieves a weighted F1 average of 78", b)
print(f"  naive 基準句在第 {base_line + 1} 行；85／15 組成在第 {find_line(L, '255 (85%) are incorrect') + 1} 行")
# 以 85／15 組成重算 naive 基準：全判 incorrect 時，incorrect 類 F1 = 2·0.85/(1+0.85)，correct 類 F1 = 0
f1_inc = 2 * 0.85 / (1 + 0.85)
naive = 0.85 * f1_inc * 100
print(f"  重算 naive 基準：0.85 × (2 × 0.85 ÷ 1.85) = {naive:.2f}，與論文的 78 相符")
counts = {}
for m in ("GPT-4", "GPT-4-Turbo", "GPT-3.5-Turbo", "Gemini Pro", "PaLM 2 Unicorn"):
    cells = [(t, v, ln) for t in TASKS for v, ln in table[(t, m)] if v is not None]
    above = [(t, v, ln) for t, v, ln in cells if v > 78]
    counts[m] = (len(above), len(cells))
    print(f"  {m}：{len(above)}／{len(cells)} 格高於 78" + (f"，例如 {above[0][0]} {above[0][1]}（第 {above[0][2]} 行）" if above else ""))
verdict("B1", counts["GPT-4"] == (10, 15) and counts["GPT-4-Turbo"] == (6, 10),
        "GPT-4 10／15、GPT-4-Turbo 6／10 高於 78，逐格證實；其他三個模型明顯較少，精讀筆記「對 GPT-4 家族是過度概括」成立")

# ---------- C. Self-Debugging Table 2 / Table 3 ----------
print("\n== C. Self-Debugging（2304.05128）Table 2(b)(c)、Table 3(b) ==")
L = load("2304.05128")
cap2 = find_line(L, "Table 2: Results of Self-Debugging with different feedback formats.")
tb = find_line(L, "(b) Results on TransCoder.", cap2)
tc = find_line(L, "(c) Results on MBPP.", tb)
te = find_line(L, "Next, we compare different feedback formats", tc)
hdr = [L[i].strip() for i in range(tb + 1, tb + 8) if L[i].strip()]
assert hdr[:5] == ["| TransCoder", "| Codex", "| GPT-3.5", "| GPT-4", "| StarCoder"], hdr
T = {lab: cells for lab, _, cells in groups(L, tb + 1, tc) if len(cells) == 4}
assert set(T) >= {"Baseline", "Simple", "UT", "+ Expl.", "+ Trace."}, list(T)
MOD = ["Codex", "GPT-3.5", "GPT-4", "StarCoder"]
claimed_share = {"Codex": 73.6, "GPT-3.5": 69.4, "GPT-4": 27.5, "StarCoder": 43.9}
ok_share = True
for k, m in enumerate(MOD):
    base, simple, full = T["Baseline"][k], T["Simple"][k], T["+ Expl."][k]
    best = max(T[r][k][0] for r in ("Simple", "UT", "+ Expl.", "+ Trace."))
    share = (simple[0] - base[0]) / (full[0] - base[0]) * 100
    ok = abs(share - claimed_share[m]) < 0.06 and full[0] == best
    ok_share &= ok
    print(f"  {m}：({simple[0]} − {base[0]}) ÷ ({full[0]} − {base[0]}) = {share:.1f}%（行 {simple[1]}、{base[1]}、{full[1]}）；"
          f"+Expl. 是否為四種回饋中最高：{full[0] == best}")
verdict("C1", ok_share, "四個比例的運算元都取自 TransCoder 表的 Baseline、Simple、+Expl. 三列，分母 +Expl. 在四個模型上都是最高的回饋格式")
Tm = {lab: cells for lab, _, cells in groups(L, tc + 1, te) if len(cells) == 4}
c3 = find_line(L, "Table 3: Results of Self-Debugging without unit test execution.")
tb3 = find_line(L, "(b) Results on MBPP", c3)
e3 = find_line(L, "By default, we leverage unit test execution", tb3)
T3 = {lab: cells for lab, _, cells in groups(L, tb3 + 1, e3) if len(cells) == 3}
print(f"  MBPP（有執行）Codex：Baseline {Tm['Baseline'][0][0]}（第 {Tm['Baseline'][0][1]} 行）→ Simple {Tm['Simple'][0][0]}（第 {Tm['Simple'][0][1]} 行）")
print(f"  MBPP（無執行）Codex：Baseline {T3['Baseline'][0][0]}（第 {T3['Baseline'][0][1]} 行）→ Simple {T3['Simple'][0][0]}（第 {T3['Simple'][0][1]} 行）")
verdict("C2", Tm["Simple"][0][0] == 68.2 and T3["Simple"][0][0] == 57.6 and Tm["Baseline"][0][0] == T3["Baseline"][0][0] == 61.4,
        "MBPP 的 61.4→68.2（Table 2(c)，可見測試給位元）與 61.4→57.6（Table 3(b)，模型自判對錯）分別取自兩張表的 Codex 欄")

from collections import Counter
cnt = Counter(label for _, label in verdicts)
by = {label: [t for t, l in verdicts if l == label] for label in cnt}
print(f"\n結論：{len(verdicts)} 個子主張中 " + "、".join(f"{n} 個{k}（{', '.join(by[k])}）" for k, n in cnt.items()) + "。")
if "無法判定" in by:
    print("  無法判定的子主張只能說「依本章讀法不吻合、無法定位」，不能說推翻作者。")
sys.exit(0 if cnt.get("不成立", 0) == 0 else 1)
