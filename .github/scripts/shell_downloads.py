from __future__ import annotations

import re
from typing import NamedTuple

FETCH_OK_ARGS = ('origin', 'develop')
FETCH_OK_OPTIONS = frozenset({'-q', '--quiet'})

WRAPPERS = frozenset({'env', 'command', 'sudo', 'nohup', 'time', 'exec', 'builtin', 'rtk', 'proxy', 'xargs', 'nice', 'timeout'})
LEADING_KEYWORDS = frozenset({'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'for'})
SHELLS = frozenset({'sh', 'bash', 'zsh', 'dash', 'ksh'})
GIT_VALUE_OPTIONS = frozenset({'-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'})
PNPM_VALUE_OPTIONS = frozenset({'-C', '--dir', '--filter', '-F', '--config', '--reporter', '--loglevel', '--workspace-concurrency'})
ASSIGNMENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*=')
HEREDOC_OP = re.compile(r'<<-?$')
MAX_DEPTH = 4


class Word(NamedTuple):
    text: str
    quoted: bool = False


def _substitutions(text: str) -> list[str]:
    found = re.findall(r'\$\(([^()]*)\)', text)
    found += re.findall(r'`([^`]*)`', text)
    return found


def tokenize(command: str) -> tuple[list[list[Word]], list[str]]:
    segments: list[list[Word]] = [[]]
    nested: list[str] = []
    i, n = 0, len(command)
    buf: list[str] = []
    quoted = False
    in_word = False
    skip_next_word = False
    heredocs: list[str] = []

    def flush() -> None:
        nonlocal buf, quoted, in_word, skip_next_word
        if in_word:
            word = Word(''.join(buf), quoted)
            if skip_next_word:
                skip_next_word = False
            else:
                segments[-1].append(word)
        buf, quoted, in_word = [], False, False

    def cut() -> None:
        flush()
        if segments[-1]:
            segments.append([])

    while i < n:
        c = command[i]
        if c == '\\':
            if i + 1 < n and command[i + 1] == '\n':
                i += 2
                continue
            in_word = True
            if i + 1 < n:
                buf.append(command[i + 1])
            i += 2
            continue
        if c == "'":
            j = command.index("'", i + 1)
            in_word, quoted = True, True
            buf.append(command[i + 1:j])
            i = j + 1
            continue
        if c == '"':
            j = i + 1
            part: list[str] = []
            while j < n and command[j] != '"':
                if command[j] == '\\' and j + 1 < n:
                    part.append(command[j + 1])
                    j += 2
                    continue
                part.append(command[j])
                j += 1
            if j >= n:
                raise ValueError('unclosed double quote')
            text = ''.join(part)
            nested += _substitutions(text)
            in_word, quoted = True, True
            buf.append(text)
            i = j + 1
            continue
        if c == '`':
            j = command.index('`', i + 1)
            nested.append(command[i + 1:j])
            cut()
            i = j + 1
            continue
        if c == '$' and command.startswith('$(', i):
            cut()
            i += 2
            continue
        if c == '#' and not in_word:
            while i < n and command[i] != '\n':
                i += 1
            continue
        if c == '\n':
            flush()
            if heredocs:
                i += 1
                for delim in heredocs:
                    while i < n:
                        end = command.find('\n', i)
                        line = command[i:] if end < 0 else command[i:end]
                        i = n if end < 0 else end + 1
                        if line.strip() == delim:
                            break
                heredocs = []
                cut()
                continue
            cut()
            i += 1
            continue
        if c in ' \t':
            flush()
            i += 1
            continue
        if c in ';&|()':
            if c == '&' and command[i + 1:i + 2] == '>':
                i += 1
                continue
            cut()
            i += 1
            while i < n and command[i] in ';&|' and c != '(' and c != ')':
                i += 1
            continue
        if c in '<>':
            if in_word and not quoted and ''.join(buf).isdigit():
                buf, in_word = [], False
            else:
                flush()
            j = i
            while j < n and command[j] in '<>':
                j += 1
            op = command[i:j]
            if j < n and command[j] == '&':
                j += 1
            if HEREDOC_OP.match(op):
                k = j
                while k < n and command[k] in ' \t':
                    k += 1
                m = re.match(r'''(['"]?)([^\s'";&|()<>]+)\1''', command[k:])
                if m:
                    heredocs.append(m.group(2))
                    j = k + m.end()
            else:
                skip_next_word = True
            i = j
            continue
        in_word = True
        buf.append(c)
        i += 1
    flush()
    return [s for s in segments if s], nested


def _strip_prefix(words: list[Word]) -> list[Word]:
    i = 0
    while i < len(words):
        w = words[i].text
        if not words[i].quoted and (w in LEADING_KEYWORDS or ASSIGNMENT.match(w)):
            i += 1
        elif w in WRAPPERS and not words[i].quoted:
            i += 1
            while i < len(words) and (words[i].text.startswith('-') or ASSIGNMENT.match(words[i].text) or (words[i - 1].text == 'timeout' and re.fullmatch(r'[\d.]+[smhd]?', words[i].text))):
                i += 1
        else:
            break
    return words[i:]


def _subcommand(args: list[str], value_options: frozenset[str]) -> tuple[str | None, list[str]]:
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith('-'):
            i += 2 if a in value_options else 1
            continue
        return a, args[i + 1:]
    return None, []


def _check_git(args: list[str]) -> str | None:
    sub, rest = _subcommand(args, GIT_VALUE_OPTIONS)
    if sub == 'pull':
        return '`git pull` 會下載：改成開分支前一次 `git fetch origin develop`，其他情況先申請核可'
    if sub == 'fetch':
        options = [a for a in rest if a.startswith('-')]
        positional = [a for a in rest if not a.startswith('-')]
        if tuple(positional) == FETCH_OK_ARGS and all(o in FETCH_OK_OPTIONS for o in options):
            return None
        return '`git fetch` 只放行 `git fetch origin develop`（只這個 remote、這個 ref）'
    if sub == 'remote' and rest[:1] == ['update']:
        return '`git remote update` 會抓所有 remote'
    return None


def _check_pnpm(args: list[str]) -> str | None:
    sub, rest = _subcommand(args, PNPM_VALUE_OPTIONS)
    if sub in ('install', 'i', 'deploy') and not any(a in ('--offline', '--offline=true') for a in args):
        return f'`pnpm {sub}` 要加 `--offline`，跑不起來交給 CI'
    return None


def _check_segment(words: list[Word], depth: int) -> str | None:
    words = _strip_prefix(words)
    if not words:
        return None
    head = words[0].text.rsplit('/', 1)[-1]
    args = [w.text for w in words[1:]]
    if head == 'git':
        return _check_git(args)
    if head == 'pnpm':
        return _check_pnpm(args)
    if head in SHELLS and '-c' in args[:3]:
        k = args.index('-c')
        if k + 1 < len(args):
            return check_command(args[k + 1], depth + 1)
    if head == 'eval' and args:
        return check_command(' '.join(args), depth + 1)
    return None


def check_command(command: str, depth: int = 0) -> str | None:
    if depth > MAX_DEPTH:
        return None
    try:
        segments, nested = tokenize(command)
    except ValueError:
        if depth == 0:
            raise
        return None
    for segment in segments:
        reason = _check_segment(segment, depth)
        if reason:
            return reason
    for text in nested:
        reason = check_command(text, depth + 1)
        if reason:
            return reason
    return None
