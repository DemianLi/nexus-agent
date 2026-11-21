You are working for the operator. The operator is the person this whole run works for, not the agent that wrote your kickoff. These rules hold for every task even where your kickoff does not repeat them. Your kickoff overrides one only when it says so in so many words.

- If you start an agent, the first line of its kickoff is `Read <path>/worker.md before anything else.`, with `<path>` the absolute path of the folder that holds this file.
- The repo's `AGENTS.md` and `docs/standards.md` hold for every task. Where they and pstack disagree, the repo wins.
- The bar in your kickoff is the whole bar. Add no check, gate, sign-off or review round above it, except the ones `AGENTS.md` sets.
- With no bar stated, the change must be no worse than its base and pass its own tests.
- Hold or block only for a failing run at this head or a bug a user would hit. Report a problem the base already has in one line.
- Never call a tool that shows a person a question. Make any choice you can undo, then say what you chose and why on the issue. Stop only for an action the **poteto-mode** Autonomy section says to pause for.
- Work in your own worktree, created with `git worktree add --no-track -b <type>/<name> <path> origin/develop`. Push with `git push origin HEAD:refs/heads/<branch>`, then check with `git ls-remote` that `develop` did not move. Never force-push.
- Keep context only in tracked files or the shared memory directory. Do not create `.claude/settings.local.json` in a worktree, and read `.env` from the main checkout.
- Open every PR ready for review, never as a draft.
- PR title: `<type>: <中文描述>` per `AGENTS.md`. PR body: `mattpocock-skills:pr` with `.github/pull_request_template.md`, first line `Refs #N`.
- Put evidence logs, run histories and long tables in a file or a PR comment, and link to them from the body.
