"""相依漏洞掃描（#1545 步驟 5）：prod 相依有 high／critical 又不在例外清單上就紅。

    check_audit.py [--audit-json <檔>] [--out <檔>] [--today YYYY-MM-DD]

每天排程（`.github/workflows/audit.yml`）跑一次，發版（`release.yml`）在打包之前也跑一次，結果附在 Release 上。
不擋 PR（#1545 Q1 (a)）。

**偏離 dsh，理由 2（產品需求超出 dsh 的射程）。** dsh 沒有實作漏洞掃描：`687f282e` 整棵樹（排除 `node_modules`）grep
`pnpm audit|npm audit|osv-scanner|trivy|ignoreGhsas|auditConfig`，只中一份 `Status: proposed` 的筆記
（`.agents/notes/proposed/process/2026-06-11-supply-chain-and-vendor-drift.zh.md:14`：定期跑 osv-scanner 或 `pnpm audit`，
PR 動到 lockfile 時也跑）。dsh 實際只靠 GitHub 的 alert。nexus 部署在完全內網，主機上沒辦法再查一次，發版當下就要留一份結果，
所以補上排程與發版前兩處。跟那份提案不同的是不在 PR 上跑：#1545 Q1 (a) 拍板不擋 PR。掃描只在 GitHub runner 上跑，部署端不連外。

## 例外清單為什麼不用 pnpm 的 `auditConfig.ignoreGhsas`

在 pnpm 10.34.5 實測：列進 `ignoreGhsas` 的 advisory 會從 `pnpm audit --json` 的 `advisories` 消失（`muted` 也是空的），只剩
`metadata` 的計數還算它。那樣一來就看不到它的 `patched_versions`，上游出了修補版我們也不會知道。`ignoreGhsas` 是字串陣列，
也放不下理由與到期日。所以例外清單是 `.github/audit-exceptions.json`，這支腳本是唯一的判斷處：跑不帶任何忽略的
`pnpm audit --prod --json`，只看 `advisories`（`metadata` 的計數不管例外清單），再對清單逐條比。

## 什麼會紅

- prod 相依有 high 或 critical 的 advisory，不在例外清單上；
- 例外條目缺欄位、欄位是空的、到期日不是 `YYYY-MM-DD`、同一個 advisory 列兩次；
- 例外過期：`today` 晚於 `expires`（`expires` 當天仍有效）。`today` 取 UTC 日期；
- 列了例外的 advisory 有了修補版：`patched_versions` 不再是 `<0.0.0`。該升版，不該再例外；
- 列了例外的 advisory 出現在條目沒列的路徑上：例外只接受審過的那幾條路徑；
- 例外清單上的 advisory，audit 已經不報了：例外過時，該撤；
- audit 的輸出解不出來（網路錯、registry 錯）：當成不合格（fail-closed）；
- 不在例外上的 advisory，嚴重度不是認得的五級之一（含缺欄位）：同樣 fail-closed。

info、low、moderate 不擋，只列出來。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[2]
EXCEPTIONS = ROOT / '.github' / 'audit-exceptions.json'

BLOCKING = ('high', 'critical')
# 只列出、不擋的等級。pnpm 的 `metadata.vulnerabilities` 就是這五級；認不得的（含缺欄位）一律當成擋（fail-closed）。
NON_BLOCKING = ('info', 'low', 'moderate')
# `pnpm audit --json` 對沒有修補版的 advisory 寫的 `patched_versions`。
NO_PATCH = '<0.0.0'
FIELDS = ('advisory', 'paths', 'reason', 'expires', 'review', 'removal')
_GHSA_RE = re.compile(r'^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$')
_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


@dataclass(frozen=True)
class Exception_:
    advisory: str
    paths: frozenset[str]
    expires: date


@dataclass(frozen=True)
class Finding:
    advisory: str
    module: str
    severity: str
    patched: str
    paths: frozenset[str]
    title: str


def read_exceptions(text: str, today: date) -> tuple[dict[str, Exception_], list[str]]:
    """讀例外清單。回傳以 advisory 為鍵的條目，以及清單本身的問題（缺欄位、過期、重複）。"""
    problems: list[str] = []
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        return {}, [f'例外清單不是合法的 JSON：{error}']
    entries = data.get('exceptions') if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return {}, ['例外清單要是 {"exceptions": [...]}']
    found: dict[str, Exception_] = {}
    for index, entry in enumerate(entries):
        where = f'例外第 {index + 1} 條'
        if not isinstance(entry, dict):
            problems.append(f'{where} 不是物件')
            continue
        missing = [field for field in FIELDS if not entry.get(field)]
        extra = sorted(set(entry) - set(FIELDS))
        if missing:
            problems.append(f'{where} 缺欄位或是空的：{", ".join(missing)}')
        if extra:
            problems.append(f'{where} 有不認得的欄位：{", ".join(extra)}')
        if missing:
            continue
        advisory = entry['advisory']
        paths = entry['paths']
        texts = [entry[field] for field in ('advisory', 'reason', 'expires', 'review', 'removal')]
        if not all(isinstance(value, str) and value.strip() for value in texts):
            problems.append(f'{where} 的 advisory、reason、expires、review、removal 都要是非空字串')
            continue
        if not isinstance(paths, list) or not all(isinstance(path, str) and path for path in paths):
            problems.append(f'{where}（{advisory}）的 paths 要是非空字串的清單')
            continue
        if not _GHSA_RE.match(advisory):
            problems.append(f'{where} 的 advisory 不是 GHSA 編號：{advisory}')
            continue
        if not _DATE_RE.match(entry['expires']):
            problems.append(f'{where}（{advisory}）的 expires 要是 YYYY-MM-DD：{entry["expires"]}')
            continue
        try:
            expires = date.fromisoformat(entry['expires'])
        except ValueError:
            problems.append(f'{where}（{advisory}）的 expires 不是有效日期：{entry["expires"]}')
            continue
        if advisory in found:
            problems.append(f'{advisory} 在例外清單上列了兩次')
            continue
        if today > expires:
            problems.append(f'{advisory} 的例外已在 {expires.isoformat()} 到期：重審後延期或撤掉')
        found[advisory] = Exception_(advisory, frozenset(paths), expires)
    return found, problems


def read_findings(text: str) -> tuple[list[Finding], dict]:
    """解 `pnpm audit --json` 的輸出。解不出來就丟 ValueError（呼叫端當成不合格）。"""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f'audit 的輸出不是 JSON：{error}') from error
    if not isinstance(data, dict) or not isinstance(data.get('advisories'), dict) or not isinstance(
        data.get('metadata'), dict
    ):
        raise ValueError('audit 的輸出沒有 advisories／metadata，可能是 registry 錯誤')
    findings: list[Finding] = []
    for key, advisory in data['advisories'].items():
        if not isinstance(advisory, dict):
            raise ValueError(f'audit 的 advisory {key} 不是物件')
        paths = frozenset(
            path for finding in advisory.get('findings') or [] for path in finding.get('paths') or []
        )
        findings.append(
            Finding(
                advisory=str(advisory.get('github_advisory_id') or f'npm:{key}'),
                module=str(advisory.get('module_name') or '?'),
                severity=str(advisory.get('severity') or 'unknown'),
                patched=str(advisory.get('patched_versions') or ''),
                paths=paths,
                title=str(advisory.get('title') or ''),
            )
        )
    return findings, data


def judge(findings: list[Finding], exceptions: dict[str, Exception_]) -> tuple[list[str], list[str]]:
    """比對 audit 與例外清單。回傳（問題，只列出不擋的）。"""
    problems: list[str] = []
    notices: list[str] = []
    reported = {finding.advisory for finding in findings}
    for finding in sorted(findings, key=lambda f: f.advisory):
        label = f'{finding.module}（{finding.advisory}，{finding.severity}）'
        exception = exceptions.get(finding.advisory)
        if exception is None:
            if finding.severity in NON_BLOCKING:
                notices.append(f'{label}：{finding.title}')
            elif finding.severity in BLOCKING:
                problems.append(f'{label} 不在例外清單上：{finding.title}；路徑 {", ".join(sorted(finding.paths))}')
            else:
                problems.append(f'{label} 的嚴重度認不得，當成要擋：{finding.title}；路徑 {", ".join(sorted(finding.paths))}')
            continue
        if finding.patched != NO_PATCH:
            problems.append(f'{label} 有修補版了（patched_versions {finding.patched}）：升版並撤掉例外')
        unlisted = sorted(finding.paths - exception.paths)
        if unlisted:
            problems.append(f'{label} 出現在例外沒列的路徑上：{", ".join(unlisted)}')
    for advisory in sorted(set(exceptions) - reported):
        problems.append(f'{advisory} 在例外清單上，audit 已經不報了：撤掉這條例外')
    return problems, notices


def run_audit() -> str:
    """跑不帶任何忽略的 `pnpm audit --prod --json`。有發現時 pnpm 以 1 結束，所以不看結束碼，只看輸出解不解得開。"""
    result = subprocess.run(
        ['pnpm', 'audit', '--prod', '--json'],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.stderr.strip():
        print(result.stderr.strip(), file=sys.stderr)
    return result.stdout


def check(
    audit: Callable[[], str],
    exceptions_text: str,
    today: date,
) -> tuple[list[str], list[str], dict | None]:
    """整個判斷。回傳（問題，只列出不擋的，audit 原始輸出解開後的物件）。"""
    exceptions, problems = read_exceptions(exceptions_text, today)
    try:
        findings, raw = read_findings(audit())
    except ValueError as error:
        return [*problems, str(error)], [], None
    verdict, notices = judge(findings, exceptions)
    return [*problems, *verdict], notices, raw


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    parser.add_argument('--audit-json', type=Path, help='讀存下來的 `pnpm audit --prod --json` 輸出，不自己跑')
    parser.add_argument('--exceptions', type=Path, default=EXCEPTIONS, help='例外清單（預設 .github/audit-exceptions.json）')
    parser.add_argument('--out', type=Path, help='把 audit 原始輸出與這次用到的例外清單寫成一份 JSON')
    parser.add_argument('--today', type=date.fromisoformat, help='判斷到期用的日期（預設今天，UTC）')
    args = parser.parse_args(argv)

    today = args.today or datetime.now(timezone.utc).date()
    exceptions_text = args.exceptions.read_text(encoding='utf-8')
    audit = (lambda: args.audit_json.read_text(encoding='utf-8')) if args.audit_json else run_audit
    problems, notices, raw = check(audit, exceptions_text, today)

    if args.out is not None and raw is not None:
        report = {'checkedOn': today.isoformat(), 'exceptions': json.loads(exceptions_text), 'audit': raw}
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    for notice in notices:
        print(f'不擋：{notice}')
    if problems:
        for problem in problems:
            print(f'::error::{problem}')
        return 1
    print('漏洞掃描通過：prod 相依沒有例外清單以外的 high／critical。')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
