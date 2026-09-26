#!/usr/bin/env python3
"""驗證：精讀時對大表自行做的彙總與比較（缺口 C14）。

這三條都是精讀 agent 自己算的平均或挑出的格子，章節直接引用；
check_chapter.py 只因筆記裡有這些數字就放行，沒有重算。

主張（章節 05-self-correction-reflection.md）：
  A. SotA 口徑段：RCI（2303.17491）Table 18 對 54 個有分數的任務做等權平均，
     純 gpt-3.5-turbo 的 Ours 約 0.906，低於 CC-Net (SL + RL) 的約 0.936；
     把 9 個任務換成 GPT-4 分數的「Ours (w/ GPT-4)」欄才到約 0.940。
  B. 陷阱五：SCORE（2404.17140）引言的「平均 14.6%」是 10 格相對增益的平均；
     Gemma 在 MATH 子集一格就有 44.6%，去掉這格後其餘 9 格平均約 11.2%；LLaMA 的絕對增益平均只有 +4.3 個百分點。
  C. 陷阱一：CRITIC（2305.11738）的 CRITIC∗ 在 LLaMA-2-7B、HotpotQA 上 EM 為 28.6，低於非 oracle 的 28.8；
     而且在 Table 8 三個 LLaMA 尺寸 × 六欄 = 18 組比較（每組是 CRITIC∗ 與 CRITIC 各一格，共 36 格）中，
     CRITIC∗ 較低的只有這一組。

輸入：全部由本程式從 .cache/text/<id>.txt 解析，以表題為錨點，對表頭、列名與格數做 assert，輸出附行號。

無隨機數，不需種子。只用標準函式庫。執行：python3 verify/05-aggregate-recalc.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXT = ROOT / ".cache" / "text"
verdicts = []


def load(pid):
    return (TEXT / f"{pid}.txt").read_text(encoding="utf-8").splitlines()


def find_line(lines, needle, start=0):
    hits = [i for i in range(start, len(lines)) if needle in lines[i]]
    assert hits, f"找不到含 {needle!r} 的行"
    return hits[0]


def verdict(tag, ok, text):
    verdicts.append((tag, ok))
    print(f"  [{tag}] {'證實' if ok else '不成立'}：{text}")


# ---------- A. RCI Table 18 ----------
print("== A. RCI（2303.17491）Table 18：54 個任務的等權平均 ==")
L = load("2303.17491")
cap = find_line(L, "Table 18: Comprehensive task-level success rate evaluation")
head = [i for i in range(cap, cap + 20) if L[i].strip() == "| TASK"][0]
# 表頭：接下來 10 個非分隔線的字串
hdr, k = [], head + 1
while len(hdr) < 10:
    s = L[k].strip()
    if s and s != "|":
        hdr.append(s)
    k += 1
EXP = ["Ours", "Ours (w/ GPT-4)", "WebN-T5-3B", "CC-Net (SL + RL)", "CC-Net (RL)", "CC-Net (SL)",
       "Others (SL + RL)", "SotA (SL)", "SotA (RL)", "SotA (SL + RL)"]
assert hdr == EXP, hdr
rows, cur = [], None
for i in range(k, len(L)):
    s = L[i].strip()
    if s.startswith("| ") and not re.fullmatch(r"\|\s*[\d.]+", s):
        name = s[2:].strip()
        if not re.fullmatch(r"[a-z0-9-]+", name):
            break  # 表格結束
        cur = [name, i + 1, []]
        rows.append(cur)
        continue
    if cur is not None:
        cur[2].append((s, i + 1))
parsed = []
for name, ln, toks in rows:
    cells, buf, started = [], None, False
    for s, l2 in toks:
        if s == "|":
            if started:
                cells.append(buf)
            started, buf = True, None
        elif s:
            buf = (s, l2)
    if started:
        cells.append(buf)
    assert len(cells) == 10, (name, ln, len(cells))
    parsed.append((name, ln, cells))


def val(c):
    return None if c is None or c[0] in ("n/a", "-") else float(c[0])


scored = [(n, ln, c) for n, ln, c in parsed if val(c[0]) is not None]
print(f"  Table 18 共 {len(parsed)} 個任務，其中 Ours 欄有分數的 {len(scored)} 個")
ours = [val(c[0]) for _, _, c in scored]
g4 = [val(c[1]) for _, _, c in scored]
cc = [val(c[3]) for _, _, c in scored]
assert None not in g4 and None not in cc, "54 個任務裡有 Ours (w/ GPT-4) 或 CC-Net (SL + RL) 缺值"
changed = [(n, val(c[0]), val(c[1])) for n, _, c in scored if val(c[0]) != val(c[1])]
mo, mg, mc = sum(ours) / len(ours), sum(g4) / len(g4), sum(cc) / len(cc)
print(f"  等權平均：Ours = {sum(ours):.2f} ÷ {len(ours)} = {mo:.4f}；CC-Net (SL + RL) = {sum(cc):.2f} ÷ {len(cc)} = {mc:.4f}；"
      f"Ours (w/ GPT-4) = {sum(g4):.2f} ÷ {len(g4)} = {mg:.4f}")
print(f"  兩欄不同的任務 {len(changed)} 個：{', '.join(f'{n} {a}→{b}' for n, a, b in changed)}")
verdict("A1", len(scored) == 54 and round(mo, 3) == 0.906 and round(mc, 3) == 0.936 and round(mg, 3) == 0.940 and len(changed) == 9,
        f"54 個任務、平均 {mo:.3f}／{mc:.3f}／{mg:.3f}、換成 GPT-4 分數的任務 {len(changed)} 個，精讀時的計算逐項證實")

# ---------- B. SCORE Table 6 ----------
print("\n== B. SCORE（2404.17140）Table 6：gpt-4 驗證器＋SCORE refiner 的相對增益 ==")
L = load("2404.17140")
cap = find_line(L, "Performance of SCORE models using LLaMA-2-13B-chat and Gemma-7B-it as base LM")
start = find_line(L, "| Verifier", cap - 400)
block = L[start:cap]
text = "\n".join(block)
DS = ["GSM8K", "GSM8K→MATH", "CSQA", "CSQA→QASC", "CSQA→RiddleSense"]
res = {}
for model, tag in (("LLaMA", "Base LM: LLaMA-2-13B-chat"), ("Gemma", "Base LM: Gemma-7B-it")):
    i0 = find_line(L, tag, start)
    # few-shot 初始答案那一列：「Initial answers by / few-shot prompting」之後的 10 格
    i1 = find_line(L, "few-shot prompting", i0)
    cells, k = [], i1 + 1
    while len(cells) < 10:
        s = L[k].strip().lstrip("|").strip()
        if s:
            cells.append((s, k + 1))
        k += 1
    base = [float(cells[j][0]) for j in (1, 3, 5, 7, 9)]
    assert all(cells[j][0] == "-" for j in (0, 2, 4, 6, 8)), cells
    # gpt-4 驗證器那一列（在 SCORE (fine-tuned) 區塊內）
    ig = find_line(L, "| gpt-4", find_line(L, "(fine-tuned)", i0))
    acc, k = [], ig + 1
    while len(acc) < 10:
        s = L[k].strip().lstrip("|").strip()
        if s:
            acc.append((s, k + 1))
        k += 1
    rows = []
    for j, d in enumerate(DS):
        s, ln = acc[2 * j + 1]
        m = re.match(r"([\d.]+)\s*\$\{\}_\{\\text\{([+-][\d.]+)\}\}\$", s)
        assert m, (s, ln)
        a, g = float(m.group(1)), float(m.group(2))
        assert abs(a - base[j] - g) < 0.051, (model, d, a, base[j], g)
        rows.append((d, base[j], a, g, g / base[j] * 100, ln))
    res[model] = rows
    for d, b0, a, g, rel, ln in rows:
        print(f"  {model} {d}：{b0} → {a}（第 {ln} 行），+{g}，相對 {g} ÷ {b0} = {rel:.2f}%")
rels = [r[4] for m in res for r in res[m]]
avg10 = sum(rels) / 10
gm = [r for r in res["Gemma"] if r[0] == "GSM8K→MATH"][0]
avg9 = (sum(rels) - gm[4]) / 9
llama_abs = sum(r[3] for r in res["LLaMA"]) / 5
print(f"  10 格相對增益平均 {sum(rels):.2f} ÷ 10 = {avg10:.2f}%；Gemma MATH 子集 {gm[4]:.2f}%；去掉後 9 格平均 {avg9:.2f}%")
print(f"  LLaMA 五格絕對增益平均 ({' + '.join(str(r[3]) for r in res['LLaMA'])}) ÷ 5 = {llama_abs:.2f}")
intro = find_line(L, "outperforms the original model by an average of 14.6%")
print(f"  引言原句在第 {intro + 1} 行")
verdict("B1", round(avg10, 1) == 14.6 and round(gm[4], 1) == 44.6 and round(avg9, 1) == 11.2 and round(llama_abs, 1) == 4.3,
        "「平均 14.6%」正是 10 格相對增益的平均；Gemma MATH 44.6%、其餘 9 格 11.2%、LLaMA 絕對增益平均 4.3，逐項證實")

# ---------- C. CRITIC Table 8 ----------
print("\n== C. CRITIC（2305.11738）Table 8：CRITIC∗（oracle）對 CRITIC ==")
L = load("2305.11738")
cap = find_line(L, "Table 8: LLaMA-2 Results of free-form question answering")  # 表題在表格上方
end = find_line(L, "Table 9: LLaMA-2 results of mathematical program synthesis", cap)
COLS = ["AmbigNQ EM", "AmbigNQ F1", "TriviaQA EM", "TriviaQA F1", "HotpotQA EM", "HotpotQA F1"]
blocks, cur_model, cur_row = {}, None, None
for i in range(cap, end):
    s = L[i].strip()
    lab = s.lstrip("|").strip()
    if s.startswith("|") and lab.startswith("LLaMA-2-"):
        if lab in blocks:
            break  # 表題在表格上方；再次遇到同一個尺寸，代表已進入下一張表（Table 9）
        cur_model = lab
        blocks[cur_model] = {}
        continue
    if cur_model is None:
        continue
    if s.startswith("| ") and not re.fullmatch(r"[\d.]+", lab):
        cur_row = lab
        blocks[cur_model][cur_row] = []
        continue
    if cur_row and re.fullmatch(r"\|\s*[\d.]+", s):
        blocks[cur_model][cur_row].append((float(lab), i + 1))
assert set(blocks) == {"LLaMA-2-7B", "LLaMA-2-13B", "LLaMA-2-70B"}, list(blocks)
lower = []
for m, rows in blocks.items():
    assert "CRITIC" in rows and "CRITIC∗" in rows, (m, list(rows))
    c, cs = rows["CRITIC"], rows["CRITIC∗"]
    assert len(c) == 6 and len(cs) == 6, (m, len(c), len(cs))
    for j, col in enumerate(COLS):
        if cs[j][0] < c[j][0]:
            lower.append((m, col, cs[j], c[j]))
    print(f"  {m}：CRITIC {[x[0] for x in c]}；CRITIC∗ {[x[0] for x in cs]}")
for m, col, a, b in lower:
    print(f"  CRITIC∗ 低於 CRITIC：{m} {col}：{a[0]}（第 {a[1]} 行）< {b[0]}（第 {b[1]} 行）")
n_cmp = len(blocks) * len(COLS)
verdict("C1", len(lower) == 1 and lower[0][0] == "LLaMA-2-7B" and lower[0][1] == "HotpotQA EM"
        and lower[0][2][0] == 28.6 and lower[0][3][0] == 28.8,
        f"28.6 < 28.8；{len(blocks)} 個尺寸 × {len(COLS)} 欄 = {n_cmp} 組比較（{2 * n_cmp} 格）中，CRITIC∗ 低於 CRITIC 的有 {len(lower)} 組"
        + ("，只有這一組" if len(lower) == 1 else "，不只這一組"))

ok = all(v for _, v in verdicts)
bad = [t for t, v in verdicts if not v]
print(f"\n結論：{len(verdicts)} 個子主張中 {sum(v for _, v in verdicts)} 個證實、{len(bad)} 個不成立（{', '.join(bad) or '無'}）；"
      f"CRITIC∗ 低於 CRITIC 的比較共 {len(lower)} 組（全部 {n_cmp} 組）。")
sys.exit(0 if ok else 1)
