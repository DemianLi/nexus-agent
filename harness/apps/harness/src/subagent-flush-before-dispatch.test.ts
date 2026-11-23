/**
 * root 與前景子代理在模型被叫的前後，日誌被排空的次數一致（[#2751](https://github.com/DemianLi/nexus-agent/issues/2751)）。
 *
 * `fold.ts` 只給 native＋`history-source=log` 的 root 加 `preRecord`（推導之前先寫快照與 `model/start`），子代理槽不給；但請求快照記錄器
 * 是 `shared` 的，root 與每個子代理走同一顆，`flushBeforeDispatch` 跟存檔點開關。這個檔在註冊表上掛一個排空者，記下每次被問到哪一份日誌、
 * 當時那份日誌上有哪些事件，斷言：
 *
 * - 每份日誌在第一顆 `model/start` 之後被排空的次數不少於模型呼叫數，排空時日誌上已有 `request/header`；
 * - root 與子代理各叫兩次模型時，呼叫數、被問排空的總次數、`model/start` 之後的排空次數都相同。
 *
 * 排空與「送出」的先後這裡沒有量（探針沒記模型被叫的時刻，檢查點政策自己也會排空）；送出前的那一次排空由 `request-snapshot.ts` 做，
 * 單元測試在 `packages/nexus-core/src/request-snapshot.test.ts`。沒接真的持久化（排空者是這裡掛的記錄用的），所以量的是呼叫次數，
 * 不是磁碟上的內容。明給 `historySource` 與 `agentLoop`。**零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { HistorySource, PluginEntry } from '@nexus/core';
import type { SessionLog } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import type { CreateNexusAgentOptions } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

type Loop = NonNullable<CreateNexusAgentOptions['agentLoop']>;

const WORKER: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
      });
      registry.tools.register(
        tool(() => '好', { name: 'noop', description: '什麼都不做。', schema: z.object({}) }),
      );
    },
  },
};

const TURNS: readonly ScriptedTurn[] = [
  {
    content: '委派。',
    toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
  },
  { content: '', toolCalls: [{ name: 'noop', args: {} }] },
  { content: '子代理收工。' },
  { content: '根收工。' },
];

interface Probe {
  /** 每次被問排空：日誌 id、當時那份日誌上的事件型別。 */
  readonly flushes: { readonly id: string; readonly types: readonly string[] }[];
  /** 每份日誌的 id 對到它是 root 還是子代理，以及那份日誌。 */
  readonly byLog: Map<string, { kind: 'root' | 'subagent'; log: SessionLog }>;
}

async function run(
  loop: Loop,
  historySource: HistorySource,
): Promise<Probe & { built: HistorySource }> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-flush-'));
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: TURNS }),
    checkpointer: new MemorySaver(),
    plugins: [WORKER],
    backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }),
    agentLoop: loop,
    historySource,
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'flush-probe');
  const detach = built.attachSession(pump.sessions);
  const flushes: Probe['flushes'] = [];
  const unflush = pump.sessions.onFlush(async (log) => {
    flushes.push({ id: log.sessionId, types: log.events.map((event) => event.type) });
  });
  try {
    await pump.submit({ kind: 'message', text: '委派' });
    await pump.whenIdle();
    const byLog = new Map<string, { kind: 'root' | 'subagent'; log: SessionLog }>();
    for (const entry of pump.sessions.list()) {
      byLog.set(entry.log.sessionId, {
        kind: entry.address.kind === 'subagent' ? 'subagent' : 'root',
        log: entry.log,
      });
    }
    return { flushes, byLog, built: built.historySource };
  } finally {
    unflush();
    detach();
    await built.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

describe.each(['langgraph', 'native'] as const)('送出之前的排空：%s', (loop) => {
  it.each(['state', 'log'] as const)(
    '%s：root 與子代理的排空次數不少於模型呼叫數，排空時日誌上已有 request/header，兩邊次數相同',
    async (historySource) => {
      const result = await run(loop, historySource);
      expect(result.built).toBe(historySource);
      const kinds = [...result.byLog.values()].map((entry) => entry.kind).sort();
      expect(kinds).toEqual(['root', 'subagent']);

      const shape = new Map<string, { calls: number; flushes: number; afterStart: number }>();
      for (const [id, { kind, log }] of result.byLog) {
        const modelCalls = log.events.filter((event) => event.type === 'model/start').length;
        expect(modelCalls, `${kind} 沒叫過模型`).toBeGreaterThan(0);
        // 排空者被問到這份日誌、且當時 model/start 已寫：次數不少於模型呼叫數。
        const afterStart = result.flushes.filter(
          (flush) => flush.id === id && flush.types.includes('model/start'),
        );
        expect(afterStart.length, `${kind} 在 model/start 之後沒被排空`).toBeGreaterThanOrEqual(
          modelCalls,
        );
        shape.set(kind, {
          calls: modelCalls,
          flushes: result.flushes.filter((flush) => flush.id === id).length,
          afterStart: afterStart.length,
        });
        // 排空那一刻，日誌上已有 request/header。
        for (const flush of afterStart) {
          expect(flush.types, `${kind}`).toContain('request/header');
        }
      }
      // 兩邊各叫兩次模型：呼叫數、排空總數、model/start 之後的排空數都相同。
      expect(shape.get('subagent')).toEqual(shape.get('root'));
    },
  );
});
