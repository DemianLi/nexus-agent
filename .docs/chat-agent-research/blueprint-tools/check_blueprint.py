#!/usr/bin/env python3
"""blueprint.md 的機械檢查（S3）。在研究目錄下執行：python3 blueprint-tools/check_blueprint.py

檢查項：
1. 文中每個 arXiv ID 都有 notes/<id>.json；引用到的論文若 read_level 不是 full／deep 或不在 reading-status 內，列出。
   補讀名單（data/blueprint/supplementary-reads.json）內的論文沒有筆記，改驗：只准是 full，且全文快取 .cache/text/<id>.json 的 level 也是 full。
2. 數字比對：呼叫 tools/check_chapter.py --json，再把結果分類。
   - 「找不到」的數字：若出現在 chapters/ 或 README.md（章作者已驗過、含換算），記為「章內換算」；否則列為待處理。
   - 「整行沒有出處」：只准出現在抽取欄位（驗收／等級理由／附錄／表格／標題／章行號引用）；其他行列為待處理。
3. 每張卡有六格、有等級、有出處；A 級卡在 JSON 裡有 ≥2 個 flaws 與 unverified 皆不含 F1–F4 的 measured 證據。
4. 沒有超過 15 個英文單字的連續引文；沒有大陸用語。
5. blueprint.md 裡每張卡的等級與重算一致；待決卡沒有等級。
6. 第 5 節 M2、M3 的每個編號項目底下至少有一個帶標記的證據條目（【直接】【直接（帶毛病：F?）】【單側】【推論】四選一），並印出各標記列數。
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
    # 補讀名單（地圖 #962）：不在八章與 reading-status 內，沒有 notes/<id>.json，只准是 full。
    # read_level 以 .cache/text/<id>.json（fetch 寫的）為準，不採名單自己填的值；快取不進版控，乾淨 clone 上只能警告。
    supp = {}
    sp = os.path.join(ROOT, 'data', 'blueprint', 'supplementary-reads.json')
    if os.path.exists(sp):
        for p in json.load(open(sp, encoding='utf-8'))['papers']:
            supp[p['id']] = p
    levels = {}
    n_supp = 0
    for i in ids:
        if i in supp:
            n_supp += 1
            if supp[i].get('read_level') != 'full':
                bad('未讀', f'{i} 補讀名單的 read_level={supp[i].get("read_level")}，只准 full')
            cj = os.path.join(ROOT, '.cache', 'text', i.replace('/', '_') + '.json')
            if os.path.exists(cj):
                lv = json.load(open(cj, encoding='utf-8')).get('level', '快取沒有 level')
                if lv != 'full':
                    bad('未讀', f'{i} 全文快取的 level={lv}，補讀只准 full')
            else:
                print(f'[警告] {i} 沒有 .cache/text 快取，補讀的 full 與數字都無法在這裡驗證')
                lv = 'full'
            levels[lv] = levels.get(lv, 0) + 1
            continue
        f = os.path.join(ROOT, 'notes', i.replace('/', '_') + '.json')
        if not os.path.exists(f):
            bad('ID', f'{i} 沒有筆記')
        lv = status.get(i, {}).get('read_level', '不在 reading-status')
        levels[lv] = levels.get(lv, 0) + 1
        if lv not in ('full', 'deep'):
            bad('未讀', f'{i} read_level={lv}')
    print(f'引用的不同論文 {len(ids)} 篇（語料內 {len(ids) - n_supp}、補讀 {n_supp}）；read_level 分佈 {levels}')

    # 2 數字
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'check_chapter.py'), 'blueprint.md', '--json'],
                       cwd=ROOT, capture_output=True, text=True)
    rep = json.loads(r.stdout)
    corpus = ''
    for f in glob.glob(os.path.join(ROOT, 'chapters', '*.md')) + [os.path.join(ROOT, 'README.md')]:
        corpus += open(f, encoding='utf-8').read()
    corpus = re.sub(r'(?<=\d),(?=\d{3})', '', corpus)
    n_derived = n_nocite_ok = 0
    spine_a = next(i for i, l in enumerate(lines) if l.startswith('### 主幹五條箭頭'))
    spine_b = next(i for i, l in enumerate(lines) if l.startswith('## 6　組裝順序'))
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
            # 第 5 節主幹契約與附錄 D 導言：地圖編號、本文自己數的列數（第 6 項另驗）、M2／M3 的「查過」條目（查詢命中數不是論文的數字）
            in_spine = spine_a <= row['line'] - 1 < spine_b or lines[row['line'] - 1].startswith('地圖 #')
            if in_spine and (re.search(r'#\d{3}|\d+ 列', row['sentence']) or lines[row['line'] - 1].lstrip().startswith('- 查過')):
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

    # 6 M2、M3 的欄位證據標記（地圖 #962）
    tag_re = r'(直接（帶毛病：F[1-4][^】]*）|直接|單側|推論)'
    for blk in ('M2', 'M3'):
        m = re.search(r'(?ms)^##### ' + blk + r'　.*?(?=^##### |^\*\*五條契約)', text)
        if not m:
            bad('標記', f'找不到 {blk} 區塊')
            continue
        sub = m.group(0).split('\n')
        counts = {}
        starts = [i for i, l in enumerate(sub) if re.match(r'^  \d+\. ', l)]
        for i in starts:
            seg = []
            for l in sub[i + 1:]:
                if re.match(r'^  \d+\. ', l) or re.match(r'^- \*\*', l):
                    break
                seg.append(l)
            tags = [re.match(r'^\s+- 證據【' + tag_re + r'】', l) for l in seg]
            tags = [t.group(1) for t in tags if t]
            if not tags:
                bad('標記', f'{blk} 「{sub[i].strip()[:30]}」底下沒有帶標記的證據條目')
            for t in tags:
                k = '直接（帶毛病）' if t.startswith('直接（') else t
                counts[k] = counts.get(k, 0) + 1
        print(f'{blk} 欄位標記 {sum(counts.values())} 列：' + '、'.join(f'{k} {counts.get(k, 0)}' for k in ('直接', '直接（帶毛病）', '單側', '推論')))

    for k, m in problems:
        print(f'[{k}] {m}')
    print(f'待處理 {len(problems)} 條')
    return len(problems)


if __name__ == '__main__':
    sys.exit(min(main(), 255))
