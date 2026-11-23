"""CI 裡 Rust 產物與 vitest 結果檔的路徑，都從一個來源推出來，不各抄一份字面值。

- 沙箱 spawner 的 crate 目錄 = `.github/actions/sandbox-spawner/action.yml` 裡 cargo 步驟的 `working-directory`。
  同一支 action 的快取路徑（`<crate>/target`）、`hashFiles` 的檔、打包監督行程的 `<crate>/target/.../release`，
  以及 `ci.yml` 的 `sandbox-spawner`、`sandbox-spawner-arm64` 的 cargo 步驟與 `NEXUS_*_BIN` 的執行檔路徑，都要落在這個目錄底下。
  crate 目錄在這一版要真的有 `Cargo.toml`。
- vitest 結果檔 `cp <harness 套件目錄>/node_modules/.vite/vitest/*/results.json`（`ci.yml`、`post-merge.yml`，只在 full 與合併後跑）的
  套件目錄 = `@nexus/harness` 這一版真的在的目錄（舊形狀與新形狀都認，見 `plan_ci.project_dirs`）。

只改 cargo 的 `working-directory`、或只改執行檔或快取的路徑，都會紅；兩邊一起搬才綠。沙箱整合測試那一步要核對通過的條數不是 0，x64 與 arm64 都要。找不到任何一條要檢查的路徑也是紅的：
這些路徑是字串，搬目錄時沒有別的東西會替它們報錯，快取那幾行永遠不會因為路徑錯而紅，只是悄悄失效。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import plan_ci  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
ACTION = '.github/actions/sandbox-spawner/action.yml'
CI = '.github/workflows/ci.yml'
POST_MERGE = '.github/workflows/post-merge.yml'
TARGET = '${{ env.SPAWNER_TARGET }}'

WORKING_DIRECTORY = re.compile(r'^\s*working-directory:\s*(.+?)\s*$', re.M)
WORKSPACE_BIN = re.compile(r'\$\{\{ github\.workspace \}\}/(\S+?)/target/' + re.escape(TARGET) + r'/release/(\S+)')
CACHE_TARGET = re.compile(r'^\s+(\S+)/target\s*$', re.M)
HASH_FILES = re.compile(r"hashFiles\(([^)]*)\)")
VITEST_RESULT = re.compile(r'cp\s+(\S+?)/node_modules/\.vite/vitest/\*/results\.json')


def jobs_of(text: str) -> dict[str, str]:
    head, _, body = text.partition('\njobs:\n')
    out: dict[str, str] = {}
    name = ''
    for line in body.split('\n'):
        if m := re.match(r'^  ([\w-]+):\s*$', line):
            name = m.group(1)
            out[name] = ''
        elif name:
            out[name] += line + '\n'
    return out


def crate_dirs(text: str) -> set[str]:
    return {v for v in WORKING_DIRECTORY.findall(text) if '/target' not in v}


def check_action(root: Path) -> tuple[str | None, list[str]]:
    path = root / ACTION
    if not path.is_file():
        return None, [f'{ACTION} 不在這一版。']
    text = path.read_text(encoding='utf-8')
    dirs = crate_dirs(text)
    if len(dirs) != 1:
        return None, [f'{ACTION} 的 cargo 步驟要在同一個 crate 目錄跑，讀到 {sorted(dirs) or "沒有任何 working-directory"}。']
    crate = next(iter(dirs))
    errors: list[str] = []
    if not (root / crate / 'Cargo.toml').is_file():
        errors.append(f'{ACTION} 的 cargo 步驟在 {crate} 跑，這一版沒有 {crate}/Cargo.toml。')
    release = f'{crate}/target/{TARGET}/release'
    for value in WORKING_DIRECTORY.findall(text):
        if '/target' in value and value != release:
            errors.append(f'{ACTION} 打包執行檔的目錄是 {value}，從 crate 推出來要是 {release}。')
    caches = CACHE_TARGET.findall(text)
    if not caches:
        errors.append(f'{ACTION} 找不到快取的 <crate>/target 路徑：快取會悄悄失效。')
    errors += [f'{ACTION} 快取的路徑是 {c}/target，從 crate 推出來要是 {crate}/target。' for c in caches if c != crate]
    hashes = [a.strip().strip("'\"") for call in HASH_FILES.findall(text) for a in call.split(',')]
    if not hashes:
        errors.append(f'{ACTION} 找不到快取鍵的 hashFiles：鍵不會隨 Cargo.lock 變。')
    for h in hashes:
        if h not in (f'{crate}/Cargo.lock', f'{crate}/rust-toolchain.toml'):
            errors.append(f'{ACTION} 快取鍵讀的是 {h}，要是 {crate}/Cargo.lock 或 {crate}/rust-toolchain.toml。')
    return crate, errors


def check_ci(root: Path, crate: str) -> list[str]:
    path = root / CI
    text = path.read_text(encoding='utf-8')
    errors: list[str] = []
    jobs = jobs_of(text)
    for name in ('sandbox-spawner', 'sandbox-spawner-arm64'):
        dirs = crate_dirs(jobs.get(name, ''))
        if dirs != {crate}:
            errors.append(f'{CI} 的 {name} 的 cargo 步驟在 {sorted(dirs) or "沒有 working-directory"} 跑，action 的 crate 是 {crate}。')
    found = 0
    for name, body in jobs.items():
        for where, binary in WORKSPACE_BIN.findall(body):
            found += 1
            if where != crate:
                errors.append(f'{CI} 的 {name}：{binary} 的路徑落在 {where}/target，從 crate 推出來要是 {crate}/target。')
    if found == 0:
        errors.append(f'{CI} 找不到任何 NEXUS_*_BIN 的執行檔路徑：沙箱整合測試會找不到執行檔而整支跳過。')
    return errors


INTEGRATION_STEP = '真的 spawner 跑整合測試'
TEE = re.compile(r'\|\s*tee\s+"([^"]+)"')


def step_block(job: str, name: str) -> str | None:
    m = re.search(r'^      - name: ' + re.escape(name) + r'\s*$\n((?:(?!      - |      #).*\n)*)', job, re.M)
    return m.group(1) if m else None


def check_integration_count(root: Path) -> list[str]:
    """整合測試的 env 沒設時整支跳過、vitest 照樣 exit 0：那一步要核對通過的條數不是 0，x64 與 arm64 都要。"""
    jobs = jobs_of((root / CI).read_text(encoding='utf-8'))
    errors: list[str] = []
    for name in ('sandbox-spawner', 'sandbox-spawner-arm64'):
        block = step_block(jobs.get(name, ''), INTEGRATION_STEP)
        where = f'{CI} 的 {name}「{INTEGRATION_STEP}」'
        if block is None:
            errors.append(f'{where} 找不到這一步。')
            continue
        if not re.search(r'^\s+shell:\s*bash\s*$', block, re.M):
            errors.append(f'{where}沒有 shell: bash，沒有 pipefail，tee 會吞掉 vitest 的失敗。')
        tee = TEE.search(block)
        if tee is None:
            errors.append(f'{where}沒有把輸出 tee 進檔案，核對不了通過的條數。')
            continue
        counted = re.search(r"grep -E[a-z]*q? '[^']*\[1-9\]\[0-9\]\* passed[^']*' \"" + re.escape(tee.group(1)) + r'"', block)
        if counted is None:
            errors.append(f'{where}沒有對 {tee.group(1)} 核對「通過條數不是 0」。')
    return errors


def harness_dir(root: Path) -> str | None:
    return plan_ci.project_dirs(root).get('apps/harness')


def check_vitest_results(root: Path) -> list[str]:
    errors: list[str] = []
    expected = harness_dir(root)
    if expected is None:
        return ['找不到 @nexus/harness 的套件目錄：apps/harness 與 harness/apps/harness 這一版都沒有 package.json。']
    for rel in (CI, POST_MERGE):
        hits = VITEST_RESULT.findall((root / rel).read_text(encoding='utf-8'))
        if not hits:
            errors.append(f'{rel} 找不到 vitest 結果檔的 cp 路徑：耗時紀錄會悄悄停掉。')
        errors += [f'{rel} 的 vitest 結果檔從 {h} 複製，harness 套件在 {expected}。' for h in hits if h != expected]
    return errors


def check(root: Path) -> list[str]:
    crate, errors = check_action(root)
    if crate is not None:
        errors += check_ci(root, crate)
    return errors + check_integration_count(root) + check_vitest_results(root)


def main() -> int:
    errors = check(ROOT)
    for e in errors:
        print(f'::error::{e}')
    if errors:
        return 1
    print('Rust 產物與 vitest 結果檔的路徑通過。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
