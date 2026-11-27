"""擋進版控的檔與 PR 內文裡的個人或本機暫存的絕對路徑（#3325）。repo 是公開的，這類路徑會洩漏使用者名與機器配置。

- 擋四種：`/Users/<名字>/`、`/home/<名字>/`、`/private/tmp/claude-<數字>/`、`/var/folders/<2 碼>/<20 碼以上>`（macOS 真正的暫存根）。
- `/Users/<名字>/` 不看前面接什麼一律擋。`/home/<名字>/` 緊接在相對路徑後面才放行：`<…>` 佔位、`$VAR`／`${VAR}`、或開頭不是 `/`、`-` 且不含 `://` 的片段（例如 `build`、`..`、`a/b`）；行首、空白、引號、`(`、`=`、`:`、`>` 導向、`-o`、`/mnt/c`、URL 後面照擋。`<code>/home/<名字>/` 分不出它跟 `<root>/home/`，照放行（接受的漏擋）。
- `<名字>` 在 `PLACEHOLDER_NAMES` 的放行；名字段不是純英數與 `._-`（例如 `<名字>`、`$USER`、`…`）的也放行，那是寫給人看的樣板。
  `/var/folders/` 後面接的不是真的暫存根長相（測試用的 `ab/cd1234`、省略號）也放行。佔位名清單只在這裡定義。
- 只擋路徑，不擋主機架構字樣：`darwin-arm64`、`linux-x64` 在這個 repo 是正當的平台名。
- 二進位檔與產生的鎖檔不掃；這支與它的測試本身要寫範例，也不掃。
- 參數照 `check_md_links.py`：`--root` 指掃描根，`--files` 只掃這些檔（相對於 `--root`）；不給 `--files` 就掃 `git ls-files`。
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

PLACEHOLDER_NAMES = frozenset({'x', 'u', 'you', 'someone', 'FAKE', 'user', 'username', 'name', 'me', 'example', 'runner'})
GENERATED = frozenset({'pnpm-lock.yaml', 'Cargo.lock', 'package-lock.json', 'yarn.lock'})
SELF = frozenset({'.github/scripts/check_personal_paths.py', '.github/scripts/test_check_personal_paths.py'})

HOME_RE = re.compile(r'/(?:Users|home)/([^/\s\'"`<>()\[\]{}]+)/')
PREFIX_RE = re.compile(r'[^\s\'"`(=]*$')
RELATIVE_PLACEHOLDER_RE = re.compile(r'<[^<>\s]+>$')
RELATIVE_VARIABLE_RE = re.compile(r'\$(?:[A-Za-z0-9_]+|\{[^}\s]*\})$')
RELATIVE_SEGMENT_RE = re.compile(r'[A-Za-z0-9_.][A-Za-z0-9_.\-/]*')
SCRATCH_RE = re.compile(r'/private/tmp/claude-\d+/')
FOLDERS_RE = re.compile(r'/var/folders/[A-Za-z0-9_]{2}/[A-Za-z0-9_]{20,}')
REAL_NAME_RE = re.compile(r'^[A-Za-z0-9._-]+$')


def relative_prefix(prefix: str) -> bool:
    return bool(
        RELATIVE_PLACEHOLDER_RE.search(prefix)
        or RELATIVE_VARIABLE_RE.search(prefix)
        or RELATIVE_SEGMENT_RE.fullmatch(prefix)
    )


def line_hits(line: str) -> list[str]:
    hits = []
    for match in HOME_RE.finditer(line):
        name = match.group(1)
        if match.group(0).startswith('/home/') and relative_prefix(PREFIX_RE.search(line[: match.start()]).group(0)):
            continue
        if name not in PLACEHOLDER_NAMES and REAL_NAME_RE.match(name):
            hits.append(match.group(0))
    hits += [m.group(0) for m in SCRATCH_RE.finditer(line)]
    hits += [m.group(0) for m in FOLDERS_RE.finditer(line)]
    return hits


def text_violations(text: str, label: str) -> list[str]:
    found = []
    for number, line in enumerate(text.splitlines(), 1):
        for hit in line_hits(line):
            found.append(f'{label}:{number}：個人或本機暫存的絕對路徑 `{hit}`，改用佔位名或相對路徑。')
    return found


def skipped(path: str) -> bool:
    return path in SELF or path.rsplit('/', 1)[-1] in GENERATED


def file_violations(root: Path, paths: list[str]) -> list[str]:
    found: list[str] = []
    for path in paths:
        if skipped(path):
            continue
        try:
            data = (root / path).read_bytes()
        except OSError:
            continue
        if b'\0' in data[:8192]:
            continue
        found += text_violations(data.decode('utf-8', errors='replace'), path)
    return found


def tracked(root: Path) -> list[str]:
    out = subprocess.run(['git', 'ls-files', '-z'], cwd=root, capture_output=True, check=True).stdout
    return [p for p in out.decode('utf-8').split('\0') if p]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='擋個人絕對路徑。')
    parser.add_argument('--root', type=Path, default=ROOT, help='掃描的根；預設是這個項目倉庫自己')
    parser.add_argument('--files', nargs='+', type=Path, help='只掃這些檔（相對於 --root）；不給就掃 git 追蹤的檔')
    args = parser.parse_args(argv)
    root = args.root.resolve()
    paths = [p.as_posix() for p in args.files] if args.files else tracked(root)
    errors = file_violations(root, paths)
    for error in errors:
        print(f'::error::{error}')
    if errors:
        print(f'{len(errors)} 處個人或本機暫存的絕對路徑。佔位名清單在 .github/scripts/check_personal_paths.py。')
        return 1
    print('沒有個人或本機暫存的絕對路徑。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
