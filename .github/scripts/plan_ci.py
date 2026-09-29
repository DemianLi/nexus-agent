"""決定這一輪 CI 要跑什麼。規範與取捨見 .github/workflows/ci.yml 檔頭與 AGENTS.md。

兩個子指令：

    plan_ci.py plan                  讀 changed.txt 與環境變數，把要跑的範圍寫到 $GITHUB_OUTPUT
    plan_ci.py harness-files <sha>   印出 harness 這一輪要跑的測試檔（`--changed` 的結果 ∪ 必跑集合）

**選擇性測試只發生在「功能分支 → develop」的 PR 上。** 其餘一律全跑：`develop → main` 的 PR 與
`main` 的 push 是進發版線之前的最後一道保險，這個腳本的對照有漏也會在那裡被擋下來。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# 有這些異動才值得掃 TypeScript。三個非 TypeScript 的檔名是刻意的窄例外（「測試會讀這個檔」）：
# `docs/operations.md`、`apps/harness/cordis.yml`、`apps/harness/src/*.patch.yml`。
# 別放寬成所有 `.md` 或所有 `.yml`：「純文件的 PR 不會卡住」是設計。
TS_RE = re.compile(
    r'\.(ts|tsx|mts|cts)$'
    r'|^package\.json$|^pnpm-lock\.yaml$|^tsconfig.*\.json$'
    r'|^docs/operations\.md$'
    r'|^apps/harness/cordis\.yml$'
    r'|^apps/harness/src/.*\.patch\.yml$'
)

# 這些異動讓「哪些測試相關」的判斷失去依據，一律全跑（同時也一定會觸發掃描）。
FULL_RES = [
    re.compile(rx)
    for rx in (
        # 全部套件都依賴它們。
        r'^packages/nexus-(core|wire)/',
        # 相依、工具鏈、workspace 設定：影響每一個套件。
        r'^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.prettierignore|\.prettierrc.*|prettier\.config\..*)$',
        r'^(eslint\.config\..*|tsconfig.*\.json|vitest\..*)$',
        # CI 自己：改了它就該用它驗一次完整的。
        r'^\.github/(workflows|scripts)/',
        # 測試「讀」而不是 import 的檔：import 圖看不到它們（見 ci.yml 的說明）。
        r'^docs/operations\.md$',
        r'^apps/harness/(cordis\.yml|package\.json|vitest\.config\..*|tsconfig.*\.json|eslint\.config\..*)$',
        r'^apps/harness/src/(test-home\.setup\.ts|.*\.patch\.yml|.*\.fixture\.ts)$',
    )
]


HARNESS_SHARDS = 2
WEB_SHARDS = 2


def read_changed(path: str = 'changed.txt') -> list[str]:
    return [line.strip() for line in Path(path).read_text(encoding='utf-8').splitlines() if line.strip()]


def changed_plugin_dirs(changed: list[str]) -> list[str]:
    """異動落在哪些 `packages/nexus-plugin-*` 目錄（core 與 wire 走全跑，不在這裡）。"""
    dirs = {m.group(1) for p in changed if (m := re.match(r'^(packages/nexus-plugin-[^/]+)/', p))}
    return sorted(d for d in dirs if (ROOT / d / 'package.json').exists())


def plan(changed: list[str], event: str, base_ref: str) -> dict[str, str]:
    forced = any(rx.search(p) for p in changed for rx in FULL_RES)
    if not (forced or any(TS_RE.search(p) for p in changed)):
        return {
            'ts': 'false',
            'full': 'false',
            'pkg_filters': '',
            'harness_mode': 'none',
            'harness_shards': '[1]',
            'harness_shard_total': '1',
            'web_shards': '[1]',
            'web_shard_total': '1',
        }

    selective = event == 'pull_request' and base_ref == 'develop' and not forced
    if selective:
        pkg_filters = ' '.join(f'--filter=./{d}' for d in changed_plugin_dirs(changed))
    else:
        pkg_filters = '--filter=./packages/*'
    # 全跑時 harness 是關鍵路徑（單一 job 約三分鐘），切片平行跑；選擇性時只有幾十個檔，切了只是多付安裝。
    harness_total = 1 if selective else HARNESS_SHARDS
    return {
        'ts': 'true',
        'full': 'false' if selective else 'true',
        'pkg_filters': pkg_filters,
        'harness_mode': 'selective' if selective else 'full',
        'harness_shards': json.dumps(list(range(1, harness_total + 1))),
        'harness_shard_total': str(harness_total),
        'web_shards': json.dumps(list(range(1, WEB_SHARDS + 1))),
        'web_shard_total': str(WEB_SHARDS),
    }


# harness 裡 import 圖看不到、所以「不管異動落在哪都必須跑」的測試，一律從檔案內容偵測，不維護清單：
#
# - 用 `shippedPlugins()` 的測試：它們照 cordis.yml 用 `import(entry.name)` 動態載入 plugin，
#   plugin 原始碼的異動不在靜態 import 圖上。
# - 掃描整個原始碼樹的絆索測試（`'apps/web/src'` 出現在它們的掃描根裡）：異動落在哪一個套件都可能踩到。
ALWAYS_RUN_MARKERS = ('shippedPlugins', "'apps/web/src'")


def always_run_tests(harness_dir: Path) -> list[str]:
    found = []
    for path in sorted(harness_dir.rglob('*.test.ts')):
        if 'node_modules' in path.parts:
            continue
        text = path.read_text(encoding='utf-8')
        if any(marker in text for marker in ALWAYS_RUN_MARKERS):
            found.append(path.relative_to(harness_dir).as_posix())
    return found


def harness_files(base_sha: str) -> list[str]:
    harness_dir = ROOT / 'apps' / 'harness'
    out = subprocess.run(
        ['pnpm', 'exec', 'vitest', 'list', '--changed', base_sha, '--filesOnly'],
        cwd=harness_dir,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    related = [line.strip() for line in out.splitlines() if line.strip().endswith('.test.ts')]
    return sorted(set(related) | set(always_run_tests(harness_dir)))


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'plan':
        result = plan(read_changed(), os.environ.get('EVENT_NAME', ''), os.environ.get('BASE_REF', ''))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        target = os.environ.get('GITHUB_OUTPUT')
        if target:
            with open(target, 'a', encoding='utf-8') as fh:
                for key, value in result.items():
                    fh.write(f'{key}={value}\n')
        return 0
    if cmd == 'harness-files' and len(argv) > 2:
        for name in harness_files(argv[2]):
            print(name)
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
