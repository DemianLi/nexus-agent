"""Node 相容冒煙（#1546）：ci.yml 的 node-compat job 在矩陣的每一格跑這支。

    node_compat.py smoke    逐檔跑 node-compat-files.txt 列的測試，核對每一檔都真的跑了

清單、為什麼是這幾檔，見 node-compat-files.txt 檔頭。照 dsh `scripts/run-gates.ts:444-460`：逐檔、串行。

**不能交給 vitest 自己判斷「有沒有跑到」**：vitest 的位置參數是子字串過濾，不是路徑。清單裡寫錯一個檔名，
其他檔照跑、以 0 結束，job 是綠的。所以這裡先核對每一檔都存在，跑完再讀 JSON 報告，核對「實際跑了的檔」
正好等於清單、每一檔至少一條測試。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIST = ROOT / '.github' / 'scripts' / 'node-compat-files.txt'


def read_list(path: Path = LIST) -> list[str]:
    """清單裡的路徑（從 repo 根算），去掉註解與空行。"""
    files = []
    for line in path.read_text(encoding='utf-8').splitlines():
        entry = line.split('#', 1)[0].strip()
        if entry:
            files.append(entry)
    return files


def group_by_app(files: list[str]) -> dict[str, list[str]]:
    """依 `apps/<名稱>/` 分組，各組在自己的目錄下跑 vitest（各 app 有自己的 vitest 設定）。"""
    groups: dict[str, list[str]] = {}
    for f in files:
        parts = f.split('/')
        if len(parts) < 3 or parts[0] != 'apps':
            raise ValueError(f'清單只收 apps/<名稱>/ 底下的測試：{f}')
        groups.setdefault('/'.join(parts[:2]), []).append(f)
    return groups


def check_report(report: dict, expected: list[str]) -> list[str]:
    """核對 vitest 的 JSON 報告：跑了的檔正好是清單、每一檔至少一條、全部通過。回傳問題清單（空的表示通過）。"""
    problems = []
    ran = {}
    for result in report.get('testResults', []):
        ran[os.path.relpath(result['name'], ROOT)] = len(result.get('assertionResults', []))
    missing = sorted(set(expected) - set(ran))
    extra = sorted(set(ran) - set(expected))
    if missing:
        problems.append(f'清單裡這幾檔沒有跑到：{missing}')
    if extra:
        problems.append(f'跑到清單以外的檔：{extra}')
    for f, count in sorted(ran.items()):
        if count == 0:
            problems.append(f'{f} 一條測試都沒有')
    if report.get('numTotalTests', 0) == 0:
        problems.append('測試數是 0')
    if not report.get('success', False):
        problems.append('有測試沒過')
    return problems


def smoke() -> int:
    files = read_list()
    if not files:
        print('::error::冒煙清單是空的')
        return 1
    absent = [f for f in files if not (ROOT / f).is_file()]
    if absent:
        for f in absent:
            print(f'::error::冒煙清單裡的檔不存在：{f}')
        return 1

    rc = 0
    for app, group in group_by_app(files).items():
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'report.json'
            relative = [os.path.relpath(ROOT / f, ROOT / app) for f in group]
            cmd = [
                'pnpm', 'exec', 'vitest', 'run', *relative,
                '--no-file-parallelism', '--maxWorkers=1',
                '--reporter=default', '--reporter=json', f'--outputFile.json={out}',
            ]
            print(f'::group::{app}（{len(group)} 檔）', flush=True)
            code = subprocess.run(cmd, cwd=ROOT / app).returncode
            print('::endgroup::', flush=True)
            if not out.is_file():
                print(f'::error::{app} 的 vitest 沒寫出報告（退出碼 {code}）')
                rc = 1
                continue
            problems = check_report(json.loads(out.read_text(encoding='utf-8')), group)
            if code != 0:
                problems.append(f'vitest 退出碼 {code}')
            for p in problems:
                print(f'::error::{app}：{p}')
            if problems:
                rc = 1
            else:
                print(f'{app}：{len(group)} 檔全部跑到、全部通過')
    return rc


def main(argv: list[str]) -> int:
    if argv[1:] == ['smoke']:
        return smoke()
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
