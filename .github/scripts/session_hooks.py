from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SKILL_MD = '.agents/skills/pstack/skills/poteto-mode/SKILL.md'

ROLES = {
    'eng-': ('Engineer', 'sonnet', 'medium'),
    'ver-': ('Verifier', 'opus', 'medium'),
}

CLOSING_PREFIXES = ('可封存', '不可封存', '還在等')


def check_start_session(tool_input: dict) -> str | None:
    if tool_input.get('proposal_id'):
        return None
    name = tool_input.get('name') or ''
    for prefix, (role, model, effort) in ROLES.items():
        if not name.startswith(prefix):
            continue
        got_model = tool_input.get('model') or ''
        got_effort = tool_input.get('effort') or ''
        if model in got_model and got_effort == effort:
            return None
        return (
            f'`{name}` 是 {role}，要用 model 含 `{model}`、effort `{effort}`，'
            f'這次是 model `{got_model or "（沿用）"}`、effort `{got_effort or "（沿用）"}`。'
            f'角色表在 {SKILL_MD}〈Subagents〉。'
        )
    return None


def last_reply(transcript: Path) -> str | None:
    texts: list[str] = []
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
        elif kind == 'assistant' and isinstance(content, list):
            texts += [b['text'] for b in content if isinstance(b, dict) and b.get('type') == 'text' and b.get('text', '').strip()]
    return texts[-1] if texts else None


def check_closing(reply: str | None) -> str | None:
    if reply is None:
        return None
    first = next((l for l in reply.splitlines() if l.strip()), '')
    first = re.sub(r'^[\s>#*_`-]+', '', first)
    if first.startswith(CLOSING_PREFIXES):
        return None
    return (
        '最後那段話的第一句要以 `可封存：`、`不可封存：` 或 `還在等：` 開頭'
        '（AGENTS.md〈收尾〉）。補上這一句再結束。'
    )


def main(argv: list[str]) -> int:
    try:
        event = json.load(sys.stdin)
        if argv[1:] == ['pre-start-session']:
            reason = check_start_session(event.get('tool_input') or {})
        elif argv[1:] == ['stop']:
            if event.get('stop_hook_active'):
                return 0
            reason = check_closing(last_reply(Path(event['transcript_path'])))
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
