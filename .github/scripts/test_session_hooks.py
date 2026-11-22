from __future__ import annotations

import io
import json
import re
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

import session_hooks
from session_hooks import ROLES, SKILL_MD, check_closing, check_download, check_start_session, main

REPO = Path(__file__).resolve().parents[2]


def run(argv: list[str], event: object) -> tuple[int, str]:
    err = io.StringIO()
    with mock.patch('sys.stdin', io.StringIO(json.dumps(event))), redirect_stderr(err):
        code = main(['session_hooks.py', *argv])
    return code, err.getvalue()


BASE = {'use_worktree': False, 'prompt': '開場。不讀不寫 app 給的共用 notes 目錄。下載只有開分支前一次 git fetch origin develop，其餘寫在卡上等 operator 核可。'}


def ok_input(name: str, model: str, effort: str, **more: object) -> dict:
    return {'name': name, 'model': model, 'effort': effort, **BASE, **more}


class StartSessionTest(unittest.TestCase):
    def test_engineer_and_verifier_with_table_values_pass(self) -> None:
        self.assertIsNone(check_start_session(ok_input('eng-2521', 'claude-sonnet-5-5', 'medium')))
        self.assertIsNone(check_start_session(ok_input('ver-3092', 'claude-opus-5-5', 'medium')))

    def test_wrong_model_or_effort_is_blocked(self) -> None:
        for tool_input in (
            ok_input('eng-1', 'claude-opus-5-5', 'medium'),
            ok_input('eng-1', 'claude-sonnet-5-5', 'high'),
            {**BASE, 'name': 'ver-1', 'model': 'claude-opus-5-5'},
            {**BASE, 'name': 'ver-1', 'effort': 'medium'},
        ):
            with self.subTest(tool_input=tool_input):
                reason = check_start_session(tool_input)
                self.assertIsNotNone(reason)
                self.assertIn(SKILL_MD, reason)

    def test_other_names_and_bare_proposal_starts_are_not_checked(self) -> None:
        self.assertIsNone(check_start_session({'name': 'docker-fix'}))
        self.assertIsNone(check_start_session({}))
        self.assertIsNone(check_start_session({'proposal_id': 'task_1'}))
        self.assertIsNone(check_start_session({'title': 'Docker 修正'}))
        self.assertIsNone(check_start_session({'title': 'Engineering handbook 更新'}))
        self.assertIsNone(check_start_session({'title': 'verifiers 清單'}))

    def test_offer_brief_sent_with_proposal_id_is_checked(self) -> None:
        self.assertIsNotNone(check_start_session({'proposal_id': 'task_1', 'name': 'eng-1', 'model': 'claude-opus-5-5', 'effort': 'medium'}))
        self.assertIsNone(check_start_session({'proposal_id': 'task_1', 'name': 'eng-1', 'model': 'claude-sonnet-5-5', 'effort': 'medium', 'use_worktree': False}))

    def test_role_title_without_name_is_blocked(self) -> None:
        for title in ('verifier：PR #3093', 'Engineer：#2521'):
            with self.subTest(title=title):
                reason = check_start_session({'title': title, 'model': 'claude-opus-5-5', 'effort': 'medium'})
                self.assertIsNotNone(reason)
                self.assertIn('`name`', reason)

    def test_name_wins_over_title(self) -> None:
        self.assertIsNone(check_start_session({'name': 'foo', 'title': 'Verifier：PR #1'}))
        self.assertIsNotNone(check_start_session({'name': 'ver-1', 'title': 'docker'}))

    def test_role_word_only_counts_at_title_start(self) -> None:
        self.assertIsNone(check_start_session({'title': '修 verifier 的 bug'}))

    def test_fork_and_cloud_are_blocked(self) -> None:
        ok = ok_input('ver-1', 'claude-opus-5-5', 'medium')
        self.assertIsNotNone(check_start_session({**ok, 'context': 'fork'}))
        self.assertIsNotNone(check_start_session({**ok, 'target': 'cloud'}))
        self.assertIsNone(check_start_session({**ok, 'context': 'fresh', 'target': 'local'}))

    def test_model_generation(self) -> None:
        for model, ok in (('sonnet', True), ('claude-sonnet-5-5', True), ('claude-sonnet-6', True),
                          ('claude-sonnet-5-5[1m]', True), ('claude-sonnet-5-5-20261001', True),
                          ('claude-sonnet-4-5', False), ('claude-3-5-sonnet', False), ('my-sonnet-fork', False),
                          ('claude-sonnet-5-foo', False), ('claude-sonnet-5-5[1m]x', False), ('claude-sonnet-5-5[]', False)):
            with self.subTest(model=model):
                self.assertEqual(check_start_session(ok_input('eng-1', model, 'medium')) is None, ok)

    def test_cwd_host_and_worktree_flag_are_blocked(self) -> None:
        ok = ok_input('eng-1', 'sonnet', 'medium')
        self.assertIsNone(check_start_session(ok))
        for extra in ({'cwd': '/tmp/x'}, {'host': 'devbox'}, {'use_worktree': True}):
            with self.subTest(extra=extra):
                self.assertIsNotNone(check_start_session({**ok, **extra}))
        missing = {k: v for k, v in ok.items() if k != 'use_worktree'}
        self.assertIsNotNone(check_start_session(missing))

    def test_prompt_must_forbid_shared_notes(self) -> None:
        ok = ok_input('ver-1', 'opus', 'medium')
        self.assertIsNotNone(check_start_session({**ok, 'prompt': '判定 #1 的 PR #2。'}))
        self.assertIsNotNone(check_start_session({**ok, 'prompt': '去讀 notes 目錄。'}))
        no_prompt = {k: v for k, v in ok.items() if k != 'prompt'}
        self.assertIsNone(check_start_session(no_prompt))

    def test_prompt_must_state_download_rule(self) -> None:
        ok = ok_input('eng-1', 'sonnet', 'medium')
        notes_only = '開場。不讀不寫 app 給的共用 notes 目錄。'
        reason = check_start_session({**ok, 'prompt': notes_only})
        self.assertIsNotNone(reason)
        self.assertIn('下載', reason)
        self.assertIsNone(check_start_session({**ok, 'prompt': notes_only + '下載先寫在卡上等 operator 核可。'}))

    def test_hook_exit_codes(self) -> None:
        self.assertEqual(run(['pre-start-session'], {'tool_input': {'name': 'ver-1'}})[0], 2)
        self.assertEqual(run(['pre-start-session'], {'tool_input': ok_input('ver-1', 'opus', 'medium')})[0], 0)


def blocked(command: str) -> bool:
    return check_download({'command': command}) is not None


class DownloadTest(unittest.TestCase):
    def test_pull_and_wide_fetch_are_blocked(self) -> None:
        for command in (
            'git pull', 'git pull --ff-only', 'git -C /x pull', 'git fetch', 'git fetch origin', 'git fetch --all',
            'git fetch origin main', 'git fetch origin develop:develop', 'git fetch origin refs/heads/develop',
            'git fetch upstream develop', 'git fetch origin develop --depth=1', 'git fetch --prune origin develop',
            'git remote update', 'git -c a=b fetch origin pull/1/head',
        ):
            with self.subTest(command=command):
                self.assertTrue(blocked(command))

    def test_only_origin_develop_fetch_passes(self) -> None:
        for command in (
            'git fetch origin develop', 'git -C /x fetch origin develop', 'git fetch -q origin develop',
            'git fetch origin develop 2>&1', 'git fetch origin develop && git merge --ff-only FETCH_HEAD',
            'git status', 'git push origin HEAD:refs/heads/x', 'git log --grep=pull',
        ):
            with self.subTest(command=command):
                self.assertFalse(blocked(command))

    def test_pnpm_install_and_deploy_need_offline(self) -> None:
        for command in ('pnpm install', 'pnpm i', 'pnpm deploy out', 'pnpm -C a --filter b install', 'pnpm install --prefer-offline', 'pnpm install --offline=false'):
            with self.subTest(command=command):
                self.assertTrue(blocked(command))
        for command in ('pnpm install --offline', 'pnpm --filter b deploy --offline out', 'pnpm run test', 'pnpm exec vitest run', 'pnpm add --offline x'):
            with self.subTest(command=command):
                self.assertFalse(blocked(command))

    def test_found_through_wrappers_and_compound_commands(self) -> None:
        for command in (
            'rtk git pull', 'FOO=1 git pull', 'env X=1 git pull', 'timeout 5 git pull', 'cd x && git pull', 'git status | head; git pull',
            'if true; then git pull; fi', 'bash -c "git pull"', "sh -c 'cd x && pnpm install'", 'echo $(git pull)', 'echo "$(git pull)"',
            'x=`git pull`', 'cat <<E\nx\nE\ngit pull', 'git status\ngit pull', '(git pull)', '/usr/bin/git pull',
        ):
            with self.subTest(command=command):
                self.assertTrue(blocked(command))

    def test_quoted_text_and_heredoc_bodies_are_not_commands(self) -> None:
        for command in (
            'echo "git pull"', "grep 'git pull' f", 'git commit -m "run pnpm install"', "cat <<'E'\ngit pull\nE\ngit status",
            'git fetch origin develop # git pull', 'echo "pnpm install" > notes.txt',
        ):
            with self.subTest(command=command):
                self.assertFalse(blocked(command))

    def test_env_vars_and_marker_files_do_not_unblock(self) -> None:
        for command in (
            'ALLOW_DOWNLOAD=1 git pull', 'NEXUS_APPROVED=1 pnpm install', 'touch .download-approved && git pull',
            'echo approved > /tmp/approved; git fetch --all', 'export OK=1; git pull',
        ):
            with self.subTest(command=command):
                self.assertTrue(blocked(command))

    def test_message_tells_operator_to_run_it(self) -> None:
        reason = check_download({'command': 'git pull'})
        self.assertIn('operator', reason)
        self.assertIn('不代跑', reason)

    def test_non_command_input_passes(self) -> None:
        self.assertIsNone(check_download({}))
        self.assertIsNone(check_download({'command': 5}))

    def test_hook_exit_codes_for_bash_and_terminal_inputs(self) -> None:
        for tool_name in ('Bash', 'mcp__terminal__run_in_terminal'):
            with self.subTest(tool_name=tool_name):
                self.assertEqual(run(['pre-download'], {'tool_name': tool_name, 'tool_input': {'command': 'git pull'}})[0], 2)
                self.assertEqual(run(['pre-download'], {'tool_name': tool_name, 'tool_input': {'command': 'git status'}})[0], 0)

    def test_unparsable_command_passes_with_warning(self) -> None:
        code, err = run(['pre-download'], {'tool_input': {'command': "git pull 'oops"}})
        self.assertEqual(code, 0)
        self.assertIn('放行', err)


class SettingsTest(unittest.TestCase):
    def test_download_hook_covers_bash_and_terminal_panel(self) -> None:
        settings = json.loads((REPO / '.claude/settings.json').read_text(encoding='utf-8'))
        entries = [e for e in settings['hooks']['PreToolUse'] if any('pre-download' in h['command'] for h in e['hooks'])]
        self.assertEqual(len(entries), 1)
        for tool in ('Bash', 'mcp__terminal__run_in_terminal'):
            with self.subTest(tool=tool):
                self.assertRegex(tool, f'^(?:{entries[0]["matcher"]})$')


class RoleTableTest(unittest.TestCase):
    def test_roles_match_skill_md_table(self) -> None:
        rows = {}
        for line in (REPO / SKILL_MD).read_text(encoding='utf-8').splitlines():
            m = re.match(r'^\| ([^|]+?) \| `([^`]+)` \| `([^`]+)` \|$', line)
            if m:
                rows[m.group(1).split(' (')[0]] = (m.group(2), m.group(3))
        for role in ROLES.values():
            with self.subTest(role=role.table_row):
                self.assertEqual(rows.get(role.table_row), (role.model, role.effort))


class ClosingTest(unittest.TestCase):
    def test_accepted_first_lines(self) -> None:
        for reply in ('可封存：都合了', '不可封存：CI 還在跑\n\n細節', '還在等：verifier', '還在等: verifier\n\n', '**不可封存：**等判定', '**不可封存**：等判定', '\n\n> 可封存：x'):
            with self.subTest(reply=reply):
                self.assertIsNone(check_closing(reply))

    def test_missing_closing_line_is_blocked(self) -> None:
        for reply in ('合好了。\n\n可封存：都合了', '判定出來了', '', '可封存了', '不可封存，等 CI'):
            with self.subTest(reply=reply):
                self.assertIsNotNone(check_closing(reply))

    def test_waiting_reply_must_be_one_line(self) -> None:
        reason = check_closing('還在等：CI\n\n細節')
        self.assertIsNotNone(reason)
        self.assertIn('只寫這一行', reason)

    def test_turn_without_text_passes(self) -> None:
        self.assertIsNone(check_closing(None))

    def test_stop_reads_last_assistant_message_only(self) -> None:
        self.assertEqual(run(['stop'], {'transcript_path': '/nonexistent', 'last_assistant_message': '做好了'})[0], 2)
        self.assertEqual(run(['stop'], {'transcript_path': '/nonexistent', 'last_assistant_message': '不可封存：等 CI'})[0], 0)
        self.assertEqual(run(['stop'], {'transcript_path': '/nonexistent'}), (0, ''))

    def test_stop_hook_blocks_then_respects_stop_hook_active(self) -> None:
        self.assertEqual(run(['stop'], {'last_assistant_message': '做好了'})[0], 2)
        self.assertEqual(run(['stop'], {'last_assistant_message': '做好了', 'stop_hook_active': True})[0], 0)


class FailOpenTest(unittest.TestCase):
    def test_errors_pass_with_warning(self) -> None:
        for argv, event in ((['stop'], []), (['stop'], {'last_assistant_message': 5}), (['bogus'], {})):
            with self.subTest(argv=argv, event=event):
                code, err = run(argv, event)
                self.assertEqual(code, 0)
                self.assertIn('放行', err)

    def test_bad_json_passes(self) -> None:
        err = io.StringIO()
        with mock.patch('sys.stdin', io.StringIO('{')), redirect_stderr(err):
            self.assertEqual(session_hooks.main(['x', 'stop']), 0)
        self.assertIn('放行', err.getvalue())


if __name__ == '__main__':
    unittest.main()
