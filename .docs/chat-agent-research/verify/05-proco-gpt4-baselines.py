#!/usr/bin/env python3
"""驗證：ProCo Table 4 的 GPT-4 基準六格與 Huang et al. Table 3 逐格相同，但兩篇宣稱的設定不同；
ProCo 自己的 97.6、86.7 放不進 200 題的格點。

主張（章節 05-self-correction-reflection.md 第 416 行）：
  ProCo Table 4 的 CoT 95.5／82.0／49.0、Self-Correct 91.5／79.5／49.0，與 Huang et al. Table 3 的
  GPT-4 Standard Prompting 及 Self-Correct round 1 逐格相同。Huang 用 2023/08/29 存取的 GPT-4、溫度 1、
  每個資料集抽 200 題（HotpotQA 100 題）；ProCo 用 GPT-4-0125-Preview、溫度 0.7。
  97.6×2=195.2、86.7×2=173.4 不是整數，放不進 200 題的格點。
出處：[arXiv:2405.14092] 精讀筆記 notes/2405.14092.json 的 limitations_observed 第 1 條；
      比對對象 [arXiv:2310.01798] Table 3。

輸入從哪來：
  - ProCo Table 4：由本程式從 .cache/text/2405.14092.txt 解析，錨點是表題
    「Table 4: Performance comparison of various baseline methods using GPT-4-0125-Preview」，
    該表不是 pipe 格式，每格一行、以空行分隔；CoVe 的 GSM8K 是「-」。
  - Huang Table 3：由本程式從 .cache/text/2310.01798.txt 解析。這份檔的表題在表格「上方」
    （「Table 3: Results of GPT-3.5 and GPT-4 on reasoning benchmarks with intrinsic self-correction.」），
    所以從表題往下讀到「### 3.2 Results」為止；每列第一個數字是 # calls（1／3／5），要跳過。
  - 設定（模型版本、存取日期、溫度、抽樣題數）：直接從兩份全文 grep 原句並印出行號。

200 題格點的前提：單次執行、n=200、準確率四捨五入到一位小數。那麼可出現的值只有 0.5 的倍數。
  若 ProCo 的數字是多次執行的平均，格點會變，本論證就不適用；ProCo 全文沒寫評估題數，
  所以「分母不同」只是推論。HotpotQA 在 Huang 那邊是 100 題、三格都是整數，不適用這個論證。
  另外列舉 n=1..2000 中哪些 n 能產生 97.6 與 86.7，只用來確認 200 不在其中；不引入任何快取外的資料集大小。

無隨機數，不需種子。只用標準函式庫。執行：python3 05-proco-gpt4-baselines.py
"""

import re
import sys
from fractions import Fraction
from pathlib import Path

CACHE = Path(__file__).resolve().parent.parent / ".cache" / "text"
PROCO = CACHE / "2405.14092.txt"
HUANG = CACHE / "2310.01798.txt"
DATASETS = ["GSM8K", "CSQA", "HotpotQA"]


def parse_proco(lines):
    cap = [i for i, l in enumerate(lines)
           if l.startswith("Table 4: Performance comparison of various baseline methods using GPT-4-0125-Preview")]
    assert len(cap) == 1, f"ProCo Table 4 表題應恰好一次，實際 {len(cap)}"
    cap = cap[0]
    start = None
    for i in range(cap - 1, -1, -1):
        if lines[i].strip() == "Method":
            start = i
            break
    assert start is not None
    toks = [(i + 1, lines[i].strip()) for i in range(start, cap) if lines[i].strip()]
    assert [t for _, t in toks[:7]] == ["Method", "GSM8K", "CSQA", "HotpotQA", "Accuracy", "Accuracy", "EM"], toks[:7]
    body = toks[7:]
    rows = {}
    k = 0
    while k < len(body):
        ln, name = body[k]
        vals = body[k + 1:k + 4]
        for vln, v in vals:
            assert v == "-" or re.fullmatch(r"\d+\.\d", v), f"第 {vln} 行不是數字：{v!r}"
        rows[name] = [(None if v == "-" else float(v), vln) for vln, v in vals]
        k += 4
    assert list(rows) == ["CoT", "Self-Correct", "CoVe", "ProCo"], list(rows)
    return cap + 1, rows


def parse_huang(lines):
    cap = [i for i, l in enumerate(lines)
           if l.startswith("Table 3: Results of GPT-3.5 and GPT-4 on reasoning benchmarks with intrinsic self-correction")]
    assert len(cap) == 1, f"Huang Table 3 表題應恰好一次，實際 {len(cap)}"
    cap = cap[0]
    end = next(i for i in range(cap, len(lines)) if lines[i].startswith("### 3.2 Results"))
    block = "\n".join(lines[cap:end])
    assert "Self-Correct (round 1)" in block and "# calls" in block, "Table 3 區塊內容不對（可能抓到 Table 2）"
    groups, cur = [], []
    for i in range(cap + 1, end):
        s = lines[i].strip()
        if not s:
            if cur:
                groups.append(cur)
                cur = []
            continue
        cur.append((i + 1, s.lstrip("|").strip()))
    if cur:
        groups.append(cur)
    header = [c for _, c in groups[0]]
    assert header == ["", "", "# calls", "GSM8K", "CommonSenseQA", "HotpotQA"], header
    rows, model = {}, None
    for g in groups[1:]:
        cells = list(g)
        if not re.fullmatch(r"[\d.]+", cells[1][1]):  # 第一格是模型名
            model = cells[0][1]
            cells = cells[1:]
        method = cells[0][1]
        calls = int(cells[1][1])
        vals = [(float(v), ln) for ln, v in cells[2:5]]
        assert len(vals) == 3
        rows[(model, method)] = dict(calls=calls, vals=vals)
    return cap + 1, rows


def grid_ns(x, nmax=2000):
    """列出 1..nmax 中能讓某個整數 k 使 100k/n 四捨五入到一位小數等於 x 的 n（邊界採閉區間，偏寬鬆）。"""
    X = Fraction(str(x))
    lo, hi = X - Fraction(1, 20), X + Fraction(1, 20)
    out = []
    for n in range(1, nmax + 1):
        # 需要 lo <= 100k/n <= hi → k 在 [lo*n/100, hi*n/100]
        kmin = -(-(lo * n) // 100)  # ceil
        if kmin * 100 <= hi * n:
            out.append(n)
    return out


def main():
    pl = PROCO.read_text(encoding="utf-8").splitlines()
    hl = HUANG.read_text(encoding="utf-8").splitlines()
    print(f"來源：{PROCO}\n      {HUANG}")

    pcap, prow = parse_proco(pl)
    hcap, hrow = parse_huang(hl)
    print(f"  ProCo Table 4 表題在第 {pcap} 行；Huang Table 3 表題在第 {hcap} 行（表在表題下方）")

    print("\n=== 逐格比對 ===")
    pairs = [("CoT", ("GPT-4", "Standard Prompting")), ("Self-Correct", ("GPT-4", "Self-Correct (round 1)"))]
    same = 0
    for pm, hk in pairs:
        h = hrow[hk]
        for d in range(3):
            pv, pln = prow[pm][d]
            hv, hln = h["vals"][d]
            eq = pv == hv
            same += eq
            print(f"  {DATASETS[d]:<9} ProCo {pm:<13}{pv:>5}（第 {pln} 行）  Huang {hk[0]} {hk[1]:<23}{hv:>5}（第 {hln} 行）  "
                  f"{'相同' if eq else '不同'}")
    print(f"  六格中相同的格數：{same}/6")
    print("  （對照：Huang 的 GPT-4 Self-Correct round 2 為 "
          f"{[v for v, _ in hrow[('GPT-4', 'Self-Correct (round 2)')]['vals']]}，GPT-3.5 Standard 為 "
          f"{[v for v, _ in hrow[('GPT-3.5', 'Standard Prompting')]['vals']]}，都與 ProCo 不同，表示不是整張表都撞在一起）")

    print("\n=== 兩篇宣稱的設定（原句片段；換行併成空白後比對）===")
    settings_ok = True
    for name, lines, pats in (
        ("Huang 2310.01798", hl, [r"GPT-4 accessed on 2023/08/29",
                                  r"randomly sample 200 questions for each dataset \(100 for HotpotQA\)",
                                  r"temperature of 1\s+for GPT-3\.5-Turbo and GPT-4"]),
        ("ProCo 2405.14092", pl, [r"GPT-4-0125-Preview",
                                  r"temperature parameter is set to \$0\.7\$"])):
        joined, starts, pos = [], [], 0
        for l in lines:
            starts.append(pos)
            joined.append(l)
            pos += len(l) + 1
        text = " ".join(joined)
        for pat in pats:
            m = re.search(pat, text)
            if not m:
                settings_ok = False
                print(f"  {name}：找不到「{pat}」")
                continue
            ln = max(i for i, s in enumerate(starts) if s <= m.start()) + 1
            a, b = max(0, m.start() - 60), min(len(text), m.end() + 20)
            print(f"  {name} 第 {ln} 行起：…{text[a:b]}…")
    all_temp = [i + 1 for i, l in enumerate(pl) if re.search(r"[Tt]emperature", l)]
    print(f"  ProCo 全文出現 temperature 的行：{all_temp}（只有一處，沒有替基準另設溫度）")
    huang_mentions = [i + 1 for i, l in enumerate(pl) if "Huang et al." in l]
    print(f"  ProCo 全文提到「Huang et al.」的行：{huang_mentions}（逐行看過，沒有一行說 Table 4 的基準取自 Huang）")
    for ln in huang_mentions:
        print(f"    第 {ln} 行：{pl[ln - 1].strip()[:150]}")

    print("\n=== 200 題格點（前提：單次、n=200、一位小數）===")
    for m in ("CoT", "Self-Correct", "CoVe", "ProCo"):
        for d in range(2):  # 只看 GSM8K、CSQA；HotpotQA 在 Huang 是 100 題
            v, ln = prow[m][d]
            if v is None:
                continue
            twice = Fraction(str(v)) * 2
            print(f"  {m:<13}{DATASETS[d]:<7}{v:>5} × 2 = {float(twice):>6.1f}  → {'整數，放得進 200 題格點' if twice.denominator == 1 else '不是整數，放不進 200 題格點'}")
    print("  HotpotQA 各格：" + "、".join(f"{m} {prow[m][2][0]}" for m in prow) + "（全是整數，與 100 題相容，不適用此論證）")

    for v in (97.6, 86.7):
        ns = grid_ns(v)
        print(f"  能產生 {v} 的 n（1..2000）：共 {len(ns)} 個，最小幾個 {ns[:8]}；200 在其中？{'是' if 200 in ns else '否'}")

    print("\n=== 結論 ===")
    print(f"子主張 3a（六格逐格相同）：{'證實' if same == 6 else '推翻'}（{same}/6）")
    print("子主張 3b（設定不同：Huang 2023/08/29 的 GPT-4、溫度 1、200 題／HotpotQA 100 題；ProCo GPT-4-0125-Preview、溫度 0.7）："
          f"{'證實（五句原文都找到）' if settings_ok else '無法判定（有原句沒找到）'}")
    ok_grid = all((Fraction(str(v)) * 2).denominator != 1 for v in (97.6, 86.7)) and 200 not in grid_ns(97.6) and 200 not in grid_ns(86.7)
    print(f"子主張 3c（97.6、86.7 乘 2 不是整數、放不進 200 題格點）：{'證實（算術）' if ok_grid else '推翻'}")
    print("子主張 3d（因此 ProCo 與基準的評估分母不同）：推論，無法判定。ProCo 沒寫評估題數，也沒寫是不是多次平均。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
