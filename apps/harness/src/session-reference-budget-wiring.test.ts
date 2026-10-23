/**
 * **引用別的會話的預算，從 wire 進來走完 pump**（[#1573](https://github.com/DemianLi/nexus-agent/issues/1573) N0862 驗收 A、B、F 與接線紅燈）。
 *
 * `session-reference-budget.test.ts` 量的是公式與 `nextContextWindow`；那種測法拿掉 `wire-handler.ts` 在 `new ThreadPump` 那一處交出
 * `referencePolicy` 的那一行也照樣綠（機制測試自己傳選項，不經組裝）。這一檔用真的 `createWireHandler`＋真的 wire client＋真的
 * `createNexusAgent`＋真的 `ChatOpenAI`（對手方是本機假端點）＋真的 `createModelSelectionHost`，被引用的會話是記憶體裡的替身讀端。
 * 量的是**假端點真的收到的請求本文**：快照有沒有被截。
 *
 * 型錄兩顆：`small`（窗口 100,000，預算落在 64 KiB 下限）、`big`（700,045，出廠那顆的窗口，比例 0.1 時 280,018 位元組）。
 * 被引用的會話是一則 200,000 位元組的訊息：在 64 KiB 的預算下要被截，在 280,018 的預算下完整。
 *
 * **零憑證、零外部連線。**
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
  SESSION_LOG_FORMAT_VERSION,
  SessionLog,
  toLoggedMessage,
} from '@nexus/core';
import type { SessionEvent, SessionRegistry, StoredSessionHeader } from '@nexus/core';
import { createWireClient, formatSessionReferenceMention } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ambientCredentials } from './credentials.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { createModelSelectionHost, createModelSelectionPlugin } from './model-selection-host.js';
import { composeAttachSessions } from './session-attach.js';
import type { SessionReferenceReader } from './session-reference.js';
import { DEFAULT_MAX_REFERENCE_BYTES } from './session-reference.js';
import type { PumpAgent } from './thread-pump.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { sessionReferenceConfigSchema } from './settings/session-reference.js';
import type { SessionReferenceConfig } from './settings/session-reference.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://wire.test';
const THREAD = 'budget-wiring';
const BIG_WINDOW = 700_045;

/** 200 KB 的一則訊息：超過 64 KiB、小於 280,018。 */
const LONG_TEXT = `開頭-${'字'.repeat(1)}${'x'.repeat(200_000)}-結尾`;

interface Recorded {
  readonly model: string;
  readonly messages: { role: string; content: unknown }[];
}

let upstream: Server;
let requests: Recorded[];

beforeEach(async () => {
  requests = [];
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as {
        model: string;
        messages?: { role: string; content: unknown }[];
      };
      requests.push({ model: parsed.model, messages: parsed.messages ?? [] });
      const index = requests.length;
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: `resp_${index}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '收到。' }));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
});

afterEach(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

function liveConfig(modelId: 'small' | 'big') {
  const { port } = upstream.address() as AddressInfo;
  return liveModelConfigSchema.parse({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    modelId,
    retryPolicy: { mode: 'normal', maxRetries: 0 },
    models: [
      { id: 'small', contextWindow: 100_000, maxTokens: 1_000 },
      { id: 'big', contextWindow: BIG_WINDOW, maxTokens: 16_384 },
    ],
  });
}

/** 被引用的那條會話：一則 200 KB 的問，一句答。 */
function longSource(id = 'long'): {
  header: StoredSessionHeader;
  events: readonly SessionEvent[];
} {
  const log = new SessionLog(id);
  log.append('turn/start', { kind: 'message', text: LONG_TEXT });
  log.append('assistant/message', { message: toLoggedMessage(new AIMessage('收到')) });
  log.append('turn/end', {});
  return {
    header: { version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 1, cwd: '/專案/甲' },
    events: log.events,
  };
}

const reader: SessionReferenceReader = {
  read: async (sessionId) => ({
    ...longSource(sessionId),
    storedFormatVersion: SESSION_LOG_FORMAT_VERSION,
  }),
};

interface ConnectOptions {
  readonly modelId: 'small' | 'big';
  /** `session-reference` 那一列的值；省略即出廠的比例 0.1（`cordis.yml`）。 */
  readonly settings?: Partial<SessionReferenceConfig>;
  /** 不給選擇控制器（腳本模型、沒帶 `--live` 的組裝）。 */
  readonly withoutSelection?: boolean;
}

function connect(options: ConnectOptions) {
  const live = liveConfig(options.modelId);
  const credentials = ambientCredentials({ [LIVE_API_KEY_ENV]: 'sk-loopback' });
  const host = createModelSelectionHost({ liveModel: live, credentials });
  let registry: SessionRegistry | undefined;
  const checkpointer = new MemorySaver();
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    sessionReferenceReader: reader,
    sessionReferenceSettings: sessionReferenceConfigSchema.parse({
      referenceContextFraction: 0.1,
      ...options.settings,
    }),
    createAgent: async () => {
      const built = await createNexusAgent({
        model: createLiveModel(live, undefined, credentials) as never,
        checkpointer,
        plugins: options.withoutSelection === true ? [] : [createModelSelectionPlugin(host)],
        summarization: false,
        observationPolicy: false,
        stepInbox: true,
        ...(options.withoutSelection !== true && {
          modelSelection: host.controller,
          modelLimits: host.limitsOf,
        }),
      });
      return {
        agent: built.agent as unknown as PumpAgent,
        stepInbox: true,
        commands: emptyCommandPoint(),
        attachSessions: (sessions, port) => {
          registry = sessions;
          return composeAttachSessions(built)(sessions, port);
        },
        ...(options.withoutSelection !== true && { modelSelection: host }),
        dispose: built.dispose,
      };
    },
  });
  const fetchImpl: typeof globalThis.fetch = async (input, init) =>
    handler.handle(loopbackRequest(input as string, init));
  return {
    handler,
    host,
    client: createWireClient({ baseUrl: BASE_URL, fetch: fetchImpl }),
    events: () => registry?.root.events ?? [],
  };
}

async function settled(events: () => readonly { type: string }[], turns: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const done = events().filter((e) => e.type === 'turn/end' || e.type === 'turn/failed').length;
    if (done >= turns) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等不到這一輪收尾');
}

const MENTION = `看 ${formatSessionReferenceMention({ sessionId: 'long', label: '長的' })}`;

/** 假端點收到的第 `index` 個請求裡，**最後一則**引用快照的全文（前面幾輪的快照還在歷史裡）。 */
function lastSnapshot(index: number): string {
  const request = requests[index];
  if (request === undefined) throw new Error(`沒有第 ${String(index)} 個請求`);
  const snapshots = request.messages
    .map((message) => JSON.stringify(message.content))
    .filter((content) => content.includes('referenced-sessions'));
  const last = snapshots.at(-1);
  if (last === undefined) throw new Error('請求裡沒有引用快照');
  return last;
}

/** 截斷時快照多一段 `## Reference omissions`（整則訊息被丟掉，或一則太長被頭尾各留一半，後者另有 `[… omitted N UTF-8 bytes …]`）。 */
const TRUNCATED = /## Reference omissions/u;

async function ask(connection: ReturnType<typeof connect>, turns: number): Promise<void> {
  expect(await connection.client.runStart(THREAD, MENTION)).toMatchObject({ type: 'success' });
  await settled(connection.events, turns);
}

describe('預算跟著這條 thread 下一步會走的模型（驗收 A、接線紅燈）', () => {
  it('預設那顆窗口小：200 KB 的來源被截到 64 KiB；`model.select` 換成大的那顆之後，下一次引用完整，標記不在', async () => {
    const connection = connect({ modelId: 'small' });
    try {
      await ask(connection, 1);
      expect(requests[0]!.model).toBe('small');
      expect(lastSnapshot(0)).toMatch(TRUNCATED);
      expect(lastSnapshot(0)).not.toContain('結尾');

      const selected = await connection.client.selectModel(THREAD, { modelId: 'big' });
      expect(selected).toMatchObject({ kind: 'ok', result: { ok: true } });

      await ask(connection, 2);
      expect(requests.at(-1)!.model).toBe('big');
      const snapshot = lastSnapshot(requests.length - 1);
      expect(snapshot).not.toMatch(TRUNCATED);
      expect(snapshot).toContain('結尾');
    } finally {
      await connection.handler.close();
    }
  });

  it('換回小的那顆：又被截，證明跟著選擇走，不是記住第一次的值', async () => {
    const connection = connect({ modelId: 'big' });
    try {
      await ask(connection, 1);
      expect(lastSnapshot(0)).not.toMatch(TRUNCATED);

      await connection.client.selectModel(THREAD, { modelId: 'small' });
      await ask(connection, 2);
      expect(requests.at(-1)!.model).toBe('small');
      expect(lastSnapshot(requests.length - 1)).toMatch(TRUNCATED);
    } finally {
      await connection.handler.close();
    }
  });
});

describe('取不到窗口與明講位元組（驗收 B、F）', () => {
  it('B：沒有選擇控制器（腳本模型、沒帶 --live）：照 64 KiB 截，證明退路還在', async () => {
    const connection = connect({ modelId: 'big', withoutSelection: true });
    try {
      await ask(connection, 1);
      expect(lastSnapshot(0)).toMatch(TRUNCATED);
      // 沒有被截的話會是 200 KB 以上；截了的快照遠小於此，不會比 64 KiB 的預算大。
      expect(Buffer.byteLength(lastSnapshot(0))).toBeLessThan(DEFAULT_MAX_REFERENCE_BYTES);
    } finally {
      await connection.handler.close();
    }
  });

  it('F：給了 maxReferenceBytes 就壓過模型相對預算：大的那顆也被截', async () => {
    const connection = connect({ modelId: 'big', settings: { maxReferenceBytes: 1_000 } });
    try {
      await ask(connection, 1);
      expect(lastSnapshot(0)).toMatch(TRUNCATED);
      expect(Buffer.byteLength(lastSnapshot(0))).toBeLessThan(DEFAULT_MAX_REFERENCE_BYTES);
    } finally {
      await connection.handler.close();
    }
  });

  it('F 反方向：maxReferenceBytes 比窗口算出來的大，小窗口那顆也完整', async () => {
    const connection = connect({ modelId: 'small', settings: { maxReferenceBytes: 300_000 } });
    try {
      await ask(connection, 1);
      expect(lastSnapshot(0)).not.toMatch(TRUNCATED);
      expect(lastSnapshot(0)).toContain('結尾');
    } finally {
      await connection.handler.close();
    }
  });

  it('比例 0.2（dsh 的）：大的那顆的預算是 560,036，同一份 200 KB 照樣完整——比例真的進了公式', async () => {
    const connection = connect({
      modelId: 'big',
      settings: { referenceContextFraction: 0.2 },
    });
    try {
      await ask(connection, 1);
      expect(lastSnapshot(0)).not.toMatch(TRUNCATED);
    } finally {
      await connection.handler.close();
    }
  });

  it('比例 0：自動預算墊到 64 KiB 下限，大的那顆也被截', async () => {
    const connection = connect({ modelId: 'big', settings: { referenceContextFraction: 0 } });
    try {
      await ask(connection, 1);
      expect(lastSnapshot(0)).toMatch(TRUNCATED);
    } finally {
      await connection.handler.close();
    }
  });
});

describe('型錄沒有那一顆（選過、後來被拿掉）：這一格的 64 KiB 沒有人看得到', () => {
  /**
   * `session-reference-budget.ts` 檔頭說這一格「走不到供應商」，這條把它釘住：預算照 64 KiB 算了（沒有窗口），
   * 但同一步換模型時 `instanceFor` 在打供應商之前就拋，這一輪失敗，假端點一個請求都沒收到，快照沒有送出去。
   * `controller.select` 不驗證（驗證在 `host.select`），所以可以直接寫一個型錄沒有的路由，等於模擬「後來被從型錄拿掉」。
   */
  it('這一輪在打供應商之前失敗，假端點沒收到任何請求', async () => {
    const connection = connect({ modelId: 'small' });
    try {
      // 先開 thread、讓控制器接上日誌。
      expect(await connection.client.modelCatalog(THREAD)).toMatchObject({ kind: 'ok' });
      connection.host.controller.select({ model: 'ghost' });
      expect(connection.host.nextContextWindow()).toBeUndefined();

      await ask(connection, 1);
      expect(connection.events().some((e) => e.type === 'turn/failed')).toBe(true);
      expect(requests).toHaveLength(0);
    } finally {
      await connection.handler.close();
    }
  });
});

describe('一則訊息最多引用幾條（驗收 C）', () => {
  const mentions = (...ids: string[]): string =>
    ids.map((id) => formatSessionReferenceMention({ sessionId: id, label: id })).join(' ');

  it('maxReferences: 2：引用三條，收下那句話的時候就回 invalid_argument，帶 SESSION_REFERENCE_TOO_MANY，什麼都不進日誌', async () => {
    const connection = connect({ modelId: 'big', settings: { maxReferences: 2 } });
    try {
      const refused = await connection.client.runStart(THREAD, `看 ${mentions('a', 'b', 'c')}`);
      expect(refused).toMatchObject({ type: 'error', error: 'invalid_argument' });
      expect(String(refused.type === 'error' ? refused.message : '')).toContain(
        'SESSION_REFERENCE_TOO_MANY',
      );
      expect(requests).toHaveLength(0);
      // 兩條照收。
      expect(await connection.client.runStart(THREAD, `看 ${mentions('a', 'b')}`)).toMatchObject({
        type: 'success',
      });
      await settled(connection.events, 1);
    } finally {
      await connection.handler.close();
    }
  });

  it('預設 3 條：三條收、四條拒（上限不能調過 3，schema 擋）', async () => {
    const connection = connect({ modelId: 'big' });
    try {
      const refused = await connection.client.runStart(
        THREAD,
        `看 ${mentions('a', 'b', 'c', 'd')}`,
      );
      expect(refused).toMatchObject({ type: 'error', error: 'invalid_argument' });
      expect(await connection.client.runStart(THREAD, `看 ${mentions('a', 'b', 'c')}`)).toMatchObject(
        { type: 'success' },
      );
      await settled(connection.events, 1);
    } finally {
      await connection.handler.close();
    }
  });
});
