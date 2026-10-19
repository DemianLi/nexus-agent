"""check_md_links.py 的單元測試（#1537）：掃哪些檔、目標與錨點怎麼判。"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from check_md_links import PATTERNS, collect, github_slug

OPS = """# 操作

## 升級與回滾

```bash
# 不是標題
```

### 後台改清單：`plugin` 寫入口與變更紀錄

## 重複

## 重複

<a id="手寫錨點"></a>

> ## 引言標題

段落

    ## 縮排程式碼

>     # 引言裡的縮排程式碼
"""

BAD = '見 [沒有](nope.md)。\n'


def scan(files: dict[str, str], links: dict[str, str] | None = None) -> tuple[list[str], int, list[str]]:
    """files 相對於 repo 根；links 是「符號連結 → 它指的檔」，同樣相對於 repo 根。"""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for rel, text in files.items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
        for rel, target in (links or {}).items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(os.path.relpath(root / target, path.parent), path)
        paths, count, violations = collect(root)
        return [p.relative_to(root).as_posix() for p in paths], count, violations


def linked(link: str) -> list[str]:
    return scan({'docs/a.md': f'# A\n\n## 變更\n\n見 {link}。\n', 'docs/ops.md': OPS, 'src/a.ts': ''})[2]


class Scope(unittest.TestCase):
    def test_every_pattern_is_scanned(self) -> None:
        files = {
            'README.md': BAD,
            'AGENTS.md': BAD,
            'docs/a.md': BAD,
            'docs/x/y/z.md': BAD,
            'packages/a.md': BAD,
            'packages/p/README.md': BAD,
            'packages/p/docs/a.md': BAD,
        }
        paths, count, violations = scan(files)
        self.assertEqual(paths, sorted(files))
        self.assertEqual(count, len(files))
        self.assertEqual(len(violations), len(files))

    def test_outside_patterns_is_not_scanned(self) -> None:
        files = {
            '.docs/a.md': BAD,
            '.github/a.md': BAD,
            'apps/web/README.md': BAD,
            'docs/.hidden/a.md': BAD,
            'packages/.p/README.md': BAD,
            'packages/p/a/b/c.md': BAD,
            'CONTRIBUTING.md': BAD,
        }
        self.assertEqual(scan(files), ([], 0, []))

    def test_symlink_to_same_file_is_scanned_once(self) -> None:
        paths, _, violations = scan({'AGENTS.md': BAD}, {'docs/AGENTS.md': 'AGENTS.md'})
        self.assertEqual(len(paths), 1)
        self.assertEqual(len(violations), 1)

    def test_patterns_follow_dsh(self) -> None:
        # dsh 的 PATTERNS 扣掉本 repo 沒有的 README.zh.md 與 .agents/**；.docs/、.github/、apps/ 由 #1755 補。
        self.assertEqual(sorted(PATTERNS), sorted(['README.md', 'docs/**/*.md', 'packages/*.md', 'packages/*/*.md',
                                                   'packages/*/*/*.md', 'AGENTS.md']))


class Links(unittest.TestCase):
    def test_github_slug(self) -> None:
        self.assertEqual(github_slug('後台改清單：plugin 寫入口與變更紀錄'), '後台改清單plugin-寫入口與變更紀錄')
        self.assertEqual(github_slug('Showcase: web_fetch'), 'showcase-web_fetch')

    def test_resolving_links_pass(self) -> None:
        for link in (
            '[升級](ops.md#升級與回滾)',
            '[改清單](ops.md#後台改清單plugin-寫入口與變更紀錄)',
            '[第二個重複](ops.md#重複-1)',
            '[手寫](ops.md#手寫錨點)',
            '[引言裡的標題](ops.md#引言標題)',
            '[編碼](ops.md#%E5%8D%87%E7%B4%9A%E8%88%87%E5%9B%9E%E6%BB%BE)',
            '[查詢字串](ops.md?plain=1#升級與回滾)',
            '[原始碼](../src/a.ts#L1)',
            '[外部](https://example.com/x.md#nope)',
            '[根](/docs/nope.md)',
            '[協定相對](//example.com/nope.md)',
            '[本檔](#變更)',
            '`[程式碼裡](nope.md)`',
        ):
            with self.subTest(link=link):
                self.assertEqual(linked(link), [])

    def test_missing_target(self) -> None:
        violations = linked('[沒有](nope.md)')
        self.assertEqual(len(violations), 1)
        self.assertIn('docs/a.md：', violations[0])
        self.assertIn('不存在的檔案', violations[0])

    def test_missing_anchor(self) -> None:
        for link in (
            '[沒有](ops.md#不存在)',
            '[fence 裡的](ops.md#不是標題)',
            '[第三個重複](ops.md#重複-2)',
            '[縮排程式碼](ops.md#縮排程式碼)',
            '[引言裡的縮排程式碼](ops.md#引言裡的縮排程式碼)',
            '[本檔](#沒有這段)',
        ):
            with self.subTest(link=link):
                self.assertTrue(any('沒有這個錨點' in v for v in linked(link)))

    def test_link_definition_is_checked(self) -> None:
        self.assertTrue(any('不存在的檔案' in v for v in linked('[參考]\n\n[參考]: nope.md')))

    def test_link_inside_fence_is_not_checked(self) -> None:
        self.assertEqual(linked('下面\n\n```\n[不查](nope.md)\n```\n'), [])


if __name__ == '__main__':
    unittest.main()
