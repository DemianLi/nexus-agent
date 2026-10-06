/**
 * **serve 的每條 thread 共用同一本錨定估算的帳**——[#702](https://github.com/DemianLi/nexus-agent/issues/702)
 * 的產品路徑驗收。
 *
 * 帳以前是 `@nexus/core` 的模組全域，現在由 `runServe` 建一本、每條 thread 的組裝都傳同一本。「第二條 thread 的第一次借
 * 第一條的」（[#588](https://github.com/DemianLi/nexus-agent/issues/588)）因此成了組裝點的責任：誰把它改成每條 thread
 * 各建一本，行為不報錯，只是第一次又退回純估算——這個檔就是為了讓那件事有測試會紅。
 *
 * 對手方是本機的假端點（串流，最後一顆 chunk 帶 usage）。**`prompt_tokens` 固定報一個遠大於純估算的數**，借到了就
 * 一眼分得出來；回應裡的 `model` 與請求同名，否則帳不記（`token-estimate.ts`）。
 *
 * 突變（量過）：`serve.ts` 對每條 thread 傳 `new TokenAnchorBook()`（或不傳），第二條那一格掉回純估算，這裡紅。
 *
 * **零憑證、零外部連線**：假 key、本機端點。
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { DEFAULT_LIVE_MODEL_ENTRY, LIVE_API_KEY_ENV } from './live-model.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

/** 假端點報的 prompt token 數：遠大於這段對話的純估算（幾百），借到了才會是這個量級。 */
const REPORTED_PROMPT_TOKENS = 40_000;

async function startUsageEndpoint(): Promise<{ server: Server; baseUrl: string }> {
  let next = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown };
      next += 1;
      // 每次回應的 id 都不同：同 id 的 AI 訊息會被 reducer 取代。
      const id = `chatcmpl-anchor-${String(next)}`;
      const model = typeof body.model === 'string' ? body.model : 'unknown';
      const frame = (payload: Record<string, unknown>): string =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 1_790_000_000,
          model,
          ...payload,
        })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        frame({
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        }),
      );
      response.write(
        frame({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] }),
      );
      response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
      response.write(
        frame({
          choices: [],
          usage: {
            prompt_tokens: REPORTED_PROMPT_TOKENS,
            completion_tokens: 1,
            total_tokens: REPORTED_PROMPT_TOKENS + 1,
          },
        }),
      );
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${String(port)}/v1` };
}

describe('serve：帳是這台 server 的，不是一條 thread 的', () => {
  let fake: Awaited<ReturnType<typeof startUsageEndpoint>>;
  let running: RunningServe | undefined;

  beforeEach(async () => {
    vi.stubEnv(LIVE_API_KEY_ENV, 'sk-fake-anchor-book');
    fake = await startUsageEndpoint();
  });
  afterEach(async () => {
    await running?.close();
    running = undefined;
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  it('第二條 thread 的第一次借第一條的實數，不是純估算', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-anchor-book-'));
    const patch = join(dir, 'live-model.patch.yml');
    await writeFile(patch, `- id: live-model\n  config:\n    baseUrl: '${fake.baseUrl}'\n`, 'utf8');
    running = (await runServe({
      argv: ['--port', '0', '--live', '--patch', patch],
      log: () => undefined,
      env: {},
    })) as RunningServe;
    const client = await serveClient(running);

    const measureOf = async (threadId: string): Promise<number> => {
      const events = await client.openEvents(threadId);
      await client.runStart(threadId, '說一句話。');
      const state = await foldTurn(events);
      await events.return?.(undefined);
      const measure = state.contextPressure?.measure;
      if (measure === undefined) throw new Error(`thread ${threadId} 沒有量到 context/measure`);
      return measure.approxTokens;
    };

    const first = await measureOf('anchor-a');
    // 前提：第一條 thread 帳上什麼都沒有，量到的是純估算，遠小於假端點報的實數。
    expect(first).toBeLessThan(REPORTED_PROMPT_TOKENS / 4);

    const second = await measureOf('anchor-b');
    // 借錨：T(ref) ＋ 增量，量級跟著實數走。
    expect(second).toBeGreaterThan(REPORTED_PROMPT_TOKENS * 0.75);
    expect(second).toBeLessThan(REPORTED_PROMPT_TOKENS * 1.25);
  }, 60000);
});

describe('serve：型錄宣告逐位切詞的模型，第一次就按位數估（#1102）', () => {
  let fake: Awaited<ReturnType<typeof startUsageEndpoint>>;
  let running: RunningServe | undefined;

  beforeEach(async () => {
    vi.stubEnv(LIVE_API_KEY_ENV, 'sk-fake-anchor-book');
    fake = await startUsageEndpoint();
  });
  afterEach(async () => {
    await running?.close();
    running = undefined;
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  /** 起一台 serve、問一輪（prompt 是一長串數字），回第一次呼叫量到的 `approxTokens`。 */
  async function firstMeasure(models: readonly unknown[] | undefined): Promise<number> {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-digits-'));
    const patch = join(dir, 'live-model.patch.yml');
    await writeFile(
      patch,
      [
        '- id: live-model',
        '  config:',
        `    baseUrl: '${fake.baseUrl}'`,
        ...(models === undefined ? [] : [`    models: ${JSON.stringify(models)}`]),
        '',
      ].join('\n'),
      'utf8',
    );
    running = (await runServe({
      argv: ['--port', '0', '--live', '--patch', patch],
      log: () => undefined,
      env: {},
    })) as RunningServe;
    const client = await serveClient(running);
    // 每次一條新 thread：同 id 會續接上一次留在磁碟上的日誌，第二次就錨在上一次的實數上。
    const threadId = `digits-${randomUUID()}`;
    const events = await client.openEvents(threadId);
    await client.runStart(threadId, '7'.repeat(3000));
    const state = await foldTurn(events);
    await events.return?.(undefined);
    await running.close();
    running = undefined;
    const measure = state.contextPressure?.measure;
    if (measure === undefined) throw new Error('沒有量到 context/measure');
    return measure.approxTokens;
  }

  it('出廠那一筆宣告了 single：3000 位數字比沒宣告的多估約 2000 個', async () => {
    const { tokenizer: _declared, ...undeclared } = DEFAULT_LIVE_MODEL_ENTRY;
    // 前提：出廠那一筆真的有宣告，不然下面兩邊一樣是空話。
    expect(_declared).toEqual({ digits: 'single' });
    const plain = await firstMeasure([undeclared]);
    const declared = await firstMeasure(undefined);
    expect(declared - plain).toBeGreaterThanOrEqual(1_900);
    expect(declared - plain).toBeLessThanOrEqual(2_100);
  }, 60000);
});
