"""排隊合併（#3194）：掛了 `queue` 標籤的 PR，一次一張，核對完才用 `--match-head-commit` squash 合進它的 base。

    queue_merge.py            PR 號碼小的先，處理掛著標籤、base 是 develop 的 PR；跑滿 240 分鐘就不再開始新的一張
    queue_merge.py <PR 號碼>   只處理這一張

每張 PR 都要核對下面幾項，任何一項不過就拿掉標籤、在 PR 上留言說原因，交回 engineer：
  1. 沒有落後 base。不自己同步。
  2. 最新的判定（作者是 OWNER、MEMBER 或 COLLABORATOR、帶 `verdict:` 行的最新一則留言）是 PASS 或 PASS+NOTES，
     帶 `patch-id:` 行，而且記的 patch-id 等於現在 `gh pr diff` 算的。
  3. `gate` 綠（SUCCESS，或 plan 成功時的 SKIPPED）。等的時候 head 變了也退回。
  4. 合併前再核對一次 head、判定、落後與 patch-id（等 gate 期間出現新的 FAIL 也退回），然後 `gh pr merge --squash --match-head-commit <SHA>`。
核對與合併途中 gh 失敗也一樣拿掉標籤並留言。退回本身失敗就記為 failed，繼續下一張，整輪以非零結束。
列不出排隊的 PR 時沒有對象可以退回，整輪失敗並在輸出寫明原因。
合併成功後 dispatch post-merge.yml：GITHUB_TOKEN 做的合併不會觸發 push 事件，合併後那一輪要靠這一步補上。

權限只靠 workflow 的 GITHUB_TOKEN，不繞過 ruleset：合併不過就是退回。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from typing import Callable

LABEL = 'queue'
BASE = 'develop'
POLL_SECONDS = 30
GATE_TIMEOUT_SECONDS = 60 * 60
RUN_BUDGET_SECONDS = 240 * 60
TRUSTED_AUTHORS = frozenset({'OWNER', 'MEMBER', 'COLLABORATOR'})
PATCH_ID_RE = re.compile(r'^patch-id:\s*([0-9a-f]{40})\s*$', re.MULTILINE)
VERDICT_RE = re.compile(r'^verdict:\s*(PASS\+NOTES|PASS|FAIL)\s*$', re.MULTILINE)

Gh = Callable[[list[str]], str]


class Returned(Exception):
    pass


def gh_cli(args: list[str]) -> str:
    done = subprocess.run(['gh', *args], capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f'gh {" ".join(args[:3])} 失敗：{done.stderr.strip() or done.stdout.strip()}')
    return done.stdout


def patch_id_cli(repo: str, number: int) -> str | None:
    """`gh pr diff` 算的 patch-id；算不出來（例如超過 300 個檔，API 不給 diff）回 None。"""
    diff = subprocess.run(['gh', 'pr', 'diff', str(number), '--repo', repo], capture_output=True, text=True)
    if diff.returncode != 0:
        return None
    out = subprocess.run(['git', 'patch-id', '--stable'], input=diff.stdout, capture_output=True, text=True)
    return out.stdout.split()[0] if out.returncode == 0 and out.stdout.split() else None


def verdict_of(comments: list[dict]) -> tuple[str, str | None] | None:
    for comment in reversed(comments):
        if comment.get('authorAssociation') not in TRUSTED_AUTHORS:
            continue
        body = comment.get('body', '')
        word = VERDICT_RE.findall(body)
        if not word:
            continue
        found = PATCH_ID_RE.findall(body)
        return word[-1], (found[-1] if found else None)
    return None


def gate_state(rollup: list[dict]) -> str:
    """`ok`、`pending` 或 `red:<原因>`。"""

    def started(check: dict) -> str:
        at = check.get('startedAt') or ''
        return at if at and not at.startswith('0001') else '9999'

    def newest(name: str) -> dict | None:
        runs = [c for c in rollup if c.get('name') == name]
        return max(runs, key=started) if runs else None

    gate = newest('gate')
    if gate is None or gate.get('status') != 'COMPLETED':
        return 'pending'
    conclusion = gate.get('conclusion')
    if conclusion == 'SUCCESS':
        return 'ok'
    if conclusion == 'SKIPPED':
        plan = newest('plan')
        if plan is not None and plan.get('status') == 'COMPLETED' and plan.get('conclusion') == 'SUCCESS':
            return 'ok'
        return 'red:gate 被跳過，但 plan 沒成功'
    return f'red:gate 的結論是 {conclusion}'


class Queue:
    def __init__(
        self,
        repo: str,
        gh: Gh = gh_cli,
        patch_id: Callable[[str, int], str | None] = patch_id_cli,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        timeout: float = GATE_TIMEOUT_SECONDS,
        budget: float = RUN_BUDGET_SECONDS,
    ) -> None:
        self.repo = repo
        self.gh = gh
        self.patch_id = patch_id
        self.sleep = sleep
        self.clock = clock
        self.timeout = timeout
        self.budget = budget
        self.fatal: str | None = None

    def view(self, number: int) -> dict:
        fields = 'state,headRefOid,baseRefName,labels,comments,statusCheckRollup'
        return json.loads(self.gh(['pr', 'view', str(number), '--repo', self.repo, '--json', fields]))

    def queued(self) -> list[int]:
        out = self.gh(['pr', 'list', '--repo', self.repo, '--label', LABEL, '--base', BASE, '--state', 'open', '--json', 'number', '--limit', '100'])
        return sorted(item['number'] for item in json.loads(out))

    def behind(self, base: str, head: str) -> int:
        out = self.gh(['api', f'repos/{self.repo}/compare/{base}...{head}', '--jq', '.behind_by'])
        return int(out.strip())

    def check_current(self, number: int, pr: dict, recorded: str) -> None:
        head = pr['headRefOid']
        behind = self.behind(pr['baseRefName'], head)
        if behind > 0:
            raise Returned(f'落後 {pr["baseRefName"]} {behind} 個 commit。排隊合併不自己同步：在本機 merge 後 push，patch-id 變了就重判。')
        current = self.patch_id(self.repo, number)
        if current is None:
            raise Returned('算不出 patch-id（例如 `gh pr diff` 超過 300 個檔案），沒辦法確認判定還涵蓋這份程式碼，要重判。')
        if current != recorded:
            raise Returned(f'patch-id 變了：判定記的是 {recorded}，現在是 {current}。要重判。')

    def require_head(self, pr: dict, head: str) -> None:
        if pr['headRefOid'] != head:
            raise Returned(f'head 從 {head} 變成 {pr["headRefOid"]}，要重判。')

    def wait_for_gate(self, number: int, head: str) -> None:
        deadline = self.clock() + self.timeout
        while True:
            pr = self.view(number)
            if pr['state'] != 'OPEN':
                raise Returned(f'PR 已經是 {pr["state"]}。')
            self.require_head(pr, head)
            state = gate_state(pr['statusCheckRollup'])
            if state == 'ok':
                return
            if state.startswith('red:'):
                raise Returned(state[4:] + '。')
            if self.clock() >= deadline:
                raise Returned(f'等了 {int(self.timeout // 60)} 分鐘 gate 還沒完成。')
            self.sleep(POLL_SECONDS)

    def read_verdict(self, pr: dict) -> tuple[str, str]:
        verdict = verdict_of(pr['comments'])
        if verdict is None:
            raise Returned('PR 上沒有可信作者貼的、帶 `verdict:` 行的 verifier 判定。')
        if verdict[0] == 'FAIL':
            raise Returned('最新的判定不是 PASS 或 PASS+NOTES。')
        if verdict[1] is None:
            raise Returned('最新的判定沒有 `patch-id:` 行。')
        return verdict[0], verdict[1]

    def process(self, number: int) -> str:
        try:
            pr = self.view(number)
            if pr['state'] != 'OPEN' or LABEL not in [label['name'] for label in pr['labels']]:
                return 'skipped'
            if pr['baseRefName'] != BASE:
                raise Returned(f'base 是 {pr["baseRefName"]}，排隊合併只合進 {BASE}。')
            _, recorded = self.read_verdict(pr)
            head = pr['headRefOid']
            self.check_current(number, pr, recorded)
            self.wait_for_gate(number, head)
            pr = self.view(number)
            self.require_head(pr, head)
            _, recorded = self.read_verdict(pr)
            self.check_current(number, pr, recorded)
            try:
                self.gh(['pr', 'merge', str(number), '--repo', self.repo, '--squash', '--match-head-commit', head])
            except RuntimeError as error:
                raise Returned(f'合併被拒：{error}') from error
            if self.view(number)['state'] != 'MERGED':
                raise Returned('`gh pr merge` 回報成功，但 PR 沒有進入 MERGED。')
        except Returned as reason:
            self.return_to_engineer(number, str(reason))
            return f'returned: {reason}'
        except (RuntimeError, ValueError, KeyError) as error:
            self.return_to_engineer(number, f'排隊合併自己出錯：{error}')
            return f'returned: {error}'
        try:
            self.gh(['workflow', 'run', 'post-merge.yml', '--repo', self.repo, '--ref', pr['baseRefName']])
        except RuntimeError as error:
            self.gh(['pr', 'comment', str(number), '--repo', self.repo, '--body', f'已合併，但補跑 post-merge.yml 失敗，請手動 dispatch：{error}'])
        return 'merged'

    def return_to_engineer(self, number: int, reason: str) -> None:
        self.gh(['pr', 'edit', str(number), '--repo', self.repo, '--remove-label', LABEL])
        body = f'排隊合併退回：{reason}\n\n標籤已拿掉；在本機同步並重新核對 patch-id（變了就重判），再掛一次 `{LABEL}`。'
        self.gh(['pr', 'comment', str(number), '--repo', self.repo, '--body', body])

    def drain(self, only: int | None = None) -> list[tuple[int, str]]:
        results: list[tuple[int, str]] = []
        seen: set[int] = set()
        started = self.clock()
        while self.clock() - started < self.budget:
            try:
                pending = [only] if only is not None else self.queued()
            except (RuntimeError, ValueError, KeyError) as error:
                self.fatal = f'列不出排隊的 PR，沒有對象可以退回，整輪中止：{error}'
                break
            fresh = [n for n in pending if n not in seen]
            if not fresh:
                break
            seen.add(fresh[0])
            try:
                results.append((fresh[0], self.process(fresh[0])))
            except RuntimeError as error:
                results.append((fresh[0], f'failed: 退回也失敗，標籤可能還在：{error}'))
        return results


def main(argv: list[str]) -> int:
    repo = os.environ['GITHUB_REPOSITORY']
    only = int(argv[1]) if len(argv) > 1 else None
    queue = Queue(repo)
    results = queue.drain(only)
    for number, result in results:
        print(f'#{number}: {result}')
    if queue.fatal:
        print(f'::error::{queue.fatal}')
        return 1
    failed = [number for number, result in results if result.startswith('failed:')]
    if failed:
        print(f'::error::退回失敗的 PR：{", ".join(f"#{n}" for n in failed)}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
