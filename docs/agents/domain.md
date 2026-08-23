# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** at the repo root — system-wide decisions. Read ADRs that touch the area you're about to work in.
- **`apps/<name>/docs/adr/`** — context-scoped decisions for a single app.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a **multi-context** repo — a pnpm workspace whose contexts are the packages under `apps/*`, not folders under a root `src/`. There is no root `src/`; wherever the upstream skills say `src/<context>/`, read it as `apps/<name>/`.

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── apps/
    ├── harness/
    │   ├── CONTEXT.md
    │   ├── docs/adr/                  ← context-specific decisions
    │   └── src/
    └── web/
        ├── CONTEXT.md
        ├── docs/adr/
        └── src/
```

A new context is a new package under `apps/*` plus a line in `CONTEXT-MAP.md`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
