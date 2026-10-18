"""node_compat.py 的單元測試（#1546）：清單解析與「每一檔都真的跑了」的核對。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from node_compat import ROOT, check_report, group_by_app, read_list

A = 'apps/harness/src/a.test.ts'
B = 'apps/harness/src/b.test.ts'


def report(files: dict[str, int], success: bool = True) -> dict:
    """照 vitest JSON 報告的形狀造一份：name 是絕對路徑。"""
    return {
        'success': success,
        'numTotalTests': sum(files.values()),
        'testResults': [
            {'name': str(ROOT / f), 'assertionResults': [{}] * count} for f, count in files.items()
        ],
    }


class ReadList(unittest.TestCase):
    def test_drops_comments_and_blank_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'list.txt'
            path.write_text(f'# 檔頭\n\n{A}   # 註解\n{B}\n', encoding='utf-8')
            self.assertEqual(read_list(path), [A, B])

    def test_groups_by_app(self) -> None:
        web = 'apps/web/src/x.test.tsx'
        self.assertEqual(group_by_app([A, web, B]), {'apps/harness': [A, B], 'apps/web': [web]})
        with self.assertRaises(ValueError):
            group_by_app(['packages/x/src/y.test.ts'])


class CheckReport(unittest.TestCase):
    def test_all_ran(self) -> None:
        self.assertEqual(check_report(report({A: 2, B: 1}), [A, B]), [])

    def test_listed_file_not_run(self) -> None:
        # vitest 的位置參數是子字串過濾：寫錯的那一檔不會讓它失敗，只會少跑。
        self.assertTrue(check_report(report({A: 2}), [A, B]))

    def test_unlisted_file_run(self) -> None:
        self.assertTrue(check_report(report({A: 2, B: 1}), [A]))

    def test_file_without_tests(self) -> None:
        self.assertTrue(check_report(report({A: 2, B: 0}), [A, B]))

    def test_zero_tests(self) -> None:
        self.assertTrue(check_report(report({}), []))

    def test_failed(self) -> None:
        self.assertTrue(check_report(report({A: 2}, success=False), [A]))


if __name__ == '__main__':
    unittest.main()
