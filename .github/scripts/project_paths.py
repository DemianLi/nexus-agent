"""項目倉庫的路徑有兩種形狀，這支把兩種對到同一個。

舊形狀：`apps/harness`、`apps/web`、`packages/*`、`native`、`vendor`、`scripts`。
新形狀：`harness/apps/harness`、`harness/packages/*`、`harness/native`、`harness/vendor`、`harness/scripts`、`web`。

比對、計數、選範圍一律用舊形狀（`canonical`），輸出給 pnpm、vitest、檔案系統的用磁碟上的真路徑。
"""

from __future__ import annotations

HARNESS_DIR = 'harness'
WEB_DIR = 'web'

LEGACY_SOURCE_ROOTS = ('apps', 'packages', 'native', 'vendor', 'scripts')
OTHER_ROOTS = ('docs', 'licenses', '.github', '.agents', '.claude', '.docs', 'references')
SOURCE_SUFFIXES = ('.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.rs')


def canonical(path: str) -> str:
    """新形狀的路徑換成舊形狀；舊形狀與不認得的原樣回傳。"""
    if path == WEB_DIR:
        return 'apps/web'
    head, _, rest = path.partition('/')
    if head == HARNESS_DIR and rest:
        return rest
    if head == WEB_DIR and rest:
        return f'apps/web/{rest}'
    return path


def actual(path: str, exists) -> str:
    """舊形狀的路徑換成磁碟上真的那個：`exists` 判斷一個路徑在這一版有沒有；兩種都沒有就回舊形狀。"""
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
    """舊形狀的路徑落在認得的位置：根目錄的檔，或認得的頂層目錄底下。"""
    head, sep, _ = path.partition('/')
    if not sep:
        return True
    return head in LEGACY_SOURCE_ROOTS or head in OTHER_ROOTS


def unknown_source(path: str) -> bool:
    """原始碼路徑換成舊形狀之後，不在任何認得的位置：範圍沒辦法算，要全跑。"""
    return path.endswith(SOURCE_SUFFIXES) and not known(canonical(path))

