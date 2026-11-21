---
name: no-comments
description: "Spawn Comment Sicko, fix accepted findings, and offer encodings for claimed constraints."
disable-model-invocation: true
---

# No comments

In Claude Code, read [the Claude Code adapter](../../docs/harness/claude-code.md) once per session before you follow this skill. It maps the Cursor names in pstack skills to Claude Code.

Spawn Comment Sicko. Act on accepted findings.

Defer to Comment Sicko's fresh perspective.

## Scope

Use the caller's files or diff. Otherwise use the current diff against `origin/develop`, including the working tree.

Also in scope: each factual claim in `docs/` prose the diff touches. Check that its subject, condition, and timing hold at HEAD, and correct it against the code with the `file:line` you relied on. Out of scope: `vendor/`, `references/`, fixtures and snapshots, and generated files.

## Steps

1. Spawn an `Agent` with `subagent_type: "general-purpose"`, `model: "opus"`, `effort: "high"`. The first line of its brief is `Read <pstack>/agents/comment-sicko.md and act as that agent.`, then the scope. Do not restate its rules.
2. Inspect its report and diff. Reject application-code edits, scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on our-code surprises stay actionable. Do not restore those comments. A keep survives only with proof it is about something we cannot change. Audit missed scoped lint and TypeScript suppressions. Correctness or safety suppressions stay actionable `MUST KILL`s. Restore deletions only with exact exceptions and scoped proof. Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, trace their symbol or run `/why` on it. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it. Revert and rerun one rejected report with the failure named. Reject a second, report it open, and fail `/no-comments`.
3. Fix trivial accepted flags directly by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a shape, run `/architect` once for the accepted set and surrounding code. Stop at the sketch. Architect shapes. Step 4 implements.
4. Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. The **principle-fix-root-causes** and **principle-redesign-from-first-principles** skills guide intent only. Neither authorizes widening the fence nor fixing instances outside it. Never bolt on symptom guards.
5. Constraint comments say `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. For the rest, encode the cheapest in-scope type, runtime check, test, or CI lint, then delete the comment. When no in-scope encoding exists, delete the comment, report the constraint open, and sketch the out-of-scope work.
6. A new or contract-changed export needs a doc comment that states its contract when the code and types cannot. Add the missing ones.
7. A deleted deepseek-harness comparison that meets the ADR bar in `AGENTS.md` becomes an ADR in the same PR. Otherwise it goes.
8. Report the deletion count with each deleted comment as `file:line`, restored comments, reruns, architect sketch, fixes, encodings, added doc comments, ADRs written, unenforced constraints, and other open work. The PR body carries this list so the operator can restore any deletion.
