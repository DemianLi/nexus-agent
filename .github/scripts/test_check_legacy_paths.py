from __future__ import annotations

import unittest

from check_legacy_paths import violations


class AgentFilesTest(unittest.TestCase):
    def test_every_agent_name_is_reported_at_any_depth(self) -> None:
        for path in (
            'AGENTS.md',
            'CLAUDE.md',
            'CLAUDE.local.md',
            'web/CLAUDE.md',
            'harness/apps/harness/AGENTS.md',
            '.agents/skills/a/SKILL.md',
            '.claude/settings.json',
            'harness/packages/nexus-core/.claude/x.json',
        ):
            with self.subTest(path=path):
                self.assertEqual(len(violations([path])), 1)

    def test_fixtures_are_exempt(self) -> None:
        for path in (
            'harness/apps/harness/src/fixtures/AGENTS.md',
            'harness/packages/nexus-plugin-agent-instructions/src/fixtures/x/CLAUDE.md',
            'web/src/fixtures/.claude/settings.json',
        ):
            with self.subTest(path=path):
                self.assertEqual(violations([path]), [])

    def test_names_that_only_contain_an_agent_name_pass(self) -> None:
        for path in (
            'harness/apps/harness/src/agent-instructions.test.ts',
            'harness/apps/harness/src/fixtures/request-baseline/log-derived-history.agents.test.ts/a.json',
            'docs/agents-overview.md',
            'web/CLAUDE.md.bak',
        ):
            with self.subTest(path=path):
                self.assertEqual(violations([path]), [])


class LegacyRootsTest(unittest.TestCase):
    def test_every_legacy_root_is_reported(self) -> None:
        for path in (
            'apps/web/src/a.ts',
            'apps/harness/src/a.ts',
            'packages/nexus-core/src/a.ts',
            'native/sandbox-spawner/src/a.rs',
            'vendor/cordis/src/a.ts',
            'scripts/release/a.ts',
        ):
            with self.subTest(path=path):
                self.assertEqual(len(violations([path])), 1)

    def test_the_new_layout_and_unrelated_roots_pass(self) -> None:
        for path in (
            'harness/apps/harness/src/a.ts',
            'harness/packages/nexus-core/src/a.ts',
            'harness/native/sandbox-spawner/src/a.rs',
            'harness/vendor/cordis/src/a.ts',
            'harness/scripts/release/a.ts',
            'web/scripts/check-built-css.mjs',
            'web/src/vendor/solid-glass/README.md',
            'docs/release.md',
            '.github/scripts/check_legacy_paths.py',
            'package.json',
        ):
            with self.subTest(path=path):
                self.assertEqual(violations([path]), [])

    def test_a_legacy_root_name_as_a_file_at_the_top_is_not_a_directory(self) -> None:
        self.assertEqual(violations(['scripts']), [])

    def test_both_kinds_in_one_path_are_reported_once_each(self) -> None:
        self.assertEqual(len(violations(['apps/web/CLAUDE.md'])), 2)


if __name__ == '__main__':
    unittest.main()
