"""check_upgrade_guides.py 的單元測試（#1537）：路徑、frontmatter、段落，以及版本目錄要是已存在的 tag。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from check_upgrade_guides import collect_violations

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


def tree(files: dict[str, str]) -> list[str]:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for rel, text in files.items():
            path = root / 'docs/upgrade-guide' / rel
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


if __name__ == '__main__':
    unittest.main()
