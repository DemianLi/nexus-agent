"""檢查 PR 標題與內文格式。規範見 AGENTS.md。

標題與內文是外部輸入，一律從環境變數讀取，不經 shell 展開。
"""

import os
import re
import sys

TYPES = ('feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'ci', 'chore', 'release')

# Dependabot 的 PR 標題由 GitHub 產生（例如 Bump vite from 7.1.12 to 7.1.13），
# 不可能符合中文描述規範，而 ruleset 的 bypass_actors 為空，無人能繞過 gate。
# 不豁免的話 security 更新會全部卡死在紅燈。
BOT_ACTORS = ('dependabot[bot]',)

TITLE_RE = re.compile(r'^(?:%s): (.+)$' % '|'.join(TYPES))
CJK_RE = re.compile(r'[一-鿿]')

# 只擋整句都是填充詞的描述。帶了具體資訊的長描述不受影響。
VAGUE_RE = re.compile(
    r'^(更新|修改|調整|優化|修正|重構|整理|處理)(了)?'
    r'(一下|一些|些許|部分|若干)?(的)?'
    r'(程式碼|內容|檔案|東西|問題|設定|地方|bug|BUG)*$'
)

MIN_LEN, MAX_LEN = 8, 50
REQUIRED_SECTIONS = ('## 變更內容', '## 驗證方式')

errors: list[str] = []


def fail(message: str, hint: str = '') -> None:
    errors.append(message if not hint else f'{message}\n{hint}')


def check_title(title: str) -> None:
    match = TITLE_RE.match(title)
    if not match:
        fail(
            f'PR 標題不符格式：{title}',
            f'格式為 <type>: <中文描述>，type 可用：{"、".join(TYPES)}',
        )
        return

    desc = match.group(1).strip()
    stripped = re.sub(r'[\s，。、,.!?！？]', '', desc)

    if len(desc) < MIN_LEN:
        fail(f'描述只有 {len(desc)} 字，至少要 {MIN_LEN} 字：{desc}')
    if len(desc) > MAX_LEN:
        fail(f'描述有 {len(desc)} 字，最多 {MAX_LEN} 字：{desc}')
    if not CJK_RE.search(desc):
        fail(f'描述要有中文：{desc}', '套件名、指令名保留原文即可，整句英文不行。')
    if VAGUE_RE.match(stripped):
        fail(f'描述沒有資訊量：{desc}', '寫「做了什麼」，不要只寫「更新」「調整」。')


def check_body(body: str) -> None:
    missing = [s for s in REQUIRED_SECTIONS if s not in body]
    if missing:
        fail(
            f'develop → main 的 PR 內文缺少段落：{"、".join(missing)}',
            '這種 PR 的內文會成為 main 上的 commit message，見 .github/pull_request_template.md',
        )


def main() -> int:
    actor = os.environ.get('ACTOR', '')
    if actor in BOT_ACTORS:
        print(f'PR 由 {actor} 開啟，略過標題格式檢查。')
    else:
        check_title(os.environ.get('TITLE', ''))

    if os.environ.get('BASE') == 'main':
        check_body(os.environ.get('BODY') or '')

    for error in errors:
        head, _, rest = error.partition('\n')
        print(f'::error::{head}')
        if rest:
            print(rest)

    if errors:
        return 1

    print('標題與內文格式通過。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
