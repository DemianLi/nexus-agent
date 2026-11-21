### Opening a PR

Invoked at the end of every other playbook.

Work from your own worktree off `origin/develop`, and keep unrelated work out of it. Keep small, landable commits. Run **no-comments** over the diff before you open the PR and before every later push.

Title: `<type>: <中文描述>`, per `AGENTS.md` (the `gate` check enforces it). Body: `mattpocock-skills:pr` with `.github/pull_request_template.md`. First line `Refs #N`, never `Closes`. Evidence lists only commands you actually ran, with their results.

Never stack PRs. Open the PR ready with `gh pr create` without `--draft`. Opening a PR does not start a babysit.
