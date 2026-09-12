/**
 * **會話統計讀得出來**——[#266](https://github.com/DemianLi/nexus-agent/issues/266) 的驗收，量的是
 * 真的跑一場對話之後，把日誌餵過 `deriveSessionStats` 得到什麼。
 *
 * 折疊的規則在 `packages/nexus-core/src/session-stats.test.ts`，起訖紀錄器的規則在
 * `packages/nexus-core/src/model-calls.test.ts`。這一份量的是它們掛進真的組裝、走真的進入點
 * （`ThreadPump`，web 那條；它寫 `turn/start`／`turn/end`，也是唯一會寫 `resume` 的）之後
 * 還成不成立。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { deriveSessionStats } from '@nexus/core';
import type { NexusPlugin, SessionEvent } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 一顆會花一點時間的工具，讓 `toolMs` 量得出非零；一顆要核准的。 */
const toolsPlugin: NexusPlugin = {
  name: 'session-stats-tools',
  apply(registry) {
    registry.tools.register(
      tool(
        async ({ text }: { text: string }) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return `已記下：${text}`;
        },
        {
          name: 'take_note',
          description: '把一段文字記下來。',
          schema: z.object({ text: z.string() }),
        },
      ),
    );
    registry.tools.register(
      tool(() => '危險的事做完了', {
        name: 'danger',
        description: '要核准。',
        schema: z.object({}),
      }),
    );
  },
};

const gatePlugin: NexusPlugin = {
  name: 'session-stats-gate',
  apply(registry) {
    registry.approvals.gate((exec, next) =>
      exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
    );
  },
};

const workerPlugin: NexusPlugin = {
  name: 'worker-host',
  apply(registry) {
    registry.subagents.register({ name: 'worker', description: '幹活的。' });
  },
};

/** 真的組裝接上一個 pump——serve 那條路的形狀。 */
async function assemble(turns: readonly ScriptedTurn[], plugins: readonly NexusPlugin[]) {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'stats-root');
  const detach = built.attachSession(pump.sessions);
  const logsOf = (kind: 'root' | 'subagent'): (readonly SessionEvent[])[] =>
    pump.sessions
      .list()
      .filter((entry) => entry.address.kind === kind)
      .map((entry) => entry.log.events);
  return {
    pump,
    root: (): readonly SessionEvent[] => logsOf('root')[0] ?? [],
    subagents: () => logsOf('subagent'),
    close: async () => {
      detach();
      await built.dispose();
    },
  };
}

const count = (events: readonly SessionEvent[], type: SessionEvent['type']) =>
  events.filter((event) => event.type === type).length;

describe('一場跑過的會話', () => {
  /**
   * **卡上的驗收句 1。** 兩輪、三次模型呼叫、兩次工具呼叫：統計讀出 2 與 3，`toolMs` 非零。
   * 第一輪叫兩次工具是刻意的：一個把工具呼叫當成步的實作在這裡是 5。
   */
  it('N 輪、M 次模型呼叫、K 次工具呼叫：讀出 N、M 與非零的 toolMs', async () => {
    const run = await assemble(
      [
        {
          content: '記兩筆。',
          toolCalls: [
            { name: 'take_note', args: { text: '一' } },
            { name: 'take_note', args: { text: '二' } },
          ],
        },
        { content: '記好了。' },
        { content: '第二句也收到了。' },
      ],
      [toolsPlugin],
    );
    try {
      await run.pump.submit({ kind: 'message', text: '第一句' });
      await run.pump.submit({ kind: 'message', text: '第二句' });
      const events = run.root();
      expect(count(events, 'tool/result')).toBe(2);
      const stats = deriveSessionStats(events);
      expect(stats.turns).toBe(2);
      expect(stats.steps).toBe(3);
      // 兩顆各睡 20ms，併發跑：每一對都至少 20，加總至少 40。
      expect(stats.toolMs).toBeGreaterThanOrEqual(40);
      expect(stats.llmMs).toBeGreaterThanOrEqual(0);
      // 工具事件落在一次模型呼叫**之後**，不在 model/start 與 model/end 之間——名字換掉的理由。
      const types = events.map((event) => event.type);
      const firstEnd = types.indexOf('model/end');
      expect(types.indexOf('tool/call')).toBeGreaterThan(firstEnd);
    } finally {
      await run.close();
    }
  });

  /** 核准之後那一輪是 `resume`，併回前一輪：兩顆 `turn/start`、一輪。 */
  it('停在核准點、resume 之後跑完：一輪', async () => {
    const run = await assemble(
      [{ content: '動手。', toolCalls: [{ name: 'danger', args: {} }] }, { content: '做完了。' }],
      [toolsPlugin, gatePlugin],
    );
    try {
      await run.pump.submit({ kind: 'message', text: '做危險的事' });
      await run.pump.submit({
        kind: 'resume',
        interruptId: run.pump.pendings[0]?.interruptId ?? '',
        response: { decisions: [{ type: 'approve' }] },
      });
      const events = run.root();
      expect(count(events, 'turn/start')).toBe(2);
      expect(deriveSessionStats(events)).toMatchObject({ turns: 1, steps: 2 });
    } finally {
      await run.close();
    }
  });

  /** **卡上的驗收句 2。** 腳本用完，假模型拋錯：那一步照樣落下 `model/end`、照樣算數。 */
  it('失敗的那一步也算', async () => {
    const run = await assemble([], [toolsPlugin]);
    try {
      await expect(run.pump.submit({ kind: 'message', text: '嗨' })).rejects.toThrow();
      const events = run.root();
      expect(count(events, 'turn/failed')).toBe(1);
      expect(deriveSessionStats(events)).toMatchObject({ turns: 1, steps: 1 });
    } finally {
      await run.close();
    }
  });

  /** 數字是逐份日誌的：subagent 那兩次模型呼叫在它自己那份，不在 root 那份。 */
  it('subagent 的步在它自己那份', async () => {
    const run = await assemble(
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '子代理動手。', toolCalls: [{ name: 'take_note', args: { text: '子' } }] },
        { content: '子代理收工。' },
        { content: '收工。' },
      ],
      [toolsPlugin, workerPlugin],
    );
    try {
      await run.pump.submit({ kind: 'message', text: '跑' });
      expect(deriveSessionStats(run.root())).toMatchObject({ turns: 1, steps: 2 });
      const subagents = run.subagents();
      expect(subagents).toHaveLength(1);
      const sub = deriveSessionStats(subagents[0]!);
      expect(sub).toMatchObject({ turns: 1, steps: 2 });
      expect(sub.toolMs).toBeGreaterThanOrEqual(20);
    } finally {
      await run.close();
    }
  });
});
