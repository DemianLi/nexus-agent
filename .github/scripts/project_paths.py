from __future__ import annotations

from collections.abc import Callable

HARNESS_DIR = 'harness'
WEB_DIR = 'web'

LEGACY_SOURCE_ROOTS = ('apps', 'packages', 'native', 'vendor', 'scripts')
OTHER_ROOTS = ('docs', 'licenses', '.github', '.agents', '.claude', 'references')
SOURCE_SUFFIXES = ('.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.rs')


def canonical(path: str) -> str:
    if path == WEB_DIR:
        return 'apps/web'
    head, _, rest = path.partition('/')
    if head == HARNESS_DIR and rest:
        return rest
    if head == WEB_DIR and rest:
        return f'apps/web/{rest}'
    return path


def actual(path: str, exists: Callable[[str], bool]) -> str:
    head, _, rest = path.partition('/')
    if head == 'apps' and rest.startswith('web/') or path == 'apps/web':
        candidates = [path, f'{WEB_DIR}/{rest[len("web/"):]}'.rstrip('/')]
    elif head in LEGACY_SOURCE_ROOTS and rest:
        candidates = [path, f'{HARNESS_DIR}/{path}']
    else:
        return path
    for candidate in candidates:
        if exists(candidate):
            return candidate
    return path


def known(path: str) -> bool:
    head, sep, _ = path.partition('/')
    if not sep:
        return True
    return head in LEGACY_SOURCE_ROOTS or head in OTHER_ROOTS


def unknown_source(path: str) -> bool:
    return path.endswith(SOURCE_SUFFIXES) and not known(canonical(path))

