"""每個 `pnpm --filter` 都要帶 `--fail-if-no-match`。

pnpm 10 篩選比對不到任何專案時只印 "No projects matched" 然後 exit 0，那一步什麼都不跑還是綠的。搬目錄之後寫死舊路徑的篩選
就是這樣悄悄變成空操作。加了 `--fail-if-no-match` 之後比對不到 exit 1。

掃的範圍：workflow、composite action、每份 `package.json` 的 scripts，以及 `typecheck.sh`（它把呼叫端給的篩選轉給 pnpm，旗標由它加）。
逐行看（接續行先併起來）；呼叫 `typecheck.sh` 的那一行不用帶，由 `typecheck.sh` 自己帶。掃到 0 份檔案就是紅的。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FLAG = '--fail-if-no-match'
FILTER = re.compile(r'(?<![\w-])(--filter(?![\w-])|--filter=|-F(?=[ =]))')
SELF_FLAGGING = 'typecheck.sh'
TYPECHECK_SCRIPT = '.github/scripts/typecheck.sh'


def tracked(root: Path) -> list[str]:
    out = subprocess.run(['git', 'ls-files', '-z'], cwd=root, capture_output=True, check=True).stdout
    return [p for p in out.decode('utf-8').split('\0') if p]


def targets(paths: list[str]) -> list[str]:
    found = []
    for p in paths:
        name = p.rsplit('/', 1)[-1]
        if re.fullmatch(r'\.github/workflows/[^/]+\.ya?ml', p) or re.fullmatch(r'\.github/actions/[^/]+/action\.ya?ml', p):
            found.append(p)
        elif name == 'package.json' and 'node_modules' not in p.split('/'):
            found.append(p)
    return found


def logical_lines(text: str) -> list[tuple[int, str]]:
    rows: list[tuple[int, str]] = []
    start, buffer = 0, ''
    for number, line in enumerate(text.split('\n'), start=1):
        if not buffer:
            start = number
        if line.rstrip().endswith('\\'):
            buffer += line.rstrip()[:-1] + ' '
            continue
        rows.append((start, buffer + line))
        buffer = ''
    if buffer:
        rows.append((start, buffer))
    return rows


def violations(path: str, text: str) -> list[str]:
    errors = []
    if path.endswith('package.json'):
        try:
            scripts = json.loads(text).get('scripts', {})
        except json.JSONDecodeError as e:
            return [f'{path}：不是合法的 JSON：{e}']
        rows = [(0, f'{name}: {command}') for name, command in scripts.items() if isinstance(command, str)]
    else:
        rows = logical_lines(text)
    for number, line in rows:
        if not FILTER.search(line) or FLAG in line or SELF_FLAGGING in line:
            continue
        where = f'{path}:{number}' if number else path
        errors.append(f'{where}：pnpm 的篩選沒帶 {FLAG}，比對不到專案時那一步會空跑還是綠的：{line.strip()[:100]}')
    return errors


def check(root: Path, paths: list[str] | None = None) -> tuple[int, list[str]]:
    files = targets(tracked(root) if paths is None else paths)
    errors: list[str] = []
    if not any(f.startswith('.github/workflows/') for f in files):
        errors.append('掃到 0 份 workflow：路徑搬了，這一關就空掃了。')
    script = root / TYPECHECK_SCRIPT
    if not script.is_file() or FLAG not in script.read_text(encoding='utf-8'):
        errors.append(f'{TYPECHECK_SCRIPT} 沒帶 {FLAG}：呼叫端的篩選比對不到時型別檢查什麼都不跑。')
    for f in files:
        errors.extend(violations(f, (root / f).read_text(encoding='utf-8')))
    return len(files), errors


def main() -> int:
    count, errors = check(ROOT)
    for e in errors:
        print(f'::error::{e}')
    if errors:
        return 1
    print(f'pnpm 篩選檢查通過：{count} 份檔。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
