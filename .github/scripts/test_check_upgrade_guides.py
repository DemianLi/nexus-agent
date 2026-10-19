"""check_upgrade_guides.py 的單元測試（#1537）：路徑、frontmatter、段落、相對連結，以及版本目錄要是已存在的 tag。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from check_upgrade_guides import collect_violations, github_slug

TAGS = {'v0.5.19'}

GOOD = """---
kind: upgrade-guide
description: 舊的 cordis.patch.yml 第一次啟動時遷進變更紀錄。
---

# 插件設定改存在變更紀錄

## 變更

舊版讀 home 的 `cordis.patch.yml`。

## 遷移

1. 停 serve。
2. 起新版，確認啟動輸出有遷移那一行：

   ```bash
   # 這行在 code block 裡，不是標題
   grep 遷進 serve.log
   ```

### 補充

三級標題不算。
"""


def tree(files: dict[str, str], others: dict[str, str] | None = None) -> list[str]:
    """files 放在 docs/upgrade-guide 底下，others 相對於 repo 根。"""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for rel, text in [*((f'docs/upgrade-guide/{k}', v) for k, v in files.items()), *(others or {}).items()]:
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
        return collect_violations(root, TAGS)


def guide(text: str) -> list[str]:
    return tree({'v0.5.19/plugin-journal-migration/guide.md': text})


class Paths(unittest.TestCase):
    def test_good_sample_passes(self) -> None:
        self.assertEqual(guide(GOOD), [])

    def test_absent_directory_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(collect_violations(Path(tmp), TAGS), [])

    def test_bad_path_shapes(self) -> None:
        for rel in (
            '0.5.19/item/guide.md',
            'v0.5/item/guide.md',
            'v0.5.19/Item_Name/guide.md',
            'v0.5.19/item/README.md',
            'v0.5.19/guide.md',
            'v0.5.19/item/sub/guide.md',
        ):
            with self.subTest(rel=rel):
                self.assertTrue(any('只放 v<semver>' in v for v in tree({rel: GOOD})))

    def test_extra_file_beside_guide(self) -> None:
        violations = tree({'v0.5.19/item/guide.md': GOOD, 'v0.5.19/item/notes.md': '筆記'})
        self.assertEqual(len(violations), 1)
        self.assertIn('v0.5.19/item/notes.md', violations[0])

    def test_version_directory_must_be_existing_tag(self) -> None:
        violations = tree({'v0.0.0/item/guide.md': GOOD})
        self.assertEqual(len(violations), 1)
        self.assertIn('沒有這個 tag', violations[0])


class Frontmatter(unittest.TestCase):
    def test_missing(self) -> None:
        self.assertTrue(any('frontmatter' in v for v in guide(GOOD.split('---\n', 2)[2])))

    def test_extra_key(self) -> None:
        bad = GOOD.replace('kind: upgrade-guide\n', 'kind: upgrade-guide\nversion: v0.5.19\n')
        self.assertTrue(any('鍵要恰好是' in v for v in guide(bad)))

    def test_wrong_kind(self) -> None:
        self.assertTrue(any('kind 要是' in v for v in guide(GOOD.replace('kind: upgrade-guide', 'kind: guide'))))

    def test_empty_or_non_string_description(self) -> None:
        line = 'description: 舊的 cordis.patch.yml 第一次啟動時遷進變更紀錄。'
        for value in ('description:', "description: ''", 'description: 42', 'description: true'):
            with self.subTest(value=value):
                self.assertTrue(any('description' in v for v in guide(GOOD.replace(line, value))))

    def test_duplicate_key(self) -> None:
        bad = GOOD.replace('kind: upgrade-guide\n', 'kind: upgrade-guide\nkind: upgrade-guide\n')
        self.assertTrue(any('重複' in v for v in guide(bad)))

    def test_multi_line_value(self) -> None:
        bad = GOOD.replace('kind: upgrade-guide\n', 'kind: upgrade-guide\n  continued\n')
        self.assertTrue(any('單行' in v for v in guide(bad)))

    def test_plain_value_yaml_would_not_read_as_this_string(self) -> None:
        line = 'description: 舊的 cordis.patch.yml 第一次啟動時遷進變更紀錄。'
        for value in ('[a, b]', '{a: b}', '&x 錨點', '*x', '!!str 標籤', '| 區塊', '> 摺疊', '- 清單', '舊的: 新的', '結尾冒號:', '說明 #註解', '`反引號'):
            with self.subTest(value=value):
                self.assertTrue(any('請加引號' in v for v in guide(GOOD.replace(line, f'description: {value}'))))

    def test_plain_value_that_yaml_reads_as_is(self) -> None:
        line = 'description: 舊的 cordis.patch.yml 第一次啟動時遷進變更紀錄。'
        for value in ('a:b 沒有空白的冒號', 'C# 前面沒有空白的井號', '-1 天', "'舊的: 新的'", '"說明 #不是註解"'):
            with self.subTest(value=value):
                self.assertEqual(guide(GOOD.replace(line, f'description: {value}')), [])


class Sections(unittest.TestCase):
    def test_reversed_order(self) -> None:
        bad = GOOD.replace('## 變更', '## TMP').replace('## 遷移', '## 變更').replace('## TMP', '## 遷移')
        self.assertTrue(any('標題要是' in v for v in guide(bad)))

    def test_extra_second_level(self) -> None:
        self.assertTrue(any('標題要是' in v for v in guide(GOOD + '\n## 備註\n\n多一段。\n')))

    def test_missing_section(self) -> None:
        self.assertTrue(any('標題要是' in v for v in guide(GOOD.replace('## 遷移', '### 遷移'))))

    def test_title_must_come_first(self) -> None:
        self.assertTrue(any('標題要是' in v for v in guide(GOOD.replace('# 插件設定改存在變更紀錄\n', ''))))

    def test_setext_heading_counts(self) -> None:
        self.assertTrue(any('標題要是' in v for v in guide(GOOD + '\n備註\n---\n')))

    def test_heading_inside_fence_or_quote_is_not_heading(self) -> None:
        self.assertEqual(guide(GOOD + '\n~~~\n## 不是標題\n~~~\n\n> ## 引言裡的也不是\n'), [])

    def test_heading_inside_html_comment_is_not_heading(self) -> None:
        self.assertEqual(guide(GOOD + '\n<!--\n## 註解裡的不是標題\n-->\n'), [])
        self.assertEqual(guide(GOOD + '\n<!-- 同一行開頭\n## 註解裡的不是標題 -->\n'), [])

    def test_heading_inside_list_item_is_not_top_level(self) -> None:
        for item in ('- 項目\n\n  ## 項目裡的\n', '3. 項目\n\n   ## 項目裡的\n', '- 項目\n  ## 項目裡的\n', '-\n  ## 空項目裡的\n'):
            with self.subTest(item=item):
                self.assertEqual(guide(GOOD + '\n' + item), [])

    def test_list_ends_before_unindented_heading(self) -> None:
        for tail in ('- 項目\n## 備註\n', '- 項目\n\n## 備註\n', '- 項目\n延續行\n\n備註\n===\n', '1. 項目\n\n   續\n\n## 備註\n'):
            with self.subTest(tail=tail):
                self.assertTrue(any('標題要是' in v for v in guide(GOOD + '\n' + tail)))

    def test_thematic_break_is_not_heading(self) -> None:
        self.assertEqual(guide(GOOD + '\n***\n\n- - -\n'), [])
        # `- - -` 是分隔線、不開清單，下一行縮兩格的 `##` 仍是頂層標題。
        self.assertTrue(any('標題要是' in v for v in guide(GOOD + '\n- - -\n  ## 備註\n')))


OPS = """# 操作

## 升級與回滾

```bash
# 不是標題
```

### 後台改清單：`plugin` 寫入口與變更紀錄

## 重複

## 重複

<a id="手寫錨點"></a>
"""


def linked(link: str) -> list[str]:
    body = GOOD.replace('舊版讀 home 的 `cordis.patch.yml`。', f'舊版讀 home 的 `cordis.patch.yml`，見 {link}。')
    return tree({'v0.5.19/plugin-journal-migration/guide.md': body}, {'docs/ops.md': OPS, 'src/a.ts': ''})


class Links(unittest.TestCase):
    def test_github_slug(self) -> None:
        self.assertEqual(github_slug('後台改清單：plugin 寫入口與變更紀錄'), '後台改清單plugin-寫入口與變更紀錄')
        self.assertEqual(github_slug('Showcase: web_fetch'), 'showcase-web_fetch')

    def test_resolving_links_pass(self) -> None:
        for link in (
            '[升級](../../../ops.md#升級與回滾)',
            '[改清單](../../../ops.md#後台改清單plugin-寫入口與變更紀錄)',
            '[第二個重複](../../../ops.md#重複-1)',
            '[手寫](../../../ops.md#手寫錨點)',
            '[編碼](../../../ops.md#%E5%8D%87%E7%B4%9A%E8%88%87%E5%9B%9E%E6%BB%BE)',
            '[原始碼](../../../../src/a.ts#L1)',
            '[外部](https://example.com/x.md#nope)',
            '[根](/docs/nope.md)',
            '[本檔](#變更)',
            '`[程式碼裡](nope.md)`',
        ):
            with self.subTest(link=link):
                self.assertEqual(linked(link), [])

    def test_missing_target(self) -> None:
        violations = linked('[沒有](../../../nope.md)')
        self.assertEqual(len(violations), 1)
        self.assertIn('不存在的檔案', violations[0])

    def test_missing_anchor(self) -> None:
        for link in ('[沒有](../../../ops.md#不存在)', '[fence 裡的](../../../ops.md#不是標題)', '[第三個重複](../../../ops.md#重複-2)', '[本檔](#沒有這段)'):
            with self.subTest(link=link):
                self.assertTrue(any('沒有這個錨點' in v for v in linked(link)))

    def test_link_definition_is_checked(self) -> None:
        self.assertTrue(any('不存在的檔案' in v for v in guide(GOOD + '\n[參考]: ../../../nope.md\n')))

    def test_link_inside_fence_is_not_checked(self) -> None:
        self.assertEqual(guide(GOOD + '\n```\n[不查](nope.md)\n```\n'), [])


if __name__ == '__main__':
    unittest.main()
