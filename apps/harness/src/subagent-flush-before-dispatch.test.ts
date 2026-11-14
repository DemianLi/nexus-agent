/**
 * 送出模型請求之前的排空時機（`flushBeforeDispatch`）：root 與子代理一致嗎？（[#2751](https://github.com/DemianLi/nexus-agent/issues/2751)）
 *
 * `fold.ts` 只給 native＋`history-source=log` 的 root 加 `preRecord`（推導之前先寫快照與 `model/start`），子代理沒有；但請求快照記錄器
 * 是 `shared` 的，root 與每個子代理走同一顆，`flushBeforeDispatch` 跟存檔點開關。這個檔**實際量**：在註冊表上掛一個排空者，
 * 記下每次被問到哪一份日誌、當時那份日誌已經有哪些事件；再看「送出」（模型被叫）時它是什麼時候。要回答：崩潰時子日誌上
 * 「送出去但沒落盤」的窗口是否與 root 一致。
 *
 * 量到的就是釘的：每一次模型被叫，那一份日誌在送出之前至少被排空過一次，而且排空那一刻 `request/header` 與 `model/start` 都已經在日誌上。
 * root 與前景子代理兩邊各斷言一遍。
 *
 * 明給 `historySource` 與 `agentLoop`；沒接真的持久化（排空者是這裡掛的記錄用的），所以量的是**呼叫時序**，
 * 不是磁碟上的內容。**零憑證、零外部連線**：模型是 `ScriptedChatModel`。
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
  /** 每份日誌上 `model/start` 之後的第一次排空是不是在 `model/start` 已經寫了之後。 */
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
    '%s：root 與子代理每次模型被叫之前，那份日誌都被排空過，而且當時 request/header 與 model/start 已經在',
    async (historySource) => {
      const result = await run(loop, historySource);
      expect(result.built).toBe(historySource);
      const kinds = [...result.byLog.values()].map((entry) => entry.kind).sort();
      expect(kinds).toEqual(['root', 'subagent']);

      const shape = new Map<string, { calls: number; flushes: number; afterStart: number }>();
      for (const [id, { kind, log }] of result.byLog) {
        const modelCalls = log.events.filter((event) => event.type === 'model/start').length;
        expect(modelCalls, `${kind} 沒叫過模型`).toBeGreaterThan(0);
        // 排空者被問到這份日誌、且當時 model/start 已寫：每次模型被叫至少一次。
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
        // 排空那一刻，送出所需的請求記錄已經在日誌上。
        for (const flush of afterStart) {
          expect(flush.types, `${kind}`).toContain('request/header');
        }
      }
      // 兩邊各叫兩次模型：被問排空的次數一樣（子代理沒有 preRecord，也沒有少排或多排）。
      expect(shape.get('subagent')).toEqual(shape.get('root'));
    },
  );
});
