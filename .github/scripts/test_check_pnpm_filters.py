from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from check_pnpm_filters import FLAG, ROOT, TYPECHECK_SCRIPT, check, logical_lines, tracked, violations

CI = '.github/workflows/ci.yml'


def build(files: dict[str, str]) -> tuple[Path, list[str]]:
    root = Path(tempfile.mkdtemp())
    for path, text in files.items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(text, encoding='utf-8')
    return root, list(files)


class ViolationsTest(unittest.TestCase):
    def test_filter_without_the_flag_is_reported(self) -> None:
        self.assertEqual(len(violations(CI, 'run: pnpm --filter @nexus/web run build\n')), 1)
        self.assertEqual(len(violations(CI, "run: pnpm '--filter=./**/packages/*' run test\n")), 1)
        self.assertEqual(len(violations(CI, 'run: pnpm -F @nexus/web run build\n')), 1)

    def test_filter_with_the_flag_passes(self) -> None:
        self.assertEqual(violations(CI, f'run: pnpm --filter @nexus/web {FLAG} run build\n'), [])

    def test_the_flag_may_sit_on_a_continuation_line(self) -> None:
        text = f'run: |\n  pnpm --filter @nexus/web \\\n    {FLAG} run build\n'
        self.assertEqual(violations(CI, text), [])
        self.assertEqual(logical_lines('a \\\nb\nc')[0][0], 1)

    def test_calling_typecheck_script_needs_no_flag(self) -> None:
        self.assertEqual(violations(CI, "run: .github/scripts/typecheck.sh '--filter=./**/apps/*'\n"), [])

    def test_package_json_scripts_are_read(self) -> None:
        bad = json.dumps({'scripts': {'dev': 'pnpm --filter @nexus/web run dev'}})
        good = json.dumps({'scripts': {'dev': f'pnpm --filter @nexus/web {FLAG} run dev'}})
        self.assertEqual(len(violations('package.json', bad)), 1)
        self.assertEqual(violations('package.json', good), [])


class CheckTest(unittest.TestCase):
    def test_scanning_nothing_is_red(self) -> None:
        root, _ = build({TYPECHECK_SCRIPT: f'pnpm "$@" {FLAG}\n'})
        count, errors = check(root, ['README.md'])
        self.assertEqual(count, 0)
        self.assertTrue(any('0 份 workflow' in e for e in errors))

    def test_typecheck_script_must_carry_the_flag(self) -> None:
        root, paths = build({TYPECHECK_SCRIPT: 'pnpm "$@" exec pwd\n', CI: 'run: echo ok\n'})
        _, errors = check(root, paths)
        self.assertTrue(any(TYPECHECK_SCRIPT in e for e in errors))

    def test_clean_tree_passes(self) -> None:
        root, paths = build({TYPECHECK_SCRIPT: f'pnpm "$@" {FLAG}\n', CI: f'run: pnpm --filter @nexus/web {FLAG} run build\n'})
        self.assertEqual(check(root, paths), (1, []))

    def test_this_repo_passes(self) -> None:
        count, errors = check(ROOT)
        self.assertEqual(errors, [])
        self.assertGreater(count, 5)
        self.assertTrue(any(p.startswith('.github/workflows/') for p in tracked(ROOT)))


if __name__ == '__main__':
    unittest.main()
