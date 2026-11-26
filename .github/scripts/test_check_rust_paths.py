from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

import check_rust_paths as mod

ROOT = mod.ROOT
CURRENT_CRATE = 'harness/native/sandbox-spawner'
STALE_CRATE = 'native/sandbox-spawner'
CURRENT_HARNESS = 'harness/apps/harness'
STALE_HARNESS = 'apps/harness'


class Tree:
    def __init__(self, test: unittest.TestCase, crate: str = CURRENT_CRATE, harness: str = CURRENT_HARNESS) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        test.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for rel in (mod.ACTION, mod.CI, mod.POST_MERGE):
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / rel, self.root / rel)
        (self.root / crate).mkdir(parents=True)
        (self.root / crate / 'Cargo.toml').write_text('[package]\n', encoding='utf-8')
        (self.root / harness).mkdir(parents=True)
        (self.root / harness / 'package.json').write_text('{"name": "@nexus/harness"}', encoding='utf-8')

    def edit(self, rel: str, old: str, new: str, count: int = -1) -> None:
        path = self.root / rel
        text = path.read_text(encoding='utf-8')
        assert old in text, (rel, old)
        path.write_text(text.replace(old, new, count), encoding='utf-8')

    def move(self, rel: str, old: str, new: str) -> None:
        self.edit(rel, old, new)


def stale_tree(test: unittest.TestCase) -> Tree:
    tree = Tree(test, STALE_CRATE, STALE_HARNESS)
    for rel in (mod.ACTION, mod.CI):
        tree.move(rel, CURRENT_CRATE, STALE_CRATE)
    for rel in (mod.CI, mod.POST_MERGE):
        tree.move(rel, f'cp {CURRENT_HARNESS}/', f'cp {STALE_HARNESS}/')
    return tree


class RealRepoTest(unittest.TestCase):
    def test_this_repo_passes(self) -> None:
        self.assertEqual(mod.check(ROOT), [])

    def test_the_crate_is_read_from_the_action(self) -> None:
        crate, errors = mod.check_action(ROOT)
        self.assertEqual(errors, [])
        self.assertTrue((ROOT / str(crate) / 'Cargo.toml').is_file())


class BothShapesTest(unittest.TestCase):
    def test_current_shape_is_green(self) -> None:
        self.assertEqual(mod.check(Tree(self).root), [])

    def test_both_sides_in_the_stale_shape_together_is_green(self) -> None:
        self.assertEqual(mod.check(stale_tree(self).root), [])


class MutationTest(unittest.TestCase):
    def test_changing_only_the_cargo_working_directory_is_red(self) -> None:
        tree = Tree(self, STALE_CRATE)
        tree.edit(mod.ACTION, f'working-directory: {CURRENT_CRATE}\n', f'working-directory: {STALE_CRATE}\n')
        errors = mod.check(tree.root)
        self.assertTrue(any('快取的路徑' in e or '打包執行檔' in e for e in errors), errors)

    def test_changing_only_the_ci_cargo_working_directory_is_red(self) -> None:
        tree = Tree(self, STALE_CRATE)
        tree.edit(mod.CI, f'working-directory: {CURRENT_CRATE}\n', f'working-directory: {STALE_CRATE}\n')
        errors = mod.check(tree.root)
        self.assertTrue(any('cargo 步驟' in e for e in errors), errors)

    def test_changing_only_the_binary_paths_is_red(self) -> None:
        tree = Tree(self)
        tree.edit(mod.CI, f'github.workspace }}}}/{CURRENT_CRATE}/target', f'github.workspace }}}}/{STALE_CRATE}/target')
        errors = mod.check(tree.root)
        self.assertTrue(any('的路徑落在' in e for e in errors), errors)

    def test_changing_only_the_cache_paths_is_red(self) -> None:
        tree = Tree(self)
        tree.edit(mod.ACTION, f'          {CURRENT_CRATE}/target\n', f'          {STALE_CRATE}/target\n')
        errors = mod.check(tree.root)
        self.assertTrue(any('快取的路徑' in e for e in errors), errors)

    def test_changing_only_the_hash_files_is_red(self) -> None:
        tree = Tree(self)
        tree.edit(mod.ACTION, f"'{CURRENT_CRATE}/Cargo.lock'", f"'{STALE_CRATE}/Cargo.lock'")
        self.assertTrue(any('快取鍵讀的是' in e for e in mod.check(tree.root)))

    def test_changing_only_the_packaging_directory_is_red(self) -> None:
        tree = Tree(self)
        tree.edit(mod.ACTION, f'working-directory: {CURRENT_CRATE}/target', f'working-directory: {STALE_CRATE}/target')
        self.assertTrue(any('打包執行檔' in e for e in mod.check(tree.root)))

    def test_a_crate_that_is_not_on_disk_is_red(self) -> None:
        tree = stale_tree(self)
        shutil.rmtree(tree.root / STALE_CRATE)
        self.assertTrue(any('Cargo.toml' in e for e in mod.check(tree.root)))

    def test_vitest_result_path_must_follow_the_harness_package(self) -> None:
        tree = Tree(self, harness=STALE_HARNESS)
        errors = mod.check(tree.root)
        self.assertEqual(len([e for e in errors if 'vitest' in e]), 2, errors)

    def test_harness_package_missing_is_red(self) -> None:
        tree = Tree(self)
        shutil.rmtree(tree.root / CURRENT_HARNESS)
        self.assertTrue(any('@nexus/harness' in e for e in mod.check(tree.root)))

    def test_nothing_to_check_is_red(self) -> None:
        tree = Tree(self)
        tree.edit(mod.CI, '${{ github.workspace }}/', '${{ runner.temp }}/')
        tree.edit(mod.POST_MERGE, '/node_modules/.vite/vitest/*/results.json', '/results.json')
        errors = mod.check(tree.root)
        self.assertTrue(any('NEXUS_*_BIN' in e for e in errors), errors)
        self.assertTrue(any('耗時紀錄' in e for e in errors), errors)

    def test_integration_step_that_runs_nothing_is_red(self) -> None:
        tree = Tree(self)
        tree.edit(mod.CI, r"failed \| )?[1-9][0-9]* passed", r"failed \| )?[0-9]* ok", 1)
        self.assertTrue(any('通過條數' in e and 'sandbox-spawner「' in e for e in mod.check(tree.root)))

    def test_integration_step_without_the_count_is_red_in_both_jobs(self) -> None:
        tree = Tree(self)
        tree.edit(mod.CI, '          grep -Eq \'Tests', '          true \'Tests')
        errors = [e for e in mod.check(tree.root) if '整合測試' in e]
        self.assertEqual(len(errors), 2, errors)

    def test_integration_step_without_pipefail_is_red(self) -> None:
        tree = Tree(self)
        tree.edit(mod.CI, '        shell: bash\n        run: |\n          pnpm --filter @nexus/harness --fail-if-no-match exec vitest run src/sandbox', '        run: |\n          pnpm --filter @nexus/harness --fail-if-no-match exec vitest run src/sandbox', 1)
        self.assertTrue(any('pipefail' in e for e in mod.check(tree.root)))

    def test_missing_integration_step_is_red(self) -> None:
        tree = Tree(self)
        tree.edit(mod.CI, '- name: 真的 spawner 跑整合測試', '- name: 別的名字')
        self.assertTrue(any('找不到這一步' in e for e in mod.check(tree.root)))

    def test_an_empty_action_is_red(self) -> None:
        tree = Tree(self)
        (tree.root / mod.ACTION).write_text('name: x\n', encoding='utf-8')
        self.assertTrue(any('cargo 步驟' in e for e in mod.check(tree.root)))


if __name__ == '__main__':
    unittest.main()
