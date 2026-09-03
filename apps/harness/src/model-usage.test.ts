/**
 * **每一輪的 token 用量進會話日誌**——[#153](https://github.com/DemianLi/nexus-agent/issues/153)
 * 的驗收，量的是真的跑一場對話之後日誌裡有什麼。
 *
 * 規則（哪些數字收、寫不進去會怎樣）在 `packages/nexus-core/src/model-usage.test.ts`。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，用量由腳本給。
 */

import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '@nexus/core';
import type { ModelUsage, NexusPlugin, SessionEvent } from '@nexus/core';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

const ROOT_ID = 'usage-root';

/** 只註冊一個 subagent，其餘什麼都不做。 */
const withWorker: NexusPlugin = {
  name: 'worker-host',
  apply(registry) {
    registry.subagents.register({ name: 'worker', description: '幹活的。' });
  },
};

/** 一份日誌裡的用量，照 `seq` 排。 */
function usageOf(events: readonly SessionEvent[]): ModelUsage[] {
  return events
    .filter((event) => event.type === 'model/usage')
    .map((event) => event.data as ModelUsage);
}

/**
 * 跑一場，回傳每一份日誌的用量。
 *
 * @param turns - 模型的腳本。
 * @param plugins - 額外的 plugin。
 * @param streaming - `true` 走 v3 `streamEvents`（web 那條），`false` 走 `invoke`。
 * @returns root 那份、以及每一份 subagent 的用量。
 */
async function run(
  turns: readonly ScriptedTurn[],
  plugins: readonly NexusPlugin[] = [],
  streaming = false,
): Promise<{ root: ModelUsage[]; subagents: ModelUsage[][] }> {
  const model = new ScriptedChatModel({ turns });
  const { agent, attachSession, dispose } = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
  });
  const sessions = new SessionRegistry(ROOT_ID);
  const detach = attachSession(sessions);
  try {
    const config = { configurable: { thread_id: ROOT_ID } };
    if (streaming) {
      for await (const _ of await agent.streamEvents(toAgentInvocation('跑。') as never, {
        ...config,
        version: 'v3',
      })) {
        void _;
      }
    } else {
      await agent.invoke(toAgentInvocation('跑。'), config);
    }
  } finally {
    detach();
    await dispose();
  }
  const entries = sessions.list();
  return {
    root: usageOf(entries.find((entry) => entry.address.kind === 'root')?.log.events ?? []),
    subagents: entries
      .filter((entry) => entry.address.kind === 'subagent')
      .map((entry) => usageOf(entry.log.events)),
  };
}

describe('模型報了用量', () => {
  it('三輪就是三筆，數字一一對得上', async () => {
    const { root } = await run([
      { content: '一。', usage: { inputTokens: 11, outputTokens: 22 } },
      { content: '二。', usage: { inputTokens: 33, outputTokens: 44 } },
      { content: '三。', usage: { inputTokens: 55, outputTokens: 66 } },
    ]);
    // 一次 `invoke` 只跑到模型不再叫工具為止，所以這裡只會用掉第一輪腳本。
    expect(root).toEqual([{ inputTokens: 11, outputTokens: 22, totalTokens: 33 }]);
  });

  it('一輪裡叫幾次模型就有幾筆——用量是 per-step 的，不是 per-turn', async () => {
    const { root } = await run([
      {
        content: '先問一下。',
        usage: { inputTokens: 11, outputTokens: 22 },
        toolCalls: [{ name: 'write_todos', args: { todos: [] } }],
      },
      { content: '好了。', usage: { inputTokens: 33, outputTokens: 44 } },
    ]);
    expect(root).toEqual([
      { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
      { inputTokens: 33, outputTokens: 44, totalTokens: 77 },
    ]);
  });

  /**
   * **web 那條也要產得出來。** 走 v3 `streamEvents` 時模型改走 `_streamResponseChunks`
   * （見 `scripted-model.ts` 的說明），用量掛在最後一顆 chunk 上、靠 `AIMessageChunk`
   * 相加聚合。聚合掉了的話這一條會紅，而 `invoke` 那條照樣綠。
   */
  it('走 v3 streamEvents 也一樣——聚合之後 usage 還在', async () => {
    const { root } = await run(
      [
        {
          content: '先問一下。',
          usage: { inputTokens: 11, outputTokens: 22 },
          toolCalls: [{ name: 'write_todos', args: { todos: [] } }],
        },
        { content: '好了。', usage: { inputTokens: 33, outputTokens: 44 } },
      ],
      [],
      true,
    );
    expect(root).toEqual([
      { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
      { inputTokens: 33, outputTokens: 44, totalTokens: 77 },
    ]);
  });
});

describe('模型沒報用量', () => {
  it('日誌裡連一顆 model/usage 都沒有——不是 0，是整顆事件不存在', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '不報。' }] });
    const { agent, attachSession, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [],
    });
    const sessions = new SessionRegistry(ROOT_ID);
    const detach = attachSession(sessions);
    try {
      await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: ROOT_ID } });
    } finally {
      detach();
      await dispose();
    }
    const events = sessions.list()[0]?.log.events ?? [];
    expect(events.some((event) => event.type === 'model/usage')).toBe(false);
  });

  it('報一半的那幾輪各自不見，報齊的那幾輪照記', async () => {
    const { root } = await run([
      {
        content: '這輪不報。',
        toolCalls: [{ name: 'write_todos', args: { todos: [] } }],
      },
      { content: '這輪報。', usage: { inputTokens: 33, outputTokens: 44 } },
    ]);
    expect(root).toEqual([{ inputTokens: 33, outputTokens: 44, totalTokens: 77 }]);
  });
});

/**
 * **射程：subagent 那幾輪記在 subagent 自己那份。**
 *
 * 兩半各有一條會紅的斷言，而它們為不同的理由壞掉：
 *
 * - 漏了 `foldSubAgents` 那一注 → subagent 那份是空的。
 * - 身分算錯（`checkpoint_ns` 去尾的規則對模型呼叫不成立）→ 33/44 出現在 root 那份。
 *
 * 所以三輪的數字**刻意兩兩不同**：合流是看得出來的，不是碰巧對得上。
 */
describe('subagent 的那幾輪', () => {
  it('記在 subagent 那份，不在 root 的', async () => {
    const { root, subagents } = await run(
      [
        {
          content: '委派。',
          usage: { inputTokens: 11, outputTokens: 22 },
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '子代理收工。', usage: { inputTokens: 33, outputTokens: 44 } },
        { content: '根收工。', usage: { inputTokens: 55, outputTokens: 66 } },
      ],
      [withWorker],
    );
    expect(subagents).toEqual([[{ inputTokens: 33, outputTokens: 44, totalTokens: 77 }]]);
    expect(root).toEqual([
      { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
      { inputTokens: 55, outputTokens: 66, totalTokens: 121 },
    ]);
  });
});
