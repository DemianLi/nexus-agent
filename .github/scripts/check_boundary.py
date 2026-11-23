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

WEB = 'apps/web'
HARNESS = 'apps/harness'
WIRE_PACKAGE = 'packages/nexus-wire'
WIRE_SPECIFIER = '@nexus/wire'
WEB_SPECIFIER = '@nexus/web'

CODE_SUFFIXES = ('.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs')
SKIPPED_DIRS = {'node_modules', 'dist', '.git', 'coverage', '.turbo'}

WEB_FORBIDDEN_PREFIXES = ('apps/harness', 'docs', 'scripts', 'vendor', 'references', '.github')


@dataclass(frozen=True)
class Exemption:
    path: str
    rule: str
    reason: str


EXEMPTIONS: tuple[Exemption, ...] = (
    Exemption(
        'apps/web/e2e/*',
        'web-path',
        '端到端測試起真的 harness（`apps/harness/src/serve.ts`）與真的瀏覽器，對著它跑；那是這組測試要驗的東西。'
        '倉庫拆開後這組測試的歸屬留給 E 卡。',
    ),
    Exemption(
        'apps/web/scripts/measure-frames.mjs',
        'web-path',
        '量測腳本要起真的 harness 才量得到畫格；留給 E 卡。',
    ),
    Exemption(
        'apps/harness/package.json',
        'harness-spec',
        'harness 供應網頁 dist（`serve-run.ts` 的 `webDistDir`）：宣告對 web 的建置相依。留給 E 卡。',
    ),
    Exemption(
        'apps/harness/src/serve-run.ts',
        'harness-spec',
        'harness 供應網頁 dist：`require.resolve(\'@nexus/web/package.json\')` 找 dist 目錄。留給 E 卡。',
    ),
    Exemption(
        'apps/harness/src/third-party-notices.test.ts',
        'harness-path',
        '第三方授權彙整的測試用假 repo 當夾具，夾具裡的 `apps/web/package.json` 是假 repo 的內容，不讀真的 web。留給 E 卡。',
    ),
    Exemption(
        'apps/harness/src/typecheck-projects.test.ts',
        'harness-path',
        'typecheck 專案清單的規則本來就把 `apps/web` 排除（web 單獨 `tsc --noEmit`）：比的是目錄名，不讀 web 的內容。',
    ),
)


@dataclass(frozen=True)
class Literal:
    line: int
    value: str
    start: int = 0
    end: int = 0


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
            out.extend(Literal(line + k, v, i, i) for k, v in parts)
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


def path_segments(text: str, literals: list[Literal]) -> list[tuple[Literal, list[str]]]:
    runs: list[tuple[Literal, list[str]]] = []
    current: list[Literal] = []
    for lit in literals:
        segment = lit.end > lit.start and '/' not in lit.value
        if segment and current and re.fullmatch(r'\s*,\s*', text[current[-1].end : lit.start]):
            current.append(lit)
            continue
        if len(current) > 1:
            runs.append((current[0], [item.value for item in current]))
        current = [lit] if segment else []
    if len(current) > 1:
        runs.append((current[0], [item.value for item in current]))
    return runs


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
    return under(path, 'packages') and not under(path, WIRE_PACKAGE)


def web_findings(file: str, text: str) -> list[tuple[int, str, str]]:
    found: list[tuple[int, str, str]] = []
    literals = string_literals(text)
    for first, segments in path_segments(text, literals):
        joined = '/'.join(segments)
        if re.search(r'(^|/)apps/harness(/|$)', joined) or re.search(r'(^|/)packages/(?!nexus-wire(/|$))', joined):
            found.append((first.line, 'web-path', f'web 不准用路徑讀 wire 以外的 harness 內容：`{joined}`。'))
    for lit in literals:
        value = lit.value
        if value.startswith('@nexus/') and at_import_position(text, lit) and value.split('/')[0:2] != ['@nexus', 'wire']:
            found.append((lit.line, 'web-spec', f'web 不准 import `{value}`：web 只能相依 `{WIRE_SPECIFIER}`。'))
        elif is_relative(value):
            target = resolve(file, value)
            if target is not None and web_forbidden(target):
                found.append(
                    (lit.line, 'web-path', f'web 不准用路徑讀 wire 以外的 harness 內容：`{value}` 指到 `{target}`。')
                )
        elif re.search(r'(^|[/\s])apps/harness(/|$)', value):
            found.append((lit.line, 'web-path', f'web 不准用路徑讀 harness：`{value}`。'))
    return found


def harness_findings(file: str, text: str) -> list[tuple[int, str, str]]:
    found: list[tuple[int, str, str]] = []
    literals = string_literals(text)
    for first, segments in path_segments(text, literals):
        joined = '/'.join(segments)
        if re.search(r'(^|/)apps/web(/|$)', joined):
            found.append((first.line, 'harness-path', f'harness 不准掃或讀 web：`{joined}`。'))
    for lit in literals:
        value = lit.value
        if (value == WEB_SPECIFIER or value.startswith(WEB_SPECIFIER + '/')) and at_import_position(text, lit):
            found.append((lit.line, 'harness-spec', f'harness 不准 import `{value}`。'))
        elif is_relative(value):
            target = resolve(file, value)
            if target is not None and under(target, WEB):
                found.append(
                    (lit.line, 'harness-path', f'harness 不准掃或讀 web：`{value}` 指到 `{target}`。')
                )
        elif re.search(r'(^|[/\s])apps/web(/|$)', value):
            found.append((lit.line, 'harness-path', f'harness 不准掃或讀 web：`{value}`。'))
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
    for base, finder in ((WEB, web_findings), (HARNESS, harness_findings)):
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='web 與 harness 的邊界檢查：web 只能相依 wire；harness 不掃、不 import web。')
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args(argv)
    errors = check(args.root)
    for error in errors:
        print(f'::error::{error}')
    if errors:
        print(f'邊界檢查：{len(errors)} 處違規。例外在 .github/scripts/check_boundary.py 的 EXEMPTIONS 逐條列出，加一條要寫理由。')
        return 1
    print('邊界檢查：web 只相依 wire，harness 不碰 web（例外 %d 條，見 EXEMPTIONS）。' % len(EXEMPTIONS))
    return 0


if __name__ == '__main__':
    sys.exit(main())
