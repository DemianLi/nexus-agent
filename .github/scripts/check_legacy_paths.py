"""搬進 `harness/` 與 `web/` 之後（ADR 0007）擋兩件事：
- 進版控的檔出現協作用的檔：任何一層的 `AGENTS.md`、`CLAUDE.md`、`CLAUDE.local.md`、`.agents`、`.claude`。這些由外層的本地 git 管，不進項目倉庫。
  `fixtures/` 底下的測試夾具不算。
- 進版控的檔以 `apps/`、`packages/`、`native/`、`vendor/`、`scripts/` 開頭：搬家前開的分支合進來時，新檔會留在舊路徑、不在 workspace 裡，
  型別、lint、測試都跑不到。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENT_NAMES = frozenset({'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', '.agents', '.claude'})
LEGACY_ROOTS = ('apps', 'packages', 'native', 'vendor', 'scripts')
FIXTURES = 'fixtures'


def tracked(root: Path) -> list[str]:
    out = subprocess.run(['git', 'ls-files', '-z'], cwd=root, capture_output=True, check=True).stdout
    return [p for p in out.decode('utf-8').split('\0') if p]


def violations(paths: list[str]) -> list[str]:
    found: list[str] = []
    for path in paths:
        parts = path.split('/')
        if FIXTURES not in parts[:-1]:
            hit = next((part for part in parts if part in AGENT_NAMES), None)
            if hit is not None:
                found.append(f'{path}：進版控的檔裡不放 `{hit}`，協作用的檔由外層的本地 git 管。')
        if len(parts) > 1 and parts[0] in LEGACY_ROOTS:
            found.append(
                f'{path}：`{parts[0]}/` 開頭是搬家前的路徑，該放進 `harness/` 或 `web/`（`apps/web` 的檔放 `web/`）。'
            )
    return found


def main() -> int:
    errors = violations(tracked(ROOT))
    for error in errors:
        print(f'::error::{error}')
    if errors:
        print(f'{len(errors)} 個檔在不該有的路徑。')
        return 1
    print('沒有協作用的檔，也沒有舊路徑開頭的檔。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
