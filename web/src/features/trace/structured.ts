/**
 * 結構化模式的分組：條目歸進投影的輪與呼叫，再把投影的結構列（呼叫、重試、提醒）照順序插進去。
 *
 * @module
 */

import type { ConversationState, TrajectoryView } from '@nexus/wire';
import { signalText, snapshotsOf } from '@/features/trace/trajectory-view';
import type { TraceRow, TurnHead, TraceTurn, TraceModel } from '@/features/trace/model';
import type { Item } from '@/features/trace/rows';
import { indexView, assignSlots, logicalNumbers } from '@/features/trace/slots';
import type { ViewIndex } from '@/features/trace/slots';
import { failedTools, headOf, mergeHead, foldResumes } from '@/features/trace/heads';
import { legacyGroups } from '@/features/trace/legacy';
import { snapshotPartsOf, callRowOf } from '@/features/trace/calls';

/** 結構化模式：條目歸進投影的輪與呼叫，再把投影的結構列（呼叫、重試、提醒）照順序插進去。 */
export function structuredTurns(
  state: ConversationState,
  allItems: readonly Item[],
  view: TrajectoryView,
  placeholders: ReadonlySet<number>,
): TraceModel {
  const answered = answeredApprovals(view);
  // 軌跡已經有這顆核准的結局（工具名、結局、等多久）：本地那一列說的是同一件事，留著就是同一個決定出現兩次。
  // 只擋「一個動作」的決定：一顆中斷若同時問了好幾個動作，軌跡那一格只有一個工具名，本地那一列才說得全。
  const items = allItems.filter(
    ({ entry }) =>
      !(entry.kind === 'decision' && entry.actions.length === 1 && answered.has(entry.id)),
  );
  const index = indexView(view);
  const snapshotParts = snapshotPartsOf(snapshotsOf(state));
  const slots = assignSlots(
    items.map((item) => item.entry),
    view,
    index,
  );

  // 歸位：每輪一個「開頭」袋（呼叫之前的列）、每次呼叫一個袋。
  const pre = view.turns.map(() => [] as TraceRow[]);
  const byCall = view.turns.map((turn) => turn.calls.map(() => [] as TraceRow[]));
  const callTarget = view.turns.map((turn) => turn.calls.map((): string | undefined => undefined));
  const leading: Item[] = [];
  const trailing: Item[] = [];
  let seenSlot = false;
  const anyMapped = slots.some((slot) => slot !== undefined);
  items.forEach((item, i) => {
    const slot = slots[i];
    if (slot === undefined) {
      // 一則都歸不進去時，已載入的是最新的幾頁、比投影的窗口新（投影還沒跟上），所以算在後面。
      (seenSlot || !anyMapped ? trailing : leading).push(item);
      return;
    }
    seenSlot = true;
    const rows = item.rows.map((row) => withToolFact(row, index));
    const bag = slot.call === undefined ? pre[slot.turn] : byCall[slot.turn]?.[slot.call];
    bag?.push(...rows);
    if (slot.call !== undefined && item.entry.kind === 'ai') {
      const targets = callTarget[slot.turn];
      if (targets !== undefined && targets[slot.call] === undefined)
        targets[slot.call] = item.entry.id;
    }
  });

  const numbers = logicalNumbers(view);
  const groups: {
    key: string;
    seq: number;
    rows: TraceRow[];
    head: TurnHead;
    summaryOnly: boolean;
  }[] = [];
  view.turns.forEach((turn, t) => {
    // `resume`（核准後續接）併回前一個邏輯輪：同一輪、同一組，編號不加。
    const previous = groups.at(-1);
    const merging = !turn.logical && previous !== undefined;
    const callBase = merging ? previous.head.callCount : 0;
    const rows: TraceRow[] = [...(pre[t] ?? [])];
    const skipped = turn.elided?.calls ?? 0;
    const decisions = turn.decisions.filter((d) => d.kind !== 'compaction');
    let next = 0;
    const flushSignals = (before: number) => {
      while (next < decisions.length && (decisions[next]?.seq ?? 0) < before) {
        const decision = decisions[next];
        next += 1;
        if (decision === undefined) continue;
        rows.push({
          kind: 'signal',
          key: `signal-${decision.seq}`,
          target: undefined,
          signal: decision.kind,
          time: decision.time,
          summary: signalText(decision),
        });
      }
    };
    turn.calls.forEach((call, c) => {
      flushSignals(call.id);
      const loadedRows = byCall[t]?.[c] ?? [];
      rows.push(
        callRowOf(call, {
          n: callBase + skipped + c + 1,
          target: callTarget[t]?.[c],
          loaded: loadedRows.length > 0,
          snapshotParts,
          endCause: turn.endCause,
        }),
      );
      for (const retry of call.retries) {
        rows.push({
          kind: 'retry',
          key: `retry-${call.id}-${retry.retry}`,
          target: undefined,
          retry: retry.retry,
          maxRetries: retry.maxRetries,
          time: retry.time,
          code: retry.code,
          ...(retry.status === undefined ? {} : { status: retry.status }),
          ...(retry.waitedMs === undefined ? {} : { waitedMs: retry.waitedMs }),
        });
      }
      for (const row of loadedRows) {
        // 人的核准、人的答案是對「停下來等人」的回答：把還沒排進去的那幾顆停下來的提醒先放在它前面。
        if (row.kind === 'decision' || row.kind === 'answer') {
          const lastInterrupt = decisions.findLastIndex(
            (d, i) => i >= next && d.kind === 'interrupt',
          );
          if (lastInterrupt >= 0) flushSignals((decisions[lastInterrupt]?.seq ?? 0) + 1);
        }
        rows.push(row);
      }
    });
    flushSignals(Number.POSITIVE_INFINITY);
    const elidedTools = turn.elided?.tools;
    const head: TurnHead = {
      ...headOf(turn, numbers.get(turn.seq) ?? 1),
      toolErrors: failedTools(turn),
      ...(skipped > 0 ? { elidedCalls: skipped } : {}),
      ...(elidedTools !== undefined && elidedTools > 0 ? { elidedTools } : {}),
    };
    const summaryOnly = placeholders.has(turn.seq);
    if (merging) {
      previous.rows.push(...rows);
      previous.head = mergeHead(previous.head, head);
      previous.summaryOnly = previous.summaryOnly && summaryOnly;
    } else {
      groups.push({ key: `turn-${turn.seq}`, seq: turn.seq, rows, head, summaryOnly });
    }
  });
  const turns: TraceTurn[] = groups.map(({ summaryOnly, ...group }) => ({
    ...group,
    legacy: false,
    ...(summaryOnly ? { summaryOnly: true as const } : {}),
  }));

  return {
    structured: true,
    turns: [...legacyGroups(leading), ...turns, ...legacyGroups(trailing)],
    digests: foldResumes(
      view.digests.map((digest) => ({
        head: headOf(digest, numbers.get(digest.seq) ?? 1),
        logical: digest.logical,
        key: `digest-${digest.index}`,
        seq: digest.seq,
      })),
    ).map(({ head, key, seq }) => ({ ...head, key, seq })),
    omitted: view.omitted,
  };
}

/** 軌跡裡已經有結局的核准中斷，換算成本地決定列的 id（`decision-<中斷 id>`）。 */
function answeredApprovals(view: TrajectoryView): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const turn of view.turns)
    for (const decision of turn.decisions)
      if (
        decision.kind === 'interrupt' &&
        decision.id !== undefined &&
        decision.approval?.outcome !== undefined
      )
        ids.add(`decision-${decision.id}`);
  return ids;
}

function withToolFact(row: TraceRow, index: ViewIndex): TraceRow {
  if (row.kind !== 'tool') return row;
  const fact = index.tools.get(row.entry.id);
  if (fact === undefined) return row;
  return {
    ...row,
    time: fact.time,
    ...(fact.durationMs === undefined ? {} : { durationMs: fact.durationMs }),
    ...(fact.subagentRunId === undefined ? {} : { subagentRunId: fact.subagentRunId }),
    ...(fact.parentCutByClock ? { parentCutByClock: true as const } : {}),
  };
}
