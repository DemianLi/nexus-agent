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
import { createQuickJsPlugin, RUN_JAVASCRIPT_TOOL_NAME } from '@nexus/plugin-quickjs';
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
  it('逾時在真的迴圈裡也擋得住，而且擋下來的是一句話不是一個 exception', async () => {
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: RUN_JAVASCRIPT_TOOL_NAME, args: { code: 'while (true) {}' } }],
        },
        { content: '跑太久了。' },
      ],
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createQuickJsPlugin({ timeoutMs: 200 })],
    });

    try {
      const result = await agent.invoke(toAgentInvocation('跑一個無限迴圈。'));
      const denial = result.messages.find((message) => message.getType() === 'tool');

      // 迴圈沒有被 exception 打斷——模型收到的是一則工具訊息，還接得下去。
      expect(denial?.text).toContain('執行超過 200 毫秒');
      expect(result.messages.at(-1)?.text).toBe('跑太久了。');
    } finally {
      await dispose();
    }
  });
});
