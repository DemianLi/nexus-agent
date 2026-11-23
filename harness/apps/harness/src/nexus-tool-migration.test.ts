/**
 * #2352 的六顆 `NexusTool` 插件經 `langChainToolOf` 轉出來之後，送上線的工具定義、驗證與拒絕的結果，
 * 與 `nexus-tool-migration.baseline.json` 逐字相同。
 *
 * 對照組在 `develop` `76db1d8e`（這幾顆還是 LangChain 工具時）以 `K3B_RECORD=1` 錄的，當時轉接器在 `./nexus-tool-adapter.js`。
 * `K3B_RECORD=1` 會拿當下的輸出覆寫對照組。帶查找的工具都接成「沒接上」，所以合格的輸入走到的是本體裡第一條拒絕。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { createAskUserTool } from '@nexus/plugin-ask-user';
import { createEchoTool } from '@nexus/plugin-echo';
import { createGoalTools } from '@nexus/plugin-goal';
import { createPresentDelivery } from '@nexus/plugin-present';
import { createSubmitRecordTool } from '@nexus/plugin-submit-record';
import { createTodoTool } from '@nexus/plugin-todo';
import { isNexusTool } from '@nexus/tools';
import type { NexusTool } from '@nexus/tools';
import { expect, it } from 'vitest';

import { langChainToolOf } from '@nexus/tool-adapter';

const BASELINE = new URL('./nexus-tool-migration.baseline.json', import.meta.url);
const notAttached = () => ({ kind: 'not-attached' }) as never;

function tools(): StructuredToolInterface[] {
  const made: unknown[] = [
    createEchoTool(),
    createTodoTool(false, notAttached),
    createTodoTool(true, notAttached),
    createPresentDelivery(4, { sessions: notAttached, fs: notAttached }).tool,
    createAskUserTool(() => undefined),
    ...createGoalTools({ forCall: notAttached, serviceFor: notAttached }),
    createSubmitRecordTool(notAttached),
  ];
  return made.map((tool) =>
    isNexusTool(tool as NexusTool)
      ? langChainToolOf(tool as NexusTool)
      : (tool as StructuredToolInterface),
  );
}

const common: readonly unknown[] = [{}, { extra: 1 }, '嗨', null];
const inputs: Record<string, readonly unknown[]> = {
  echo: [{ message: '嗨' }, { message: 3 }, { message: '嗨', extra: 1 }],
  todo_write: [
    { todos: [{ content: 'a', status: 'pending' }] },
    { todos: [{ content: 'a', status: 'bad' }] },
    { todos: [{ content: 'a', status: 'pending', x: 1 }] },
    { todos: [{ content: 'a', status: 'pending' }], extra: 1 },
  ],
  present: [
    { files: [{ path: 'a' }] },
    { files: [{ path: 1 }] },
    { files: [{ path: 'a', x: 1 }] },
    { files: [{ path: 'a', description: 'd' }], extra: 1 },
  ],
  ask_user_question: [
    { questions: [{ id: 'q', question: '?' }] },
    { questions: [{ id: 1 }] },
    { questions: [{ id: 'q', question: '?', x: 1, options: [{ label: 'a', y: 2 }] }] },
    { questions: [], extra: 1 },
  ],
  get_goal: [],
  create_goal: [{ objective: 'x' }, { objective: 1 }, { objective: 'x', max_goal_rounds: '3' }],
  update_goal: [
    { goal_id: 'g', revision: 1, action: 'edit', objective: 'y' },
    { goal_id: 'g', revision: 1, action: 'bad' },
    { goal_id: 'g', revision: 1, action: 'blocked', blocked_reason: 'r', extra: 1 },
  ],
  submit_record: [
    { file_path: '/a.csv', record: { a: '1' } },
    { file_path: '/a.csv', record: { a: 1 } },
    { file_path: '/a.csv', record: {}, extra: 1 },
  ],
};

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    const result = await run();
    if (ToolMessage.isInstance(result) || AIMessage.isInstance(result)) {
      const message = result as ToolMessage;
      return {
        content: message.content,
        status: message.status,
        id: message.tool_call_id,
        name: message.name,
      };
    }
    return result;
  } catch (error) {
    return { threw: (error as Error).constructor.name, message: (error as Error).message };
  }
}

async function record(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const tool of tools()) {
    const key = out[tool.name] === undefined ? tool.name : `${tool.name}#2`;
    const results: unknown[] = [];
    for (const args of [...(inputs[tool.name] ?? []), ...common]) {
      const call = {
        name: tool.name,
        args: args as Record<string, unknown>,
        id: 'c1',
        type: 'tool_call' as const,
      };
      results.push({
        args,
        toolCall: await outcome(() => tool.invoke(call)),
        bare: await outcome(() => tool.invoke(args as never)),
      });
    }
    out[key] = { wire: JSON.stringify(convertToOpenAITool(tool)), results };
  }
  return out;
}

it('六顆插件的工具定義、驗證與拒絕，與對照組逐字相同', async () => {
  const now = await record();
  if (process.env.K3B_RECORD === '1') {
    writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  const before = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(now)).toEqual(Object.keys(before));
  for (const key of Object.keys(before)) expect(now[key], key).toEqual(before[key]);
});
