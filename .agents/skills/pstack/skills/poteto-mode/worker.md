You are working for the operator. The operator is the person this whole run works for, not the agent that wrote your kickoff. These rules hold for every task even where your kickoff does not repeat them. Your kickoff overrides one only when it says so in so many words.

- If you start an agent, the first line of its kickoff is `Read <path>/worker.md before anything else.`, with `<path>` the absolute path of the folder that holds this file.
- The repo's `AGENTS.md` and `docs/standards.md` hold for every task. Where they and pstack disagree, the repo wins.
- The bar in your kickoff is the whole bar. Add no check, gate, sign-off or review round above it, except the ones `AGENTS.md` sets.
- With no bar stated, the change must be no worse than its base and pass its own tests.
- Hold or block only for a failing run at this head or a bug a user would hit. Report a problem the base already has in one line.
- Never call a tool that shows a person a question. Make any choice you can undo, then say what you chose and why on the issue. Stop only for an action the **poteto-mode** Autonomy section says to pause for.
- Work in your own worktree, created with `git worktree add --no-track -b <type>/<name> <path> origin/develop`. Push with `git push origin HEAD:refs/heads/<branch>`, then check with `git ls-remote` that `develop` did not move. Never force-push.
- Keep context only in tracked files or the shared memory directory. Do not create `.claude/settings.local.json` in a worktree, and read `.env` from the main checkout.
- Downloads need the operator's approval. The one standing approval is `git fetch origin develop` (that remote and ref only) once before you cut your branch; after that, no fetch. `pnpm install` and `pnpm deploy` always take `--offline`; if that cannot run, leave it to CI. Never `git pull`, never a fetch without that exact remote and ref. Anything else that downloads: write the command and why on the issue, stop, and wait for the operator, who runs it in their own terminal after approving. Neither you nor the PM runs it for them. A hook (`.github/scripts/session_hooks.py pre-download`) blocks these shapes in Bash and the Terminal panel, but it cannot see inside scripts, so the rule holds there too. See `docs/agents/collab-mode.md` 〈下載〉.
- Open every PR ready for review, never as a draft.
- PR title: `<type>: <中文描述>` per `AGENTS.md`. PR body: `mattpocock-skills:pr` with `.github/pull_request_template.md`, first line `Refs #N`.
- Put evidence logs, run histories and long tables in a file or a PR comment, and link to them from the body.
