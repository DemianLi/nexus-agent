/**
 * 核准被拒之後，**線上**留下什麼。
 *
 * **基座一顆 `tools` frame 都不發**（2026-09-09 量的，[#239](https://github.com/DemianLi/nexus-agent/issues/239)
 * 收尾時順帶）：產品路徑的 tools node 有跑，但 `packages/nexus-core/src/approval.ts` 的 `wrapToolCall`
 * 在 `handler(request)` **之前**就 `interrupt()`／回 `denial()`，工具本體從沒被呼叫，基座發生命週期事件
 * 的那一段就沒進去。這跟 `hitl-wire.test.ts` 那條基座機制（`interruptOn`、tools node 從沒跑）結論相同、
 * 成因不同；跟 `ask_user_question` 的中斷也不同——那顆的 `interrupt()` 在工具本體裡，`tool-started`
 * 早就發過了（`tool-frame-classify.test.ts`、`ask-user-wire.test.ts`）。**三條路的證據不能互相引用。**
 *
 * **卡從會話日誌來**（[#297](https://github.com/DemianLi/nexus-agent/issues/297)）：圍堵在閘門之前記
 * `tool/call`、閘門回來之後記 `tool/result`，pump 照這兩顆開卡、收卡，同 dsh。所以這份組裝要跟 serve
 * 一樣接上 `attachSession`——沒接的話圍堵不記日誌，「零張卡」會在一個根本不是產品路徑的組裝上綠。
 *
 * **核准那一格是承重的對照組**：它證明線本身收得到基座的 `tools` frame，拒絕那條的「基座零顆」才不是
 * 因為線收不到。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { NexusPlugin } from '@nexus/core';
import type { ConversationState, Event, ToolEntry, WireClient } from '@nexus/wire';
import {
  appendDecision,
  appendHumanTurn,
  createWireClient,
  emptyConversation,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { approvalAt, emptyCommandPoint } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://rejection.test';
const GATED = 'alpha';

/** 這一輪工具本體真的被呼叫到了沒有。 */
let ran: string[] = [];

beforeEach(() => {
  ran = [];
});

function spyPlugin(): NexusPlugin {
  return {
    name: 'spy',
    apply(registry) {
      registry.tools.register(
        tool(
          () => {
            ran.push(GATED);
            return `${GATED} 跑過了`;
          },
          { name: GATED, description: `間諜工具 ${GATED}`, schema: z.object({}) },
        ),
      );
    },
  };
}

/** 產品路徑的閘門：`approvals.gate`，fold 成 `wrapToolCall` 上的 pre-execute waterfall。 */
function gatePlugin(): NexusPlugin {
  return {
    name: 'gate',
    apply(registry) {
      registry.approvals.gate((exec, next) =>
        exec.name === GATED ? { kind: 'ask', reason: `${GATED} 要人看過` } : next(),
      );
    },
  };
}

interface Session {
  readonly client: WireClient;
  readonly events: AsyncGenerator<Event, void, undefined>;
  readonly frames: Event[];
  state: ConversationState;
  close(): Promise<void>;
}

/** 產品路徑建 agent，接上真的 handler 與真的 client，零 port。 */
async function open(threadId: string): Promise<Session> {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        { content: `動 ${GATED}。`, toolCalls: [{ name: GATED, args: {} }] },
        { content: '收工。' },
        // 被拒的那批會回去再問一次模型，尾巴多備一輪免得腳本用完。
        { content: '再收一次工。' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [spyPlugin(), gatePlugin()],
  });
  const handler = createWireHandler({
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      // 同 serve：圍堵照這條記 `tool/call`／`tool/result`，卡從那裡來。
      attachSession: built.attachSession,
      dispose: built.dispose,
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(new Request(input as string, init)),
  });
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, '動手');
  return {
    client,
    events,
    frames: [],
    state: appendHumanTurn(emptyConversation(), '動手'),
    close: () => handler.close(),
  };
}

/** 抽到條件成立為止。用 `next()` 不用 `for await`——`break` 會把下行關掉，這條線要跨兩輪抽。 */
async function until(session: Session, done: (session: Session) => boolean): Promise<void> {
  while (!done(session)) {
    const next = await session.events.next();
    if (next.done === true) break;
    session.frames.push(next.value);
    session.state = reduceConversation(session.state, next.value);
  }
}

/**
 * 這一輪真的收完了。
 *
 * 不能只看 `status === 'idle'`：中斷那一輪自己也會發一顆 `lifecycle completed / root`，
 * 在按下決定之後才抽到的話會把狀態翻成 idle——resume 那一輪還沒開始跑，而「線上沒有
 * `tools` frame」與「還沒輪到它發」在那個停止條件下分不出來。所以數模型講完幾輪話。
 */
function settled(turns: number) {
  return (session: Session): boolean =>
    session.state.status === 'idle' &&
    session.state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >=
      turns;
}

/**
 * 線上的 `tools` frame，攤成 `事件名` 的清單。
 *
 * `source` 分兩種：pump 照日誌合成的 root 那幾顆 namespace 是 `[]`，基座發的 root 那幾顆是
 * `['tools:<task id>']`（實測）。
 */
function toolEvents(session: Session, source: 'all' | 'base' = 'all'): string[] {
  return session.frames
    .filter((frame) => frame.method === 'tools')
    .filter((frame) => source === 'all' || frame.params.namespace.length > 0)
    .map((frame) => String((frame.params as { data?: { event?: unknown } }).data?.event));
}

function toolCards(session: Session): ToolEntry[] {
  return session.state.entries.filter((entry): entry is ToolEntry => entry.kind === 'tool');
}

/** 停在核准點：給一個決定，**像 web 那樣**在送出的那一刻記下那一則。 */
async function respond(
  session: Session,
  threadId: string,
  type: 'approve' | 'reject',
): Promise<void> {
  const pending = approvalAt(session.state.pendings);
  await session.client.inputRespond(threadId, {
    namespace: [...pending.namespace],
    interrupt_id: pending.interruptId,
    response: uniformDecisions(pending, type),
  });
  session.state = appendDecision(session.state, pending.interruptId, type);
}

const requested = (session: Session): boolean =>
  session.frames.some((frame) => frame.method === 'input.requested');

describe('核准的兩個方向在下行上長什麼樣', () => {
  it('**拒絕 → 一張失敗的卡、紅字是拒絕理由**，與「已拒絕」那一則並存；基座一顆 frame 都沒發', async () => {
    const session = await open('r1');
    await until(session, requested);
    // 照 dsh：`tool/call` 在核准之前就記，所以等核准時畫面上已經有一張執行中的卡。
    expect(toolCards(session).map((card) => [card.name, card.status])).toEqual([
      [GATED, 'running'],
    ]);

    await respond(session, 'r1', 'reject');
    await until(session, settled(2));

    // 先證中斷真的發生過——沒有這一句，「閘門根本沒觸發」也會讓下面全綠。
    expect(session.frames.filter((frame) => frame.method === 'input.requested')).toHaveLength(1);
    // 工具本體沒跑：`wrapToolCall` 回 `denial()` 時 `handler(request)` 一次都沒被呼叫。
    expect(ran).toEqual([]);
    // 基座一顆都沒發；那兩顆是 pump 照日誌合成的——開一次（resume 後圍堵再記的那顆 `tool/call`
    // 不再開），收一次。
    expect(toolEvents(session, 'base')).toEqual([]);
    expect(toolEvents(session)).toEqual(['tool-started', 'tool-finished']);
    expect(toolCards(session)).toMatchObject([
      {
        name: GATED,
        status: 'failed',
        // 模型看到的那一句，閘門的預設拒絕文字。
        error: `Error: 有人看過並拒絕了 "${GATED}"。`,
        attribution: { kind: 'root' },
      },
    ]);
    // 「是人按了拒絕」只有這一則說得出來（`DecisionEntry` 的註解），所以兩則並存。
    expect(session.state.entries.map((entry) => entry.kind)).toContain('decision');

    await session.close();
  });

  it('**核准 → 基座的 `tool-started` 與 `tool-finished` 都到**——上一條不是因為線收不到基座的 frame', async () => {
    const session = await open('r2');
    await until(session, requested);
    await respond(session, 'r2', 'approve');
    await until(session, settled(2));

    // **這一條承重。** 少了它，一個把基座 `tools` frame 整個丟掉的 pump 也會讓上一條綠。
    expect(toolEvents(session, 'base')).toEqual(['tool-started', 'tool-finished']);
    expect(ran).toEqual([GATED]);
    // 兩個來源、同一張卡：折疊器照 `tool_call_id` 取代。
    expect(toolCards(session).map((card) => [card.name, card.status])).toEqual([[GATED, 'done']]);

    await session.close();
  });
});
