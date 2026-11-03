/**
 * #2353 的 `run_javascript` 改成 `NexusTool` 之後，在真的組裝裡模型看到的工具定義、工具結果，與日誌上的 `tool/result`，
 * 與 `quickjs-migration.baseline.json` 逐字相同。
 *
 * 對照組在 `develop` `240e2354`（這顆還是 LangChain 工具時）以 `K3C_RECORD=1` 錄的。`K3C_RECORD=1` 會拿當下的輸出覆寫對照組。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import { createQuickJsPlugin, RUN_JAVASCRIPT_TOOL_NAME } from '@nexus/plugin-quickjs';
import type { QuickJsPluginOptions } from '@nexus/plugin-quickjs';
import { expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const BASELINE = new URL('./quickjs-migration.baseline.json', import.meta.url);

const cases: readonly (readonly [string, unknown, QuickJsPluginOptions])[] = [
  ['回傳值', { code: '1 + 1' }, {}],
  ['沒有回傳值', { code: 'const x = 1;' }, {}],
  ['async', { code: '(async () => 41 + 1)()' }, {}],
  ['字串', { code: '"嗨"' }, {}],
  ['物件', { code: '({ a: [1, { b: 2 }], c: "d" })' }, {}],
  ['拋例外', { code: 'throw new TypeError("壞了")' }, {}],
  ['reject', { code: 'Promise.reject(new RangeError("拒絕了"))' }, {}],
  ['逾時', { code: 'while (true) {}' }, { timeoutMs: 200 }],
  ['不會完成的 promise', { code: 'new Promise(() => {})' }, {}],
  ['不是無損 JSON', { code: 'NaN' }, {}],
  ['記憶體上限', { code: 'const a = []; for (;;) a.push(new Array(1e5).fill(1));' }, {}],
  ['堆疊上限', { code: 'function f(n) { return f(n + 1) + 1; } f(0);' }, {}],
  ['參數型別不對', { code: 1 }, {}],
  ['少參數', {}, {}],
  ['多一個鍵', { code: '1', extra: 1 }, {}],
];

async function runOne(args: unknown, options: QuickJsPluginOptions): Promise<unknown> {
  const model = new ScriptedChatModel({
    turns: [
      {
        content: '',
        toolCalls: [
          { name: RUN_JAVASCRIPT_TOOL_NAME, args: args as Record<string, unknown>, id: 'c1' },
        ],
      },
      { content: '收工。' },
    ],
  });
  const { agent, attachSession, dispose } = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [createQuickJsPlugin(options)],
  });
  const sessions = new SessionRegistry('quickjs');
  const detach = attachSession(sessions);
  try {
    await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'quickjs' } });
  } finally {
    detach();
    await dispose();
  }
  const bound = (model.boundTools ?? []) as StructuredToolInterface[];
  const tool = bound.find((entry) => entry.name === RUN_JAVASCRIPT_TOOL_NAME);
  const prompt = (model.prompts[1] ?? []) as readonly BaseMessage[];
  const message = prompt.find((entry): entry is ToolMessage => ToolMessage.isInstance(entry));
  const rootLog = sessions.list().find((entry) => entry.address.kind === 'root');
  return {
    wire: tool === undefined ? undefined : JSON.stringify(convertToOpenAITool(tool)),
    seen:
      message === undefined
        ? undefined
        : {
            content: message.content,
            status: message.status,
            name: message.name,
            id: message.tool_call_id,
          },
    logged: (rootLog?.log.events ?? []).flatMap((event) =>
      event.type === 'tool/result'
        ? [{ isError: event.data.isError, error: event.data.error, content: event.data.content }]
        : [],
    ),
  };
}

it('run_javascript 的工具定義、結果與日誌，與對照組逐字相同', { timeout: 60_000 }, async () => {
  const now: Record<string, unknown> = {};
  for (const [label, args, options] of cases) now[label] = await runOne(args, options);
  if (process.env.K3C_RECORD === '1') {
    writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  const before = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(now)).toEqual(Object.keys(before));
  for (const key of Object.keys(before)) expect(now[key], key).toEqual(before[key]);
});
