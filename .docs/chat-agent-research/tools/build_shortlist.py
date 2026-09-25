#!/usr/bin/env python3
"""開 W2 之前的閘門：把篩選結果套上仲裁、重排、做確定性檢查，全部通過才寫出最終名單。

用法：
  build_shortlist.py <篩選結果.json>            只檢查、印報告
  build_shortlist.py <篩選結果.json> --write    檢查全過才寫 data/shortlist.json 與 data/candidates/

篩選結果的格式（W1b workflow 的回傳值）：
  {"assignments": [{"id", "primary", "reason"}],
   "topics": [{"key", "main": [{"id", "subarea", "reason"}], "reserve": [...], "shortfall", "notes"}]}

檢查項目（任何一項不過就不寫檔，exit 1）：
  - 每篇都在該節點的候選池裡（數字才有來源）
  - ID 閘門重驗：arXiv 上存在，而且標題與池裡一致
  - 硬規則旗標：GATE-FAIL、RECENT-INELIGIBLE
  - 節點內不重複；跨節點重複的一定要有仲裁結果
  - 子領域名稱是 topics.json 裡定義的
  - 入選理由不空白、不過短、同一節點內不重複
  - 範圍證據（evidence）逐字出自該論文的 arXiv 摘要
數字（引用數、年份、venue）一律從候選池取，不採用 agent 回傳的任何數字。
"""

import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arxiv_tool as ax  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOPICS = json.load(open(os.path.join(ROOT, "data", "topics.json"), encoding="utf-8"))["topics"]
MAIN_TARGET = 24
FIELDS = ("title", "year", "citations", "influential", "cites_per_year", "venue", "top_venue", "flags", "adoption_evidence", "arxiv_comment")


def pool_of(t):
    return json.load(open(os.path.join(ROOT, "data", "pool", "%s-%s.json" % (t["nn"], t["slug"])), encoding="utf-8"))


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    res = json.load(open(sys.argv[1], encoding="utf-8"))
    write = "--write" in sys.argv
    errors, warnings = [], []
    assign = {ax.norm_id(a["id"]) or a["id"]: a for a in res.get("assignments", [])}
    by_key = {t["key"]: t for t in TOPICS}
    decided = {d["key"]: d for d in res["topics"]}

    missing_topics = [k for k in by_key if k not in decided]
    if missing_topics:
        errors.append("缺少節點的篩選結果：%s" % "、".join(missing_topics))

    # 先找出跨節點重複
    appears = collections.defaultdict(set)
    for k, d in decided.items():
        for p in d["main"] + d["reserve"]:
            appears[ax.norm_id(p["id"]) or p["id"]].add(k)
    for pid, ks in appears.items():
        if len(ks) > 1:
            a = assign.get(pid)
            if not a:
                errors.append("%s 同時在 %s，但沒有仲裁結果" % (pid, "、".join(sorted(ks))))
            elif a["primary"] not in ks:
                errors.append("%s 仲裁給了 %s，但它只出現在 %s" % (pid, a["primary"], "、".join(sorted(ks))))

    out = {"date": json.load(open(os.path.join(ROOT, "data", "topics.json"), encoding="utf-8"))["date"], "topics": {}, "cross_refs": []}
    for k, t in by_key.items():
        if k not in decided:
            continue
        d = decided[k]
        pool = {p["id"]: p for p in pool_of(t)["papers"]}
        names = {s["name"]: s["quota"] for s in t["subareas"]}
        seen, reasons, ordered = set(), collections.Counter(), []
        for tier in ("main", "reserve"):
            for p in d[tier]:
                pid = ax.norm_id(p["id"]) or p["id"]
                tag = "%s %s" % (k, pid)
                if pid in seen:
                    errors.append("%s：節點內重複" % tag)
                    continue
                seen.add(pid)
                a = assign.get(pid)
                if a and a["primary"] != k and len(appears[pid]) > 1:
                    out["cross_refs"].append({"id": pid, "primary": a["primary"], "also": k, "reason": a["reason"]})
                    continue
                row = pool.get(pid)
                if row is None:
                    errors.append("%s：不在候選池裡（數字沒有來源）" % tag)
                    continue
                hard = [f for f in row.get("flags", []) if f.isupper()]
                if hard:
                    errors.append("%s：硬規則旗標 %s（%s）" % (tag, ",".join(hard), row["title"][:60]))
                if p["subarea"] not in names:
                    errors.append("%s：子領域「%s」不在定義裡" % (tag, p["subarea"]))
                r = (p.get("reason") or "").strip()
                if len(r) < 10:
                    errors.append("%s：理由空白或過短" % tag)
                reasons[r] += 1
                ordered.append({"id": pid, "subarea": p["subarea"], "reason": r, "evidence": (p.get("evidence") or "").strip(), "from": tier, **{f: row.get(f) for f in FIELDS}})
        for r, n in reasons.items():
            if n > 1 and r:
                errors.append("%s：%d 篇用了同一句理由「%s」" % (k, n, r[:40]))
        # ID 閘門重驗（快取命中，不會打網路）
        entries = ax.resolve_ids([p["id"] for p in ordered])
        for p in ordered:
            e = entries.get(p["id"])
            if not e:
                errors.append("%s %s：arXiv 上找不到" % (k, p["id"]))
            elif ax.title_sim(e["title"], p["title"]) < 0.85:
                errors.append("%s %s：標題與 arXiv 不符（%s ≠ %s）" % (k, p["id"], p["title"][:40], e["title"][:40]))
            else:
                # 範圍證據必須逐字出自這篇的摘要：逼篩選者真的讀過摘要，也讓人工複核時一眼看得出它屬不屬於本節點
                ev = ax._norm_anchor(p["evidence"])
                if len(ev.split()) < 6 or ev not in ax._norm_anchor(e.get("abstract") or ""):
                    errors.append("%s %s：evidence 不在摘要裡或過短（%s）" % (k, p["id"], p["evidence"][:50]))
        main_list, reserve_list = ordered[:MAIN_TARGET], ordered[MAIN_TARGET:]
        for i, p in enumerate(main_list):
            p["rank"] = i + 1
        for i, p in enumerate(reserve_list):
            p["rank"] = i + 1
        sub = collections.Counter(p["subarea"] for p in main_list)
        for name, quota in names.items():
            if sub.get(name, 0) > quota:
                warnings.append("%s：子領域「%s」主選 %d 篇，超過上限 %d" % (k, name, sub[name], quota))
        if len(main_list) < 20:
            warnings.append("%s：主選只有 %d 篇（門檻 20）；候補 %d 篇。篩選者說：%s" % (k, len(main_list), len(reserve_list), d.get("shortfall", "")))
        years = collections.Counter(("≤2022" if (p["year"] or 0) <= 2022 else str(p["year"])) for p in main_list)
        print("%s 主選 %2d 候補 %2d｜%s｜%s" % (k, len(main_list), len(reserve_list), dict(sorted(years.items())), "；".join("%s %d/%d" % (n[:10], sub.get(n, 0), q) for n, q in names.items())))
        out["topics"][k] = {"name": t["name"], "main": main_list, "reserve": reserve_list, "shortfall": d.get("shortfall", ""), "curator_notes": d.get("notes", "")}

    for w in warnings:
        print("警告：" + w)
    for e in errors:
        print("錯誤：" + e)
    total = sum(len(v["main"]) for v in out["topics"].values())
    print("合計主選 %d 篇（不重複）；錯誤 %d；警告 %d" % (total, len(errors), len(warnings)))
    if errors:
        sys.exit(1)
    if write:
        with open(os.path.join(ROOT, "data", "shortlist.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
            f.write("\n")
        for k, t in by_key.items():
            if k not in out["topics"]:
                continue
            chosen = {p["id"]: ("main", p) for p in out["topics"][k]["main"]}
            chosen.update({p["id"]: ("reserve", p) for p in out["topics"][k]["reserve"]})
            moved = {c["id"]: c for c in out["cross_refs"] if c["also"] == k}
            papers = []
            for row in pool_of(t)["papers"]:
                rec = {f: row.get(f) for f in ("id",) + FIELDS}
                rec["sources"] = row.get("sources")
                if row["id"] in chosen:
                    dec, p = chosen[row["id"]]
                    rec.update(decision=dec, rank=p["rank"], subarea=p["subarea"], reason=p["reason"])
                elif row["id"] in moved:
                    rec.update(decision="moved", reason="主節點判給 %s：%s" % (moved[row["id"]]["primary"], moved[row["id"]]["reason"]))
                else:
                    hard = [f for f in row.get("flags", []) if f.isupper()]
                    rec.update(decision="rejected", reason=("程式硬規則：%s" % ",".join(hard)) if hard else "未入選（篩選者依範圍與影響力判斷）")
                papers.append(rec)
            path = os.path.join(ROOT, "data", "candidates", "%s-%s.json" % (t["nn"], t["slug"]))
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"topic": k, "papers": papers}, f, ensure_ascii=False, indent=2)
                f.write("\n")
        print("已寫出 data/shortlist.json 與 data/candidates/")


if __name__ == "__main__":
    main()
