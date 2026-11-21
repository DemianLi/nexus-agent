"""只降不升的計數：程式碼裡的 dsh 引用、註解裡的變更敘事用語。規則見 docs/agents/collab-mode.md「規則與執行者」。

兩種計數都以目錄為單位（`apps/<name>`、`packages/<name>`，其餘取第一層目錄，根目錄的檔記成 `.`），
基準在 `.github/ratchets.json`：

- 實際數字要等於基準。多了就是新增了引用或敘事；少了就要在同一張 PR 把基準調低（`--write` 重算）。
- 帶 `--base <rev>` 時，基準的每個數字都不能比 `<rev>` 那一版高，基準只能降。

掃的是進版控的程式碼檔（副檔名見 `EXTENSIONS`），不含 `references/`、`vendor/`、`docs/`、`.docs/`、夾具、快照與 Markdown。

- **dsh 引用**：含 `dsh` 這個字或 `deepseek-harness` 的行。
- **變更敘事**：註解行裡含 `NARRATIVE` 列的用語。註解行用行首的 `//`、`/*`、`*`、`#` 或行中的 ` // ` 判斷，
  所以字串裡剛好有 ` // ` 的程式碼行也會算進去。用語刻意只收幾乎只會出現在變更敘事裡的那幾個，
  「改成」「不再」「以前」這類在現況描述裡也常見的不收，免得擋掉正常的新註解。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE = '.github/ratchets.json'
EXTENSIONS = ('.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs', '.py', '.sh', '.yml', '.yaml', '.css', '.toml')
EXCLUDED_PREFIXES = ('references/', 'vendor/', 'apps/web/src/vendor/', 'docs/', '.docs/')
EXCLUDED_PARTS = ('/fixtures/', '/__snapshots__/')
EXEMPT = {'.github/scripts/check_ratchets.py', '.github/scripts/test_check_ratchets.py'}

DSH = re.compile(r'(?i)(?<![a-z0-9_])dsh(?![a-z0-9_])|deepseek[-_ ]?harness')
COMMENT = re.compile(r'^\s*(?://|/\*|\*|#)|\s//\s')
NARRATIVE = re.compile(r'這張 ?PR|這張卡|本 ?PR|原本寫|(?<!還)原先')
RULES = {'dsh': '程式碼裡的 dsh 引用', 'narrative': '註解裡的變更敘事用語'}


def directory(path: str) -> str:
    parts = path.split('/')
    if parts[0] in ('apps', 'packages') and len(parts) > 2:
        return '/'.join(parts[:2])
    return parts[0] if len(parts) > 1 else '.'


def scanned(path: str) -> bool:
    if not path.endswith(EXTENSIONS) or path in EXEMPT:
        return False
    if path.startswith(EXCLUDED_PREFIXES):
        return False
    return not any(part in f'/{path}' for part in EXCLUDED_PARTS)


def measure(root: Path, files: list[str]) -> dict[str, dict[str, int]]:
    counts = {rule: Counter() for rule in RULES}
    for path in files:
        if not scanned(path):
            continue
        try:
            text = (root / path).read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError):
            continue
        key = directory(path)
        for line in text.split('\n'):
            if DSH.search(line):
                counts['dsh'][key] += 1
            if COMMENT.search(line) and NARRATIVE.search(line):
                counts['narrative'][key] += 1
    return {rule: dict(sorted(c.items())) for rule, c in counts.items()}


def compare(
    actual: dict[str, dict[str, int]],
    baseline: dict[str, dict[str, int]],
    base: dict[str, dict[str, int]] | None,
) -> list[str]:
    errors: list[str] = []
    for rule, label in RULES.items():
        have = actual.get(rule, {})
        want = baseline.get(rule, {})
        for key in sorted(set(have) | set(want)):
            n, b = have.get(key, 0), want.get(key, 0)
            if n > b:
                errors.append(f'{label}：{key} 有 {n} 處，基準是 {b}。新增的要拿掉。')
            elif n < b:
                errors.append(f'{label}：{key} 降到 {n} 處，把 {BASELINE} 的基準從 {b} 調成 {n}（check_ratchets.py --write）。')
        if base is None:
            continue
        before = base.get(rule, {})
        for key, b in sorted(want.items()):
            if b > before.get(key, 0):
                errors.append(f'{label}：{key} 的基準從 {before.get(key, 0)} 調高到 {b}。基準只能降。')
    return errors


def tracked(root: Path) -> list[str]:
    out = subprocess.run(['git', 'ls-files', '-z'], cwd=root, capture_output=True, check=True).stdout
    return [p for p in out.decode('utf-8').split('\0') if p]


def baseline_at(root: Path, rev: str) -> dict[str, dict[str, int]] | None:
    shown = subprocess.run(['git', 'show', f'{rev}:{BASELINE}'], cwd=root, capture_output=True)
    if shown.returncode != 0:
        return None
    return json.loads(shown.stdout.decode('utf-8'))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--write', action='store_true', help='照現況重寫基準')
    parser.add_argument('--base', help='基準不能比這一版高')
    args = parser.parse_args()

    actual = measure(ROOT, tracked(ROOT))
    if args.write:
        (ROOT / BASELINE).write_text(json.dumps(actual, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'已寫入 {BASELINE}。')
        return 0

    baseline = json.loads((ROOT / BASELINE).read_text(encoding='utf-8'))
    base = baseline_at(ROOT, args.base) if args.base else None
    errors = compare(actual, baseline, base)
    for e in errors:
        print(f'::error::{e}')
    if errors:
        return 1
    totals = '、'.join(f'{label} {sum(actual[rule].values())} 處' for rule, label in RULES.items())
    print(f'只降不升的計數通過：{totals}。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
