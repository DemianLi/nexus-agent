/**
 * **中止這一輪，在正式路徑上**——[#276](https://github.com/DemianLi/nexus-agent/issues/276) 的驗收。
 *
 * `packages/nexus-core/src/turn-cancel.test.ts` 直接呼叫鉤子量規則；這一份量的是它們掛進真的組裝、
 * 走真的進入點（`ThreadPump`，web 那條）、接上真的會話註冊表之後，**日誌上的碼、對話狀態、下行**
 * 三邊對不對得上。兩者會為不同的理由壞掉：規則對但位置錯（被擋下的呼叫多算一步）、或位置對但
 * 進入點沒把訊號放進去。
 *
 * 真的 `ChatOpenAI` 請求被切斷那一條在 `turn-cancel-openai.test.ts`：假模型重現不了它的 quirk。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  TOOL_ABORTED,
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_ABORTED_BEFORE_DISPATCH_TEXT,
  TOOL_ABORTED_TEXT,
} from '@nexus/core';
import type { NexusPlugin, SessionEvent } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { createWireClient } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { emptyCommandPoint } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

/** 慢工具跑到哪裡了——「有沒有丟下它」的答案在這裡，不在回傳的措辭上。 */
interface Probe {
  started: number;
  settled: number;
}

function toolsPlugin(probe: Probe): NexusPlugin {
  return {
    name: 'cancel-tools',
    apply(registry) {
      registry.tools.register(
        tool(
          async () => {
            probe.started += 1;
            await new Promise((resolve) => setTimeout(resolve, 60));
            probe.settled += 1;
            return '寫好了';
          },
          { name: 'slow_write', description: '慢慢寫一個檔。', schema: z.object({}) },
        ),
      );
      registry.tools.register(
        tool(() => '危險的事做完了', {
          name: 'danger',
          description: '要核准。',
          schema: z.object({}),
        }),
      );
      registry.approvals.gate((exec, next) =>
        exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
      );
    },
  };
}

const workerPlugin: NexusPlugin = {
  name: 'worker-host',
  apply(registry) {
    registry.subagents.register({ name: 'worker', description: '幹活的。' });
  },
};

/** 真的組裝接上一個 pump 與一條下行——serve 那條路的形狀。 */
async function assemble(turns: readonly ScriptedTurn[], plugins: readonly NexusPlugin[]) {
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'cancel-root');
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  const logsOf = (kind: 'root' | 'subagent'): (readonly SessionEvent[])[] =>
    pump.sessions
      .list()
      .filter((entry) => entry.address.kind === kind)
      .map((entry) => entry.log.events);
  return {
    model,
    pump,
    frames,
    root: (): readonly SessionEvent[] => logsOf('root')[0] ?? [],
    subagents: () => logsOf('subagent'),
    close: async () => {
      line.abort();
      await draining;
      detach();
      await built.dispose();
    },
  };
}

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const typesOf = (events: readonly SessionEvent[]) => events.map((event) => event.type);
const resultsOf = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === 'tool/result').map((event) => event.data);
const ABORTED_END = { reason: { kind: 'aborted', cause: { kind: 'user' } } };
const abortedResult = (code: string) => ({
  callId: expect.any(String),
  isError: true,
  error: { name: 'AbortError', code },
});

/** root 那顆收尾的 `lifecycle` 標了中止——畫面據它畫「已停止」。 */
const isStoppedFrame = (frame: Event) =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { aborted?: unknown }).aborted === true;

describe('有一輪在跑', () => {
  it('工具跑到一半按停止：等本體落定，結果換成 ABORTED，這一步之後不再叫模型', async () => {
    const probe: Probe = { started: 0, settled: 0 };
    const run = await assemble(
      [
        { content: '動手寫。', toolCalls: [{ name: 'slow_write', args: {} }] },
        { content: '第二句收到。' },
      ],
      [toolsPlugin(probe)],
    );
    try {
      const turn = run.pump.submit({ kind: 'message', text: '寫檔' });
      await until(() => probe.started === 1);
      expect(run.pump.cancel()).toBe('run');
      // **中止不是失敗**：submit 照常 resolve。
      await turn;
      // 本體跑完了——沒有丟下它（交給 LangGraph 的 signal 的話，這裡在錯誤冒出時還是 0）。
      expect(probe.settled).toBe(1);

      const events = run.root();
      expect(resultsOf(events)).toEqual([abortedResult(TOOL_ABORTED)]);
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: ABORTED_END });
      expect(typesOf(events)).not.toContain('turn/failed');
      // **被擋下的那次模型呼叫不算一步**：外層那顆排在起訖紀錄器外面才會是一對。
      // 位置排錯（排進紀錄器裡面）的話，這裡是兩顆 `model/start`。
      expect(typesOf(events).filter((type) => type === 'model/start')).toHaveLength(1);
      expect(run.model.prompts).toHaveLength(1);
      await until(() => run.frames.some(isStoppedFrame));

      // 下一句照常，而模型看到的是 dsh 的原字串。
      await run.pump.submit({ kind: 'message', text: '還在嗎' });
      const tools = (run.model.prompts.at(-1) ?? []).filter(
        (message) => message.getType() === 'tool',
      );
      expect(tools.map((message) => message.text)).toEqual([TOOL_ABORTED_TEXT]);
      expect(run.root().at(-1)).toMatchObject({ type: 'turn/end', data: {} });
    } finally {
      await run.close();
    }
  });

  it('委派中按停止：子代理也停，它的工具與 root 的 task 都是 ABORTED', async () => {
    const probe: Probe = { started: 0, settled: 0 };
    const run = await assemble(
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '子代理動手。', toolCalls: [{ name: 'slow_write', args: {} }] },
      ],
      [toolsPlugin(probe), workerPlugin],
    );
    try {
      const turn = run.pump.submit({ kind: 'message', text: '派出去' });
      await until(() => probe.started === 1);
      run.pump.cancel();
      await turn;
      expect(probe.settled).toBe(1);

      const subagents = run.subagents();
      expect(subagents).toHaveLength(1);
      expect(resultsOf(subagents[0] ?? [])).toEqual([abortedResult(TOOL_ABORTED)]);
      expect(resultsOf(run.root())).toEqual([abortedResult(TOOL_ABORTED)]);
      // root 一次、子代理一次，之後兩邊都沒再叫——腳本只寫了兩輪，多叫一次就拋。
      expect(run.model.prompts).toHaveLength(2);
      expect(run.root().at(-1)).toMatchObject({ type: 'turn/end', data: ABORTED_END });
    } finally {
      await run.close();
    }
  });

  it('排在後面的那一句不動：停完接著跑', async () => {
    const probe: Probe = { started: 0, settled: 0 };
    const run = await assemble(
      [
        { content: '動手寫。', toolCalls: [{ name: 'slow_write', args: {} }] },
        { content: '第二句收到。' },
      ],
      [toolsPlugin(probe)],
    );
    try {
      const first = run.pump.submit({ kind: 'message', text: '寫檔' });
      const second = run.pump.submit({ kind: 'message', text: '第二句' });
      await until(() => probe.started === 1);
      run.pump.cancel();
      await first;
      await second;
      const ends = run
        .root()
        .filter((event) => event.type === 'turn/end')
        .map((event) => event.data);
      expect(ends).toEqual([ABORTED_END, {}]);
    } finally {
      await run.close();
    }
  });

  it('對照：沒按停止時模型自己拋錯，照舊記 turn/failed', async () => {
    const run = await assemble([], [toolsPlugin({ started: 0, settled: 0 })]);
    try {
      // 腳本用完，假模型拋錯——那是一次真的失敗，不能被記成中止。
      await expect(run.pump.submit({ kind: 'message', text: '嗨' })).rejects.toThrow();
      expect(typesOf(run.root())).toContain('turn/failed');
      expect(typesOf(run.root())).not.toContain('turn/end');
      expect(run.frames.some(isStoppedFrame)).toBe(false);
    } finally {
      await run.close();
    }
  });
});

describe('沒有一輪在跑', () => {
  it('停在核准點按停止：收回——一輪 resume、那顆 before dispatch、aborted 收尾', async () => {
    const run = await assemble(
      [{ content: '動手。', toolCalls: [{ name: 'danger', args: {} }] }, { content: '換個話題。' }],
      [toolsPlugin({ started: 0, settled: 0 })],
    );
    try {
      await run.pump.submit({ kind: 'message', text: '做危險的事' });
      expect(run.pump.awaitingInput).toBe(true);
      const before = run.root().length;

      expect(run.pump.cancel()).toBe('withdrawn');
      // 收下的那一刻就不再掛著：緊接著到的 `run.start` 不會被「停在核准點」擋回去。
      expect(run.pump.awaitingInput).toBe(false);
      await run.pump.whenIdle();

      const tail = run.root().slice(before);
      expect(typesOf(tail)).toEqual(['turn/start', 'tool/result', 'turn/end']);
      expect(tail[0]?.data).toEqual({ kind: 'resume' });
      expect(tail[1]?.data).toEqual(abortedResult(TOOL_ABORTED_BEFORE_DISPATCH));
      expect(tail[2]?.data).toEqual(ABORTED_END);
      // 配的是暫停那一輪留下、還沒配到結果的那顆 `tool/call`。
      const call = run.root().find((event) => event.type === 'tool/call');
      expect((tail[1]?.data as { callId: string }).callId).toBe(
        (call?.data as { callId: string }).callId,
      );
      await until(() => run.frames.some(isStoppedFrame));

      // 下一句：模型看到的是我們寫的 dsh 原字串，不是基座補的「another message came in」。
      await run.pump.submit({ kind: 'message', text: '算了' });
      const tools = (run.model.prompts.at(-1) ?? []).filter(
        (message) => message.getType() === 'tool',
      );
      expect(tools.map((message) => message.text)).toEqual([TOOL_ABORTED_BEFORE_DISPATCH_TEXT]);
    } finally {
      await run.close();
    }
  });

  it('閒著時按停止：什麼都不做', async () => {
    const run = await assemble([{ content: '好。' }], [toolsPlugin({ started: 0, settled: 0 })]);
    try {
      await run.pump.submit({ kind: 'message', text: '嗨' });
      const before = run.root().length;
      expect(run.pump.cancel()).toBe('idle');
      await run.pump.whenIdle();
      expect(run.root()).toHaveLength(before);
    } finally {
      await run.close();
    }
  });
});

describe('線上', () => {
  it('`run.cancel` 回受理，不等停穩；沒有 run 在跑也照樣受理', async () => {
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns: [] }),
      checkpointer: new MemorySaver(),
      plugins: [],
    });
    const handler = createWireHandler({
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        commands: emptyCommandPoint(),
        dispose: () => built.dispose(),
      }),
    });
    const client = createWireClient({
      baseUrl: 'http://cancel.test',
      fetch: async (input, init) => handler.handle(new Request(input as string, init)),
    });
    try {
      await expect(client.runCancel('cancel-thread')).resolves.toMatchObject({
        type: 'success',
        result: { accepted: true },
      });
    } finally {
      await handler.close();
    }
  });
});
