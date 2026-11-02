"""CI 形狀測試（#1546）：釘住 ci.yml 裡改錯了也不會紅的那幾處。照 dsh `scripts/ci-workflow.spec.ts:16-42`。

在 static 與輕的模式的 plan 裡跑（`python3 -m unittest discover -s .github/scripts`）。需要 PyYAML。

釘的東西：
- node-compat 的矩陣、依序跑、真的把矩陣版本交給 setup；
- gate 的 needs 列了每一個 job，判斷段也讀了每一個 job 的結果——只列 needs 不判斷，skipped 會被當成通過；
- 兩處釘在下限的 Node（packed-install、node-compat 的 22.19）對得上 `engines`；
- 同時活躍的 job 峰值在上限之內（ci.yml 檔頭的算式）；
- 輕的模式的 plan 永遠不被跳過、讀得到合併後那一輪存的快取；只改 PR 內文不重跑 gate（#2090）；
- test-harness 的兩片讀同一份耗時、合併後那一輪各片存回自己那一份（#2093）；
- sandbox-spawner 只在動到它、動到 CI、合併後完整一輪時跑，不准自我跳過，出貨的建置不帶 test-hooks（#1946）。
"""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

import yaml

import plan_ci
from node_compat import read_list

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / '.github' / 'workflows' / 'ci.yml'
SETUP = ROOT / '.github' / 'actions' / 'setup' / 'action.yml'
PLAN_CHECKS = ROOT / '.github' / 'actions' / 'plan-checks' / 'action.yml'
SPAWNER_ACTION = ROOT / '.github' / 'actions' / 'sandbox-spawner' / 'action.yml'

# ci.yml 檔頭：免費額度同時 20 個 job。合併後的一輪加上兩張功能 PR 的輕 gate 同時跑，要在這之內。
JOB_LIMIT = 20
LIGHT_IF = "steps.plan.outputs.mode == 'light'"
TYPECHECK_CACHE = 'node_modules/.cache/nexus-typecheck'
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


GATE_FULL = 'if [ "$MODE" = "full" ] && [ "$TS" = "true" ]; then'
GATE_SKIP = 'elif [ "$MODE" = "light" ] || { [ "$MODE" = "full" ] && [ "$TS" = "false" ]; }; then'


def gate_branches(script: str) -> tuple[str, str]:
    """gate 判斷段裡「全跑且要掃」與「輕的模式或不用掃」兩個分支的原文。"""
    full_at = script.index(GATE_FULL)
    skip_at = script.index(GATE_SKIP)
    else_at = script.index('else', skip_at + len('elif'))
    return script[full_at:skip_at], script[skip_at:else_at]


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
        self.step = next(s for s in self.gate['steps'] if s.get('name') == '彙總')

    def test_needs_every_job(self) -> None:
        others = set(self.ci['jobs']) - {'gate'}
        self.assertEqual(set(self.gate['needs']), others)

    def test_judges_every_job(self) -> None:
        """每個 job 的結果都經 env 交給判斷段，並在兩個分支的迴圈裡被要求 success／skipped。"""
        env = self.step['env']
        script = self.step['run']
        on, off = gate_branches(script)
        required, skipped = loop_pairs(on, 'success'), loop_pairs(off, 'skipped')
        # sandbox-spawner 看 plan 的 rust、sandbox-spawner-arm64 看是不是合併後完整一輪，都不看模式，另有 SandboxSpawner 那組。
        for job in set(self.gate['needs']) - {'plan', 'sandbox-spawner', 'sandbox-spawner-arm64'}:
            with self.subTest(job=job):
                keys = [k for k, v in env.items() if v == f'${{{{ needs.{job}.result }}}}']
                self.assertEqual(len(keys), 1, f'{job} 的結果沒有經 env 交給判斷段')
                self.assertIn(job, skipped)
                self.assertIn(job, required)

    def test_reads_the_mode_from_plan(self) -> None:
        """全部 skipped 只在 plan 說是輕的模式時才放行；模式判錯成輕的，靠 Mode 那組測試擋。"""
        self.assertEqual(self.step['env']['MODE'], '${{ needs.plan.outputs.mode }}')
        script = self.step['run']
        self.assertIn(GATE_FULL, script)
        self.assertIn(GATE_SKIP, script)


# 接在中間那一段某個 job 後面跑的：跟它依序，不另外佔一格。
CHAINED = {'packed-install': 'sandbox-spawner'}


def full_peak(jobs: dict) -> int:
    """全跑時 plan 之後、gate 之前那一段同時活躍的 job 數，也就是合併後完整一輪的峰值。"""
    peak = 0
    for name, job in jobs.items():
        if name in ('plan', 'gate'):
            continue
        if name in CHAINED:
            if job.get('needs') != ['plan', CHAINED[name]] or job.get('strategy') is not None:
                raise AssertionError(f'{name} 沒有單純接在 {CHAINED[name]} 後面，算式要重寫')
            continue
        if job.get('needs') != 'plan':
            raise AssertionError(f'{name} 不在中間那一段，算式要重寫')
        strategy = job.get('strategy')
        if strategy is None:
            peak += 1
            continue
        matrix = strategy['matrix']
        cells = len(matrix['include']) if 'include' in matrix else len(next(iter(matrix.values())))
        peak += min(cells, strategy.get('max-parallel', cells))
    return peak


class Budget(unittest.TestCase):
    def test_peak_matches_header(self) -> None:
        self.assertEqual(full_peak(load(CI)['jobs']), 9)

    def test_post_merge_and_two_light_gates_fit(self) -> None:
        """ci.yml 檔頭的算式：合併後一輪的峰值，加上兩張功能 PR 的輕 gate（各同時只有一個 job）。"""
        jobs = load(CI)['jobs']
        # 輕的一輪是 plan 接 gate：中間那一段都只在全跑時跑，gate 等 plan 跑完才開始，同時只有 1 個。
        # sandbox-spawner 例外，輕的模式也會跑，但它也等 plan、gate 也等它，三個依序，同時仍只有 1 個。
        self.assertEqual(jobs['sandbox-spawner']['needs'], 'plan')
        self.assertIn('sandbox-spawner', jobs['gate']['needs'])
        # sandbox-spawner-arm64 只在合併後完整一輪跑，功能 PR 上不跑。
        self.assertEqual(jobs['sandbox-spawner-arm64']['if'], 'inputs.full')
        for name, job in jobs.items():
            if name not in ('plan', 'gate', 'sandbox-spawner', 'sandbox-spawner-arm64'):
                self.assertTrue(job['if'].startswith("needs.plan.outputs.mode == 'full'"), name)
        light_peak = 1
        self.assertLessEqual(full_peak(jobs) + 2 * light_peak, JOB_LIMIT)


class UpgradeGuideGate(unittest.TestCase):
    """升級指南與 Markdown 連結的檢查掛在 plan-checks，兩種模式的 plan 都無條件跑，checkout 要帶 tags（#1537）。"""

    def setUp(self) -> None:
        self.steps = load(PLAN_CHECKS)['runs']['steps']
        self.jobs = load(CI)['jobs']

    def test_runs_without_condition(self) -> None:
        for script in ('check_upgrade_guides.py', 'check_md_links.py'):
            with self.subTest(script=script):
                steps = [s for s in self.steps if s.get('run') == f'python3 .github/scripts/{script}']
                self.assertEqual(len(steps), 1)
                self.assertNotIn('if', steps[0])

    def test_plan_runs_it_after_full_checkout(self) -> None:
        steps = self.jobs['plan']['steps']
        self.assertNotIn('if', self.jobs['plan'])
        uses = [str(s.get('uses', '')) for s in steps]
        at = next(i for i, u in enumerate(uses) if u.startswith('actions/checkout@'))
        self.assertEqual(steps[at].get('with', {}).get('fetch-depth'), 0)
        self.assertLess(at, uses.index('./.github/actions/plan-checks'))
        self.assertNotIn('if', steps[uses.index('./.github/actions/plan-checks')])

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
    """會話日誌夾具（#1529）不是 .ts：只改它的 commit 在全跑那一層要觸發掃描，拿掉 SCAN_RES 那一條，讀它的測試就靜靜不跑。"""

    def test_fixture_only_change_scans(self) -> None:
        self.assertEqual(plan_ci.plan(['apps/harness/src/fixtures/session-format/v14/cli.jsonl'], 'push', '')['ts'], 'true')


class PersistenceSchema(unittest.TestCase):
    """持久化型別圖（#1856）是 .json：只手改它的 commit 要觸發掃描，拿掉 TS_RE 那一條，比對它的新鮮度測試就靜靜不跑。"""

    def test_schema_only_change_scans(self) -> None:
        self.assertEqual(plan_ci.plan(['docs/persistence-schema.json'], 'push', '')['ts'], 'true')


class PersistenceChanges(unittest.TestCase):
    """確認紀錄（#1856 ⓪b-2）是 .md 與 .json：只改紀錄的 commit 要觸發掃描。"""

    def test_record_only_change_scans(self) -> None:
        for path in ('docs/persistence-changes/README.md', 'docs/persistence-changes/2026-10-23-initial.schema.json'):
            self.assertEqual(plan_ci.plan([path], 'push', '')['ts'], 'true', path)


class PostMerge(unittest.TestCase):
    """合併後完整一輪（#2089）：每個 develop commit 一輪全跑、不被取消、不是 gate。post-merge.yml 不在 PR 上跑，這幾處改錯了只有這組測試會紅。"""

    def setUp(self) -> None:
        self.wf = load(CI.with_name('post-merge.yml'))
        self.ci = load(CI)

    def test_triggers_on_develop_push_and_dispatch_only(self) -> None:
        # PyYAML 把 `on` 讀成 True。
        triggers = self.wf[True]
        self.assertEqual(set(triggers), {'push', 'workflow_dispatch'})
        self.assertEqual(triggers['push'], {'branches': ['develop']})

    def test_nothing_is_named_gate(self) -> None:
        """required check 比對的是 job 的 name；這支若有 job 叫 gate，它在 develop sha 上的結果會被 develop → main 的 PR 當成 gate。"""
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
        """被呼叫時 group 每個 commit 一個、不取消；呼叫端不另設 concurrency（設成同一個 group 會跟被呼叫端搶同一組）。"""
        self.assertNotIn('concurrency', self.wf)
        concurrency = self.ci['concurrency']
        self.assertIn('(inputs.full && github.sha)', concurrency['group'])
        self.assertEqual(concurrency['cancel-in-progress'], '${{ !inputs.full }}')

    def test_plan_receives_force_full(self) -> None:
        step = next(s for s in self.ci['jobs']['plan']['steps'] if s.get('id') == 'plan')
        self.assertEqual(step['env']['FORCE_FULL'], '${{ inputs.full }}')
        self.assertEqual(step['env']['EVENT_NAME'], '${{ github.event_name }}')
        self.assertEqual(step['env']['BASE_REF'], '${{ github.base_ref }}')

    def test_force_full_ignores_changes(self) -> None:
        self.assertEqual(plan_ci.plan(['README.md'], 'push', '')['ts'], 'false')
        self.assertEqual(plan_ci.plan(['README.md'], 'push', '', force_full=True), {'mode': 'full', 'ts': 'true', 'rust': 'true'})

    def test_grants_what_ci_asks(self) -> None:
        """被呼叫的 workflow 要的權限不能多過呼叫端給的，否則合併後那一輪一開始就失敗。"""
        for scope, level in self.ci['permissions'].items():
            with self.subTest(scope=scope):
                self.assertEqual(self.wf['permissions'].get(scope), level)

    def test_report_turns_red_with_the_run(self) -> None:
        report = self.wf['jobs']['report']
        self.assertEqual(report['needs'], 'full')
        self.assertEqual(report['if'], 'always()')
        step = report['steps'][0]
        self.assertEqual(step['env']['RESULT'], '${{ needs.full.result }}')
        self.assertIn('if [ "$RESULT" != "success" ]', step['run'])


class LightMode(unittest.TestCase):
    """輕的模式（#2090）：擋合併所需的檢查都在 plan 裡跑，中間那一段 skipped。"""

    def setUp(self) -> None:
        self.plan = load(CI)['jobs']['plan']
        self.light_steps = [s for s in self.plan['steps'] if str(s.get('if', '')).startswith(LIGHT_IF)]

    def test_runs_the_listed_checks(self) -> None:
        runs = '\n'.join(str(s.get('run', '')) + str(s.get('uses', '')) for s in self.light_steps)
        for needle in (
            'python3 -m unittest discover -s .github/scripts',
            'check_lockfile_age.py',
            'plan_ci.py light',
            '.github/scripts/typecheck.sh',
            'prettier --check',
            'eslint',
            'vitest run',
        ):
            with self.subTest(needle=needle):
                self.assertIn(needle, runs)

    def test_lockfile_age_runs_before_install(self) -> None:
        names = [s.get('name') or s.get('uses') for s in self.light_steps]
        self.assertLess(names.index('lockfile 新版本的發布年齡'), names.index('./.github/actions/setup'))


class SandboxSpawner(unittest.TestCase):
    """沙箱 spawner 的 Rust（#1946，D55）：只有該編時編；編了就要真的在有 Landlock 的核心上測，跳過不算綠。"""

    def setUp(self) -> None:
        self.ci = load(CI)
        self.job = self.ci['jobs']['sandbox-spawner']
        self.steps = {s.get('name'): s for s in load(SPAWNER_ACTION)['runs']['steps']}

    def rust(self, changed: list[str], event: str = 'pull_request', base: str = 'develop', full: bool = False) -> str:
        return plan_ci.plan(changed, event, base, force_full=full)['rust']

    def test_builds_only_when_the_spawner_or_ci_changes(self) -> None:
        self.assertEqual(self.rust(['native/sandbox-spawner/src/main.rs']), 'true')
        self.assertEqual(self.rust(['native/sandbox-spawner/Cargo.lock']), 'true')
        self.assertEqual(self.rust(['.github/workflows/ci.yml']), 'true')
        self.assertEqual(self.rust(['apps/harness/src/a.ts', 'docs/a.md']), 'false')
        self.assertEqual(self.rust(['apps/harness/src/sandbox-protocol.ts']), 'true')
        self.assertEqual(self.rust(['apps/harness/src/sandbox-spawner-client.ts']), 'true')
        self.assertEqual(self.rust(['apps/harness/src/git-sandbox.ts']), 'true')
        self.assertEqual(self.rust(['apps/harness/src/mcp-sandbox.ts']), 'true')
        self.assertEqual(self.rust(['apps/harness/src/kernel-file-lock.ts']), 'true')
        self.assertEqual(self.rust(['apps/harness/src/kernel-file-lock.integration.test.ts']), 'true')
        self.assertEqual(self.rust(['packages/nexus-plugin-workspace-changes/src/git.ts']), 'true')
        self.assertEqual(self.rust(['apps/harness/src/tool-process.ts']), 'true')
        self.assertEqual(self.rust(['apps/harness/src/ripgrep-sandbox.ts']), 'true')
        self.assertEqual(self.rust(['docs/a.md'], event='push', base=''), 'false')
        self.assertEqual(self.rust(['README.md'], event='push', base='', full=True), 'true')

    def test_builds_whenever_packed_install_runs(self) -> None:
        """包裡的 spawner 是這個 job 編的：develop → main 的 PR 只改 TypeScript 也要編。"""
        result = plan_ci.plan(['apps/harness/src/a.ts'], 'pull_request', 'main')
        self.assertEqual((result['mode'], result['ts'], result['rust']), ('full', 'true', 'true'))
        self.assertEqual(self.rust(['docs/a.md'], base='main'), 'false')

    def test_packed_install_packs_the_bundle_this_job_built(self) -> None:
        job = self.ci['jobs']['packed-install']
        self.assertEqual(job['needs'], ['plan', 'sandbox-spawner'])
        use = next(s for s in self.job['steps'] if s.get('uses') == './.github/actions/sandbox-spawner')
        self.assertEqual(
            use['with']['bundle'],
            "${{ needs.plan.outputs.mode == 'full' && needs.plan.outputs.ts == 'true' && 'sandbox-spawner-linux-x64' || '' }}",
        )
        self.assertEqual(job['if'], "needs.plan.outputs.mode == 'full' && needs.plan.outputs.ts == 'true'")
        download = next(s for s in job['steps'] if str(s.get('uses', '')).startswith('actions/download-artifact@'))
        self.assertEqual(download['with']['name'], 'sandbox-spawner-linux-x64')
        steps = {s.get('name'): s for s in job['steps']}
        self.assertIn('--spawner "$RUNNER_TEMP/spawner"', steps['打包']['run'])

    def test_cache_can_be_turned_off(self) -> None:
        """發版傳 cache: 'false'：快取那一步要真的看這個 input。"""
        action = load(SPAWNER_ACTION)
        self.assertEqual(action['inputs']['cache']['default'], 'true')
        cache = next(s for s in action['runs']['steps'] if str(s.get('uses', '')).startswith('actions/cache@'))
        self.assertEqual(cache['if'], "inputs.cache == 'true'")

    def test_bundle_keeps_the_exec_bit(self) -> None:
        """upload-artifact 不保留執行權限，所以先包成 tar。"""
        self.assertIn('tar -cf', self.steps['打 bundle']['run'])
        self.assertIn('./bundle.sh', self.steps['打 bundle']['run'])

    def test_arm64_builds_and_tests_only_in_the_post_merge_run(self) -> None:
        job = self.ci['jobs']['sandbox-spawner-arm64']
        self.assertEqual(job['if'], 'inputs.full')
        self.assertEqual(job['runs-on'], 'ubuntu-24.04-arm')
        use = next(s for s in job['steps'] if s.get('uses') == './.github/actions/sandbox-spawner')
        self.assertNotIn('with', use, 'arm64 不出貨，不打 bundle')
        step = next(s for s in self.ci['jobs']['gate']['steps'] if s.get('name') == '彙總')
        self.assertEqual(step['env']['FULL'], '${{ inputs.full }}')
        self.assertEqual(step['env']['SANDBOX_SPAWNER_ARM64'], '${{ needs.sandbox-spawner-arm64.result }}')
        self.assertIn('[ "$SANDBOX_SPAWNER_ARM64" = "success" ] || fail', step['run'])
        self.assertIn('[ "$SANDBOX_SPAWNER_ARM64" = "skipped" ] || fail', step['run'])

    def test_release_packs_the_x64_bundle_and_only_builds_arm64(self) -> None:
        jobs = load(CI.with_name('release.yml'))['jobs']
        self.assertEqual(jobs['release']['needs'], ['branch', 'sandbox-spawner', 'sandbox-spawner-arm64'])
        # 選錯分支時，spawner 的建置不先跑：兩個都等分支檢查。
        self.assertEqual(jobs['sandbox-spawner']['needs'], 'branch')
        self.assertEqual(jobs['sandbox-spawner-arm64']['needs'], 'branch')
        check = next(s for s in jobs['branch']['steps'] if s.get('name') == '確認執行分支為 main')
        self.assertIn('"refs/heads/main"', check['run'])
        x64 = next(s for s in jobs['sandbox-spawner']['steps'] if s.get('uses') == './.github/actions/sandbox-spawner')
        self.assertEqual(x64['with']['bundle'], 'sandbox-spawner-linux-x64')
        self.assertEqual(x64['with']['cache'], 'false')
        self.assertEqual(jobs['sandbox-spawner-arm64']['runs-on'], 'ubuntu-24.04-arm')
        arm = next(s for s in jobs['sandbox-spawner-arm64']['steps'] if s.get('uses') == './.github/actions/sandbox-spawner')
        self.assertEqual(arm['with'], {'cache': 'false'}, 'arm64 不出貨、不打 bundle；發版不用快取')
        steps = jobs['release']['steps']
        download = next(s for s in steps if str(s.get('uses', '')).startswith('actions/download-artifact@'))
        self.assertEqual(download['with']['name'], 'sandbox-spawner-linux-x64')
        names = [s.get('name') for s in steps]
        self.assertIn('--spawner "$RUNNER_TEMP/spawner"', steps[names.index('打包')]['run'])

    def test_light_mode_still_builds(self) -> None:
        result = plan_ci.plan(['native/sandbox-spawner/src/main.rs'], 'pull_request', 'develop')
        self.assertEqual((result['mode'], result['rust']), ('light', 'true'))

    def test_runs_on_the_plan_flag_not_the_mode(self) -> None:
        self.assertEqual(self.job['if'], "needs.plan.outputs.rust == 'true'")
        self.assertEqual(self.ci['jobs']['plan']['outputs']['rust'], '${{ steps.plan.outputs.rust }}')

    def test_gate_judges_it_by_the_rust_flag(self) -> None:
        step = next(s for s in self.ci['jobs']['gate']['steps'] if s.get('name') == '彙總')
        self.assertEqual(step['env']['RUST'], '${{ needs.plan.outputs.rust }}')
        self.assertEqual(step['env']['SANDBOX_SPAWNER'], '${{ needs.sandbox-spawner.result }}')
        script = step['run']
        self.assertIn('[ "$SANDBOX_SPAWNER" = "success" ] || fail', script)
        self.assertIn('[ "$SANDBOX_SPAWNER" = "skipped" ] || fail', script)

    def test_shipped_build_has_no_test_hooks_and_tests_require_landlock(self) -> None:
        build = self.steps['編譯']['run']
        self.assertIn('--release', build)
        self.assertNotIn('--features', build)
        for name in ('測試（musl）', '測試（glibc 的子行程）'):
            test = self.steps[name]
            self.assertIn('--features test-hooks', test['run'])
            self.assertEqual(test['env']['NEXUS_REQUIRE_LANDLOCK'], '1')

    def test_ships_and_tests_the_static_musl_build(self) -> None:
        """出貨的是 musl 版（#1827 D61 a）：編與 musl 那輪測試都帶 musl target，target 由安裝那一步依架構裝好。"""
        install = self.steps['安裝釘住的 Rust']['run']
        self.assertIn('--target "$(uname -m)-unknown-linux-musl"', install)
        self.assertIn('SPAWNER_TARGET=$(uname -m)-unknown-linux-musl', install)
        self.assertIn('--target "$SPAWNER_TARGET"', self.steps['編譯']['run'])
        self.assertIn('--target "$SPAWNER_TARGET"', self.steps['測試（musl）']['run'])
        self.assertNotIn('--target', self.steps['測試（glibc 的子行程）']['run'])
        bundle = (ROOT / 'native' / 'sandbox-spawner' / 'bundle.sh').read_text(encoding='utf-8')
        self.assertIn('target="$(uname -m)-unknown-linux-musl"', bundle)

    def test_toolchain_is_pinned(self) -> None:
        toolchain = (ROOT / 'native' / 'sandbox-spawner' / 'rust-toolchain.toml').read_text(encoding='utf-8')
        self.assertRegex(toolchain, r'(?m)^channel = "\d+\.\d+\.\d+"$')
        self.assertIn('rust-toolchain.toml', self.steps['安裝釘住的 Rust']['run'])


class Mode(unittest.TestCase):
    """功能 PR 只有動到 CI 自己時全跑（#2088 決議第 15 條）；判錯成輕的，gate 會照輕的放行。"""

    def mode(self, changed: list[str], base: str = 'develop') -> str:
        return plan_ci.plan(changed, 'pull_request', base)['mode']

    def test_feature_pr_is_light(self) -> None:
        for path in ('packages/nexus-core/src/a.ts', 'pnpm-lock.yaml', 'vendor/cordis/src/x.ts', 'docs/a.md'):
            with self.subTest(path=path):
                self.assertEqual(self.mode([path]), 'light')

    def test_ci_changes_run_full(self) -> None:
        for path in ('.github/workflows/ci.yml', '.github/scripts/plan_ci.py', '.github/actions/setup/action.yml'):
            with self.subTest(path=path):
                self.assertEqual(self.mode(['packages/nexus-core/src/a.ts', path]), 'full')

    def test_other_events_run_full(self) -> None:
        self.assertEqual(self.mode(['packages/nexus-core/src/a.ts'], base='main'), 'full')
        self.assertEqual(plan_ci.plan(['packages/nexus-core/src/a.ts'], 'push', '')['mode'], 'full')


class TypecheckCache(unittest.TestCase):
    """合併後那一輪存、輕的模式的 plan 讀。兩邊的路徑對不上時快取靜靜沒效，gate 照樣綠，只是慢。"""

    def setUp(self) -> None:
        jobs = load(CI)['jobs']
        self.typecheck = jobs['typecheck']
        self.save = next(s for s in self.typecheck['steps'] if str(s.get('uses', '')).startswith('actions/cache/save@'))
        self.restore = next(
            s
            for s in jobs['plan']['steps']
            if str(s.get('uses', '')).startswith('actions/cache/restore@') and TYPECHECK_CACHE in s['with']['path']
        )

    def test_only_post_merge_saves(self) -> None:
        self.assertEqual(self.save['if'], 'inputs.full')
        self.assertEqual(self.save['with']['key'], 'typecheck-${{ github.sha }}')

    def test_gate_reads_its_merge_base(self) -> None:
        self.assertEqual(self.restore['with']['key'], 'typecheck-${{ steps.base.outputs.sha }}')
        self.assertEqual(self.restore['with']['restore-keys'], 'typecheck-')

    def test_paths_match_typecheck_script(self) -> None:
        self.assertEqual(self.save['with']['path'], self.restore['with']['path'])
        script = (ROOT / '.github' / 'scripts' / 'typecheck.sh').read_text(encoding='utf-8')
        self.assertIn(f'cache={TYPECHECK_CACHE}\n', script)
        generator = (ROOT / 'scripts' / 'gen-typecheck-projects.ts').read_text(encoding='utf-8')
        self.assertIn(f"CACHE_DIR = '{TYPECHECK_CACHE}'", generator)
        # 整個目錄：產生的設定、out/（宣告檔與 buildinfo）、沒人引用的套件的 buildinfo，少了哪一份都要從頭查。
        self.assertEqual(
            self.save['with']['path'].split(),
            [f'packages/*/{TYPECHECK_CACHE}', f'apps/*/{TYPECHECK_CACHE}'],
        )

    def test_full_layer_checks_every_package_from_scratch(self) -> None:
        uses = [str(s.get('uses', '')) for s in self.typecheck['steps']]
        self.assertFalse(any(u.startswith(('actions/cache/restore@', 'actions/cache@')) for u in uses))
        run = next(s['run'] for s in self.typecheck['steps'] if s.get('name') == 'Typecheck')
        self.assertEqual(run, ".github/scripts/typecheck.sh '--filter=./packages/*' '--filter=./apps/*'")

    def test_root_script_matches_full_layer(self) -> None:
        # 開發時的 `pnpm typecheck` 跟全跑同一支、同一組篩選：宣告檔輸出才有的錯，本機與 CI 一起紅。
        manifest = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
        self.assertEqual(
            manifest['scripts']['typecheck'], ".github/scripts/typecheck.sh '--filter=./packages/*' '--filter=./apps/*'"
        )


class HarnessDurations(unittest.TestCase):
    """test-harness 分片看的耗時（#2093）。路徑或鍵對不上時快取靜靜沒效、退回雜湊切法，gate 照樣綠，只是兩片又不均；
    兩片取到的不是同一份時切法不一致，會有檔兩片都沒跑。"""

    SHARDS = (1, 2)

    def setUp(self) -> None:
        jobs = load(CI)['jobs']
        self.plan = jobs['plan']
        self.harness = jobs['test-harness']
        self.lookups = {s['id']: s for s in self.plan['steps'] if str(s.get('id', '')).startswith('durations-')}
        harness_steps = self.harness['steps']
        self.restores = [s for s in harness_steps if str(s.get('uses', '')).startswith('actions/cache/restore@')]
        self.save = next(s for s in harness_steps if str(s.get('uses', '')).startswith('actions/cache/save@'))
        self.collect = next(s for s in harness_steps if s.get('name') == '收這一片的耗時')
        self.test = next(s for s in harness_steps if s.get('name') == 'Test')

    def path(self, shard: int | str) -> str:
        return f'.harness-durations/results-{shard}.json'

    def test_plan_only_looks_up_in_full_mode(self) -> None:
        self.assertEqual(sorted(self.lookups), [f'durations-{n}' for n in self.SHARDS])
        for n in self.SHARDS:
            with self.subTest(shard=n):
                step = self.lookups[f'durations-{n}']
                self.assertEqual(step['if'], "steps.plan.outputs.mode == 'full'")
                self.assertIs(step['with']['lookup-only'], True)
                self.assertEqual(step['with']['path'], self.path(n))
                self.assertEqual(step['with']['key'], f'harness-durations-{n}-${{{{ steps.base.outputs.sha || github.sha }}}}')
                self.assertEqual(step['with']['restore-keys'], f'harness-durations-{n}-')
                self.assertEqual(
                    self.plan['outputs'][f'durations_key_{n}'],
                    f'${{{{ steps.durations-{n}.outputs.cache-matched-key }}}}',
                )

    def test_both_shards_restore_exactly_what_plan_found(self) -> None:
        # 兩片都取兩份；鍵是 plan 查到的那一個、取不到就紅，所以兩片看到的資料相同。
        self.assertEqual(len(self.restores), len(self.SHARDS))
        for n, step in zip(self.SHARDS, self.restores):
            with self.subTest(shard=n):
                self.assertEqual(step['if'], f"needs.plan.outputs.durations_key_{n} != ''")
                self.assertEqual(step['with']['key'], f'${{{{ needs.plan.outputs.durations_key_{n} }}}}')
                self.assertEqual(step['with']['path'], self.path(n))
                self.assertIs(step['with']['fail-on-cache-miss'], True)
                self.assertNotIn('restore-keys', step['with'])
        names = [s.get('name') or s.get('uses') for s in self.harness['steps']]
        self.assertLess(names.index(self.restores[-1]['uses']), names.index('Test'))

    def test_sequencer_reads_the_restored_dir(self) -> None:
        source = (ROOT / 'apps' / 'harness' / 'src' / 'test-shard-sequencer.ts').read_text(encoding='utf-8')
        env = re.search(r"DURATIONS_DIR_ENV = '([A-Z_]+)'", source)
        assert env is not None
        self.assertEqual(self.test['env'], {env.group(1): '${{ github.workspace }}/.harness-durations'})
        config = (ROOT / 'apps' / 'harness' / 'vitest.config.ts').read_text(encoding='utf-8')
        self.assertIn('sequence: { sequencer: DurationSequencer }', config)

    def test_only_post_merge_saves_its_own_shard(self) -> None:
        for step in (self.collect, self.save):
            self.assertEqual(step['if'], 'inputs.full && !cancelled()')
        self.assertEqual(self.save['with']['path'], self.path('${{ matrix.shard }}'))
        self.assertEqual(self.save['with']['key'], 'harness-durations-${{ matrix.shard }}-${{ github.sha }}')
        self.assertIn(f'"{self.path("${{ matrix.shard }}")}"', self.collect['run'])
        self.assertEqual(self.harness['strategy']['matrix']['shard'], list(self.SHARDS))


class LightScope(unittest.TestCase):
    """`plan_ci.light` 的範圍（#2088 決議第 5、7 條）。"""

    NAMES = {
        'packages/nexus-core': '@nexus/core',
        'packages/nexus-plugin-todo': '@nexus/plugin-todo',
        'apps/web': '@nexus/web',
    }

    def scope(self, changed: list[str], existing: set[str] | None = None) -> dict:
        present = set(changed) if existing is None else existing
        return plan_ci.light(changed, self.NAMES, lambda p: p in present)

    def test_typecheck_changed_packages_with_downstream(self) -> None:
        scope = self.scope(['packages/nexus-plugin-todo/src/index.ts', 'packages/nexus-core/src/a.ts'])
        self.assertEqual(scope['typecheck'], ['@nexus/core', '@nexus/plugin-todo'])
        with tempfile.TemporaryDirectory() as out:
            plan_ci.write_light(scope, Path(out))
            self.assertEqual(
                (Path(out) / 'typecheck.txt').read_text(encoding='utf-8').split(),
                ['--filter=...@nexus/core', '--filter=...@nexus/plugin-todo'],
            )

    def test_root_toolchain_checks_everything(self) -> None:
        for path in ('pnpm-lock.yaml', 'package.json', 'tsconfig.base.json', 'vendor/cordis/src/x.ts', 'pnpm-workspace.yaml'):
            with self.subTest(path=path):
                self.assertEqual(self.scope([path])['typecheck'], 'all')

    def test_non_type_files_skip_typecheck(self) -> None:
        self.assertEqual(self.scope(['packages/nexus-core/README.md', 'docs/x.md'])['typecheck'], [])

    def test_tests_are_changed_tests_and_same_name(self) -> None:
        changed = ['packages/nexus-core/src/a.ts', 'packages/nexus-core/src/b.test.ts', 'apps/web/src/c.tsx']
        existing = set(changed) | {'packages/nexus-core/src/a.test.ts', 'apps/web/src/c.test.tsx', 'apps/web/src/d.test.tsx'}
        self.assertEqual(
            self.scope(changed, existing)['tests'],
            {'packages/nexus-core': ['src/a.test.ts', 'src/b.test.ts'], 'apps/web': ['src/c.test.tsx']},
        )

    def test_browser_guard_and_deleted_tests_are_left_out(self) -> None:
        changed = ['apps/web/guard/guard.test.ts', 'packages/nexus-core/src/gone.test.ts']
        self.assertEqual(self.scope(changed, {'apps/web/guard/guard.test.ts'})['tests'], {})

    def test_format_and_lint_only_existing_files(self) -> None:
        changed = ['packages/nexus-core/src/a.ts', 'packages/nexus-core/src/gone.ts', 'README.md', '.github/workflows/ci.yml']
        scope = self.scope(changed, {'packages/nexus-core/src/a.ts', 'README.md', '.github/workflows/ci.yml'})
        self.assertEqual(scope['format'], ['packages/nexus-core/src/a.ts', '.github/workflows/ci.yml'])
        self.assertEqual(scope['lint'], {'packages/nexus-core': ['src/a.ts']})

    def test_docs_only_needs_no_install(self) -> None:
        self.assertFalse(plan_ci.needs_node(self.scope(['docs/a.md', 'AGENTS.md'])))
        self.assertTrue(plan_ci.needs_node(self.scope(['.github/workflows/ci.yml'])))


class EditedPullRequest(unittest.TestCase):
    """只改 PR 內文不重跑 gate、不取消正在跑的那一輪（#2090 第 7 條）。"""

    def setUp(self) -> None:
        self.ci = load(CI)
        self.wf = load(CI.with_name('pr-edited.yml'))

    def test_ci_does_not_listen_to_edits(self) -> None:
        # PyYAML 把 `on` 讀成 True。沒寫 types 時是預設的 opened、synchronize、reopened。
        self.assertNotIn('types', self.ci[True]['pull_request'])

    def test_edited_workflow_has_no_gate(self) -> None:
        """只改內文時這支的 job 被跳過；叫 gate 的話，跳過的 required check 算成通過。"""
        self.assertEqual(self.wf[True]['pull_request']['types'], ['edited'])
        self.assertNotIn('gate', self.wf['name'].lower())
        for job_id, job in self.wf['jobs'].items():
            with self.subTest(job=job_id):
                self.assertNotIn('gate', job_id.lower())
                self.assertNotIn('gate', job.get('name', '').lower())

    def test_reruns_only_for_what_gate_reads(self) -> None:
        self.assertEqual(
            self.wf['jobs']['rerun']['if'],
            "github.event.changes.title || github.event.changes.base || (github.event.changes.body && github.base_ref == 'main')",
        )

    def test_gate_reads_title_body_and_base_from_api(self) -> None:
        """rerun 沿用觸發時的事件；從事件讀的話，改了標題重跑還是驗舊的。"""
        step = next(s for s in load(PLAN_CHECKS)['runs']['steps'] if s.get('name') == '檢查 PR 標題與內文')
        self.assertNotIn('TITLE', step['env'])
        self.assertNotIn('BODY', step['env'])
        self.assertIn('gh api "$PR_URL"', step['run'])
        self.assertIn('[ "$live_base" != "$BASE" ]', step['run'])
        self.assertEqual(self.ci['permissions'].get('pull-requests'), 'read')
