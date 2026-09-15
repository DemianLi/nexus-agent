/**
 * **上游絆索的子行程**（[#346](https://github.com/DemianLi/nexus-agent/issues/346)）：裸 `createAgent`、
 * 工具本體拋錯、走 v3 `streamEvents`、**不裝** `unhandledRejection` handler。
 *
 * 今天（`langchain@1.5.10`）這個行程會因為 `tool-call.ts` reject 掉那顆沒人 await 的 `output`
 * 而以非 0 結束。哪天它乾淨地跑完，就是上游修掉了——`ThreadPump` 裡替投影掛 catch 的那一段
 * 該拆了。由 `tool-throw-orphan.test.ts` 在子行程裡跑：直接在 vitest 裡觸發的話，會被 vitest
 * 自己的 unhandled 偵測報成整份測試失敗。
 */

import { tool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { ScriptedChatModel } from './scripted-model.js';

const boom = tool(
  async () => {
    throw new Error('Service temporarily overloaded');
  },
  { name: 'boom', description: '一律拋錯。', schema: z.object({}) },
);

const agent = createAgent({
  model: new ScriptedChatModel({
    turns: [{ content: '', toolCalls: [{ name: 'boom', args: {} }] }, { content: '收到錯誤了。' }],
  }),
  tools: [boom],
});

const run = await agent.streamEvents({ messages: [{ role: 'user', content: '跑。' }] }, {
  version: 'v3',
  configurable: { thread_id: 'upstream-orphan' },
} as never);
for await (const _ of run as AsyncIterable<unknown>) void _;
