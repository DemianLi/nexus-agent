"""lockfile 年齡檢查（#1545）的單元紅燈，以及釘住 `pnpm-workspace.yaml` 與根 `package.json` 的供應鏈設定。

在 static 跑（`python3 -m unittest discover -s .github/scripts`）。不連網：registry 一律用注入的 fetch。
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone

from check_lockfile_age import ROOT, Policy, check, lockfile_packages, read_policy

NOW = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)
DAY = Policy(1440, frozenset())


def lock(packages: list[str], importer_spec: str = '^1.0.0') -> str:
    """最小的 lockfile v9：一個 importer、`packages` 與 `snapshots` 各列一次。"""
    body = [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      old:',
        f'        specifier: {importer_spec}',
        '        version: 1.0.0',
        '',
        'packages:',
        '',
    ]
    for key in packages:
        body += [f'  {key}:', '    resolution: {integrity: sha512-x}', '']
    body += ['snapshots:', '']
    for key in packages:
        body += [f'  {key}: {{}}', '']
    return '\n'.join(body)


class CountingFetch:
    """注入的 registry：記下被問了哪些套件，回 `time`。"""

    def __init__(self, times: dict[str, dict[str, str]]) -> None:
        self.times = times
        self.calls: list[str] = []

    def __call__(self, name: str) -> dict:
        self.calls.append(name)
        if name not in self.times:
            raise OSError(f'404 {name}')
        return {'name': name, 'time': self.times[name]}


def iso(delta: timedelta) -> str:
    return (NOW - delta).strftime('%Y-%m-%dT%H:%M:%S.000Z')


BASE = lock(['old@1.0.0'])


class LockfileAge(unittest.TestCase):
    def test_new_version_ten_minutes_old_fails(self) -> None:
        fetch = CountingFetch({'fresh': {'1.0.0': iso(timedelta(minutes=10))}})
        checked, findings = check(BASE, lock(['old@1.0.0', 'fresh@1.0.0']), DAY, NOW, fetch)
        self.assertEqual(checked, [('fresh', '1.0.0')])
        self.assertEqual([(f.name, f.version) for f in findings], [('fresh', '1.0.0')])
        self.assertIn('未滿 1440 分鐘', findings[0].reason)
        self.assertEqual(fetch.calls, ['fresh'])

    def test_new_version_older_than_threshold_passes(self) -> None:
        fetch = CountingFetch({'ripe': {'1.0.0': iso(timedelta(days=2))}})
        checked, findings = check(BASE, lock(['old@1.0.0', 'ripe@1.0.0']), DAY, NOW, fetch)
        self.assertEqual(checked, [('ripe', '1.0.0')])
        self.assertEqual(findings, [])

    def test_boundary_is_strictly_younger(self) -> None:
        # 剛好滿 1440 分鐘算合格（pnpm 也是「早於 now - minimumReleaseAge」才收），差一分鐘不合格。
        fetch = CountingFetch({'edge': {'1.0.0': iso(timedelta(minutes=1440)), '1.0.1': iso(timedelta(minutes=1439))}})
        _, findings = check(BASE, lock(['old@1.0.0', 'edge@1.0.0', 'edge@1.0.1']), DAY, NOW, fetch)
        self.assertEqual([(f.name, f.version) for f in findings], [('edge', '1.0.1')])

    def test_exact_exclude_passes_without_request(self) -> None:
        fetch = CountingFetch({'fresh': {'1.0.0': iso(timedelta(minutes=10))}})
        policy = Policy(1440, frozenset({'fresh@1.0.0'}))
        checked, findings = check(BASE, lock(['old@1.0.0', 'fresh@1.0.0']), policy, NOW, fetch)
        self.assertEqual((checked, findings, fetch.calls), ([], [], []))

    def test_exclude_is_per_version(self) -> None:
        fetch = CountingFetch({'fresh': {'1.0.1': iso(timedelta(minutes=10))}})
        policy = Policy(1440, frozenset({'fresh@1.0.0'}))
        _, findings = check(BASE, lock(['old@1.0.0', 'fresh@1.0.1']), policy, NOW, fetch)
        self.assertEqual([(f.name, f.version) for f in findings], [('fresh', '1.0.1')])

    def test_version_union_exclude(self) -> None:
        # dsh `pnpm-workspace.yaml:94` 的 `name@a||b` 形狀。
        fetch = CountingFetch({})
        policy = Policy(1440, frozenset({'@scope/pkg@1.0.0||1.0.0-linux-x64'}))
        checked, findings = check(BASE, lock(['old@1.0.0', "'@scope/pkg@1.0.0'", "'@scope/pkg@1.0.0-linux-x64'"]), policy, NOW, fetch)
        self.assertEqual((checked, findings, fetch.calls), ([], [], []))

    def test_importers_only_change_sends_no_request(self) -> None:
        fetch = CountingFetch({})
        checked, findings = check(BASE, lock(['old@1.0.0'], importer_spec='~1.0.0'), DAY, NOW, fetch)
        self.assertEqual((checked, findings, fetch.calls), ([], [], []))

    def test_unchanged_lockfile_sends_no_request(self) -> None:
        fetch = CountingFetch({})
        self.assertEqual(check(BASE, BASE, DAY, NOW, fetch), ([], []))
        self.assertEqual(fetch.calls, [])

    def test_removed_package_is_not_checked(self) -> None:
        fetch = CountingFetch({})
        self.assertEqual(check(lock(['old@1.0.0', 'gone@2.0.0']), BASE, DAY, NOW, fetch), ([], []))
        self.assertEqual(fetch.calls, [])

    def test_registry_error_fails_closed(self) -> None:
        fetch = CountingFetch({})
        _, findings = check(BASE, lock(['old@1.0.0', 'missing@1.0.0']), DAY, NOW, fetch)
        self.assertEqual(len(findings), 1)
        self.assertIn('查不到 registry', findings[0].reason)

    def test_missing_time_fails_closed(self) -> None:
        fetch = CountingFetch({'notime': {'0.9.0': iso(timedelta(days=9))}})
        _, findings = check(BASE, lock(['old@1.0.0', 'notime@1.0.0']), DAY, NOW, fetch)
        self.assertIn('沒有這個版本的發布時間', findings[0].reason)

    def test_no_base_lockfile_checks_everything(self) -> None:
        fetch = CountingFetch({'old': {'1.0.0': iso(timedelta(days=9))}})
        checked, findings = check(None, BASE, DAY, NOW, fetch)
        self.assertEqual((checked, findings), ([('old', '1.0.0')], []))

    def test_one_request_per_package_name(self) -> None:
        fetch = CountingFetch({'multi': {'1.0.0': iso(timedelta(days=3)), '2.0.0': iso(timedelta(days=3))}})
        check(BASE, lock(['old@1.0.0', 'multi@1.0.0', 'multi@2.0.0']), DAY, NOW, fetch)
        self.assertEqual(fetch.calls, ['multi'])

    def test_scoped_and_quoted_keys(self) -> None:
        self.assertEqual(
            lockfile_packages(lock(["'@types/node@22.19.0'", 'esbuild@0.28.2'])),
            {('@types/node', '22.19.0'), ('esbuild', '0.28.2')},
        )


class Policy_(unittest.TestCase):
    def test_reads_scalar_and_block_list(self) -> None:
        text = "minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  # 理由\n  - 'a@1.0.0'\n  - b@2.0.0||2.0.1\nstrictDepBuilds: true\n"
        self.assertEqual(read_policy(text), Policy(1440, frozenset({'a@1.0.0', 'b@2.0.0||2.0.1'})))

    def test_bare_name_exclude_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, '只收精確版本'):
            read_policy('minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - lodash\n')
        with self.assertRaisesRegex(ValueError, '只收精確版本'):
            read_policy('minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - lodash@^4\n')

    def test_missing_threshold_is_an_error(self) -> None:
        with self.assertRaisesRegex(ValueError, '沒有 minimumReleaseAge'):
            read_policy('strictDepBuilds: true\n')


class SupplyChainSettings(unittest.TestCase):
    """驗收 1：拿掉任何一個設定都要紅。"""

    def setUp(self) -> None:
        self.workspace = (ROOT / 'pnpm-workspace.yaml').read_text(encoding='utf-8')

    def top_level(self, key: str) -> str | None:
        for line in self.workspace.splitlines():
            if line.startswith(f'{key}:'):
                return line.split(':', 1)[1].split('#', 1)[0].strip()
        return None

    def test_release_age_is_one_day(self) -> None:
        self.assertEqual(read_policy(self.workspace).minutes, 1440)

    def test_strict_dep_builds(self) -> None:
        self.assertEqual(self.top_level('strictDepBuilds'), 'true')

    def test_allow_builds_is_the_reviewed_set(self) -> None:
        # 新增一項要先審過它的 install script，再改這裡與 pnpm-workspace.yaml 的理由註解。
        lines = self.workspace.splitlines()
        start = lines.index('allowBuilds:')
        entries = {}
        for line in lines[start + 1 :]:
            if line.strip().startswith('#') or not line.strip():
                continue
            if not line.startswith('  '):
                break
            key, value = line.strip().split(':', 1)
            entries[key.strip("'\"")] = value.strip()
        self.assertEqual(entries, {'esbuild': 'true'})

    def test_root_manifest_has_no_only_built_dependencies(self) -> None:
        manifest = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
        self.assertNotIn('onlyBuiltDependencies', manifest.get('pnpm', {}))
        self.assertNotIn('neverBuiltDependencies', manifest.get('pnpm', {}))


if __name__ == '__main__':
    unittest.main()
