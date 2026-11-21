### Feature

**You own the design and the diff. Plan, build, verify.** The verifier the PM starts gives the review separation, so you write the code yourself.

1. Trace the affected subsystem.
2. `architect` for the shape.
3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Gates run before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Default to splitting the target (the **separate-before-serializing-shared-state** principle skill). Serialize only for real invariants.
   - **Smallest safe decomposition.** If one worker is best, name why.
4. Write the code yourself within the issue's scope. Name the data shape and its organizing structure per **principle-model-the-domain** before you write logic: a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each. Commit liberally.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
6. Keep small, ordered commits. Follow-ups become new issues, never a stacked PR.
   Use the **sequence-verifiable-units** principle skill, building, verifying, and committing each small unit before the next.
7. If the design is contested, make the reversible choice, record it per the **poteto-mode** Non-negotiables, and go on.
8. Run **Opening a PR**.

One issue is one engineer. Fan out to subagents only for slices that produce independent artifacts, such as inventories or test runs. Rewrite the checkpoint at phase boundaries.

**Reply:** what you built, what you chose and why, the throughput checkpoint, open decisions. Tables for design alternatives.
