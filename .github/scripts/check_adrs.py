from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAME = re.compile(r'^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$')


def adr_dirs(root: Path) -> list[Path]:
    dirs = [root / 'docs' / 'adr']
    dirs += sorted([*root.glob('harness/apps/*/docs/adr'), *root.glob('web/docs/adr')])
    return [d for d in dirs if d.is_dir()]


def check_dir(d: Path, root: Path) -> list[str]:
    rel = d.relative_to(root).as_posix()
    errors: list[str] = []
    numbers: list[int] = []
    for p in sorted(d.iterdir()):
        name = p.name
        if p.is_dir():
            errors.append(f'{rel}/{name}：ADR 目錄裡不放子目錄。')
            continue
        m = NAME.match(name)
        if not m:
            errors.append(f'{rel}/{name}：檔名要是 NNNN-<kebab-slug>.md（四位數編號、小寫英數與連字號）。')
            continue
        numbers.append(int(m.group(1)))
        lines = p.read_text(encoding='utf-8').split('\n')
        title = lines[0] if lines else ''
        if not title.startswith('# ') or not title[2:].strip():
            errors.append(f'{rel}/{name}:1：第一行要是「# <標題>」。')
        elif not any(line.strip() for line in lines[1:]):
            errors.append(f'{rel}/{name}：標題之後沒有正文。')
    seen: set[int] = set()
    for n in numbers:
        if n in seen:
            errors.append(f'{rel}：編號 {n:04d} 重複。')
        seen.add(n)
    expected = set(range(1, len(seen) + 1))
    if seen != expected:
        missing = sorted(expected - seen)
        extra = sorted(seen - expected)
        detail = '、'.join([f'缺 {n:04d}' for n in missing] + [f'多出 {n:04d}' for n in extra])
        errors.append(f'{rel}：編號要從 0001 起連續（{detail}）。')
    return errors


def check(root: Path) -> list[str]:
    errors = [
        f'{d.relative_to(root).as_posix()}：套件不放 ADR，決策歸到根目錄的 docs/adr/。'
        for d in sorted(root.glob('harness/packages/*/docs/adr'))
        if d.is_dir()
    ]
    for d in adr_dirs(root):
        errors += check_dir(d, root)
    return errors


def main() -> int:
    errors = check(ROOT)
    for e in errors:
        print(f'::error::{e}')
    if errors:
        return 1
    count = sum(1 for d in adr_dirs(ROOT) for p in d.iterdir() if p.is_file())
    print(f'ADR 格式通過：{count} 份。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
