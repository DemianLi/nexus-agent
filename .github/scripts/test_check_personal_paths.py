from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import check_pr
from check_personal_paths import file_violations, main, text_violations

REAL = {
    'users': '/Users/' + 'alice/Projects/x',
    'home': '/home/' + 'bob/.config',
    'claude scratch': '/private/tmp/claude-' + '501/proj/scratchpad',
    'var folders': '/var/folders/' + 'zz/abcdefghijklmnopqrstuvwxyz012345/T/x',
}


class TextTest(unittest.TestCase):
    def test_each_kind_of_path_is_reported(self) -> None:
        for kind, path in REAL.items():
            with self.subTest(kind=kind):
                self.assertEqual(len(text_violations(f'看 {path} 這裡', 'f.md')), 1)

    def test_placeholder_names_pass(self) -> None:
        for path in (
            '/Users/someone/secret/path.ts',
            '/Users/x/Projects',
            '/home/you/.nexus-agent/a',
            '/home/FAKE/.credentials.yaml',
            '/home/u/.nexus',
            '/Users/<名字>/專案',
            '/home/$USER/a',
            '/var/folders/ab/cd1234/T/nexus-lh-xyz',
            '/var/folders/…',
            'darwin-arm64 linux-x64',
        ):
            with self.subTest(path=path):
                self.assertEqual(text_violations(path, 'f.md'), [])

    def test_report_has_file_and_line(self) -> None:
        self.assertIn('f.md:2：', text_violations('ok\n' + REAL['users'], 'f.md')[0])


class FilesTest(unittest.TestCase):
    def test_scans_text_and_skips_binary_lockfiles_and_self(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'a.md').write_text(REAL['home'])
            (root / 'b.bin').write_bytes(b'\0' + REAL['home'].encode())
            (root / 'pnpm-lock.yaml').write_text(REAL['home'])
            (root / 'ok.md').write_text('/Users/x/a')
            names = ['a.md', 'b.bin', 'pnpm-lock.yaml', 'ok.md']
            self.assertEqual(len(file_violations(root, names)), 1)
            self.assertEqual(main(['--root', str(root), '--files', 'ok.md']), 0)
            self.assertEqual(main(['--root', str(root), '--files', 'a.md']), 1)


class PrBodyTest(unittest.TestCase):
    def setUp(self) -> None:
        check_pr.errors.clear()

    def tearDown(self) -> None:
        check_pr.errors.clear()

    def test_body_with_personal_path_fails(self) -> None:
        check_pr.check_personal_paths(f'Refs #1\n在 {REAL["users"]} 跑過')
        self.assertEqual(len(check_pr.errors), 1)

    def test_body_with_placeholder_passes(self) -> None:
        check_pr.check_personal_paths('Refs #1\n在 /Users/<名字>/x 與 <外層>/nexus 跑過')
        self.assertEqual(check_pr.errors, [])


if __name__ == '__main__':
    unittest.main()
