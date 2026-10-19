"""檢查 `docs/upgrade-guide/` 的升級指南：路徑形狀、frontmatter、段落（#1537）。規則見 AGENTS.md「發版」。

規則逐條照 dsh `scripts/verify-upgrade-guides.ts`（687f282e）：

- 目錄裡只准有 `v<semver>/<kebab-case>/guide.md`，其他檔一律報；
- frontmatter 的鍵恰好是 `description` 與 `kind`，`kind` 是 `upgrade-guide`，`description` 是非空字串；
- 深度 ≤ 2 的標題恰好是一個 `#` 標題，接著 `## 變更`、`## 遷移`，順序不能換；
- 目錄不存在就沒有違規。

另外多驗一條：版本目錄的 `v<版號>` 必須是已存在的 git tag。dsh 的 `<version>` 是讀者正在跑的那一版、也就是上一個
發出的版本（SKILL.md:8、:26），它從根 `package.json` 讀。本 repo 的 manifest 今天還是 0.0.0，對不上已發出的 tag；
版號 PR 合進去到 Release 發出之間，manifest 又是還沒發的那一版。所以改取最近一個 Release tag，並由這裡擋住寫錯的目錄
（#1537 偏離 2，理由 1；撤除條件見 AGENTS.md「升級指南」）。這裡只驗 tag 存在，不驗是不是最近一個。

指南裡的相對連結不在這裡驗：同 dsh 由 `verify-md-links` 管，本 repo 是 `check_md_links.py`，`docs/**` 在它的範圍裡。

和 dsh 不同的地方：

- 只收 `guide.md` 一份中文（dsh 的 `guide.zh.md`、`guide.i18n.yaml` 是雙語配對，本 repo 文件只有中文，見 #1537 偏離 1）。
  段落名照 dsh 中文版的「变更」「迁移」，寫成正體；字數上限照 dsh 中文版，不設。
- 寫成 stdlib 的 Python，跑在 `ci.yml` 的 `plan` job：純文件 PR 會跳過 `static`，只有 `plan` 每張都跑。`plan` 不裝相依，
  所以 YAML 與 Markdown 都沒有真的解析器，下面兩處是近似，各自往哪一邊偏寫在這裡：
  - frontmatter 只收單行的 `鍵: 值`。不加引號、YAML 不會讀成這一整行字串的值（流式集合、錨點、標籤、區塊純量、
    值裡的「: 」與「 #」等）一律要求加引號：會報一些 dsh 放行的寫法（例如 `說明 #註解`，YAML 讀成「說明」，仍是非空字串），
    不會放過 dsh 擋的。
  - 頂層標題自己掃：跳過 fenced code、引言、HTML 註解、清單項目裡的標題；縮排程式碼、HTML 區塊這類少見形狀沒有照
    CommonMark 細分。
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GUIDE_ROOT = 'docs/upgrade-guide'
FRONTMATTER_KEYS = ['description', 'kind']
SECTIONS = ['變更', '遷移']
SEMVER = r'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?'
GUIDE_PATH = re.compile(rf'^v{SEMVER}/[a-z0-9]+(?:-[a-z0-9]+)*/guide\.md$')

FRONTMATTER = re.compile(r'^---\r?\n([\s\S]*?)\r?\n---\r?\n')
FIELD = re.compile(r'^([A-Za-z_][\w-]*):(?:[ \t]+(.*?))?[ \t]*$')
# 不加引號時 YAML 會讀成非字串的值（照 dsh 的 JSON_SCHEMA）。
NON_STRING = re.compile(r'^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?)?$')
# 不加引號時 YAML 不會讀成「整行就是這個字串」的：流式集合、錨點與別名、標籤、區塊純量、保留字元開頭，
# 以及中間的「: 」（變成巢狀映射或語法錯）與「 #」（後面變成註解）。
PLAIN_UNSAFE = re.compile(r'^[\[\]{}&*!|>%@`\'"]|^[-?:](?:[ \t]|$)|:(?:[ \t]|$)|[ \t]#')
FENCE = re.compile(r'^ {0,3}(`{3,}|~{3,})')
ATX = re.compile(r'^ {0,3}(#{1,6})(?:[ \t]|$)')
SETEXT = re.compile(r'^ {0,3}(=+|-+)[ \t]*$')
THEMATIC = re.compile(r'^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$')
NOT_PARAGRAPH = re.compile(r'^ {0,3}(?:[-+*][ \t]|\d+[.)][ \t]|>|#)|^ {4}|^\t')
LIST_ITEM = re.compile(r'^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)')
HTML_COMMENT = re.compile(r'^ {0,3}<!--')


def parse_frontmatter(text: str) -> tuple[dict[str, object], list[str]]:
    """單行 `鍵: 值` 的 frontmatter。值加了引號才算一定是字串；重複的鍵、其他形狀都報。"""
    fields: dict[str, object] = {}
    problems: list[str] = []
    for line in text.splitlines():
        if line.strip() == '' or line.lstrip().startswith('#'):
            continue
        match = FIELD.match(line)
        if match is None:
            problems.append(f'frontmatter 只收單行的「鍵: 值」，這行不是：{line!r}')
            continue
        key, raw = match.group(1), match.group(2) or ''
        if key in fields:
            problems.append(f'frontmatter 的鍵 {key} 重複')
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in '"\'':
            fields[key] = raw[1:-1]
        elif NON_STRING.match(raw):
            fields[key] = None
        elif PLAIN_UNSAFE.search(raw):
            problems.append(f'frontmatter 的 {key} 沒加引號時 YAML 不會讀成這一整行字串，請加引號：{raw!r}')
            fields[key] = None
        else:
            fields[key] = raw
    return fields, problems


def _indent(line: str) -> int:
    expanded = line.expandtabs(4)
    return len(expanded) - len(expanded.lstrip(' '))


def outline(body: str) -> list[str]:
    """頂層、深度 ≤ 2 的標題，取原文（同 dsh 用 mdast 根節點的子節點切出來的那段）。

    不算頂層的：fenced code、引言、HTML 註解，以及清單項目裡的標題（縮排到項目內容那一欄的行屬於那個項目，
    同 CommonMark）。清單在縮排不夠的標題、fence，或空行之後縮排不夠的段落結束；空行之前縮排不夠的段落行是
    延續行（lazy continuation），仍屬於那個項目。
    """
    headings: list[str] = []
    fence: str | None = None
    comment = False
    item_indent: int | None = None
    blank_before = True
    paragraph: list[str] = []
    for line in body.splitlines():
        if comment:
            comment = '-->' not in line
            continue
        if fence is not None:
            close = FENCE.match(line)
            if close and close.group(1)[0] == fence[0] and len(close.group(1)) >= len(fence) and line.strip() == close.group(1):
                fence = None
            continue
        if line.strip() == '':
            paragraph, blank_before = [], True
            continue
        blank = blank_before
        blank_before = False
        indent = _indent(line)
        if item_indent is not None and indent < item_indent:
            if LIST_ITEM.match(line) or ATX.match(line) or FENCE.match(line) or THEMATIC.match(line) or blank:
                item_indent = None
            else:
                continue
        if item_indent is not None:
            # 項目裡的 fence 也要追，免得裡面的行被當成項目之外的東西。
            opened = FENCE.match(line.expandtabs(4)[item_indent:])
            if opened:
                fence = opened.group(1)
            paragraph = []
            continue
        setext = SETEXT.match(line)
        if setext and paragraph:
            headings.append('\n'.join(paragraph + [line.strip()]))
            paragraph = []
            continue
        if THEMATIC.match(line):
            paragraph = []
            continue
        item = LIST_ITEM.match(line)
        if item:
            marker = item.group(0).expandtabs(4)
            after = len(marker) - len(marker.rstrip())
            # 標記後面沒字或空了 5 格以上，內容欄是標記後一格（CommonMark 5.2）。
            item_indent = len(marker) if 1 <= after <= 4 and line.strip() != marker.strip() else len(marker) - after + 1
            paragraph = []
            continue
        if HTML_COMMENT.match(line):
            comment = '-->' not in line[line.index('<!--') + 4:]
            paragraph = []
            continue
        opened = FENCE.match(line)
        if opened:
            fence, paragraph = opened.group(1), []
            continue
        atx = ATX.match(line)
        if atx:
            if len(atx.group(1)) <= 2:
                headings.append(line.strip())
            paragraph = []
            continue
        if NOT_PARAGRAPH.match(line):
            paragraph = []
            continue
        paragraph.append(line.strip())
    return headings


def guide_violations(source: str) -> list[str]:
    match = FRONTMATTER.match(source)
    if match is None:
        return ['開頭要是 YAML frontmatter（--- 包起來）']
    violations: list[str] = []
    fields, problems = parse_frontmatter(match.group(1))
    violations.extend(problems)
    keys = sorted(fields)
    if keys != FRONTMATTER_KEYS:
        violations.append(f'frontmatter 的鍵要恰好是 {", ".join(FRONTMATTER_KEYS)}，實際是 {", ".join(keys) or "（沒有）"}')
    if fields.get('kind') != 'upgrade-guide':
        violations.append('kind 要是 upgrade-guide')
    description = fields.get('description')
    if not isinstance(description, str) or description.strip() == '':
        violations.append('description 要是非空字串')

    headings = outline(source[match.end():])
    expected = [f'## {section}' for section in SECTIONS]
    if len(headings) != len(expected) + 1 or not headings[0].startswith('# ') or headings[1:] != expected:
        want = '、'.join(f'「{h}」' for h in expected)
        got = '、'.join(f'「{h}」' for h in headings) or '（沒有）'
        violations.append(f'標題要是一個「#」標題，接著恰好 {want}；實際是 {got}')
    return violations


def release_tags(root: Path) -> set[str]:
    out = subprocess.run(['git', 'tag', '--list', 'v*'], cwd=root, check=True, capture_output=True, text=True).stdout
    return {line.strip() for line in out.splitlines() if line.strip()}


def collect_violations(root: Path, tags: set[str]) -> list[str]:
    directory = root / GUIDE_ROOT
    if not directory.exists():
        return []
    violations: list[str] = []
    for version in sorted(p.name for p in directory.iterdir() if p.is_dir()):
        if GUIDE_PATH.match(f'{version}/x/guide.md') and version not in tags:
            violations.append(
                f'{GUIDE_ROOT}/{version}：沒有這個 tag。版本目錄取最近一個 Release 的 tag（讀者正在跑的那一版），'
                '不是 package.json 的版號；CI 的 checkout 要帶 tags'
            )
    files = sorted(p.relative_to(directory).as_posix() for p in directory.rglob('*') if not p.is_dir())
    for file in files:
        path = f'{GUIDE_ROOT}/{file}'
        if not GUIDE_PATH.match(file):
            violations.append(f'{path}：{GUIDE_ROOT} 底下只放 v<semver>/<kebab-case 名稱>/guide.md')
            continue
        for violation in guide_violations((directory / file).read_text(encoding='utf-8')):
            violations.append(f'{path}：{violation}')
    return violations


def main() -> int:
    directory = ROOT / GUIDE_ROOT
    violations = collect_violations(ROOT, release_tags(ROOT) if directory.exists() else set())
    for violation in violations:
        print(f'::error::{violation}')
    if violations:
        print('升級指南的格式不對，規則見 AGENTS.md「發版」。')
        return 1
    print('升級指南格式通過。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
