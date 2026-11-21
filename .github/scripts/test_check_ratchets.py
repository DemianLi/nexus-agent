"""check_ratchets.py 與 check_adrs.py 的單元測試：算哪些行、怎麼比基準、ADR 的格式。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from check_adrs import check
from check_ratchets import compare, directory, measure


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
