/**
 * **工具呼叫與結果進會話日誌**——[#264](https://github.com/DemianLi/nexus-agent/issues/264) 的驗收，
 * 量的是真的跑一場對話之後日誌裡有什麼。
 *
 * 規則（碼從哪裡來、什麼時候整對不記）在 `packages/nexus-core/src/containment.test.ts`。
 * 這一份量的是那幾條規則掛進真的組裝之後還成不成立：**每一種錯誤都從它真正的生產者冒出來**
 * ——基座的 ToolNode、超時的 `AbortSignal`、校驗 plugin、核准閘門、`ask_user_question`——
 * 而不是從手搭的假 handler。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { tool } from '@langchain/core/tools';
import { Command, MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import type { NexusPlugin, SessionEvent, SessionEventMap } from '@nexus/core';
import { createAskUserPlugin } from '@nexus/plugin-ask-user';
import { createValidationPlugin } from '@nexus/plugin-validation';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

const ROOT_ID = 'tool-events-root';

/** 每一種失敗各一顆工具，外加一顆會成功的。 */
const toolsPlugin: NexusPlugin = {
  name: 'tool-events-tools',
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
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return '太慢了';
        },
        {
          name: 'slow',
          description: '會超時。',
          schema: z.object({}),
          defaultConfig: { timeout: 30 },
        },
      ),
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
    );
    registry.tools.register(
      tool(({ n }: { n: number }) => `n=${n}`, {
        name: 'typed',
        description: '參數要數字。',
        schema: z.object({ n: z.number() }),
      }),
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

/** `danger` 一律要人看過。 */
const gatePlugin: NexusPlugin = {
  name: 'tool-events-gate',
  apply(registry) {
    registry.approvals.gate((exec, next) =>
      exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
    );
  },
};

/** 只註冊一個 subagent。 */
const workerPlugin: NexusPlugin = {
  name: 'worker-host',
  apply(registry) {
    registry.subagents.register({ name: 'worker', description: '幹活的。' });
  },
};

/** 輸出 schema：`report` 的 `total` 要是數字。 */
const validation = createValidationPlugin({ schemas: { report: z.object({ total: z.number() }) } });

type ToolCall = SessionEventMap['tool/call'];
type ToolResult = SessionEventMap['tool/result'];

/** 一份日誌裡的工具事件，照 `seq` 排。 */
function toolEvents(events: readonly SessionEvent[]): SessionEvent<'tool/call' | 'tool/result'>[] {
  return events.filter(
    (event): event is SessionEvent<'tool/call' | 'tool/result'> =>
      event.type === 'tool/call' || event.type === 'tool/result',
  );
}

/** 呼叫的名字 → 它配到的那顆結果。**以 `callId` 配對，取最後那顆呼叫**（見 `session-log.ts`）。 */
function resultsByName(events: readonly SessionEvent[]): Map<string, ToolResult> {
  const names = new Map<string, string>();
  const out = new Map<string, ToolResult>();
  for (const event of toolEvents(events)) {
    if (event.type === 'tool/call') {
      names.set((event.data as ToolCall).callId, (event.data as ToolCall).name);
      continue;
    }
    const result = event.data as ToolResult;
    const name = names.get(result.callId);
    if (name === undefined) throw new Error(`結果 ${result.callId} 配不到呼叫`);
    out.set(name, result);
  }
  return out;
}

/** 一場組裝加上它的會話註冊表。 */
async function assemble(turns: readonly ScriptedTurn[], plugins: readonly NexusPlugin[]) {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
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
    subagents: (): (readonly SessionEvent[])[] => logOf('subagent'),
    close: async () => {
      detach();
      await built.dispose();
    },
  };
}

const done: ScriptedTurn[] = [
  { content: '收工。' },
  { content: '再收一次。' },
  { content: '三收。' },
];

describe('一次成功的呼叫', () => {
  /**
   * **卡上的驗收句 1。** 參數刻意帶中文與巢狀：序列化掉了一層、或換成模型看不到的形狀，
   * 這一條會紅。
   */
  it.each([
    ['invoke（CLI 那條）', false],
    ['v3 streamEvents（web 那條）', true],
  ])('%s：落下配對的一對，arguments 是參數物件序列化後的字串', async (_label, streaming) => {
    const run = await assemble(
      [{ content: '回聲。', toolCalls: [{ name: 'echo', args: { text: '嗨' } }] }, ...done],
      [toolsPlugin],
    );
    try {
      if (streaming) {
        for await (const _ of await run.agent.streamEvents(toAgentInvocation('跑。') as never, {
          ...run.config,
          version: 'v3',
        })) {
          void _;
        }
      } else {
        await run.agent.invoke(toAgentInvocation('跑。'), run.config);
      }
      const events = toolEvents(run.root());
      expect(events.map((event) => event.type)).toEqual(['tool/call', 'tool/result']);
      const call = events[0]!.data as ToolCall;
      const result = events[1]!.data as ToolResult;
      expect(call.name).toBe('echo');
      expect(JSON.parse(call.arguments)).toEqual({ text: '嗨' });
      expect(call.callId.length).toBeGreaterThan(0);
      expect(result).toEqual({ callId: call.callId, isError: false });
    } finally {
      await run.close();
    }
  });
});

describe('每一種失敗從它真正的生產者冒出來', () => {
  /**
   * **卡上的驗收句 2，擴成全部能分的種類。** 一格五顆併發：配對靠 `callId`，不靠順序。
   * 一般拋錯照 dsh 不帶 `error`——那一格斷言的是「連 key 都沒有」。
   */
  it('超時、拋錯、schema 違規、參數不合、未知工具各自的碼', async () => {
    const run = await assemble(
      [
        {
          content: '五個一起。',
          toolCalls: [
            { name: 'slow', args: {} },
            { name: 'boom', args: {} },
            { name: 'report', args: {} },
            { name: 'typed', args: { n: '不是數字' } },
            { name: 'nope', args: {} },
          ],
        },
        ...done,
      ],
      [toolsPlugin, validation],
    );
    try {
      await run.agent.invoke(toAgentInvocation('跑。'), run.config);
      const results = resultsByName(run.root());
      expect(results.get('slow')?.error).toEqual({
        name: 'ToolTimeoutError',
        code: 'TOOL_TIMEOUT',
      });
      expect(results.get('report')?.error).toEqual({
        name: 'ToolOutputError',
        code: 'INVALID_TOOL_OUTPUT',
      });
      expect(results.get('typed')?.error).toEqual({ name: 'ToolArgsError', code: 'INVALID_ARGS' });
      expect(results.get('nope')?.error).toEqual({
        name: 'ToolNotFoundError',
        code: 'UNKNOWN_TOOL',
      });
      const boom = results.get('boom');
      expect(boom?.isError).toBe(true);
      expect(boom !== undefined && 'error' in boom).toBe(false);
      expect([...results.values()].every((result) => result.isError)).toBe(true);
    } finally {
      await run.close();
    }
  });
});

/**
 * **卡上的驗收句 3：射程。** 兩半各有一條會紅的斷言——漏了 subagent 那一注，subagent 那份
 * 是空的；身分算錯，`echo` 出現在 root 那份。
 */
describe('subagent 裡的呼叫', () => {
  it('記在 subagent 那份，root 那份只有 task', async () => {
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
      [toolsPlugin, workerPlugin],
    );
    try {
      await run.agent.invoke(toAgentInvocation('跑。'), run.config);
      expect([...resultsByName(run.root()).keys()]).toEqual(['task']);
      const subagents = run.subagents();
      expect(subagents).toHaveLength(1);
      expect([...resultsByName(subagents[0]!).entries()]).toEqual([
        ['echo', { callId: expect.any(String), isError: false }],
      ]);
    } finally {
      await run.close();
    }
  });
});

/**
 * **中斷不是落定**（卡上「動工時的決定」第一條）。暫停那一次只留一顆呼叫；resume 之後以
 * **同一個 `callId`** 再記一對。拒絕那一格照 dsh 不帶碼——被拒不是工具的錯。
 */
describe('被核准閘門中斷的呼叫', () => {
  it.each([
    ['核准', 'approve', false],
    ['拒絕', 'reject', true],
  ])('%s：暫停時一顆呼叫，resume 之後同一個 callId 再一對', async (_label, decision, isError) => {
    const run = await assemble(
      [{ content: '動手。', toolCalls: [{ name: 'danger', args: {} }] }, ...done],
      [toolsPlugin, gatePlugin],
    );
    try {
      const paused = await run.agent.invoke(toAgentInvocation('跑。'), run.config);
      expect(paused.__interrupt__).toBeDefined();
      expect(toolEvents(run.root()).map((event) => event.type)).toEqual(['tool/call']);

      await run.agent.invoke(
        new Command({ resume: { decisions: [{ type: decision }] } }) as never,
        run.config,
      );
      const events = toolEvents(run.root());
      expect(events.map((event) => event.type)).toEqual(['tool/call', 'tool/call', 'tool/result']);
      const callIds = events.map((event) => (event.data as ToolCall | ToolResult).callId);
      expect(new Set(callIds).size).toBe(1);
      expect(events[2]!.data).toEqual({ callId: callIds[0], isError });
    } finally {
      await run.close();
    }
  });
});

describe('ask_user_question', () => {
  it('人放棄整組 → ASK_CANCELLED，碼走得過工具本體回的那則訊息', async () => {
    const run = await assemble(
      [
        {
          content: '問一下。',
          toolCalls: [
            { name: 'ask_user_question', args: { questions: [{ id: 'q', question: '哪個？' }] } },
          ],
        },
        ...done,
      ],
      [createAskUserPlugin()],
    );
    try {
      await run.agent.invoke(toAgentInvocation('跑。'), run.config);
      await run.agent.invoke(new Command({ resume: { cancelled: true } }) as never, run.config);
      expect(resultsByName(run.root()).get('ask_user_question')).toEqual({
        callId: expect.any(String),
        isError: true,
        error: { name: 'UserQuestionError', code: 'ASK_CANCELLED' },
      });
    } finally {
      await run.close();
    }
  });
});
