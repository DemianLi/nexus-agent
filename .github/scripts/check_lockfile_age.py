"""lockfile 年齡檢查（#1545）：PR 新帶進 `pnpm-lock.yaml` 的版本，發布不到 `minimumReleaseAge` 就紅。

    check_lockfile_age.py <base sha>

**為什麼要這一步（偏離 dsh，理由 1：基座表達不出來）。** dsh 用 pnpm 11，年齡閘由 pnpm 自己在安裝時驗。nexus
留在 pnpm 10.34.5：它的年齡檢查只在解析時發生（`NO_MATURE_MATCHING_VERSION`），`--frozen-lockfile` 不重新解析，
已經寫進 lockfile 的版本 CI 不會再查。有人在本機用 `--config.minimum-release-age=0` 或改舊版 pnpm 產生 lockfile，
新版本就這樣進來了。退到：對 base 沒有、head 有的 `packages` 鍵逐一查 registry 的發布時間。

規則與 pnpm 對齊：
- 門檻與例外讀 `pnpm-workspace.yaml` 的 `minimumReleaseAge`（分鐘）與 `minimumReleaseAgeExclude`；
- 例外只收精確版本（`name@1.2.3`，或 dsh 用的 `name@1.2.3||1.2.4`）。只寫套件名的條目等於整個套件永遠免檢，
  這裡當成設定錯誤直接紅（政策寫在 `pnpm-workspace.yaml` 的註解）。

**查不到就紅（fail-closed）**：網路錯、404、packument 沒有那個版本的 `time`，一律當成不合格，訊息寫明原因。
lockfile 沒變、或只動了 `importers` 沒動 `packages`，不發任何請求。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[2]
REGISTRY = 'https://registry.npmjs.org/'

# 一個 `packages:` 鍵：`name@version`，名稱可帶 scope，鍵可能被單引號包住。
_KEY_RE = re.compile(r"^  '?((?:@[^/@\s]+/)?[^@\s']+)@([^\s':]+)'?:\s*$")
# 從 registry 解析來的版本長得像 semver；`file:`、`link:`、git、tarball 網址不走 registry，不查。
_SEMVER_RE = re.compile(r'^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$')


def lockfile_packages(text: str) -> set[tuple[str, str]]:
    """`packages:` 段落的每一個 `(name, version)`。不看 `importers` 與 `snapshots`。"""
    found: set[tuple[str, str]] = set()
    section = None
    for line in text.splitlines():
        if line and not line.startswith(' '):
            section = line.rstrip(':').strip()
            continue
        if section != 'packages':
            continue
        match = _KEY_RE.match(line)
        if match:
            found.add((match.group(1), match.group(2)))
    return found


@dataclass(frozen=True)
class Policy:
    minutes: int
    exclude: frozenset[str]


def _yaml_scalar(raw: str) -> str:
    raw = raw.split(' #', 1)[0].strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in '\'"':
        return raw[1:-1]
    return raw


def read_policy(text: str) -> Policy:
    """讀 `pnpm-workspace.yaml` 的兩個鍵。只認這個 repo 會寫的形狀：純量、`[]`、區塊清單。"""
    minutes: int | None = None
    exclude: list[str] = []
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith('minimumReleaseAge:'):
            minutes = int(_yaml_scalar(line.split(':', 1)[1]))
        elif line.startswith('minimumReleaseAgeExclude:'):
            rest = _yaml_scalar(line.split(':', 1)[1])
            if rest == '[]':
                continue
            if rest:
                raise ValueError(f'minimumReleaseAgeExclude 只認 [] 或區塊清單，讀到：{rest}')
            for item in lines[index + 1 :]:
                if item.strip().startswith('#') or not item.strip():
                    continue
                if not item.startswith('  - '):
                    break
                exclude.append(_yaml_scalar(item[4:]))
    if minutes is None:
        raise ValueError('pnpm-workspace.yaml 沒有 minimumReleaseAge：年齡閘沒設，這一步沒有門檻可比')
    for entry in exclude:
        name, _, versions = entry.rpartition('@')
        if not name or not versions or not all(_SEMVER_RE.match(v) for v in versions.split('||')):
            raise ValueError(f'minimumReleaseAgeExclude 只收精確版本（name@x.y.z），這一條不是：{entry}')
    return Policy(minutes, frozenset(exclude))


def excluded(name: str, version: str, policy: Policy) -> bool:
    for entry in policy.exclude:
        entry_name, _, versions = entry.rpartition('@')
        if entry_name == name and version in versions.split('||'):
            return True
    return False


def fetch_packument(name: str) -> dict:
    """完整 packument（abbreviated 那份沒有 `time`）。scope 的斜線要編碼成 `%2f`。"""
    url = REGISTRY + urllib.parse.quote(name, safe='@')
    request = urllib.request.Request(url, headers={'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


@dataclass(frozen=True)
class Finding:
    name: str
    version: str
    reason: str

    def __str__(self) -> str:
        return f'{self.name}@{self.version}：{self.reason}'


def check(
    base_lock: str | None,
    head_lock: str,
    policy: Policy,
    now: datetime,
    fetch: Callable[[str], dict] = fetch_packument,
) -> tuple[list[tuple[str, str]], list[Finding]]:
    """回傳（查過的版本, 不合格的版本）。`base_lock` 為 None 表示 base 沒有 lockfile：每一顆都是新的。"""
    if base_lock == head_lock:
        return [], []
    added = lockfile_packages(head_lock) - (lockfile_packages(base_lock) if base_lock is not None else set())
    checked: list[tuple[str, str]] = []
    findings: list[Finding] = []
    threshold = timedelta(minutes=policy.minutes)
    packuments: dict[str, dict | Exception] = {}
    for name, version in sorted(added):
        if not _SEMVER_RE.match(version) or excluded(name, version, policy):
            continue
        checked.append((name, version))
        if name not in packuments:
            try:
                packuments[name] = fetch(name)
            except (urllib.error.URLError, OSError, ValueError) as error:
                packuments[name] = error
        packument = packuments[name]
        if isinstance(packument, Exception):
            findings.append(Finding(name, version, f'查不到 registry（{packument}），不能確認發布時間'))
            continue
        published = (packument.get('time') or {}).get(version)
        if not published:
            findings.append(Finding(name, version, 'packument 裡沒有這個版本的發布時間'))
            continue
        at = datetime.fromisoformat(published.replace('Z', '+00:00'))
        if now - at < threshold:
            findings.append(Finding(name, version, f'發布於 {published}，未滿 {policy.minutes} 分鐘'))
    return checked, findings


def git_show(sha: str, path: str) -> str | None:
    result = subprocess.run(['git', 'show', f'{sha}:{path}'], cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        if 'does not exist' in result.stderr or 'exists on disk, but not in' in result.stderr:
            return None
        raise RuntimeError(f'git show {sha}:{path} 失敗：{result.stderr.strip()}')
    return result.stdout


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    base = argv[1]
    head_lock = (ROOT / 'pnpm-lock.yaml').read_text(encoding='utf-8')
    policy = read_policy((ROOT / 'pnpm-workspace.yaml').read_text(encoding='utf-8'))
    checked, findings = check(git_show(base, 'pnpm-lock.yaml'), head_lock, policy, datetime.now(timezone.utc))
    if not checked and not findings:
        print(f'lockfile 對 {base[:8]} 沒有新的 registry 版本，不用查。')
        return 0
    print(f'查了 {len(checked)} 個新版本（門檻 {policy.minutes} 分鐘）：')
    for name, version in checked:
        print(f'  {name}@{version}')
    if findings:
        print('::error::lockfile 帶進了發布太新或查不到發布時間的版本：', file=sys.stderr)
        for finding in findings:
            print(f'  {finding}', file=sys.stderr)
        print('等它滿 24 小時再更新 lockfile；真的等不了，在 pnpm-workspace.yaml 的 minimumReleaseAgeExclude 加精確版本並寫理由。', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
