from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from check_adrs import check
from check_ratchets import (
    BASELINE_DIR,
    LEGACY_BASELINE,
    SCRIPT,
    BaselineError,
    assemble,
    baseline_at,
    baseline_path,
    compare,
    directory,
    key_of,
    measure,
    read_baseline,
    write_baseline,
)


def write(root: Path, files: dict[str, str]) -> list[str]:
    for path, text in files.items():
        p = root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding='utf-8')
    return list(files)


class MeasureTest(unittest.TestCase):
    def test_counts_dsh_lines_per_directory(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            files = write(root, {
                'apps/harness/src/a.ts': '// 照 dsh 的做法\nconst x = 1; // deepseek-harness\nconst dshell = 2;\n',
                'packages/nexus-core/src/b.ts': '/** DSH 也算 */\n',
                'scripts/c.sh': '# dsh\n',
                'root.ts': '// dsh\n',
            })
            self.assertEqual(measure(root, files)['dsh'], {
                '.': 1, 'apps/harness': 2, 'packages/nexus-core': 1, 'scripts': 1,
            })

    def test_skips_excluded_paths_and_markdown(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            files = write(root, {
                'references/x/a.ts': '// dsh\n',
                'vendor/y/a.ts': '// dsh\n',
                'apps/web/src/vendor/z/a.ts': '// dsh\n',
                'docs/a.ts': '// dsh\n',
                'apps/harness/src/fixtures/a.ts': '// dsh\n',
                'apps/harness/README.md': 'dsh\n',
                '.github/scripts/check_ratchets.py': '# dsh\n',
            })
            self.assertEqual(measure(root, files)['dsh'], {})

    def test_counts_narrative_only_in_comments(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            files = write(root, {
                'apps/web/src/a.ts': (
                    '// 這張 PR 把它拿掉\n'
                    ' * 這張卡不改語意\n'
                    'const s = "這張 PR";\n'
                    '// 還原先前的派送器\n'
                    'f(); // 原先維持預設\n'
                ),
            })
            self.assertEqual(measure(root, files)['narrative'], {'apps/web': 3})

    def test_inline_slashes_in_string_count_as_comment(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            files = write(root, {'apps/web/src/a.ts': 'const u = "a // 這張卡";\n'})
            self.assertEqual(measure(root, files)['narrative'], {'apps/web': 1})

    def test_directory_key(self) -> None:
        self.assertEqual(directory('apps/harness/src/a.ts'), 'apps/harness')
        self.assertEqual(directory('packages/nexus-core/a.ts'), 'packages/nexus-core')
        self.assertEqual(directory('.github/workflows/ci.yml'), '.github')
        self.assertEqual(directory('vitest.config.ts'), '.')


class CompareTest(unittest.TestCase):
    def test_equal_passes(self) -> None:
        counts = {'dsh': {'apps/web': 3}, 'narrative': {}}
        self.assertEqual(compare(counts, counts, counts), [])

    def test_more_than_baseline_fails(self) -> None:
        errors = compare({'dsh': {'apps/web': 4}}, {'dsh': {'apps/web': 3}}, None)
        self.assertEqual(len(errors), 1)
        self.assertIn('新增的要拿掉', errors[0])

    def test_new_directory_fails(self) -> None:
        errors = compare({'dsh': {'apps/new': 1}}, {'dsh': {}}, None)
        self.assertEqual(len(errors), 1)

    def test_less_than_baseline_asks_to_lower_it(self) -> None:
        errors = compare({'dsh': {'apps/web': 2}}, {'dsh': {'apps/web': 3}}, None)
        self.assertEqual(len(errors), 1)
        self.assertIn('調成 2', errors[0])

    def test_raising_baseline_against_base_fails(self) -> None:
        raised = {'dsh': {'apps/web': 4}}
        errors = compare(raised, raised, {'dsh': {'apps/web': 3}})
        self.assertEqual(len(errors), 1)
        self.assertIn('基準只能降', errors[0])

    def test_lowering_baseline_against_base_passes(self) -> None:
        lowered = {'dsh': {'apps/web': 2}}
        self.assertEqual(compare(lowered, lowered, {'dsh': {'apps/web': 3}}), [])


def git(root: Path, *args: str) -> str:
    out = subprocess.run(
        ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', *args],
        cwd=root, capture_output=True, text=True, check=True,
    )
    return out.stdout.strip()


def commit(root: Path, files: dict[str, str | None], message: str = 'c') -> str:
    for path, text in files.items():
        p = root / path
        if text is None:
            git(root, 'rm', '-q', path)
            continue
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding='utf-8')
        git(root, 'add', path)
    git(root, 'commit', '-q', '--allow-empty', '-m', message)
    return git(root, 'rev-parse', 'HEAD')


def entry(dsh: int, narrative: int = 0) -> str:
    return json.dumps({'dsh': dsh, 'narrative': narrative})


class RepoTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        git(self.root, 'init', '-q', '-b', 'main')

    def tearDown(self) -> None:
        self.tmp.cleanup()


class BaselineFilesTest(unittest.TestCase):
    def test_path_and_key_round_trip(self) -> None:
        for key, path in {
            '.': '.github/ratchets/_root.json',
            '.github': '.github/ratchets/.github.json',
            'apps/web': '.github/ratchets/apps__web.json',
            'packages/nexus-core': '.github/ratchets/packages__nexus-core.json',
        }.items():
            self.assertEqual(baseline_path(key), path)
            self.assertEqual(key_of(path), key)

    def test_write_then_read_round_trips_and_skips_unchanged_files(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            counts = {'dsh': {'apps/web': 3, '.': 1}, 'narrative': {'apps/web': 2}}
            self.assertEqual(len(write_baseline(root, counts)), 2)
            self.assertEqual(read_baseline(root), counts)
            self.assertEqual(
                json.loads((root / baseline_path('.')).read_text(encoding='utf-8')),
                {'dsh': 1, 'narrative': 0},
            )
            self.assertEqual(write_baseline(root, counts), [])
            changed = write_baseline(root, {'dsh': {'apps/web': 2, '.': 1}, 'narrative': {'apps/web': 2}})
            self.assertEqual(changed, [baseline_path('apps/web')])

    def test_write_deletes_file_of_a_directory_that_reached_zero(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            write_baseline(root, {'dsh': {'apps/web': 1}, 'narrative': {}})
            write_baseline(root, {'dsh': {}, 'narrative': {}})
            self.assertFalse((root / baseline_path('apps/web')).exists())

    def test_two_files_for_the_same_directory_are_rejected(self) -> None:
        with self.assertRaises(BaselineError):
            assemble({f'{BASELINE_DIR}/apps__web.json': entry(1), f'{BASELINE_DIR}/z/apps__web.json': entry(2)})

    def test_broken_file_is_an_error(self) -> None:
        for text in ('{', '[]', '{"dsh": 1}', '{"dsh": -1, "narrative": 0}', '{"dsh": true, "narrative": 0}'):
            with tempfile.TemporaryDirectory() as d:
                root = Path(d)
                write(root, {baseline_path('apps/web'): text})
                with self.assertRaises(BaselineError):
                    read_baseline(root)


class BaselineAtTest(RepoTest):
    def test_new_folder_missing_directory_counts_as_zero(self) -> None:
        rev = commit(self.root, {baseline_path('apps/web'): entry(3), SCRIPT: ''})
        self.assertEqual(baseline_at(self.root, rev), {'dsh': {'apps/web': 3}, 'narrative': {}})

    def test_legacy_file_when_folder_is_absent(self) -> None:
        legacy = json.dumps({'dsh': {'apps/web': 3}, 'narrative': {'apps/web': 1}})
        rev = commit(self.root, {LEGACY_BASELINE: legacy, SCRIPT: ''})
        self.assertEqual(baseline_at(self.root, rev), {'dsh': {'apps/web': 3}, 'narrative': {'apps/web': 1}})

    def test_legacy_file_without_a_rule_counts_as_zero(self) -> None:
        rev = commit(self.root, {LEGACY_BASELINE: json.dumps({'dsh': {'apps/web': 3}}), SCRIPT: ''})
        self.assertEqual(baseline_at(self.root, rev), {'dsh': {'apps/web': 3}, 'narrative': {}})

    def test_script_without_any_readable_baseline_is_an_error(self) -> None:
        rev = commit(self.root, {SCRIPT: ''})
        with self.assertRaises(BaselineError):
            baseline_at(self.root, rev)

    def test_broken_baseline_is_an_error(self) -> None:
        commit(self.root, {SCRIPT: ''})
        for files in ({baseline_path('apps/web'): '{'}, {LEGACY_BASELINE: '{'}):
            rev = commit(self.root, files)
            with self.assertRaises(BaselineError):
                baseline_at(self.root, rev)
            git(self.root, 'reset', '-q', '--hard', 'HEAD~1')

    def test_no_script_skips_and_says_why(self) -> None:
        rev = commit(self.root, {'README.md': 'x'})
        with redirect_stdout(io.StringIO()) as out:
            self.assertIsNone(baseline_at(self.root, rev))
        self.assertIn(SCRIPT, out.getvalue())

    def test_file_in_a_subdirectory_does_not_override_the_baseline(self) -> None:
        rev = commit(self.root, {
            baseline_path('apps/web'): entry(3),
            f'{BASELINE_DIR}/z/apps__web.json': entry(999),
            SCRIPT: '',
        })
        self.assertEqual(baseline_at(self.root, rev), {'dsh': {'apps/web': 3}, 'narrative': {}})

    def test_unknown_revision_is_an_error(self) -> None:
        commit(self.root, {'README.md': 'x'})
        with self.assertRaises(BaselineError):
            baseline_at(self.root, 'no-such-rev')

    def test_moving_the_file_while_raising_a_baseline_is_caught(self) -> None:
        rev = commit(self.root, {LEGACY_BASELINE: json.dumps({'dsh': {'apps/web': 3}, 'narrative': {}}), SCRIPT: ''})
        raised = {'dsh': {'apps/web': 4}, 'narrative': {}}
        errors = compare(raised, raised, baseline_at(self.root, rev))
        self.assertEqual(len(errors), 1)
        self.assertIn('基準只能降', errors[0])

    def test_moving_the_file_without_raising_passes(self) -> None:
        rev = commit(self.root, {LEGACY_BASELINE: json.dumps({'dsh': {'apps/web': 3}, 'narrative': {}}), SCRIPT: ''})
        same = {'dsh': {'apps/web': 3}, 'narrative': {}}
        self.assertEqual(compare(same, same, baseline_at(self.root, rev)), [])


class ParallelMergeTest(RepoTest):
    def patch_id(self, base: str, head: str) -> str:
        diff = subprocess.run(
            ['git', 'diff', f'{base}..{head}'], cwd=self.root, capture_output=True, text=True, check=True,
        ).stdout
        return subprocess.run(
            ['git', 'patch-id', '--stable'], cwd=self.root, input=diff, capture_output=True, text=True, check=True,
        ).stdout.split()[0]

    def test_two_branches_lowering_different_directories_merge_cleanly_with_same_patch_id(self) -> None:
        base = commit(self.root, {baseline_path(k): entry(5) for k in ('apps/web', 'apps/harness', '.github')})
        git(self.root, 'checkout', '-q', '-b', 'a')
        head_a = commit(self.root, {baseline_path('apps/web'): entry(4)})
        git(self.root, 'checkout', '-q', 'main')
        git(self.root, 'checkout', '-q', '-b', 'b')
        head_b = commit(self.root, {baseline_path('apps/harness'): entry(4)})
        git(self.root, 'checkout', '-q', 'main')
        git(self.root, 'merge', '-q', '--ff-only', 'b')
        before = self.patch_id(base, head_a)
        git(self.root, 'checkout', '-q', 'a')
        git(self.root, 'merge', '-q', '--no-edit', 'main')
        self.assertEqual(self.patch_id(head_b, 'HEAD'), before)


class AdrTest(unittest.TestCase):
    def run_check(self, files: dict[str, str]) -> list[str]:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            write(root, files)
            return check(root)

    def test_valid_dirs_pass(self) -> None:
        self.assertEqual(self.run_check({
            'docs/adr/0001-first.md': '# 第一個\n\n正文。\n',
            'docs/adr/0002-second-one.md': '# 第二個\n\n正文。\n',
            'apps/web/docs/adr/0001-web.md': '# web 的\n\n正文。\n',
        }), [])

    def test_no_dirs_pass(self) -> None:
        self.assertEqual(self.run_check({'README.md': '# x\n'}), [])

    def test_bad_name_fails(self) -> None:
        errors = self.run_check({'docs/adr/1-first.md': '# x\n\ny\n'})
        self.assertEqual(len(errors), 1)
        self.assertIn('檔名', errors[0])

    def test_gap_fails(self) -> None:
        errors = self.run_check({
            'docs/adr/0001-a.md': '# a\n\nb\n',
            'docs/adr/0003-c.md': '# c\n\nd\n',
        })
        self.assertEqual(len(errors), 1)
        self.assertIn('缺 0002', errors[0])

    def test_duplicate_fails(self) -> None:
        errors = self.run_check({
            'docs/adr/0001-a.md': '# a\n\nb\n',
            'docs/adr/0001-b.md': '# b\n\nc\n',
        })
        self.assertTrue(any('重複' in e for e in errors))

    def test_title_and_body_required(self) -> None:
        self.assertEqual(len(self.run_check({'docs/adr/0001-a.md': '沒有標題\n'})), 1)
        self.assertEqual(len(self.run_check({'docs/adr/0001-a.md': '# 只有標題\n\n'})), 1)

    def test_package_adr_fails(self) -> None:
        errors = self.run_check({'packages/nexus-core/docs/adr/0001-a.md': '# a\n\nb\n'})
        self.assertEqual(len(errors), 1)
        self.assertIn('套件不放 ADR', errors[0])


if __name__ == '__main__':
    unittest.main()
