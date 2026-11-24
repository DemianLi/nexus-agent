"""排隊合併（#3194）：掛了 `queue` 標籤的 PR，一次一張，核對完才用 `--match-head-commit` squash 合進 develop。

    queue_merge.py            從最舊的開始，把掛著標籤的 PR 處理完
    queue_merge.py <PR 號碼>   只處理這一張

每張 PR 依序核對，任何一項不過就拿掉標籤、在 PR 上留言說原因，交回 engineer：
  1. 沒有落後 develop。不自己同步：GitHub 做的 merge commit 本機沒有。
  2. 最新的判定是 PASS 或 PASS+NOTES，而且判定裡記的 patch-id 等於現在 `gh pr diff` 算的。
  3. `gate` 綠（SUCCESS，或 plan 成功時的 SKIPPED）。等的時候 head 或 patch-id 變了也退回。
  4. 合併前再核對一次落後與 patch-id，然後 `gh pr merge --squash --match-head-commit <SHA>`。
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
POLL_SECONDS = 30
GATE_TIMEOUT_SECONDS = 90 * 60
VERDICT_RE = re.compile(r'^patch-id:\s*([0-9a-f]{40})\s*$', re.MULTILINE)
VERDICT_WORD_RE = re.compile(r'PASS\+NOTES|PASS|FAIL')

Gh = Callable[[list[str]], str]


class Returned(Exception):
    """這張 PR 不能合：message 就是留在 PR 上的原因。"""


def gh_cli(args: list[str]) -> str:
    done = subprocess.run(['gh', *args], capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f'gh {" ".join(args[:3])} 失敗：{done.stderr.strip() or done.stdout.strip()}')
    return done.stdout


def patch_id_cli(repo: str, number: int) -> str | None:
    """`gh pr diff` 算的 patch-id；超過 300 個檔 API 不給 diff，回 None。"""
    diff = subprocess.run(['gh', 'pr', 'diff', str(number), '--repo', repo], capture_output=True, text=True)
    if diff.returncode != 0:
        return None
    out = subprocess.run(['git', 'patch-id', '--stable'], input=diff.stdout, capture_output=True, text=True)
    return out.stdout.split()[0] if out.returncode == 0 and out.stdout.split() else None


def verdict_of(comments: list[dict]) -> tuple[str, str] | None:
    """最新一則帶 `patch-id:` 行的留言：回 (PASS、PASS+NOTES 或 FAIL, patch-id)。"""
    for comment in reversed(comments):
        body = comment.get('body', '')
        found = VERDICT_RE.findall(body)
        if not found:
            continue
        for line in body.splitlines():
            if '判定' in line or re.match(r'\W*verdict', line, re.IGNORECASE):
                words = VERDICT_WORD_RE.findall(line)
                if words:
                    return words[-1], found[-1]
        return 'FAIL', found[-1]
    return None


def gate_state(rollup: list[dict]) -> str:
    """`ok`、`pending` 或 `red:<原因>`。"""

    def newest(name: str) -> dict | None:
        runs = [c for c in rollup if c.get('name') == name]
        return max(runs, key=lambda c: c.get('startedAt') or '') if runs else None

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
    ) -> None:
        self.repo = repo
        self.gh = gh
        self.patch_id = patch_id
        self.sleep = sleep
        self.clock = clock
        self.timeout = timeout

    def view(self, number: int) -> dict:
        fields = 'state,headRefOid,baseRefName,labels,comments,statusCheckRollup'
        return json.loads(self.gh(['pr', 'view', str(number), '--repo', self.repo, '--json', fields]))

    def queued(self) -> list[int]:
        out = self.gh(['pr', 'list', '--repo', self.repo, '--label', LABEL, '--state', 'open', '--json', 'number', '--limit', '100'])
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
            raise Returned('算不出 patch-id（`gh pr diff` 超過 300 個檔案），沒辦法確認判定還涵蓋這份程式碼，要重判。')
        if current != recorded:
            raise Returned(f'patch-id 變了：判定記的是 {recorded}，現在是 {current}。要重判。')

    def wait_for_gate(self, number: int, head: str) -> None:
        deadline = self.clock() + self.timeout
        while True:
            pr = self.view(number)
            if pr['state'] != 'OPEN':
                raise Returned(f'PR 已經是 {pr["state"]}。')
            if pr['headRefOid'] != head:
                raise Returned(f'等 gate 的時候 head 從 {head} 變成 {pr["headRefOid"]}，要重判。')
            state = gate_state(pr['statusCheckRollup'])
            if state == 'ok':
                return
            if state.startswith('red:'):
                raise Returned(state[4:] + '。')
            if self.clock() >= deadline:
                raise Returned(f'等了 {int(self.timeout // 60)} 分鐘 gate 還沒完成。')
            self.sleep(POLL_SECONDS)

    def process(self, number: int) -> str:
        pr = self.view(number)
        if pr['state'] != 'OPEN' or LABEL not in [label['name'] for label in pr['labels']]:
            return 'skipped'
        try:
            verdict = verdict_of(pr['comments'])
            if verdict is None:
                raise Returned('PR 上沒有帶 `patch-id:` 行的 verifier 判定。')
            if verdict[0] == 'FAIL':
                raise Returned('最新的判定不是 PASS 或 PASS+NOTES。')
            head = pr['headRefOid']
            self.check_current(number, pr, verdict[1])
            self.wait_for_gate(number, head)
            pr = self.view(number)
            if pr['headRefOid'] != head:
                raise Returned(f'head 從 {head} 變成 {pr["headRefOid"]}，要重判。')
            self.check_current(number, pr, verdict[1])
            try:
                self.gh(['pr', 'merge', str(number), '--repo', self.repo, '--squash', '--match-head-commit', head])
            except RuntimeError as error:
                raise Returned(f'合併被拒：{error}') from error
            if self.view(number)['state'] != 'MERGED':
                raise Returned('`gh pr merge` 回報成功，但 PR 沒有進入 MERGED。')
        except Returned as reason:
            self.return_to_engineer(number, str(reason))
            return f'returned: {reason}'
        self.gh(['workflow', 'run', 'post-merge.yml', '--repo', self.repo, '--ref', pr['baseRefName']])
        return 'merged'

    def return_to_engineer(self, number: int, reason: str) -> None:
        self.gh(['pr', 'edit', str(number), '--repo', self.repo, '--remove-label', LABEL])
        body = f'排隊合併退回：{reason}\n\n標籤已拿掉；在本機同步並重新核對 patch-id（變了就重判），再掛一次 `{LABEL}`。'
        self.gh(['pr', 'comment', str(number), '--repo', self.repo, '--body', body])

    def drain(self, only: int | None = None) -> list[tuple[int, str]]:
        results: list[tuple[int, str]] = []
        seen: set[int] = set()
        while True:
            pending = [only] if only is not None else self.queued()
            fresh = [n for n in pending if n not in seen]
            if not fresh:
                return results
            seen.add(fresh[0])
            results.append((fresh[0], self.process(fresh[0])))


def main(argv: list[str]) -> int:
    repo = os.environ['GITHUB_REPOSITORY']
    only = int(argv[1]) if len(argv) > 1 else None
    for number, result in Queue(repo).drain(only):
        print(f'#{number}: {result}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
