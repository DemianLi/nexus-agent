from __future__ import annotations

import json
import re
import sys
from typing import NamedTuple

from shell_downloads import check_command

SKILL_MD = '.agents/skills/pstack/skills/poteto-mode/SKILL.md'


class Role(NamedTuple):
    table_row: str
    title_word: str
    model: str
    effort: str


ROLES = {
    'eng-': Role('Engineer', 'engineer', 'sonnet', 'medium'),
    'ver-': Role('Verifier', 'verifier', 'opus', 'medium'),
}

MIN_GENERATION = 5

NOTES_RULE = re.compile(r'不讀不寫[^\n]*notes')
DOWNLOAD_RULE = re.compile(r'下載[^\n]*核可')
DOWNLOAD_HELP = '寫在卡上、停下，等 operator 核可，核可後由 operator 自己在終端跑；agent 與 PM 不代跑（docs/agents/collab-mode.md〈下載〉）。'

CLOSING_PREFIXES = ('可封存', '不可封存', '還在等')
WAITING = '還在等'
CLOSING_LINE = re.compile(rf'^({"|".join(CLOSING_PREFIXES)})[：:]')


def model_matches(got: str, family: str) -> bool:
    if got == family:
        return True
    m = re.fullmatch(rf'claude-{family}-(\d+)(?:-\d+)*(?:\[\w+\])?', got)
    return bool(m) and int(m.group(1)) >= MIN_GENERATION


def role_for(tool_input: dict) -> tuple[str, Role] | None:
    name = tool_input.get('name') or ''
    title = (tool_input.get('title') or '').lower()
    for prefix, role in ROLES.items():
        if name.startswith(prefix) or (not name and re.match(rf'{role.title_word}(?![a-z])', title)):
            return prefix, role
    return None


def check_start_session(tool_input: dict) -> str | None:
    found = role_for(tool_input)
    if found is None:
        return None
    prefix, role = found
    name = tool_input.get('name') or ''
    where = f'角色表在 {SKILL_MD}〈Subagents〉，開法在 docs/agents/collab-mode.md〈開場說明〉。'
    if not name.startswith(prefix):
        return f'{role.table_row} 的 session 要給 `name`，以 `{prefix}` 開頭。{where}'
    if tool_input.get('context') == 'fork' or tool_input.get('target') == 'cloud':
        return f'`{name}` 是 {role.table_row}，要用 `context: "fresh"` 在本機開：fork 會帶進 PM 的對話，cloud 不吃 model 與 effort。{where}'
    extra = [k for k in ('cwd', 'host') if tool_input.get(k)]
    if extra:
        return f'`{name}` 是 {role.table_row}，不帶 {"、".join(f"`{k}`" for k in extra)}：子 session 要從 PM 所在的主 checkout 起跑。{where}'
    if tool_input.get('use_worktree') is not False:
        return f'`{name}` 是 {role.table_row}，要明確給 `use_worktree: false`：worktree 由 session 自己照 worker.md 開。{where}'
    prompt = tool_input.get('prompt')
    if prompt is not None and not NOTES_RULE.search(prompt):
        return f'`{name}` 是 {role.table_row}，開場要寫一句「不讀不寫 app 給的共用 notes 目錄」。{where}'
    if prompt is not None and not DOWNLOAD_RULE.search(prompt):
        return f'`{name}` 是 {role.table_row}，開場要寫一句下載規則：只有開分支前一次 `git fetch origin develop`，其餘下載先寫在卡上等 operator 核可。{where}'
    got_model = tool_input.get('model') or ''
    got_effort = tool_input.get('effort') or ''
    if model_matches(got_model, role.model) and got_effort == role.effort:
        return None
    return (
        f'`{name}` 是 {role.table_row}，要用 model `{role.model}`（第 {MIN_GENERATION} 代以後的 id 也行）、effort `{role.effort}`，'
        f'這次是 model `{got_model or "（沿用）"}`、effort `{got_effort or "（沿用）"}`。{where}'
    )


def check_download(tool_input: dict) -> str | None:
    command = tool_input.get('command')
    if not isinstance(command, str):
        return None
    reason = check_command(command)
    if reason is None:
        return None
    return f'下載要 operator 核可：{reason}。{DOWNLOAD_HELP}'


def check_closing(reply: str | None) -> str | None:
    if reply is None:
        return None
    lines = [l for l in reply.splitlines() if l.strip()]
    first = re.sub(r'^[\s>#*_`-]+', '', lines[0] if lines else '').replace('**', '')
    m = CLOSING_LINE.match(first)
    if m and (m.group(1) != WAITING or len(lines) == 1):
        return None
    if m:
        return f'`{WAITING}：` 的回合只寫這一行（AGENTS.md〈收尾〉）。狀態有變就改寫成另外兩種。'
    allowed = '、'.join(f'`{p}：`' for p in CLOSING_PREFIXES)
    return f'最後那段話的第一句要以 {allowed} 之一開頭（AGENTS.md〈收尾〉）。補上這一句再結束。'


def main(argv: list[str]) -> int:
    try:
        event = json.load(sys.stdin)
        if argv[1:] == ['pre-start-session']:
            reason = check_start_session(event.get('tool_input') or {})
        elif argv[1:] == ['pre-download']:
            reason = check_download(event.get('tool_input') or {})
        elif argv[1:] == ['stop']:
            if event.get('stop_hook_active'):
                return 0
            reason = check_closing(event.get('last_assistant_message'))
        else:
            raise ValueError(f'unknown hook {argv[1:]}')
    except Exception as e:
        print(f'session_hooks.py 出錯，放行：{e!r}', file=sys.stderr)
        return 0
    if reason:
        print(reason, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
