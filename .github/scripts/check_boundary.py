"""web 與 `harness/` 的邊界檢查（字串比對；掃 `web`、`harness/apps/harness` 與 `harness/scripts`，後兩者算 harness 一側）。

只看程式碼裡的字串字面值與樣板字串的靜態片段，不做資料流分析：變數拼出來的路徑、
`--filter '@nexus/web'` 這類參數字串、`node_modules/@nexus/web/dist` 這類安裝後的路徑都不保證抓得到，留給拆倉後的實體邊界。
相對路徑解析到 repo 根不算越界。
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import posixpath
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

WEB = 'web'
HARNESS = 'harness/apps/harness'
SCRIPTS = 'harness/scripts'
WIRE_PACKAGE = 'harness/packages/nexus-wire'
HARNESS_ROOT = 'harness'
WIRE_SPECIFIER = '@nexus/wire'
WEB_SPECIFIER = '@nexus/web'

CODE_SUFFIXES = ('.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs')
SKIPPED_DIRS = {'node_modules', 'dist', '.git', 'coverage', '.turbo'}

WEB_FORBIDDEN_PREFIXES = ('docs', 'references', '.github')


@dataclass(frozen=True)
class Exemption:
    path: str
    rule: str
    reason: str


EXEMPTIONS: tuple[Exemption, ...] = (
    Exemption(
        'web/e2e/*',
        'web-path',
        '端到端測試起真的 harness（`harness/apps/harness/src/serve.ts`）與真的瀏覽器，對著它跑；那是這組測試要驗的東西。'
        '倉庫拆開後這組測試的歸屬留給 E 卡。',
    ),
    Exemption(
        'web/scripts/measure-frames.mjs',
        'web-path',
        '量測腳本要起真的 harness 才量得到畫格；留給 E 卡。',
    ),
    Exemption(
        'harness/scripts/gen-third-party-notices.ts',
        'harness-path',
        '授權彙整要讀 `web` 的相依與內建字型，並真的 build 一次 web（`:450`、`:531`）；留給拆倉那張卡。',
    ),
    Exemption(
        'harness/scripts/gen-tsconfig-paths.ts',
        'harness-path',
        '產生 tsconfig paths 要讀 `apps/web/tsconfig.json`（`:52`）；留給拆倉那張卡。',
    ),
    Exemption(
        'harness/apps/harness/package.json',
        'harness-spec',
        'harness 供應網頁 dist（`serve-run.ts` 的 `webDistDir`）：宣告對 web 的建置相依。留給 E 卡。',
    ),
    Exemption(
        'harness/apps/harness/src/release-scripts.test.ts',
        'harness-path',
        '發版成員要含 web：測試核對成員清單等於 `pnpm-workspace.yaml` 的群組展開（扣掉 `harness/vendor/*`），並斷言 `web/package.json` 在內。',
    ),
    Exemption(
        'harness/apps/harness/src/serve-run.ts',
        'harness-spec',
        'harness 供應網頁 dist：`require.resolve(\'@nexus/web/package.json\')` 找 dist 目錄。留給 E 卡。',
    ),
    Exemption(
        'harness/apps/harness/src/third-party-notices.test.ts',
        'harness-path',
        '第三方授權彙整（卡上例外 2）：測試對真的 repo 呼叫 `render()`，`harness/scripts/gen-third-party-notices.ts` 會讀 `web` 並 build web；'
        '檔裡另有幾處假 repo 夾具字串 `web/package.json`。留給 E 卡。',
    ),
)


@dataclass(frozen=True)
class Literal:
    line: int
    value: str
    start: int = 0
    end: int = 0
    template: bool = False


def string_literals(text: str) -> list[Literal]:
    """程式碼裡的字串字面值（含樣板字串的靜態片段），不含註解。"""
    out: list[Literal] = []
    n = len(text)
    i = 0
    line = 1
    prev = ''

    def skip_string(quote: str, start: int) -> tuple[int, str, int]:
        j = start + 1
        buf: list[str] = []
        newlines = 0
        while j < n:
            c = text[j]
            if c == '\\' and j + 1 < n:
                buf.append(text[j + 1])
                if text[j + 1] == '\n':
                    newlines += 1
                j += 2
                continue
            if c == quote:
                return j + 1, ''.join(buf), newlines
            if c == '\n' and quote != '`':
                return j, ''.join(buf), newlines
            if c == '\n':
                newlines += 1
            buf.append(c)
            j += 1
        return j, ''.join(buf), newlines

    def skip_template(start: int) -> tuple[int, list[tuple[int, str]], int]:
        j = start + 1
        parts: list[tuple[int, str]] = []
        buf: list[str] = []
        newlines = 0
        while j < n:
            c = text[j]
            if c == '\\' and j + 1 < n:
                buf.append(text[j + 1])
                j += 2
                continue
            if c == '`':
                parts.append((newlines, ''.join(buf)))
                return j + 1, parts, newlines
            if c == '$' and j + 1 < n and text[j + 1] == '{':
                parts.append((newlines, ''.join(buf)))
                buf = []
                depth = 1
                j += 2
                while j < n and depth > 0:
                    d = text[j]
                    if d == '{':
                        depth += 1
                    elif d == '}':
                        depth -= 1
                    elif d in '\'"':
                        j, inner, _ = skip_string(d, j)
                        parts.append((newlines, inner))
                        continue
                    elif d == '`':
                        j, inner_parts, inner_newlines = skip_template(j)
                        parts.extend((newlines + k, v) for k, v in inner_parts)
                        newlines += inner_newlines
                        continue
                    elif d == '\n':
                        newlines += 1
                    j += 1
                continue
            if c == '\n':
                newlines += 1
            buf.append(c)
            j += 1
        return j, parts, newlines

    regex_before = set('(,=:[!&|?{};+-*%<>~^')
    while i < n:
        c = text[i]
        if c == '\n':
            line += 1
            i += 1
            continue
        if c == '/' and i + 1 < n and text[i + 1] == '/':
            while i < n and text[i] != '\n':
                i += 1
            continue
        if c == '/' and i + 1 < n and text[i + 1] == '*':
            end = text.find('*/', i + 2)
            end = n if end < 0 else end + 2
            line += text.count('\n', i, end)
            i = end
            continue
        if c in '\'"':
            j, value, newlines = skip_string(c, i)
            out.append(Literal(line, value, i, j))
            line += newlines
            i = j
            prev = c
            continue
        if c == '`':
            j, parts, newlines = skip_template(i)
            out.extend(Literal(line + k, v, i, i, True) for k, v in parts)
            line += newlines
            i = j
            prev = c
            continue
        if c == '/' and (prev == '' or prev in regex_before):
            j = i + 1
            in_class = False
            while j < n and text[j] != '\n':
                d = text[j]
                if d == '\\':
                    j += 2
                    continue
                if d == '[':
                    in_class = True
                elif d == ']':
                    in_class = False
                elif d == '/' and not in_class:
                    break
                j += 1
            i = j + 1
            prev = '/'
            continue
        if not c.isspace():
            prev = c
        i += 1
    return out


IMPORT_POSITION = re.compile(
    r'(?:\bfrom|\bimport\s*\(?|\brequire\s*\(|\bmock\s*\(|\bdoMock\s*\(|\bimportActual\s*\(|\bresolve\s*\()\s*$'
)


def at_import_position(text: str, lit: Literal) -> bool:
    return IMPORT_POSITION.search(text[max(0, lit.start - 40) : lit.start]) is not None


def path_segments(text: str, literals: list[Literal], min_len: int = 2) -> list[tuple[Literal, list[str]]]:
    runs: list[tuple[Literal, list[str]]] = []
    current: list[Literal] = []
    for lit in literals:
        segment = lit.end > lit.start and re.fullmatch(r'[^\s{}/]+/?', lit.value) is not None
        if segment and current and re.fullmatch(r'\s*,\s*', text[current[-1].end : lit.start]):
            current.append(lit)
            continue
        if len(current) >= min_len:
            runs.append((current[0], [piece for item in current for piece in pieces(item.value)]))
        current = [lit] if segment else []
    if len(current) >= min_len:
        runs.append((current[0], [piece for item in current for piece in pieces(item.value)]))
    return runs


def pieces(value: str) -> list[str]:
    return [piece for piece in value.split('/') if piece]


def expand_braces(value: str) -> list[str]:
    match = re.search(r'\{([^{}]*)\}', value)
    if match is None or ',' not in match.group(1):
        return [value]
    out: list[str] = []
    for option in match.group(1).split(','):
        out.extend(expand_braces(value[: match.start()] + option + value[match.end() :]))
    return out


def is_relative(value: str) -> bool:
    return value == '..' or value.startswith('./') or value.startswith('../')


def resolve(file: str, value: str) -> str | None:
    joined = posixpath.normpath(posixpath.join(posixpath.dirname(file), value))
    if joined == '..' or joined.startswith('../'):
        return None
    return joined


def under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + '/')


def web_forbidden(path: str) -> bool:
    if any(under(path, prefix) for prefix in WEB_FORBIDDEN_PREFIXES):
        return True
    return under(path, HARNESS_ROOT) and not under(path, WIRE_PACKAGE)


URL_POSITION = re.compile(r'\bURL\s*\(\s*$')


def relative_paths(file: str, text: str, literals: list[Literal]) -> list[tuple[int, str, str | None, bool]]:
    found: list[tuple[int, str, str | None, bool]] = []
    for lit in literals:
        if is_relative(lit.value):
            as_path = URL_POSITION.search(text[max(0, lit.start - 20) : lit.start]) is not None
            found.append((lit.line, lit.value, resolve(file, lit.value), as_path))
    for first, segments in path_segments(text, literals):
        joined = '/'.join(segments)
        if is_relative(joined):
            found.append((first.line, joined, resolve(file, joined), True))
    return found


HARNESS_SEGMENT = re.compile(r'(^|[/\s])harness/(apps(/|$)|packages(?!/nexus-wire(/|$))(/|$))')
HARNESS_LITERAL = re.compile(r'(^|[/\s])harness/apps/harness(/|$)')
WEB_CONTENT = r'(src|e2e|dist|public|guard|tokengen|scripts|package\.json|tsconfig[\w.-]*|vite\.config[\w.]*|index\.html)'
WEB_LITERAL = re.compile(r'(^|[/\s])(?<!@nexus/)web/' + WEB_CONTENT + r'(/|$)')
WEB_RUN = re.compile(r'(^|/)(?<!@nexus/)web(/' + WEB_CONTENT + r'(/|$)|$)')


def web_findings(file: str, text: str) -> list[tuple[int, str, str]]:
    found: list[tuple[int, str, str]] = []
    literals = string_literals(text)
    for first, segments in path_segments(text, literals):
        joined = '/'.join(segments)
        if HARNESS_SEGMENT.search(joined):
            found.append((first.line, 'web-path', f'web 不准用路徑讀 wire 以外的 harness 內容：`{joined}`。'))
    for line, value, target, as_path in relative_paths(file, text, literals):
        if target is not None and web_forbidden(target):
            found.append((line, 'web-path', f'web 不准用路徑讀 wire 以外的 harness 內容：`{value}` 指到 `{target}`。'))
    for lit in literals:
        value = lit.value
        if value.startswith('@nexus/') and at_import_position(text, lit) and value.split('/')[0:2] != ['@nexus', 'wire']:
            found.append((lit.line, 'web-spec', f'web 不准 import `{value}`：web 只能相依 `{WIRE_SPECIFIER}`。'))
        elif not is_relative(value):
            for variant in expand_braces(lit.value):
                if HARNESS_LITERAL.search(variant):
                    found.append((lit.line, 'web-path', f'web 不准用路徑讀 harness：`{value}`。'))
                    break
    return found


def harness_findings(file: str, text: str) -> list[tuple[int, str, str]]:
    found: list[tuple[int, str, str]] = []
    literals = string_literals(text)
    for first, segments in path_segments(text, literals):
        joined = '/'.join(segments)
        if WEB_RUN.search(joined) and joined != 'web':
            found.append((first.line, 'harness-path', f'harness 不准掃或讀 web：`{joined}`。'))
    for line, value, target, as_path in relative_paths(file, text, literals):
        if target is not None and under(target, WEB):
            found.append((line, 'harness-path', f'harness 不准掃或讀 web：`{value}` 指到 `{target}`。'))
    for lit in literals:
        value = lit.value
        if (value == WEB_SPECIFIER or value.startswith(WEB_SPECIFIER + '/')) and at_import_position(text, lit):
            found.append((lit.line, 'harness-spec', f'harness 不准 import `{value}`。'))
        elif not is_relative(value):
            for variant in expand_braces(lit.value):
                if WEB_LITERAL.search(variant):
                    found.append((lit.line, 'harness-path', f'harness 不准掃或讀 web：`{value}`。'))
                    break
    return found


def manifest_findings(file: str, text: str) -> list[tuple[int, str, str]]:
    data = json.loads(text)
    found: list[tuple[int, str, str]] = []
    for section in ('dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'):
        for name in data.get(section, {}):
            if file.startswith(WEB + '/') and name.startswith('@nexus/') and name != WIRE_SPECIFIER:
                found.append((0, 'web-spec', f'web 的 `{section}` 不准有 `{name}`：web 只能相依 `{WIRE_SPECIFIER}`。'))
            if file.startswith(HARNESS + '/') and name == WEB_SPECIFIER:
                found.append((0, 'harness-spec', f'harness 的 `{section}` 不准有 `{name}`。'))
    return found


def files_under(root: Path, base: str) -> list[str]:
    out: list[str] = []
    start = root / base
    if not start.is_dir():
        return out
    stack = [start]
    while stack:
        current = stack.pop()
        for entry in sorted(current.iterdir()):
            if entry.is_dir():
                if entry.name not in SKIPPED_DIRS:
                    stack.append(entry)
            elif entry.suffix in CODE_SUFFIXES or entry.name == 'package.json':
                out.append(entry.relative_to(root).as_posix())
    return sorted(out)


def exempt(file: str, rule: str) -> Exemption | None:
    for item in EXEMPTIONS:
        if item.rule == rule and fnmatch.fnmatch(file, item.path):
            return item
    return None


def check(root: Path) -> list[str]:
    errors: list[str] = []
    used: set[Exemption] = set()
    for base, finder in ((WEB, web_findings), (HARNESS, harness_findings), (SCRIPTS, harness_findings)):
        for file in files_under(root, base):
            text = (root / file).read_text(encoding='utf-8')
            findings = (
                manifest_findings(file, text) if file.endswith('package.json') else finder(file, text)
            )
            for line, rule, message in findings:
                item = exempt(file, rule)
                if item is not None:
                    used.add(item)
                    continue
                where = f'{file}:{line}' if line else file
                errors.append(f'{where}：{message}')
    for item in EXEMPTIONS:
        if item not in used:
            errors.append(
                f'邊界例外 `{item.path}`（{item.rule}）沒有任何命中：它指的位置已經不存在或已經合規，從 '
                '`.github/scripts/check_boundary.py` 的 EXEMPTIONS 拿掉。'
            )
    return errors


def empty_scans(root: Path) -> list[str]:
    return [
        f'`{base}` 底下掃到 0 個程式檔：目錄搬了，WEB 與 HARNESS 的路徑要一起搬，不能少掃了還說通過。'
        for base in (WEB, HARNESS, SCRIPTS)
        if not files_under(root, base)
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='web 與 harness 的邊界檢查：web 只能相依 wire；harness 不掃、不 import web。')
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args(argv)
    errors = [*empty_scans(args.root), *check(args.root)]
    for error in errors:
        print(f'::error::{error}')
    if errors:
        print(f'邊界檢查：{len(errors)} 處違規。例外在 .github/scripts/check_boundary.py 的 EXEMPTIONS 逐條列出，加一條要寫理由。')
        return 1
    print('邊界檢查：web 只相依 wire，harness 與 scripts 不碰 web（例外 %d 條，見 EXEMPTIONS）。' % len(EXEMPTIONS))
    return 0


if __name__ == '__main__':
    sys.exit(main())
