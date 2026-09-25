#!/usr/bin/env python3
"""章節的確定性數字比對：句子裡的每個數字，都要能在它引用的論文筆記或快取全文裡找到。

不判斷數字用得對不對（那是查核員的事），只抓「筆記與全文裡根本沒有這個數字」的句子，
讓查核員先處理這些，而不是靠抽查碰運氣。沒有附 [arXiv:ID] 的句子沿用同一行的出處。

找不到的原因通常有三種：數字抄錯、張冠李戴（數字屬於另一篇）、撰寫者自己換算出來的
（例如兩個百分比相減）。第三種不一定是錯，但要在句子裡寫出算式或改寫成筆記裡的數字。

用法：
  check_chapter.py chapters/01-goal-intent.md          印出找不到的句子
  check_chapter.py chapters/01-goal-intent.md --json   以 JSON 輸出（給 agent 用）
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CITE = re.compile(r"\[arXiv:([^\]]+)\]")
ID = re.compile(r"\d{4}\.\d{4,5}")
NUM = re.compile(r"(?<![\w.])\d[\d,]*(?:\.\d+)?")
# 章節號、表號、圖號、附錄號後面的數字不是結果數字
REF = re.compile(r"(§|Table|Tab\.|Figure|Fig\.|表|圖|附錄|Appendix|Section|Eq\.|式)\s*[A-Z]?\d[\d.]*", re.I)
SPLIT = re.compile(r"(?<=[。！？；])")

_hay = {}


def haystack(pid):
    if pid not in _hay:
        parts = []
        for p in (os.path.join(ROOT, "notes", pid.replace("/", "_") + ".json"),
                  os.path.join(ROOT, ".cache", "text", pid.replace("/", "_") + ".txt")):
            if os.path.exists(p):
                parts.append(open(p, encoding="utf-8").read())
        text = "\n".join(parts)
        _hay[pid] = re.sub(r"(?<=\d),(?=\d{3})", "", text) if text else None
    return _hay[pid]


def found(num, hay):
    candidates = {num}
    try:
        v = float(num)
        if "." in num and v < 1:
            candidates.add(("%g" % (v * 100)))
        elif v >= 1:
            candidates.add(("%g" % (v / 100)))
    except ValueError:
        pass
    return any(re.search(r"(?<![\d.])" + re.escape(c) + r"(?!\.?\d)", hay) for c in candidates)


def numbers(unit):
    s = CITE.sub(" ", unit)
    s = REF.sub(" ", s)
    s = ID.sub(" ", s)
    s = re.sub(r"\]\([^)]*\)", "]", s)  # markdown 連結的網址
    s = re.sub(r"https?://\S+", " ", s)
    out = []
    for m in NUM.finditer(s):
        n = m.group().replace(",", "")
        if "." not in n and int(n) <= 10:
            continue  # 0–10 的整數到處都是，比對不出意義
        out.append(n)
    return out


def check(path):
    known = {f[:-5].replace("_", "/") for f in os.listdir(os.path.join(ROOT, "notes")) if f.endswith(".json")}
    rows, unknown, total, missing_total = [], set(), 0, 0
    in_code = False
    for lineno, line in enumerate(open(path, encoding="utf-8"), 1):
        if line.startswith("```"):
            in_code = not in_code
        if in_code or line.startswith("#"):
            continue
        line_ids = [i for c in CITE.findall(line) for i in ID.findall(c)]
        units = [line] if line.lstrip().startswith("|") else [u for u in SPLIT.split(line) if u.strip()]
        for unit in units:
            ids = [i for c in CITE.findall(unit) for i in ID.findall(c)] or line_ids
            nums = numbers(unit)
            if not nums:
                continue
            for i in ids:
                if i not in known:
                    unknown.add(i)
            hays = [h for h in (haystack(i) for i in ids) if h]
            if not ids:
                rows.append({"line": lineno, "sentence": unit.strip()[:160], "ids": [], "missing": nums, "why": "有數字但整行沒有出處"})
                total += len(nums)
                missing_total += len(nums)
                continue
            miss = [n for n in nums if not any(found(n, h) for h in hays)]
            total += len(nums)
            missing_total += len(miss)
            if miss:
                rows.append({"line": lineno, "sentence": unit.strip()[:160], "ids": ids, "missing": miss, "why": "引用的筆記與全文裡找不到"})
    return {"path": path, "numbers": total, "missing": missing_total, "unknown_ids": sorted(unknown), "rows": rows}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        sys.exit(2)
    res = check(args[0])
    if "--json" in sys.argv:
        print(json.dumps(res, ensure_ascii=False, indent=1))
        return
    print(f"{res['path']}：數字 {res['numbers']} 個，找不到 {res['missing']} 個；引用了沒有筆記的 ID：{res['unknown_ids'] or '無'}")
    for r in res["rows"]:
        print(f"  L{r['line']} [{','.join(r['ids']) or '無出處'}] 找不到 {'、'.join(r['missing'])}｜{r['sentence']}")


if __name__ == "__main__":
    main()
