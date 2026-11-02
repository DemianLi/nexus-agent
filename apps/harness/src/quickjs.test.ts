/**
 * `@nexus/plugin-quickjs` 在**真的 agent 迴圈**裡的驗收。
 *
 * 與 `packages/nexus-plugin-quickjs/src/index.test.ts` 分工：那邊驗的是直譯器本身的兩種
 * 邊界（能力與資源），這裡驗的是**接線**——經我們的 registry 註冊進去的工具真的被基座
 * 排進工具集合、真的在迴圈裡執行、結果真的回到對話裡，而且與基座內建的檔案工具並存無礙。
 *
 * 只有模型是假的（[#31](https://github.com/DemianLi/nexus-agent/issues/31)：CI 不放模型
 * secret），其餘都是真的。假模型證明不了「模型會不會想到用這個工具」——那是模型的行為，
 * 不是我們的程式碼。
 *
 * **並存那一條是這個檔案存在的主要理由。** `run_javascript` 與基座的 `write_file` 走的是
 * 兩條完全不同的路（custom tool vs. filesystem middleware），而
 * [`sandbox-backend-conflict.test.ts`](./sandbox-backend-conflict.test.ts) 說明了走錯路
 * 的版本會在組裝期炸掉。這裡是那個決定走對了的正面證據。
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import { createQuickJsPlugin, RUN_JAVASCRIPT_TOOL_NAME } from '@nexus/plugin-quickjs';
import type { QuickJsPluginOptions } from '@nexus/plugin-quickjs';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

describe('run_javascript 在 agent 迴圈裡', () => {
  it('求值結果回到對話裡，而且同一輪的 write_file 照樣寫得進磁碟', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-quickjs-'));
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [
            {
              name: RUN_JAVASCRIPT_TOOL_NAME,
              args: { code: '[1, 2, 3, 4].reduce((a, b) => a + b, 0)' },
            },
            { name: 'write_file', args: { file_path: '/算完的.md', content: '一起跑的' } },
          ],
        },
        { content: '算完了。' },
      ],
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [createQuickJsPlugin()],
    });

    try {
      const result = await agent.invoke(toAgentInvocation('把 1 到 4 加起來。'));
      const outputs = result.messages
        .filter((message) => message.getType() === 'tool')
        .map((message) => message.text);

      expect(outputs).toContain('10');
    } finally {
      await dispose();
    }

    // 並存的證據在磁碟上：custom tool 那條路沒有把 filesystem middleware 擠掉。
    expect(await readFile(join(root, '算完的.md'), 'utf8')).toBe('一起跑的');
  });

  // 資源上限透過組裝點傳得進去的證據。少了這一條，`timeoutMs` 就只是 plugin 單測裡的
  // 一個參數，沒人知道它在真的組裝裡還在不在。
  it('逾時在真的迴圈裡也擋得住，而且那一輪接得下去', async () => {
    const { tool, logged, last } = await runOne({ code: 'while (true) {}' }, { timeoutMs: 200 });

    expect(tool?.text).toContain('執行超過 200 毫秒');
    expect(logged).toEqual([true]);
    // 迴圈沒有被 exception 打斷——模型收到的是一則工具訊息，還接得下去。
    expect(last).toBe('收工。');
  });
});

/**
 * **程式失敗是工具失敗**（[#615](https://github.com/DemianLi/nexus-agent/issues/615)，照 dsh
 * `run_code` 的 `CodeRunFailedError`）：工具拋、圍堵接。以前回一句 `錯誤：…` 的字串，模型、
 * 會話日誌、web 的工具卡三處都記成成功。
 *
 * 走真的組裝、接上會話日誌（`attachSession`，沒接的話圍堵不記日誌），看三處：模型收到的
 * ToolMessage 是 `status: 'error'`、文字帶得出失敗種類與原因；日誌那顆 `tool/result` 是
 * `isError: true`；那一輪照常收尾。
 */
describe('run_javascript 失敗時回報成工具錯誤', () => {
  it.each([
    [
      '程式拋例外',
      'throw new TypeError("壞了")',
      {},
      'code run failed (exception): TypeError: 壞了',
    ],
    [
      '回傳的 promise 被 reject',
      'Promise.reject(new RangeError("拒絕了"))',
      {},
      'code run failed (exception): RangeError: 拒絕了',
    ],
    [
      '逾時中斷',
      'while (true) {}',
      { timeoutMs: 200 },
      'code run failed (timeout): 執行超過 200 毫秒的上限，已中斷。',
    ],
    [
      '回傳一個永遠不會完成的 promise（demian 2026-09-25 拍板算失敗）',
      'new Promise(() => {})',
      {},
      'code run failed (timeout): 回傳了一個永遠不會完成的 promise',
    ],
  ] as const)('%s', async (_label, code, options, expected) => {
    const { tool, logged, errors, last } = await runOne({ code }, options);

    expect(tool?.status).toBe('error');
    // 圍堵的前綴只有一層：工具自己不再帶 `錯誤：`。
    expect(tool?.text).toContain(`工具 ${RUN_JAVASCRIPT_TOOL_NAME} 執行失敗：${expected}`);
    expect(tool?.text).not.toContain('錯誤：');
    expect(logged).toEqual([true]);
    // 碼照 dsh 跟著進日誌：`CodeRunFailedError` 是 `HarnessError`，圍堵記它的 `{ name, code }`。
    expect(errors).toEqual([{ name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' }]);
    expect(last).toBe('收工。');
  });

  it.each([
    ['回傳值照舊', '1 + 1', '2'],
    ['沒有回傳值照舊', 'const x = 1;', '（沒有回傳值）'],
    ['async 照舊拿得到值', '(async () => 41 + 1)()', '42'],
  ])('成功的不變：%s', async (_label, code, expected) => {
    const { tool, logged, errors } = await runOne({ code }, {});

    expect(tool?.status).not.toBe('error');
    expect(tool?.text).toBe(expected);
    expect(logged).toEqual([false]);
    expect(errors).toEqual([]);
  });
});

/**
 * 在真的組裝、接上會話日誌的情況下叫一次 `run_javascript`。
 *
 * @returns 模型收到的那則工具訊息、root 日誌上每顆 `tool/result` 的 `isError`、最後一則訊息的文字。
 */
async function runOne(
  args: { readonly code: string },
  options: QuickJsPluginOptions,
): Promise<{
  tool: ToolMessage | undefined;
  logged: boolean[];
  errors: unknown[];
  last: string | undefined;
}> {
  const { agent, attachSession, dispose } = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        { content: '', toolCalls: [{ name: RUN_JAVASCRIPT_TOOL_NAME, args }] },
        { content: '收工。' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [createQuickJsPlugin(options)],
  });
  const sessions = new SessionRegistry('quickjs');
  const detach = attachSession(sessions);
  let messages: BaseMessage[];
  try {
    ({ messages } = (await agent.invoke(toAgentInvocation('跑。'), {
      configurable: { thread_id: 'quickjs' },
    })) as { messages: BaseMessage[] });
  } finally {
    detach();
    await dispose();
  }
  const rootLog = sessions.list().find((entry) => entry.address.kind === 'root');
  return {
    tool: messages.find((message): message is ToolMessage => ToolMessage.isInstance(message)),
    logged: (rootLog?.log.events ?? []).flatMap((event) =>
      event.type === 'tool/result' ? [event.data.isError] : [],
    ),
    errors: (rootLog?.log.events ?? []).flatMap((event) =>
      event.type === 'tool/result' && event.data.error !== undefined ? [event.data.error] : [],
    ),
    last: messages.at(-1)?.text,
  };
}
