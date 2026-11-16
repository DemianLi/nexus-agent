/**
 * 結構化模式的歸位：投影的鍵 → 位置，條目歸到哪一輪、哪一次呼叫，以及邏輯輪的編號。
 *
 * @module
 */

import type {
  ConversationEntry,
  TrajectoryTool,
  TrajectoryTurn,
  TrajectoryView,
} from '@nexus/wire';
import { stoppedByTurnClock } from '@/shared/lib/stop-cause';
import { startsTurn } from '@/shared/lib/turn-start';

/** 投影裡一個條目歸在哪一輪、哪一次呼叫（`call` 缺席＝歸不到呼叫，投影的 `looseTools` 就是這樣）。 */
interface Slot {
  readonly turn: number;
  readonly call: number | undefined;
}

interface ToolFact {
  readonly time: number;
  readonly durationMs: number | undefined;
  readonly subagentRunId: string | undefined;
  readonly parentCutByClock: boolean;
}

export interface ViewIndex {
  readonly slots: ReadonlyMap<string, Slot>;
  readonly tools: ReadonlyMap<string, ToolFact>;
}

function toolFact(tool: TrajectoryTool, parentCutByClock: boolean): ToolFact {
  return {
    time: tool.time,
    durationMs: tool.durationMs,
    subagentRunId: tool.subagent?.runId,
    parentCutByClock,
  };
}

/**
 * 這一輪連同接著它的續接輪是不是被時鐘切斷。工具可能開在核准之前、被切斷在續接那一段，所以看整組最後一段。
 */
function groupCutByClock(turns: readonly TrajectoryTurn[], index: number): boolean {
  let last = index;
  while (turns[last + 1]?.logical === false) last += 1;
  return stoppedByTurnClock(turns[last]!.endCause);
}

/** 條目鍵 → 位置。鍵的形狀見檔頭的表。 */
export function indexView(view: TrajectoryView): ViewIndex {
  const slots = new Map<string, Slot>();
  const tools = new Map<string, ToolFact>();
  view.turns.forEach((turn, t) => {
    const cutByClock = groupCutByClock(view.turns, t);
    turn.calls.forEach((call, c) => {
      const { reply } = call;
      if (reply !== undefined) {
        if (reply.messageId !== undefined)
          slots.set(`message:${reply.messageId}`, { turn: t, call: c });
        slots.set(`history-${reply.seq}`, { turn: t, call: c });
      }
      for (const tool of call.tools) {
        slots.set(`tool-${tool.callId}`, { turn: t, call: c });
        tools.set(`tool-${tool.callId}`, toolFact(tool, cutByClock));
      }
    });
    for (const tool of turn.looseTools) {
      slots.set(`tool-${tool.callId}`, { turn: t, call: undefined });
      tools.set(`tool-${tool.callId}`, toolFact(tool, cutByClock));
    }
  });
  return { slots, tools };
}

function directSlot(entry: ConversationEntry, index: ViewIndex): Slot | undefined {
  if (entry.kind === 'tool') return index.slots.get(entry.id);
  if (entry.kind === 'ai') {
    const byMessage =
      entry.messageId === undefined ? undefined : index.slots.get(`message:${entry.messageId}`);
    return byMessage ?? index.slots.get(entry.id);
  }
  return undefined;
}

/**
 * 每則條目歸到哪一輪、哪一次呼叫。`undefined` ＝ 不在投影的任何一輪裡（窗口之前，或投影還沒跟上的最新條目），
 * 由第 0 版的切法接手。規則見檔頭。
 */
export function assignSlots(
  entries: readonly ConversationEntry[],
  view: TrajectoryView,
  index: ViewIndex,
): (Slot | undefined)[] {
  const direct = entries.map((entry) => directSlot(entry, index));
  const unmappedContent = (entry: ConversationEntry) =>
    (entry.kind === 'ai' || entry.kind === 'tool') && entry.attribution.kind === 'root';
  // 每則條目「後面第一個歸得進去的條目」在哪一輪。**中間隔著歸不進去的 root 回覆或工具，就不算**：那幾則自己屬於別的組
  // （窗口之前的舊對話：人話後面跟著一串不在投影裡的回覆），不能把人話硬拉進後面那一輪。
  const nextTurn: (number | undefined)[] = new Array<number | undefined>(entries.length);
  let upcoming: number | undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    nextTurn[i] = upcoming;
    const slot = direct[i];
    if (slot !== undefined) upcoming = slot.turn;
    else if (unmappedContent(entries[i]!)) upcoming = undefined;
  }
  const lastTurn = view.turns.length - 1;
  const lastTurnHasMember = direct.some((slot) => slot?.turn === lastTurn);
  const lastDirect = direct.findLastIndex((slot) => slot !== undefined);
  const lastOpener = entries.findLastIndex(startsTurn);
  /**
   * 投影還沒跟上的最新一句：最新那一輪已開（`turn/start` 先於人話之外的任何事進日誌）、還沒有成員、還沒結束，而且這一句
   * 是整份對話最後一個開輪條目、排在所有歸得進去的條目之後。**只有最後那一句**能認領：更早的沒有鍵的人話是窗口之前的舊對話。
   */
  const claimable =
    lastTurn >= 0 &&
    view.turns[lastTurn]?.end === undefined &&
    !lastTurnHasMember &&
    lastOpener > lastDirect;
  /** 還在跑的那次呼叫：這一輪最後一次、而且回覆還沒進日誌。 */
  const inFlight = (turn: number): number | undefined => {
    const calls = view.turns[turn]?.calls ?? [];
    const last = calls.length - 1;
    return last >= 0 && calls[last]?.reply === undefined ? last : undefined;
  };
  const out: (Slot | undefined)[] = [];
  let current: Slot | undefined;
  entries.forEach((entry, i) => {
    const slot = direct[i];
    if (slot !== undefined) {
      current = slot;
    } else if (startsTurn(entry)) {
      const next = nextTurn[i];
      if (next !== undefined) {
        // 同一輪裡插進來的（人插話、子代理來信）留在原位，不退回那一輪的開頭。
        if (current?.turn !== next) current = { turn: next, call: undefined };
      } else if (claimable && i === lastOpener) {
        current = { turn: lastTurn, call: undefined };
      } else {
        current = undefined;
      }
    } else if (
      current !== undefined &&
      (entry.kind === 'ai' || entry.kind === 'tool') &&
      entry.attribution.kind === 'root'
    ) {
      // 還在吐字的回覆、還在跑的工具：歸給這一輪還在進行的那次呼叫（不只是第一次），免得回覆落地時列從段落上方跳到下方。
      const call = inFlight(current.turn);
      if (call !== undefined && (current.call === undefined || call > current.call)) {
        current = { turn: current.turn, call };
      }
    }
    out.push(current);
  });
  return out;
}

/** 投影的 turn/start seq → 第幾個邏輯輪，見 {@link TurnHead.number}。 */
export function logicalNumbers(view: TrajectoryView): ReadonlyMap<number, number> {
  const numbers = new Map<number, number>();
  let count = view.omitted;
  for (const item of [...view.digests, ...view.turns]) {
    if (item.logical) count += 1;
    numbers.set(item.seq, Math.max(count, 1));
  }
  return numbers;
}
