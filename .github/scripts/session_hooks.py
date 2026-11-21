from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import NamedTuple

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
    got_model = tool_input.get('model') or ''
    got_effort = tool_input.get('effort') or ''
    if model_matches(got_model, role.model) and got_effort == role.effort:
        return None
    return (
        f'`{name}` 是 {role.table_row}，要用 model `{role.model}`（第 {MIN_GENERATION} 代以後的 id 也行）、effort `{role.effort}`，'
        f'這次是 model `{got_model or "（沿用）"}`、effort `{got_effort or "（沿用）"}`。{where}'
    )


def last_reply(transcript: Path) -> str | None:
    texts: list[str] = []
    last_kind = None
    for line in transcript.read_text(encoding='utf-8').splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = entry.get('type')
        content = (entry.get('message') or {}).get('content')
        if kind == 'user' and (isinstance(content, str) or any(
            isinstance(b, dict) and b.get('type') == 'text' for b in content or []
        )):
            texts = []
        if kind in ('user', 'assistant') and content:
            last_kind = kind
        if kind == 'assistant' and isinstance(content, list):
            texts += [b['text'] for b in content if isinstance(b, dict) and b.get('type') == 'text' and b.get('text', '').strip()]
    if last_kind != 'assistant':
        return None
    return texts[-1] if texts else None


def stop_reply(event: dict) -> str | None:
    message = event.get('last_assistant_message')
    if isinstance(message, str):
        return message
    return last_reply(Path(event['transcript_path']))


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
        elif argv[1:] == ['stop']:
            if event.get('stop_hook_active'):
                return 0
            reason = check_closing(stop_reply(event))
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
