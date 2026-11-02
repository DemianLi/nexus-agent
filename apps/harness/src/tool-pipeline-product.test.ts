/**
 * **工具事件掛進真的組裝之後**（[#1248](https://github.com/DemianLi/nexus-agent/issues/1248)，S1a 的驗收）。
 *
 * 單元層（`packages/nexus-core/src/tool-pipeline.test.ts`）量生產者自己的規則；這一份量的是掛進 `createNexusAgent`
 * 之後還成不成立，而且**每一種結果從它真正的生產者冒出來**（基座的 ToolNode、超時、輸出校驗、核准閘門），不是手搭的假 handler：
 *
 * 1. **有人聽、但只是放行 ＝ 沒人聽**：同一場對話跑兩遍，一遍沒有監聽者、一遍四個事件都掛了純放行的監聽者，
 *    日誌裡的 `tool/result`（碼、判別、模型收到的那句）逐位元組相同。這是「不改行為」的證據。
 * 2. **拒絕在問人之前**：`danger` 會被核准閘門要求人看過；有人在 `tools/pre-execute` 先拒絕它，就不會跳核准卡。
 * 3. **子代理的呼叫帶對身分**，監聽者看得到是誰在叫。
 * 4. **`tools/result` 的監聽者壞了不影響結果**。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import type { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { fromLoggedMessage, SessionRegistry } from '@nexus/core';
import type {
  PipelineExecution,
  PipelineResult,
  PluginEntry,
  SessionEvent,
  SessionEventMap,
} from '@nexus/core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { humanChannelPlugin } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

const ROOT_ID = 'tool-pipeline-root';

type ToolResult = SessionEventMap['tool/result'];

/** 計數：`danger` 的本體跑了幾次。 */
const dangerRuns = { count: 0 };

const toolsPlugin: PluginEntry = {
  plugin: {
    name: 'tool-pipeline-tools',
    apply(registry) {
      registry.tools.register(
        tool(({ text }: { text: string }) => `回聲：${text}`, {
          name: 'echo',
          description: '原樣回聲。',
          schema: z.object({ text: z.string() }),
        }),
      );
      registry.tools.register(
        tool(
          () => {
            throw new Error('連不上');
          },
          { name: 'boom', description: '會拋錯。', schema: z.object({}) },
        ),
      );
      registry.tools.register(
        tool(() => '{"total":"一百"}', {
          name: 'report',
          description: '輸出不合 schema。',
          schema: z.object({}),
        }),
        { outputSchema: z.object({ total: z.number() }) },
      );
      registry.tools.register(
        tool(({ n }: { n: number }) => `n=${n}`, {
          name: 'typed',
          description: '參數要數字。',
          schema: z.object({ n: z.number() }),
        }),
      );
      registry.tools.register(
        tool(
          () => {
            dangerRuns.count += 1;
            return '危險的事做完了';
          },
          { name: 'danger', description: '要核准。', schema: z.object({}) },
        ),
      );
    },
  },
};

/** `danger` 一律要人看過（走核准閘門，沒有搬上匯流排）。 */
const gatePlugin: PluginEntry = {
  plugin: {
    name: 'tool-pipeline-gate',
    apply(registry) {
      registry.approvals.gate((exec, next) =>
        exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
      );
    },
  },
};

const workerPlugin: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

/** 四個事件都掛純放行的監聽者。 */
const passThroughPlugin: PluginEntry = {
  plugin: {
    name: 'tool-pipeline-pass-through',
    apply(registry) {
      registry.events.on('tools/pre-execute', (_exec, next) => next());
      registry.events.on('tools/execute', (_exec, next) => next());
      registry.events.on('tools/post-execute', (_exec, _result, next) => next());
      registry.events.on('tools/result', () => undefined);
    },
  },
};

async function assemble(turns: readonly ScriptedTurn[], plugins: readonly PluginEntry[]) {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [humanChannelPlugin(), ...plugins],
  });
  const sessions = new SessionRegistry(ROOT_ID);
  const detach = built.attachSession(sessions);
  const logOf = (kind: 'root' | 'subagent'): (readonly SessionEvent[])[] =>
    sessions
      .list()
      .filter((entry) => entry.address.kind === kind)
      .map((entry) => entry.log.events);
  return {
    ...built,
    config: { configurable: { thread_id: ROOT_ID } },
    root: (): readonly SessionEvent[] => logOf('root')[0] ?? [],
    close: async () => {
      detach();
      await built.dispose();
    },
  };
}

const done: ScriptedTurn[] = [{ content: '收工。' }, { content: '再收一次。' }];

/** 日誌裡每顆 `tool/result` 的判別格與模型收到的文字，照 `seq` 排。`callId` 換成呼叫的工具名，兩場才比得起來。 */
function resultDigest(events: readonly SessionEvent[]): unknown[] {
  const names = new Map<string, string>();
  const out: unknown[] = [];
  for (const event of events) {
    if (event.type === 'tool/call') {
      names.set(event.data.callId, event.data.name);
    } else if (event.type === 'tool/result') {
      const { message, callId, ...verdict } = event.data as ToolResult;
      const text =
        message === undefined ? undefined : (fromLoggedMessage(message) as ToolMessage).text;
      out.push({ name: names.get(callId), ...verdict, text });
    }
  }
  return out;
}

describe('有人聽但只是放行 ＝ 沒人聽', () => {
  const FIVE = [
    {
      content: '一起。',
      toolCalls: [
        { name: 'echo', args: { text: '嗨' } },
        { name: 'boom', args: {} },
        { name: 'report', args: {} },
        { name: 'typed', args: { n: '不是數字' } },
        { name: 'nope', args: {} },
      ],
    },
    ...done,
  ] satisfies ScriptedTurn[];

  it('五種結果（成功、拋錯、schema 違規、參數不合、未知工具）：日誌逐位元組相同', async () => {
    const bare = await assemble(FIVE, [toolsPlugin]);
    const listened = await assemble(FIVE, [toolsPlugin, passThroughPlugin]);
    try {
      await bare.agent.invoke(toAgentInvocation('跑。'), bare.config);
      await listened.agent.invoke(toAgentInvocation('跑。'), listened.config);
      const expected = resultDigest(bare.root());
      // 先確認這一組真的有料：五顆、有成功有失敗、有碼。
      expect(expected).toHaveLength(5);
      expect(expected).toContainEqual(
        expect.objectContaining({
          name: 'nope',
          error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
        }),
      );
      expect(expected).toContainEqual(
        expect.objectContaining({ name: 'echo', isError: false, text: '回聲：嗨' }),
      );
      expect(resultDigest(listened.root())).toEqual(expected);
    } finally {
      await bare.close();
      await listened.close();
    }
  });
});

describe('拒絕在問人之前', () => {
  it('`tools/pre-execute` 先拒絕 `danger`：不跳核准卡、本體不跑、模型收到 `Error: <reason>`，tool/result 記上', async () => {
    dangerRuns.count = 0;
    const deny: PluginEntry = {
      plugin: {
        name: 'tool-pipeline-deny',
        apply(registry) {
          registry.events.on('tools/pre-execute', (exec, next) =>
            exec.name === 'danger'
              ? Promise.resolve({ kind: 'deny', reason: '這裡不准動手' })
              : next(),
          );
        },
      },
    };
    const run = await assemble(
      [{ content: '動手。', toolCalls: [{ name: 'danger', args: {} }] }, ...done],
      [toolsPlugin, gatePlugin, deny],
    );
    try {
      const out = await run.agent.invoke(toAgentInvocation('跑。'), run.config);
      expect((out as { __interrupt__?: unknown }).__interrupt__).toBeUndefined();
      expect(dangerRuns.count).toBe(0);
      expect(resultDigest(run.root())).toEqual([
        { name: 'danger', isError: true, text: 'Error: 這裡不准動手' },
      ]);
    } finally {
      await run.close();
    }
  });

  it('對照：沒有人拒絕時，同一顆 `danger` 照舊停在核准卡（核准沒被動到）', async () => {
    const run = await assemble(
      [{ content: '動手。', toolCalls: [{ name: 'danger', args: {} }] }, ...done],
      [toolsPlugin, gatePlugin, passThroughPlugin],
    );
    try {
      const out = await run.agent.invoke(toAgentInvocation('跑。'), run.config);
      expect((out as { __interrupt__?: unknown }).__interrupt__).toBeDefined();
    } finally {
      await run.close();
    }
  });
});

describe('呼叫者身分與 tools/result', () => {
  it('root 與子代理的呼叫各帶對 `exec.agent`；`tools/result` 看到每一顆', async () => {
    const seen: { exec: PipelineExecution; result: PipelineResult }[] = [];
    const observer: PluginEntry = {
      plugin: {
        name: 'tool-pipeline-observer',
        apply(registry) {
          registry.events.on('tools/result', (exec, result) => {
            seen.push({ exec, result });
          });
        },
      },
    };
    const run = await assemble(
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '子代理動手。', toolCalls: [{ name: 'echo', args: { text: '子' } }] },
        { content: '子代理收工。' },
        ...done,
      ],
      [toolsPlugin, workerPlugin, observer],
    );
    try {
      await run.agent.invoke(toAgentInvocation('跑。'), run.config);
      const byName = new Map(seen.map((each) => [each.exec.name, each]));
      expect(byName.get('task')?.exec.agent).toEqual({ kind: 'root' });
      const echo = byName.get('echo');
      expect(echo?.exec.agent?.kind).toBe('subagent');
      expect(echo?.result).toMatchObject({ kind: 'message', content: '回聲：子', isError: false });
    } finally {
      await run.close();
    }
  });

  it('`tools/result` 的監聽者拋錯：結果與日誌不變，其他監聽者照跑', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ran: string[] = [];
    const broken: PluginEntry = {
      plugin: {
        name: 'tool-pipeline-broken',
        apply(registry) {
          registry.events.on('tools/result', () => {
            throw new Error('觀察者壞了');
          });
          registry.events.on('tools/result', (exec) => {
            ran.push(exec.name);
          });
        },
      },
    };
    const bare = await assemble(
      [{ content: '回聲。', toolCalls: [{ name: 'echo', args: { text: '嗨' } }] }, ...done],
      [toolsPlugin],
    );
    const run = await assemble(
      [{ content: '回聲。', toolCalls: [{ name: 'echo', args: { text: '嗨' } }] }, ...done],
      [toolsPlugin, broken],
    );
    try {
      await bare.agent.invoke(toAgentInvocation('跑。'), bare.config);
      await run.agent.invoke(toAgentInvocation('跑。'), run.config);
      expect(resultDigest(run.root())).toEqual(resultDigest(bare.root()));
      expect(ran).toEqual(['echo']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('觀察者壞了'));
    } finally {
      warn.mockRestore();
      await bare.close();
      await run.close();
    }
  });
});
