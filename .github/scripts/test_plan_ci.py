from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import plan_ci
from project_paths import actual, canonical, unknown_source

NAMES = {
    'packages/nexus-core': '@nexus/core',
    'packages/nexus-wire': '@nexus/wire',
    'apps/harness': '@nexus/harness',
    'apps/web': '@nexus/web',
}
DIRS_MOVED = {
    'packages/nexus-core': 'harness/packages/nexus-core',
    'packages/nexus-wire': 'harness/packages/nexus-wire',
    'apps/harness': 'harness/apps/harness',
    'apps/web': 'web',
}

PAIRS = [
    ('packages/nexus-core/src/a.ts', 'harness/packages/nexus-core/src/a.ts'),
    ('apps/harness/src/sandbox-protocol.ts', 'harness/apps/harness/src/sandbox-protocol.ts'),
    ('apps/harness/src/snapshot/scenarios/a.json', 'harness/apps/harness/src/snapshot/scenarios/a.json'),
    ('apps/web/src/App.tsx', 'web/src/App.tsx'),
    ('apps/web/src/styles/theme.css', 'web/src/styles/theme.css'),
    ('apps/web/index.html', 'web/index.html'),
    ('native/sandbox-spawner/src/main.rs', 'harness/native/sandbox-spawner/src/main.rs'),
    ('vendor/cordis/src/a.ts', 'harness/vendor/cordis/src/a.ts'),
    ('scripts/release/pack.ts', 'harness/scripts/release/pack.ts'),
]


class CanonicalTest(unittest.TestCase):
    def test_new_paths_map_back_to_the_old_ones(self) -> None:
        for old, new in PAIRS:
            self.assertEqual(canonical(new), old)
            self.assertEqual(canonical(old), old)

    def test_actual_prefers_what_is_on_disk(self) -> None:
        for old, new in PAIRS:
            self.assertEqual(actual(old, lambda p, hit=new: p == hit), new)
            self.assertEqual(actual(old, lambda p, hit=old: p == hit), old)
            self.assertEqual(actual(old, lambda p: False), old)

    def test_unrecognized_source_paths(self) -> None:
        self.assertTrue(unknown_source('nexus/harness/src/a.ts'))
        self.assertTrue(unknown_source('harness/other/src/a.ts'))
        self.assertTrue(unknown_source('somewhere/a.rs'))
        self.assertFalse(unknown_source('eslint.config.js'))
        self.assertFalse(unknown_source('.github/scripts/a.py'))
        self.assertFalse(unknown_source('harness/packages/nexus-core/src/a.ts'))
        self.assertFalse(unknown_source('web/src/a.tsx'))
        self.assertFalse(unknown_source('docs/a.md'))


class PlanShapesTest(unittest.TestCase):
    def plan(self, changed: list[str], event: str = 'pull_request', base: str = 'develop') -> dict[str, str]:
        return plan_ci.plan(changed, event, base)

    def test_old_and_new_paths_give_the_same_plan(self) -> None:
        for old, new in PAIRS:
            for event, base in (('pull_request', 'develop'), ('pull_request', 'main'), ('push', '')):
                self.assertEqual(self.plan([old], event, base), self.plan([new], event, base), (old, new, event))

    def test_new_shape_still_triggers_each_scan_and_rust_rule(self) -> None:
        self.assertEqual(self.plan(['harness/native/sandbox-spawner/src/main.rs'])['rust'], 'true')
        self.assertEqual(self.plan(['harness/packages/nexus-host-bridge/src/a.ts'])['rust'], 'true')
        self.assertEqual(self.plan(['harness/apps/harness/src/tool-process.ts'])['rust'], 'true')
        self.assertEqual(self.plan(['web/src/a.css'], 'pull_request', 'main')['ts'], 'true')
        self.assertEqual(self.plan(['harness/vendor/cordis/README.md'], 'pull_request', 'main')['ts'], 'true')
        self.assertEqual(self.plan(['docs/a.md'], 'pull_request', 'main')['ts'], 'false')

    def test_unrecognized_source_path_runs_everything(self) -> None:
        for path in ('nexus/harness/src/a.ts', 'harness/elsewhere/a.ts', 'brand-new-dir/a.rs'):
            self.assertEqual(self.plan([path]), {'mode': 'full', 'ts': 'true', 'rust': 'true'}, path)

    def test_known_source_path_in_a_feature_pr_stays_light(self) -> None:
        for path in ('harness/packages/nexus-core/src/a.ts', 'packages/nexus-core/src/a.ts', 'web/src/a.tsx'):
            self.assertEqual(self.plan([path])['mode'], 'light', path)


class LightShapesTest(unittest.TestCase):
    def scope(self, changed: list[str], present: set[str], dirs: dict[str, str] | None) -> dict:
        return plan_ci.light(changed, NAMES, lambda p: p in present, None, dirs)

    def canonical_scope(self, scope: dict) -> dict:
        def fix_dirs(rows: dict[str, list[str]]) -> dict[str, list[str]]:
            return {canonical(d): files for d, files in rows.items()}

        return {
            'typecheck': scope['typecheck'],
            'format': sorted(canonical(p) for p in scope['format']),
            'lint': fix_dirs(scope['lint']),
            'tests': fix_dirs(scope['tests']),
        }

    def test_same_change_gives_an_equivalent_scope(self) -> None:
        old_changed = [
            'packages/nexus-core/src/a.ts',
            'apps/web/src/App.tsx',
            'apps/harness/src/llm-replay.ts',
            'packages/nexus-wire/src/frame.ts',
            'docs/a.md',
        ]
        old_present = set(old_changed) | {
            'packages/nexus-core/src/a.test.ts',
            'apps/web/src/App.test.tsx',
            plan_ci.SNAPSHOT_TEST,
            *plan_ci.WEB_STRUCTURE_GUARDS,
        }
        new_changed = [canonical_to_new(p) for p in old_changed]
        new_present = {canonical_to_new(p) for p in old_present}
        before = self.scope(old_changed, old_present, None)
        after = self.scope(new_changed, new_present, DIRS_MOVED)
        self.assertEqual(self.canonical_scope(before), self.canonical_scope(after))
        self.assertIn('harness/packages/nexus-core', after['lint'])
        self.assertIn('web', after['tests'])
        self.assertTrue(before['tests'] and before['lint'])

    def test_typecheck_all_filters_match_both_shapes(self) -> None:
        with tempfile.TemporaryDirectory() as out:
            plan_ci.write_light({'typecheck': 'all', 'format': [], 'lint': {}, 'tests': {}}, Path(out))
            args = (Path(out) / 'typecheck.txt').read_text(encoding='utf-8').split()
        self.assertEqual(args, ['--filter=./**/packages/*', '--filter=./**/apps/*'])


class ProjectDirsTest(unittest.TestCase):
    def make(self, root: Path, dirs: list[str]) -> None:
        for d in dirs:
            (root / d).mkdir(parents=True, exist_ok=True)
            name = '@nexus/' + d.rsplit('/', 1)[-1]
            (root / d / 'package.json').write_text('{"name": "%s"}' % name, encoding='utf-8')

    def test_both_shapes_give_the_same_names(self) -> None:
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            self.make(Path(a), ['packages/x', 'apps/harness', 'apps/web'])
            self.make(Path(b), ['harness/packages/x', 'harness/apps/harness', 'web'])
            self.assertEqual(plan_ci.project_names(Path(a)), {'apps/harness': '@nexus/harness', 'apps/web': '@nexus/web', 'packages/x': '@nexus/x'})
            self.assertEqual(plan_ci.project_names(Path(a)).keys(), plan_ci.project_names(Path(b)).keys())
            self.assertEqual(plan_ci.project_dirs(Path(b))['apps/web'], 'web')
            self.assertEqual(plan_ci.project_dirs(Path(b))['packages/x'], 'harness/packages/x')


def canonical_to_new(path: str) -> str:
    head, _, rest = path.partition('/')
    if path.startswith('apps/web/'):
        return 'web/' + path[len('apps/web/'):]
    if head in ('apps', 'packages', 'native', 'vendor', 'scripts'):
        return 'harness/' + path
    return path


if __name__ == '__main__':
    unittest.main()
