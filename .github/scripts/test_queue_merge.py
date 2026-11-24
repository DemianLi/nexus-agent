from __future__ import annotations

import json
import unittest
from pathlib import Path

import yaml

from queue_merge import GATE_TIMEOUT_SECONDS, Queue, gate_state, verdict_of

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


def verdict(word: str = 'PASS', pid: str = PID) -> dict:
    return {'body': f'## verifier 判定：{word}\n\npatch-id: {pid}\n'}


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

    def __call__(self, args: list[str]) -> str:
        self.calls.append(args)
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
        self.assertEqual(gh.ran('pr', 'update-branch'), [])

    def test_no_verdict(self) -> None:
        gh = FakeGh(comments=[{'body': '好了'}])
        self.assert_returned(gh, make(gh), '沒有帶 `patch-id:` 行')

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
    def test_verdict_word_comes_from_the_verdict_line_only(self) -> None:
        body = '## verifier 判定：PASS+NOTES\n\n上一輪 FAIL 的理由都修了。\npatch-id: ' + PID
        self.assertEqual(verdict_of([{'body': body}]), ('PASS+NOTES', PID))

    def test_newest_comment_with_a_patch_id_wins(self) -> None:
        self.assertEqual(verdict_of([verdict('PASS', OTHER_PID), {'body': '閒聊'}, verdict('FAIL')]), ('FAIL', PID))

    def test_unreadable_verdict_word_is_fail(self) -> None:
        self.assertEqual(verdict_of([{'body': f'patch-id: {PID}'}]), ('FAIL', PID))

    def test_newest_gate_run_decides(self) -> None:
        rollup = [check('gate', conclusion='FAILURE', started='2026-11-24T10:00:00Z'), check('gate', started='2026-11-24T11:00:00Z')]
        self.assertEqual(gate_state(rollup), 'ok')
        self.assertEqual(gate_state(list(reversed(rollup))), 'ok')

    def test_skipped_gate_without_a_green_plan_is_red(self) -> None:
        self.assertTrue(gate_state([check('plan', conclusion='FAILURE'), check('gate', conclusion='SKIPPED')]).startswith('red:'))

    def test_missing_gate_is_pending(self) -> None:
        self.assertEqual(gate_state([check('plan')]), 'pending')

    def test_timeout_is_ninety_minutes(self) -> None:
        self.assertEqual(GATE_TIMEOUT_SECONDS, 90 * 60)


class WorkflowShape(unittest.TestCase):
    def setUp(self) -> None:
        self.wf = load(QUEUE_WORKFLOW)
        self.job = self.wf['jobs']['merge']

    def trigger(self) -> dict:
        return self.wf.get('on') or self.wf[True]

    def test_runs_only_for_the_queue_label_or_by_hand(self) -> None:
        self.assertEqual(self.trigger()['pull_request']['types'], ['labeled'])
        self.assertEqual(self.trigger()['pull_request']['branches'], ['develop'])
        self.assertIn('github.event.label.name == \'queue\'', self.job['if'])

    def test_one_run_at_a_time_and_never_cancelled(self) -> None:
        self.assertEqual(self.wf['concurrency']['group'], 'queue-merge')
        self.assertIs(self.wf['concurrency']['cancel-in-progress'], False)

    def test_token_permissions_are_limited_to_merge_and_dispatch(self) -> None:
        self.assertEqual(self.wf['permissions'], {'contents': 'read'})
        self.assertEqual(self.job['permissions'], {'contents': 'write', 'pull-requests': 'write', 'actions': 'write'})

    def test_script_comes_from_develop_not_from_the_pr(self) -> None:
        checkout = self.job['steps'][0]
        self.assertEqual(checkout['with']['ref'], 'develop')
        self.assertIs(checkout['with']['persist-credentials'], False)

    def test_does_not_sync_or_bypass_the_ruleset(self) -> None:
        script = (ROOT / '.github' / 'scripts' / 'queue_merge.py').read_text()
        self.assertNotIn("'update-branch'", script)
        self.assertNotIn('--admin', script)
        self.assertNotIn('--auto', script)


if __name__ == '__main__':
    unittest.main()
