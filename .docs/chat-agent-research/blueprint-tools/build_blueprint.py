#!/usr/bin/env python3
"""由 data/blueprint/T1..T8.json 與手寫段落（blueprint-parts/*.md）組出 blueprint.md。

用法（在研究目錄 .docs/chat-agent-research/ 下）：python3 blueprint-tools/build_blueprint.py
只用標準函式庫。決策卡、收斂度表、邊介面契約、開放決策匯整、附錄全由 JSON 機械產生，不手寫；唯一手寫的契約是主幹 M1–M5（blueprint-parts/edge-spine.md，推論）；附錄 D 的補讀論文來自 data/blueprint/supplementary-reads.json。

等級規則：取「依 SPEC 由 flaws／unverified 重算的候選等級」與「子代理給的等級」中較低者（A > B > C）。
A 只是候選：獨立性與藏起來的毛病由稽核員另查；稽核降級的結果記在 data/blueprint/audit-overrides.json，
build 時套用（只准降、不准升）。
"""
import json
import glob
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data', 'blueprint')
PARTS = os.path.join(ROOT, 'blueprint-parts')
OUT = os.path.join(ROOT, 'blueprint.md')
F14 = {'F1', 'F2', 'F3', 'F4'}
RANK = {'A': 3, 'B': 2, 'C': 1}
AN = {}
TYPE_ZH = {'do': '建議做', 'avoid': '避免', 'measure': '量測規則', 'open': '待決'}


def clean(e):
    return not (set(e.get('flaws', [])) & F14) and not (set(e.get('unverified', [])) & F14)


def candidate(x):
    """regrade.py 同一套邏輯：兩個以上獨立且乾淨的 measured 來源才是 A 候選。"""
    if x['type'] == 'open':
        return None
    ev = x.get('evidence', [])
    ids = {e['id'] for e in ev if clean(e) and e.get('kind', 'measured') != 'design'}
    if len(ids) >= 2:
        return 'A'
    if x.get('grade') == 'C' or not ev:
        return 'C'
    return 'B'


def load_overrides():
    p = os.path.join(DATA, 'audit-overrides.json')
    if not os.path.exists(p):
        return {}
    return json.load(open(p, encoding='utf-8'))


def load_json(name):
    p = os.path.join(DATA, name)
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}


def apply_patches(nodes):
    """稽核修補：audit-patches.json = {id: {欄位: [[舊字串, 新字串], ...]}}；舊字串必須存在，否則報錯。"""
    for pid, fields in load_json('audit-patches.json').items():
        x = nodes[pid[:2]]['by_id'][pid]
        for field, pairs in fields.items():
            for old, new in pairs:
                if field == '__replace_all__':
                    continue
                v = x.get(field) or ''
                if old == '':
                    x[field] = (v + ' ' + new).strip() if v else new
                elif old not in v:
                    sys.exit(f'patch 失敗：{pid}.{field} 找不到「{old[:30]}」')
                else:
                    x[field] = v.replace(old, new, 1)


def final_grade(x, overrides):
    if x['type'] == 'open':
        return None
    cands = [g for g in (candidate(x), x.get('grade')) if g in RANK]
    g = min(cands, key=lambda k: RANK[k])
    ov = overrides.get(x['id'])
    if ov and RANK[ov['grade']] < RANK[g]:
        g = ov['grade']
    return g


def noise_flag(x):
    ev = x.get('evidence', [])
    return bool(ev) and all('F5' in e.get('flaws', []) for e in ev)


def ids_of(evs):
    seen = []
    for e in evs:
        if e['id'] not in seen:
            seen.append(e['id'])
    return seen


def tag(ids):
    return ''.join(f'[arXiv:{i}]' for i in ids)


def nz(v):
    return v if v else '（文獻沒給，不自己訂）'


def card(x, g, ov):
    head = f"#### {x['id']}　{TYPE_ZH[x['type']]}｜等級 {g}"
    if noise_flag(x):
        head += '（雜訊旗標：支持結果全是單次或小樣本）'
    if x['id'] in ov and g == ov[x['id']]['grade']:
        head += '（稽核降級）'
    lines = [head, '']
    lines.append(f"- **要決定什麼**：{x['decision']}")
    lines.append(f"- **建議做法**：{x['recommendation']}")
    lines.append(f"- **起手預設值**：{nz(x.get('defaults'))}")
    lines.append(f"- **換做法的條件**：{nz(x.get('switch_when'))}")
    ev = ids_of(x.get('evidence', []))
    ce = ids_of(x.get('counter_evidence', []))
    src = f"等級 {g}；來源 {tag(ev)}" if ev else f"等級 {g}（推論，沒有直接量到）"
    if ce:
        src += f"；章內反證 {tag(ce)}"
    src += f"；完整證據見附錄 A（{x['id']}）"
    lines.append(f"- **證據等級與出處**：{src}")
    lines.append(f"- **怎麼驗收**：{x['verification']}")
    if x.get('depends_on'):
        lines.append(f"- **前提**：{'、'.join(x['depends_on'])}")
    if g == 'C' and x.get('grade_reason'):
        lines.append(f"- **推論依據**：{x['grade_reason'].strip()}")
    for n in AN.get(x['id'], []):
        lines.append(f"- **稽核補註**：{n}")
    lines.append('')
    return '\n'.join(lines)


def open_card(x):
    lines = [f"#### {x['id']}　待決（文獻沒有答案）", '']
    lines.append(f"- **要決定什麼**：{x['decision']}")
    lines.append('- **文獻沒有答案**：本調研讀過的論文撐不起一個有道理的建議，不編。')
    lines.append(f"- **要自己量什麼**：{x.get('what_to_measure') or x.get('verification')}")
    if x.get('depends_on'):
        lines.append(f"- **前提**：{'、'.join(x['depends_on'])}")
    lines.append('')
    return '\n'.join(lines)


def main():
    topics = json.load(open(os.path.join(ROOT, 'data', 'topics.json'), encoding='utf-8'))
    tname = {t['key']: t['name'] for t in topics['topics']}
    edges = topics['edges']
    ov = load_overrides()
    nodes = {}
    for f in sorted(glob.glob(os.path.join(DATA, 'T?.json'))):
        d = json.load(open(f, encoding='utf-8'))
        d['by_id'] = {x['id']: x for x in d['decisions']}
        nodes[d['node']] = d
    apply_patches(nodes)
    AN.clear()
    AN.update(load_json('audit-notes.json'))
    keys = sorted(nodes)
    if len(keys) != 8:
        sys.exit(f'預期 8 份 JSON，只有 {keys}')

    def part(name):
        return open(os.path.join(PARTS, name), encoding='utf-8').read().rstrip() + '\n'

    out = []
    out.append(part('head.md'))
    out.append(part('howto.md'))

    out.append('## 2　一頁總覽\n')
    out.append(part('overview-flow.md'))
    cnt = {}
    for k in keys:
        c = {'A': 0, 'B': 0, 'C': 0, 'open': 0, 'noise': 0}
        for x in nodes[k]['decisions']:
            g = final_grade(x, ov)
            c[g or 'open'] += 1
            if g and noise_flag(x):
                c['noise'] += 1
        cnt[k] = c
    tot = {s: sum(cnt[k][s] for k in keys) for s in ('A', 'B', 'C', 'open', 'noise')}
    out.append('### 收斂度表（程式從 JSON 算出；等級為取較低者並套用稽核降級後的結果）\n')
    out.append('| 節點 | A | B | C | 待決 | 合計 | 其中帶雜訊旗標 |')
    out.append('| --- | --- | --- | --- | --- | --- | --- |')
    for k in keys:
        c = cnt[k]
        out.append(f"| {k} {tname[k]} | {c['A']} | {c['B']} | {c['C']} | {c['open']} | {c['A']+c['B']+c['C']+c['open']} | {c['noise']} |")
    out.append(f"| **合計** | {tot['A']} | {tot['B']} | {tot['C']} | {tot['open']} | {tot['A']+tot['B']+tot['C']+tot['open']} | {tot['noise']} |")
    out.append('')
    tc = {}
    for k in keys:
        for x in nodes[k]['decisions']:
            tc[x['type']] = tc.get(x['type'], 0) + 1
    out.append('依類型：' + '、'.join(f"{TYPE_ZH[t]} {tc.get(t,0)} 條" for t in ('do', 'avoid', 'measure', 'open')) + '。\n')
    top = sorted(keys, key=lambda k: -cnt[k]['A'])
    a_txt = '、'.join(f"{k} {cnt[k]['A']}" for k in keys if cnt[k]['A'] >= 4)
    low = '、'.join(k for k in keys if 1 <= cnt[k]['A'] <= 3)
    zero = '、'.join(k for k in keys if cnt[k]['A'] == 0)
    out.append(f"這張表要這樣讀：A 集中在 {a_txt} 條（節點別 A 的條數），而且絕大多數是量測規則，也就是「怎麼量才不會看錯」有不止一個獨立來源；{zero} 沒有任何一條 A，{low} 各只有 1–3 條 A，其餘以 B 為主，代表多半只有一個乾淨來源，或來源各有毛病；待決是文獻的空白，不是工作沒做完。雜訊旗標欄是支持結果全為單次或小樣本的卡數（T2 為 0，是因為它的證據多為設計事實類，不參與旗標的判定，不代表它的數字比較穩）。A 與雜訊旗標並存的卡，意思是「方向有兩個獨立來源一致」，不是「數字可以直接用」。\n")

    out.append(part('discipline.md'))

    out.append('## 4　八個節點的決策卡\n')
    out.append('每節點先列 A、B 級的卡，再列「推論與待量」（C 級與待決型）。卡片欄位直接來自 JSON，等級已依上面的規則取較低者。\n')
    for k in keys:
        out.append(f"### 4.{k[1]}　{k} {tname[k]}\n")
        main_cards = [x for x in nodes[k]['decisions'] if final_grade(x, ov) in ('A', 'B')]
        rest = [x for x in nodes[k]['decisions'] if final_grade(x, ov) not in ('A', 'B')]
        order = {'do': 0, 'avoid': 1, 'measure': 2}
        main_cards.sort(key=lambda x: (order.get(x['type'], 9), x['id']))
        for x in main_cards:
            out.append(card(x, final_grade(x, ov), ov))
        out.append(f"##### {k} 的推論與待量\n")
        if not rest:
            out.append('（無）\n')
        for x in sorted(rest, key=lambda x: x['id']):
            out.append(open_card(x) if x['type'] == 'open' else card(x, final_grade(x, ov), ov))

    out.append('## 5　介面契約：六條邊與主幹五條箭頭\n')
    out.append('每條邊傳什麼、不能傳什麼，逐字彙整自各節點 JSON 的 `edge_interfaces`。T3 與 T8 不是任何一條邊的端點（見 README〈六條邊〉），所以 T3 的項目是它的監控器對 E3 的貢獻，不是地圖上的正式端點。E1–E6 之後另有主幹 M1–M5 五條箭頭的契約，那一段是推論，不是彙整。\n')
    for e in edges:
        out.append(f"### {e['key']} {e['label']}（{e['from']} → {e['to']}）：{e['meaning']}\n")
        n = 0
        for k in keys:
            for ei in nodes[k]['edge_interfaces']:
                if ei['edge'] != e['key']:
                    continue
                n += 1
                role = {'produces': '生產端', 'consumes': '消費端'}.get(ei['role'], ei['role'])
                out.append(f"- **{k} {role}**")
                out.append(f"  - 該傳：{ei['payload']}")
                out.append(f"  - 不能傳：{ei['must_not_pass']}")
        if not n:
            out.append('（八份抽取都沒有這條邊的介面。）')
        out.append('')
        if os.path.exists(os.path.join(PARTS, f"edge-{e['key']}.md")):
            out.append(part(f"edge-{e['key']}.md"))

    out.append(part('edge-spine.md'))

    out.append(part('assembly.md'))

    out.append('## 7　開放決策與要自己跑的實驗\n')
    out.append('### 7.1　待決型（文獻沒有答案）\n')
    out.append('| ID | 要決定什麼 | 要自己量什麼 |')
    out.append('| --- | --- | --- |')
    for k in keys:
        for x in nodes[k]['decisions']:
            if x['type'] == 'open':
                m = (x.get('what_to_measure') or x.get('verification') or '').replace('|', '／').replace('\n', ' ')
                out.append(f"| {x['id']} | {x['decision'].replace('|','／')} | {m} |")
    out.append('')
    out.append('### 7.2　各節點自己列的未解問題\n')
    for k in keys:
        out.append(f"**{k}**")
        for u in nodes[k].get('unresolved', []):
            out.append(f"- {u}")
        out.append('')

    supp = load_json('supplementary-reads.json').get('papers', [])
    n_supp = len(supp)
    a1 = load_json('audit-1.json')
    a2 = load_json('audit-2.json')
    a3 = load_json('audit-3.json')
    n_a1 = len(a1.get('cards', []))
    n_down = len(ov)
    out.append('## 8　稽核與這份方案的限制\n')
    out.append(f"S4 對抗稽核共三位（都是子代理，原始回報在 `data/blueprint/audit-1.json`、`audit-2.json`、`audit-3.json`）：稽核員 1 逐張查 A 級候選卡（{n_a1} 張）的獨立性與藏起來的毛病，建議降級 {sum(1 for c in a1.get('cards', []) if c['verdict'].startswith('downgrade'))} 張；稽核員 2 查 do／avoid 卡與 A 級量測卡有沒有被反證打臉，共 {len(a2.get('findings', []))} 項發現；稽核員 3 站在建造者角度查能不能照做，共 {len(a3.get('findings', []))} 項發現。降級後 A 級由 {n_a1} 張變成 {tot['A']} 張（降級清單：{'、'.join(sorted(ov))}，理由在各卡的稽核補註與 `audit-overrides.json`）。稽核員的發現已逐項處理成卡片上的「稽核補註」或欄位修補（`audit-notes.json`、`audit-patches.json`），邊介面的缺口寫進第 5 節 E6 之後。\n")
    out.append('**這份方案的限制（請審核者特別看這幾處）**\n')
    out.append('- 證據範圍只有本調研讀過的論文；等級 A 不是「已被證明」，而且多數 A 仍帶雜訊旗標（單次或小樣本）。')
    out.append('- 沒有人逐句讀過整份 blueprint.md：決策卡的欄位來自八位抽取者（子代理）的 JSON，數字由程式比對過筆記與全文，判斷是否用得對只由三位稽核員抽查，稽核員自己也標了沒把握的項目。')
    out.append('- 機械檢查（`blueprint-tools/check_blueprint.py`）是寬鬆的：「整行沒有出處」的數字，只在驗收欄、等級理由、附錄與以章行號為出處的段落放行；其中約二十處驗收欄的數字只標章行號、沒有 arXiv 標籤（稽核員 3 指出），沒有逐一補上。')
    out.append('- 稽核員 3 指出的欄位修補只處理了預設值錯誤、判準模糊與邊介面缺口等有行號依據的項目；卡片本文由子代理寫成，許多句子較長，沒有為了簡短而改寫。')
    out.append('- 第 6 節的組裝順序整節是推論，沒有任何實驗支持；第 5 節的邊介面缺口與連結鍵建議也是推論。')
    out.append('- 這份方案不是一份完整的「觀測 agent」方案：T3 的可觀測性那一塊，追蹤與日誌、白箱監控在 T3 計入的論文裡是零篇，非安全類的異常偵測在 T3 計入的論文裡只有 AgentMonitor 碰到一角，監控的證據以安全面為主；T3 的建議做型卡（T3-01、T3-03、T3-09、T3-11）最高是 B，A 級只有量測規則 T3-07，非安全類的異常偵測只能寫成待決（T3-12）。')
    out.append('- 方案只涵蓋自我進化之前的底座：圖上沒有從評估或分數回到 agent 的更新箭頭，所以「量到→提出改動→驗證改動→收進去」的閉環不在範圍內（見第 2 節）；圖上主幹的五條箭頭沒有任何論文把它們整條當邊研究過，第 5 節 M1–M5 的契約主要是從相鄰的卡推出來的，等級 C，只有 M4 有可直接執行的驗收（T7-10，本身也是推論）。M2、M3 另外逐欄標了證據標記（地圖 #962 補強），M2 仍是五條裡最薄的一條；其餘三條沒有欄位標記。M1–M5 是 S4 對抗稽核之後才加的，沒有經過稽核，只由寫的人自己核對過卡號與等級。')
    out.append(f'- 第 5 節 M2、M3 引用了 {n_supp} 篇補讀論文（附錄 D），不在八章與 README 內，沒有精讀筆記，也沒有經過錨點驗證；它們的數字由 `check_blueprint.py` 對照全文快取 `.cache/text/<id>.txt` 核對，這份快取不進版控，乾淨 clone 上只能驗到「名單與 full 的標記」，驗不到數字。')
    out.append('- 八份抽取是在不同時間、規格逐步補充下進行的（T1–T4 開跑時沒有「試點後補充」那一節），等級雖已統一重算並取較低者，邊界案例的寬嚴仍可能不一致。')
    out.append('')
    out.append('## 附錄 A　證據索引\n')
    out.append('決策 ID → 類型 → 等級 → 證據的 arXiv ID → 章節與行號。等級欄為最終等級；「子代理／候選」欄是兩個來源各自給的，供稽核對照。毛病欄的「?F」表示未能確認有沒有。\n')
    out.append('| ID | 類型 | 等級 | 子代理／候選 | 證據（arXiv ID：毛病） | 位置 |')
    out.append('| --- | --- | --- | --- | --- | --- |')
    for k in keys:
        for x in nodes[k]['decisions']:
            g = final_grade(x, ov)
            evs = x.get('evidence', [])
            evtxt = '、'.join(f"{e['id']}（{'/'.join(e.get('flaws', [])+['?'+u for u in e.get('unverified', [])]) or '無'}）" for e in evs) or '—'
            wh = '；'.join(dict.fromkeys(e.get('where', '') for e in evs)) or '—'
            wh = wh.replace('|', '／')
            out.append(f"| {x['id']} | {x['type']} | {g or '—'} | {x.get('grade') or '—'}／{candidate(x) or '—'} | {evtxt} | {wh} |")
    out.append('')
    out.append('## 附錄 B　各節點的平凡基準\n')
    out.append('每個節點抽取時列出的「不需要模型就能拿到的分數」，驗收時要並列。\n')
    for k in keys:
        out.append(f"**{k}**\n")
        for b in nodes[k].get('trivial_baselines', []):
            out.append(f"- {b['metric']}：對照「{b['baseline']}」；{b['value']}")
        out.append('')
    out.append('## 附錄 C　等級判定的理由\n')
    out.append('每張卡的 `grade_reason`。更細的 `flaw_basis`（為什麼有或沒有哪個毛病）在 `data/blueprint/T?.json`。\n')
    for k in keys:
        out.append(f"**{k}**\n")
        for x in nodes[k]['decisions']:
            if x['type'] == 'open':
                continue
            out.append(f"- {x['id']}（{final_grade(x, ov)}）：{(x.get('grade_reason') or '').strip()}")
        out.append('')

    out.append('## 附錄 D　補讀論文（第 5 節 M2、M3 的證據）\n')
    out.append('地圖 #962 補強 M2、M3 時新讀的論文，來源是 `data/blueprint/supplementary-reads.json`。它們不在八章與 README 內，沒有精讀筆記；全部讀過 arxiv-html 全文（read_level 為 full，由 `check_blueprint.py` 對照全文快取驗證）。「毛病與旗標」欄的 F1–F5 見第 1 節；RECENT-INELIGIBLE 表示 2025 年以後、不是頂會、沒有採納證據、影響力引用數太低；這類論文，以及卡在水論文判準邊上的論文，最多支撐【單側】。\n')
    rs = json.load(open(os.path.join(ROOT, 'data', 'reading-status.json'), encoding='utf-8'))
    in_rs = {p['id'] for t in rs['topics'].values() for p in t['papers']}
    both = [q['id'] for q in supp if q['id'] in in_rs]
    if both:
        out.append('其中 ' + '、'.join(both) + ' 在章內原本列為候補（尚未精讀），這一輪讀完全文；章與 `reading-status.json` 沒有改，仍照原狀態。\n')
    out.append('| arXiv | 標題 | 年／venue／引用 | 毛病與旗標 | 用在哪 | 最高標記 |')
    out.append('| --- | --- | --- | --- | --- | --- |')
    for q in supp:
        fl = '、'.join(q.get('flags', [])) or '無'
        out.append(f"| {q['id']} | {q['title'].replace('|', '／')} | {q['year']}／{q['venue']}／{q['citations']} | {fl} | {q['used_for']} | {q['max_tag']} |")
    out.append('')
    text = '\n'.join(out)
    open(OUT, 'w', encoding='utf-8').write(text)
    print(f'寫出 {OUT}，{len(text)} 字元；A {tot["A"]} B {tot["B"]} C {tot["C"]} 待決 {tot["open"]}；雜訊旗標 {tot["noise"]}')


if __name__ == '__main__':
    main()
