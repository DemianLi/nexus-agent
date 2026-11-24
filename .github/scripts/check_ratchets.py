from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_paths import canonical  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
BASELINE_DIR = '.github/ratchets'
LEGACY_BASELINE = '.github/ratchets.json'
SCRIPT = '.github/scripts/check_ratchets.py'
FOLDER_AWARE = 'BASELINE_DIR'
REGULAR_MODES = ('100644', '100755')
EXTENSIONS = ('.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs', '.py', '.sh', '.yml', '.yaml', '.css', '.toml')
EXCLUDED_PREFIXES = ('references/', 'vendor/', 'apps/web/src/vendor/', 'docs/')
EXCLUDED_PARTS = ('/fixtures/', '/__snapshots__/')
EXEMPT = {'.github/scripts/check_ratchets.py', '.github/scripts/test_check_ratchets.py'}

DSH = re.compile(r'(?i)(?<![a-z0-9_])dsh(?![a-z0-9_])|deepseek[-_ ]?harness')
COMMENT_OR_INLINE_SLASHES = re.compile(r'^\s*(?://|/\*|\*|#)|\s//\s')
NARRATIVE = re.compile(r'這張 ?PR|這張卡|本 ?PR|原本寫|(?<!還)原先')
def reference_lines(text: str) -> int:
    return sum(1 for line in text.split('\n') if DSH.search(line))


RULES = {'dsh': '程式碼裡的 dsh 引用', 'narrative': '註解裡的變更敘事用語'}
Counts = dict[str, dict[str, int]]


class BaselineError(Exception):
    pass


def directory(path: str) -> str:
    parts = canonical(path).split('/')
    if parts[0] in ('apps', 'packages') and len(parts) > 2:
        return '/'.join(parts[:2])
    return parts[0] if len(parts) > 1 else '.'


def scanned(path: str) -> bool:
    path = canonical(path)
    if not path.endswith(EXTENSIONS) or path in EXEMPT:
        return False
    if path.startswith(EXCLUDED_PREFIXES):
        return False
    return not any(part in f'/{path}' for part in EXCLUDED_PARTS)


def measure(root: Path, files: list[str]) -> dict[str, dict[str, int]]:
    counts = {rule: Counter() for rule in RULES}
    for path in files:
        if not scanned(path):
            continue
        try:
            text = (root / path).read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError):
            continue
        key = directory(path)
        for line in text.split('\n'):
            if DSH.search(line):
                counts['dsh'][key] += 1
            if COMMENT_OR_INLINE_SLASHES.search(line) and NARRATIVE.search(line):
                counts['narrative'][key] += 1
    return {rule: dict(sorted(c.items())) for rule, c in counts.items()}


def compare(
    actual: dict[str, dict[str, int]],
    baseline: dict[str, dict[str, int]],
    base: dict[str, dict[str, int]] | None,
) -> list[str]:
    errors: list[str] = []
    for rule, label in RULES.items():
        have = actual.get(rule, {})
        want = baseline.get(rule, {})
        for key in sorted(set(have) | set(want)):
            n, b = have.get(key, 0), want.get(key, 0)
            if n > b:
                errors.append(f'{label}：{key} 有 {n} 處，基準是 {b}。新增的要拿掉。')
            elif n < b:
                errors.append(f'{label}：{key} 降到 {n} 處，把 {baseline_path(key)} 的基準從 {b} 調成 {n}（check_ratchets.py --write）。')
        if base is None:
            continue
        before = base.get(rule, {})
        for key, b in sorted(want.items()):
            if b > before.get(key, 0):
                errors.append(f'{label}：{key} 的基準從 {before.get(key, 0)} 調高到 {b}。基準只能降。')
    return errors


def baseline_path(key: str) -> str:
    return f'{BASELINE_DIR}/{"_root" if key == "." else key.replace("/", "__")}.json'


def key_of(path: str) -> str:
    name = path.rsplit('/', 1)[-1].removesuffix('.json')
    if name == '_root':
        return '.'
    head, sep, rest = name.partition('__')
    return f'{head}/{rest}' if sep and rest and head in ('apps', 'packages') else name


def parse_file(text: str, label: str) -> dict[str, int]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise BaselineError(f'{label} 不是合法的 JSON：{e}') from e
    if not isinstance(data, dict) or set(data) != set(RULES) or not all(
        isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in data.values()
    ):
        raise BaselineError(f'{label} 的內容要剛好是 {sorted(RULES)} 兩個非負整數。')
    return data


def assemble(files: dict[str, str]) -> Counts:
    counts: Counts = {rule: {} for rule in RULES}
    keys = [key_of(path) for path in files]
    if len(set(keys)) != len(keys):
        raise BaselineError(f'有兩個基準檔對到同一個目錄：{sorted(files)}')
    for path, text in sorted(files.items()):
        data = parse_file(text, path)
        for rule in RULES:
            if data[rule]:
                counts[rule][key_of(path)] = data[rule]
    return counts


def read_baseline(root: Path) -> Counts:
    folder = root / BASELINE_DIR
    legacy = root / LEGACY_BASELINE
    if legacy.exists() or legacy.is_symlink():
        raise BaselineError(f'{LEGACY_BASELINE} 是舊格式的基準，要刪掉，只留 {BASELINE_DIR}/。')
    if folder.is_symlink():
        raise BaselineError(f'{BASELINE_DIR} 是連結，基準只收一般資料夾。')
    files = {}
    for p in sorted(folder.glob('*.json')):
        if p.is_symlink() or not p.is_file():
            raise BaselineError(f'{BASELINE_DIR}/{p.name} 不是一般檔，基準只收一般檔。')
        files[f'{BASELINE_DIR}/{p.name}'] = p.read_text(encoding='utf-8')
    return assemble(files)


def write_baseline(root: Path, actual: Counts) -> list[str]:
    folder = root / BASELINE_DIR
    folder.mkdir(parents=True, exist_ok=True)
    keys = {k for rule in RULES for k in actual[rule]}
    changed: list[str] = []
    for key in sorted(keys):
        path = root / baseline_path(key)
        text = json.dumps({rule: actual[rule].get(key, 0) for rule in RULES}, ensure_ascii=False, indent=2) + '\n'
        if not path.exists() or path.read_text(encoding='utf-8') != text:
            path.write_text(text, encoding='utf-8')
            changed.append(baseline_path(key))
    for path in sorted(folder.glob('*.json')):
        if f'{BASELINE_DIR}/{path.name}' not in {baseline_path(k) for k in keys}:
            path.unlink()
            changed.append(f'{BASELINE_DIR}/{path.name}（已刪）')
    return changed


def tracked(root: Path) -> list[str]:
    out = subprocess.run(['git', 'ls-files', '-z'], cwd=root, capture_output=True, check=True).stdout
    return [p for p in out.decode('utf-8').split('\0') if p]


def git(root: Path, *args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(['git', *args], cwd=root, capture_output=True)


def tree_entries(root: Path, rev: str, spec: str) -> list[tuple[str, str, str]]:
    listed = git(root, 'ls-tree', '-z', rev, '--', spec)
    if listed.returncode != 0:
        raise BaselineError(f'讀不到 {rev}：{listed.stderr.decode("utf-8", "replace").strip()}')
    try:
        records = listed.stdout.decode('utf-8').split('\0')
    except UnicodeDecodeError as e:
        raise BaselineError(f'{rev} 的 {spec} 底下有不是 UTF-8 的檔名。') from e
    entries = []
    for record in records:
        if record:
            meta, path = record.split('\t', 1)
            mode, kind, _ = meta.split(' ')
            entries.append((mode, kind, path))
    return entries


def regular_blob(root: Path, rev: str, entry: tuple[str, str, str]) -> str:
    mode, kind, path = entry
    if kind != 'blob' or mode not in REGULAR_MODES:
        raise BaselineError(f'{rev}:{path} 不是一般檔（模式 {mode}），基準只收一般檔。')
    shown = git(root, 'show', f'{rev}:{path}')
    if shown.returncode != 0:
        raise BaselineError(f'讀不到 {rev}:{path}')
    try:
        return shown.stdout.decode('utf-8')
    except UnicodeDecodeError as e:
        raise BaselineError(f'{rev}:{path} 不是 UTF-8。') from e


def baseline_at(root: Path, rev: str) -> Counts | None:
    folder = tree_entries(root, rev, BASELINE_DIR)
    legacy = tree_entries(root, rev, LEGACY_BASELINE)
    script = git(root, 'show', f'{rev}:{SCRIPT}')
    if folder and (folder[0][1] != 'tree' or folder[0][0] != '040000'):
        raise BaselineError(f'{rev}:{BASELINE_DIR} 不是資料夾（模式 {folder[0][0]}），基準只收一般資料夾。')
    if folder and legacy:
        raise BaselineError(f'{rev} 的 {BASELINE_DIR}/ 與 {LEGACY_BASELINE} 並存，只能留一份。')
    if legacy:
        if script.returncode == 0 and FOLDER_AWARE in script.stdout.decode('utf-8', 'replace'):
            raise BaselineError(f'{rev} 的 {SCRIPT} 讀的是 {BASELINE_DIR}/，不該還有 {LEGACY_BASELINE}。')
        return parse_legacy(rev, regular_blob(root, rev, legacy[0]))
    if folder:
        entries = [e for e in tree_entries(root, rev, f'{BASELINE_DIR}/') if e[2].endswith('.json')]
        return assemble({path: regular_blob(root, rev, (mode, kind, path)) for mode, kind, path in entries})
    if script.returncode == 0:
        return {rule: {} for rule in RULES}
    print(f'{rev} 還沒有 {SCRIPT}，略過「基準只能降」的比對。')
    return None


def parse_legacy(rev: str, text: str) -> Counts:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise BaselineError(f'{rev}:{LEGACY_BASELINE} 不是合法的 JSON：{e}') from e
    if not isinstance(data, dict) or not all(isinstance(data.get(rule, {}), dict) for rule in RULES):
        raise BaselineError(f'{rev}:{LEGACY_BASELINE} 的格式不對。')
    return {rule: dict(data.get(rule, {})) for rule in RULES}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--write', action='store_true', help='照現況重寫基準')
    parser.add_argument('--base', help='基準不能比這一版高')
    args = parser.parse_args()

    actual = measure(ROOT, tracked(ROOT))
    if args.write:
        changed = write_baseline(ROOT, actual)
        print(f'已更新 {len(changed)} 個基準檔。' + ''.join(f'\n  {c}' for c in changed))
        return 0

    try:
        baseline = read_baseline(ROOT)
        base = None
        if args.base is not None:
            if not args.base.strip():
                raise BaselineError('--base 是空字串，沒有可比的版本。')
            base = baseline_at(ROOT, args.base)
    except BaselineError as e:
        print(f'::error::{e}')
        return 1
    errors = compare(actual, baseline, base)
    for e in errors:
        print(f'::error::{e}')
    if errors:
        return 1
    totals = '、'.join(f'{label} {sum(actual[rule].values())} 處' for rule, label in RULES.items())
    print(f'只降不升的計數通過：{totals}。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
