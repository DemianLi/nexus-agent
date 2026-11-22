/**
 * 子代理的工具動手之前，子代理那一份日誌已經排空（[#722](https://github.com/DemianLi/nexus-agent/issues/722)）：
 * **走產品組裝**——真的 `createNexusAgent`、真的 fold 出來的子代理堆疊與圍堵、真的持久化協調器（窗口開到上限，
 * 所以後端看到東西只可能是檢查點排的），後端是記憶體替身。
 *
 * 工具本體在被叫的那一刻去看後端：這次呼叫自己的 `tool/call` 在不在。不在，就是強制結束時
 * 「外部副作用發生了、日誌上卻沒有那次呼叫」的那條路。前景（基座的 `task`）與背景（`BackgroundSubagentHost`）
 * 各一條，兩條子代理的堆疊是分開編的。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { attachSessionPersistence, MAX_PERSISTENCE_WINDOW_MS, SessionRegistry } from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionStore, StoredSession } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-sub-checkpoint-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 後端的替身：記下每份日誌寫進來的事件。 */
function memoryStore() {
  const written = new Map<string, SessionEvent[]>();
  const never = () => Promise.reject(new Error('協調器不該讀'));
  const store: SessionStore = {
    list: never,
    open: never,
    resume: never,
    create(header): StoredSession {
      const events: SessionEvent[] = [];
      written.set(header.id, events);
      return {
        append: (batch) => {
          events.push(...batch);
          return Promise.resolve();
        },
        flush: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
    },
  };
  return { store, written };
}

async function assemble(background: boolean) {
  const { store, written } = memoryStore();
  /** 工具本體被叫的那一刻，各份「非 root」日誌在後端的事件種類。 */
  const seen: Record<string, string[]>[] = [];
  const worker: PluginEntry = {
    plugin: {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          model: new ScriptedChatModel({
            turns: [
              { content: '', toolCalls: [{ name: 'probe', id: 'probe-call', args: {} }] },
              { content: '做完' },
            ],
          }) as never,
        });
        registry.tools.register(
          tool(
            async () => {
              seen.push(
                Object.fromEntries(
                  [...written]
                    .filter(([id]) => id !== 'root-1')
                    .map(([id, events]) => [id, events.map((event) => event.type)]),
                ),
              );
              return '探過了';
            },
            { name: 'probe', description: '探針。', schema: z.object({}) },
          ),
        );
      },
    },
  };
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'subagent',
              id: 'root-call',
              args: { description: '幹活', subagent_type: 'worker', run_in_background: background },
            },
          ],
        },
        { content: '根收尾' },
        { content: '收到' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [worker],
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    backgroundSubagents: {},
  });
  const sessions = new SessionRegistry('root-1');
  const detachPersistence = attachSessionPersistence(sessions, store, {
    windowMs: MAX_PERSISTENCE_WINDOW_MS,
  });
  const detach = built.attachSession(sessions, {});
  return {
    seen,
    async say() {
      await built.agent.invoke(
        { messages: [new HumanMessage('委派')] },
        { configurable: { thread_id: 'thread-1' } },
      );
    },
    async close() {
      detach();
      await detachPersistence.dispose();
      await built.dispose();
    },
  };
}

describe('子代理的工具動手之前，子代理那一份已經在後端', () => {
  for (const [label, background] of [
    ['前景（task）', false],
    ['背景（BackgroundSubagentHost）', true],
  ] as const) {
    it(`${label}：探針被叫的那一刻，子代理日誌上這次呼叫的 tool/call 已經寫到後端`, async () => {
      const run = await assemble(background);
      try {
        await run.say();
        await until(() => run.seen.length === 1);
        const logs = Object.values(run.seen[0]!);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('tool/call');
      } finally {
        await run.close();
      }
    });
  }
});
