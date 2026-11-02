#!/usr/bin/env python3
"""候選池：把發現階段的候選合併、補上經典名單、從快取接上數字、用程式套硬規則。

W1 的教訓：篩選 agent 轉抄的數字不可信（整欄 influential 被寫成 0），寫在 prompt 散文裡的
規則也沒人擋。所以這支程式負責所有確定性的事：數字一律從 S2／arXiv 快取取，規則一律在這裡判。
agent 只看 `table` 印出的表，只做範圍與品質的判斷。

子命令：
  extract <journal.jsonl>          從 W1 的 journal 撈回三路發現 agent 的完整候選，寫進 data/pool/
  add <T?> <file.json>             併入 [{"id"?, "title", "subarea", "why", "adoption_evidence"?}]；
                                   有 id 的比對標題、沒 id 的用標題找，過閘門才收
  table <T?> [--out <path>]        補齊 resolve 與 meta，計算旗標，寫回池檔並印出判斷用的表
  show <id...>                     印出標題、年份、venue、摘要（判斷範圍用）
"""

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arxiv_tool as ax  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOPICS = json.load(open(os.path.join(ROOT, "data", "topics.json"), encoding="utf-8"))["topics"]
NOW = 2026.75

TOP_VENUE = re.compile(
    r"\b(ACL|EMNLP|NAACL|EACL|AACL|TACL|COLING|NeurIPS|NIPS|ICLR|ICML|COLM|SIGDIAL|AAAI|IJCAI|KDD|WWW|SIGIR|CHI|CSCW|"
    r"TOIS|TMLR|JMLR|ICSE|FSE|ESEC|ISSTA|ASE|CoRL|RSS|Interspeech|ICASSP|UIST|WSDM|CIKM|RecSys|CVPR|ICCV|ECCV|TPAMI)\b"
    r"|Association for Computational Linguistics|Empirical Methods in Natural Language Processing"
    r"|North American Chapter|European Chapter|Neural Information Processing Systems"
    r"|International Conference on Learning Representations|International Conference on Machine Learning"
    r"|Conference on Language Modeling|Discourse and Dialogue|Joint Conference on Artificial Intelligence"
    r"|Knowledge Discovery and Data Mining|The Web Conference|Research and Development in Information Retrieval"
    r"|Human Factors in Computing Systems|Transactions on Information Systems|Transactions on Machine Learning Research"
    r"|Conference on Computational Linguistics|Software Engineering|Conference on Robot Learning"
    r"|\bNature\b|\bScience\b",
    re.I,
)
ACCEPTED = re.compile(r"accepted|to appear|published|proceedings|camera[- ]ready|main conference|oral|spotlight", re.I)
NOT_YET = re.compile(r"under review|submitted|in submission|preprint", re.I)
WORKSHOP = re.compile(r"workshop", re.I)
FINDINGS = re.compile(r"findings", re.I)


def topic(key):
    for t in TOPICS:
        if t["key"] == key:
            return t
    raise SystemExit("沒有這個節點：%s" % key)


def pool_path(t):
    p = os.path.join(ROOT, "data", "pool", "%s-%s.json" % (t["nn"], t["slug"]))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def load_pool(t):
    p = pool_path(t)
    if os.path.exists(p):
        return json.load(open(p, encoding="utf-8"))
    return {"topic": t["key"], "papers": []}


def save_pool(t, pool):
    pool["papers"].sort(key=lambda x: x["id"])
    with open(pool_path(t), "w", encoding="utf-8") as f:
        json.dump(pool, f, ensure_ascii=False, indent=2)
        f.write("\n")


def merge(pool, cand, source):
    cid = ax.norm_id(str(cand.get("id") or ""))
    if not cid:
        return None
    for p in pool["papers"]:
        if p["id"] == cid:
            if source not in p["sources"]:
                p["sources"].append(source)
            if cand.get("why") and cand["why"] not in p["why"]:
                p["why"].append(cand["why"])
            if cand.get("adoption_evidence") and not p.get("adoption_evidence"):
                p["adoption_evidence"] = cand["adoption_evidence"]
            return p
    p = {
        "id": cid,
        "title": cand.get("title", ""),
        "subarea_hint": cand.get("subarea", ""),
        "why": [cand["why"]] if cand.get("why") else [],
        "sources": [source],
        "adoption_evidence": cand.get("adoption_evidence") or None,
    }
    pool["papers"].append(p)
    return p


# ---------------------------------------------------------------- extract


def cmd_extract(a):
    labels, counts = {}, {}
    pools = {t["key"]: load_pool(t) for t in TOPICS}
    for line in open(a.journal, encoding="utf-8"):
        r = json.loads(line)
        if r.get("type") == "started":
            labels[r["key"]] = r.get("label", "")
        elif r.get("type") == "result":
            label = labels.get(r["key"], "")
            m = re.match(r"^(T\d):(snowball|keyword|adoption)$", label)
            if not m or not isinstance(r.get("result"), dict):
                continue
            key, angle = m.groups()
            for c in r["result"].get("candidates", []):
                if merge(pools[key], c, angle):
                    counts[key] = counts.get(key, 0) + 1
    for t in TOPICS:
        save_pool(t, pools[t["key"]])
    return {k: {"raw": counts.get(k, 0), "unique": len(pools[k]["papers"])} for k in pools}


# ---------------------------------------------------------------- add


def cmd_add(a):
    t = topic(a.topic)
    pool = load_pool(t)
    items = json.load(open(a.file, encoding="utf-8"))
    report = {"added": [], "merged": [], "rejected": []}
    with_id = [it for it in items if ax.norm_id(str(it.get("id") or ""))]
    ids = sorted({ax.norm_id(str(it["id"])) for it in with_id})
    table = ax.resolve_ids(ids) if ids else {}
    for it in items:
        cid = ax.norm_id(str(it.get("id") or ""))
        if cid:
            entry = table.get(cid)
            if not entry:
                report["rejected"].append({"title": it.get("title"), "id": cid, "why": "notfound"})
                continue
            if it.get("title") and ax.title_sim(it["title"], entry["title"]) < 0.85:
                # ID 與標題對不上：改用標題找
                cid = None
            else:
                it["title"] = entry["title"]
        if not cid:
            found = ax.cmd_find_title(argparse.Namespace(title=it.get("title", "")))
            if found.get("verdict") != "match":
                report["rejected"].append({"title": it.get("title"), "why": "title-%s" % found.get("verdict"), "best": found.get("best")})
                continue
            cid = found["best"]["id"]
            it["title"] = found["best"]["title"]
        it["id"] = cid
        before = {p["id"] for p in pool["papers"]}
        merge(pool, it, "canon")
        (report["merged"] if cid in before else report["added"]).append({"id": cid, "title": it["title"]})
    save_pool(t, pool)
    report["n_pool"] = len(pool["papers"])
    return report


# ---------------------------------------------------------------- table


def venue_flags(meta_row, entry):
    s2 = " ".join(filter(None, [meta_row.get("venue") or "", meta_row.get("journal") or ""]))
    comment = " ".join(filter(None, [(entry or {}).get("comment") or "", (entry or {}).get("journal_ref") or ""]))
    top_s2 = bool(TOP_VENUE.search(s2)) and not WORKSHOP.search(s2)
    top_comment = bool(TOP_VENUE.search(comment)) and bool(ACCEPTED.search(comment) or (entry or {}).get("journal_ref")) and not NOT_YET.search(comment) and not WORKSHOP.search(comment)
    workshop = bool(WORKSHOP.search(s2) or (WORKSHOP.search(comment) and ACCEPTED.search(comment)))
    findings = bool(FINDINGS.search(s2) or FINDINGS.search(comment))
    return top_s2 or top_comment, workshop, findings


def cmd_table(a):
    t = topic(a.topic)
    pool = load_pool(t)
    ids = [p["id"] for p in pool["papers"]]
    entries = ax.resolve_ids(ids)
    meta = {}
    missing = [i for i in ids if ax._read_json(ax._path("s2", ax._safe(i) + ".json")) is None]
    if missing:
        ax.cmd_meta(argparse.Namespace(ids=missing, file=None, now_year=str(NOW)))
    for i in ids:
        c = ax._read_json(ax._path("s2", ax._safe(i) + ".json")) or {}
        meta[i] = c.get("paper") or {}
    rows = []
    for p in pool["papers"]:
        e = entries.get(p["id"])
        m = meta.get(p["id"]) or {}
        pv = m.get("publicationVenue") or {}
        jn = (m.get("journal") or {}).get("name") if isinstance(m.get("journal"), dict) else None
        year = m.get("year") or (int(e["published"][:4]) if e and e.get("published") else None)
        cites = m.get("citationCount")
        infl = m.get("influentialCitationCount")
        cpy = round(cites / max(1.0, NOW - year + 0.5), 1) if (cites is not None and year) else None
        top, workshop, findings = venue_flags({"venue": m.get("venue") or pv.get("name"), "journal": jn}, e)
        p.update(
            title=(e or {}).get("title") or p["title"],
            year=year,
            citations=cites,
            influential=infl,
            cites_per_year=cpy,
            venue=m.get("venue") or pv.get("name") or None,
            arxiv_comment=(e or {}).get("comment"),
            journal_ref=(e or {}).get("journal_ref"),
            top_venue=top,
        )
        flags = []
        if e is None:
            flags.append("GATE-FAIL")
        if not m:
            flags.append("no-s2")
        if workshop:
            flags.append("workshop")
        if findings:
            flags.append("findings")
        recent = year is not None and year >= 2025
        # 採納證據必須附 URL 才算；「相關領域論文」這種空話不算
        adopted = bool(re.search(r"https?://", p.get("adoption_evidence") or ""))
        if recent and not (top or adopted or (infl or 0) >= 5):
            flags.append("RECENT-INELIGIBLE")
        p["flags"] = flags
        rows.append(p)
    # 節點內相對影響力：年均引用的四分位
    cpys = sorted(r["cites_per_year"] for r in rows if r.get("cites_per_year") is not None)
    q1 = cpys[len(cpys) // 4] if cpys else 0
    for r in rows:
        v = r.get("cites_per_year")
        old = (r.get("year") or 9999) <= 2024
        adopted = bool(re.search(r"https?://", r.get("adoption_evidence") or ""))
        if old and v is not None and v <= max(2.0, q1) and not r["top_venue"] and not adopted:
            r["flags"].append("low-impact")
    save_pool(t, pool)

    def short_venue(v):
        return (v or "-").replace("Annual Meeting of the Association for Computational Linguistics", "ACL").replace(
            "Conference on Empirical Methods in Natural Language Processing", "EMNLP").replace(
            "Neural Information Processing Systems", "NeurIPS").replace(
            "International Conference on Learning Representations", "ICLR").replace(
            "International Conference on Machine Learning", "ICML").replace(
            "North American Chapter of the Association for Computational Linguistics", "NAACL")[:22]

    out = []
    out.append("# %s 候選池（%d 篇）。數字來自 S2 快取；flags 由程式判定。年均引用 Q1=%.1f" % (t["key"], len(rows), q1))
    out.append("# 大寫旗標是硬規則：GATE-FAIL、RECENT-INELIGIBLE 不得入選。小寫旗標是提醒：workshop、findings、low-impact、no-s2。")
    out.append("# id | 年 | 引用 | influential | 年均 | venue | top | flags | 來源 | 子領域提示 | 標題 | 發現者給的理由 | 採納證據")
    for r in sorted(rows, key=lambda r: (r.get("subarea_hint") or "", -(r.get("cites_per_year") or 0))):
        out.append(
            " | ".join(
                str(x)
                for x in (
                    r["id"],
                    r.get("year"),
                    r.get("citations"),
                    r.get("influential"),
                    r.get("cites_per_year"),
                    short_venue(r.get("venue")),
                    "Y" if r["top_venue"] else "-",
                    ",".join(r["flags"]) or "-",
                    "+".join(r["sources"]),
                    (r.get("subarea_hint") or "")[:24],
                    r["title"][:110],
                    (r["why"][0] if r["why"] else "")[:120],
                    (r.get("adoption_evidence") or "")[:160],
                )
            )
        )
    text = "\n".join(out) + "\n"
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        open(a.out, "w", encoding="utf-8").write(text)
        return {"topic": t["key"], "n": len(rows), "table": a.out, "hard_blocked": sum(1 for r in rows if any(f.isupper() for f in r["flags"]))}
    sys.stdout.write(text)
    return None


def cmd_show(a):
    ids = [ax.norm_id(i) for i in a.ids]
    entries = ax.resolve_ids([i for i in ids if i])
    out = []
    for i in ids:
        e = entries.get(i) or {}
        m = (ax._read_json(ax._path("s2", ax._safe(i) + ".json")) or {}).get("paper") or {}
        out.append(
            {
                "id": i,
                "title": e.get("title"),
                "published": e.get("published"),
                "venue": m.get("venue"),
                "comment": e.get("comment"),
                "citations": m.get("citationCount"),
                "influential": m.get("influentialCitationCount"),
                "abstract": e.get("abstract"),
            }
        )
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("extract")
    s.add_argument("journal")
    s = sub.add_parser("add")
    s.add_argument("topic")
    s.add_argument("file")
    s = sub.add_parser("table")
    s.add_argument("topic")
    s.add_argument("--out")
    s = sub.add_parser("show")
    s.add_argument("ids", nargs="+")
    a = ap.parse_args()
    res = {"extract": cmd_extract, "add": cmd_add, "table": cmd_table, "show": cmd_show}[a.cmd](a)
    if res is not None:
        json.dump(res, sys.stdout, ensure_ascii=False, indent=1)
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
