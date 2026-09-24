/**
 * **這條對話累計燒了多少，即時看得到、重新整理之後也一樣、行程重開之後接得上**——
 * [#574](https://github.com/DemianLi/nexus-agent/issues/574) 的 harness 那一半。
 *
 * 真的圖、真的 pump，模型是腳本、每一次呼叫報一組用量。每一個檢查點都比三條路：即時的 frame、歷史的整份一頁、
 * 只收最後一輪的那一頁，各折一次，`tokenUsage` 與 `sessionStats` 要相等，而且要等於直接折 root 日誌。
 *
 * 1. 只算 root：子代理那幾次呼叫記在它自己那份，不進總帳，同 dsh。
 * 2. 還沒叫過模型就一顆都不送，兩邊都是 `null`。
 * 3. **重開**：pump 帶著上一個行程的 seed 起來，建起來當下不送；之後送出去的是「seed 加新的」，不是只有新的。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，測試不碰真的 `~/.nexus-agent`。
 */

import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { deriveSessionStats, deriveTokenUsage } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { emptyConversation, reduceAll, SESSION_STATS, TOKEN_USAGE } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { historyPage } from './conversation-history.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

const WORKER: PluginEntry = {
  plugin: {
    name: 'session-totals-fixture',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

/** 兩輪：第一輪直接答；第二輪委派，子代理叫一次模型（報一組很大的用量），root 收尾。 */
const FIRST_RUN: ScriptedTurn[] = [
  { content: '你好。', usage: usage(1000, 20) },
  {
    content: '',
    toolCalls: [{ name: 'task', args: { description: '做事', subagent_type: 'worker' } }],
    usage: usage(1100, 30),
  },
  { content: '子代理收工。', usage: usage(900_000, 9_000) },
  { content: '根收工。', usage: usage(1300, 40) },
];

/** 重開之後那一輪。 */
const SECOND_RUN: ScriptedTurn[] = [{ content: '又見面了。', usage: usage(1500, 50) }];

const stateOf = (frames: readonly Event[]) => reduceAll(emptyConversation(), frames);

/** 一條路折出來的兩格。 */
const totalsOf = (frames: readonly Event[]) => {
  const { tokenUsage, sessionStats } = stateOf(frames);
  return { tokenUsage, sessionStats };
};

/** 重新整理拿到的：整份一頁，與只收最後一輪的那一頁。 */
const refreshed = (events: readonly SessionEvent[]) =>
  [historyPage(events), historyPage(events, { maxMessages: 1 })].map((page) =>
    totalsOf(page.events),
  );

/** 即時送出去的會話累計 frame，照順序。 */
const totalsFrames = (frames: readonly Event[]) =>
  frames
    .filter((frame) => frame.method === 'custom')
    .map((frame) => frame.params.data as { name: string; payload: unknown })
    .filter((data) => data.name === TOKEN_USAGE || data.name === SESSION_STATS);

async function open(turns: ScriptedTurn[], rootSeed?: readonly SessionEvent[]) {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }) as never,
    checkpointer: new MemorySaver(),
    plugins: [WORKER],
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'totals', undefined, rootSeed);
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'custom'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  const close = async () => {
    line.abort();
    await draining;
    detach();
    await built.dispose();
  };
  return { pump, frames, close };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('會話累計在即時、重新整理、重開之後都一樣', () => {
  it('只算 root；還沒叫模型不送；重開之後是 seed 加新的', async () => {
    const first = await open(FIRST_RUN);
    let seed: readonly SessionEvent[];
    try {
      await settle();
      // 還沒叫過模型：一顆都不送，歷史也不送。
      expect(totalsFrames(first.frames)).toEqual([]);
      expect(refreshed(first.pump.sessionLog.events)).toEqual([
        { tokenUsage: null, sessionStats: null },
        { tokenUsage: null, sessionStats: null },
      ]);

      await first.pump.submit({ kind: 'message', text: '嗨' });
      await first.pump.submit({ kind: 'message', text: '派出去' });
      await settle();

      // 前提：子代理那份真的記了它那一次的帳，root 這份沒有。
      const subagentUsage = first.pump.sessions
        .list()
        .filter((entry) => entry.address.kind === 'subagent')
        .flatMap((entry) => entry.log.events.filter((event) => event.type === 'model/usage'));
      expect(subagentUsage).toHaveLength(1);

      const expected = {
        tokenUsage: { inputTokens: 1000 + 1100 + 1300, outputTokens: 20 + 30 + 40 },
        sessionStats: deriveSessionStats(first.pump.sessionLog.events),
      };
      expect(deriveTokenUsage(first.pump.sessionLog.events)).toEqual(expected.tokenUsage);
      // 前提：兩輪三次 root 呼叫（子代理那一次不算）。
      expect(expected.sessionStats).toMatchObject({ turns: 2, steps: 3 });
      expect(totalsOf(first.frames)).toEqual(expected);
      expect(refreshed(first.pump.sessionLog.events)).toEqual([expected, expected]);
      seed = first.pump.sessionLog.events;
    } finally {
      await first.close();
    }

    // 重開：同一份 root 日誌當 seed，新的行程、新的 pump。
    const second = await open(SECOND_RUN, seed);
    try {
      await settle();
      // 建起來當下不送：seed 那一段的值由歷史的最後一頁送。
      expect(totalsFrames(second.frames)).toEqual([]);
      expect(refreshed(second.pump.sessionLog.events)[0]?.tokenUsage).toEqual({
        inputTokens: 3400,
        outputTokens: 90,
      });

      await second.pump.submit({ kind: 'message', text: '還在嗎' });
      await settle();
      const expected = {
        tokenUsage: { inputTokens: 3400 + 1500, outputTokens: 90 + 50 },
        sessionStats: deriveSessionStats(second.pump.sessionLog.events),
      };
      expect(expected.sessionStats).toMatchObject({ turns: 3, steps: 4 });
      // 即時送出去的最後一顆就是 seed 加新的——只折這個行程那幾顆的話，這裡是 1500／50。
      expect(totalsOf(second.frames)).toEqual(expected);
      expect(refreshed(second.pump.sessionLog.events)).toEqual([expected, expected]);
    } finally {
      await second.close();
    }
  }, 30000);
});
