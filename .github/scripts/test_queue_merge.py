from __future__ import annotations

import json
import unittest
from pathlib import Path

import yaml

from queue_merge import GATE_TIMEOUT_SECONDS, RUN_BUDGET_SECONDS, Queue, gate_state, verdict_of

ROOT = Path(__file__).resolve().parents[2]

HEAD = 'a' * 40
NEW_HEAD = 'b' * 40
PID = '1' * 40
OTHER_PID = '2' * 40
QUEUE_WORKFLOW = ROOT / '.github' / 'workflows' / 'queue.yml'


def load(path: Path) -> dict:
    return yaml.safe_load(path.read_text())


def check(name: str, status: str = 'COMPLETED', conclusion: str | None = 'SUCCESS', started: str = '2026-11-24T10:00:00Z') -> dict:
    return {'name': name, 'status': status, 'conclusion': conclusion, 'startedAt': started}


GREEN = [check('plan'), check('gate')]


def verdict(word: str = 'PASS', pid: str = PID, author: str = 'OWNER') -> dict:
    return {'body': f'## verifier 判定\n\nverdict: {word}\npatch-id: {pid}\n', 'authorAssociation': author}


class FakeGh:
    def __init__(self, **pr: object) -> None:
        self.pr: dict = {
            'state': 'OPEN',
            'headRefOid': HEAD,
            'baseRefName': 'develop',
            'labels': [{'name': 'queue'}],
            'comments': [verdict()],
            'statusCheckRollup': GREEN,
            **pr,
        }
        self.calls: list[list[str]] = []
        self.behind_by = 0
        self.queue = [7]
        self.merge_error: str | None = None
        self.views: list[dict] = []
        self.merged_state = 'MERGED'
        self.fail_on: str | None = None
        self.dispatch_error: str | None = None

    def __call__(self, args: list[str]) -> str:
        self.calls.append(args)
        if self.fail_on and args[0] == self.fail_on:
            raise RuntimeError(f'gh {args[0]} 失敗：Resource not accessible by integration')
        if args[:2] == ['workflow', 'run'] and self.dispatch_error:
            raise RuntimeError(self.dispatch_error)
        if args[:2] == ['pr', 'view']:
            if self.views:
                return json.dumps({**self.pr, **self.views.pop(0)})
            state = self.merged_state if self.merged else self.pr['state']
            return json.dumps({**self.pr, 'state': state})
        if args[:2] == ['pr', 'list']:
            return json.dumps([{'number': n} for n in self.queue])
        if args[0] == 'api':
            return f'{self.behind_by}\n'
        if args[:2] == ['pr', 'merge']:
            if self.merge_error:
                raise RuntimeError(self.merge_error)
            self.merged = True
            return ''
        if args[:2] == ['pr', 'edit']:
            self.queue = [n for n in self.queue if str(n) != args[2]]
        return ''

    merged = False

    def ran(self, *prefix: str) -> list[list[str]]:
        return [c for c in self.calls if c[: len(prefix)] == list(prefix)]


def make(gh: FakeGh, current: str | None = PID, clock_step: float = 0.0) -> Queue:
    ticks = {'now': 0.0}

    def sleep(seconds: float) -> None:
        ticks['now'] += seconds + clock_step

    return Queue('o/r', gh=gh, patch_id=lambda repo, number: current, sleep=sleep, clock=lambda: ticks['now'], timeout=120)


class Merges(unittest.TestCase):
    def test_all_checks_pass_then_squash_merge_pins_head_and_dispatches_post_merge(self) -> None:
        gh = FakeGh()
        self.assertEqual(make(gh).process(7), 'merged')
        self.assertEqual(
            gh.ran('pr', 'merge'),
            [['pr', 'merge', '7', '--repo', 'o/r', '--squash', '--match-head-commit', HEAD]],
        )
        self.assertEqual(gh.ran('workflow', 'run'), [['workflow', 'run', 'post-merge.yml', '--repo', 'o/r', '--ref', 'develop']])
        self.assertEqual(gh.ran('pr', 'edit'), [])

    def test_skipped_gate_counts_when_plan_succeeded(self) -> None:
        gh = FakeGh(statusCheckRollup=[check('plan'), check('gate', conclusion='SKIPPED')])
        self.assertEqual(make(gh).process(7), 'merged')

    def test_waits_for_a_running_gate(self) -> None:
        gh = FakeGh()
        gh.views = [{}, {'statusCheckRollup': [check('plan'), check('gate', status='IN_PROGRESS', conclusion=None)]}, {}, {}]
        self.assertEqual(make(gh).process(7), 'merged')

    def test_drain_takes_oldest_first_and_each_pr_once(self) -> None:
        gh = FakeGh()
        gh.queue = [9, 7]
        results = make(gh).drain()
        self.assertEqual([n for n, _ in results], [7, 9])


class Returns(unittest.TestCase):
    def assert_returned(self, gh: FakeGh, queue: Queue, needle: str, tried_merge: bool = False) -> None:
        result = queue.process(7)
        self.assertTrue(result.startswith('returned'), result)
        if not tried_merge:
            self.assertEqual(gh.ran('pr', 'merge'), [], '退回的 PR 不能被合併')
        self.assertEqual(gh.ran('workflow', 'run'), [])
        self.assertEqual(gh.ran('pr', 'edit'), [['pr', 'edit', '7', '--repo', 'o/r', '--remove-label', 'queue']])
        comment = gh.ran('pr', 'comment')
        self.assertEqual(len(comment), 1)
        self.assertIn(needle, comment[0][-1])

    def test_patch_id_changed_since_the_verdict(self) -> None:
        gh = FakeGh()
        self.assert_returned(gh, make(gh, current=OTHER_PID), 'patch-id 變了')

    def test_patch_id_unavailable_counts_as_changed(self) -> None:
        gh = FakeGh()
        self.assert_returned(gh, make(gh, current=None), '算不出 patch-id')

    def test_red_gate(self) -> None:
        gh = FakeGh(statusCheckRollup=[check('plan'), check('gate', conclusion='FAILURE')])
        self.assert_returned(gh, make(gh), 'FAILURE')

    def test_behind_develop_is_returned_not_synced(self) -> None:
        gh = FakeGh()
        gh.behind_by = 2
        self.assert_returned(gh, make(gh), '落後 develop 2')

    def test_only_develop_is_a_valid_base_even_for_a_single_pr_run(self) -> None:
        gh = FakeGh(baseRefName='main')
        self.assert_returned(gh, make(gh), '只合進 develop')

    def test_no_verdict(self) -> None:
        gh = FakeGh(comments=[{'body': '好了'}])
        self.assert_returned(gh, make(gh), '帶 `verdict:` 行')

    def test_verdict_without_patch_id_is_returned(self) -> None:
        gh = FakeGh(comments=[{'body': 'verdict: PASS', 'authorAssociation': 'OWNER'}])
        self.assert_returned(gh, make(gh), '沒有 `patch-id:` 行')

    def test_latest_verdict_fail(self) -> None:
        gh = FakeGh(comments=[verdict('PASS'), verdict('FAIL')])
        self.assert_returned(gh, make(gh), '不是 PASS')

    def test_head_moves_while_waiting(self) -> None:
        gh = FakeGh()
        gh.views = [{}, {'statusCheckRollup': [check('plan'), check('gate', status='IN_PROGRESS', conclusion=None)]}, {'headRefOid': NEW_HEAD}]
        self.assert_returned(gh, make(gh), '變成')

    def test_patch_id_changes_while_gate_runs(self) -> None:
        gh = FakeGh()
        answers = iter([PID, OTHER_PID])
        queue = Queue('o/r', gh=gh, patch_id=lambda repo, number: next(answers), sleep=lambda s: None, clock=lambda: 0.0, timeout=120)
        self.assert_returned(gh, queue, 'patch-id 變了')

    def test_develop_moves_while_gate_runs(self) -> None:
        gh = FakeGh()
        behind = iter([0, 3])
        original = gh

        def call(args: list[str]) -> str:
            if args[0] == 'api':
                gh.calls.append(args)
                return f'{next(behind)}\n'
            return original(args)

        queue = Queue('o/r', gh=call, patch_id=lambda repo, number: PID, sleep=lambda s: None, clock=lambda: 0.0, timeout=120)
        self.assert_returned(gh, queue, '落後 develop 3')

    def test_gate_never_finishes(self) -> None:
        gh = FakeGh(statusCheckRollup=[check('plan'), check('gate', status='IN_PROGRESS', conclusion=None)])
        self.assert_returned(gh, make(gh), '還沒完成')

    def test_merge_refused_is_returned_with_the_reason(self) -> None:
        gh = FakeGh()
        gh.merge_error = 'Head branch was modified'
        self.assert_returned(gh, make(gh), 'Head branch was modified', tried_merge=True)

    def test_merge_reported_but_pr_not_merged(self) -> None:
        gh = FakeGh()
        gh.merged_state = 'OPEN'
        self.assert_returned(gh, make(gh), '沒有進入 MERGED', tried_merge=True)

    def test_unlabeled_or_closed_pr_is_skipped(self) -> None:
        gh = FakeGh(labels=[])
        self.assertEqual(make(gh).process(7), 'skipped')
        self.assertEqual(gh.ran('pr', 'merge'), [])


class Parsing(unittest.TestCase):
    def test_reads_only_the_machine_lines(self) -> None:
        body = '## PASS+NOTES\n\n上一輪 FAIL 的理由都修了。\nverdict: PASS+NOTES\npatch-id: ' + PID
        self.assertEqual(verdict_of([{'body': body, 'authorAssociation': 'MEMBER'}]), ('PASS+NOTES', PID))

    def test_newest_comment_with_a_verdict_line_wins(self) -> None:
        self.assertEqual(verdict_of([verdict('PASS', OTHER_PID), {'body': '閒聊'}, verdict('FAIL')]), ('FAIL', PID))

    def test_an_engineer_posting_a_patch_id_is_not_a_verdict(self) -> None:
        sync = {'body': f'同步完，patch-id: {OTHER_PID}', 'authorAssociation': 'OWNER'}
        self.assertEqual(verdict_of([verdict('PASS'), sync]), ('PASS', PID))

    def test_comment_from_an_untrusted_author_is_ignored(self) -> None:
        self.assertEqual(verdict_of([verdict('FAIL'), verdict('PASS', author='NONE')]), ('FAIL', PID))
        self.assertIsNone(verdict_of([verdict('PASS', author='CONTRIBUTOR')]))

    def test_old_format_verdict_without_the_machine_line_is_not_readable(self) -> None:
        self.assertIsNone(verdict_of([{'body': f'## verifier 判定：PASS\npatch-id: {PID}', 'authorAssociation': 'OWNER'}]))

    def test_verdict_without_patch_id(self) -> None:
        self.assertEqual(verdict_of([{'body': 'verdict: PASS', 'authorAssociation': 'OWNER'}]), ('PASS', None))

    def test_newest_gate_run_decides(self) -> None:
        rollup = [check('gate', conclusion='FAILURE', started='2026-11-24T10:00:00Z'), check('gate', started='2026-11-24T11:00:00Z')]
        self.assertEqual(gate_state(rollup), 'ok')
        self.assertEqual(gate_state(list(reversed(rollup))), 'ok')

    def test_a_rerun_that_has_not_started_counts_as_newest(self) -> None:
        rerun = check('gate', status='QUEUED', conclusion=None, started='0001-01-01T00:00:00Z')
        self.assertEqual(gate_state([check('gate', conclusion='FAILURE'), rerun]), 'pending')
        self.assertEqual(gate_state([check('gate'), {**rerun, 'startedAt': None}]), 'pending')

    def test_skipped_gate_without_a_green_plan_is_red(self) -> None:
        self.assertTrue(gate_state([check('plan', conclusion='FAILURE'), check('gate', conclusion='SKIPPED')]).startswith('red:'))

    def test_missing_gate_is_pending(self) -> None:
        self.assertEqual(gate_state([check('plan')]), 'pending')

    def test_waits_fit_inside_the_job_timeout(self) -> None:
        self.assertEqual(GATE_TIMEOUT_SECONDS, 60 * 60)
        self.assertLess(RUN_BUDGET_SECONDS + GATE_TIMEOUT_SECONDS, 360 * 60)


class Robustness(unittest.TestCase):
    def test_gh_failure_returns_the_pr_instead_of_leaving_the_label(self) -> None:
        gh = FakeGh()
        gh.fail_on = 'api'
        result = make(gh).process(7)
        self.assertTrue(result.startswith('returned'))
        self.assertEqual(gh.ran('pr', 'edit'), [['pr', 'edit', '7', '--repo', 'o/r', '--remove-label', 'queue']])
        self.assertIn('排隊合併自己出錯', gh.ran('pr', 'comment')[0][-1])

    def test_dispatch_failure_after_merge_is_reported_on_the_pr(self) -> None:
        gh = FakeGh()
        gh.dispatch_error = 'HTTP 403'
        self.assertEqual(make(gh).process(7), 'merged')
        self.assertIn('補跑 post-merge.yml 失敗', gh.ran('pr', 'comment')[0][-1])
        self.assertEqual(gh.ran('pr', 'edit'), [])

    def test_only_develop_prs_are_listed(self) -> None:
        gh = FakeGh()
        make(gh).queued()
        listing = gh.ran('pr', 'list')[0]
        self.assertEqual(listing[listing.index('--base') + 1], 'develop')

    def test_run_stops_starting_new_prs_after_the_budget(self) -> None:
        gh = FakeGh()
        gh.queue = [7, 9]
        ticks = iter([0.0, 0.0, 10.0, 10.0, 10.0])
        queue = Queue('o/r', gh=gh, patch_id=lambda repo, number: PID, sleep=lambda s: None, clock=lambda: next(ticks), budget=5)
        self.assertEqual([n for n, _ in queue.drain()], [7])


class WorkflowShape(unittest.TestCase):
    def setUp(self) -> None:
        self.wf = load(QUEUE_WORKFLOW)
        self.job = self.wf['jobs']['merge']

    def trigger(self) -> dict:
        return self.wf.get('on') or self.wf[True]

    def test_runs_the_workflow_file_from_develop_not_from_the_pr(self) -> None:
        self.assertNotIn('pull_request', self.trigger())
        self.assertEqual(self.trigger()['pull_request_target']['types'], ['labeled'])
        self.assertEqual(self.trigger()['pull_request_target']['branches'], ['develop'])
        self.assertIn("github.event.label.name == 'queue'", self.job['if'])

    def test_checks_out_develop_only(self) -> None:
        checkout = self.job['steps'][0]
        self.assertEqual(checkout['with']['ref'], 'develop')
        self.assertIs(checkout['with']['persist-credentials'], False)
        for step in self.job['steps']:
            self.assertNotIn('head', str(step.get('with', {})).lower())

    def test_other_labels_do_not_join_the_queue_group(self) -> None:
        self.assertNotIn('concurrency', self.wf)
        self.assertEqual(self.job['concurrency'], {'group': 'queue-merge', 'cancel-in-progress': False})

    def test_token_permissions_are_the_ones_the_script_needs(self) -> None:
        self.assertEqual(self.wf['permissions'], {'contents': 'read'})
        self.assertEqual(
            self.job['permissions'],
            {'contents': 'write', 'pull-requests': 'write', 'actions': 'write', 'checks': 'read', 'statuses': 'read'},
        )

    def test_job_timeout_covers_the_run_budget_and_one_gate_wait(self) -> None:
        self.assertGreater(self.job['timeout-minutes'], (RUN_BUDGET_SECONDS + GATE_TIMEOUT_SECONDS) // 60)

    def test_pr_number_input_is_quoted(self) -> None:
        run = self.job['steps'][-1]['run']
        self.assertIn('"$ONLY_PR"', run)

    def test_script_does_not_sync_or_bypass_the_ruleset(self) -> None:
        script = (ROOT / '.github' / 'scripts' / 'queue_merge.py').read_text()
        self.assertNotIn("'update-branch'", script)
        self.assertNotIn('--admin', script)
        self.assertNotIn('--auto', script)


if __name__ == '__main__':
    unittest.main()
