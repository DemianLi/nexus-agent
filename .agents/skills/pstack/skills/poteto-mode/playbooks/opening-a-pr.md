### Opening a PR

Invoked at the end of every other playbook.

Work from your own worktree off `origin/develop`, and keep unrelated work out of it. Keep small, landable commits. Run **no-comments** over the diff before you open the PR and before every later push.

Title: `<type>: <中文描述>`, per `AGENTS.md` (the `gate` check enforces it). Body: `mattpocock-skills:pr` with `.github/pull_request_template.md`. First line `Refs #N`, never `Closes`. Evidence lists only commands you actually ran, with their results.

Never stack PRs. Open the PR ready with `gh pr create` without `--draft`. Right after it opens, in the Claude desktop app, turn on Auto-fix with `mcp__ccd_pr__set_monitor` (`auto_fix: true`, `address_comments: true`, the PR's URL) so CI failures, conflicts, and review comments wake you; never turn on auto-merge. Where that tool is absent or the permission check refuses it, say so on the issue once, do not retry, and watch CI yourself per `playbooks/babysit.md`, since nothing will wake you. With Auto-fix on, Babysit runs only when the run calls for it.
