/**
 * **背景子代理直接走 v3 `streamEvents` 的子行程**（[#738](https://github.com/DemianLi/nexus-agent/issues/738)
 * 第 4 項的對照組）：拿 fold 折出來的子代理規格自己編一張圖（同 `subagent-background-probe.test.ts` 的乙路），
 * 直接 `streamEvents(…, { version: 'v3' })`，工具本體拋錯，**不裝** `unhandledRejection` handler，也不經 `ThreadPump`。
 *
 * 由探針在子行程裡跑：直接在 vitest 裡觸發的話，會被 vitest 自己的 unhandled 偵測報成整份測試失敗。
 * 跑得起來且以非 0 結束，代表「圍堵在圖的 middleware 裡」救不了 v3 投影那顆沒人接的 `output` promise——
 * 背景那一輪要串流給 web 的話，得經過 pump 那一段接住的路（見 `thread-pump.ts` 替投影掛 catch 的那段）。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { foldRegistry, loadPlugins } from '@nexus/core';
import {
  createFilesystemMiddleware,
  createPatchToolCallsMiddleware,
  createSummarizationMiddleware,
} from 'deepagents';
import { createAgent } from 'langchain';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BASE_TOOL_NAMES } from './base-tools.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';

const model = new ScriptedChatModel({
  turns: [{ content: '', toolCalls: [{ name: 'boom_bg', args: {} }] }, { content: '收到錯誤了。' }],
});

const { registry } = await loadPlugins([
  {
    plugin: {
      name: 'background-host',
      apply(r) {
        r.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '幹活。',
          tools: [
            tool(
              () => {
                throw new Error('Service temporarily overloaded');
              },
              { name: 'boom_bg', description: '一律拋錯。', schema: z.object({}) },
            ),
          ],
        });
      },
    },
  },
]);
const params = foldRegistry(registry, {
  defaultBackend: new ContainedFilesystemBackend({
    rootDir: mkdtempSync(join(tmpdir(), 'nexus-bg-orphan-')),
    mode: 'workspace-write',
  }),
  model,
  checkpointer: new MemorySaver(),
  baseToolNames: BASE_TOOL_NAMES,
});
const spec = (params.subagents ?? []).find((candidate) => candidate.name === 'worker')!;

const custom = new Map((spec.middleware ?? []).map((entry) => [entry.name, entry]));
const defaults = [
  createFilesystemMiddleware({ backend: params.backend as never }),
  createSummarizationMiddleware({ backend: params.backend as never }),
  createPatchToolCallsMiddleware(),
];
const agent = createAgent({
  model: model as never,
  systemPrompt: spec.systemPrompt,
  tools: (spec.tools ?? []) as never,
  middleware: [
    ...defaults.map((entry) => custom.get(entry.name) ?? entry),
    ...(spec.middleware ?? []).filter((entry) => !defaults.some((d) => d.name === entry.name)),
  ] as never,
  checkpointer: new MemorySaver(),
});

const run = await agent.streamEvents(
  { messages: [{ role: 'user', content: '跑。' }] } as never,
  {
    version: 'v3',
    configurable: { thread_id: 'background-orphan' },
  } as never,
);
for await (const _ of run as AsyncIterable<unknown>) void _;
