from __future__ import annotations

import contextlib
import io
import itertools
import json
import os
import re
import subprocess
import tempfile
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


FAKE_PREFIX = 'fake'
FAKE_PROGRAMS = ('git', 'pnpm', 'npx', 'rm', 'cp', 'mv', 'tee')
SHELLS_UNDER_TEST = tuple(argv for argv in (('/bin/bash', '--noprofile', '--norc', '-c'), ('/bin/zsh', '-f', '-c')) if os.path.exists(argv[0]))

GUARD_RULES = '暫存只寫你自己的 scratchpad。git worktree remove 不加 --force。不 npx。開子代理時把這些規則原文寫進它的 prompt。'
BASE = {'use_worktree': False, 'prompt': '開場。不讀不寫 app 給的共用 notes 目錄。下載只有開分支前一次 git fetch origin develop，其餘寫在卡上等 operator 核可。' + GUARD_RULES}


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
        notes_only = '開場。不讀不寫 app 給的共用 notes 目錄。' + GUARD_RULES
        reason = check_start_session({**ok, 'prompt': notes_only})
        self.assertIsNotNone(reason)
        self.assertIn('下載', reason)
        rule = '下載只有開分支前一次 git fetch origin develop，其餘先寫在卡上等 operator 核可。'
        self.assertIsNone(check_start_session({**ok, 'prompt': notes_only + rule}))
        unrelated = '合併不用等 operator 核可。'
        self.assertIsNone(check_start_session({**ok, 'prompt': notes_only + rule + unrelated}))
        for fine in ('下載不要自己核可。', '下載時 PM 不要代為核可。', '下載先問，免得白等核可。'):
            with self.subTest(fine=fine):
                self.assertIsNone(check_start_session({**ok, 'prompt': notes_only + rule + fine}))
        self.assertIsNotNone(check_start_session({**ok, 'prompt': notes_only + rule + '其餘下載無需核可。'}))
        for wrong in ('下載先寫在卡上等 operator 核可。', '下載只有開分支前一次 git fetch origin develop，其餘不用 operator 核可。', '下載不需要核可，照常 git fetch origin develop。'):
            with self.subTest(wrong=wrong):
                self.assertIsNotNone(check_start_session({**ok, 'prompt': notes_only + wrong}))

    def test_prompt_must_carry_each_guard_rule(self) -> None:
        ok = ok_input('eng-1', 'sonnet', 'medium')
        head = '開場。不讀不寫 app 給的共用 notes 目錄。下載只有開分支前一次 git fetch origin develop，其餘寫在卡上等 operator 核可。'
        rules = ('暫存只寫你自己的 scratchpad。', 'git worktree remove 不加 --force。', '不 npx。', '開子代理時把這些規則原文寫進它的 prompt。')
        self.assertIsNone(check_start_session({**ok, 'prompt': head + ''.join(rules)}))
        for i, rule in enumerate(rules):
            with self.subTest(rule=rule):
                reason = check_start_session({**ok, 'prompt': head + ''.join(r for j, r in enumerate(rules) if j != i)})
                self.assertIsNotNone(reason)
                self.assertIn('開場要補上', reason)

    def test_hook_exit_codes(self) -> None:
        self.assertEqual(run(['pre-start-session'], {'tool_input': {'name': 'ver-1'}})[0], 2)
        self.assertEqual(run(['pre-start-session'], {'tool_input': ok_input('ver-1', 'opus', 'medium')})[0], 0)


def blocked(command: str) -> bool:
    return check_download({'command': command}) is not None


CONSTRUCTS = (
    ':', 'echo $((1+1))', 'echo "$((1+1))"', 'echo $((1<<2))', '(( 1 + 1 ))', '(( 1<<2 ))', 'if ((1<<2)); then :; fi',
    'while ((n<1)); do n=1; done', 'for ((i=0;i<1;i++)); do :; done', 'echo $(( (1+2)*3 ))', 'echo $(( $(echo 1) + 1 ))', 'echo $((cd x && echo y) )',
    'x=ab; echo ${#x}', 'x=ab; echo "${#x}"', 'echo ${#}', 'echo "${#a[@]}"', 'x=a.b; echo ${x%%.*}', 'x=a.b; echo "${x//./-}"',
    'echo "${x:-d}"', 'echo "${x% #*}"', 'echo "${x:+a; b}"', 'echo $?', 'echo $#', 'echo $[1<<2]', 'echo "$[1+1]"',
    'a=(1 2); echo "${a[0]}"', 'a=(1 2)', '[[ a == a ]]', 'echo $(echo hi)', 'echo `echo hi`', 'cat <(echo hi)',
    'echo hi >/dev/null 2>&1', 'cat <<<hi', '( : )', '{ :; }', "echo $'a\\tb'",
    'case x in (x) : ;; (y) : ;; esac', 'case x in (x) case y in (y) : ;; esac ;; esac', 'f() { :; }', 'function f { :; }',
)
PLACES = (
    '{k}; {c}', '{k}\n{c}', '{k} && {c}', 'x=$({k}; {c})', 'x="$({k}; {c})"', 'x=`{k}; {c}`', "bash -c '{k}; {c}'",
    "bash <<'EOF'\n{k}\n{c}\nEOF", 'cat <<EOF\n$({k}; {c})\nEOF', '({k}; {c})', 'cat <({k}; {c})', 'echo $(case x in (x) {k}; {c};; esac)',
    'f() { {k}; {c}; }; f', 'if true; then {k}; {c}; fi', 'bash - <<EOF\n{k}\n{c}\nEOF',
)


BASIC_CONSTRUCTS = [
    ':', 'echo $((1+1))', 'echo "$((1+1))"', 'echo $((1<<2))', '(( 1 + 1 ))', '(( 1<<2 ))',
    'if ((1<<2)); then :; fi', 'x=ab; echo ${#x}', 'x=ab; echo "${#x}"', 'echo ${#}',
    'x=a.b; echo ${x%%.*}', 'x=a.b; echo "${x//./-}"', 'echo "${x:-d}"', 'echo $?', 'echo $#',
    'a=(1 2); echo "${a[0]}"', '[[ a == a ]]', 'echo $(echo hi)', 'echo `echo hi`', 'cat <(echo hi)',
    'echo hi >/dev/null 2>&1', 'cat <<<hi', '( : )', '{ :; }', "echo $'a\\tb'",
]
BASIC_PLACES = [
    '{k}; {c}', '{k}\n{c}', '{k} && {c}', 'x=$({k}; {c})', 'x="$({k}; {c})"', 'x=`{k}; {c}`',
    "bash -c '{k}; {c}'", "bash <<'EOF'\n{k}\n{c}\nEOF", 'cat <<EOF\n$({k}; {c})\nEOF',
    '({k}; {c})', 'cat <({k}; {c})',
]


@contextlib.contextmanager
def fake_programs():
    with tempfile.TemporaryDirectory() as tmp:
        log = Path(tmp, 'ran.log')
        for tool in FAKE_PROGRAMS:
            stub = Path(tmp, f'{FAKE_PREFIX}{tool}')
            stub.write_text('#!/bin/sh\necho "$(basename "$0") $*" >> "$STUBLOG"\n', encoding='utf-8')
            stub.chmod(0o755)
        env = {'PATH': f'{tmp}:/usr/bin:/bin', 'STUBLOG': str(log), 'HOME': tmp}
        pattern = rf'\b({"|".join(FAKE_PROGRAMS)})\b'

        def ran_under_fakes(command: str) -> list[str]:
            renamed = re.sub(pattern, rf'{FAKE_PREFIX}\1', command)
            assert not re.search(pattern, renamed)
            ran: list[str] = []
            for argv in SHELLS_UNDER_TEST:
                log.write_text('', encoding='utf-8')
                subprocess.run([*argv, renamed], cwd=tmp, env=env, capture_output=True, timeout=10, stdin=subprocess.DEVNULL, check=False)
                ran += [line.replace(FAKE_PREFIX, '') for line in log.read_text(encoding='utf-8').splitlines() if line.strip()]
            return ran

        yield ran_under_fakes


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
            'eval git pull', 'eval eval eval eval eval git pull', 'cat <<-EOF\n x\nEOF\ngit pull', 'cat <<\\EOF\nx\nEOF\ngit pull',
            'echo $((1<<4))\ngit pull', "bash -lc 'git pull'", 'zsh -lc "git pull"', "sh -ec 'pnpm install'", 'git -C $(pwd) pull',
            'pnpm --dir $(pwd) install', 'out="$(cd "$ROOT" && git pull --ff-only)"', 'echo "$(cd x && (git pull))"', 'cat <(git pull)',
            'cat <<EOF\n$(git pull)\nEOF', 'nice -n 10 git pull', 'timeout -k 5 10 git pull', 'env -u X git pull', 'sudo -u x git pull',
            'taskpolicy -c background pnpm install', 'npx pnpm install', 'corepack pnpm install', 'pnpm --store-dir /s install',
            'pnpm install --offline --offline=false', 'bash <<EOF\ngit pull\nEOF', 'cat <<EOF | bash\ngit pull\nEOF',
            "echo $'it\\'s'; git pull", 'echo "${x:-$(git pull)}"', '(( x << 2 ))\ngit pull', 'git -c remote.origin.url=x fetch origin develop',
            'echo "$(echo "$(echo "$(git pull)")")"', 'taskpolicy -b git pull', 'caffeinate -i git pull', 'env -S "git pull"',
            'bash -o pipefail -c "git pull"', 'echo ' + '$(' * 2000 + 'git pull' + ')' * 2000,
        ):
            with self.subTest(command=command):
                self.assertTrue(blocked(command))

    def test_quoted_text_and_heredoc_bodies_are_not_commands(self) -> None:
        for command in (
            'echo "git pull"', "grep 'git pull' f", 'git commit -m "run pnpm install"', "cat <<'E'\ngit pull\nE\ngit status",
            'git fetch origin develop # git pull', 'echo "pnpm install" > notes.txt',
            'git commit -m "docs: 不用 \\`git pull\\`"', 'echo "寫法是 \\$(git pull)"', 'pnpm install --dir $(pwd) --offline',
            'gh pr comment 1 --body "$(cat <<\'EOF\'\n用 `git fetch --all` 會被擋\nEOF\n)"', 'cat <<EOF\ngit pull\nEOF', 'bash <<EOF\necho hi\nEOF',
            "echo 'a;git pull'", 'cat <<-E\n\tgit pull\n\tE', "gh pr comment 1 --body 'git pull and pnpm install'",
        ):
            with self.subTest(command=command):
                self.assertFalse(blocked(command))

    @unittest.skipUnless(os.path.exists('/bin/bash'), 'needs /bin/bash')
    def test_verdict_matches_what_real_bash_would_run(self) -> None:
        wrappers = ('', 'env X=1 ', 'nice -n 10 ', 'FOO=1 ')
        cores = ('git pull', 'git fetch --all', 'git fetch origin develop', 'pnpm install', 'pnpm install --offline', 'git status')
        shapes = (
            '{c}', 'echo hi; {c}', '( {c} )', '$( {c} )', '"$( {c} )"', 'x=`{c}`', 'bash -c "{c}"', "bash -ec '{c}'", 'eval "{c}"',
            'echo "{c}"', "echo '{c}'", 'echo \\"{c}\\"', 'echo "\\$({c})"', 'echo "\\`{c}\\`"',
            'cat <<EOF\n{c}\nEOF', "cat <<'EOF'\n{c}\nEOF", 'cat <<EOF\n$({c})\nEOF', "cat <<'EOF'\n$({c})\nEOF", 'cat <<-EOF\n\t{c}\n\tEOF',
            'cat <<EOF | bash\n{c}\nEOF', 'bash <<EOF\n{c}\nEOF', "bash <<'EOF'\n{c}\nEOF", 'cat <({c})', 'echo ${{x:-$({c})}}',
            'if true; then {c}; fi', '{c} 2>&1', '{c} # {c}', 'echo $((1<<4))\n{c}', 'echo "a $({c}) b"', 'echo "$(echo "$({c})")"',
            'echo "$(cat <<\'EOF\'\n{c}\nEOF\n)"', 'f() {{ {c}; }}; f',
        )
        with fake_programs() as ran_under_fakes:
            for wrapper, core, shape in itertools.product(wrappers, cores, shapes):
                command = shape.replace('{{', '{').replace('}}', '}').replace('{c}', wrapper + core)
                with self.subTest(command=command):
                    self.assertEqual(blocked(command), any(blocked(line) for line in ran_under_fakes(command)))

    @unittest.skipUnless(os.path.exists('/bin/bash'), 'needs /bin/bash')
    def test_every_syntax_in_every_position_matches_what_real_bash_would_run(self) -> None:
        cores = ('git pull', 'git fetch origin develop', 'pnpm install', 'pnpm install --offline')
        with fake_programs() as ran_under_fakes:
            for core, construct, place in itertools.product(cores, CONSTRUCTS, PLACES):
                if ("'" in construct and place.startswith('bash -c')) or ('`' in construct and '`' in place):
                    continue
                command = place.replace('{k}', construct).replace('{c}', core)
                with self.subTest(command=command):
                    self.assertEqual(blocked(command), any(blocked(line) for line in ran_under_fakes(command)))

    @unittest.skipUnless(os.path.exists('/bin/bash'), 'needs /bin/bash')
    def test_basic_syntax_table_matches_what_real_bash_would_run(self) -> None:
        with fake_programs() as ran_under_fakes:
            for core, construct, place in itertools.product(('git pull',), BASIC_CONSTRUCTS, BASIC_PLACES):
                if ("'" in construct and place.startswith('bash -c')) or ('`' in construct and '`' in place):
                    continue
                command = place.replace('{k}', construct).replace('{c}', core)
                with self.subTest(command=command):
                    self.assertEqual(blocked(command), any(blocked(line) for line in ran_under_fakes(command)))

    def test_what_the_shell_would_not_run_is_not_blocked_and_vice_versa(self) -> None:
        for command in (
            'out="$(n=$((1+1)); git pull)"', 'echo "$(echo $((1+1)) && git pull)"', 'cat <<EOF\n$(echo $((1+1)); git pull)\nEOF',
            'if ((1<<4)); then echo y; fi\ngit pull', 'while ((n<3)); do n=1; done\ngit pull', 'for ((i=0;i<2;i++)); do :; done; git pull',
            '(( n = $(git pull) ))', 'git -C wt$((1+1)) pull', 'echo $((cd x && git pull) )', 'echo ${#x}; git pull',
            'if [ ${#x} -gt 0 ]; then git pull; fi', 'echo "${#a[@]}"; git pull', 'echo ${#}; git pull', 'echo "${x% #*}"; git pull',
            "bash -c 'echo ${#x}; git pull'", 'echo $(( $(git pull) ))', 'echo $[ $(git pull) ]', 'echo $[1<<4]\ngit pull',
            'x=$((( 1+1 )); git pull)', 'cat <<EOF\n${x:-it\'s}\n$(git pull)\nEOF', 'function f { git pull; }; f',
            'echo $(case x in (x) git pull;; esac)', 'echo $(case x in x) git pull;; esac)', 'x=`echo `echo hi`; git pull`', 'echo ${x:-<(git pull)}', 'bash - <<EOF\ngit pull\nEOF', 'bash -s a <<EOF\ngit pull\nEOF',
            'echo "`bash -c \\"git pull\\"`"',
        ):
            with self.subTest(command=command):
                self.assertTrue(blocked(command))
        for command in (
            'pnpm install --child-concurrency=$((8/2)) --offline', 'echo "${x:+now; git pull}"', 'a=(git pull)', 'echo "${x:-<(git pull)}"', 'cat <<EOF\n<(git pull)\nEOF', 'echo $((1+1)) git pull',
            'echo $((cd x && echo "git pull") )', 'echo $(( 1 << 2 )) ${#x} "$[1+1]"; git status', 'case x in git) git status;; esac',
        ):
            with self.subTest(command=command):
                self.assertFalse(blocked(command))

    def test_env_vars_and_marker_files_do_not_unblock(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            for name in ('.download-approved', 'approved', 'APPROVED', '.nexus-approved'):
                Path(tmp, name).write_text('ok', encoding='utf-8')
            env = {**os.environ, 'ALLOW_DOWNLOAD': '1', 'NEXUS_APPROVED': '1', 'NEXUS_ALLOW_DOWNLOAD': 'true', 'DOWNLOAD_APPROVED': '1'}
            for command in ('git pull', 'pnpm install', 'git fetch --all'):
                with self.subTest(command=command):
                    result = run_settings_hook('Bash', command, env=env, cwd=tmp)
                    self.assertEqual(result.returncode, 2, result.stderr)

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


SCRATCH = '/private/tmp/claude-501/fake-project/fake-session/scratchpad'
OTHER_SCRATCH = '/private/tmp/claude-501/fake-project/other-session/scratchpad'


def guarded(command: str, session_id: str | None = 'fake-session') -> str | None:
    return check_download({'command': command}, session_id)


class GuardTest(unittest.TestCase):
    def test_npx_and_equivalents_are_blocked_with_no_way_out(self) -> None:
        for command in (
            'npx vitest', 'npx -y vitest run', 'pnpm dlx vitest', 'pnpm -C a dlx vitest', 'npm exec vitest', 'npm x vitest', 'yarn dlx vitest', 'pnpx vitest', 'bunx vitest',
            'FOO=1 npx vitest', 'env npx vitest', 'timeout 5 npx vitest', 'cd x && npx vitest', 'bash -c "npx vitest"', 'echo $(npx vitest)', '/usr/bin/npx vitest',
            'rtk npx vitest', 'corepack npx vitest',
        ):
            with self.subTest(command=command):
                reason = guarded(command)
                self.assertIsNotNone(reason)
                self.assertIn('pnpm exec', reason)
                self.assertNotIn('核可後', reason)
        for command in ('pnpm exec vitest run', 'pnpm run test', 'npm run test', 'echo "npx vitest"', 'git commit -m "不 npx"', 'ls npx'):
            with self.subTest(command=command):
                self.assertIsNone(guarded(command))

    def test_forced_worktree_removal_is_blocked(self) -> None:
        for command in (
            'git worktree remove --force /nope/fake', 'git worktree remove -f /nope/fake', 'git worktree remove -ff /nope/fake', 'git worktree remove /nope/fake --force',
            'git -C /nope/fake worktree remove -f /nope/fake', 'cd x && git worktree remove --force y', 'bash -c "git worktree remove -f y"', 'sudo git worktree remove -f y',
        ):
            with self.subTest(command=command):
                reason = guarded(command)
                self.assertIsNotNone(reason)
                self.assertIn('operator', reason)
        for command in ('git worktree remove /nope/fake', 'git worktree add -f /nope/worktrees/eng-1', 'git worktree list', 'git worktree prune', 'git worktree remove -- -f',
                        'git commit -m "git worktree remove --force"'):
            with self.subTest(command=command):
                self.assertIsNone(guarded(command))

    def test_worktree_add_outside_the_fixed_location_is_blocked(self) -> None:
        for command in (
            'git worktree add /nope/fake', 'git worktree add --no-track -b feat/x /nope/fake origin/develop', 'git worktree add .claude/worktrees/eng-1 origin/develop',
            'git worktree add /nope/.claude/worktrees/eng-1', 'git worktree add worktrees/eng-1', 'git worktree add ../elsewhere/eng-1', 'git worktree add /nope/worktrees/fake',
            'git worktree add -b x ../worktrees/eng-1/sub', 'cd x && git worktree add /nope/fake', 'bash -c "git worktree add /nope/fake"', 'git -C /nope/repo worktree add ../fake',
        ):
            with self.subTest(command=command):
                reason = guarded(command)
                self.assertIsNotNone(reason)
                self.assertIn('worktree.sh new', reason)
        for command in (
            'git worktree add --no-track -b chore/x ../worktrees/eng-3151 origin/develop', 'git worktree add -B x /nope/worktrees/ver-3180-b', 'git worktree add --detach ~/p/worktrees/ver-12 HEAD',
            'git worktree add -b x "$WT" origin/develop', 'git worktree add "$(pwd)/../worktrees/eng-1"', 'git worktree list', 'git worktree remove /nope/fake',
            'git commit -m "git worktree add /nope/fake"',
        ):
            with self.subTest(command=command):
                self.assertIsNone(guarded(command))

    def test_writes_to_shared_temp_are_blocked(self) -> None:
        for command in (
            'echo x > /tmp/fake-a', 'echo x >> /tmp/fake-a', 'echo x >/tmp/fake-a', 'echo x &>/tmp/fake-a', 'echo x >| /tmp/fake-a', 'echo x 2> /tmp/fake-a', 'echo x > "/tmp/fake-a"',
            'echo x > /private/tmp/fake-a', 'echo x > /var/folders/ab/cd/T/fake-a', 'echo x > /var/tmp/fake-a', 'echo x > /tmp/../tmp/fake-a',
            'cp a /tmp/fake-a', 'cp -r a b /tmp/fake-dir', 'cp -t /tmp/fake-dir a', 'cp --target-directory=/tmp/fake-dir a', 'mv a /tmp/fake-a', 'mv /tmp/fake-a b', 'mv -f /tmp/fake-a b',
            'tee /tmp/fake-a', 'echo x | tee -a /tmp/fake-a', 'rm /tmp/fake-a', 'rm -rf /tmp/fake-dir', 'rm -rf -- /tmp/fake-dir', 'rmdir /tmp/fake-dir', 'mkdir -p /tmp/fake-dir', 'touch /tmp/fake-a',
            'rm /private/tmp/claude-501/fake-project/other-session/scratchpad/fake-a', f'echo x > {OTHER_SCRATCH}/fake-a', f'rm {SCRATCH}/../../fake-a',
            'bash -c "rm /tmp/fake-a"', 'cd x && echo y > /tmp/fake-a', 'echo $(rm /tmp/fake-a)', 'cat <<EOF | bash\nrm /tmp/fake-a\nEOF', 'FOO=1 rm /tmp/fake-a', '/bin/rm /tmp/fake-a',
        ):
            with self.subTest(command=command):
                reason = guarded(command)
                self.assertIsNotNone(reason)
                self.assertIn('scratchpad', reason)

    def test_own_scratchpad_and_other_paths_pass(self) -> None:
        for command in (
            f'echo x > {SCRATCH}/fake-a', f'echo x >> {SCRATCH}/a/b', f'cp a {SCRATCH}/fake-a', f'cp -t {SCRATCH} a', f'mv {SCRATCH}/a {SCRATCH}/b', f'rm -rf {SCRATCH}/fake-dir',
            f'echo x | tee {SCRATCH}/fake-a', f'mkdir -p {SCRATCH}/x', 'echo x > /tmp/claude-501/fake-project/fake-session/scratchpad/fake-a',
            'echo x > out.txt', 'echo x > ./out.txt', 'cp a b', 'cp /tmp/fake-a b', 'cat /tmp/fake-a > out.txt', 'rm -rf node_modules', 'echo x > /dev/null 2>&1', 'echo x > /Users/x/fake-a',
            'echo x > $SOMEWHERE/fake-a', 'echo x > "$(mktemp)"', 'ls /tmp', 'echo "x > /tmp/fake-a"', "echo 'rm /tmp/fake-a'", 'git commit -m "rm /tmp/fake-a"', 'grep x /tmp/fake-a',
            'echo x > /tmpfoo/fake-a', 'echo x > /private/tmpfoo/fake-a',
        ):
            with self.subTest(command=command):
                self.assertIsNone(guarded(command))

    def test_scratchpad_exception_needs_the_matching_session(self) -> None:
        self.assertIsNone(guarded(f'echo x > {SCRATCH}/fake-a', 'fake-session'))
        self.assertIsNotNone(guarded(f'echo x > {SCRATCH}/fake-a', 'another-session'))
        self.assertIsNone(guarded(f'echo x > {SCRATCH}/fake-a', None))

    def test_the_five_incidents_replayed_as_strings(self) -> None:
        for command in (
            'pnpm install', 'git worktree remove --force /nope/fake', 'npx vitest run', 'cp a /tmp/fake-shared.txt', 'echo x > /tmp/fake-shared.txt',
        ):
            with self.subTest(command=command):
                self.assertIsNotNone(guarded(command))

    def test_hook_exit_code_and_message_for_guard_rules(self) -> None:
        code, err = run(['pre-download'], {'session_id': 'fake-session', 'tool_input': {'command': 'npx vitest'}})
        self.assertEqual(code, 2)
        self.assertIn('pnpm exec', err)
        self.assertEqual(run(['pre-download'], {'session_id': 'fake-session', 'tool_input': {'command': f'echo x > {SCRATCH}/fake-a'}})[0], 0)
        self.assertEqual(run(['pre-download'], {'session_id': 'other', 'tool_input': {'command': f'echo x > {SCRATCH}/fake-a'}})[0], 2)

    @unittest.skipUnless(os.path.exists('/bin/bash'), 'needs /bin/bash')
    def test_verdict_matches_what_real_bash_would_run_for_fake_programs(self) -> None:
        cores = (
            'npx vitest', 'rm /tmp/fake-a', 'cp a /tmp/fake-a', 'mv a /tmp/fake-a', 'echo x | tee /tmp/fake-a', 'rm fake-local', 'cp a b',
            'git worktree remove --force /nope/fake', 'git worktree remove /nope/fake',
        )
        shapes = (
            '{c}', 'echo hi; {c}', '( {c} )', '$( {c} )', 'x=`{c}`', 'bash -c "{c}"', 'eval "{c}"', 'echo "{c}"', "echo '{c}'", 'cat <<EOF\n{c}\nEOF',
            "cat <<'EOF'\n{c}\nEOF", 'cat <<EOF | bash\n{c}\nEOF', 'if true; then {c}; fi', 'f() {{ {c}; }}; f', 'echo "$({c})"',
        )
        with fake_programs() as ran_under_fakes:
            for core, shape in itertools.product(cores, shapes):
                command = shape.replace('{{', '{').replace('}}', '}').replace('{c}', core)
                with self.subTest(command=command):
                    self.assertEqual(guarded(command) is not None, any(guarded(line) is not None for line in ran_under_fakes(command)))


def settings_entry() -> dict:
    settings = json.loads((REPO / '.claude/settings.json').read_text(encoding='utf-8'))
    entries = [e for e in settings['hooks']['PreToolUse'] if any('pre-download' in h['command'] for h in e['hooks'])]
    assert len(entries) == 1
    return entries[0]


def run_settings_hook(tool_name: str, command: str, env: dict | None = None, cwd: str | None = None) -> subprocess.CompletedProcess:
    entry = settings_entry()
    hook = entry['hooks'][0]['command']
    event = json.dumps({'tool_name': tool_name, 'tool_input': {'command': command}})
    full_env = {**(env or os.environ), 'CLAUDE_PROJECT_DIR': str(REPO)}
    return subprocess.run(['/bin/sh', '-c', hook], input=event, capture_output=True, text=True, env=full_env, cwd=cwd, check=False)


class SettingsTest(unittest.TestCase):
    def test_download_hook_covers_bash_monitor_and_terminal_panel(self) -> None:
        for tool in ('Bash', 'Monitor', 'mcp__terminal__run_in_terminal'):
            with self.subTest(tool=tool):
                self.assertRegex(tool, f'^(?:{settings_entry()["matcher"]})$')

    def test_settings_hook_command_blocks_end_to_end_for_each_tool(self) -> None:
        for tool in ('Bash', 'Monitor', 'mcp__terminal__run_in_terminal'):
            with self.subTest(tool=tool):
                blocked_result = run_settings_hook(tool, 'git pull')
                self.assertEqual(blocked_result.returncode, 2, blocked_result.stderr)
                self.assertIn('operator', blocked_result.stderr)
                self.assertEqual(run_settings_hook(tool, 'git status').returncode, 0)


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
