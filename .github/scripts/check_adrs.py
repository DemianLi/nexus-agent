from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAME = re.compile(r'^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$')


PROJECT_ADR = 'docs/adr'
APP_ADR_GLOBS = ('apps/*/docs/adr', 'harness/apps/*/docs/adr', 'web/docs/adr')
PACKAGE_ADR_GLOBS = ('packages/*/docs/adr', 'harness/packages/*/docs/adr')


def adr_dirs(root: Path) -> list[Path]:
    """全項目的 ADR 目錄，加上 harness 與 web 的（舊形狀 `apps/*/docs/adr`、新形狀 `harness/apps/*/docs/adr`、`web/docs/adr`）。"""
    dirs = [root / PROJECT_ADR]
    for pattern in APP_ADR_GLOBS:
        dirs += sorted(root.glob(pattern))
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


def check(root: Path, files: list[str] | None = None) -> list[str]:
    """格式。`files` 給了就只查含有這些檔的 ADR 目錄（套件裡的 ADR 照樣擋）。"""
    errors = [
        f'{d.relative_to(root).as_posix()}：套件不放 ADR，決策歸到根目錄的 docs/adr/。'
        for pattern in PACKAGE_ADR_GLOBS
        for d in sorted(root.glob(pattern))
        if d.is_dir()
    ]
    for d in adr_dirs(root):
        if files is None or any((root / f).parent == d for f in files):
            errors += check_dir(d, root)
    return errors


def floor_errors(root: Path) -> list[str]:
    """全項目的 ADR 目錄掃到 0 份是紅的：目錄搬了或被清空時，不能少掃了還說通過。兩個 app 的可以沒有。"""
    d = root / PROJECT_ADR
    if not d.is_dir() or not any(p.is_file() for p in d.iterdir()):
        return [f'{PROJECT_ADR}：在 {root} 底下掃到 0 份，全項目的 ADR 目錄至少要有 1 份。']
    return []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='檢查 ADR 格式。')
    parser.add_argument('--root', type=Path, default=ROOT, help='要查的根；預設是這個項目倉庫自己')
    parser.add_argument('--files', nargs='+', help='只查含有這些檔（相對於 --root）的 ADR 目錄，不查份數下限')
    args = parser.parse_args(argv)
    root = args.root.resolve()
    errors = check(root, args.files) + ([] if args.files else floor_errors(root))
    for e in errors:
        print(f'::error::{e}')
    if errors:
        return 1
    count = sum(1 for d in adr_dirs(root) for p in d.iterdir() if p.is_file())
    print(f'ADR 格式通過：{count} 份。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
