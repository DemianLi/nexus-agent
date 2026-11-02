#!/usr/bin/env python3
"""精讀筆記的確定性檢查：重跑錨點比對、檢查欄位，依計數規則算出每個節點實際計入幾篇。

不信任閱讀 agent 自己回報的錨點數字 —— 這裡對 .cache/anchors/<id>.json 與快取全文重新比對一次。

計數規則（見 plan.md）：主節點是這個節點、read_level=full、value_verdict 不是 low、exact 錨點 ≥ 3，
而且其中至少 2 段落在全文 20% 之後（只錨在摘要與引言，驗證不了方法與實驗的主張）。

用法：
  check_notes.py            印出每個節點的計數與不合格原因
  check_notes.py --write    另外寫出 data/reading-status.json
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arxiv_tool as ax  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REQUIRED = (
    "id", "title", "topic", "subarea", "read_level", "one_liner", "problem", "core_idea", "method",
    "evaluation", "key_results", "limitations_stated", "limitations_observed", "framework_role",
    "adoption", "value_verdict", "verdict_reason",
)
MIN_ANCHORS = 3
MIN_DEEP = 2  # 至少 2 段 exact 錨點落在引言之後，才驗得到方法與實驗的主張


def check(note_path):
    note = json.load(open(note_path, encoding="utf-8"))
    pid = ax.norm_id(note.get("id", "")) or note.get("id")
    problems = [f"缺欄位 {f}" for f in REQUIRED if f not in note or note[f] in (None, "", [])]
    anchors_path = ax._path("anchors", ax._safe(pid) + ".json")
    exact = total = deep = 0
    if os.path.exists(anchors_path) and os.path.exists(ax._path("text", ax._safe(pid) + ".txt")):
        res = ax.cmd_anchors(argparse.Namespace(id=pid, snippets=[], file=anchors_path))
        exact, total, deep = res["pass"], res["total"], res["deep"]
    else:
        problems.append("沒有錨點檔或全文快取")
    info = ax._read_json(ax._path("text", ax._safe(pid) + ".json")) or {}
    level = info.get("level") or "unknown"
    if note.get("read_level") == "full" and level != "full":
        problems.append(f"筆記宣稱全文，但快取的層級是 {level}")
    counted = (
        level == "full"
        and note.get("read_level") == "full"
        and note.get("value_verdict") in ("high", "medium")
        and exact >= MIN_ANCHORS
        and deep >= MIN_DEEP
        and not [p for p in problems if p.startswith("缺欄位")]
    )
    return {
        "id": pid,
        "topic": note.get("topic"),
        "title": note.get("title"),
        "read_level": level,
        "value_verdict": note.get("value_verdict"),
        "anchors_exact": exact,
        "anchors_total": total,
        "anchors_deep": deep,
        "counted": counted,
        "problems": problems,
    }


def main():
    write = "--write" in sys.argv
    shortlist = json.load(open(os.path.join(ROOT, "data", "shortlist.json"), encoding="utf-8"))
    notes_dir = os.path.join(ROOT, "notes")
    results = {}
    for name in sorted(os.listdir(notes_dir)) if os.path.isdir(notes_dir) else []:
        if name.endswith(".json"):
            r = check(os.path.join(notes_dir, name))
            results[r["id"]] = r
    status = {"topics": {}}
    for key, t in shortlist["topics"].items():
        rows = []
        for tier in ("main", "reserve"):
            for p in t[tier]:
                r = results.get(p["id"])
                rows.append({"id": p["id"], "tier": tier, **(r or {"counted": False, "problems": ["尚未精讀"]})})
        n = sum(1 for r in rows if r["counted"])
        status["topics"][key] = {"counted": n, "papers": rows}
        read = [r for r in rows if "尚未精讀" not in r.get("problems", [])]
        print(f"{key}：計入 {n:2d}｜已讀 {len(read):2d}｜低價值 {sum(1 for r in read if r.get('value_verdict') == 'low')}｜非全文 {sum(1 for r in read if r.get('read_level') not in ('full', None))}｜錨點不足 {sum(1 for r in read if r.get('anchors_exact', 0) < MIN_ANCHORS or r.get('anchors_deep', 0) < MIN_DEEP)}")
        for r in read:
            if not r["counted"]:
                why = r["problems"] or []
                if r.get("value_verdict") == "low":
                    why = why + ["精讀後判為低價值"]
                if r.get("anchors_exact", 0) < MIN_ANCHORS or r.get("anchors_deep", 0) < MIN_DEEP:
                    why = why + [f"錨點 exact {r.get('anchors_exact', 0)}/{r.get('anchors_total', 0)}、深處 {r.get('anchors_deep', 0)}"]
                print(f"   不計入 {r['id']}（{r['tier']}）：{'；'.join(why)}")
    if write:
        with open(os.path.join(ROOT, "data", "reading-status.json"), "w", encoding="utf-8") as f:
            json.dump(status, f, ensure_ascii=False, indent=2)
            f.write("\n")


if __name__ == "__main__":
    main()
