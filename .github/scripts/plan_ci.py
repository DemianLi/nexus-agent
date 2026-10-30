"""決定這一輪 CI 要跑什麼。規範與取捨見 .github/workflows/ci.yml 檔頭與 AGENTS.md。

兩個子指令：

    plan_ci.py plan            讀 changed.txt 與環境變數，把模式（`mode`）、要不要掃（`ts`）、要不要編沙箱 spawner（`rust`）寫到 $GITHUB_OUTPUT
    plan_ci.py light <dir>     輕的模式：讀 changed.txt，把要型別檢查的套件、要 format、lint、測試的檔寫進 <dir>

功能分支 → develop 的 PR 走輕的模式，只有動到 CI 自己時全跑；`develop → main` 的 PR、`main` 的 push、
合併後完整一輪一律全跑（#2088 決議第 5、15 條）。
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# 有這些異動才值得掃 TypeScript。非 TypeScript 的檔名是刻意的窄例外（「測試會讀這個檔」）：
# `docs/operations.md`、`docs/persistence-schema.json` 與 `docs/persistence-changes/`（#1856）、`apps/harness/cordis.yml`、`apps/harness/cordis.serve.yml`、`apps/harness/src/*.patch.yml`，
# 以及 web 的樣式（#1512）：`apps/web` 底下的 `.css`（讀 cascade 的護欄、build 後的 check-built-css 與瀏覽器護欄都量它）、
# 產生顏色 token 的 `tokengen/`、build 後檢查產物的 `scripts/*.mjs`、瀏覽器護欄的測試頁 `guard/`，以及 `apps/web/index.html`
# （內嵌的主題腳本：`src/lib/theme.test.tsx` 讀它、瀏覽器護欄的測試頁照抄它）。少了這幾條，
# 只調 CSS 的 commit 在全跑那一層 static 與 test-web 全部 skipped、gate 照樣綠。
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

# 不是 TypeScript、但在全跑那一層也要觸發掃描的異動。
SCAN_RES = [
    re.compile(rx)
    for rx in (
        # vendor 的 Cordis 是容器本身（#1401）。
        r'^vendor/',
        # 相依、工具鏈、workspace 設定：影響每一個套件。
        r'^(pnpm-workspace\.yaml|\.npmrc|\.prettierignore|\.prettierrc.*|prettier\.config\..*)$',
        r'^(eslint\.config\..*|vitest\..*)$',
        r'^apps/(harness|web)/(package\.json|tsconfig.*\.json|eslint\.config\..*)$',
        # CI 自己。`actions/` 是每個 job 共用的 setup（Node 版本在這裡，#1546）。
        r'^\.github/(workflows|scripts|actions)/',
        # 漏洞掃描的例外清單（#1545）：格式由 `.github/scripts/test_check_audit.py` 驗。
        r'^\.github/audit-exceptions\.json$',
        # 已出貨格式的會話日誌夾具（#1529）：`session-format-fixtures.test.ts` 讀它們，副檔名不是 .ts。
        r'^apps/harness/src/fixtures/session-format/',
    )
]


def read_changed(path: str = 'changed.txt') -> list[str]:
    return [line.strip() for line in Path(path).read_text(encoding='utf-8').splitlines() if line.strip()]


# 功能 PR 動到這些時全跑：改壞了 CI 自己，合併前只有全跑驗得出來（#2088 決議第 15 條）。
FULL_RE = re.compile(r'^\.github/(workflows|scripts|actions)/')


# 沙箱 spawner 的 Rust（#1946）在這幾種情況編：動到它、TS 那一側的接縫與 client、CI 自己、packed-install 要跑的一輪（包裡的 spawner 是 sandbox-spawner
# 那個 job 編的，develop → main 的 PR 走這一條）、合併後完整一輪（#1827 D55）。跟模式無關，輕的模式也編。
RUST_RE = re.compile(
    r'^native/sandbox-spawner/'
    r'|^packages/nexus-plugin-workspace-changes/src/git\.'
    r'|^apps/harness/src/(sandbox-protocol|sandbox-spawner\S*|tool-process|tool-launcher|ripgrep-sandbox|ripgrep-runner|git-sandbox\S*)\.'
)


def plan(changed: list[str], event: str, base_ref: str, force_full: bool = False) -> dict[str, str]:
    """`force_full` 是合併後完整一輪（`post-merge.yml` 呼叫 ci.yml 時帶 `full: true`）：不看異動，一律全跑。"""
    feature_pr = event == 'pull_request' and base_ref == 'develop'
    rust = 'true' if force_full or any(RUST_RE.search(p) or FULL_RE.search(p) for p in changed) else 'false'
    if feature_pr and not force_full and not any(FULL_RE.search(p) for p in changed):
        return {'mode': 'light', 'ts': 'false', 'rust': rust}
    scan = force_full or any(TS_RE.search(p) or any(rx.search(p) for rx in SCAN_RES) for p in changed)
    return {'mode': 'full', 'ts': 'true' if scan else 'false', 'rust': 'true' if scan else rust}


# 輕的模式只型別檢查受影響的套件：改到的，加上它的下游（由 pnpm 的 `...` 算）。
# 這些異動影響每一個套件，一律全查：相依與工具鏈、根的 tsconfig（paths 也在這裡）、vendor 的 Cordis。
TYPECHECK_ALL_RE = re.compile(r'^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|tsconfig[^/]*\.json)$|^vendor/')

# 型別檢查的範圍是 `packages/*` 與 `apps/*`，跟全跑那一層的 typecheck job 一樣。
PROJECT_RE = re.compile(r'^((?:packages|apps)/[^/]+)/')
# 套件裡會改變型別檢查結果的檔：原始碼、`package.json`、`tsconfig*.json`、可被 import 的 JSON。只改 README 不查。
TYPECHECK_FILE_RE = re.compile(r'\.(ts|tsx|mts|cts|json)$')
LINT_RE = re.compile(r'\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$')
TEST_RE = re.compile(r'\.test\.tsx?$')
SOURCE_RE = re.compile(r'^(.*)\.(ts|tsx|mts|cts)$')
# 瀏覽器護欄有自己的 vitest 設定，在全跑那一層跑（#2088 決議第 5 條）。
TEST_EXCLUDE_RE = re.compile(r'^apps/web/guard/')
# `*.md` 全在 `.prettierignore`：只改文件的 PR 不必為了 format 安裝相依。
FORMAT_SKIP_RE = re.compile(r'\.md$')


def project_names(root: Path = ROOT) -> dict[str, str]:
    """`packages/*`、`apps/*` 的目錄 → 套件名。"""
    manifests = sorted([*root.glob('packages/*/package.json'), *root.glob('apps/*/package.json')])
    return {m.parent.relative_to(root).as_posix(): json.loads(m.read_text(encoding='utf-8'))['name'] for m in manifests}


def light(changed: list[str], names: dict[str, str], exists: Callable[[str], bool]) -> dict:
    """輕的模式的範圍（#2088 決議第 5、7 條）。`exists` 判斷檔案在這一版還在不在：刪掉的檔不 format、不 lint、不測。"""

    def project(path: str) -> str | None:
        match = PROJECT_RE.match(path)
        return match.group(1) if match and match.group(1) in names else None

    present = [p for p in changed if exists(p)]

    if any(TYPECHECK_ALL_RE.search(p) for p in changed):
        typecheck: str | list[str] = 'all'
    else:
        typecheck = sorted({names[d] for p in changed if (d := project(p)) and TYPECHECK_FILE_RE.search(p)})

    lint: dict[str, list[str]] = {}
    for p in present:
        if (d := project(p)) and LINT_RE.search(p):
            lint.setdefault(d, []).append(p[len(d) + 1:])

    # 這次改到的測試檔，加上改到的原始檔在同一目錄下的同名測試檔（`foo.ts` → `foo.test.ts`、`foo.test.tsx`）。
    tests: dict[str, set[str]] = {}
    for p in changed:
        d = project(p)
        if d is None or TEST_EXCLUDE_RE.search(p):
            continue
        if TEST_RE.search(p):
            candidates = [p]
        elif (match := SOURCE_RE.match(p)) and not p.endswith('.d.ts'):
            candidates = [f'{match.group(1)}.test.ts', f'{match.group(1)}.test.tsx']
        else:
            continue
        for c in candidates:
            if exists(c):
                tests.setdefault(d, set()).add(c[len(d) + 1:])

    return {
        'typecheck': typecheck,
        'format': [p for p in present if not FORMAT_SKIP_RE.search(p)],
        'lint': lint,
        'tests': {d: sorted(files) for d, files in tests.items()},
    }


def write_light(scope: dict, out: Path) -> None:
    """寫成 shell 好讀的檔：`typecheck.txt` 是 pnpm 的參數，`lint.tsv`、`tests.tsv` 一行是「目錄<TAB>檔」。"""
    out.mkdir(parents=True, exist_ok=True)
    if scope['typecheck'] == 'all':
        args = ['--filter=./packages/*', '--filter=./apps/*']
    else:
        args = [f'--filter=...{name}' for name in scope['typecheck']]
    (out / 'typecheck.txt').write_text(''.join(f'{a}\n' for a in args), encoding='utf-8')
    (out / 'format.txt').write_text(''.join(f'{p}\n' for p in scope['format']), encoding='utf-8')
    for name in ('lint', 'tests'):
        rows = [f'{d}\t{f}\n' for d, files in sorted(scope[name].items()) for f in files]
        (out / f'{name}.tsv').write_text(''.join(rows), encoding='utf-8')


def needs_node(scope: dict) -> bool:
    """四件事都沒東西可做時，輕的模式不安裝相依（只改文件的 PR）。"""
    return bool(scope['typecheck'] or scope['format'] or scope['lint'] or scope['tests'])


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
    if cmd == 'light' and len(argv) > 2:
        scope = light(read_changed(), project_names(), lambda p: (ROOT / p).is_file())
        print(json.dumps(scope, ensure_ascii=False, indent=2))
        write_light(scope, Path(argv[2]))
        target = os.environ.get('GITHUB_OUTPUT')
        if target:
            with open(target, 'a', encoding='utf-8') as fh:
                fh.write(f"node={'true' if needs_node(scope) else 'false'}\n")
                fh.write(f"typecheck={'true' if scope['typecheck'] else 'false'}\n")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
