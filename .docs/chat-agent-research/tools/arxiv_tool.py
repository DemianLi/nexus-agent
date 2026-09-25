#!/usr/bin/env python3
"""chat-agent 調研用的 arXiv / Semantic Scholar 工具。只用標準函式庫（Python 3.9）。

所有對外請求都走這支：同一個主機一次只有一個請求（檔案鎖），請求之間有最小間隔，
429／5xx 做指數退避，結果按 ID 快取在 ../.cache/（不進版控）。多個子代理同時呼叫
也不會把 arXiv 或 S2 打爆。

子命令（輸出一律是 JSON，印在 stdout）：

  search  "<arXiv 查詢式>" [--max N] [--sort relevance|submittedDate]
          arXiv API 搜尋。查詢式語法同 arXiv API，例如 'abs:"user simulator" AND cat:cs.CL'。
  find-title "<論文標題>"
          依標題在 arXiv 找論文，回傳最相近的一筆與相似度。
  resolve <id...> | --check <file.json>
          用 arXiv API 的 id_list 解析 ID。--check 讀 [{"id","title"},...]，逐筆比對標題，
          判定 match / mismatch / notfound —— 這是擋掉幻覺 ID 的閘門。
  meta    <id...> | --file <ids.txt>
          Semantic Scholar 批次查引用數、influentialCitationCount、venue、年份。
  fetch   <id>
          抓全文：arxiv.org/html → ar5iv → 只剩摘要，轉成純文字存進快取，回傳路徑與章節。
  refs    <id>
          從已抓的全文（必要時先抓）收割參考文獻，附上其中出現的 arXiv ID。
  anchors <id> --file <anchors.json>
          檢查 ["原文片段", ...] 是否真的出現在該論文的快取全文裡（正規化後比對）。
"""

import argparse
import difflib
import fcntl
import html
import html.parser
import json
import os
import re
import sys
import tempfile
import textwrap
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(os.path.dirname(HERE), ".cache")
UA = "nexus-chat-agent-research/0.1 (literature survey tool; polite, cached, serialized)"

# 每個主機群組的最小請求間隔（秒）。arXiv API 官方要求 3 秒一次。
MIN_INTERVAL = {"arxiv-api": 3.1, "arxiv-web": 1.0, "s2": 1.2}

NEW_ID = re.compile(r"^\d{4}\.\d{4,5}(v\d+)?$")
OLD_ID = re.compile(r"^[a-z\-]+(\.[A-Z]{2})?/\d{7}(v\d+)?$")
ID_IN_TEXT = re.compile(r"(?<![\d.])(\d{4}\.\d{4,5})(v\d+)?(?![\d])")

# 錨點落在全文 20% 之後才算「深處」：摘要與引言通常在前 15% 左右
DEEP_POS = 0.2

ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV = "{http://arxiv.org/schemas/atom}"


# ---------------------------------------------------------------- 基礎設施


def _path(*parts):
    p = os.path.join(CACHE, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def _atomic_write(path, data):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(data)
    os.replace(tmp, path)


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def norm_id(raw):
    """去掉 URL、前綴與版本號，回傳 arXiv 的 canonical ID；格式不對回 None。"""
    s = raw.strip()
    s = re.sub(r"^(https?://)?(www\.)?(arxiv\.org|ar5iv\.(labs\.arxiv\.)?org)/(abs|pdf|html)/", "", s)
    s = re.sub(r"^arxiv:", "", s, flags=re.I)
    s = re.sub(r"\.pdf$", "", s)
    s = s.rstrip("/")
    if NEW_ID.match(s) or OLD_ID.match(s):
        return re.sub(r"v\d+$", "", s)
    return None


def _safe(id_):
    return id_.replace("/", "_")


def http(group, url, data=None, headers=None, tries=8, accept_404=False):
    """在主機群組的檔案鎖內送出請求，遵守最小間隔，429／5xx 指數退避。回傳 (status, body, final_url)。"""
    lock_path = _path("locks", group + ".lock")
    stamp_path = _path("locks", group + ".last")
    delay = 5.0
    last_err = None
    with open(lock_path, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            for attempt in range(tries):
                try:
                    with open(stamp_path) as f:
                        last = float(f.read().strip() or 0)
                except (OSError, ValueError):
                    last = 0.0
                wait = MIN_INTERVAL[group] - (time.time() - last)
                if wait > 0:
                    time.sleep(wait)
                req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
                try:
                    with urllib.request.urlopen(req, timeout=60) as resp:
                        body = resp.read()
                        status, final = resp.status, resp.geturl()
                except urllib.error.HTTPError as e:
                    body, status, final = e.read(), e.code, url
                except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                    body, status, final = b"", 0, url
                    last_err = repr(e)
                finally:
                    with open(stamp_path, "w") as f:
                        f.write(str(time.time()))
                if status == 200 or (accept_404 and status == 404):
                    return status, body, final
                if status in (0, 429, 500, 502, 503, 504):
                    sys.stderr.write("[%s] HTTP %s，第 %d 次，退避 %.0fs\n" % (group, status, attempt + 1, delay))
                    time.sleep(delay)
                    delay = min(delay * 2, 90)
                    continue
                return status, body, final
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
    raise RuntimeError("%s 重試 %d 次仍失敗：%s %s" % (group, tries, url, last_err or "HTTP %s" % status))


def norm_title(t):
    t = unicodedata.normalize("NFKC", t or "").lower()
    t = re.sub(r"[^0-9a-z一-鿿]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def title_sim(a, b):
    na, nb = norm_title(a), norm_title(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    # 副標題差異：一邊是另一邊的前綴（例如「τ-bench」對「τ-bench: A Benchmark ...」）
    short, long_ = sorted((na, nb), key=len)
    if len(short) >= 12 and long_.startswith(short):
        return 0.95
    return difflib.SequenceMatcher(None, na, nb).ratio()


# ---------------------------------------------------------------- arXiv API


def _parse_feed(body):
    root = ET.fromstring(body)
    out = []
    for e in root.findall(ATOM + "entry"):
        raw_id = (e.findtext(ATOM + "id") or "").strip()
        if "/api/errors" in raw_id:
            out.append({"error": (e.findtext(ATOM + "summary") or "").strip()})
            continue
        m = re.search(r"arxiv\.org/abs/(.+)$", raw_id)
        full = m.group(1) if m else raw_id
        cats = [c.get("term") for c in e.findall(ATOM + "category")]
        prim = e.find(ARXIV + "primary_category")
        out.append(
            {
                "id": re.sub(r"v\d+$", "", full),
                "version": (re.search(r"v(\d+)$", full) or [None, None])[1],
                "title": re.sub(r"\s+", " ", (e.findtext(ATOM + "title") or "")).strip(),
                "published": (e.findtext(ATOM + "published") or "")[:10],
                "updated": (e.findtext(ATOM + "updated") or "")[:10],
                "authors": [a.findtext(ATOM + "name") for a in e.findall(ATOM + "author")][:8],
                "n_authors": len(e.findall(ATOM + "author")),
                "comment": re.sub(r"\s+", " ", e.findtext(ARXIV + "comment") or "").strip() or None,
                "journal_ref": re.sub(r"\s+", " ", e.findtext(ARXIV + "journal_ref") or "").strip() or None,
                "primary_category": prim.get("term") if prim is not None else (cats[0] if cats else None),
                "abstract": re.sub(r"\s+", " ", (e.findtext(ATOM + "summary") or "")).strip(),
            }
        )
    return out


def arxiv_query(params):
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(params)
    status, body, _ = http("arxiv-api", url)
    if status != 200:
        raise RuntimeError("arXiv API HTTP %s" % status)
    return _parse_feed(body)


def cmd_search(a):
    rows = arxiv_query(
        {
            "search_query": a.query,
            "start": a.start,
            "max_results": a.max,
            "sortBy": a.sort,
            "sortOrder": "descending",
        }
    )
    if not a.abstract:
        for r in rows:
            r.pop("abstract", None)
    return rows


def cmd_find_title(a):
    words = [w for w in norm_title(a.title).split() if len(w) > 2][:12]
    if not words:
        return {"query": a.title, "best": None}
    q = " AND ".join('ti:"%s"' % w for w in words)
    rows = [r for r in arxiv_query({"search_query": q, "max_results": 10}) if "error" not in r]
    if not rows:  # 標題裡有 arXiv 不收的字（希臘字母等）時，退到少一點的詞
        q = " AND ".join('ti:"%s"' % w for w in words[:5])
        rows = [r for r in arxiv_query({"search_query": q, "max_results": 10}) if "error" not in r]
    scored = sorted(((title_sim(a.title, r["title"]), r) for r in rows), key=lambda x: -x[0])
    best = scored[0] if scored else None
    return {
        "query": a.title,
        "best": None if not best else {"sim": round(best[0], 3), **{k: best[1][k] for k in ("id", "title", "published", "comment")}},
        "verdict": "match" if best and best[0] >= 0.9 else ("weak" if best and best[0] >= 0.75 else "notfound"),
    }


def resolve_ids(ids):
    """回傳 {canonical_id: entry 或 None}。帶快取；批次失敗時退回逐筆。"""
    result, todo = {}, []
    for i in ids:
        c = _read_json(_path("arxiv", _safe(i) + ".json"))
        if c is not None:
            result[i] = c.get("entry")
        else:
            todo.append(i)
    for k in range(0, len(todo), 50):
        chunk = todo[k : k + 50]
        try:
            rows = arxiv_query({"id_list": ",".join(chunk), "max_results": len(chunk)})
            if any("error" in r for r in rows):
                raise ValueError("batch error")
            got = {r["id"]: r for r in rows}
        except (ValueError, RuntimeError, ET.ParseError):
            got = {}
            for i in chunk:
                try:
                    rows = arxiv_query({"id_list": i, "max_results": 1})
                    for r in rows:
                        if "error" not in r:
                            got[r["id"]] = r
                except (RuntimeError, ET.ParseError):
                    pass
        for i in chunk:
            entry = got.get(i)
            # arXiv 對不存在的 ID 會回一筆空標題的 entry
            if entry is not None and not entry.get("title"):
                entry = None
            _atomic_write(_path("arxiv", _safe(i) + ".json"), json.dumps({"entry": entry}, ensure_ascii=False))
            result[i] = entry
    return result


def cmd_resolve(a):
    if a.check:
        items = json.load(open(a.check, encoding="utf-8"))
    else:
        items = [{"id": i} for i in a.ids]
    out, ids = [], []
    for it in items:
        cid = norm_id(str(it.get("id", "")))
        it["_cid"] = cid
        if cid:
            ids.append(cid)
    table = resolve_ids(sorted(set(ids)))
    for it in items:
        cid = it.pop("_cid")
        entry = table.get(cid) if cid else None
        row = {"input_id": it.get("id"), "id": cid}
        if not cid:
            row.update(verdict="badformat")
        elif entry is None:
            row.update(verdict="notfound")
        else:
            row.update({k: entry[k] for k in ("title", "published", "comment", "journal_ref", "primary_category", "n_authors")})
            row["authors"] = entry["authors"][:4]
            if it.get("title"):
                sim = title_sim(it["title"], entry["title"])
                row["claimed_title"] = it["title"]
                row["sim"] = round(sim, 3)
                row["verdict"] = "match" if sim >= 0.85 else "mismatch"
            else:
                row["verdict"] = "resolved"
        out.append(row)
    return out


# ---------------------------------------------------------------- Semantic Scholar

S2_FIELDS = "title,year,venue,publicationVenue,journal,citationCount,influentialCitationCount,publicationTypes,externalIds,publicationDate"


def cmd_meta(a):
    ids = list(a.ids)
    if a.file:
        ids += [l.strip() for l in open(a.file, encoding="utf-8") if l.strip()]
    cids = []
    for i in ids:
        c = norm_id(i)
        if c and c not in cids:
            cids.append(c)
    out, todo = {}, []
    for c in cids:
        cached = _read_json(_path("s2", _safe(c) + ".json"))
        if cached is not None:
            out[c] = cached.get("paper")
        else:
            todo.append(c)
    for k in range(0, len(todo), 400):
        chunk = todo[k : k + 400]
        body = json.dumps({"ids": ["arXiv:" + c for c in chunk]}).encode()
        status, resp, _ = http(
            "s2",
            "https://api.semanticscholar.org/graph/v1/paper/batch?fields=" + S2_FIELDS,
            data=body,
            headers={"Content-Type": "application/json"},
        )
        if status != 200:
            raise RuntimeError("S2 batch HTTP %s: %s" % (status, resp[:200]))
        papers = json.loads(resp)
        for c, p in zip(chunk, papers):
            _atomic_write(_path("s2", _safe(c) + ".json"), json.dumps({"paper": p}, ensure_ascii=False))
            out[c] = p
    rows = []
    for c in cids:
        p = out.get(c)
        if not p:
            rows.append({"id": c, "s2": None})
            continue
        pv = p.get("publicationVenue") or {}
        year = p.get("year")
        cites = p.get("citationCount") or 0
        age = max(1.0, (float(a.now_year) - float(year)) + 0.5) if year else None
        rows.append(
            {
                "id": c,
                "title": p.get("title"),
                "year": year,
                "venue": p.get("venue") or pv.get("name"),
                "venue_type": pv.get("type"),
                "citations": cites,
                "influential": p.get("influentialCitationCount") or 0,
                "cites_per_year": round(cites / age, 1) if age else None,
                "types": p.get("publicationTypes"),
            }
        )
    return rows


# ---------------------------------------------------------------- 全文


class _Text(html.parser.HTMLParser):
    """把 arXiv / ar5iv 的 LaTeXML HTML 轉成可讀的純文字。數學取 alttext。"""

    SKIP = {"script", "style", "nav", "header", "footer", "button", "svg", "noscript"}
    BLOCK = {"p", "div", "section", "article", "li", "tr", "table", "figure", "figcaption", "blockquote", "br", "dd", "dt"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip, self.math, self.sections = [], 0, 0, []
        self.heading = None

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        cls = d.get("class") or ""
        if tag in self.SKIP or "ltx_page_header" in cls or "ltx_page_footer" in cls or "package-alerts" in cls:
            self.skip += 1
            return
        if self.skip:
            return
        if tag == "math":
            alt = d.get("alttext")
            if alt:
                (self.heading[2] if self.heading is not None else self.out).append(" $" + alt + "$ ")
            self.math += 1
            return
        if self.math:
            return
        if re.match(r"h[1-6]$", tag):
            sid = d.get("id") or ""
            self.heading = [int(tag[1]), sid, []]
            self.out.append("\n\n")
            return
        if tag in ("td", "th"):
            self.out.append(" | ")
        elif tag in self.BLOCK:
            self.out.append("\n")
        if "ltx_bibitem" in cls:
            self.out.append("\n[BIB] ")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag == "math":
            self.math = max(0, self.math - 1)
            return
        if self.math:
            return
        if self.heading and re.match(r"h[1-6]$", tag):
            lvl, sid, parts = self.heading
            title = re.sub(r"\s+", " ", "".join(parts)).strip()
            self.sections.append({"level": lvl, "id": sid, "title": title})
            self.out.append("%s %s%s\n" % ("#" * lvl, title, "  [§%s]" % sid if sid else ""))
            self.heading = None
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if self.skip or self.math:
            return
        if self.heading is not None:
            self.heading[2].append(data)
        else:
            self.out.append(data)


def _html_to_text(body):
    p = _Text()
    p.feed(body)
    raw = "".join(p.out)
    lines, blank = [], 0
    for line in raw.split("\n"):
        line = re.sub(r"[ \t ]+", " ", line).strip()
        if not line:
            blank += 1
            if blank <= 1:
                lines.append("")
            continue
        blank = 0
        if line.startswith("#"):
            lines.append(line)
        else:
            # 行寬收在 220 字元，讓 Read 工具不會截掉長段落
            lines.extend(textwrap.wrap(line, 220, break_long_words=False, break_on_hyphens=False) or [line])
    return "\n".join(lines).strip() + "\n", p.sections


def _looks_like_paper(body, final_url):
    if "/abs/" in final_url:
        return False  # ar5iv 沒有版本時會轉回 abs 頁
    return b"ltx_document" in body or b"ltx_page_main" in body


def cmd_fetch(a):
    cid = norm_id(a.id)
    if not cid:
        raise SystemExit("ID 格式不對：%s" % a.id)
    txt_path = _path("text", _safe(cid) + ".txt")
    info_path = _path("text", _safe(cid) + ".json")
    info = _read_json(info_path)
    if info and os.path.exists(txt_path) and not a.force:
        return info
    source, text, sections = None, None, []
    for src, url in (("arxiv-html", "https://arxiv.org/html/" + cid), ("ar5iv", "https://ar5iv.labs.arxiv.org/html/" + cid)):
        status, body, final = http("arxiv-web", url, accept_404=True)
        if status == 200 and _looks_like_paper(body, final):
            text, sections = _html_to_text(body.decode("utf-8", "replace"))
            if len(text) > 5000:
                source = src
                break
    level = "full"
    if source is None:
        entry = resolve_ids([cid]).get(cid)
        if not entry:
            raise SystemExit("arXiv 上找不到 %s" % cid)
        text = "# %s\n\n## Abstract\n\n%s\n" % (entry["title"], textwrap.fill(entry["abstract"], 220))
        source, level = "abs-only", "abstract"
    entry = resolve_ids([cid]).get(cid) or {}
    header = "# [arXiv:%s] %s\n# source: %s  level: %s\n\n" % (cid, entry.get("title", ""), source, level)
    _atomic_write(txt_path, header + text)
    has_refs = "[BIB]" in text
    info = {
        "id": cid,
        "title": entry.get("title"),
        "path": txt_path,
        "source": source,
        "level": level,
        "chars": len(text),
        "lines": text.count("\n"),
        "has_bibliography": has_refs,
        "sections": [s for s in sections if s["level"] <= 3 and s["title"]][:60],
    }
    _atomic_write(info_path, json.dumps(info, ensure_ascii=False))
    return info


def cmd_refs(a):
    info = cmd_fetch(argparse.Namespace(id=a.id, force=False))
    text = open(info["path"], encoding="utf-8").read()
    refs = []
    for chunk in text.split("[BIB]")[1:]:
        # 一條文獻的作者／標題／出處之間有空行；取到下一個章節標題為止
        body = re.split(r"\n#", chunk)[0]
        entry = re.sub(r"\s+", " ", body).strip()
        ids = sorted({m.group(1) for m in ID_IN_TEXT.finditer(entry)})
        refs.append({"text": entry[:400], "arxiv_ids": ids})
    return {"id": info["id"], "source": info["source"], "n_refs": len(refs), "refs": refs}


# ---------------------------------------------------------------- 錨點


def _norm_anchor(s):
    s = unicodedata.normalize("NFKC", s).lower()
    s = s.replace("’", "'").replace("–", "-").replace("—", "-")
    s = re.sub(r"-\s+", "-", s)
    s = re.sub(r"[^0-9a-z%.\-+ ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def cmd_anchors(a):
    cid = norm_id(a.id)
    path = _path("text", _safe(cid) + ".txt")
    if not os.path.exists(path):
        cmd_fetch(argparse.Namespace(id=cid, force=False))
    hay = _norm_anchor(open(path, encoding="utf-8").read())
    anchors = json.load(open(a.file, encoding="utf-8")) if a.file else a.snippets
    out = []
    for s in anchors:
        n = _norm_anchor(s)
        if not n:
            out.append({"anchor": s, "verdict": "empty"})
            continue
        if n in hay:
            # pos：錨點在全文中的相對位置（0＝開頭）。只落在摘要與引言的錨點驗證不了方法與實驗的主張
            out.append({"anchor": s, "verdict": "exact", "pos": round(hay.index(n) / max(1, len(hay)), 3)})
            continue
        sm = difflib.SequenceMatcher(None, hay, n, autojunk=False)
        m = sm.find_longest_match(0, len(hay), 0, len(n))
        cover = m.size / len(n)
        out.append(
            {
                "anchor": s,
                "verdict": "partial" if cover >= 0.6 else "missing",
                "longest_match_ratio": round(cover, 2),
                "nearest": hay[max(0, m.a - 40) : m.a + m.size + 40] if cover >= 0.3 else None,
            }
        )
    deep = sum(1 for r in out if r["verdict"] == "exact" and r.get("pos", 0) >= DEEP_POS)
    return {"id": cid, "results": out, "pass": sum(r["verdict"] == "exact" for r in out), "deep": deep, "total": len(out)}


# ---------------------------------------------------------------- 入口


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search")
    s.add_argument("query")
    s.add_argument("--max", type=int, default=25)
    s.add_argument("--start", type=int, default=0)
    s.add_argument("--sort", default="relevance", choices=["relevance", "submittedDate", "lastUpdatedDate"])
    s.add_argument("--abstract", action="store_true", help="輸出也帶摘要")

    s = sub.add_parser("find-title")
    s.add_argument("title")

    s = sub.add_parser("resolve")
    s.add_argument("ids", nargs="*")
    s.add_argument("--check", help='JSON 檔：[{"id": "...", "title": "..."}]')

    s = sub.add_parser("meta")
    s.add_argument("ids", nargs="*")
    s.add_argument("--file")
    s.add_argument("--now-year", default="2026.75", help="算 cites_per_year 用的現在時間（年，帶小數）")

    s = sub.add_parser("fetch")
    s.add_argument("id")
    s.add_argument("--force", action="store_true")

    s = sub.add_parser("refs")
    s.add_argument("id")

    s = sub.add_parser("anchors")
    s.add_argument("id")
    s.add_argument("snippets", nargs="*")
    s.add_argument("--file", help='JSON 檔：["原文片段", ...]')

    a = ap.parse_args()
    fn = {
        "search": cmd_search,
        "find-title": cmd_find_title,
        "resolve": cmd_resolve,
        "meta": cmd_meta,
        "fetch": cmd_fetch,
        "refs": cmd_refs,
        "anchors": cmd_anchors,
    }[a.cmd]
    json.dump(fn(a), sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
