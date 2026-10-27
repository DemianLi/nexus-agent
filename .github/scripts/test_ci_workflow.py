"""CI 形狀測試（#1546）：釘住 ci.yml 裡改錯了也不會紅的那幾處。照 dsh `scripts/ci-workflow.spec.ts:16-42`。

在 static 跑（`python3 -m unittest discover -s .github/scripts`）。需要 PyYAML。

釘的東西：
- node-compat 的矩陣、依序跑、真的把矩陣版本交給 setup；
- gate 的 needs 列了每一個 job，判斷段也讀了每一個 job 的結果——只列 needs 不判斷，skipped 會被當成通過；
- 兩處釘在下限的 Node（packed-install、node-compat 的 22.19）對得上 `engines`；
- 同時活躍的 job 峰值在上限之內（ci.yml 檔頭的算式）。
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

import yaml

import plan_ci
from node_compat import read_list

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / '.github' / 'workflows' / 'ci.yml'
SETUP = ROOT / '.github' / 'actions' / 'setup' / 'action.yml'

# ci.yml 檔頭：免費額度同時 20 個 job，一輪的峰值 10 個以內，兩張 PR 並行才不會排隊。
PEAK_LIMIT = 10
COMPAT_NODES = {'22.19', '26'}


def load(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding='utf-8'))


def engines_lower_bound() -> str:
    """`engines.node` 第一段範圍的下限，例如 `^22.19.0 || >=24.0.0` → `22.19.0`。"""
    spec = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['engines']['node']
    match = re.match(r'\s*(?:\^|>=)?\s*(\d+\.\d+\.\d+)', spec)
    if match is None:
        raise AssertionError(f'讀不出 engines.node 的下限：{spec!r}')
    return match.group(1)


def gate_branches(script: str) -> tuple[str, str]:
    """gate 判斷段裡 `TS=true` 與 `TS=false` 兩個分支的原文。"""
    true_at = script.index('if [ "$TS" = "true" ]')
    false_at = script.index('elif [ "$TS" = "false" ]')
    else_at = script.index('else', false_at + len('elif'))
    return script[true_at:false_at], script[false_at:else_at]


def loop_pairs(branch: str, verdict: str) -> set[str]:
    """分支裡「逐個要求 <verdict>」那個 for 迴圈列的 job 名稱（`"<job>=$<ENV>"`）。"""
    for match in re.finditer(r'for pair in (.*?); do\n\s*\[ "\$\{pair#\*=\}" = "(\w+)" \]', branch):
        if match.group(2) == verdict:
            return set(re.findall(r'"([\w-]+)=\$\w+"', match.group(1)))
    raise AssertionError(f'找不到要求 {verdict} 的迴圈')


class NodeCompatShape(unittest.TestCase):
    def setUp(self) -> None:
        self.ci = load(CI)
        self.job = self.ci['jobs']['node-compat']

    def test_matrix_is_lower_bound_and_next(self) -> None:
        nodes = self.job['strategy']['matrix']['node']
        # 一律是字串：沒加引號的 22.10 會被讀成 22.1。
        self.assertTrue(all(isinstance(n, str) for n in nodes), nodes)
        self.assertEqual(set(nodes), COMPAT_NODES)

    def test_runs_one_cell_at_a_time(self) -> None:
        strategy = self.job['strategy']
        self.assertIs(strategy.get('fail-fast'), False)
        self.assertEqual(strategy.get('max-parallel'), 1)

    def test_matrix_version_reaches_setup(self) -> None:
        setup = [s for s in self.job['steps'] if s.get('uses') == './.github/actions/setup']
        self.assertEqual(len(setup), 1)
        self.assertEqual(setup[0].get('with', {}).get('node-version'), '${{ matrix.node }}')
        setup_node = [s for s in load(SETUP)['runs']['steps'] if str(s.get('uses', '')).startswith('actions/setup-node@')]
        self.assertEqual(len(setup_node), 1)
        self.assertEqual(setup_node[0]['with']['node-version'], '${{ inputs.node-version }}')

    def test_checks_version_before_smoke(self) -> None:
        names = [s.get('name') for s in self.job['steps']]
        self.assertLess(names.index('核對 Node 版本'), names.index('相容冒煙'))

    def test_smoke_list_files_exist(self) -> None:
        files = read_list()
        self.assertTrue(files)
        for f in files:
            self.assertTrue((ROOT / f).is_file(), f)


class LowerBound(unittest.TestCase):
    def test_packed_install_runs_engines_lower_bound(self) -> None:
        steps = load(CI)['jobs']['packed-install']['steps']
        setup_node = [s for s in steps if str(s.get('uses', '')).startswith('actions/setup-node@')]
        self.assertEqual(len(setup_node), 1)
        self.assertEqual(str(setup_node[0]['with']['node-version']), engines_lower_bound())

    def test_compat_matrix_has_engines_lower_bound(self) -> None:
        major, minor, _ = engines_lower_bound().split('.')
        self.assertIn(f'{major}.{minor}', load(CI)['jobs']['node-compat']['strategy']['matrix']['node'])


class Gate(unittest.TestCase):
    def setUp(self) -> None:
        self.ci = load(CI)
        self.gate = self.ci['jobs']['gate']
        self.step = self.gate['steps'][0]

    def test_needs_every_job(self) -> None:
        others = set(self.ci['jobs']) - {'gate'}
        self.assertEqual(set(self.gate['needs']), others)

    def test_judges_every_job(self) -> None:
        """每個 job 的結果都經 env 交給判斷段，並在兩個分支的迴圈裡被要求 success／skipped。"""
        env = self.step['env']
        script = self.step['run']
        on, off = gate_branches(script)
        required, skipped = loop_pairs(on, 'success'), loop_pairs(off, 'skipped')
        for job in set(self.gate['needs']) - {'plan'}:
            with self.subTest(job=job):
                keys = [k for k, v in env.items() if v == f'${{{{ needs.{job}.result }}}}']
                self.assertEqual(len(keys), 1, f'{job} 的結果沒有經 env 交給判斷段')
                self.assertIn(job, skipped)
                if job == 'test-packages':
                    # 有沒有要測的套件是 plan 決定的，所以它在 TS=true 分支有自己的判斷。
                    self.assertIn(f'[ "${keys[0]}" = "success" ]', on)
                else:
                    self.assertIn(job, required)


class Budget(unittest.TestCase):
    def test_peak_active_jobs_within_limit(self) -> None:
        """ci.yml 檔頭的算式：plan 之後、gate 之前那一段同時活躍的 job 數。全跑的形狀，也就是合併後完整一輪的峰值。"""
        jobs = load(CI)['jobs']
        peak = 0
        for name, job in jobs.items():
            if name in ('plan', 'gate'):
                continue
            self.assertEqual(job.get('needs'), 'plan', f'{name} 不在中間那一段，算式要重寫')
            strategy = job.get('strategy')
            if strategy is None:
                peak += 1
                continue
            matrix = strategy['matrix']
            if 'include' in matrix:
                cells = len(matrix['include'])
            else:
                (axis,) = matrix.values()
                # test-harness 的分片數由 plan 算，全跑時最多。
                cells = plan_ci.HARNESS_SHARDS if isinstance(axis, str) else len(axis)
            peak += min(cells, strategy.get('max-parallel', cells))
        self.assertLessEqual(peak, PEAK_LIMIT)


class UpgradeGuideGate(unittest.TestCase):
    """升級指南與 Markdown 連結的 gate 要掛在每張 PR 都跑的 plan，而且 checkout 要帶 tags（#1537）。"""

    def setUp(self) -> None:
        self.steps = load(CI)['jobs']['plan']['steps']

    def test_runs_in_plan_without_condition(self) -> None:
        for script in ('check_upgrade_guides.py', 'check_md_links.py'):
            with self.subTest(script=script):
                steps = [s for s in self.steps if s.get('run') == f'python3 .github/scripts/{script}']
                self.assertEqual(len(steps), 1)
                self.assertNotIn('if', steps[0])

    def test_checkout_fetches_tags(self) -> None:
        checkout = [s for s in self.steps if str(s.get('uses', '')).startswith('actions/checkout@')]
        self.assertEqual(checkout[0].get('with', {}).get('fetch-depth'), 0)

    def test_release_finds_previous_tag(self) -> None:
        # release notes 用 `git describe` 找上一個 tag 再連到它的指南；淺 clone 時那行靜靜回空、notes 就不見，不報錯。
        steps = load(CI.with_name('release.yml'))['jobs']['release']['steps']
        checkout = [s for s in steps if str(s.get('uses', '')).startswith('actions/checkout@')]
        self.assertEqual(checkout[0].get('with', {}).get('fetch-depth'), 0)
        run = next(s['run'] for s in steps if 'gh release create' in str(s.get('run', '')))
        self.assertIn("git describe --tags --abbrev=0 --match 'v*' HEAD", run)
        self.assertIn('[ -d "docs/upgrade-guide/$prev" ]', run)


class AuditWiring(unittest.TestCase):
    """漏洞掃描（#1545 步驟 5）接在發版與每日排程上。兩份 workflow 都不在 PR 上跑，拿掉那一步不會有別的東西紅。"""

    SCRIPT = 'python3 .github/scripts/check_audit.py'

    def test_release_scans_before_pack_and_attaches_report(self) -> None:
        steps = load(CI.with_name('release.yml'))['jobs']['release']['steps']
        names = [s.get('name') for s in steps]
        scan = steps[names.index('漏洞掃描')]
        self.assertNotIn('if', scan)
        self.assertIn(f'{self.SCRIPT} --out ".release-out/$report"', scan['run'])
        self.assertIn('report="nexus-agent-${VERSION#v}-audit.json"', scan['run'])
        self.assertIn('sha256sum "$report" > "$report.sha256"', scan['run'])
        self.assertLess(names.index('漏洞掃描'), names.index('打包'))
        run = next(s['run'] for s in steps if 'gh release create' in str(s.get('run', '')))
        self.assertIn('.release-out/*-audit.json', run)

    def test_daily_schedule_runs_the_scan(self) -> None:
        workflow = load(CI.with_name('audit.yml'))
        # PyYAML 把 `on` 讀成 True。
        triggers = workflow[True]
        self.assertEqual(len(triggers['schedule']), 1)
        self.assertNotIn('pull_request', triggers)
        steps = workflow['jobs']['audit']['steps']
        scans = [s for s in steps if s.get('run') == self.SCRIPT]
        self.assertEqual(len(scans), 1)
        self.assertNotIn('if', scans[0])


if __name__ == '__main__':
    unittest.main()


class SessionFormatFixtures(unittest.TestCase):
    """會話日誌夾具（#1529）不是 .ts，只改它的 PR 不會被 TS_RE 認成要跑測試；拿掉 FULL_RES 那一條，讀它的測試就靜靜不跑。"""

    def test_fixture_only_change_runs_full(self) -> None:
        result = plan_ci.plan(
            ['apps/harness/src/fixtures/session-format/v14/cli.jsonl'], 'pull_request', 'develop'
        )
        self.assertEqual(result['ts'], 'true')
        self.assertEqual(result['full'], 'true')


class PersistenceSchema(unittest.TestCase):
    """持久化型別圖（#1856）是 .json，只手改它的 PR 不會被 TS_RE 認成要跑測試；拿掉那兩條，比對它的新鮮度測試就靜靜不跑。"""

    def test_schema_only_change_runs_full(self) -> None:
        result = plan_ci.plan(['docs/persistence-schema.json'], 'pull_request', 'develop')
        self.assertEqual(result['ts'], 'true')
        self.assertEqual(result['full'], 'true')


class PersistenceChanges(unittest.TestCase):
    """確認紀錄（#1856 ⓪b-2）是 .md 與 .json：只改紀錄的 PR 要全跑；驗證那格從原始碼抽型別圖、不在 import 圖上，選擇性模式也要挑到。"""

    def test_record_only_change_runs_full(self) -> None:
        for path in ('docs/persistence-changes/README.md', 'docs/persistence-changes/2026-10-23-initial.schema.json'):
            result = plan_ci.plan([path], 'pull_request', 'develop')
            self.assertEqual(result['ts'], 'true', path)
            self.assertEqual(result['full'], 'true', path)

    def test_verifier_test_always_runs(self) -> None:
        self.assertIn('persistence-changes.test.ts', [Path(p).name for p in plan_ci.SUITES['harness'].always_run()])


class PostMerge(unittest.TestCase):
    """合併後完整一輪（#2089）：每個 develop commit 一輪全跑、不被取消、不是 gate。這幾處改錯了 PR 上不會有任何東西紅。"""

    def setUp(self) -> None:
        self.wf = load(CI.with_name('post-merge.yml'))
        self.ci = load(CI)

    def test_triggers_on_develop_push_and_dispatch_only(self) -> None:
        # PyYAML 把 `on` 讀成 True。
        triggers = self.wf[True]
        self.assertEqual(set(triggers), {'push', 'workflow_dispatch'})
        self.assertEqual(triggers['push'], {'branches': ['develop', 'ci/develop-full-run']})

    def test_nothing_is_named_gate(self) -> None:
        """required check 綁的是 `gate`；這支的名稱與 job 都不能叫它。"""
        self.assertNotIn('gate', self.wf['name'].lower())
        for job_id, job in self.wf['jobs'].items():
            with self.subTest(job=job_id):
                self.assertNotIn('gate', job_id.lower())
                self.assertNotIn('gate', job.get('name', '').lower())

    def test_calls_ci_with_full(self) -> None:
        full = self.wf['jobs']['full']
        self.assertEqual(full['uses'], './.github/workflows/ci.yml')
        self.assertIs(full['with']['full'], True)
        self.assertEqual(self.ci[True]['workflow_call']['inputs']['full']['type'], 'boolean')

    def test_called_run_is_never_cancelled(self) -> None:
        """被呼叫時 group 每個 commit 一個、不取消；呼叫端不另設 concurrency（同 group 會互等）。"""
        self.assertNotIn('concurrency', self.wf)
        concurrency = self.ci['concurrency']
        self.assertIn('(inputs.full && github.sha)', concurrency['group'])
        self.assertEqual(concurrency['cancel-in-progress'], '${{ !inputs.full }}')

    def test_plan_receives_force_full(self) -> None:
        step = next(s for s in self.ci['jobs']['plan']['steps'] if s.get('id') == 'plan')
        self.assertEqual(step['env']['FORCE_FULL'], '${{ inputs.full }}')

    def test_force_full_ignores_changes(self) -> None:
        self.assertEqual(plan_ci.plan(['README.md'], 'push', '')['ts'], 'false')
        result = plan_ci.plan(['README.md'], 'push', '', force_full=True)
        self.assertEqual(result['ts'], 'true')
        self.assertEqual(result['test_mode'], 'full')
        self.assertEqual(result['harness_shard_total'], str(plan_ci.HARNESS_SHARDS))

    def test_report_turns_red_with_the_run(self) -> None:
        report = self.wf['jobs']['report']
        self.assertEqual(report['needs'], 'full')
        self.assertEqual(report['if'], 'always()')
        step = report['steps'][0]
        self.assertEqual(step['env']['RESULT'], '${{ needs.full.result }}')
        self.assertIn('if [ "$RESULT" != "success" ]', step['run'])
