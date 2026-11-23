from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / '.agents/skills/pstack/skills/poteto-mode/scripts/worktree.sh'
GIT_ENV = {'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}


def git(cwd: Path, *args: str) -> str:
    done = subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, check=True, env={**os.environ, **GIT_ENV})
    return done.stdout.strip()


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        origin = self.root / 'origin.git'
        subprocess.run(['git', 'init', '--bare', '-b', 'develop', str(origin)], check=True, capture_output=True)
        self.main = self.root / 'project'
        subprocess.run(['git', 'clone', str(origin), str(self.main)], check=True, capture_output=True)
        git(self.main, 'checkout', '-b', 'develop')
        (self.main / 'a.txt').write_text('a\n')
        git(self.main, 'add', 'a.txt')
        git(self.main, 'commit', '-m', 'init')
        git(self.main, 'push', 'origin', 'HEAD:refs/heads/develop')
        git(self.main, 'fetch', 'origin', 'develop')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.pnpm_log = self.root / 'pnpm.log'
        self.pr_file = self.root / 'prs.txt'
        self.pr_file.write_text('')
        self.stub('gh', f'cat "{self.pr_file}"')
        self.stub('pnpm', f'echo "$@" >> "{self.pnpm_log}"')

    def stub(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text(f'#!/bin/sh\n{body}\n')
        path.chmod(0o755)

    def prs(self, *lines: str) -> None:
        self.pr_file.write_text(''.join(line + '\n' for line in lines))

    def run(self, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
        env = {**os.environ, **GIT_ENV, 'GH': str(self.bin / 'gh'), 'PNPM': str(self.bin / 'pnpm')}
        return subprocess.run(['bash', str(SCRIPT), *args], cwd=cwd or self.main, capture_output=True, text=True, env=env, check=False)

    def new(self, branch: str = 'chore/x', card: str = '12') -> Path:
        done = self.run('new', branch, card)
        assert done.returncode == 0, done.stderr
        return self.root / 'worktrees' / f'eng-{card}'


class NewTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fx = Fixture(Path(self.tmp.name))

    def test_opens_at_the_fixed_location_without_upstream_and_prepares_it(self) -> None:
        path = self.fx.new()
        self.assertEqual(path.parent, self.fx.root / 'worktrees')
        self.assertEqual(git(path, 'rev-parse', 'HEAD'), git(self.fx.main, 'rev-parse', 'origin/develop'))
        self.assertEqual(git(path, 'branch', '--show-current'), 'chore/x')
        self.assertNotEqual(subprocess.run(['git', 'rev-parse', '--abbrev-ref', '@{u}'], cwd=path, capture_output=True).returncode, 0)
        self.assertEqual(self.fx.pnpm_log.read_text().splitlines(), ['install --offline', 'run build:lib'])

    def test_runs_from_inside_a_worktree_too(self) -> None:
        first = self.fx.new('chore/x', '12')
        second = self.fx.run('new', 'chore/y', '13', cwd=first)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertTrue((self.fx.root / 'worktrees' / 'eng-13').is_dir())

    def test_refuses_bad_input_and_existing_paths(self) -> None:
        self.fx.new()
        for args in (('chore/z', '12'), ('chore/z', 'abc'), ('chore/z', '13', 'ver'), ('bad branch', '13'), ('chore/z',)):
            with self.subTest(args=args):
                self.assertNotEqual(self.fx.run('new', *args).returncode, 0)

    def test_refuses_an_existing_empty_directory(self) -> None:
        (self.fx.root / 'worktrees' / 'eng-14').mkdir(parents=True)
        done = self.fx.run('new', 'chore/y', '14')
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('已經有', done.stderr)
        self.assertNotIn('chore/y', git(self.fx.main, 'branch', '--list', 'chore/y'))

    def test_refuses_without_local_origin_develop(self) -> None:
        git(self.fx.main, 'update-ref', '-d', 'refs/remotes/origin/develop')
        done = self.fx.run('new', 'chore/x', '12')
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('git fetch origin develop', done.stderr)
        self.assertFalse((self.fx.root / 'worktrees' / 'eng-12').exists())

    def test_a_failing_install_is_reported(self) -> None:
        self.fx.stub('pnpm', 'exit 1')
        done = self.fx.run('new', 'chore/x', '12')
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('pnpm install --offline', done.stderr)


class DoneTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fx = Fixture(Path(self.tmp.name))
        self.path = self.fx.new()
        (self.path / 'b.txt').write_text('b\n')
        git(self.path, 'add', 'b.txt')
        git(self.path, 'commit', '-m', 'work')
        self.head = git(self.path, 'rev-parse', 'HEAD')

    def test_a_detached_verifier_worktree_is_found_by_sha_and_removed_with_open_ok(self) -> None:
        sha = git(self.path, 'rev-parse', 'HEAD')
        ver = self.fx.root / 'worktrees' / 'ver-9'
        git(self.fx.main, 'worktree', 'add', '--detach', str(ver), sha)
        self.fx.prs(f'7 OPEN {sha}')
        self.assertNotEqual(self.fx.run('done', str(ver)).returncode, 0)
        self.assertTrue(ver.exists())
        done = self.fx.run('done', '--open-ok', str(ver))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse(ver.exists())

    def test_a_relative_path_works_with_cdpath_set(self) -> None:
        nested = self.fx.main / 'wt-x'
        git(self.fx.main, 'worktree', 'add', '--detach', str(nested), self.head)
        self.fx.prs(f'7 MERGED {self.head}')
        env = {**os.environ, **GIT_ENV, 'GH': str(self.fx.bin / 'gh'), 'CDPATH': str(self.fx.main)}
        done = subprocess.run(['bash', str(SCRIPT), 'done', 'wt-x'], cwd=self.fx.main, capture_output=True, text=True, env=env, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse(nested.exists())

    def test_removes_a_merged_clean_worktree_and_keeps_the_branch(self) -> None:
        self.fx.prs(f'7 MERGED {self.head}')
        done = self.fx.run('done', str(self.path))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse(self.path.exists())
        self.assertEqual(git(self.fx.main, 'rev-parse', '--verify', 'refs/heads/chore/x'), self.head)

    def test_refuses_an_unmerged_pr_unless_open_ok(self) -> None:
        self.fx.prs(f'7 OPEN {self.head}')
        self.assertNotEqual(self.fx.run('done', str(self.path)).returncode, 0)
        self.assertTrue(self.path.exists())
        self.assertEqual(self.fx.run('done', '--open-ok', str(self.path)).returncode, 0)
        self.assertFalse(self.path.exists())

    def test_refuses_when_head_is_not_the_last_pr_commit(self) -> None:
        self.fx.prs('7 MERGED ' + '0' * 40)
        self.assertNotEqual(self.fx.run('done', str(self.path)).returncode, 0)
        self.assertTrue(self.path.exists())

    def test_refuses_when_there_is_no_pr(self) -> None:
        self.assertNotEqual(self.fx.run('done', str(self.path)).returncode, 0)
        self.assertTrue(self.path.exists())

    def test_refuses_uncommitted_and_untracked_content(self) -> None:
        self.fx.prs(f'7 MERGED {self.head}')
        for name, tracked in (('b.txt', True), ('scratch.txt', False)):
            with self.subTest(name=name):
                (self.path / name).write_text('changed\n')
                done = self.fx.run('done', str(self.path))
                self.assertNotEqual(done.returncode, 0)
                self.assertIn(name, done.stderr)
                self.assertTrue((self.path / name).exists())
                if tracked:
                    git(self.path, 'checkout', 'b.txt')
                else:
                    (self.path / name).unlink()

    def test_refuses_the_main_checkout_even_when_a_merged_pr_matches_its_head(self) -> None:
        self.fx.prs(f'7 MERGED {git(self.fx.main, "rev-parse", "HEAD")}')
        done = self.fx.run('done', str(self.fx.main))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('主 checkout', done.stderr)
        self.assertTrue(self.fx.main.exists())

    def test_half_deleted_directory_is_reported_with_its_files_and_left_alone(self) -> None:
        half = self.fx.root / 'worktrees' / 'eng-3175'
        (half / 'node_modules/pkg').mkdir(parents=True)
        (half / 'node_modules/pkg/readonly.js').write_text('x\n')
        (half / '.git').write_text('gitdir: /nope\n')
        done = self.fx.run('done', str(half))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('半刪', done.stderr)
        self.assertIn('node_modules/pkg/readonly.js', done.stderr)
        self.assertIn('.git', done.stderr)
        self.assertTrue((half / 'node_modules/pkg/readonly.js').exists())

    def test_leftovers_after_a_removal_are_reported_not_deleted(self) -> None:
        self.fx.prs(f'7 MERGED {self.head}')
        real_git = subprocess.run(['which', 'git'], capture_output=True, text=True, check=True).stdout.strip()
        self.fx.stub('git', f'''if [ "$1" = worktree ] && [ "$2" = remove ]; then
  "{real_git}" "$@" || exit $?
  mkdir -p "$3" && echo left > "$3/.DS_Store"
  exit 0
fi
exec "{real_git}" "$@"''')
        env_path = f'{self.fx.bin}:{os.environ["PATH"]}'
        done = subprocess.run(
            ['bash', str(SCRIPT), 'done', str(self.path)], cwd=self.fx.main, capture_output=True, text=True, check=False,
            env={**os.environ, **GIT_ENV, 'PATH': env_path, 'GH': str(self.fx.bin / 'gh')},
        )
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('半刪', done.stderr)
        self.assertIn('.DS_Store', done.stderr)
        self.assertTrue((self.path / '.DS_Store').exists())


if __name__ == '__main__':
    unittest.main()
