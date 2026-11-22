from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

import check_dsh_cleanup as mod
from check_dsh_cleanup import analyze, core_of, names, norm, scan, terms_of, units, verify

W = 'd' + 'sh'


def d(text: str) -> str:
    return text.replace('@@', W)


TS_BASE = d("""\
/**
 * 登記身分。
 *
 * ## 偏離登記
 *
 * 跟 @@ 的對照：@@ 把這一段放在 loop 裡。我們放在插件裡。
 */
export const a = 'x'; // 一句行尾註解
export function f(): number {
  return 1;
}
""")

TS_HEAD = """\
/**
 * 登記身分。
 *
 * ## 偏離登記
 *
 * 我們放在插件裡。
 */
export const a = 'y'; // 一句行尾註解
export function f(): number {
  return 1;
}
"""

CLEAN = TS_BASE.replace(d('跟 @@ 的對照：@@ 把這一段放在 loop 裡。'), '')


def run(root: Path, *args: str) -> str:
    return subprocess.run(['git', *args], cwd=root, capture_output=True, text=True, check=True).stdout


class Repo:
    def __init__(self, test: unittest.TestCase) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        test.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        run(self.root, 'init', '-q', '-b', 'main')
        run(self.root, 'config', 'user.email', 't@example.com')
        run(self.root, 'config', 'user.name', 't')
        self._patch = unittest.mock.patch.object(mod, 'ROOT', self.root)
        self._patch.start()
        test.addCleanup(self._patch.stop)

    def commit(self, files: dict[str, str]) -> str:
        for path, text in files.items():
            p = self.root / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding='utf-8')
        run(self.root, 'add', '-A')
        run(self.root, 'commit', '-q', '-m', 'c')
        return run(self.root, 'rev-parse', 'HEAD').strip()


import unittest.mock  # noqa: E402


class ScanTest(unittest.TestCase):
    def test_comment_and_string_edits_do_not_change_code(self) -> None:
        a, _ = scan("const x = 'a'; // 舊\nfoo(`t ${1}`);\n", '.ts')
        b, _ = scan("const x = 'b'; /* 新 */\nfoo(`u ${2}`);\n", '.ts')
        self.assertEqual(a, b)

    def test_code_edit_changes_code(self) -> None:
        a, _ = scan('const x = 1;\n', '.ts')
        b, _ = scan('const x = 2;\n', '.ts')
        self.assertNotEqual(a, b)

    def test_hash_languages(self) -> None:
        a, ca = scan("a: 'x'  # 舊\n# 整行\nb: 1\n", '.yml')
        b, cb = scan("a: 'y'  # 新\nb: 1\n", '.yml')
        self.assertEqual(a, b)
        self.assertEqual([c[1] for c in ca], [['舊'], ['整行']])
        self.assertEqual([c[1] for c in cb], [['新']])

    def test_rust_lifetime_is_not_a_string(self) -> None:
        a, _ = scan("fn f<'a>(x: &'a str) -> char { 'c' } // 舊\n", '.rs')
        b, _ = scan("fn f<'a>(x: &'a str) -> char { 'd' } // 新\n", '.rs')
        self.assertEqual(a, b)
        c, _ = scan("fn g<'a>(x: &'a str) -> char { 'c' }\n", '.rs')
        self.assertNotEqual(a, c)

    def test_python_docstring_is_string_content(self) -> None:
        a, _ = scan('def f():\n    """舊"""\n    return 1\n', '.py')
        b, _ = scan('def f():\n    """新\n多行"""\n    return 1\n', '.py')
        self.assertEqual(a, b)


class UnitsTest(unittest.TestCase):
    def test_reflow_does_not_change_sentences(self) -> None:
        _, a = scan('// 第一句在這裡，\n// 接著寫完。第二句。\n', '.ts')
        _, b = scan('// 第一句在這裡，接著寫完。\n// 第二句。\n', '.ts')
        self.assertEqual([norm(u.text) for u in units(a)], [norm(u.text) for u in units(b)])

    def test_headings_and_table_names(self) -> None:
        _, c = scan(d('/**\n * ## 偏離登記（@@）\n *\n * | # | 名稱 | 說明 |\n * | --- | --- | --- |\n * | 7 | Config 三格 | 沒有 |\n */\n'), '.ts')
        self.assertEqual(sorted(n.text for n in names(units(c))), ['Config 三格', d('偏離登記（@@）')])

    def test_core_and_terms(self) -> None:
        self.assertEqual(core_of(d('偏離登記（AGENTS.md 的規則；@@ 為準）')), '偏離登記')
        self.assertIn('三格', terms_of('Config 三格'))


class PhaseOneTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Repo(self)

    def head_and_base(self, base: dict[str, str], head: dict[str, str]) -> tuple[str, str]:
        b = self.repo.commit(base)
        return b, self.repo.commit(head)

    def test_comment_only_with_reference_drop_is_in_scope(self) -> None:
        b, h = self.head_and_base({'src/a.ts': TS_BASE}, {'src/a.ts': TS_HEAD.replace("'y'", "'x'")})
        a = analyze(b, h)
        self.assertTrue(a.in_scope, a.reason)

    def test_string_content_change_is_still_in_scope(self) -> None:
        b, h = self.head_and_base({'src/a.ts': TS_BASE}, {'src/a.ts': TS_HEAD})
        self.assertTrue(analyze(b, h).in_scope)

    def test_code_change_is_out_of_scope(self) -> None:
        b, h = self.head_and_base({'src/a.ts': TS_BASE}, {'src/a.ts': TS_HEAD.replace('return 1', 'return 2')})
        a = analyze(b, h)
        self.assertFalse(a.in_scope)
        self.assertIn('程式碼也變了', a.reason)

    def test_no_reference_drop_is_out_of_scope(self) -> None:
        b, h = self.head_and_base({'src/a.ts': TS_BASE}, {'src/a.ts': TS_BASE.replace('登記身分', '登記身份')})
        self.assertFalse(analyze(b, h).in_scope)

    def test_other_file_is_out_of_scope(self) -> None:
        b, h = self.head_and_base({'src/a.ts': TS_BASE, 'package.json': '{}\n'}, {'src/a.ts': TS_HEAD, 'package.json': '{"a":1}\n'})
        self.assertFalse(analyze(b, h).in_scope)

    def test_ratchets_and_docs_do_not_count_as_code(self) -> None:
        b, h = self.head_and_base(
            {'src/a.ts': TS_BASE, '.github/ratchets/_root.json': d('{"@@":1}\n'), 'docs/x.md': 'a\n'},
            {'src/a.ts': TS_HEAD, '.github/ratchets/_root.json': d('{"@@":0}\n'), 'docs/x.md': 'b\n'},
        )
        self.assertTrue(analyze(b, h).in_scope)


class RulesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Repo(self)
        self.base = self.repo.commit({'src/a.ts': TS_BASE, 'src/impl.ts': 'export const real = 1;\nexport const two = 2;\n'})

    def analyze_head(self, text: str, extra: dict[str, str] | None = None) -> tuple[mod.Analysis, str]:
        head = self.repo.commit({'src/a.ts': text, **(extra or {})})
        return analyze(self.base, head), head

    def test_rule1_lists_rewritten_sentences_and_demands_a_row(self) -> None:
        head_text = TS_BASE.replace(d('跟 @@ 的對照：@@ 把這一段放在 loop 裡。我們放在插件裡。'), '這一段由插件登記。')
        a, head = self.analyze_head(head_text)
        self.assertEqual([u.text for _, u in a.sentences], ['這一段由插件登記。'])
        self.assertTrue(any('規則 1' in e and '沒有對應的一列' in e for e in verify(a, '', head)))

    def test_rule1_row_with_existing_path_line_passes(self) -> None:
        a, head = self.analyze_head(TS_BASE.replace(d('跟 @@ 的對照：@@ 把這一段放在 loop 裡。我們放在插件裡。'), '這一段由插件登記。'))
        self.assertEqual(verify(a, '| 這一段由插件登記。 | src/impl.ts:1 |', head), [])

    def test_rule1_missing_file_or_line_fails(self) -> None:
        a, head = self.analyze_head(TS_BASE.replace(d('跟 @@ 的對照：@@ 把這一段放在 loop 裡。我們放在插件裡。'), '這一段由插件登記。'))
        for ref in ('src/none.ts:1', 'src/impl.ts:99', 'src/impl.ts:0'):
            with self.subTest(ref=ref):
                errors = verify(a, f'| 這一段由插件登記。 | {ref} |', head)
                self.assertTrue(any('不存在' in e for e in errors), errors)

    def test_rule1_unfilled_placeholder_fails(self) -> None:
        a, head = self.analyze_head(TS_BASE.replace(d('跟 @@ 的對照：@@ 把這一段放在 loop 裡。我們放在插件裡。'), '這一段由插件登記。'))
        errors = verify(a, '| 這一段由插件登記。 | <填：path:line> |', head)
        self.assertTrue(any('規則 1' in e for e in errors))

    def test_rule1_deleting_whole_sentences_needs_no_row(self) -> None:
        a, head = self.analyze_head(TS_BASE.replace(d('跟 @@ 的對照：@@ 把這一段放在 loop 裡。'), ''))
        self.assertEqual(a.sentences, [])
        self.assertEqual(verify(a, '', head), [])

    def test_rule2_renamed_heading_fails(self) -> None:
        a, head = self.analyze_head(CLEAN.replace('## 偏離登記', '## 接縫的限制'))
        self.assertTrue(any('規則 2' in e and '偏離登記' in e for e in verify(a, '', head)))

    def test_rule2_core_kept_while_parenthetical_dropped_passes(self) -> None:
        base = TS_BASE.replace('## 偏離登記', d('## 偏離登記（@@ 以 86a40220 為準）'))
        self.base = self.repo.commit({'src/a.ts': base})
        a, head = self.analyze_head(CLEAN)
        self.assertEqual([e for e in verify(a, '', head) if '規則 2' in e], [])

    def test_rule2_heading_naming_a_reference_is_exempt(self) -> None:
        base = TS_BASE.replace('## 偏離登記', d('## 偏離 @@'))
        self.base = self.repo.commit({'src/a.ts': base})
        a, head = self.analyze_head(CLEAN.replace('## 偏離登記', '## 登記'))
        self.assertEqual([e for e in verify(a, '', head) if '規則 2' in e], [])

    def test_rule3_stale_pointer_needs_a_row(self) -> None:
        pointer = '// 偏離登記寫在 a.ts 的檔頭。\nexport const p = 1;\n'
        self.base = self.repo.commit({'src/a.ts': TS_BASE, 'src/p.ts': pointer})
        a, head = self.analyze_head(CLEAN.replace('## 偏離登記', '## 登記'))
        self.assertEqual([(c.path, c.line) for c in a.candidates], [('src/p.ts', 1)])
        self.assertTrue(any('規則 3' in e and 'src/p.ts:1' in e for e in verify(a, '', head)))
        self.assertEqual([e for e in verify(a, '| src/p.ts:1 | 那是別的檔自己的偏離登記，名字沒變 |', head) if '規則 3' in e], [])

    def test_rule3_row_without_reason_fails(self) -> None:
        pointer = '// 偏離登記寫在 a.ts 的檔頭。\nexport const p = 1;\n'
        self.base = self.repo.commit({'src/a.ts': TS_BASE, 'src/p.ts': pointer})
        a, head = self.analyze_head(CLEAN.replace('## 偏離登記', '## 登記'))
        self.assertTrue(any('規則 3' in e for e in verify(a, '| src/p.ts:1 | |', head)))
        self.assertTrue(any('規則 3' in e for e in verify(a, '| src/p.ts:1 | <填：理由> |', head)))

    def test_rule3_pointer_changed_in_this_pr_is_not_a_candidate(self) -> None:
        self.base = self.repo.commit({'src/a.ts': TS_BASE, 'src/p.ts': '// 偏離登記寫在 a.ts 的檔頭。\n'})
        a, _ = self.analyze_head(CLEAN.replace('## 偏離登記', '## 登記'), {'src/p.ts': '// 照 a.ts 的檔頭。\n'})
        self.assertEqual(a.candidates, [])

    def test_body_edit_alone_changes_the_verdict(self) -> None:
        a, head = self.analyze_head(TS_BASE.replace(d('跟 @@ 的對照：@@ 把這一段放在 loop 裡。我們放在插件裡。'), '這一段由插件登記。'))
        self.assertTrue(verify(a, '', head))
        self.assertEqual(verify(a, '| 這一段由插件登記。 | src/impl.ts:1 |', head), [])


if __name__ == '__main__':
    unittest.main()
