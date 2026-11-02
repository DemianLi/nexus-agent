#!/usr/bin/env python3
"""驗證：2403.16416 的洩漏排除表裡，有多少格與「只移除成功對話」的規則矛盾。

主張（章節 06-user-simulator-feedback.md「表格與正文對不上的地方」與「爭議」兩節）：
  - 若只把受洩漏影響的成功對話移除、分母不變，recall 不可能上升；撰寫時逐格清點，
    recall 上升的格子 Table 1 有 6 格、Table 2 有 4 格。
  - -both 理應排除 -history 的超集合，卻有兩張表各 4 格的 -both 高於 -history。
  - 精讀時發現：論文沒寫洩漏怎麼判定（notes/2403.16416.json 的 limitations_observed 第 3 條）。
  - 章節引用的幾個數字：ReDial R@10 KBRD 0.229 勝 BARCOR 0.190，-both 後 0.143 對 0.187；
    ChatGPT ReDial R@10 0.539 → -both 0.271。
出處：[arXiv:2403.16416]。

輸入（全部由程式從 .cache/text/2403.16416.txt 解析，不手抄）：
  - 「Table 1. Performance of existing CRS methods」到「Figure 4」之間的表格。
  - 「Table 2. Performance of CRSs and ChatGPT under SimpleUserSim」到「Figure 6」之間的表格。
  - 全文中所有含 "leak" 的句子（表格列與參考文獻除外）。

表格在快取全文裡是一格一行：資料集名、模擬器名、12 個原始值；接著每個排除條件是
「模擬器名、(-history)」加 12 組「值、(±x%)」。欄順序為 KBRD、BARCOR、UniCRS、ChatGPT，
各三個 Recall@1／10／50。

方法：
  1. 解析兩張表，先用「值 ÷ 原始值 − 1」重算每格的百分比，與表上印的百分比比對（確認解析沒錯位）。
  2. 清點每張表中「排除後的值高於原始值」的格數，以及「-both 高於 -history」「-both 高於 -response」的格數。
  3. 印出章節引用的幾格。
  4. 把全文切成句子，列出所有含 "leak" 的句子，並標出含判定程序字眼的句子
     （detect、identif、determin、match、string、manual、annotat、label、judg、check、regex、
     classif、criteria、rule）。含字眼不代表有描述判定方式，需要人讀；列出來就是為了讓人讀。

只用標準函式庫；沒有隨機數。執行：python3 verify/06-crs-leak-cell-count.py（研究根目錄）
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = os.path.join(HERE, "..", ".cache", "text", "2403.16416.txt")
with open(TEXT, encoding="utf-8") as f:
    RAW = f.read()
LINES = RAW.split("\n")

MODELS = ["KBRD", "BARCOR", "UniCRS", "ChatGPT"]
METRICS = ["R@1", "R@10", "R@50"]
COLS = [(m, k) for m in MODELS for k in METRICS]
SCEN = ["-history", "-response", "-both"]
NUM = re.compile(r"^\d+\.\d+\*?$")
PCT = re.compile(r"^\(([+-]\d+(?:\.\d+)?)%\)$")


def find_line(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(LINES)):
        if rx.search(LINES[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def tokens(a, b):
    out = []
    for i in range(a, b):
        s = LINES[i].strip()
        if s.startswith("|"):
            t = s[1:].strip()
            if t:
                out.append((i + 1, t))
    return out


def parse_table(a, b):
    toks = tokens(a, b)
    data = {}
    i = 0
    ds = None
    while i < len(toks):
        _, t = toks[i]
        if t in ("ReDial", "OpenDialKG"):
            ds = t
            sim = toks[i + 1][1]
            vals = [float(toks[i + 2 + k][1].rstrip("*")) for k in range(12)]
            assert all(NUM.match(toks[i + 2 + k][1]) for k in range(12)), f"{ds} 原始列解析錯位"
            data[(ds, "base")] = dict(zip(COLS, vals))
            data[(ds, "sim")] = sim
            i += 14
            continue
        m = re.match(r"^\((-history|-response|-both)\)$", t)
        if m:
            sc = m.group(1)
            vals, pcts = [], []
            j = i + 1
            while len(vals) < 12:
                v = toks[j][1]
                p = toks[j + 1][1]
                assert NUM.match(v) and PCT.match(p), f"{ds} {sc} 第 {toks[j][0]} 行解析錯位：{v} {p}"
                vals.append(float(v.rstrip("*")))
                pcts.append(float(PCT.match(p).group(1)))
                j += 2
            data[(ds, sc)] = dict(zip(COLS, vals))
            data[(ds, sc + "%")] = dict(zip(COLS, pcts))
            i = j
            continue
        i += 1
    return data


t1a = find_line(r"^Table 1\. Performance of existing CRS")
t1b = find_line(r"^Figure 4\.", t1a)
t2a = find_line(r"^Table 2\. Performance of CRSs and ChatGPT under SimpleUserSim")
t2b = find_line(r"^Figure 6\.", t2a)
TABLES = {"Table 1（iEvaLM）": parse_table(t1a, t1b), "Table 2（SimpleUserSim）": parse_table(t2a, t2b)}
print(f"Table 1：第 {t1a + 1}–{t1b} 行；Table 2：第 {t2a + 1}–{t2b} 行")

summary = {}
for name, D in TABLES.items():
    print(f"\n=== {name} ===")
    worst = 0.0
    beyond = []
    up, both_gt_hist, both_gt_resp = [], [], []
    for ds in ("ReDial", "OpenDialKG"):
        base = D[(ds, "base")]
        for sc in SCEN:
            for c in COLS:
                v, b, p = D[(ds, sc)][c], base[c], D[(ds, sc + "%")][c]
                recompute = (v / b - 1) * 100 if b else 0.0
                worst = max(worst, abs(recompute - p))
                # 三位小數各有 ±0.0005 的捨入，百分比印到一位小數再有 ±0.05
                tol = 100 * (0.0005 / b + (v + 0.0005) * 0.0005 / (b * (b - 0.0005))) + 0.05 if b > 0.0005 else 1e9
                if abs(recompute - p) > tol:
                    beyond.append((ds, sc, c, b, v, p, recompute, tol))
                if v > b:
                    up.append((ds, sc, c, b, v, p))
        for c in COLS:
            if D[(ds, "-both")][c] > D[(ds, "-history")][c]:
                both_gt_hist.append((ds, c, D[(ds, "-history")][c], D[(ds, "-both")][c]))
            if D[(ds, "-both")][c] > D[(ds, "-response")][c]:
                both_gt_resp.append((ds, c, D[(ds, "-response")][c], D[(ds, "-both")][c]))
    print(f"解析檢查：以「值 ÷ 原始值 − 1」重算的百分比與表上印的百分比，最大差 {worst:.2f} 個百分點；"
          f"超出捨入容許範圍的格 {len(beyond)} 格")
    for ds, sc, (m, k), b, v, p, r, tol in beyond:
        print(f"  {ds:10s} {sc:9s} {m:7s} {k:4s} {b:.3f} → {v:.3f}：表上 {p:+.1f}%，重算 {r:+.2f}%（容許 ±{tol:.2f}），"
              "論文自己的數字互相對不上")
    print(f"排除後 recall 高於原始值的格：{len(up)} 格")
    for ds, sc, (m, k), b, v, p in up:
        print(f"  {ds:10s} {sc:9s} {m:7s} {k:4s} 原始 {b:.3f} → {v:.3f}（表上 {p:+.1f}%）")
    print(f"-both 高於 -history 的格：{len(both_gt_hist)} 格")
    for ds, (m, k), h, bo in both_gt_hist:
        print(f"  {ds:10s} {m:7s} {k:4s} -history {h:.3f} < -both {bo:.3f}")
    print(f"-both 高於 -response 的格：{len(both_gt_resp)} 格")
    for ds, (m, k), r, bo in both_gt_resp:
        print(f"  {ds:10s} {m:7s} {k:4s} -response {r:.3f} < -both {bo:.3f}")
    summary[name] = (len(up), len(both_gt_hist), len(both_gt_resp))

T1 = TABLES["Table 1（iEvaLM）"]
print("\n章節引用的幾格（Table 1，ReDial）：")
print(f"  R@10 原始：KBRD {T1[('ReDial', 'base')][('KBRD', 'R@10')]:.3f}、BARCOR {T1[('ReDial', 'base')][('BARCOR', 'R@10')]:.3f}")
print(f"  R@10 -both：KBRD {T1[('ReDial', '-both')][('KBRD', 'R@10')]:.3f}、BARCOR {T1[('ReDial', '-both')][('BARCOR', 'R@10')]:.3f}")
print(f"  ChatGPT R@10：原始 {T1[('ReDial', 'base')][('ChatGPT', 'R@10')]:.3f} → -both {T1[('ReDial', '-both')][('ChatGPT', 'R@10')]:.3f}")
print(f"  R@50 -both 的跌幅：" + "、".join(f"{m} {T1[('ReDial', '-both%')][(m, 'R@50')]:+.1f}%" for m in MODELS))

# ---- 全文中含 leak 的句子 ----
body_lines = []
for s in LINES:
    if s.startswith("[BIB]"):
        break
    if s.strip().startswith("|"):
        continue
    body_lines.append(s)
body = " ".join(body_lines)
sents = [x.strip() for x in re.split(r"(?<=[.!?])\s+", body) if re.search(r"leak", x, re.I)]
PROC = re.compile(r"detect|identif|determin|match|string|manual|annotat|label|judg|check|regex|classif|criteri|rule", re.I)
print(f"\n全文（不含表格列與參考文獻）含 leak 的句子共 {len(sents)} 句；標 * 的含判定程序字眼：")
flagged = 0
for k, s in enumerate(sents, 1):
    hit = PROC.search(s)
    flagged += bool(hit)
    print(f"  {'*' if hit else ' '}{k:2d}. {s[:230]}{'…' if len(s) > 230 else ''}")
print(f"含判定程序字眼的句子：{flagged} 句（逐句人讀的判讀寫在 verify/06-results.md）")

u1, h1, r1 = summary["Table 1（iEvaLM）"]
u2, h2, r2 = summary["Table 2（SimpleUserSim）"]
print(f"\n結論：recall 上升的格子 Table 1 {u1} 格、Table 2 {u2} 格；-both 高於 -history 的格子兩張表各 {h1}、{h2} 格，"
      "與「只移除成功對話、分母不變」的規則不相容，章節的清點證實；論文實際怎麼排除、怎麼判定洩漏，要看上列句子人工判讀。")
