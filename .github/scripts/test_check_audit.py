"""相依漏洞掃描（#1545 步驟 5、驗收 7）的單元紅燈。

在 static 跑（`python3 -m unittest discover -s .github/scripts`）。不連網：audit 一律用注入的輸出。
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import tempfile
import unittest
from datetime import date
from pathlib import Path

import plan_ci
from check_audit import EXCEPTIONS, NO_PATCH, ROOT, check, main, read_exceptions

TODAY = date(2026, 10, 21)
GHSA = 'GHSA-vfj7-8cjw-p6xm'
PATH = 'apps__harness>deepagents>micromatch>braces'


def advisory(
    ghsa: str = GHSA,
    severity: str = 'high',
    patched: str = NO_PATCH,
    paths: tuple[str, ...] = (PATH,),
    module: str = 'braces',
) -> dict:
    """`pnpm audit --json` 裡一筆 advisory 用得到的欄位。"""
    return {
        'github_advisory_id': ghsa,
        'module_name': module,
        'severity': severity,
        'patched_versions': patched,
        'title': 't',
        'findings': [{'version': '3.0.3', 'paths': list(paths)}],
    }


def audit(*advisories: dict) -> str:
    """`pnpm audit --prod --json` 的形狀。`metadata` 照 pnpm：不管例外清單一律照算，判斷不看它。"""
    return json.dumps(
        {
            'actions': [],
            'advisories': {str(index): item for index, item in enumerate(advisories, start=1)},
            'muted': [],
            'metadata': {'vulnerabilities': {'high': len(advisories)}},
        }
    )


def entry(**override: object) -> dict:
    base = {
        'advisory': GHSA,
        'paths': [PATH],
        'reason': '沒有修補版',
        'expires': '2026-12-18',
        'review': '到期前重新評估',
        'removal': '出修補版之後',
    }
    base.update(override)
    return {key: value for key, value in base.items() if value is not None}


def listed(*entries: dict) -> str:
    return json.dumps({'exceptions': list(entries)})


def run(output: str, exceptions: str, today: date = TODAY) -> list[str]:
    problems, _notices, _raw = check(lambda: output, exceptions, today)
    return problems


class Blocking(unittest.TestCase):
    def test_high_not_listed_fails(self) -> None:
        problems = run(audit(advisory()), listed())
        self.assertEqual(len(problems), 1)
        self.assertIn('不在例外清單上', problems[0])

    def test_critical_not_listed_fails(self) -> None:
        problems = run(audit(advisory(severity='critical')), listed())
        self.assertEqual(len(problems), 1)
        self.assertIn('不在例外清單上', problems[0])

    def test_high_listed_passes(self) -> None:
        # 例外清單上的那一筆，metadata 仍照算 high 1（pnpm 10.34.5 實測）；只看 advisories 才會綠。
        self.assertEqual(run(audit(advisory()), listed(entry())), [])

    def test_moderate_and_low_only_noted(self) -> None:
        output = audit(
            advisory('GHSA-2222-3333-4444', 'moderate'),
            advisory('GHSA-5555-6666-7777', 'low'),
            advisory('GHSA-2222-5555-7777', 'info'),
        )
        problems, notices, _raw = check(lambda: output, listed(), TODAY)
        self.assertEqual(problems, [])
        self.assertEqual(len(notices), 3)

    def test_unknown_severity_fails_closed(self) -> None:
        missing = advisory()
        del missing['severity']
        for item in (missing, advisory(severity='severe')):
            with self.subTest(severity=item.get('severity')):
                problems = run(audit(item), listed())
                self.assertEqual(len(problems), 1)
                self.assertIn('嚴重度認不得', problems[0])

    def test_clean_audit_passes(self) -> None:
        self.assertEqual(run(audit(), listed()), [])


class Exceptions(unittest.TestCase):
    def test_each_missing_field_fails(self) -> None:
        for field in ('advisory', 'paths', 'reason', 'expires', 'review', 'removal'):
            with self.subTest(field=field):
                problems = run(audit(advisory()), listed(entry(**{field: None})))
                self.assertTrue(any(field in problem for problem in problems), problems)

    def test_blank_reason_fails(self) -> None:
        self.assertTrue(run(audit(advisory()), listed(entry(reason='   '))))

    def test_unknown_field_fails(self) -> None:
        problems = run(audit(advisory()), listed(entry(note='x')))
        self.assertTrue(any('不認得的欄位' in problem for problem in problems), problems)

    def test_expires_is_last_valid_day(self) -> None:
        self.assertEqual(run(audit(advisory()), listed(entry()), date(2026, 12, 18)), [])
        problems = run(audit(advisory()), listed(entry()), date(2026, 12, 19))
        self.assertEqual(len(problems), 1)
        self.assertIn('到期', problems[0])

    def test_bad_date_fails(self) -> None:
        for raw in ('2026-12-32', '12/18/2026', '2026-12-1'):
            with self.subTest(raw=raw):
                self.assertTrue(run(audit(advisory()), listed(entry(expires=raw))))

    def test_not_a_ghsa_fails(self) -> None:
        # audit 裡真的有同一個編號：不檢查形狀的話，這條例外就會被接受、整個變綠。
        problems = run(audit(advisory(ghsa='CVE-2026-1')), listed(entry(advisory='CVE-2026-1')))
        self.assertTrue(any('不是 GHSA 編號' in problem for problem in problems), problems)

    def test_listed_twice_fails(self) -> None:
        problems = run(audit(advisory()), listed(entry(), entry()))
        self.assertTrue(any('兩次' in problem for problem in problems), problems)

    def test_not_an_object_fails(self) -> None:
        for text in ('[]', '{}', '{"exceptions": {}}', 'not json'):
            with self.subTest(text=text):
                _found, problems = read_exceptions(text, TODAY)
                self.assertTrue(problems)


class ListedAdvisory(unittest.TestCase):
    def test_patched_version_appears_fails(self) -> None:
        problems = run(audit(advisory(patched='>=3.0.4')), listed(entry()))
        self.assertEqual(len(problems), 1)
        self.assertIn('有修補版了', problems[0])

    def test_unlisted_path_fails(self) -> None:
        other = 'apps__harness>fast-glob>micromatch>braces'
        problems = run(audit(advisory(paths=(PATH, other))), listed(entry()))
        self.assertEqual(len(problems), 1)
        self.assertIn(other, problems[0])

    def test_stale_exception_fails(self) -> None:
        problems = run(audit(), listed(entry()))
        self.assertEqual(len(problems), 1)
        self.assertIn('已經不報了', problems[0])


class AuditOutput(unittest.TestCase):
    def test_unreadable_output_fails_closed(self) -> None:
        for output in ('', 'ERR_PNPM_AUDIT_BAD_RESPONSE', '[]', '{"error": {"code": "ENOTFOUND"}}', '{"advisories": {}}'):
            with self.subTest(output=output):
                problems = run(output, listed())
                self.assertEqual(len(problems), 1)
                self.assertIn('audit', problems[0])


class ReleaseStep(unittest.TestCase):
    """`release.yml` 的掃描步驟執行的是 `main`：讀檔、寫報告、以結束碼擋發版。"""

    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)

    def main(self, output: str, exceptions: str) -> tuple[int, Path]:
        (self.dir / 'audit.json').write_text(output, encoding='utf-8')
        (self.dir / 'exceptions.json').write_text(exceptions, encoding='utf-8')
        report = self.dir / 'out' / 'audit-report.json'
        argv = ['--audit-json', str(self.dir / 'audit.json'), '--exceptions', str(self.dir / 'exceptions.json')]
        with contextlib.redirect_stdout(io.StringIO()):
            code = main([*argv, '--out', str(report), '--today', TODAY.isoformat()])
        return code, report

    def test_unlisted_high_stops_release(self) -> None:
        code, report = self.main(audit(advisory()), listed())
        self.assertEqual(code, 1)
        self.assertTrue(report.is_file())

    def test_listed_high_writes_report(self) -> None:
        code, report = self.main(audit(advisory()), listed(entry()))
        self.assertEqual(code, 0)
        written = json.loads(report.read_text(encoding='utf-8'))
        self.assertEqual(written['checkedOn'], TODAY.isoformat())
        self.assertEqual(written['exceptions'], json.loads(listed(entry())))
        self.assertEqual(written['audit'], json.loads(audit(advisory())))


class CommittedList(unittest.TestCase):
    def test_committed_exceptions_are_well_formed(self) -> None:
        # 只驗清單本身（欄位、日期、重複），不驗到期：到期是排程該紅的事，不該讓每張 PR 跟著紅。
        _found, problems = read_exceptions(EXCEPTIONS.read_text(encoding='utf-8'), date.min)
        self.assertEqual(problems, [])

    def test_editing_the_list_runs_this_test(self) -> None:
        # 這條測試在 static 跑，static 只在全跑或有 TypeScript 異動時跑：只改清單的 PR 要被 plan 判成全跑。
        changed = EXCEPTIONS.relative_to(ROOT).as_posix()
        self.assertTrue(any(rx.search(changed) for rx in plan_ci.FULL_RES), changed)


if __name__ == '__main__':
    unittest.main()
