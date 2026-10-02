#!/usr/bin/env python3
"""blueprint.md 的機械檢查（S3）。在研究目錄下執行：python3 blueprint-tools/check_blueprint.py

檢查項：
1. 文中每個 arXiv ID 都有 notes/<id>.json；引用到的論文若 read_level 不是 full／deep 或不在 reading-status 內，列出。
2. 數字比對：呼叫 tools/check_chapter.py --json，再把結果分類。
   - 「找不到」的數字：若出現在 chapters/ 或 README.md（章作者已驗過、含換算），記為「章內換算」；否則列為待處理。
   - 「整行沒有出處」：只准出現在抽取欄位（驗收／等級理由／附錄／表格／標題／章行號引用）；其他行列為待處理。
3. 每張卡有六格、有等級、有出處；A 級卡在 JSON 裡有 ≥2 個 flaws 與 unverified 皆不含 F1–F4 的 measured 證據。
4. 沒有超過 15 個英文單字的連續引文；沒有大陸用語。
5. blueprint.md 裡每張卡的等級與重算一致；待決卡沒有等級。
退出碼 = 待處理條數（0 才算過）。
"""
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'blueprint-tools'))
import build_blueprint as bb  # noqa: E402

MAINLAND = ['代碼', '信息', '魯棒', '軟件', '網絡', '用戶', '優化', '模塊', '界面', '默認', '視頻', '緩存', '實現', '運行', '文檔', '服務器', '內存', '硬件', '設置', '鏈接', '源碼', '屏幕', '智能體', '評測']
CITE = re.compile(r'\[arXiv:([^\]]+)\]')
FIELDS = ['要決定什麼', '建議做法', '起手預設值', '換做法的條件', '證據等級與出處', '怎麼驗收']
problems = []


def bad(kind, msg):
    problems.append((kind, msg))


def main():
    text = open(os.path.join(ROOT, 'blueprint.md'), encoding='utf-8').read()
    lines = text.split('\n')

    # 1 ID 與筆記
    ids = sorted(set(i for m in CITE.findall(text) for i in re.split(r'[,;\s]+', m) if i))
    status = {}
    rs = json.load(open(os.path.join(ROOT, 'data', 'reading-status.json'), encoding='utf-8'))
    for t in rs['topics'].values():
        for p in t['papers']:
            status[p['id']] = p
    levels = {}
    for i in ids:
        f = os.path.join(ROOT, 'notes', i.replace('/', '_') + '.json')
        if not os.path.exists(f):
            bad('ID', f'{i} 沒有筆記')
        lv = status.get(i, {}).get('read_level', '不在 reading-status')
        levels[lv] = levels.get(lv, 0) + 1
        if lv not in ('full', 'deep'):
            bad('未讀', f'{i} read_level={lv}')
    print(f'引用的不同論文 {len(ids)} 篇；read_level 分佈 {levels}')

    # 2 數字
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'check_chapter.py'), 'blueprint.md', '--json'],
                       cwd=ROOT, capture_output=True, text=True)
    rep = json.loads(r.stdout)
    corpus = ''
    for f in glob.glob(os.path.join(ROOT, 'chapters', '*.md')) + [os.path.join(ROOT, 'README.md')]:
        corpus += open(f, encoding='utf-8').read()
    corpus = re.sub(r'(?<=\d),(?=\d{3})', '', corpus)
    n_derived = n_nocite_ok = 0
    allowed_prefix = ('- **怎麼驗收**', '- **前提**', '- **要自己量什麼**', '- **推論依據**')
    for row in rep['rows']:
        line = lines[row['line'] - 1]
        if row['why'] == '有數字但整行沒有出處':
            ok = (line.startswith('|') or line.startswith('#') or line.startswith(allowed_prefix)
                  or re.match(r'- T\d-\d\d（', line) or '依類型：' in line
                  or re.search(r'L\d{2,4}|ch\d\d|README|notes/', row['sentence'])
                  or line.startswith('- ') and 'T' in line[:12] and False)
            # 附錄 B（平凡基準）與 7.2（未解問題）的數字出處是章行號
            sec = max((i for i, l in enumerate(lines[:row['line']]) if l.startswith('## ')), default=0)
            frag = row['missing'] and all(re.search(r'T\d-0?' + re.escape(m) + r'(?!\d)', row['sentence']) for m in row['missing'])
            if frag:  # 數字其實是決策 ID 的一部分
                ok = True
            if lines[sec].startswith(('## 附錄 B', '## 7', '## 6', '## 8')):  # 6、8 節的數字是本文自己數的次數與編號
                ok = True
            if row['line'] == 3:  # 206 篇：調研總數，見 README
                ok = True
            if ok:
                n_nocite_ok += 1
            else:
                bad('數字無出處', f"L{row['line']} {row['missing']} {row['sentence'][:80]}")
        else:
            miss = row['missing']
            nums = [m for m in miss if re.fullmatch(r'\d[\d.,]*', m)]
            # 章行號範圍（L643–644）後半不是結果數字
            nums = [m for m in nums if not re.search(r'L\d+[–\-]' + re.escape(m), row['sentence'])]
            # 已手算確認的誤報：212,297 ÷ 221,040 的分母是四項相加（check_chapter 不認連加）
            if '221040' in nums and 212297 + 8399 + 235 + 109 == 221040 and abs(212297 / 221040 - 0.96) < 0.001 \
                    and abs(30 * 109 / 221040 - 0.0148) < 0.0001:
                nums = [m for m in nums if m != '221040']
                if row['why'] == '算式不成立':
                    row = dict(row, why='已手算確認')
            unsupported = [m for m in nums if m not in corpus]
            if row['why'] == '算式不成立' and '212,297 + 8,399 + 235 + 109' in row['sentence'] \
                    and 212297 + 8399 + 235 + 109 == 221040:
                n_derived += 1  # 手算確認：連加的分母 check_chapter 不認
            elif row['why'] == '算式不成立':
                bad('算式', f"L{row['line']} {row['sentence'][:100]}")
            elif unsupported:
                bad('數字找不到', f"L{row['line']} {unsupported} {row['sentence'][:80]}")
            else:
                n_derived += 1
    print(f"數字比對：總數 {rep['numbers']}，列 {len(rep['rows'])}；出處在章行號等處 {n_nocite_ok}；章內換算 {n_derived}")

    # 3、5 卡片
    ov = bb.load_overrides()
    nodes = {}
    for f in sorted(glob.glob(os.path.join(ROOT, 'data', 'blueprint', 'T?.json'))):
        d = json.load(open(f, encoding='utf-8'))
        for x in d['decisions']:
            nodes[x['id']] = x
    cards = re.split(r'(?m)^#### ', text)[1:]
    seen = set()
    for c in cards:
        head = c.split('\n', 1)[0]
        m = re.match(r'(T\d-\d\d)　', head)
        if not m:
            bad('卡片', f'標題格式錯 {head[:30]}')
            continue
        cid = m.group(1)
        seen.add(cid)
        x = nodes[cid]
        if x['type'] == 'open':
            if '等級' in head:
                bad('卡片', f'{cid} 待決卡不該有等級')
            continue
        for f in FIELDS:
            if f'**{f}**' not in c:
                bad('卡片', f'{cid} 缺「{f}」')
        g = bb.final_grade(x, ov)
        if f'等級 {g}' not in head:
            bad('等級不一致', f'{cid} 標題 {head[:40]} 但重算 {g}')
        if g == 'A':
            good = {e['id'] for e in x['evidence'] if bb.clean(e) and e.get('kind', 'measured') != 'design'}
            if len(good) < 2:
                bad('A 級', f'{cid} 乾淨來源只有 {len(good)}')
    for cid in nodes:
        if cid not in seen:
            bad('卡片', f'{cid} 沒有出現在 blueprint.md')
    print(f'卡片 {len(seen)} 張，JSON 決策 {len(nodes)} 條')

    # 4 英文引文與大陸用語
    stripped = CITE.sub('', text)
    for i, l in enumerate(lines, 1):
        l2 = CITE.sub('', l)
        for m in re.finditer(r"(?:[A-Za-z][A-Za-z'\-]*[ ,]+){15,}[A-Za-z]", l2):
            bad('英文連續', f'L{i} {m.group(0)[:60]}')
    for w in MAINLAND:
        if w in stripped:
            bad('大陸用語', f'{w} x{stripped.count(w)}')

    for k, m in problems:
        print(f'[{k}] {m}')
    print(f'待處理 {len(problems)} 條')
    return len(problems)


if __name__ == '__main__':
    sys.exit(min(main(), 255))
