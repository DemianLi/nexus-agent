/**
 * `LANGSMITH_HIDE_INPUTS` / `LANGSMITH_HIDE_OUTPUTS` 這道煞車的實測。
 *
 * **為什麼自己一個檔案。** `getDefaultLangChainClientSingleton()` 是 module-private 的
 * `let client`，沒有 setter（`@langchain/core@1.2.9`，`dist/singletons/tracer.js`），而
 * `hideInputs` / `hideOutputs` 是 client 建構時從環境變數讀進去的
 * （`langsmith@0.9.0`，`dist/client.js:911-930`）。所以一個 process 裡第一次觸發 tracing
 * 的那組設定就定生死——把這一條跟 {@link ./tracing.test.ts} 的原文外洩放同一個檔案，
 * 後跑的那條會沿用先跑那條的 client，設定改了也沒用（實測：請求打向已經關掉的舊
 * server，重試了 17 秒才放棄）。vitest 預設每個**檔案**一個 fork，換檔案才換得掉。
 *
 * 這件事本身也是結論的一部分：**「跑起來之後才想開脫敏」做不到。**
 *
 * 這一條是純負面斷言（機密不出現），所以先 `waitForHits` 確認東西真的送到了再斷言——
 * 正對照在另一個檔案：同一個工具、同一串機密，不設 hide 就外洩。
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tool } from '@langchain/core/tools';
import type { NexusPlugin } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const SECRET = 'sk-機密值-12345';

const TRACING_ENV = [
  'LANGSMITH_TRACING',
  'LANGSMITH_ENDPOINT',
  'LANGSMITH_API_KEY',
  'LANGSMITH_PROJECT',
  'LANGSMITH_HIDE_INPUTS',
  'LANGSMITH_HIDE_OUTPUTS',
  'LANGCHAIN_CALLBACKS_BACKGROUND',
] as const;

let server: Server;
let hits: string[] = [];

beforeEach(async () => {
  hits = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      hits.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  for (const name of TRACING_ENV) delete process.env[name];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const plugin: NexusPlugin = {
  name: 'tracing-probe',
  apply: (registry) =>
    void registry.tools.register(
      tool(({ secret }) => `讀到了：${secret}`, {
        name: 'probe_tool',
        description: '把收到的東西唸一次。',
        schema: z.object({ secret: z.string().describe('一串不該出境的東西') }),
      }),
    ),
};

describe('HIDE_INPUTS / HIDE_OUTPUTS', () => {
  it('擋得住原文，但擋法是整組清空', async () => {
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.LANGSMITH_ENDPOINT = endpoint;
    process.env.LANGSMITH_API_KEY = 'ls-fake-for-test';
    process.env.LANGSMITH_PROJECT = 'nexus-tracing-test';
    process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';
    process.env.LANGSMITH_HIDE_INPUTS = 'true';
    process.env.LANGSMITH_HIDE_OUTPUTS = 'true';
    // loopback 確認之後才開，理由同 tracing.test.ts 的 armTracing。
    expect(process.env.LANGSMITH_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    process.env.LANGSMITH_TRACING = 'true';

    const model = new ScriptedChatModel({
      turns: [
        { content: '', toolCalls: [{ name: 'probe_tool', args: { secret: SECRET } }] },
        { content: '唸完了。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({ model, plugins: [plugin] });
    try {
      await agent.invoke(toAgentInvocation('唸一下。'));
    } finally {
      await dispose();
    }

    const deadline = Date.now() + 5_000;
    while (hits.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // 先確認東西真的送到了，否則下面那條負面斷言會被「壓根沒送」滿足。
    expect(hits.length).toBeGreaterThanOrEqual(2);

    const body = hits.join('');
    expect(body).not.toContain(SECRET);
    // 擋法是把 inputs / outputs 換成空物件——**trace 還在，只是沒有內容**
    // （`dist/client.js:1162-1185`：`hideInputs === true` 直接 `return {}`）。
    // 這就是它跟「按規則脫敏」的差別，也是自備 client 那條存在的理由。
    expect(body).toContain('.inputs');
    expect(body).toContain('{}');
  }, 20_000);
});
