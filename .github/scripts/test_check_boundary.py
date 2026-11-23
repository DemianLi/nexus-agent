from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import check_boundary
from check_boundary import check, empty_scans, main, string_literals


def tree(root: Path, files: dict[str, str]) -> None:
    for path, text in files.items():
        p = root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding='utf-8')


def run(files: dict[str, str], exemptions: tuple = ()) -> list[str]:
    original = check_boundary.EXEMPTIONS
    check_boundary.EXEMPTIONS = exemptions
    try:
        with tempfile.TemporaryDirectory() as d:
            tree(Path(d), files)
            return check(Path(d))
    finally:
        check_boundary.EXEMPTIONS = original


class EmptyScanTest(unittest.TestCase):
    def scans(self, files: dict[str, str]) -> list[str]:
        with tempfile.TemporaryDirectory() as d:
            tree(Path(d), files)
            return empty_scans(Path(d))

    def test_both_directories_with_code_pass(self) -> None:
        self.assertEqual(self.scans({'apps/web/src/a.ts': '', 'apps/harness/src/a.ts': ''}), [])

    def test_a_moved_directory_is_red_instead_of_unscanned(self) -> None:
        errors = self.scans({'web/src/a.ts': '', 'harness/apps/harness/src/a.ts': ''})
        self.assertEqual(len(errors), 2)

    def test_one_empty_side_is_red(self) -> None:
        errors = self.scans({'apps/web/src/a.ts': ''})
        self.assertEqual(len(errors), 1)
        self.assertIn('apps/harness', errors[0])

    def test_this_repo_scans_something_on_both_sides(self) -> None:
        self.assertEqual(empty_scans(check_boundary.ROOT), [])


class StringLiteralsTest(unittest.TestCase):
    def values(self, text: str) -> list[str]:
        return [lit.value for lit in string_literals(text)]

    def test_skips_comments(self) -> None:
        self.assertEqual(self.values("// 'a'\n/* 'b' */ const x = 'c';"), ['c'])

    def test_reads_escapes_and_templates(self) -> None:
        self.assertEqual(self.values(r"const x = 'it\'s'; const y = `a${'b'}c`;"), ["it's", 'a', 'b', 'c'])

    def test_regex_is_not_a_string(self) -> None:
        self.assertEqual(self.values("const r = /['\"]x/; const s = 'y';"), ['y'])

    def test_counts_lines(self) -> None:
        lits = string_literals("a\n/* x\n y */\nconst s = 'z';")
        self.assertEqual([lit.line for lit in lits], [4])


class WebTest(unittest.TestCase):
    def test_clean_web_passes(self) -> None:
        self.assertEqual(
            run({'apps/web/src/a.ts': "import { x } from '@nexus/wire';\nimport y from './b';\n"}),
            [],
        )

    def test_import_of_core_fails(self) -> None:
        errors = run({'apps/web/src/a.ts': "import { x } from '@nexus/core';\n"})
        self.assertEqual(len(errors), 1)
        self.assertIn('apps/web/src/a.ts:1', errors[0])
        self.assertIn('@nexus/core', errors[0])

    def test_every_import_shape_fails(self) -> None:
        for line in (
            "import type { T } from '@nexus/plugin-commands';",
            "export * from '@nexus/core/src/todo.ts';",
            "const m = await import('@nexus/core');",
            "const m = require('@nexus/core');",
            "vi.mock('@nexus/core', () => ({}));",
            "import '@nexus/core';",
        ):
            with self.subTest(line=line):
                self.assertEqual(len(run({'apps/web/src/a.ts': line + '\n'})), 1)

    def test_wire_subpath_is_fine(self) -> None:
        self.assertEqual(run({'apps/web/src/a.ts': "import { x } from '@nexus/wire/src/x';\n"}), [])

    def test_name_in_a_fixture_string_is_not_an_import(self) -> None:
        self.assertEqual(run({'apps/web/src/a.ts': "const s = \"declare module '@nexus/core' {}\";\n"}), [])

    def test_relative_path_into_harness_source_fails(self) -> None:
        errors = run({'apps/web/src/features/a.test.ts': "const p = '../../../harness/src/x.ts';\n"})
        self.assertEqual(len(errors), 1)
        self.assertIn('apps/harness/src/x.ts', errors[0])

    def test_relative_path_into_other_package_or_docs_fails(self) -> None:
        for path in ('../../../../packages/nexus-core/src/a.ts', '../../../../docs/tool-catalog.md'):
            with self.subTest(path=path):
                self.assertEqual(len(run({'apps/web/src/features/a.test.ts': f"new URL('{path}', import.meta.url);\n"})), 1)

    def test_relative_path_into_wire_and_own_files_is_fine(self) -> None:
        self.assertEqual(
            run({'apps/web/src/features/a.ts': "const a = '../../../../packages/nexus-wire/src/x.ts'; const b = '../b';\n"}),
            [],
        )

    def test_joined_segments_fail(self) -> None:
        self.assertEqual(len(run({'apps/web/e2e/s.ts': "const s = join(ROOT, 'apps', 'harness', 'src', 's.ts');\n"})), 1)
        self.assertEqual(len(run({'apps/web/e2e/s.ts': "const s = join(ROOT, 'packages', 'nexus-core');\n"})), 1)
        self.assertEqual(run({'apps/web/e2e/s.ts': "const s = join(ROOT, 'packages', 'nexus-wire');\n"}), [])

    def test_manifest_dependency_fails(self) -> None:
        manifest = json.dumps({'devDependencies': {'@nexus/wire': 'workspace:*', '@nexus/core': 'workspace:*'}})
        errors = run({'apps/web/package.json': manifest})
        self.assertEqual(len(errors), 1)
        self.assertIn('@nexus/core', errors[0])

    def test_comments_are_not_checked(self) -> None:
        self.assertEqual(run({'apps/web/src/a.ts': "// import { x } from '@nexus/core';\n/* '../../../harness/x' */\n"}), [])


class HarnessTest(unittest.TestCase):
    def test_clean_harness_passes(self) -> None:
        self.assertEqual(run({'apps/harness/src/a.ts': "import { x } from '@nexus/wire';\n"}), [])

    def test_scanning_web_source_fails(self) -> None:
        for line in (
            "const roots = ['apps/harness/src', 'apps/web/src'];",
            "const p = join(root, 'apps', 'web', 'src');",
            "const p = '../../web/src';",
        ):
            with self.subTest(line=line):
                self.assertEqual(len(run({'apps/harness/src/a.test.ts': line + '\n'})), 1)

    def test_import_of_web_fails(self) -> None:
        self.assertEqual(len(run({'apps/harness/src/a.ts': "import x from '@nexus/web/src/x';\n"})), 1)
        self.assertEqual(len(run({'apps/harness/src/a.ts': "require.resolve('@nexus/web/package.json');\n"})), 1)

    def test_manifest_dependency_on_web_fails(self) -> None:
        self.assertEqual(len(run({'apps/harness/package.json': json.dumps({'dependencies': {'@nexus/web': 'workspace:*'}})})), 1)

    def test_comments_are_not_checked(self) -> None:
        self.assertEqual(run({'apps/harness/src/a.ts': "/** 掃 `apps/web/src` */\n// '../web'\n"}), [])

    def test_scanning_the_whole_apps_layer_fails(self) -> None:
        for line in (
            "for (const group of ['packages', 'apps']) { readdirSync(join(root, group)); }",
            "walk(join(root, 'apps'), files);",
            "const files = glob('apps/*/src/**/*.ts');",
            "const dir = join(ROOT, 'apps', name);",
        ):
            with self.subTest(line=line):
                self.assertEqual(len(run({'apps/harness/src/a.ts': line + '\n'})), 1)

    def test_apps_followed_by_own_directory_is_fine(self) -> None:
        self.assertEqual(run({'apps/harness/src/a.ts': "const d = join(repo, 'apps', 'harness', 'src');\n"}), [])

    def test_base_event_table_scan_is_caught(self) -> None:
        base = (
            "function productFiles(root: string): string[] {\n"
            "  const files: string[] = [];\n"
            "  for (const group of ['packages', 'apps']) {\n"
            "    for (const pkg of readdirSync(join(root, group), { withFileTypes: true })) {\n"
            "      walk(join(root, group, pkg.name, 'src'), files);\n"
            "    }\n"
            "  }\n"
            "  return files;\n"
            "}\n"
        )
        errors = run({'apps/harness/src/event-table-scan.ts': base})
        self.assertEqual(len(errors), 1)
        self.assertIn('event-table-scan.ts:3', errors[0])
        self.assertIn('整層 `apps`', errors[0])

    def test_web_scanning_the_whole_apps_layer_fails(self) -> None:
        self.assertEqual(len(run({'apps/web/src/a.test.ts': "readdirSync(join(root, 'apps'));\n"})), 1)


class ExemptionTest(unittest.TestCase):
    ITEM = check_boundary.Exemption('apps/web/e2e/*', 'web-path', '測試要對著真 harness 跑')

    def test_exemption_covers_its_rule_only(self) -> None:
        files = {'apps/web/e2e/s.ts': "const s = join(ROOT, 'apps', 'harness');\nimport x from '@nexus/core';\n"}
        errors = run(files, (self.ITEM,))
        self.assertEqual(len(errors), 1)
        self.assertIn('@nexus/core', errors[0])

    def test_exemption_without_a_hit_fails(self) -> None:
        errors = run({'apps/web/e2e/s.ts': 'const x = 1;\n'}, (self.ITEM,))
        self.assertEqual(len(errors), 1)
        self.assertIn('沒有任何命中', errors[0])

    def test_every_exemption_has_a_reason(self) -> None:
        for item in check_boundary.EXEMPTIONS:
            self.assertGreater(len(item.reason.strip()), 10, item.path)


class RepositoryTest(unittest.TestCase):
    def test_real_tree_passes(self) -> None:
        out = io.StringIO()
        with redirect_stdout(out):
            code = main([])
        self.assertEqual(code, 0, out.getvalue())


if __name__ == '__main__':
    unittest.main()
