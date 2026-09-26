/**
 * 下行接上時補送還掛著的中斷（[#728](https://github.com/DemianLi/nexus-agent/issues/728)）。
 *
 * 照 dsh gateway 的做法：新的 client 一接上，先把還沒答的請求補送一次（`packages/api/gateway/src/index.ts:500`，
 * `477b4f4`）。我們的載體是 `ThreadPump.subscribe` 註冊當下放進佇列的那幾顆 `input.requested`。
 *
 * 前半對著 pump 量補送的規則；後半走真的線、照網頁重新整理的順序（開下行 → 抓歷史 → 從空重折 → 抽下行）量面板
 * 回不回得來、答了接不接得下去。
 *
 * **最容易假綠的是「什麼都沒補、也什麼都不該補」**：「答掉之後不補」「收回之後不補」在補送整個壞掉時也綠。所以
 * 第一條先證補送真的會發生，其餘每條「不補」都先證那一刻之前確實掛著。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import type { ConversationState, Event, WireChannel, WireClient } from '@nexus/wire';
import {
  createWireClient,
  emptyConversation,
  reduceAll,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import {
  approvalAt,
  approvalToolNames,
  emptyCommandPoint,
  loopbackRequest,
  TEST_BROWSER_AUTH,
} from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://pending-replay.test';
const ALL: readonly WireChannel[] = ['messages', 'tools', 'lifecycle', 'input'];

/** 這一輪真的被呼叫到的工具名，依呼叫順序。 */
let ran: string[] = [];

beforeEach(() => {
  ran = [];
});

/** 產品路徑的閘門（`approvals.gate`）：每個工具各自 `interrupt()`，同一輪兩個就是兩顆中斷。 */
function gated(names: readonly string[]): PluginEntry {
  return {
    plugin: {
      name: 'gated',
      apply(registry) {
        for (const name of names) {
          registry.tools.register(
            tool(
              () => {
                ran.push(name);
                return `${name} 跑過了`;
              },
              { name, description: `要核准的 ${name}`, schema: z.object({}) },
            ),
          );
        }
        registry.approvals.gate((exec, next) =>
          names.includes(exec.name) ? { kind: 'ask', reason: `${exec.name} 要人看過` } : next(),
        );
      },
    },
  };
}

async function build(names: readonly string[]) {
  return createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        { content: '都動。', toolCalls: names.map((name) => ({ name, args: {} })) },
        { content: '收工。' },
        { content: '再收一次工。' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [gated(names)],
  });
}

function requests(frames: readonly Event[]): Event[] {
  return frames.filter((frame) => frame.method === 'input.requested');
}

function interruptIdOf(frame: Event): string {
  return (frame.params.data as { interrupt_id: string }).interrupt_id;
}

/**
 * 開一條新的下行，拿回它**接上當下**佇列裡的東西。
 *
 * 補送在註冊時就放好了。`for await` 同步呼叫第一次 `next()`，那一刻 `#drain` 掛上中止的監聽；緊接著中止，
 * 它照樣先把佇列抽乾才收線。pump 閒著，這之間不會有別的 frame 進來。
 */
async function replayed(pump: ThreadPump, channels: readonly WireChannel[]): Promise<Event[]> {
  const line = new AbortController();
  const stream = pump.subscribe(channels, line.signal);
  const got: Event[] = [];
  const pulling = (async () => {
    for await (const frame of stream) got.push(frame);
  })();
  line.abort();
  await pulling;
  return got;
}

/** 對著 pump 本身：一條長期下行，跑到停在兩顆核准上。 */
async function parkedPump(threadId: string) {
  const built = await build(['alpha', 'beta']);
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, threadId);
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(ALL, line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  await pump.submit({ kind: 'message', text: '動手' });
  await pump.whenIdle();
  return {
    pump,
    frames,
    close: async () => {
      line.abort();
      await draining;
      detach();
      await built.dispose();
    },
  };
}

describe('下行接上時補送還掛著的中斷', () => {
  it('停在兩顆核准上：新接上的先拿到那兩顆，照號排，與即時送出的是同一顆', async () => {
    const run = await parkedPump('replay-both');
    try {
      const live = requests(run.frames);
      // 前提：真的有兩顆掛著，即時那條也真的各收到一顆。
      expect(run.pump.pendings).toHaveLength(2);
      expect(live).toHaveLength(2);

      const got = await replayed(run.pump, ALL);
      // **號與 event_id 是原本那顆的**：網頁從空重折的一頁收得下它，之後的即時 frame 號都比它大。
      expect(got).toEqual(live);
      expect(got.map((frame) => frame.seq)).toEqual(
        [...got.map((frame) => frame.seq)].sort((a, b) => (a ?? 0) - (b ?? 0)),
      );
      // 只補中斷：其他早就過去的 frame 不重播。
      expect(got.every((frame) => frame.method === 'input.requested')).toBe(true);
    } finally {
      await run.close();
    }
  }, 20000);

  it('沒訂 `input` 的下行收不到補送', async () => {
    const run = await parkedPump('replay-channels');
    try {
      expect(run.pump.pendings).toHaveLength(2);
      expect(await replayed(run.pump, ['messages', 'tools', 'lifecycle'])).toEqual([]);
      expect(await replayed(run.pump, ['input'])).toHaveLength(2);
    } finally {
      await run.close();
    }
  }, 20000);

  it('已經接著的下行不會多收一顆', async () => {
    const run = await parkedPump('replay-existing');
    try {
      expect(await replayed(run.pump, ALL)).toHaveLength(2);
      await run.pump.whenIdle();
      expect(requests(run.frames)).toHaveLength(2);
    } finally {
      await run.close();
    }
  }, 20000);

  /**
   * 答掉一顆：resume 那一輪讓沒答的那顆**帶著原本的 id 再中斷一次**（實測），號是新的。補送的要是新的那顆——
   * 舊號比那一輪之後的 frame 都小，重折的一頁收得下，但它的酬載是上一輪的。
   */
  it('答掉一顆之後只補另一顆，而且是它再中斷的那一顆', async () => {
    const run = await parkedPump('replay-answered');
    try {
      const [alpha, beta] = run.pump.pendings;
      if (alpha === undefined || beta === undefined) throw new Error('沒有兩顆掛著');
      await run.pump.submit({
        kind: 'resume',
        interruptId: alpha.interruptId,
        response: { decisions: [{ type: 'approve' }] },
      });
      await run.pump.whenIdle();
      expect(ran).toEqual(['alpha']);
      expect(run.pump.pendings.map((pending) => pending.interruptId)).toEqual([beta.interruptId]);

      const got = await replayed(run.pump, ALL);
      const latest = requests(run.frames).filter(
        (frame) => interruptIdOf(frame) === beta.interruptId,
      );
      // 前提：beta 真的再中斷了一次，號比第一次大。
      expect(latest).toHaveLength(2);
      expect(got).toEqual([latest[1]]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('兩顆都答掉之後不再補', async () => {
    const run = await parkedPump('replay-done');
    try {
      for (const pending of run.pump.pendings) {
        await run.pump.submit({
          kind: 'resume',
          interruptId: pending.interruptId,
          response: { decisions: [{ type: 'approve' }] },
        });
        await run.pump.whenIdle();
      }
      expect(ran).toEqual(['alpha', 'beta']);
      expect(run.pump.awaitingInput).toBe(false);
      expect(await replayed(run.pump, ALL)).toEqual([]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('thread 收掉之後接上的線什麼都不補，直接收線', async () => {
    const run = await parkedPump('replay-closed');
    try {
      // 前提：收掉的那一刻還掛著——`close()` 不清 `#pending`。
      expect(run.pump.pendings).toHaveLength(2);
      run.pump.close();
      expect(await replayed(run.pump, ALL)).toEqual([]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('停止這一輪（收回）之後不再補', async () => {
    const run = await parkedPump('replay-withdrawn');
    try {
      expect(run.pump.pendings).toHaveLength(2);
      expect(run.pump.cancel()).toBe('withdrawn');
      await run.pump.whenIdle();
      expect(ran).toEqual([]);
      expect(await replayed(run.pump, ALL)).toEqual([]);
    } finally {
      await run.close();
    }
  }, 20000);
});

interface Line {
  readonly events: AsyncGenerator<Event, void, undefined>;
  state: ConversationState;
}

async function until(line: Line, done: (state: ConversationState) => boolean): Promise<void> {
  while (!done(line.state)) {
    const next = await line.events.next();
    if (next.done === true) break;
    line.state = reduceConversation(line.state, next.value);
  }
}

/**
 * 照網頁重新整理的順序接回來（`apps/web/src/hooks/use-conversation.ts`）：開下行 → 抓歷史 → **從空的重折** →
 * 之後才抽下行。
 */
async function refresh(client: WireClient, threadId: string): Promise<Line> {
  const events = await client.openEvents(threadId);
  const page = await client.threadHistory(threadId);
  if (page.kind !== 'ok') throw new Error(page.message);
  return { events, state: reduceAll(emptyConversation(), page.result.events) };
}

/** 真的 handler 與 client，產品路徑的閘門擋 `alpha`。 */
async function wire() {
  const built = await build(['alpha']);
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      // 沒接的話日誌裡沒有模型與工具的事件，歷史折出來只剩使用者那句——重新整理量不到真的那一頁。
      attachSession: built.attachSession,
      dispose: built.dispose,
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  return { client, handler };
}

function cards(state: ConversationState): string[] {
  return state.entries.flatMap((entry) =>
    entry.kind === 'tool' ? [`${entry.name}:${entry.status}`] : [],
  );
}

describe('停在核准時重新整理，走真的線', () => {
  it('面板回來，按了核准這一輪接著跑完', async () => {
    const { client, handler } = await wire();
    try {
      const first: Line = {
        events: await client.openEvents('refresh'),
        state: emptyConversation(),
      };
      await client.runStart('refresh', '動手');
      await until(first, (state) => state.status === 'awaiting-input');
      const before = approvalAt(first.state.pendings);

      // 關掉舊分頁的線，同重新整理。
      await first.events.return(undefined);
      const again = await refresh(client, 'refresh');
      // 前提：歷史自己折不出面板——沒有這一句，歷史哪天自己補得出來，下面照樣綠而補送沒被量到。卡在歷史裡，
      // 停在閘門上的照 dsh 是執行中（#317）。
      expect(again.state.pendings).toEqual([]);
      expect(cards(again.state)).toEqual(['alpha:running']);

      await until(again, (state) => state.status === 'awaiting-input');
      const after = approvalAt(again.state.pendings);
      expect(approvalToolNames(again.state.pendings)).toEqual(['alpha']);
      expect(after.interruptId).toBe(before.interruptId);
      expect(after.namespace).toEqual(before.namespace);

      const answered = await client.inputRespond('refresh', {
        namespace: [...after.namespace],
        interrupt_id: after.interruptId,
        response: uniformDecisions(after, 'approve'),
      });
      expect(answered.type).toBe('success');
      // 重新整理之後的線上只有補送與之後的 frame，中斷那一輪的收尾不在上面，所以 `idle` 就是 resume 那一輪收了。
      await until(again, (state) => state.status === 'idle');
      expect(ran).toEqual(['alpha']);
      expect(again.state.pendings).toEqual([]);
      // 歷史那張卡與 resume 之後的即時 frame 折成同一張，而且跑完了。
      expect(cards(again.state)).toEqual(['alpha:done']);
    } finally {
      await handler.close();
    }
  }, 20000);

  /**
   * **兩個分頁**：新開的那頁拿到補送、答了；原本那頁沒有收到任何「別人答了」的訊號（拍板第 3 題不補 dsh 的 cancel），
   * 它的面板靠 resume 那一輪的 `lifecycle running` 收掉。
   */
  it('兩個分頁：一邊答完，另一邊的面板收掉', async () => {
    const { client, handler } = await wire();
    try {
      const tabA: Line = {
        events: await client.openEvents('two-tabs'),
        state: emptyConversation(),
      };
      await client.runStart('two-tabs', '動手');
      await until(tabA, (state) => state.status === 'awaiting-input');

      const tabB = await refresh(client, 'two-tabs');
      await until(tabB, (state) => state.status === 'awaiting-input');
      // 前提：兩邊都看得到那一題。
      expect(approvalToolNames(tabA.state.pendings)).toEqual(['alpha']);
      expect(approvalToolNames(tabB.state.pendings)).toEqual(['alpha']);

      const pending = approvalAt(tabB.state.pendings);
      await client.inputRespond('two-tabs', {
        namespace: [...pending.namespace],
        interrupt_id: pending.interruptId,
        response: uniformDecisions(pending, 'approve'),
      });
      await until(tabB, (state) => state.status === 'idle');
      // A 線上還排著中斷那一輪自己的收尾（`idle`），所以等到卡跑完，不只等 `idle`。
      await until(tabA, (state) => state.status === 'idle' && cards(state).includes('alpha:done'));

      expect(ran).toEqual(['alpha']);
      expect(tabA.state.pendings).toEqual([]);
      expect(cards(tabA.state)).toEqual(['alpha:done']);
      expect(tabB.state.pendings).toEqual([]);
    } finally {
      await handler.close();
    }
  }, 20000);
});
