"""清外部對照的 PR（階段 1）的證據檢查，規則見 docs/contributing.md 裡清外部對照 PR 的那一段與 #3125。

只對「階段 1 那種 PR」生效：對照詞計數下降，而且除了註解與字串內容，程式碼沒變。三條規則：

1. 這張 PR 改寫或新增的每一句註解，PR 內文都要有一列：整句加上 head 上存在的 `path:line`。
2. 註解裡原有的段名（`## 標題`、表格的名稱格）在同一個檔消失就紅。段名本身含對照詞的不在此限。
3. 消失的段名，用段名與簡寫找全 repo 指向它的地方；每一個候選指向，內文要有一列寫明為什麼仍成立。

句子是真是假、理由成不成立，script 判不了，留給 verifier。本機不帶 --body-file 也不設 BODY 時只印出要填的列。
"""

from __future__ import annotations

import argparse
import functools
import json
import os
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_ratchets import EXCLUDED_PREFIXES, ROOT, reference_lines  # noqa: E402
from project_paths import canonical  # noqa: E402

SLASH = ('.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs', '.css')
HASH = ('.py', '.sh', '.yml', '.yaml', '.toml')
LANGS = SLASH + HASH
IGNORED_PREFIXES = EXCLUDED_PREFIXES + ('.github/ratchets/', '.github/ratchets.json')
SEARCH_EXCLUDED = ('references/', '.github/ratchets/', 'vendor/', 'apps/web/src/vendor/')
SEARCH_EXCLUDED_NAMES = ('pnpm-lock.yaml', 'Cargo.lock')

HEADING = re.compile(r'^#{1,6}\s+(\S.*?)\s*#*$')
HEADING_LINE = re.compile(r'^\s*(?:(?://+|\*+|#)\s*)?#{2,6}\s+\S')
TABLE_ROW = re.compile(r'^\|.*\|$')
LIST_START = re.compile(r'^(?:[-*+]|\d+[.)])\s+')
NUMERIC_CELL = re.compile(r'^[\d.#\-–—:\s]*$')
SEPARATOR_CELL = re.compile(r'^:?-{2,}:?$')
SENTENCE_END = re.compile(r'(?<=[。！？!?])\s*|(?<=\.)\s+')
REF = re.compile(r'([\w@./\-]+\.\w+):(\d+)(?:[-–](\d+))?')
PLACEHOLDER = '<填'
HEADER_WORDS = ('檔頭',)
MIN_REASON = 6
MAX_NAME_CELL = 30

Comments = list[tuple[int, list[str], bool]]


@dataclass(frozen=True)
class Unit:
    line: int
    text: str
    end: int = 0

    @property
    def last(self) -> int:
        return max(self.line, self.end)


@dataclass(frozen=True)
class Candidate:
    path: str
    line: int
    term: str


@dataclass
class FileChange:
    path: str
    status: str
    kind: str  # code | doc | ignored | other


@dataclass
class Analysis:
    in_scope: bool
    reason: str
    sentences: list[tuple[str, Unit]]
    vanished: list[tuple[str, Unit, bool]]  # (檔, 段名, 要不要擋：含對照詞與文件標題不擋)
    candidates: list[Candidate]


def norm(text: str) -> str:
    return re.sub(r'[\s`\\|*]', '', text)


def scan(text: str, ext: str) -> tuple[str, Comments]:
    """回傳 (去掉註解、字串內容清空、空白壓平後的程式碼, 註解們)。註解是 (起始行, 每行文字, 是不是獨占一行)。"""
    slash = ext in SLASH
    marker = '' if ext == '.css' else '//' if slash else '#'
    rust = ext == '.rs'
    code: list[str] = []
    comments: Comments = []
    i, n, line = 0, len(text), 1
    has_code = False
    while i < n:
        c = text[i]
        if c == '\n':
            code.append('\n')
            line += 1
            has_code = False
            i += 1
        elif slash and text.startswith('/*', i):
            depth, j = 1, i + 2
            while j < n and depth:
                if rust and text.startswith('/*', j):
                    depth, j = depth + 1, j + 2
                elif text.startswith('*/', j):
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            raw = text[i + 2 : j - 2 if depth == 0 else j]
            parts = raw.split('\n')
            cleaned = [parts[0].lstrip('*').strip()] + [re.sub(r'^\s*\*+ ?', '', p).strip() for p in parts[1:]]
            comments.append((line, cleaned, not has_code))
            line += len(parts) - 1
            i = j
        elif marker and text.startswith(marker, i) and (slash or i == 0 or text[i - 1] in ' \t\n'):
            j = text.find('\n', i)
            j = n if j == -1 else j
            body = text[i + len(marker) : j]
            if marker == '//':
                body = body.lstrip('/')
            comments.append((line, [body.strip()], not has_code))
            i = j
        elif c in '"\'`':
            if ext == '.py' and text.startswith(c * 3, i):
                end = text.find(c * 3, i + 3)
                end = n if end == -1 else end + 3
                line += text.count('\n', i, end)
                code.append('""')
                has_code = True
                i = end
                continue
            if rust and c == "'" and not re.match(r"'(?:\\[^']*|[^\\'])'", text[i : i + 12]):
                code.append(c)
                has_code = True
                i += 1
                continue
            multiline = c == '`' or (rust and c == '"')
            j = i + 1
            while j < n and text[j] != c:
                if text[j] == '\\':
                    j += 1
                elif text[j] == '\n' and not multiline:
                    break
                j += 1
            j = min(j, n)
            line += text.count('\n', i, j)
            code.append(c + c)
            has_code = True
            i = j + 1 if j < n and text[j] == c else j
        else:
            code.append(c)
            has_code = has_code or not c.isspace()
            i += 1
    return re.sub(r'\s+', ' ', ''.join(code)).strip(), comments


def units(comments: Comments) -> list[Unit]:
    """連續獨占一行的行註解併成一塊；標題、表格列各自成一句，其餘併成段後照句號切。"""
    blocks: list[tuple[int, list[str]]] = []
    prev_end, prev_joinable = -2, False
    for start, lines, own in comments:
        joinable = own and len(lines) == 1
        if joinable and prev_joinable and start == prev_end + 1:
            blocks[-1][1].extend(lines)
        else:
            blocks.append((start, list(lines)))
        prev_end, prev_joinable = start + len(lines) - 1, joinable
    out: list[Unit] = []
    for start, lines in blocks:
        para: list[tuple[int, str]] = []

        def flush() -> None:
            if not para:
                return
            text = ' '.join(t for _, t in para)
            line_at: list[int] = []
            for number, t in para:
                line_at += [number] * (len(t) + 1)
            pos = 0
            for cut in [*SENTENCE_END.finditer(text), None]:
                end = len(text) if cut is None else cut.start()
                segment = text[pos:end]
                if segment.strip():
                    first = pos + len(segment) - len(segment.lstrip())
                    last = pos + len(segment.rstrip()) - 1
                    out.append(Unit(line_at[first], segment.strip(), line_at[last]))
                pos = end if cut is None else cut.end()
            para.clear()

        for offset, raw in enumerate(lines):
            s = raw.strip()
            if not s:
                flush()
            elif HEADING.match(s) or TABLE_ROW.match(s):
                flush()
                out.append(Unit(start + offset, s, start + offset))
            else:
                if LIST_START.match(s):
                    flush()
                para.append((start + offset, s))
        flush()
    return [u for u in out if TABLE_ROW.match(u.text) or (len(norm(u.text)) >= 2 and re.search(r'\w', u.text))]


def is_separator(row: str) -> bool:
    cells = [c.strip() for c in row.strip('|').split('|')]
    return bool(TABLE_ROW.match(row)) and all(SEPARATOR_CELL.match(c) for c in cells if c)


def names(found: list[Unit]) -> list[Unit]:
    out: list[Unit] = []
    for i, u in enumerate(found):
        heading = HEADING.match(u.text)
        if heading:
            out.append(Unit(u.line, heading.group(1).strip('`*')))
        elif TABLE_ROW.match(u.text):
            cells = [c.strip() for c in u.text.strip('|').split('|')]
            if all(SEPARATOR_CELL.match(c) or not c for c in cells) or (i + 1 < len(found) and is_separator(found[i + 1].text)):
                continue
            cell = next((c for c in cells if c and not NUMERIC_CELL.match(c)), '').strip('`*')
            if 2 <= len(cell) <= MAX_NAME_CELL:
                out.append(Unit(u.line, cell))
    return out


def markdown_headings(text: str) -> list[Unit]:
    out, fenced = [], False
    for number, raw in enumerate(text.split('\n'), 1):
        if raw.lstrip().startswith('```'):
            fenced = not fenced
        elif not fenced and (m := HEADING.match(raw)):
            out.append(Unit(number, m.group(1).strip('`*')))
    return out


def core_of(name: str) -> str:
    return re.sub(r'\s*[（(][^）)]*[）)]\s*', ' ', name).strip()


def terms_of(name: str) -> list[str]:
    plain = core_of(name)
    found = [name, plain]
    for token in re.split(r'[\s、，,：:/]+', plain):
        token = token.strip('`*')
        cjk = len(re.findall(r'[一-鿿]', token))
        if (cjk >= 2 and cjk >= len(token) - 2) or (cjk == 0 and len(token) >= 8):
            found.append(token)
    out: list[str] = []
    for t in found:
        if len(t) >= 2 and t not in out:
            out.append(t)
    return out


def git(*args: str, check: bool = True) -> str:
    done = subprocess.run(['git', *args], cwd=ROOT, capture_output=True)
    if check and done.returncode != 0:
        raise SystemExit(f'git {" ".join(args)} 失敗：{done.stderr.decode("utf-8", "replace").strip()}')
    return done.stdout.decode('utf-8', 'replace')


@functools.lru_cache(maxsize=None)
def show(rev: str, path: str) -> str:
    done = subprocess.run(['git', 'show', f'{rev}:{path}'], cwd=ROOT, capture_output=True)
    return done.stdout.decode('utf-8', 'replace') if done.returncode == 0 else ''


def ext_of(path: str) -> str:
    name = path.rsplit('/', 1)[-1]
    return '.' + name.rsplit('.', 1)[-1] if '.' in name else ''


def classify(path: str) -> str:
    if path.endswith('.md'):
        return 'doc'
    if canonical(path).startswith(IGNORED_PREFIXES):
        return 'ignored'
    return 'code' if ext_of(path) in LANGS else 'other'


def changes(base: str, head: str) -> list[FileChange]:
    parts = git('diff', '--name-status', '--no-renames', '-z', f'{base}...{head}').split('\0')
    return [FileChange(path, status, classify(path)) for status, path in zip(parts[0::2], parts[1::2])]


def added_lines(base: str, head: str) -> dict[str, set[int]]:
    out: dict[str, set[int]] = {}
    path = ''
    for ln in git('diff', '-U0', '--no-renames', f'{base}...{head}').split('\n'):
        if ln.startswith('+++ b/'):
            path = ln[6:]
        elif ln.startswith('@@') and (m := re.search(r'\+(\d+)(?:,(\d+))?', ln)):
            start, count = int(m.group(1)), int(m.group(2) or 1)
            out.setdefault(path, set()).update(range(start, start + count))
    return out


def owners_of(path: str, head: str) -> list[str]:
    """指到這個檔的寫法：路徑本身，加上所屬套件的名字與目錄。"""
    out = [path]
    parts = path.split('/')
    if parts[0] == 'web':
        project = 'web'
    else:
        lead = 1 if parts[0] == 'harness' else 0
        project = '/'.join(parts[: lead + 2]) if parts[lead:lead + 1] in (['apps'], ['packages']) and len(parts) > lead + 2 else ''
    if project:
        out.append(project)
        try:
            name = json.loads(show(head, project + '/package.json')).get('name')
        except ValueError:
            name = None
        if isinstance(name, str) and name:
            out.append(name)
    return out


def grep_lines(term: str, head: str) -> list[tuple[str, int, str]]:
    out = []
    for ln in git('grep', '-n', '-I', '-F', '-e', term, head, '--', check=False).split('\n'):
        m = re.match(rf'^{re.escape(head)}:(.+?):(\d+):(.*)$', ln)
        if m and not canonical(m.group(1)).startswith(SEARCH_EXCLUDED) and m.group(1).rsplit('/', 1)[-1] not in SEARCH_EXCLUDED_NAMES and not HEADING_LINE.match(m.group(3)):
            out.append((m.group(1), int(m.group(2)), m.group(3)))
    return out


def find_candidates(vanished: list[tuple[str, Unit, bool]], head: str, skip: dict[str, set[int]]) -> list[Candidate]:
    """指向消失段名的候選：行裡有段名（全名或去掉括號的名），又指到那個檔或寫了「檔頭」；或指到那個檔，又寫了「檔頭」或段名的簡寫。"""
    found: dict[tuple[str, int], Candidate] = {}
    for path, name, _ in vanished:
        terms = terms_of(name.text)
        names_ = list(dict.fromkeys(terms[:1] + [core_of(name.text)]))
        tokens = [t for t in terms if t not in names_]
        owners = owners_of(path, head)
        for term in names_:
            for p, number, text in grep_lines(term, head):
                if any(o in text for o in owners) or any(h in text for h in HEADER_WORDS):
                    found.setdefault((p, number), Candidate(p, number, term))
        for owner in owners:
            for p, number, text in grep_lines(owner, head):
                hit = next((t for t in HEADER_WORDS + tuple(tokens) if t in text), None)
                if hit:
                    found.setdefault((p, number), Candidate(p, number, hit))
    return sorted((c for c in found.values() if c.line not in skip.get(c.path, set())), key=lambda c: (c.path, c.line))


def analyze(base: str, head: str) -> Analysis:
    def out_of_scope(why: str) -> Analysis:
        return Analysis(False, why, [], [], [])

    sentences: list[tuple[str, Unit]] = []
    vanished: list[tuple[str, Unit, bool]] = []
    before = after = 0
    for f in changes(base, head):
        if f.kind == 'other':
            return out_of_scope(f'{f.path} 不是註解可以涵蓋的檔，程式碼有變')
        if f.kind == 'ignored':
            continue
        old_text = show(base, f.path)
        new_text = show(head, f.path) if f.status != 'D' else ''
        if f.kind == 'doc':
            have = {n.text for n in markdown_headings(new_text)}
            vanished += [(f.path, n, False) for n in markdown_headings(old_text) if n.text not in have]
            continue
        if f.status != 'M':
            return out_of_scope(f'{f.path} 是新增或刪除的程式碼檔')
        old_code, old_comments = scan(old_text, ext_of(f.path))
        new_code, new_comments = scan(new_text, ext_of(f.path))
        if old_code != new_code:
            return out_of_scope(f'{f.path} 除了註解與字串內容，程式碼也變了')
        before, after = before + reference_lines(old_text), after + reference_lines(new_text)
        old_units, new_units = units(old_comments), units(new_comments)
        seen = Counter(norm(u.text) for u in old_units)
        for u in new_units:
            if seen[norm(u.text)] > 0:
                seen[norm(u.text)] -= 1
            elif not is_separator(u.text):
                sentences.append((f.path, u))
        have_names = Counter(core_of(n.text) for n in names(new_units))
        for n in names(old_units):
            core = core_of(n.text)
            if have_names[core] > 0:
                have_names[core] -= 1
            else:
                vanished.append((f.path, n, not reference_lines(core)))
    if after >= before:
        return out_of_scope(f'對照詞的行數沒有下降（{before} → {after}）')
    candidates = find_candidates(vanished, head, added_lines(base, head)) if vanished else []
    return Analysis(True, f'對照詞的行數 {before} → {after}，程式碼只有註解與字串內容變了', sentences, vanished, candidates)


def line_exists(head: str, path: str, line: int) -> bool:
    text = show(head, path)
    return bool(text) and 1 <= line <= len(text.rstrip('\n').split('\n'))


def valid_refs(row: str, head: str, exclude: tuple[str, int, int] | None = None) -> list[tuple[str, int, int]]:
    out = []
    for m in REF.finditer(row):
        path, lo = m.group(1), int(m.group(2))
        hi = int(m.group(3) or lo)
        if exclude and path == exclude[0] and lo <= exclude[2] and hi >= exclude[1]:
            continue
        if lo <= hi and line_exists(head, path, lo) and line_exists(head, path, hi):
            out.append((path, lo, hi))
    return out


def cells_of(row: str) -> list[str]:
    return [c.strip() for c in re.split(r'(?<!\\)\|', row.strip().strip('|'))]


def reason_of(text: str, term: str) -> str:
    return re.sub(r'[\s|`*\-–:：，。、,.]', '', REF.sub('', text.replace(term, '')))


def table_rows(body: str) -> list[list[str]]:
    return [cells_of(r) for r in body.split('\n') if TABLE_ROW.match(r.strip()) and PLACEHOLDER not in r]


def verify(a: Analysis, body: str, head: str) -> list[str]:
    errors: list[str] = []
    rows = table_rows(body)
    for path, u in a.sentences:
        key = norm(u.text)
        hit = [r for r in rows if len(r) >= 2 and norm(r[0]) == key]
        where = f'{path}:{u.line} 的句子「{u.text[:60]}」'
        if not hit:
            errors.append(f'規則 1：{where}，內文沒有對應的一列。整句刪掉，或照 `| 整句 | 位置 | path:line |` 補一列，整句放第一格。')
        elif not any(valid_refs(' '.join(r[1:]), head, exclude=(path, u.line, u.last)) for r in hit):
            errors.append(f'規則 1：{where}，那一列後面的格子沒有在 head 上存在的 nexus 實作 path:line（句子跨到的每一行都不算）。')
    for path, n, blocking in a.vanished:
        if blocking:
            errors.append(f'規則 2：{path}:{n.line} 的段名「{n.text}」在這個檔消失了。階段 1 不改段名，改名留給階段 2，跟所有指向同一張 PR 改。')
    for c in a.candidates:
        if not any(
            len(r) >= 3
            and any(p == c.path and lo <= c.line <= hi for p, lo, hi in valid_refs(r[0], head))
            and len(reason_of(r[-1], c.term)) >= MIN_REASON
            for r in rows
        ):
            errors.append(
                f'規則 3：{c.path}:{c.line} 可能指向消失的「{c.term}」，要在這張 PR 改掉，或照 `| path:line | 詞 | 為什麼仍成立 |` 補一列，理由放最後一格。'
            )
    return errors


def span(u: Unit) -> str:
    return str(u.line) if u.last == u.line else f'{u.line}-{u.last}'


def report(a: Analysis) -> str:
    pipe = '\\|'
    lines = ['## 規則 1：改寫與新增的註解句（貼進內文，整句放第一格，最後一格補 nexus 實作的 path:line，不用改位置那格）', '', '| 句子 | 位置 | nexus 實作的 path:line |', '| --- | --- | --- |']
    lines += [f'| {u.text.replace("|", pipe)} | {path} 第 {span(u)} 行 | {PLACEHOLDER}：path:line> |' for path, u in a.sentences] or ['| （沒有） | | |']
    lines += ['', '## 規則 2：消失的段名', '']
    lines += [
        f'- {path}:{n.line}「{n.text}」' + ('' if blocking else '（含對照詞或是文件標題，不擋，改走規則 3）')
        for path, n, blocking in a.vanished
    ] or ['- （沒有）']
    lines += ['', '## 規則 3：可能指向消失段名的地方（每一個要改掉，或在內文留一列，最後一格寫為什麼仍成立）', '', '| 位置 | 命中的詞 | 為什麼仍成立 |', '| --- | --- | --- |']
    lines += [f'| {c.path}:{c.line} | {c.term} | {PLACEHOLDER}：理由> |' for c in a.candidates] or ['| （沒有） | | |']
    return '\n'.join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', help='比對的起點，預設 origin/develop 與 head 的分歧點')
    parser.add_argument('--head', default='HEAD')
    parser.add_argument('--root', help='要檢查的 repo，預設是這支 script 所在的 repo')
    parser.add_argument('--body-file', help='PR 內文；沒給時讀環境變數 BODY，兩者都沒有就只印出要填的列')
    parser.add_argument('--print', action='store_true', dest='print_rows', help='不驗內文，只印出要填的列')
    parser.add_argument('--in-scope', action='store_true', help='只回答這張 PR 在不在範圍內：印 true 或 false')
    args = parser.parse_args()

    if args.root:
        globals()['ROOT'] = Path(args.root).resolve()
    head = git('rev-parse', args.head).strip()
    base = args.base or git('merge-base', 'origin/develop', head).strip()
    a = analyze(base, head)
    if args.in_scope:
        print('true' if a.in_scope else 'false')
        return 0
    if not a.in_scope:
        print(f'不是清外部對照的 PR（{a.reason}），略過。')
        return 0
    body = None if args.print_rows else Path(args.body_file).read_text(encoding='utf-8') if args.body_file else os.environ.get('BODY')
    if body is None:
        print(f'清外部對照的 PR：{a.reason}。\n')
        print(report(a))
        return 0
    errors = verify(a, body, head)
    for e in errors:
        print(f'::error::{e}')
    if errors:
        print('\n本機跑 `python3 .github/scripts/check_dsh_cleanup.py` 可以印出要填的列。')
        return 1
    print(f'清外部對照的證據通過：{len(a.sentences)} 句、{len(a.vanished)} 個消失的段名、{len(a.candidates)} 個候選指向。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
