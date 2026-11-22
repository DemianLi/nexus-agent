---
name: tdd
description: "Use for every bug fix. The repo requires a test that reproduces the bug before the fix."
disable-model-invocation: true
---

# TDD Bug Fix

Make the broken behavior executable before changing production code. The goal is a focused regression test that fails before the fix and passes after it. `docs/standards.md` makes this mandatory for every bug fix.

## Workflow

1. **Understand the bug.** Identify the intended behavior, current behavior, affected path, and smallest observable reproduction.
2. **Choose the narrowest executable check.** Prefer the closest unit, component, integration, or regression test already used for that codepath.
3. **Write the failing test first.** Add the smallest focused test that would have caught the bug. The test should encode intended behavior, not mirror the current implementation.
4. **Run the new test before fixing.** Confirm it fails for the intended reason. If it passes or fails for an unrelated reason, correct the test or reproduction before editing the implementation.
5. **Fix the bug.** Make the smallest production change that satisfies the intended behavior while preserving nearby contracts.
6. **Rerun the regression test.** Confirm the test now passes.

## If a Failing Test Looks Impractical

A cheaper test is still a test: a targeted script under the package's test runner, a log assertion, or a focused integration check. If no executable check can reproduce the bug, stop and write why on the issue, instead of shipping the fix without one.

A bad test is one that mostly tests mocks, encodes current implementation details, or depends on timing or unrelated global state. Take the expected value from a source other than the code under test, per `docs/standards.md`.

## Guardrails

- Do not change tests merely to match a wrong implementation.
- Do not weaken existing assertions unless the expected behavior has genuinely changed and the reason is clear.
- Keep the regression test focused on the bug. Avoid broad fixture churn or unrelated coverage expansion.
- If the bug is flaky, make the test deterministic where possible and document the signal being locked down.
- If the bug exposes a broader class of failures, first land the focused regression path, then consider additional sibling coverage.

## Final Response

Report the evidence, not just the outcome:

- Name the failing-before test or executable check and the failure it produced.
- Name the passing-after test run and any nearby validation performed.
