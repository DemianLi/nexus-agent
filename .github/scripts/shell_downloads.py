from __future__ import annotations

import re
from typing import NamedTuple

FETCH_OK_ARGS = ('origin', 'develop')
FETCH_OK_OPTIONS = frozenset({'-q', '--quiet'})

PLACEHOLDER = '\x00'
MAX_DEPTH = 12
TOO_DEEP = '指令疊得太深，判斷不了，一律當成可能下載'

WRAPPER_VALUE_OPTIONS: dict[str, frozenset[str]] = {
    'env': frozenset({'-u', '-C', '-S', '--unset', '--chdir', '--split-string'}),
    'sudo': frozenset({'-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U', '-D', '--user', '--group'}),
    'nice': frozenset({'-n', '--adjustment'}),
    'timeout': frozenset({'-k', '-s', '--kill-after', '--signal'}),
    'taskpolicy': frozenset({'-c', '-d', '-g', '-t', '-l', '-p'}),
    'xargs': frozenset({'-n', '-I', '-P', '-L', '-s', '-E', '-d', '-a'}),
    'exec': frozenset({'-a'}),
    'npx': frozenset({'-p', '--package', '-c', '--call'}),
    'caffeinate': frozenset({'-t', '-w'}),
    'time': frozenset(),
    'nohup': frozenset(),
    'command': frozenset(),
    'builtin': frozenset(),
    'rtk': frozenset(),
    'proxy': frozenset(),
    'corepack': frozenset(),
    'stdbuf': frozenset(),
}
LEADING_KEYWORDS = frozenset({'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'for'})
SHELLS = frozenset({'sh', 'bash', 'zsh', 'dash', 'ksh'})
GIT_VALUE_OPTIONS = frozenset({'-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'})
GIT_REMOTE_CONFIG = re.compile(r'^(remote|url)\.', re.IGNORECASE)
PNPM_VALUE_OPTIONS = frozenset({
    '-C', '--dir', '--filter', '-F', '--filter-prod', '--config', '--reporter', '--loglevel', '--workspace-concurrency',
    '--store-dir', '--virtual-store-dir', '--registry', '--network-concurrency', '--lockfile-dir', '--modules-dir',
    '--workspace-dir', '--cache-dir', '--state-dir', '--global-dir', '--global-bin-dir', '--use-node-version', '--child-concurrency',
})
ASSIGNMENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*\+?=')
SHELL_VALUE_OPTIONS = frozenset({'-o', '+o', '-O', '+O', '--rcfile', '--init-file'})
SHELL_C_CLUSTER = re.compile(r'-[A-Za-z]*c[A-Za-z]*$')
SHELL_S_CLUSTER = re.compile(r'-[A-Za-z]*s[A-Za-z]*$')
DELIMITER_END = ' \t\n;&|()<>'


class Word(NamedTuple):
    text: str
    quoted: bool = False


class Parsed(NamedTuple):
    segments: list[list[Word]]
    heredocs: list[str]


class Scanner:
    def __init__(self, text: str) -> None:
        self.s = text
        self.n = len(text)
        self.i = 0
        self.segments: list[list[Word]] = []
        self.heredocs: list[str] = []

    def absorb(self, other: Scanner) -> None:
        self.segments += other.segments
        self.heredocs += other.heredocs

    def match_paren(self, start: int) -> int:
        depth = 0
        j = start
        while j < self.n:
            c = self.s[j]
            if c == '\\':
                j += 2
                continue
            if c == "'":
                j = self.s.index("'", j + 1) + 1
                continue
            if c == '"':
                j += 1
                while j < self.n and self.s[j] != '"':
                    j += 2 if self.s[j] == '\\' else 1
                j += 1
                continue
            if c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
                if depth == 0:
                    return j
            j += 1
        raise ValueError('unclosed parenthesis')

    def paren_kind(self, at: int) -> tuple[bool, int]:
        end = self.match_paren(at)
        arithmetic = end - 1 > at + 1 and self.s[end - 1] == ')' and self.match_paren(at + 1) == end - 1
        return arithmetic, end

    def arithmetic_body(self, at: int, end: int) -> None:
        sub = Scanner(self.s[at + 2:end - 1])
        sub.read_dq(None)
        self.absorb(sub)
        self.i = end + 1

    def bracket_arithmetic(self) -> None:
        depth = 0
        j = self.i + 1
        while j < self.n:
            if self.s[j] == '[':
                depth += 1
            elif self.s[j] == ']':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        if j >= self.n:
            raise ValueError('unclosed $[')
        sub = Scanner(self.s[self.i + 2:j])
        sub.read_dq(None)
        self.absorb(sub)
        self.i = j + 1

    def literal_until(self, terminator: str, in_dq: bool) -> None:
        while self.i < self.n:
            c = self.s[self.i]
            if c == terminator:
                self.i += 1
                return
            if c == '\\':
                self.i += 2
            elif c == '"':
                self.i += 1
                self.read_dq('"')
            elif c == "'" and not in_dq:
                self.i = self.s.index("'", self.i + 1) + 1
            elif c in '$`' and self.expand(in_dq):
                pass
            else:
                self.i += 1
        raise ValueError(f'unclosed {terminator}')

    def expand(self, in_dq: bool) -> bool:
        s = self.s
        i = self.i
        if s.startswith('$((', i):
            arithmetic, end = self.paren_kind(i + 1)
            if arithmetic:
                self.arithmetic_body(i + 1, end)
            else:
                self.i += 2
                self.scan_list(')')
        elif s.startswith('$(', i):
            self.i += 2
            self.scan_list(')')
        elif s.startswith('${', i):
            self.i += 2
            self.literal_until('}', in_dq)
        elif s.startswith('$[', i):
            self.bracket_arithmetic()
        elif s[i] == '`':
            self.backtick(in_dq)
        else:
            return False
        return True

    def command_arithmetic(self, leading: list[Word]) -> bool:
        if not self.s.startswith('((', self.i) or not all(w.text in LEADING_KEYWORDS and not w.quoted for w in leading):
            return False
        arithmetic, end = self.paren_kind(self.i)
        if arithmetic:
            self.arithmetic_body(self.i, end)
        return arithmetic

    def backtick(self, in_dq: bool) -> None:
        j = self.i + 1
        out: list[str] = []
        escapable = '`\\$"' if in_dq else '`\\$'
        while j < self.n and self.s[j] != '`':
            if self.s[j] == '\\' and j + 1 < self.n and self.s[j + 1] in escapable:
                out.append(self.s[j + 1])
                j += 2
                continue
            out.append(self.s[j])
            j += 1
        if j >= self.n:
            raise ValueError('unclosed backtick')
        sub = Scanner(''.join(out))
        sub.scan_list(None)
        self.absorb(sub)
        self.i = j + 1

    def read_dq(self, terminator: str | None) -> str:
        out: list[str] = []
        while self.i < self.n:
            c = self.s[self.i]
            if terminator is not None and c == terminator:
                self.i += 1
                return ''.join(out)
            if c == '\\' and self.i + 1 < self.n and self.s[self.i + 1] in '$`"\\\n':
                if self.s[self.i + 1] != '\n':
                    out.append(self.s[self.i + 1])
                self.i += 2
            elif c in '$`' and self.expand(True):
                out.append(PLACEHOLDER)
            else:
                out.append(c)
                self.i += 1
        if terminator is not None:
            raise ValueError('unclosed double quote')
        return ''.join(out)

    def read_delimiter(self) -> tuple[str, bool]:
        while self.i < self.n and self.s[self.i] in ' \t':
            self.i += 1
        out: list[str] = []
        quoted = False
        while self.i < self.n and self.s[self.i] not in DELIMITER_END:
            c = self.s[self.i]
            if c in '\'"':
                j = self.s.index(c, self.i + 1)
                out.append(self.s[self.i + 1:j])
                self.i = j + 1
                quoted = True
            elif c == '\\' and self.i + 1 < self.n:
                out.append(self.s[self.i + 1])
                self.i += 2
                quoted = True
            else:
                out.append(c)
                self.i += 1
        return ''.join(out), quoted

    def read_heredoc_body(self, delimiter: str, quoted: bool, strip_tabs: bool) -> None:
        lines: list[str] = []
        while self.i < self.n:
            end = self.s.find('\n', self.i)
            line = self.s[self.i:] if end < 0 else self.s[self.i:end]
            self.i = self.n if end < 0 else end + 1
            if (line.lstrip('\t') if strip_tabs else line) == delimiter:
                break
            lines.append(line)
        body = '\n'.join(lines)
        self.heredocs.append(body)
        if not quoted:
            sub = Scanner(body)
            sub.read_dq(None)
            self.absorb(sub)

    def scan_list(self, end: str | None) -> None:
        cur: list[Word] = []
        buf: list[str] = []
        state = {'quoted': False, 'in_word': False, 'skip': False}
        pending: list[tuple[str, bool, bool]] = []
        depth = 0
        case = {'open': 0, 'pattern': False}

        def flush() -> None:
            if state['in_word']:
                if state['skip']:
                    state['skip'] = False
                else:
                    word = Word(''.join(buf), state['quoted'])
                    cur.append(word)
                    if not word.quoted:
                        if word.text == 'in' and len(cur) == 3 and cur[0].text == 'case':
                            case['open'] += 1
                            case['pattern'] = True
                        elif word.text == 'esac' and len(cur) == 1 and case['open']:
                            case['open'] -= 1
            buf.clear()
            state['quoted'] = False
            state['in_word'] = False

        def cut() -> None:
            flush()
            if cur:
                self.segments.append(cur[:])
                cur.clear()

        def piece(text: str, quoted: bool) -> None:
            state['in_word'] = True
            state['quoted'] = state['quoted'] or quoted
            buf.append(text)

        s = self.s
        while self.i < self.n:
            c = s[self.i]
            if case['pattern'] and not cur and state['in_word'] and not state['quoted'] and ''.join(buf) == 'esac' and c in ' \t\n;)':
                case['open'] -= 1
                case['pattern'] = False
                state['skip'] = True
            if end is not None and c == end and not (c == ')' and (depth or case['pattern'])):
                cut()
                self.i += 1
                return
            if c == '\\':
                if self.i + 1 < self.n and s[self.i + 1] == '\n':
                    self.i += 2
                    continue
                piece(s[self.i + 1] if self.i + 1 < self.n else '', False)
                self.i += 2
            elif c == "'":
                j = s.index("'", self.i + 1)
                piece(s[self.i + 1:j], True)
                self.i = j + 1
            elif c == '"':
                self.i += 1
                piece(self.read_dq('"'), True)
            elif s.startswith("$'", self.i):
                j = self.i + 2
                while j < self.n and s[j] != "'":
                    j += 2 if s[j] == '\\' else 1
                if j >= self.n:
                    raise ValueError("unclosed $'")
                piece(s[self.i + 2:j], True)
                self.i = j + 1
            elif c in '$`' and self.expand(False):
                piece(PLACEHOLDER, False)
            elif c in '<>' and s.startswith('(', self.i + 1):
                self.i += 2
                self.scan_list(')')
                piece(PLACEHOLDER, False)
            elif c == '#' and not state['in_word']:
                while self.i < self.n and s[self.i] != '\n':
                    self.i += 1
            elif c == '\n':
                cut()
                self.i += 1
                for delimiter, quoted, strip_tabs in pending:
                    self.read_heredoc_body(delimiter, quoted, strip_tabs)
                pending = []
            elif c in ' \t':
                flush()
                self.i += 1
            elif c == '(' and not state['in_word'] and self.command_arithmetic(cur):
                pass
            elif c == '(' and state['in_word'] and ASSIGNMENT.fullmatch(''.join(buf)):
                self.i += 1
                self.literal_until(')', False)
                piece(PLACEHOLDER, False)
            elif c == '(' and case['pattern']:
                self.i += 1
            elif c == ')' and case['pattern']:
                cut()
                case['pattern'] = False
                self.i += 1
            elif c in ';&|()' and not (c == '&' and s.startswith('>', self.i + 1)):
                depth += 1 if c == '(' else -1 if c == ')' and depth else 0
                cut()
                start = self.i
                self.i += 1
                while c in ';&|' and self.i < self.n and s[self.i] in ';&|':
                    self.i += 1
                if case['open'] and s[start:self.i] in (';;', ';&', ';;&'):
                    case['pattern'] = True
            elif c in '<>' or c == '&':
                if c == '&':
                    self.i += 1
                if state['in_word'] and not state['quoted'] and ''.join(buf).isdigit():
                    buf.clear()
                    state['in_word'] = False
                else:
                    flush()
                j = self.i
                while j < self.n and s[j] in '<>':
                    j += 1
                op = s[self.i:j]
                if op == '<<' and j < self.n and s[j] == '-':
                    op = '<<-'
                    j += 1
                if j < self.n and s[j] == '&':
                    j += 1
                elif op.endswith('>') and j < self.n and s[j] == '|':
                    j += 1
                self.i = j
                if op in ('<<', '<<-'):
                    delimiter, quoted = self.read_delimiter()
                    pending.append((delimiter, quoted, op == '<<-'))
                else:
                    state['skip'] = True
            else:
                piece(c, False)
                self.i += 1
        flush()
        cut()
        if end is not None:
            raise ValueError('unclosed substitution')


def parse(command: str) -> Parsed:
    scanner = Scanner(command)
    scanner.scan_list(None)
    return Parsed(scanner.segments, scanner.heredocs)


def _strip_prefix(words: list[Word]) -> list[Word]:
    i = 0
    while i < len(words):
        w = words[i].text
        name = w.rsplit('/', 1)[-1]
        if ASSIGNMENT.match(w) or (not words[i].quoted and w in LEADING_KEYWORDS):
            i += 1
        elif w == 'function' and not words[i].quoted:
            i += 2
        elif name in WRAPPER_VALUE_OPTIONS:
            values = WRAPPER_VALUE_OPTIONS[name]
            i += 1
            while i < len(words) and words[i].text.startswith('-') and words[i].text != '-':
                if name == 'env' and words[i].text in ('-S', '--split-string') and i + 1 < len(words):
                    inner = [Word(t) for t in words[i + 1].text.split()]
                    return _strip_prefix(inner + words[i + 2:])
                i += 2 if words[i].text in values else 1
            if name == 'timeout' and i < len(words) and re.fullmatch(r'[\d.]+[smhd]?', words[i].text):
                i += 1
        else:
            break
    return words[i:]


def _subcommand(args: list[str], value_options: frozenset[str]) -> tuple[str | None, list[str], list[str]]:
    i = 0
    before: list[str] = []
    while i < len(args):
        a = args[i]
        if a.startswith('-'):
            if a in value_options and i + 1 < len(args):
                before += [a, args[i + 1]]
                i += 2
            else:
                before.append(a)
                i += 1
            continue
        return a, args[i + 1:], before
    return None, [], before


def _remote_config_override(before: list[str]) -> bool:
    for i, a in enumerate(before):
        if a in ('-c', '--config-env') and i + 1 < len(before) and GIT_REMOTE_CONFIG.match(before[i + 1]):
            return True
        if a.startswith('--config-env=') and GIT_REMOTE_CONFIG.match(a.split('=', 1)[1]):
            return True
    return False


def _check_git(args: list[str]) -> str | None:
    sub, rest, before = _subcommand(args, GIT_VALUE_OPTIONS)
    if sub == 'pull':
        return '`git pull` 會下載：改成開分支前一次 `git fetch origin develop`，其他情況先申請核可'
    if sub == 'fetch':
        options = [a for a in rest if a.startswith('-')]
        positional = [a for a in rest if not a.startswith('-')]
        if tuple(positional) == FETCH_OK_ARGS and all(o in FETCH_OK_OPTIONS for o in options) and not _remote_config_override(before):
            return None
        return '`git fetch` 只放行 `git fetch origin develop`（只這個 remote、這個 ref）'
    if sub == 'remote' and rest[:1] == ['update']:
        return '`git remote update` 會抓所有 remote'
    return None


def _offline(args: list[str]) -> bool:
    state = False
    for a in args:
        if a in ('--offline', '--offline=true'):
            state = True
        elif a in ('--offline=false', '--no-offline'):
            state = False
    return state


def _check_pnpm(args: list[str]) -> str | None:
    sub, _, _ = _subcommand(args, PNPM_VALUE_OPTIONS)
    if sub in ('install', 'i', 'deploy') and not _offline(args):
        return f'`pnpm {sub}` 要加 `--offline`，跑不起來交給 CI'
    return None


def _shell_script(args: list[str]) -> tuple[str | None, bool]:
    c_mode = False
    s_mode = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--':
            i += 1
            break
        if not a.startswith(('-', '+')) or a == '-':
            break
        if a in SHELL_VALUE_OPTIONS:
            i += 2
            continue
        if not a.startswith(('--', '+')) and SHELL_C_CLUSTER.match(a):
            c_mode = True
        if not a.startswith(('--', '+')) and SHELL_S_CLUSTER.match(a):
            s_mode = True
        i += 1
    if c_mode:
        return (args[i] if i < len(args) else None), False
    return None, s_mode or i >= len(args) or args[i] == '-'


def _check_segment(words: list[Word], depth: int) -> tuple[str | None, bool]:
    words = _strip_prefix(words)
    if not words:
        return None, False
    head = words[0].text.rsplit('/', 1)[-1]
    args = [w.text for w in words[1:]]
    if head == 'git':
        return _check_git(args), False
    if head == 'pnpm':
        return _check_pnpm(args), False
    if head in SHELLS:
        script, reads_stdin = _shell_script(args)
        if script is not None:
            return check_command(script, depth + 1), False
        return None, reads_stdin
    if head == 'eval' and args:
        return check_command(' '.join(args), depth + 1), False
    return None, False


def check_command(command: str, depth: int = 0) -> str | None:
    if depth > MAX_DEPTH:
        return TOO_DEEP
    try:
        parsed = parse(command)
    except RecursionError:
        return TOO_DEEP
    except ValueError:
        if depth == 0:
            raise
        return None
    stdin_shell = False
    for segment in parsed.segments:
        reason, reads_stdin = _check_segment(segment, depth)
        if reason:
            return reason
        stdin_shell = stdin_shell or reads_stdin
    if stdin_shell:
        for body in parsed.heredocs:
            reason = check_command(body, depth + 1)
            if reason:
                return reason
    return None
