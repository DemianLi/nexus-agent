/**
 * **`model.catalog`／`model.select` 與選擇的即時推送，走完 serve**——[#723](https://github.com/DemianLi/nexus-agent/issues/723)
 * 的線上驗收。機制在 `packages/nexus-core/src/model-selection.test.ts`，組裝後的請求本體在 `model-selection.test.ts`。
 *
 * 真的 `runServe`（`--live`，`live-model` 那一列用 `--patch` 指向本機假端點）、真的 handler、真的 client。
 * 量的是：型錄與目前選擇；選不上的原因與選擇不變；選了之後即時多一顆 `model-selection` 投影 frame，重新整理（歷史）長出同一份；
 * 下一輪的請求真的走選的那顆；server 重開之後（冷 thread）選擇還在；沒帶 `--live` 回 `not_supported`。
 *
 * **零憑證、零外部連線。**
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event, WireClient } from '@nexus/wire';
import {
  emptyConversation,
  MODEL_SELECTION_PROJECTION_KEY,
  PROJECTION,
  reduceAll,
} from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { DEFAULT_LIVE_MODEL_ENTRY, LIVE_API_KEY_ENV } from './live-model.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const A = 'model-a';
const B = 'model-b';

/** 回一句「好」的假端點，記下每次請求的 `model`。 */
async function fakeEndpoint() {
  const models: string[] = [];
  /** 標題請求（system 以 `Create a concise title` 開頭）走的模型，與主請求分開記。 */
  const titleModels: string[] = [];
  const mainModels: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as {
        model: string;
        stream?: boolean;
        messages?: { role: string; content: unknown }[];
      };
      models.push(body.model);
      const first = body.messages?.[0];
      const isTitle =
        first?.role === 'system' &&
        typeof first.content === 'string' &&
        first.content.startsWith('Create a concise title');
      (isTitle ? titleModels : mainModels).push(body.model);
      const id = `chatcmpl-${models.length}`;
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 0,
            model: 'fake',
            choices: [
              { index: 0, message: { role: 'assistant', content: '好。' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
        );
        return;
      }
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '好。' }));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models,
    titleModels,
    mainModels,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function writePatch(baseUrl: string): Promise<string> {
  const entry = (id: string, extra: Record<string, unknown> = {}) => ({
    ...structuredClone(DEFAULT_LIVE_MODEL_ENTRY),
    id,
    ...extra,
  });
  const patch = [
    {
      id: 'live-model',
      config: {
        baseUrl,
        maxRetries: 0,
        modelId: A,
        models: [entry(A), entry(B, { reasoningEfforts: false })],
      },
    },
  ];
  const dir = await mkdtemp(join(tmpdir(), 'nexus-model-selection-'));
  const path = join(dir, 'patch.yml');
  // JSON 是合法的 YAML。
  await writeFile(path, JSON.stringify(patch), 'utf8');
  return path;
}

let running: RunningServe | undefined;
let endpoint: Awaited<ReturnType<typeof fakeEndpoint>> | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  await endpoint?.close();
  endpoint = undefined;
  if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
  else process.env[LIVE_API_KEY_ENV] = savedKey;
});

async function start(root: string, patch: string): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0', '--live', '--session-log', root, '--patch', patch],
    log: () => {},
    env: {},
  })) as RunningServe;
  running = server;
  return server;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const projectionPayloads = (frames: readonly Event[]) =>
  frames
    .filter((frame) => frame.method === 'custom')
    .map((frame) => frame.params.data as { name: string; payload: { key: string; view: unknown } })
    .filter(
      (data) => data.name === PROJECTION && data.payload.key === MODEL_SELECTION_PROJECTION_KEY,
    )
    .map((data) => data.payload.view);

async function untilFrames(frames: readonly Event[], count: number): Promise<void> {
  for (let tries = 0; tries < 400 && projectionPayloads(frames).length < count; tries += 1) {
    await settle();
  }
}

async function follow(client: WireClient, threadId: string): Promise<Event[]> {
  const frames: Event[] = [];
  const events = await client.openEvents(threadId);
  void (async () => {
    try {
      for await (const frame of events) frames.push(frame);
    } catch {
      // server 收掉時下行會斷，不是測試要量的事。
    }
  })();
  return frames;
}

/** 這條 thread 的歷史最新一頁折出的 `projections[model-selection].view`。 */
async function refreshedView(client: WireClient, threadId: string) {
  const outcome = await client.threadHistory(threadId);
  if (outcome.kind !== 'ok') throw new Error(`歷史沒拿到：${JSON.stringify(outcome)}`);
  return reduceAll(emptyConversation(), outcome.result.events).projections[
    MODEL_SELECTION_PROJECTION_KEY
  ]?.view;
}

const catalogOf = async (client: WireClient, threadId: string) => {
  const outcome = await client.modelCatalog(threadId);
  if (outcome.kind !== 'ok') throw new Error(`型錄沒拿到：${JSON.stringify(outcome)}`);
  if (!outcome.result.ok) throw new Error('型錄回了 ok: false');
  return outcome.result.value;
};

describe('model.catalog', () => {
  it('回型錄（依宣告順序）、部署預設，以及還沒送過請求時的選擇 null', async () => {
    endpoint = await fakeEndpoint();
    const root = await mkdtemp(join(tmpdir(), 'nexus-model-root-'));
    const client = await serveClient(await start(root, await writePatch(endpoint.baseUrl)));
    const { catalog, selection } = await catalogOf(client, 't');
    expect(catalog.default).toEqual({ modelId: A });
    expect(catalog.models.map((model) => model.id)).toEqual([A, B]);
    // 沒宣告推理資訊的模型不帶這一格，web 不畫強度列；有宣告的只列今天能送上線的等級（`default` 在前）。
    expect(catalog.models[0]?.reasoning).toEqual({
      efforts: [
        { id: 'default', name: 'default' },
        { id: 'off', name: 'off' },
      ],
      defaultEffort: 'default',
    });
    expect(catalog.models[1]?.reasoning).toBeUndefined();
    expect(selection).toEqual({ lastUsed: null, next: null });
  }, 60_000);
});

describe('model.select', () => {
  it('選上：即時多一顆投影 frame，歷史與 model.catalog 長出同一份；選不上：選擇不變、不多 frame', async () => {
    endpoint = await fakeEndpoint();
    const root = await mkdtemp(join(tmpdir(), 'nexus-model-root-'));
    const client = await serveClient(await start(root, await writePatch(endpoint.baseUrl)));
    const live = await follow(client, 't');

    const selected = await client.selectModel('t', { modelId: B });
    expect(selected).toMatchObject({
      kind: 'ok',
      result: { ok: true, value: { selected: { modelId: B } } },
    });
    await untilFrames(live, 1);
    const expected = { lastUsed: null, next: { modelId: B } };
    expect(projectionPayloads(live)).toEqual([expected]);
    expect(await refreshedView(client, 't')).toEqual(expected);
    expect((await catalogOf(client, 't')).selection).toEqual(expected);

    // 型錄沒有那顆；沒宣告推理資訊的模型帶了強度；沒宣告的等級——都拒，而且不記、不推。
    for (const bad of [
      { modelId: 'nope' },
      { modelId: B, reasoningEffort: 'off' },
      { modelId: A, reasoningEffort: 'high' },
    ]) {
      expect(await client.selectModel('t', bad)).toMatchObject({
        kind: 'ok',
        result: { ok: false, error: { code: 'model_unavailable', modelId: bad.modelId } },
      });
    }
    await settle();
    expect(projectionPayloads(live)).toHaveLength(1);
    expect((await catalogOf(client, 't')).selection).toEqual(expected);
  }, 60_000);

  it('參數不對（modelId 不是字串、reasoningEffort 不是字串）回 invalid_argument，不記', async () => {
    endpoint = await fakeEndpoint();
    const root = await mkdtemp(join(tmpdir(), 'nexus-model-root-'));
    const client = await serveClient(await start(root, await writePatch(endpoint.baseUrl)));
    for (const bad of [{ modelId: 7 }, { modelId: A, reasoningEffort: 3 }, { modelId: '' }]) {
      expect(await client.selectModel('t', bad as never)).toMatchObject({
        kind: 'rejected',
        code: 'invalid_argument',
      });
    }
    expect((await catalogOf(client, 't')).selection).toEqual({ lastUsed: null, next: null });
  }, 60_000);
});

describe('標題沒有自己的覆寫：沿用主請求走的模型（#723，照 dsh）', () => {
  async function titleModelsAfterTurn(select: string | undefined): Promise<string[]> {
    endpoint = await fakeEndpoint();
    const root = await mkdtemp(join(tmpdir(), 'nexus-model-root-'));
    const client = await serveClient(await start(root, await writePatch(endpoint.baseUrl)));
    const events = await client.openEvents('t');
    if (select !== undefined) await client.selectModel('t', { modelId: select });
    await client.runStart('t', '你好');
    await foldTurn(events);
    for (let tries = 0; tries < 400 && endpoint.titleModels.length === 0; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return endpoint.titleModels;
  }

  it('第一句之前選了 B：標題請求走 B', async () => {
    expect(await titleModelsAfterTurn(B)).toEqual([B]);
  }, 60_000);

  it('沒選過：標題請求走部署預設', async () => {
    expect(await titleModelsAfterTurn(undefined)).toEqual([A]);
  }, 60_000);
});

describe('選了之後下一輪走那一顆', () => {
  it('請求的 model 是選的；冷 thread（server 重開）選擇還在', async () => {
    endpoint = await fakeEndpoint();
    const root = await mkdtemp(join(tmpdir(), 'nexus-model-root-'));
    const patch = await writePatch(endpoint.baseUrl);
    const first = await start(root, patch);
    const client = await serveClient(first);

    const events = await client.openEvents('t');
    await client.selectModel('t', { modelId: B });
    await client.runStart('t', '你好');
    await foldTurn(events);
    expect(endpoint.mainModels).toEqual([B]);
    const afterTurn = { lastUsed: { modelId: B }, next: { modelId: B } };
    expect(await refreshedView(client, 't')).toEqual(afterTurn);

    await first.close();
    running = undefined;

    const second = await start(root, patch);
    const cold = await serveClient(second);
    expect(await refreshedView(cold, 't')).toEqual(afterTurn);
    expect((await catalogOf(cold, 't')).selection).toEqual(afterTurn);
  }, 60_000);
});
