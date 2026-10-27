"""決定這一輪 CI 要跑什麼。規範與取捨見 .github/workflows/ci.yml 檔頭與 AGENTS.md。

兩個子指令：

    plan_ci.py plan                        讀 changed.txt 與環境變數，把要跑的範圍寫到 $GITHUB_OUTPUT
    plan_ci.py test-files <harness|web> <sha>
                                           印出該 app 這一輪要跑的測試檔（`vitest --changed` 的結果 ∪ 必跑集合）

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

# 有這些異動才值得掃 TypeScript。非 TypeScript 的檔名是刻意的窄例外（「測試會讀這個檔」）：
# `docs/operations.md`、`docs/persistence-schema.json` 與 `docs/persistence-changes/`（#1856）、`apps/harness/cordis.yml`、`apps/harness/cordis.serve.yml`、`apps/harness/src/*.patch.yml`，
# 以及 web 的樣式（#1512）：`apps/web` 底下的 `.css`（讀 cascade 的護欄、build 後的 check-built-css 與瀏覽器護欄都量它）、
# 產生顏色 token 的 `tokengen/`、build 後檢查產物的 `scripts/*.mjs`、瀏覽器護欄的測試頁 `guard/`，以及 `apps/web/index.html`
# （內嵌的主題腳本：`src/lib/theme.test.tsx` 讀它、瀏覽器護欄的測試頁照抄它）。少了這幾條，
# 只調 CSS 的 PR（例如把陰影調深）static 與 test-web 全部 skipped、gate 照樣綠。
# 別放寬成所有 `.md` 或所有 `.yml`：「純文件的 PR 不會卡住」是設計。
TS_RE = re.compile(
    r'\.(ts|tsx|mts|cts)$'
    r'|^package\.json$|^pnpm-lock\.yaml$|^tsconfig.*\.json$'
    r'|^docs/operations\.md$'
    r'|^docs/persistence-schema\.json$'
    r'|^docs/persistence-changes/'
    r'|^apps/harness/cordis(\.serve)?\.yml$'
    r'|^apps/harness/src/.*\.patch\.yml$'
    r'|^apps/web/.*\.css$|^apps/web/tokengen/|^apps/web/scripts/.*\.mjs$|^apps/web/guard/'
    r'|^apps/web/index\.html$'
)

# 這些異動讓「哪些測試相關」的判斷失去依據，一律全跑（同時也一定會觸發掃描）。
FULL_RES = [
    re.compile(rx)
    for rx in (
        # 全部套件都依賴它們。vendor 的 Cordis 是容器本身（#1401）。
        # sdk、tools、projections、session、fs、skills、commands、feedback、goal、approval-channel、tool-result、agent-loop、system-prompt、permission-presets 是插件規範與接縫的定義（#1416、#1421、#1435、#1446、#1456、#1458、#1466、#1474、#1477、#1486、#1491）：遷出的插件都相依它們，改了就不能只跑改動的那幾顆插件。
        r'^packages/nexus-(core|wire|sdk|tools|projections|session|fs|skills|commands|feedback|goal|approval-channel|tool-result|agent-loop|system-prompt|permission-presets|deque|brand|timeout)/',
        r'^vendor/',
        # 相依、工具鏈、workspace 設定：影響每一個套件。
        r'^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.prettierignore|\.prettierrc.*|prettier\.config\..*)$',
        r'^(eslint\.config\..*|tsconfig.*\.json|vitest\..*)$',
        # CI 自己：改了它就該用它驗一次完整的。`actions/` 是每個 job 共用的 setup（Node 版本在這裡，#1546）。
        r'^\.github/(workflows|scripts|actions)/',
        # 漏洞掃描的例外清單（#1545）：格式由 `.github/scripts/test_check_audit.py` 驗，只改清單的 PR 也要跑到它。
        r'^\.github/audit-exceptions\.json$',
        # 測試「讀」而不是 import 的檔：import 圖看不到它們（見 ci.yml 的說明）。
        r'^docs/operations\.md$',
        r'^apps/harness/(cordis(\.serve)?\.yml|package\.json|vitest\.config\..*|tsconfig.*\.json|eslint\.config\..*)$',
        r'^apps/harness/src/(test-home\.setup\.ts|.*\.patch\.yml|.*\.fixture\.ts)$',
        # 已出貨格式的會話日誌夾具（#1529）：`session-format-fixtures.test.ts` 讀它們，副檔名不是 .ts，只改夾具時 TS_RE 看不到。
        r'^apps/harness/src/fixtures/session-format/',
        # 持久化型別圖（#1856）：`persistence-schema.test.ts` 讀它比對原始碼，副檔名不是 .ts，只手改它的 PR TS_RE 看不到。
        r'^docs/persistence-schema\.json$',
        # 持久化型別變更的確認紀錄（#1856 ⓪b-2）：`persistence-changes.test.ts` 讀整個目錄驗歷史，只改紀錄的 PR TS_RE 看不到。
        r'^docs/persistence-changes/',
        r'^apps/web/(package\.json|vite\.config\..*|vitest\.config\..*|tsconfig.*\.json|eslint\.config\..*)$',
    )
]


# 量測（2026-09-29，GitHub 公開倉庫的標準 runner）：harness 單片約 190 秒，兩片各約 80–110 秒，
# 三片沒有更快（vitest 依檔名雜湊分片、不看耗時，片間不均）。web 單片約 85 秒，低於 harness 的一片，不需要分。
HARNESS_SHARDS = 2


def read_changed(path: str = 'changed.txt') -> list[str]:
    return [line.strip() for line in Path(path).read_text(encoding='utf-8').splitlines() if line.strip()]


def changed_plugin_dirs(changed: list[str]) -> list[str]:
    """異動落在哪些 `packages/nexus-plugin-*` 目錄（core 與 wire 走全跑，不在這裡）。"""
    dirs = {m.group(1) for p in changed if (m := re.match(r'^(packages/nexus-plugin-[^/]+)/', p))}
    return sorted(d for d in dirs if (ROOT / d / 'package.json').exists())


def plan(changed: list[str], event: str, base_ref: str, force_full: bool = False) -> dict[str, str]:
    """`force_full` 是合併後完整一輪（`post-merge.yml` 呼叫 ci.yml 時帶 `full: true`）：不看異動，一律全跑。"""
    forced = force_full or any(rx.search(p) for p in changed for rx in FULL_RES)
    if not (forced or any(TS_RE.search(p) for p in changed)):
        return {
            'ts': 'false',
            'full': 'false',
            'pkg_filters': '',
            'test_mode': 'none',
            'harness_shards': '[1]',
            'harness_shard_total': '1',
        }

    selective = event == 'pull_request' and base_ref == 'develop' and not forced
    if selective:
        pkg_filters = ' '.join(f'--filter=./{d}' for d in changed_plugin_dirs(changed))
    else:
        # vendor 只有全跑時才測：它的異動本來就一律觸發全跑（見 FULL_RES）。
        pkg_filters = '--filter=./packages/* --filter=./vendor/*'
    # 全跑時 harness 是關鍵路徑（單一 job 約三分鐘），切片平行跑；選擇性時只有幾十個檔，切了只是多付安裝。
    harness_total = 1 if selective else HARNESS_SHARDS
    return {
        'ts': 'true',
        'full': 'false' if selective else 'true',
        'pkg_filters': pkg_filters,
        'test_mode': 'selective' if selective else 'full',
        'harness_shards': json.dumps(list(range(1, harness_total + 1))),
        'harness_shard_total': str(harness_total),
    }


class Suite:
    """一個 app 的測試怎麼挑。`markers` 是「import 圖看不到、所以不管異動落在哪都必須跑」的測試的特徵字串。"""

    def __init__(self, directory: str, suffixes: tuple[str, ...], markers: tuple[str, ...]) -> None:
        self.dir = ROOT / directory
        self.suffixes = suffixes
        self.markers = markers

    def always_run(self) -> list[str]:
        found = []
        for path in sorted(self.dir.rglob('*')):
            if 'node_modules' in path.parts or not path.name.endswith(self.suffixes):
                continue
            if any(marker in path.read_text(encoding='utf-8') for marker in self.markers):
                found.append(path.relative_to(self.dir).as_posix())
        return found

    def files(self, base_sha: str) -> list[str]:
        out = subprocess.run(
            ['pnpm', 'exec', 'vitest', 'list', '--changed', base_sha, '--filesOnly'],
            cwd=self.dir,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        related = [line.strip() for line in out.splitlines() if line.strip().endswith(self.suffixes)]
        return sorted(set(related) | set(self.always_run()))


# 必跑集合一律從檔案內容偵測，不維護清單——清單會過期，而漏掉的那一個就是沒人看的護欄：
#
# - harness：用 `shippedPlugins()` 的測試照 cordis.yml 用 `import(entry.name)` 動態載入 plugin，plugin 原始碼的異動
#   不在靜態 import 圖上；掃描整個原始碼樹的絆索測試（`'apps/web/src'` 出現在掃描根裡）異動落在哪都可能踩到。
# - harness 的插件套件 gate（#1420）：`collectMigratedPluginViolations` 依檔案路徑動態載入每顆 `packages/nexus-plugin-*`
#   的入口，不在 import 圖上。只動某顆插件的 PR（選擇性模式）不會讓它被挑到，而「遷出了卻忘了寫一致性測試」正是它要擋的。
# - harness 的第三方元件清單（#1545）：新鮮度那格讀網頁的樣式表、也跑一次網頁 build 收 import，都不在 import 圖上。
#   選擇性模式下這個 marker 補到的是：只改網頁的 CSS（例如換字型的 `@import`），或網頁原始碼新增一個第三方 import——
#   兩種都會讓清單過期，而漏跑它 CI 照樣綠。改相依一定動到 `pnpm-lock.yaml`，本來就走全跑；只改某顆插件的 `package.json`、
#   沒有任何 TypeScript 異動時 `TS_RE` 不中，整個掃描不跑，這個 marker 也補不到。
# - harness 的持久化型別變更紀錄（#1856 ⓪b-2）：`verifyPersistenceChanges` 那格用 TypeScript 編譯器從原始碼抽型別圖，
#   會話事件可以宣告在任何一顆套件裡，不在 import 圖上。只改某顆插件的事件酬載（選擇性模式）也要跑到它，
#   否則「動了持久化型別卻沒寫紀錄」照樣綠。
# - web：用 fs 讀原始碼的測試（讀的是別的檔，import 圖看不到），以及經 `readCascade` 讀樣式表的護欄（#1498 起
#   tokens-contrast、focus-outline、shadow-alpha、font-stack 改走量具，檔案本身不再出現 readFileSync，但讀的照樣是 CSS）。
SUITES = {
    'harness': Suite(
        'apps/harness',
        ('.test.ts',),
        ('shippedPlugins', "'apps/web/src'", 'collectMigratedPluginViolations', 'gen-third-party-notices',
         'verifyPersistenceChanges'),
    ),
    'web': Suite('apps/web', ('.test.ts', '.test.tsx'), ('readFileSync', 'readdirSync', 'readCascade')),
}


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'plan':
        result = plan(
            read_changed(),
            os.environ.get('EVENT_NAME', ''),
            os.environ.get('BASE_REF', ''),
            os.environ.get('FORCE_FULL', '') == 'true',
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        target = os.environ.get('GITHUB_OUTPUT')
        if target:
            with open(target, 'a', encoding='utf-8') as fh:
                for key, value in result.items():
                    fh.write(f'{key}={value}\n')
        return 0
    if cmd == 'test-files' and len(argv) > 3 and argv[2] in SUITES:
        for name in SUITES[argv[2]].files(argv[3]):
            print(name)
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
