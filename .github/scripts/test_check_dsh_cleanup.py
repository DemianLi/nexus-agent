from __future__ import annotations

import os
import subprocess
import sys
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
        mod.show.cache_clear()
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

    def test_added_comment_only_code_file_is_out_of_scope(self) -> None:
        b, h = self.head_and_base({'src/a.ts': TS_BASE}, {'src/a.ts': TS_HEAD, 'src/new.ts': '// 只有註解\n'})
        a = analyze(b, h)
        self.assertFalse(a.in_scope)
        self.assertIn('新增或刪除', a.reason)

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
        self.assertTrue(any('規則 1' in e and '沒有對應的一列' in e and '| 整句 | 位置 | path:lo-hi | 原文片段 |' in e for e in verify(a, '', head)))

    def test_rule1_row_with_existing_path_line_passes(self) -> None:
        a, head = self.analyze_head(TS_BASE.replace(d('跟 @@ 的對照：@@ 把這一段放在 loop 裡。我們放在插件裡。'), '這一段由插件登記。'))
        self.assertEqual(verify(a, '| 這一段由插件登記。 | src/a.ts 第 5 行 | src/impl.ts:1 | export const real = 1; |', head), [])

    def test_rule1_missing_file_or_line_fails(self) -> None:
        a, head = self.analyze_head(TS_BASE.replace(d('跟 @@ 的對照：@@ 把這一段放在 loop 裡。我們放在插件裡。'), '這一段由插件登記。'))
        for ref in ('src/none.ts:1', 'src/impl.ts:99', 'src/impl.ts:0'):
            with self.subTest(ref=ref):
                errors = verify(a, f'| 這一段由插件登記。 | src/a.ts 第 5 行 | {ref} | export const real = 1; |', head)
                self.assertTrue(any('規則 1' in e for e in errors), errors)

    def test_rule1_unfilled_placeholder_fails(self) -> None:
        a, head = self.analyze_head(TS_BASE.replace(d('跟 @@ 的對照：@@ 把這一段放在 loop 裡。我們放在插件裡。'), '這一段由插件登記。'))
        errors = verify(a, '| 這一段由插件登記。 | src/a.ts 第 5 行 | src/impl.ts:1 <填：path:line> | export const real = 1; |', head)
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
        self.assertEqual([e for e in verify(a, '| src/p.ts:1 | 偏離登記 | 那是別的檔自己的偏離登記，名字沒變 |', head) if '規則 3' in e], [])

    def test_rule3_row_without_reason_fails(self) -> None:
        pointer = '// 偏離登記寫在 a.ts 的檔頭。\nexport const p = 1;\n'
        self.base = self.repo.commit({'src/a.ts': TS_BASE, 'src/p.ts': pointer})
        a, head = self.analyze_head(CLEAN.replace('## 偏離登記', '## 登記'))
        self.assertTrue(any('規則 3' in e for e in verify(a, '| src/p.ts:1 | 偏離登記 | |', head)))
        self.assertTrue(any('規則 3' in e for e in verify(a, '| src/p.ts:1 | 偏離登記 | <填：理由> |', head)))

    def test_rule3_pointer_changed_in_this_pr_is_not_a_candidate(self) -> None:
        self.base = self.repo.commit({'src/a.ts': TS_BASE, 'src/p.ts': '// 偏離登記寫在 a.ts 的檔頭。\n'})
        a, _ = self.analyze_head(CLEAN.replace('## 偏離登記', '## 登記'), {'src/p.ts': '// 照 a.ts 的檔頭。\n'})
        self.assertEqual(a.candidates, [])

    def test_body_edit_alone_changes_the_verdict(self) -> None:
        a, head = self.analyze_head(TS_BASE.replace(d('跟 @@ 的對照：@@ 把這一段放在 loop 裡。我們放在插件裡。'), '這一段由插件登記。'))
        self.assertTrue(verify(a, '', head))
        self.assertEqual(verify(a, '| 這一段由插件登記。 | src/a.ts 第 5 行 | src/impl.ts:1 | export const real = 1; |', head), [])


class PrintedTableTest(unittest.TestCase):
    """照 --print 印出來的表貼上，只動證據那一格：留空、亂填都要紅（#3152 verifier）。"""

    def setUp(self) -> None:
        self.repo = Repo(self)
        base = d(TS_BASE.replace('## 偏離登記', '## 偏離登記（@@ 為準）'))
        self.base = self.repo.commit({'src/a.ts': base, 'src/impl.ts': 'export const real = 1;\n', 'src/p.ts': '// 偏離登記寫在 a.ts 的檔頭。\n'})
        self.head = self.repo.commit({'src/a.ts': CLEAN.replace('## 偏離登記', '## 登記').replace('我們放在插件裡。', '改由插件登記。')})
        self.a = analyze(self.base, self.head)
        self.printed = mod.report(self.a)

    def fill(self, evidence: str, reason: str, snippet: str = 'export const real = 1;') -> str:
        return self.printed.replace('<填：path:line>', evidence).replace('<填：原文片段>', snippet).replace('<填：理由>', reason)

    def test_the_printed_table_has_both_kinds_of_rows(self) -> None:
        self.assertTrue(self.a.sentences)
        self.assertTrue(self.a.candidates)

    def test_pasted_as_printed_fails(self) -> None:
        self.assertTrue(verify(self.a, self.printed, self.head))

    def test_blank_or_wrong_evidence_and_reason_fail(self) -> None:
        for evidence, reason in (('', ''), ('x', 'x'), ('src/none.ts:9', 'x'), ('', '那是別的檔自己的偏離登記，名字沒變')):
            with self.subTest(evidence=evidence, reason=reason):
                self.assertTrue(verify(self.a, self.fill(evidence, reason), self.head))

    def test_the_sentence_own_location_is_not_evidence(self) -> None:
        path, u = self.a.sentences[0]
        errors = verify(self.a, self.fill(f'{path}:{u.line}', '那是別的檔自己的偏離登記，名字沒變'), self.head)
        self.assertTrue(any('規則 1' in e for e in errors))

    def test_a_row_with_a_leftover_placeholder_does_not_count(self) -> None:
        path, u = self.a.sentences[0]
        row = f'| {u.text} | {path} 第 {u.line} 行 | src/impl.ts:1 {mod.PLACEHOLDER}：確認 | export const real = 1; |'
        self.assertTrue(any('規則 1' in e and u.text[:10] in e for e in verify(self.a, row, self.head)))

    def test_the_hit_term_is_not_a_reason(self) -> None:
        errors = verify(self.a, self.fill('src/impl.ts:1', '偏離登記偏離登記'), self.head)
        self.assertTrue(any('規則 3' in e for e in errors))

    def test_real_evidence_and_reason_pass_rules_1_and_3(self) -> None:
        errors = verify(self.a, self.fill('src/impl.ts:1', '那是別的檔自己的偏離登記，名字沒變'), self.head)
        self.assertEqual([e for e in errors if '規則 1' in e or '規則 3' in e], [])


class EvidenceContentTest(unittest.TestCase):
    IMPL = 'export function real(): number {\n  // 登記在這裡\n\n  return registerPlugin(1);\n}\n'

    def setUp(self) -> None:
        self.repo = Repo(self)
        self.base = self.repo.commit({'a.ts': d('// @@ 才這樣。\n'), 'impl.ts': self.IMPL})
        self.head = self.repo.commit({'a.ts': '// 由插件登記。\n'})
        self.a = analyze(self.base, self.head)

    def rule1(self, ref: str, snippet: str) -> list[str]:
        return [e for e in verify(self.a, f'| 由插件登記。 | a.ts 第 1 行 | {ref} | {snippet} |', self.head) if '規則 1' in e]

    def test_rev_lines_reads_the_range_at_that_revision(self) -> None:
        self.assertEqual(mod.rev_lines(self.head, 'impl.ts', 4, 5), '  return registerPlugin(1);\n}')
        self.assertEqual(mod.rev_lines(self.head, 'impl.ts', 1, 1), 'export function real(): number {')
        for lo, hi in ((0, 1), (3, 2), (1, 6), (9, 9)):
            self.assertIsNone(mod.rev_lines(self.head, 'impl.ts', lo, hi))
        self.assertIsNone(mod.rev_lines(self.head, 'none.ts', 1, 1))

    def test_a_range_with_nothing_but_blanks_brackets_and_punctuation_is_refused(self) -> None:
        for ref in ('impl.ts:3', 'impl.ts:5'):
            with self.subTest(ref=ref):
                got = self.rule1(ref, 'return registerPlugin(1);')
                self.assertTrue(got)
                self.assertIn('什麼都不剩', got[0])
        self.assertTrue(mod.is_blank(' \n}\n  ); // '))
        self.assertFalse(mod.is_blank('}\nx'))

    def test_a_range_is_accepted_when_one_of_its_lines_has_content(self) -> None:
        self.assertEqual(self.rule1('impl.ts:3-4', 'return registerPlugin(1);'), [])

    def test_the_quoted_text_must_be_in_the_cited_lines(self) -> None:
        got = self.rule1('impl.ts:4', 'return somethingElse(2);')
        self.assertTrue(got)
        self.assertIn('impl.ts:4', got[0])
        self.assertIn('return registerPlugin(1);', got[0])
        self.assertIn('return somethingElse(2);', got[0])

    def test_the_quote_is_compared_without_whitespace_pipes_and_backticks(self) -> None:
        self.assertEqual(self.rule1('impl.ts:4', 'return   `registerPlugin`(1);'), [])
        self.assertEqual(self.rule1('impl.ts:4', 'return registerPlugin(1);'), [])

    def test_the_quote_of_another_line_does_not_count(self) -> None:
        self.assertTrue(self.rule1('impl.ts:4', 'export function real'))
        self.assertEqual(self.rule1('impl.ts:1-4', 'export function real'), [])

    def test_a_row_without_the_quote_cell_or_with_a_short_one_is_refused(self) -> None:
        none = verify(self.a, '| 由插件登記。 | a.ts 第 1 行 | impl.ts:4 |', self.head)
        self.assertTrue(any('少了最後一格' in e for e in none), none)
        for quote in ('', '}', ' ); '):
            with self.subTest(quote=quote):
                self.assertTrue(self.rule1('impl.ts:4', quote))

    def test_any_cited_range_with_the_quote_is_enough(self) -> None:
        self.assertEqual(self.rule1('impl.ts:5 impl.ts:4', 'return registerPlugin(1);'), [])

    def test_the_ref_is_not_read_from_the_quote_cell(self) -> None:
        got = verify(self.a, '| 由插件登記。 | a.ts 第 1 行 | 見下 | impl.ts:4 return registerPlugin(1); |', self.head)
        self.assertTrue(any('規則 1' in e for e in got))

    def test_the_printed_table_asks_for_the_quote(self) -> None:
        printed = mod.report(self.a)
        self.assertIn('| 句子 | 位置 | nexus 實作的 path:line | 那幾行的原文片段 |', printed)
        self.assertIn(f'{mod.PLACEHOLDER}：原文片段>', printed)


class OwnLineIsNotEvidenceTest(unittest.TestCase):
    """句子跨到的每一行都不算證據，行號寫死（#3152 第 2 次 verifier）。"""

    def setUp(self) -> None:
        self.repo = Repo(self)

    def analysis(self, base: str, head: str) -> tuple[mod.Analysis, str]:
        b = self.repo.commit({'a.ts': d(base), 'impl.ts': 'export const real = 1;\n'})
        h = self.repo.commit({'a.ts': head})
        return analyze(b, h), h

    def rule1(self, a: mod.Analysis, head: str, row: str) -> list[str]:
        return [e for e in verify(a, row, head) if '規則 1' in e]

    def test_second_line_of_a_paragraph(self) -> None:
        a, h = self.analysis('// 第一句不動。\n// @@ 才這樣。\n', '// 第一句不動。\n// 我們也這樣。\n')
        self.assertEqual([(u.line, u.last) for _, u in a.sentences], [(2, 2)])
        row = '| 我們也這樣。 | 位置 | {} | {} |'
        self.assertTrue(self.rule1(a, h, row.format('a.ts:2', '我們也這樣')))
        self.assertEqual(self.rule1(a, h, row.format('impl.ts:1', 'export const real = 1;')), [])
        self.assertEqual(self.rule1(a, h, row.format('a.ts:1', '第一句不動')), [])

    def test_second_sentence_on_the_same_line(self) -> None:
        a, h = self.analysis('// 甲句不動。@@ 乙句。\n', '// 甲句不動。我們的乙句。\n')
        self.assertEqual([(u.line, u.last) for _, u in a.sentences], [(1, 1)])
        self.assertTrue(self.rule1(a, h, '| 我們的乙句。 | 位置 | a.ts:1 | 甲句不動 |'))
        self.assertEqual(self.rule1(a, h, '| 我們的乙句。 | 位置 | impl.ts:1 | export const real = 1; |'), [])

    def test_sentence_spanning_lines(self) -> None:
        a, h = self.analysis(
            '// 前一句。\n// @@ 後面這一句寫得比較長，\n// 所以跨到第三行。\n// 末句。\n',
            '// 前一句。\n// 改寫後的句子寫得比較長，\n// 所以跨到第三行。\n// 末句。\n',
        )
        self.assertEqual([(u.line, u.last) for _, u in a.sentences], [(2, 3)])
        self.assertIn('a.ts 第 2-3 行', mod.report(a))
        row = '| 改寫後的句子寫得比較長，所以跨到第三行。 | 位置 | {} | {} |'
        for ref, quote in (('a.ts:2', '改寫後的句子'), ('a.ts:3', '所以跨到第三行'), ('a.ts:2-3', '改寫後的句子'), ('a.ts:1-2', '前一句')):
            with self.subTest(ref=ref):
                got = self.rule1(a, h, row.format(ref, quote))
                self.assertTrue(got)
                self.assertIn('a.ts:2 的句子', got[0])
        for ref, quote in (('a.ts:1', '前一句'), ('a.ts:4', '末句。'), ('impl.ts:1', 'export const real = 1;')):
            with self.subTest(ref=ref):
                self.assertEqual(self.rule1(a, h, row.format(ref, quote)), [])


class RuleThreeRoutesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Repo(self)

    def candidates(self, pointer: str, heading: str = '偏離登記') -> mod.Analysis:
        base = self.repo.commit(
            {'src/a.ts': d(TS_BASE.replace('## 偏離登記', f'## {heading}')), 'src/p.ts': pointer, 'src/impl.ts': 'export const real = 1;\n'}
        )
        self.head = self.repo.commit({'src/a.ts': CLEAN.replace('## 偏離登記', '## 登記')})
        return analyze(base, self.head)

    def test_owner_path_and_header_word_route_finds_it_without_the_name(self) -> None:
        a = self.candidates('// 詳見 src/a.ts 的檔頭。\n')
        self.assertIn(('src/p.ts', 1), [(c.path, c.line) for c in a.candidates])

    def test_owner_path_and_shorthand_route(self) -> None:
        a = self.candidates('// src/a.ts 的簡寫在那裡。\n', heading='偏離登記 簡寫')
        self.assertIn(('src/p.ts', 1), [(c.path, c.line) for c in a.candidates])

    def test_unrelated_line_is_not_a_candidate(self) -> None:
        a = self.candidates('// 完全無關的一行。\n')
        self.assertEqual([c for c in a.candidates if c.path == 'src/p.ts'], [])

    def test_reason_is_the_last_cell_only(self) -> None:
        a = self.candidates('// 偏離登記制度說明寫在 a.ts 的檔頭。\n', heading='偏離登記制度說明')
        self.assertTrue(any(c.path == 'src/p.ts' for c in a.candidates))
        errors = verify(a, '| src/p.ts:1 | 偏離登記制度說明 | |', self.head)
        self.assertTrue(any('規則 3' in e and 'src/p.ts:1' in e for e in errors))


class SentenceCellTest(unittest.TestCase):
    def test_sentence_cell_must_equal_not_contain(self) -> None:
        repo = Repo(self)
        base = repo.commit({'a.ts': d(TS_BASE), 'impl.ts': 'export const real = 1;\n'})
        head = repo.commit({'a.ts': CLEAN.replace('我們放在插件裡。', '這一段由插件登記。')})
        a = analyze(base, head)
        exact = '| 這一段由插件登記。 | 位置 | impl.ts:1 | export const real = 1; |'
        self.assertEqual([e for e in verify(a, exact, head) if '規則 1' in e], [])
        for longer in ('| 這一段由插件登記。再加一句別的話。 | 位置 | impl.ts:1 | export const real = 1; |', '| 前面還有字這一段由插件登記。 | 位置 | impl.ts:1 | export const real = 1; |'):
            with self.subTest(row=longer):
                self.assertTrue(any('規則 1' in e for e in verify(a, longer, head)))


class CssAndShortSentenceTest(unittest.TestCase):
    def test_css_hash_is_not_a_comment(self) -> None:
        a, _ = scan('a { color: #000; /* 舊 */ }\n', '.css')
        b, c = scan('a { color: #fff; /* 新 */ }\n', '.css')
        self.assertNotEqual(a, b)
        self.assertEqual([x[1] for x in c], [['新']])

    def test_short_sentences_count(self) -> None:
        _, c = scan('// 會擋。\n', '.ts')
        self.assertEqual([u.text for u in units(c)], ['會擋。'])


class CommandLineTest(unittest.TestCase):
    """走一次完整的 main()：讓整道 gate 或重跑失效的突變（不讀 BODY、範圍恆 false、錯誤仍 exit 0）要在這裡紅。"""

    def setUp(self) -> None:
        self.repo = Repo(self)
        self.base = self.repo.commit({'src/a.ts': d(TS_BASE), 'src/impl.ts': 'export const real = 1;\n'})
        self.head = self.repo.commit({'src/a.ts': d(TS_BASE).replace(d('跟 @@ 的對照：@@ 把這一段放在 loop 裡。我們放在插件裡。'), '這一段由插件登記。')})

    def cli(self, *args: str, body: str | None = None, head: str | None = None) -> subprocess.CompletedProcess[str]:
        env = {k: v for k, v in os.environ.items() if k != 'BODY'}
        if body is not None:
            env['BODY'] = body
        return subprocess.run(
            [sys.executable, str(Path(mod.__file__)), '--root', str(self.repo.root), '--base', self.base, '--head', head or self.head, *args],
            capture_output=True, text=True, env=env,
        )

    def test_empty_body_is_read_and_fails(self) -> None:
        r = self.cli(body='')
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn('::error::規則 1', r.stdout)

    def test_filled_body_passes(self) -> None:
        r = self.cli(body='| 這一段由插件登記。 | src/a.ts 第 5 行 | src/impl.ts:1 | export const real = 1; |')
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn('證據通過', r.stdout)

    def test_no_body_prints_the_rows_only(self) -> None:
        r = self.cli()
        self.assertEqual(r.returncode, 0)
        self.assertIn('規則 1：改寫與新增的註解句', r.stdout)

    def test_in_scope_answers_true_and_false(self) -> None:
        self.assertEqual(self.cli('--in-scope').stdout.strip(), 'true')
        later = self.repo.commit({'src/b.ts': 'export const b = 1;\n'})
        self.assertEqual(self.cli('--in-scope', head=later).stdout.strip(), 'false')

    def test_out_of_scope_pr_passes_without_a_body(self) -> None:
        later = self.repo.commit({'src/b.ts': 'export const b = 1;\n'})
        r = self.cli(body='', head=later)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn('不是清外部對照的 PR', r.stdout)

    def test_a_failing_revision_lookup_is_not_swallowed(self) -> None:
        r = subprocess.run([sys.executable, str(Path(mod.__file__)), '--root', str(self.repo.root), '--head', 'nope', '--in-scope'], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)


class EvidencePathSpellingTest(unittest.TestCase):
    def test_other_spellings_of_the_sentence_own_line_are_not_evidence(self) -> None:
        repo = Repo(self)
        b = repo.commit({'a.ts': d('// 第一句不動。\n// @@ 才這樣。\n'), 'impl.ts': 'export const real = 1;\n'})
        h = repo.commit({'a.ts': '// 第一句不動。\n// 我們也這樣。\n'})
        a = analyze(b, h)
        row = '| 我們也這樣。 | 位置 | {} | {} |'
        for ref in ('a.ts:2', './a.ts:2', 'x/../a.ts:2', './x/./../a.ts:2'):
            with self.subTest(ref=ref):
                self.assertTrue([e for e in verify(a, row.format(ref, '我們也這樣'), h) if '規則 1' in e])
        for ref in ('impl.ts:1', './impl.ts:1'):
            with self.subTest(ref=ref):
                self.assertEqual([e for e in verify(a, row.format(ref, 'export const real = 1;'), h) if '規則 1' in e], [])

    def test_rule3_row_may_spell_the_location_with_dot_slash(self) -> None:
        repo = Repo(self)
        b = repo.commit({'src/a.ts': d(TS_BASE), 'src/p.ts': '// 偏離登記寫在 a.ts 的檔頭。\n'})
        h = repo.commit({'src/a.ts': CLEAN.replace('## 偏離登記', '## 登記')})
        a = analyze(b, h)
        reason = '那是別的檔自己的偏離登記，名字沒變'
        self.assertEqual([e for e in verify(a, f'| ./src/p.ts:1 | 偏離登記 | {reason} |', h) if '規則 3' in e], [])


class RuleOneRowShapeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Repo(self)

    def test_evidence_is_read_after_the_sentence_cell_only(self) -> None:
        b = self.repo.commit({'a.ts': d('// @@ 才這樣。\n'), 'impl.ts': 'export const real = 1;\n'})
        h = self.repo.commit({'a.ts': '// 見 impl.ts:1 的做法。\n'})
        a = analyze(b, h)
        self.assertTrue([e for e in verify(a, '| 見 impl.ts:1 的做法。 | 位置 | | export const real = 1; |', h) if '規則 1' in e])
        self.assertEqual([e for e in verify(a, '| 見 impl.ts:1 的做法。 | 位置 | impl.ts:1 | export const real = 1; |', h) if '規則 1' in e], [])

    def test_the_sentence_must_be_in_the_first_cell(self) -> None:
        b = self.repo.commit({'a.ts': d(TS_BASE), 'impl.ts': 'export const real = 1;\n'})
        h = self.repo.commit({'a.ts': CLEAN.replace('我們放在插件裡。', '這一段由插件登記。')})
        a = analyze(b, h)
        self.assertTrue([e for e in verify(a, '| 位置 | 這一段由插件登記。 | impl.ts:1 | export const real = 1; |', h) if '規則 1' in e])
        self.assertTrue([e for e in verify(a, '| 位置 | impl.ts:1 | 這一段由插件登記。 |', h) if '規則 1' in e])

    def test_the_same_sentence_in_two_files_needs_two_rows(self) -> None:
        b = self.repo.commit({'a.ts': d('// @@ 才這樣。\n'), 'b.ts': d('// @@ 才這樣。\n'), 'impl.ts': 'export const real = 1;\n'})
        h = self.repo.commit({'a.ts': '// 我們也這樣。\n', 'b.ts': '// 我們也這樣。\n'})
        a = analyze(b, h)
        self.assertEqual([p for p, _ in a.sentences], ['a.ts', 'b.ts'])
        one = '| 我們也這樣。 | a.ts 第 1 行 | impl.ts:1 | export const real = 1; |'
        self.assertEqual(len([e for e in verify(a, one, h) if '規則 1' in e]), 1)
        two = one + '\n| 我們也這樣。 | b.ts 第 1 行 | impl.ts:1 | export const real = 1; |'
        self.assertEqual([e for e in verify(a, two, h) if '規則 1' in e], [])

    def test_a_repeated_sentence_is_counted(self) -> None:
        b = self.repo.commit({'a.ts': d('// @@ 先。\n// 同一句。\nconst a = 1;\n')})
        h = self.repo.commit({'a.ts': '// 同一句。\nconst a = 1;\n// 同一句。\n'})
        self.assertEqual([u.text for _, u in analyze(b, h).sentences], ['同一句。'])


class RuleThreeRowShapeTest(unittest.TestCase):
    REASON = '那是別的檔自己的偏離登記，名字沒變'

    def setUp(self) -> None:
        self.repo = Repo(self)
        pointer = '// 偏離登記寫在 a.ts 的檔頭。\n// 另一行無關。\n'
        self.base = self.repo.commit({'src/a.ts': d(TS_BASE), 'src/p.ts': pointer})
        self.head = self.repo.commit({'src/a.ts': CLEAN.replace('## 偏離登記', '## 登記')})
        self.a = analyze(self.base, self.head)

    def rule3(self, row: str) -> list[str]:
        return [e for e in verify(self.a, row, self.head) if '規則 3' in e]

    def test_reason_must_be_the_last_cell(self) -> None:
        self.assertEqual(self.rule3(f'| src/p.ts:1 | 偏離登記 | {self.REASON} |'), [])
        self.assertTrue(self.rule3(f'| src/p.ts:1 | 偏離登記 {self.REASON} | |'))
        self.assertTrue(self.rule3(f'| src/p.ts:1 {self.REASON} | 偏離登記 | |'))
        self.assertTrue(self.rule3(f'| src/p.ts:1 | {self.REASON} | |'))

    def test_the_row_must_name_the_candidate_line(self) -> None:
        self.assertTrue(self.rule3(f'| src/p.ts:2 | 偏離登記 | {self.REASON} |'))
        self.assertEqual(self.rule3(f'| src/p.ts:1-2 | 偏離登記 | {self.REASON} |'), [])
        self.assertTrue(self.rule3(f'| src/a.ts:1 | 偏離登記 | {self.REASON} |'))

    def test_reason_must_not_be_the_hit_term_or_a_reference(self) -> None:
        self.assertTrue(self.rule3('| src/p.ts:1 | 偏離登記 | 偏離登記 src/impl.ts:1 |'))


class RuleThreeRoutesMoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Repo(self)

    def test_package_name_route(self) -> None:
        pkg = '{"name": "@nexus/foo"}'
        b = self.repo.commit({'packages/foo/package.json': pkg, 'packages/foo/src/a.ts': d(TS_BASE), 'src/p.ts': '// 見 @nexus/foo 的檔頭。\n'})
        h = self.repo.commit({'packages/foo/src/a.ts': CLEAN.replace('## 偏離登記', '## 登記')})
        self.assertIn(('src/p.ts', 1), [(c.path, c.line) for c in analyze(b, h).candidates])

    def test_only_the_lines_this_change_touched_are_skipped(self) -> None:
        two = '// 偏離登記寫在 a.ts 的檔頭。\n// 偏離登記也見 a.ts 的檔頭。\n'
        b = self.repo.commit({'src/a.ts': d(TS_BASE), 'src/p.ts': two})
        h = self.repo.commit({'src/a.ts': CLEAN.replace('## 偏離登記', '## 登記'), 'src/p.ts': two.replace('寫在', '放在')})
        self.assertEqual([(c.path, c.line) for c in analyze(b, h).candidates], [('src/p.ts', 2)])

    def test_a_renamed_markdown_heading_is_not_blocking_but_is_searched(self) -> None:
        pointer = '// 偏離登記寫在 x.md 的檔頭。\n'
        b = self.repo.commit({'src/a.ts': d(TS_BASE), 'docs/x.md': '# 標題\n\n## 偏離登記\n', 'src/p.ts': pointer})
        h = self.repo.commit({'src/a.ts': CLEAN, 'docs/x.md': '# 標題\n\n## 登記\n'})
        a = analyze(b, h)
        md = [(p, blocking) for p, n, blocking in a.vanished if p == 'docs/x.md']
        self.assertEqual(md, [('docs/x.md', False)])
        self.assertEqual([e for e in verify(a, '', h) if '規則 2' in e], [])
        self.assertIn(('src/p.ts', 1), [(c.path, c.line) for c in a.candidates])

    def test_parenthetical_only_changes_keep_the_name(self) -> None:
        def heading(text: str) -> str:
            return d(TS_BASE.replace('## 偏離登記', text))

        b = self.repo.commit({'src/a.ts': heading('## 偏離登記（甲）')})
        same = self.repo.commit({'src/a.ts': CLEAN.replace('## 偏離登記', '## 偏離登記（乙）')})
        self.assertEqual([e for e in verify(analyze(b, same), '', same) if '規則 2' in e], [])
        other = self.repo.commit({'src/a.ts': CLEAN.replace('## 偏離登記', '## 另外的名字（甲）')})
        self.assertTrue([e for e in verify(analyze(b, other), '', other) if '規則 2' in e])


class FileKindsTest(unittest.TestCase):
    COMMENTS = {'.css': '/* @@ 註 */\na { b: c }\n'}

    def test_every_listed_language_is_comment_editable(self) -> None:
        every = ('.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs', '.css', '.py', '.sh', '.yml', '.yaml', '.toml', '.txt')
        self.assertEqual(sorted(mod.LANGS), sorted(every))
        for ext in every:
            with self.subTest(ext=ext):
                repo = Repo(self)
                mark = '/* @@ 註 */' if ext == '.css' else '// @@ 註' if ext in mod.SLASH else '# @@ 註'
                body = 'a { b: c }\n' if ext == '.css' else 'x\n'
                b = repo.commit({f'f{ext}': d(f'{mark}\n{body}')})
                h = repo.commit({f'f{ext}': body})
                self.assertTrue(analyze(b, h).in_scope, analyze(b, h).reason)

    def test_other_extensions_are_out_of_scope(self) -> None:
        for ext in ('.json', '.sql', '.html', '.lock', '.svg'):
            with self.subTest(ext=ext):
                repo = Repo(self)
                b = repo.commit({'a.ts': d('// @@ 註\nx\n'), f'f{ext}': 'a\n'})
                h = repo.commit({'a.ts': 'x\n', f'f{ext}': 'b\n'})
                a = analyze(b, h)
                self.assertFalse(a.in_scope)
                self.assertIn(f'f{ext} 不是註解可以涵蓋的檔', a.reason)

    def test_txt_comment_edit_stays_in_scope_and_data_edit_does_not(self) -> None:
        repo = Repo(self)
        b = repo.commit({'list.txt': d('# 照 @@ 逐檔列。\na.test.ts\n')})
        comment = repo.commit({'list.txt': '# 逐檔列。\na.test.ts\n'})
        self.assertTrue(analyze(b, comment).in_scope)
        data = repo.commit({'list.txt': '# 逐檔列。\nb.test.ts\n'})
        self.assertFalse(analyze(b, data).in_scope)


class PythonScanTest(unittest.TestCase):
    PY = 'def f():\n    """{}"""\n    return 1\n'

    def test_docstring_sentences_are_listed(self) -> None:
        repo = Repo(self)
        b = repo.commit({'a.py': d(self.PY.format('@@ 的做法。我們另有。')), 'impl.py': 'x = 1\n'})
        h = repo.commit({'a.py': self.PY.format('改成別的。我們另有。')})
        a = analyze(b, h)
        self.assertTrue(a.in_scope, a.reason)
        self.assertEqual([(p, u.text, u.line) for p, u in a.sentences], [('a.py', '改成別的。', 2)])
        self.assertTrue([e for e in verify(a, '', h) if '規則 1' in e])
        self.assertEqual([e for e in verify(a, '| 改成別的。 | a.py 第 2 行 | impl.py:1 | x = 1 |', h) if '規則 1' in e], [])

    def test_multiline_docstring_keeps_line_numbers(self) -> None:
        text = 'def f():\n    """標題。\n\n    第二段 @@ 在這裡。\n    """\n    return 1\n'
        _, comments = scan(d(text), '.py')
        found = units(comments)
        self.assertEqual([(u.text, u.line) for u in found], [('標題。', 2), (d('第二段 @@ 在這裡。'), 4)])

    def test_a_string_value_is_not_a_docstring(self) -> None:
        _, comments = scan('x = """甲。\n乙。"""\ny = ("""丙""",)\n', '.py')
        self.assertEqual(comments, [])

    def test_indentation_is_code(self) -> None:
        a, _ = scan('if x:\n    y = 1\nz = 2  # 舊\n', '.py')
        b, _ = scan('if x:\n    y = 1\nz = 2  # 新\n', '.py')
        c, _ = scan('if x:\n    y = 1\n    z = 2\n', '.py')
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)


class JsxCommentTest(unittest.TestCase):
    def test_removing_a_jsx_comment_wrapper_is_comment_only(self) -> None:
        a, ca = scan(d('<div>\n  {/* @@ 註 */}\n  <b />\n</div>\n'), '.tsx')
        b, _ = scan('<div>\n  <b />\n</div>\n', '.tsx')
        self.assertEqual(a, b)
        self.assertEqual([c[1] for c in ca], [[d('@@ 註')]])

    def test_empty_braces_that_are_code_still_count(self) -> None:
        for before, after in (('const f = () => {/* c */};\n', 'const f = () => ;\n'), ('const o = {/* c */};\n', 'const o = ;\n')):
            with self.subTest(before=before):
                self.assertNotEqual(scan(before, '.tsx')[0], scan(after, '.tsx')[0])

    def test_other_extensions_keep_the_braces(self) -> None:
        self.assertNotEqual(scan('f(a, {/* c */});\n', '.ts')[0], scan('f(a, );\n', '.ts')[0])


class RustCharTest(unittest.TestCase):
    def test_char_literals_and_lifetimes_do_not_open_strings(self) -> None:
        for lit in ("'\\n'", "'\\u{1F600}'", "'x'", "'\\\\'"):
            with self.subTest(lit=lit):
                a, _ = scan(f"fn f(s: &'static str) -> char {{ {lit} }} // 舊\nconst X: &str = \"a\"; // 舊二\n", '.rs')
                b, ca = scan(f"fn f(s: &'static str) -> char {{ {lit} }} // 新\nconst X: &str = \"b\"; // 新二\n", '.rs')
                self.assertEqual(a, b)
                self.assertEqual([c[1] for c in ca], [['新'], ['新二']])


if __name__ == '__main__':
    unittest.main()


class OwnersShapesTest(unittest.TestCase):
    CASES = [
        ('apps/harness/src/a.ts', 'harness/apps/harness/src/a.ts', 'apps/harness', 'harness/apps/harness', '@nexus/harness'),
        ('packages/nexus-core/src/a.ts', 'harness/packages/nexus-core/src/a.ts', 'packages/nexus-core', 'harness/packages/nexus-core', '@nexus/core'),
        ('apps/web/src/a.tsx', 'web/src/a.tsx', 'apps/web', 'web', '@nexus/web'),
    ]

    def test_both_shapes_give_the_same_owners(self) -> None:
        for old_path, new_path, old_dir, new_dir, name in self.CASES:
            repo = Repo(self)
            head = repo.commit({f'{old_dir}/package.json': '{"name": "%s"}' % name, f'{new_dir}/package.json': '{"name": "%s"}' % name})
            old = mod.owners_of(old_path, head)
            new = mod.owners_of(new_path, head)
            self.assertEqual(old, [old_path, old_dir, name])
            self.assertEqual(new, [new_path, new_dir, name])

    def test_files_outside_a_package_only_have_their_path(self) -> None:
        repo = Repo(self)
        head = repo.commit({'README.md': 'x\n'})
        for path in ('docs/a.md', 'harness/scripts/a.ts', 'scripts/a.ts', 'harness/apps/harness', 'package.json'):
            self.assertEqual(mod.owners_of(path, head), [path])

    def test_vendor_and_docs_are_ignored_in_both_shapes(self) -> None:
        for path in ('vendor/cordis/src/a.ts', 'harness/vendor/cordis/src/a.ts', 'apps/web/src/vendor/z/a.ts', 'web/src/vendor/z/a.ts', 'docs/a.ts'):
            self.assertEqual(mod.classify(path), 'ignored', path)
        for path in ('apps/harness/src/a.ts', 'harness/apps/harness/src/a.ts', 'web/src/a.tsx'):
            self.assertEqual(mod.classify(path), 'code', path)

    def test_search_skips_vendor_in_both_shapes(self) -> None:
        for path in ('vendor/x/a.ts', 'harness/vendor/x/a.ts', 'web/src/vendor/x/a.ts'):
            repo = Repo(self)
            head = repo.commit({path: '// needle\n', 'src/b.ts': '// needle\n'})
            self.assertEqual([hit[0] for hit in mod.grep_lines('needle', head)], ['src/b.ts'], path)
