from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from check_adrs import adr_dirs, check, floor_errors, main

GOOD = '# 標題\n\n正文。\n'
BAD = '沒有標題\n'


class Tree(unittest.TestCase):
    def build(self, files: dict[str, str]) -> Path:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        for rel, text in files.items():
            (Path(tmp) / rel).parent.mkdir(parents=True, exist_ok=True)
            (Path(tmp) / rel).write_text(text, encoding='utf-8')
        return Path(tmp)


class Layouts(Tree):
    def test_a_broken_adr_is_red_in_both_layouts(self) -> None:
        for harness, web in (('apps/harness', 'apps/web'), ('harness/apps/harness', 'web')):
            for where in (f'{harness}/docs/adr', f'{web}/docs/adr'):
                root = self.build({'docs/adr/0001-a.md': GOOD, f'{where}/0001-a.md': BAD})
                errors = check(root)
                self.assertEqual(len(errors), 1, (where, errors))
                self.assertIn(where, errors[0])

    def test_a_good_adr_in_each_place_passes_and_is_counted(self) -> None:
        for harness, web in (('apps/harness', 'apps/web'), ('harness/apps/harness', 'web')):
            root = self.build({'docs/adr/0001-a.md': GOOD, f'{harness}/docs/adr/0001-a.md': GOOD, f'{web}/docs/adr/0001-a.md': GOOD})
            self.assertEqual(check(root), [])
            self.assertEqual(len(adr_dirs(root)), 3)

    def test_adr_inside_a_package_is_red_in_both_layouts(self) -> None:
        for where in ('packages/nexus-core', 'harness/packages/nexus-core'):
            root = self.build({'docs/adr/0001-a.md': GOOD, f'{where}/docs/adr/0001-a.md': GOOD})
            errors = check(root)
            self.assertEqual(len(errors), 1, where)
            self.assertIn('套件不放 ADR', errors[0])

    def test_app_adr_dirs_may_be_absent(self) -> None:
        root = self.build({'docs/adr/0001-a.md': GOOD})
        self.assertEqual(check(root), [])
        self.assertEqual(floor_errors(root), [])


class Floor(Tree):
    def test_project_adr_dir_with_zero_files_is_red(self) -> None:
        self.assertEqual(len(floor_errors(self.build({'README.md': ''}))), 1)
        empty = self.build({'docs/adr/.keep': ''})
        (empty / 'docs/adr/.keep').unlink()
        self.assertEqual(len(floor_errors(empty)), 1)

    def test_moved_project_adr_dir_is_red_even_when_the_app_dirs_have_files(self) -> None:
        root = self.build({'harness/apps/harness/docs/adr/0001-a.md': GOOD, 'web/docs/adr/0001-a.md': GOOD})
        self.assertEqual(len(floor_errors(root)), 1)


class CommandLine(Tree):
    def test_root_and_files(self) -> None:
        root = self.build({'docs/adr/0001-a.md': GOOD, 'web/docs/adr/0001-a.md': BAD})
        self.assertEqual(main(['--root', str(root)]), 1)
        self.assertEqual(main(['--root', str(root), '--files', 'docs/adr/0001-a.md']), 0)
        self.assertEqual(main(['--root', str(root), '--files', 'web/docs/adr/0001-a.md']), 1)

    def test_outer_root_without_project_adrs_is_checked_by_files_only(self) -> None:
        root = self.build({'docs/adr/0001-a.md': GOOD})
        self.assertEqual(main(['--root', str(root), '--files', 'docs/adr/0001-a.md']), 0)


if __name__ == '__main__':
    unittest.main()
