/**
 * **前景子代理的核准交給人**——[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 1 項的驗收（翻了 [#324](https://github.com/DemianLi/nexus-agent/issues/324)
 * 的「子代理一律 `policy-never`」，僅限前景：前景時主對話本來就停著等；背景子代理背後沒有人，維持回絕，#737）。
 *
 * 產品路徑：真的 `createNexusAgent`＋真的 `ThreadPump`，量線上看得到什麼——下行收到幾顆 `input.requested`、帶誰的 namespace、
 * root 日誌記了幾筆、人按了什麼之後工具跑沒跑。核准閘門本身的規則（四個拒絕理由、waterfall）在 `packages/nexus-core/src/approval.test.ts`，
 * 單次 `agent.invoke` 的中斷／續行在 `interrupt.test.ts`。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const ran: string[] = [];

const DANGER: PluginEntry = {
  plugin: {
    name: 'danger',
    apply(registry) {
      registry.tools.register(
        tool(
          () => {
            ran.push('danger');
            return '危險的事做完了';
          },
          { name: 'danger', description: '要核准。', schema: z.object({}) },
        ),
      );
      registry.approvals.gate((exec, next) =>
        exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
      );
    },
  },
};

const WORKER: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

const delegate: ScriptedTurn = {
  content: '委派。',
  toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
};
const askDanger: ScriptedTurn = { content: '動手。', toolCalls: [{ name: 'danger', args: {} }] };

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function open(turns: readonly ScriptedTurn[]) {
  ran.length = 0;
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [DANGER, WORKER],
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'subagent-approval');
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  const requests = () => frames.filter((frame) => frame.method === 'input.requested');
  const rootTypes = () => pump.sessions.root.events.map((event) => event.type);
  return {
    pump,
    model,
    frames,
    requests,
    rootTypes,
    rootEvents: (type: string) => pump.sessions.root.events.filter((event) => event.type === type),
    async say(text: string) {
      await pump.submit({ kind: 'message', text });
      await until(() => pump.awaitingInput || frames.some(isRootDone));
      await pump.whenIdle();
    },
    async answer(type: 'approve' | 'reject') {
      await pump.submit({
        kind: 'resume',
        interruptId: pump.pendings[0]!.interruptId,
        response: { decisions: [{ type }] },
      });
      await pump.whenIdle();
    },
    close: async () => {
      line.abort();
      await draining;
      detach();
      await built.dispose();
    },
  };
}

const isRootDone = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { graph_name?: unknown }).graph_name === 'root' &&
  ['completed', 'failed'].includes(String((frame.params.data as { event?: unknown }).event));

describe('前景子代理要核准：卡片送到使用者面前，標明是哪個子代理', () => {
  it('下行只收到一顆 `input.requested`，帶子代理的 namespace（root 層那次露面被吞掉）；待答也記著它', async () => {
    const run = await open([
      delegate,
      askDanger,
      { content: '子代理收工。' },
      { content: '根收工。' },
    ]);
    try {
      await run.say('委派');
      expect(run.pump.awaitingInput).toBe(true);
      expect(ran).toEqual([]);

      const requests = run.requests();
      expect(requests).toHaveLength(1);
      // 第一段是基座給那次 `task` 呼叫的 namespace，畫面靠它去 `task` 那張卡認出是哪個子代理。
      expect(requests[0]?.params.namespace[0]).toMatch(/^tools:/);
      expect(run.pump.pendings).toHaveLength(1);
      expect(run.pump.pendings[0]?.request.params.namespace).toEqual(requests[0]?.params.namespace);
      // 日誌：一筆 `interrupt/raised`、一筆 `approval/asked`（帶 callId，配得上子代理那顆 `tool/call`）。
      expect(run.rootEvents('interrupt/raised')).toHaveLength(1);
      expect(run.rootEvents('approval/asked')).toHaveLength(1);
      expect(run.rootEvents('approval/asked')[0]?.data).toMatchObject({ toolName: 'danger' });
    } finally {
      await run.close();
    }
  }, 20000);

  it('核准 → 工具真的跑、子代理收工、root 收尾；審計一對 asked／decided（allowed-once）', async () => {
    const run = await open([
      delegate,
      askDanger,
      { content: '子代理收工。' },
      { content: '根收工。' },
    ]);
    try {
      await run.say('委派');
      await run.answer('approve');
      expect(ran).toEqual(['danger']);
      expect(run.pump.awaitingInput).toBe(false);
      expect(run.rootEvents('approval/decided')).toHaveLength(1);
      expect(run.rootEvents('approval/decided')[0]?.data).toMatchObject({
        outcome: 'allowed-once',
      });
      expect(run.pump.sessions.root.events.at(-1)?.type).toBe('turn/end');
      // 沒有再多的問題。
      expect(run.requests()).toHaveLength(1);
    } finally {
      await run.close();
    }
  }, 20000);

  it('拒絕只拒那一次：同一個子代理後面再叫一次，又是一顆新的問題；沒有被連坐', async () => {
    const run = await open([
      delegate,
      askDanger,
      askDanger,
      { content: '子代理收工。' },
      { content: '根收工。' },
    ]);
    try {
      await run.say('委派');
      await run.answer('reject');
      // 子代理沒有被停掉：它被拒之後又叫了一次，這次是第二顆問題。
      expect(run.pump.awaitingInput).toBe(true);
      expect(ran).toEqual([]);
      expect(run.requests()).toHaveLength(2);
      expect(run.requests()[1]?.params.namespace[0]).toBe(run.requests()[0]?.params.namespace[0]);

      await run.answer('approve');
      expect(ran).toEqual(['danger']);
      expect(run.pump.awaitingInput).toBe(false);
      expect(run.rootEvents('approval/decided').map((event) => event.data)).toMatchObject([
        { outcome: 'rejected' },
        { outcome: 'allowed-once' },
      ]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('按停止：問題被收回（cancelled），工具沒跑，這一輪收尾', async () => {
    const run = await open([
      delegate,
      askDanger,
      { content: '子代理收工。' },
      { content: '根收工。' },
    ]);
    try {
      await run.say('委派');
      expect(run.pump.awaitingInput).toBe(true);
      await run.pump.cancel();
      await run.pump.whenIdle();
      expect(ran).toEqual([]);
      expect(run.pump.awaitingInput).toBe(false);
      expect(run.rootEvents('approval/decided')[0]?.data).toMatchObject({ outcome: 'cancelled' });
    } finally {
      await run.close();
    }
  }, 20000);
});
