#!/usr/bin/env python3
"""驗證：本章的範圍說明與跨節點計數（缺口 C1、C4／G23、G3，以及章節裡工具驗不了的計數列）。

主張（章節 05-self-correction-reflection.md，2026-10 針對性補讀三篇之後）：
  A. 「這一章回答什麼」：計入的 26 篇（✅）落在 arXiv 2022-06 到 2025-01；📖 那一篇是 2023-02；
     2024-09 之後的計入論文只有 DeepSeek-R1（2501.12948）一篇。
  B. 同一段：T5 候選池裡，候選池記錄年份在 2025 以後的候選多半被程式硬規則 RECENT-INELIGIBLE 擋掉，
     DeepSeek-R1（2501.12948）是唯一列為候補的，後來經針對性補讀有了精讀筆記；其餘四篇候補都沒有精讀筆記。
     另外，章內說 2024 年第四季的候選只有 2412.14959（標題與「未讀」照 gated 格式寫出）列為候補、其餘落選：這一句依 arXiv ID 的年月（2410–2412）判斷，
     不用候選池的 year 欄，因為 year 欄只到年份。
  C. 已知缺口：Tree of Thoughts（2305.10601）在 T5 候選池裡，落選理由是制式句「未入選（篩選者依範圍與影響力判斷）」，
     不是具體的範圍判斷；critic 點名的其他經典都不在任何節點的候選池裡。其中 Olausson et al.（2306.09896）與
     Stechly et al.（2402.08115）經針對性補讀有了筆記，其餘 9 篇（RAP、Self-Evaluation Guided Beam Search、Retroformer、
     Self-RAG、Self-Verification、Kambhampati 團隊另兩篇、P(True)、sycophancy）仍沒有筆記。
     引用 ToT 的筆記有 5 份（補讀的 2402.08115 是新增的那一份）。
  D. 「與其他節點的關係」：依全部精讀筆記的 edges 欄位，E2 標了 11 篇（T5 5、T2 4、T3 1、T8 1），
     E3 標了 48 篇（T5 18、T4 12、T3 11、T8 4、T7 2、T6 1），E5 標了 27 篇（T5 23、T8 3、T3 1）；
     三個總數與 .cache/work/w3/edge-E?.md 檔頭寫的篇數一致。

輸入：chapters/05-self-correction-reflection.md 的文獻表（程式產生的 bib 區塊）、data/candidates/*.json、data/pool/*.json、notes/*.json、
.cache/work/w3/edge-E2.md、edge-E3.md、edge-E5.md。
候選池的 year 欄是 Semantic Scholar 記錄的年份，不是 arXiv 年月；所以 A 用文獻表的「arXiv 年月」欄，B 只說「候選池記錄的年份」。

無隨機數，不需種子。只用標準函式庫。執行：python3 verify/05-scope-counts.py
"""
import glob
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
verdicts = []


def verdict(tag, ok, text):
    verdicts.append((tag, ok))
    print(f"  [{tag}] {'證實' if ok else '不成立'}：{text}")


# ---------- A. 時間窗 ----------
print("== A. 計入論文的 arXiv 時間窗（文獻表） ==")
chap = (ROOT / "chapters" / "05-self-correction-reflection.md").read_text(encoding="utf-8").splitlines()
b0 = chap.index("<!-- bib:begin -->")
b1 = chap.index("<!-- bib:end -->")
rows = []
for ln in range(b0, b1):
    m = re.match(r"\| (✅|📖|❌) \| \[([^\]]+)\]\([^)]*\) \| [^|]+ \| (\d{4}-\d{2}) \|", chap[ln])
    if m:
        rows.append((m.group(1), m.group(2), m.group(3), ln + 1))
counted = [r for r in rows if r[0] == "✅"]
other = [r for r in rows if r[0] != "✅"]
first = min(counted, key=lambda r: r[2])
last = max(counted, key=lambda r: r[2])
print(f"  文獻表 {len(rows)} 列：✅ {len(counted)}、其他 {len(other)}（{', '.join(f'{r[0]} {r[1]} {r[2]}' for r in other)}）")
print(f"  最早 {first[1]}（{first[2]}，第 {first[3]} 行）；最晚 {last[1]}（{last[2]}，第 {last[3]} 行）")
by_year = Counter(r[2][:4] for r in counted)
print(f"  逐年：{dict(sorted(by_year.items()))}")
verdict("A1", len(counted) == 26 and first[2] == "2022-06" and last[2] == "2025-01",
        f"計入 {len(counted)} 篇，時間窗 {first[2]} 到 {last[2]}")
after_sep = [r[1] for r in counted if r[2] > "2024-09"]
print(f"  2024-09 之後的計入論文：{after_sep}")
verdict("A2", after_sep == ["2501.12948"] and [r[2] for r in other] == ["2023-02"],
        "2024-09 之後只有 2501.12948 一篇；📖 那一篇是 2023-02")

# ---------- B. 2025 以後的候選 ----------
print("\n== B. T5 候選池中 2025 年以後的候選 ==")
cand = json.loads((ROOT / "data" / "candidates" / "05-self-correction-reflection.json").read_text(encoding="utf-8"))
papers = cand["papers"]
recent = [p for p in papers if p["year"] >= 2025]
reasons = Counter()
for p in recent:
    r = p["reason"]
    key = "RECENT-INELIGIBLE" if "RECENT-INELIGIBLE" in r else ("制式句" if r.startswith("未入選（篩選者依範圍與影響力判斷）") else r[:40])
    reasons[(p["decision"], key)] += 1
print(f"  候選 {len(papers)} 篇，候選池記錄年份 ≥ 2025 的 {len(recent)} 篇：")
for (dec, key), n in sorted(reasons.items(), key=lambda x: -x[1]):
    print(f"    {dec:9s} {key}：{n}")
reserve = [p for p in papers if p["decision"] == "reserve"]
print(f"  候補（reserve）{len(reserve)} 篇：{', '.join(p['id'] for p in reserve)}")
no_note = [p["id"] for p in reserve if not (ROOT / "notes" / (p["id"].replace('/', '_') + ".json")).exists()]
recent_main = [p["id"] for p in recent if p["decision"] == "main"]
r1 = [p for p in papers if p["id"] == "2501.12948"][0]
verdict("B1", reasons[("rejected", "RECENT-INELIGIBLE")] > len(recent) / 2 and not recent_main and r1["decision"] == "reserve",
        f"{len(recent)} 篇中 {reasons[('rejected', 'RECENT-INELIGIBLE')]} 篇被 RECENT-INELIGIBLE 擋掉，"
        f"{reasons[('rejected', '制式句')]} 篇以制式句落選，沒有一篇入選；R1 是其中唯一的候補")
has_note = [p["id"] for p in reserve if p["id"] not in no_note]
verdict("B2", len(reserve) == 5 and has_note == ["2501.12948"] and len(no_note) == 4,
        f"五篇候補中只有 R1 有精讀筆記（{', '.join(has_note)}），其餘 {len(no_note)} 篇沒有：{', '.join(no_note)}")
q4 = [p for p in papers if re.fullmatch(r"24(10|11|12)\.\d{4,5}", p["id"])]
q4_dec = Counter(p["decision"] for p in q4)
q4_boiler = [p for p in q4 if p["decision"] == "rejected" and p["reason"].startswith("未入選（篩選者依範圍與影響力判斷）")]
print(f"  arXiv ID 為 2410–2412 的候選 {len(q4)} 篇：{dict(q4_dec)}；其中以制式句落選 {len(q4_boiler)} 篇")
for p in q4:
    print(f"    {p['id']}  {p['decision']:9s} {p['reason'][:30]}")
verdict("B3", q4_dec.get("main", 0) == 0 and [p["id"] for p in q4 if p["decision"] == "reserve"] == ["2412.14959"]
        and q4_dec.get("rejected", 0) == len(q4) - 1,
        f"2024 年第四季（arXiv 2410–2412）的候選 {len(q4)} 篇沒有一篇入選；2412.14959 是唯一的候補，"
        f"其餘 {q4_dec.get('rejected', 0)} 篇落選（{len(q4_boiler)} 篇是制式句）")

# ---------- C. critic 點名的經典 ----------
print("\n== C. critic 點名的經典在不在候選池 ==")
tot = [p for p in papers if p["id"] == "2305.10601"][0]
print(f"  ToT 在 T5 候選池：decision = {tot['decision']}，reason = {tot['reason']}")
verdict("C1", tot["decision"] == "rejected" and tot["reason"].startswith("未入選（篩選者依範圍與影響力判斷）"),
        "ToT 的落選理由是制式句，不是具體說明它「不屬於本節點」")
pools = {}
for f in glob.glob(str(ROOT / "data" / "candidates" / "*.json")) + glob.glob(str(ROOT / "data" / "pool" / "*.json")):
    pools[f] = Path(f).read_text(encoding="utf-8")
named = ["2305.14992", "2305.00633", "2308.02151", "2310.11511", "2212.09561", "2306.09896",
         "2310.08118", "2310.12397", "2402.08115", "2207.05221", "2310.13548"]
targeted = ["2306.09896", "2402.08115"]  # 針對性補讀，有筆記但從沒進過候選池
absent, pooled, noted = [], [], []
for i in named:
    in_pool = [Path(f).parent.name + "/" + Path(f).name for f, s in pools.items() if f'"{i}"' in s]
    has_note = (ROOT / "notes" / f"{i}.json").exists()
    print(f"  {i}：候選池 {in_pool or '無'}；筆記 {'有' if has_note else '無'}")
    if in_pool:
        pooled.append(i)
    if has_note:
        noted.append(i)
    if not in_pool and not has_note:
        absent.append(i)
verdict("C2", not pooled and noted == targeted and len(absent) == len(named) - len(targeted),
        f"{len(named)} 篇都不在任何節點的候選池；其中 {'、'.join(noted)} 經補讀有筆記，其餘 {len(absent)} 篇沒有筆記")
cites = defaultdict(list)
for f in sorted(glob.glob(str(ROOT / "notes" / "*.json"))):
    s = Path(f).read_text(encoding="utf-8")
    for i in ("2305.10601", "2207.05221", "2310.13548"):
        if i in s:
            cites[i].append(Path(f).stem)
for i, fs in cites.items():
    print(f"  引用 {i} 的筆記 {len(fs)} 份：{', '.join(fs)}")
verdict("C3", len(cites["2305.10601"]) == 5 and "2402.08115" in cites["2305.10601"]
        and len(cites["2207.05221"]) == 5 and len(cites["2310.13548"]) == 2,
        "筆記引用數：ToT 5（全域 critic 當時數到 4，補讀的 2402.08115 是第 5 份）、P(True) 5、sycophancy 2")

# ---------- D. 邊的篇數 ----------
print("\n== D. 依筆記 edges 欄位計數 ==")
cnt = defaultdict(Counter)
for f in glob.glob(str(ROOT / "notes" / "*.json")):
    d = json.loads(Path(f).read_text(encoding="utf-8"))
    for e in {x.get("edge") for x in d.get("edges", [])}:
        cnt[e][d["topic"]] += 1
claim = {"E2": {"T5": 5, "T2": 4, "T3": 1, "T8": 1},
         "E3": {"T5": 18, "T4": 12, "T3": 11, "T8": 4, "T7": 2, "T6": 1},
         "E5": {"T5": 23, "T8": 3, "T3": 1}}
ok = True
ok2 = True
for e in ("E2", "E3", "E5"):
    got = dict(cnt[e])
    head = (ROOT / ".cache" / "work" / "w3" / f"edge-{e}.md").read_text(encoding="utf-8")
    m = re.search(r"標了這條邊的筆記：(\d+) 篇", head)
    n_file = int(m.group(1)) if m else -1
    print(f"  {e}：共 {sum(got.values())} 篇，{got}；edge-{e}.md 檔頭 {n_file} 篇")
    ok &= got == claim[e]
    ok2 &= n_file == sum(got.values())
verdict("D1", ok, "三條邊的逐節點篇數與章節一致（E2 11、E3 48、E5 27）")
verdict("D2", ok2, "三個總數與 .cache/work/w3/edge-E?.md 檔頭一致")

allok = all(v for _, v in verdicts)
print(f"\n結論：{sum(v for _, v in verdicts)}/{len(verdicts)} 項證實；計入論文的時間窗是 {first[2]} 到 {last[2]}，"
      f"2024-09 之後只有候補 R1 經補讀計入；2025 年以後的 T5 候選沒有一篇入選（{reasons[('rejected', 'RECENT-INELIGIBLE')]} 篇被硬規則擋掉）。")
sys.exit(0 if allok else 1)
