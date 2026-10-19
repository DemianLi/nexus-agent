"""檢查 repo 自寫 Markdown 的相對連結：目標檔要存在，指向 .md 的 `#片段` 要對到那份的標題 slug 或 `<a id>`（#1537）。

照 dsh `scripts/verify-md-links.ts`（687f282e）：

- 掃的檔照它的 PATTERNS，扣掉本 repo 沒有的 `README.zh.md`、`.agents/**`；萬用字元不配點開頭的名字，符號連結指到
  同一份的只掃一次；
- 網址（帶 scheme）、`//` 與 `/` 開頭的不查，純 `#片段` 對本檔查；`?query` 不影響解析；路徑與片段先做百分比解碼；
- 片段只對指向 .md 的判，指向原始碼的 `#L10` 這類不判。

和 dsh 不同的地方：

- `.docs/`（對應 dsh 的 `.agents/notes`）、`.github/`、`apps/` 還沒掃，由 #1755 補。
- 寫成 stdlib 的 Python，跑在 `ci.yml` 的 `plan` job，理由同 `check_upgrade_guides.py`：純文件 PR 會跳過 `static`，
  `plan` 不裝相依，所以沒有 Markdown 解析器，逐行近似。各處往哪一邊偏：
  - 錨點只認 ATX 標題與 `<a id>`。setext 標題、清單項目裡縮排 4 格以上的標題不算，指向它們的連結會被報（報多）。
    縮排程式碼裡的 `<a id>` 會被收成錨點（放過）。
  - fence 用去掉行首空白的行判開關，因為清單項目裡的 fence 本來就縮排；縮排程式碼裡出現 ``` 會被當成 fence 開頭，
    到收尾之前的連結不查（放過）。
  - 連結只認行內的 `[文字](目標)`、`![圖](目標)` 與 `[標籤]: 目標` 定義；跨行的連結文字、`[文字][標籤]` 的參照式不認，
    參照式的目標由那一行定義查到。
"""

from __future__ import annotations

import os
import re
import sys
import unicodedata
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
PATTERNS = [
    'README.md',
    'docs/**/*.md',
    'packages/*.md',
    'packages/*/*.md',
    'packages/*/*/*.md',
    'AGENTS.md',
]
FRONTMATTER = re.compile(r'^---\r?\n([\s\S]*?)\r?\n---\r?\n')
# 引言符號：最多 3 格縮排、`>`、可有一格空白，可以疊好幾層。
QUOTE = re.compile(r'^ {0,3}> ?')
ATX_HEADING = re.compile(r'^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$')
# `[文字](目標)`、`![圖](目標)` 與 `[標籤]: 目標`；目標可以用 `<>` 包起來，後面可以帶標題。
INLINE_LINK = re.compile(r'!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)')
LINK_DEFINITION = re.compile(r'^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$')
INLINE_CODE = re.compile(r'`+[^`]*`+')


def source_paths(root: Path) -> list[Path]:
    """PATTERNS 撈到的檔，照路徑排序；萬用字元不配點開頭的段，realpath 相同的只留第一個。"""
    seen: set[str] = set()
    found: list[Path] = []
    for pattern in PATTERNS:
        matches = [root / pattern] if '*' not in pattern else sorted(root.glob(pattern))
        for path in matches:
            relative = path.relative_to(root).parts
            if any(part.startswith('.') for part in relative) or not path.is_file():
                continue
            real = os.path.realpath(path)
            if real in seen:
                continue
            seen.add(real)
            found.append(path)
    return sorted(found)


def github_slug(heading: str) -> str:
    """照 dsh `githubSlug`：小寫，只留字母、數字、`_`、空白、`-`，空白換成 `-`。"""
    kept = ''.join(c for c in heading.lower() if unicodedata.category(c)[0] in 'LN' or c in '_ -')
    return kept.replace(' ', '-')


def _unquote(line: str) -> str:
    line = line.expandtabs(4)
    while (match := QUOTE.match(line)) is not None:
        line = line[match.end():]
    return line


def document_anchors(source: str) -> set[str]:
    """一份 Markdown 讓連結指得到的錨點：每個 ATX 標題的 slug（重複的照 GitHub 加 -1、-2）與 `<a id>`。

    標題要去掉引言符號之後縮排 0–3 格（CommonMark 4.2），fence 與 HTML 註解裡的不算。
    """
    match = FRONTMATTER.match(source)
    body = source[match.end():] if match else source
    anchors: set[str] = set()
    occurrences: dict[str, int] = {}
    fence: str | None = None
    comment = False
    for line in body.splitlines():
        if comment:
            comment = '-->' not in line
            continue
        quoted = _unquote(line)
        bare = quoted.lstrip()
        if fence is not None:
            if re.match(rf'^{re.escape(fence[0])}{{{len(fence)},}}\s*$', bare):
                fence = None
            continue
        opened = re.match(r'^(`{3,}|~{3,})', bare)
        if opened:
            fence = opened.group(1)
            continue
        if bare.startswith('<!--'):
            comment = '-->' not in bare[4:]
            continue
        for anchor in re.findall(r'<a id="([^"]+)"', INLINE_CODE.sub('', line)):
            anchors.add(anchor)
        heading = ATX_HEADING.match(quoted)
        if heading is None:
            continue
        text = re.sub(r'<[^>]+>', '', heading.group(1) or '')
        text = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', text)
        base = github_slug(text)
        result, bump = base, occurrences.get(base, 0)
        while result in anchors:
            bump += 1
            result = f'{base}-{bump}'
        occurrences[base] = bump
        anchors.add(result)
    return anchors


def link_targets(source: str) -> list[tuple[int, str]]:
    """一份 Markdown 裡連結、圖片與定義的目標與行號；fence、HTML 註解與行內程式碼裡的不算。"""
    targets: list[tuple[int, str]] = []
    fence: str | None = None
    comment = False
    for number, line in enumerate(source.splitlines(), start=1):
        if comment:
            comment = '-->' not in line
            continue
        bare = _unquote(line).lstrip()
        if fence is not None:
            if re.match(rf'^{re.escape(fence[0])}{{{len(fence)},}}\s*$', bare):
                fence = None
            continue
        opened = re.match(r'^(`{3,}|~{3,})', bare)
        if opened:
            fence = opened.group(1)
            continue
        if bare.startswith('<!--'):
            comment = '-->' not in bare[4:]
            continue
        text = INLINE_CODE.sub('', line)
        targets.extend((number, url) for url in INLINE_LINK.findall(text))
        definition = LINK_DEFINITION.match(_unquote(text))
        if definition:
            targets.append((number, definition.group(1)))
    return targets


def link_violations(path: Path) -> list[str]:
    """一份 Markdown 的壞連結：相對目標不存在，或指向 .md 的 `#片段` 對不到標題 slug 與 `<a id>`。"""
    violations: list[str] = []
    for number, url in link_targets(path.read_text(encoding='utf-8')):
        if url.startswith('/') or re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', url):
            continue
        raw_path = re.sub(r'[#?].*$', '', url)
        target = path if raw_path == '' else Path(os.path.normpath(path.parent / unquote(raw_path)))
        if not target.exists():
            violations.append(f'第 {number} 行的連結 {url} 指到不存在的檔案')
            continue
        if '#' not in url or target.suffix != '.md':
            continue
        fragment = unquote(re.sub(r'\?.*$', '', url.split('#', 1)[1]))
        if fragment not in document_anchors(target.read_text(encoding='utf-8')):
            violations.append(f'第 {number} 行的連結 {url} 指到的檔案裡沒有這個錨點')
    return violations


def collect(root: Path) -> tuple[list[Path], int, list[str]]:
    """掃過的檔、相對連結的條數、違規（`相對路徑：說明`）。"""
    files = source_paths(root)
    links = 0
    violations: list[str] = []
    for path in files:
        relative = [u for _, u in link_targets(path.read_text(encoding='utf-8'))
                    if not (u.startswith('/') or re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', u))]
        links += len(relative)
        violations.extend(f'{path.relative_to(root).as_posix()}：{v}' for v in link_violations(path))
    return files, links, violations


def main() -> int:
    files, links, violations = collect(ROOT)
    for violation in violations:
        print(f'::error::{violation}')
    if violations:
        print('Markdown 有壞掉的相對連結。')
        return 1
    print(f'Markdown 相對連結通過：{len(files)} 份檔、{links} 條相對連結。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
