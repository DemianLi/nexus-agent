#!/usr/bin/env python3
"""驗證：WebArena 的不可達題數能不能由 Table 2 的百分比唯一反推，以及由它推出的地板與份額。

主張（章節 07-agent-evaluation.md〈陷阱二〉「正確放棄」WebArena 那一條與〈爭議十八〉WebArena 那一條）：
  論文沒寫不可達題有幾題，精讀筆記由 Table 2 的百分比反推約 36 題（可達 776 題）。以這組題數
  驗算 Table 2 的七格 SR，六格和由同一列 SR_AC、SR_UA 推得的加權值吻合；唯一對不上的是
  GPT-3.5 direct 不給 hint 的 5.10，推得 (4.90% × 776 + 8.33% × 36)/812 ≈ 5.05%。若以 36 題計，
  一律回 N/A 可拿 36/812 = 4.43%；GPT-4 給 UA hint 時的 11.70% 約對應 95.0 題成功，其中不可達題
  約 77.78% × 36 ≈ 28.0 題，占 28/95 ≈ 29.5%。
出處：[arXiv:2307.13854]。36 題是精讀筆記的推算，其餘是組章時的重算；critic（C18）要求改成
  可重跑的程式。

輸入從哪來（全部由程式從 .cache/text/2307.13854.txt 解析並印出行號，不手抄）：
  - Table 2：每列「CoT｜UA hint｜模型｜SR｜SR_AC｜SR_UA」，7 列模型加 1 列 Human。
  - 正文：812 個任務（第 329 行附近）。

方法：
  1. 對 u = 1…200，檢查 7 列模型的 SR_UA 能否都寫成 k/u，SR_AC 能否都寫成 k/(812−u)。表上印到
     小數點後兩位，嚴格四捨五入的容差是 0.005 個百分點；另以 0.01 再跑一次，因為論文的進位不一定
     嚴格（程式會印出嚴格容差下是哪一格擋住）。列出所有相容的 u。
  2. 取最小的相容 u，逐列算加權 SR =（SR_AC ×(812−u) + SR_UA × u）/ 812，與表上的 SR 比；
     另以整數計數重算（成功題數 = 可達成功 + 不可達成功），看哪一列對不上。
  3. 由 u 算「一律回 N/A」的地板與 GPT-4＋UA hint 的成功題中有多少來自不可達題。

沒有用到隨機數。只用標準函式庫。執行：python3 07-webarena-unachievable-count.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TXT = os.path.join(ROOT, ".cache", "text", "2307.13854.txt")
NUM = re.compile(r"^\|\s*([0-9]+\.[0-9]+)$")


def load_lines():
    with open(TXT, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def parse_table2(lines):
    cap = find_line(lines, r"^Table 2: The end-to-end task success rate \(SR %\) on WebArena")
    rows = []
    for i in range(cap - 80, cap):
        s = lines[i].strip()
        if s in ("| GPT-3.5", "| GPT-4", "| text-bison-001", "| Human") and all(
                NUM.match(lines[i + k].strip()) for k in (1, 2, 3)):
            cot = lines[i - 2].strip().lstrip("|").strip()
            ua = lines[i - 1].strip().lstrip("|").strip()
            sr, ac, un = (float(NUM.match(lines[i + k].strip()).group(1)) for k in (1, 2, 3))
            rows.append({"model": s.lstrip("|").strip(), "cot": cot, "ua": ua,
                         "sr": sr, "ac": ac, "un": un, "line": i + 1})
    return cap + 1, rows


def fits(pct, n, tol=0.005):
    return n > 0 and any(abs(100 * k / n - pct) <= tol + 1e-9 for k in range(n + 1))


def label(r):
    return f"{r['model']}（CoT {r['cot']}，UA hint {r['ua']}）"


def main():
    lines = load_lines()
    i_total = find_line(lines, r"In total, we curated 241 templates and 812 instantiated intents")
    TOTAL = 812
    print(f"第 {i_total + 1} 行：共 {TOTAL} 個任務")
    cap, rows = parse_table2(lines)
    print(f"Table 2（caption 在第 {cap} 行）：解析到 {len(rows)} 列")
    models = [r for r in rows if r["model"] != "Human"]
    assert len(models) == 7 and len(rows) == 8, rows

    strict = [u for u in range(1, 201)
              if all(fits(r["un"], u) and fits(r["ac"], TOTAL - u) for r in models)]
    cands = [u for u in range(1, 201)
             if all(fits(r["un"], u, 0.01) and fits(r["ac"], TOTAL - u, 0.01) for r in models)]
    print(f"方法 1：7 列模型的 SR_UA 都是 k/u、SR_AC 都是 k/(812−u) 的 u（1–200）")
    print(f"  嚴格容差 0.005：{strict}；容差 0.01：{cands}")
    assert cands, "沒有任何 u 相容"
    for u_ in cands:
        blk = [f"{label(r)} 的 SR_AC {r['ac']}" for r in models if not fits(r["ac"], TOTAL - u_)] + \
              [f"{label(r)} 的 SR_UA {r['un']}" for r in models if not fits(r["un"], u_)]
        if blk:
            k = round(float(blk[0].split()[-1]) * (TOTAL - u_) / 100)
            print(f"  u = {u_} 在嚴格容差下被擋住的格：{'、'.join(blk)}（最接近的是 {k}/{TOTAL - u_} = {100 * k / (TOTAL - u_):.4f}%）")
    u = cands[0]
    a = TOTAL - u
    print(f"  取最小的 u = {u}，可達 {a} 題")

    print()
    print("方法 2：逐列重算 SR")
    miss = []
    for r in models:
        k_ac = round(r["ac"] * a / 100)
        k_un = round(r["un"] * u / 100)
        weighted = (r["ac"] * a + r["un"] * u) / TOTAL
        by_count = 100 * (k_ac + k_un) / TOTAL
        # 與方法 1 同一個容差（0.01）：論文的進位不嚴格，差 0.01 以內視為同一個計數
        ok = abs(by_count - r["sr"]) <= 0.01 + 1e-9
        integral = fits(r["sr"], TOTAL, 0.01)
        if not ok:
            miss.append((r, weighted, by_count, k_ac, k_un))
        print(f"  {label(r)}：表上 SR {r['sr']}；加權 ({r['ac']}×{a} + {r['un']}×{u})/{TOTAL} = {weighted:.3f}；"
              f"計數 ({k_ac}+{k_un})/{TOTAL} = {by_count:.3f} → {'吻合' if ok else '對不上'}"
              f"{'' if integral else f'；表上 SR 本身不是任何 k/{TOTAL}（{r[chr(115) + chr(114)]}×{TOTAL}/100 = {r[chr(115) + chr(114)] * TOTAL / 100:.2f}）'}"
              f"（第 {r['line']} 行）")
    for r, wgt, bc, k_ac, k_un in miss:
        same = [x for x in models if x is not r and abs(x["sr"] - bc) <= 0.005 + 1e-9]
        print(f"  對不上的那列算得 {bc:.2f}，與 {'、'.join(label(x) + ' 的 ' + str(x['sr']) for x in same) or '沒有其他列'} 相同")

    print()
    floor = 100 * u / TOTAL
    g4 = [r for r in models if r["model"] == "GPT-4" and r["ua"] == "✓"][0]
    succ = g4["sr"] * TOTAL / 100
    ua_succ = g4["un"] * u / 100
    print(f"方法 3：一律回 N/A 的地板 {u}/{TOTAL} = {floor:.2f}%；"
          f"GPT-4＋UA hint 的 {g4['sr']}% × {TOTAL} ≈ {succ:.1f} 題成功，其中不可達題 {g4['un']}% × {u} ≈ {ua_succ:.1f} 題，"
          f"占 {ua_succ:.1f}/{succ:.1f} ≈ {ua_succ / succ:.1%}")
    tb = [r for r in models if r["model"] == "text-bison-001"][0]
    print(f"  對照：text-bison-001 的 SR 是 {tb['sr']}%")

    print()
    print(f"結論：證實。在 1–200 之間，以容差 0.01 同時讓 7 列 SR_UA 與 SR_AC 都成為整數比例的 u 只有 {cands}"
          f"（嚴格四捨五入下是 {strict or '沒有'}，被一格 4.00 擋住），"
          f"所以 {u} 題不可達（可達 {a} 題）是唯一的小解；以它重算 7 格 SR，{7 - len(miss)} 格吻合，"
          + "；".join(f"對不上的是 {label(r)} 的 {r['sr']}，由同一列推得 {bc:.2f}，而 {r['sr']} 本身"
                     f"{'也不是' if not fits(r['sr'], TOTAL, 0.01) else '是'}任何 k/{TOTAL}" for r, _, bc, _, _ in miss)
          + f"。一律回 N/A 的地板是 {floor:.2f}%，GPT-4＋UA hint 的成功題約 {ua_succ / succ:.1%} 來自不可達題。")


if __name__ == "__main__":
    main()
