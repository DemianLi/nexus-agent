/**
 * 沒有專用碼的內部失敗，原因不上線（#2230）：每一條路都讓底下拋一個帶主機路徑的 Node fs 錯誤，
 * 回應只有固定訊息，原因在 `warn`。釘選在 `thread-organization-wire.test.ts`，讀圖要真的日誌，在 `attachment-image-checks-wire.test.ts`；改名這裡沒有接縫，沒有測試。
 *
 * **零憑證、零外部連線**：底下全是替身，只量 `wire-handler.ts` 這一層。
 */

import type { ProjectionUnit } from '@nexus/core';
import { createWireClient, TRAJECTORY_PROJECTION } from '@nexus/wire';
import type { WireClient } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import type { AttachmentStore } from './attachment-store.js';
import { BackgroundSubagentError } from './background-subagents.js';
import type { BackgroundSubagentControl } from './background-subagents.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadSearchError } from './thread-search.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandlerOptions } from './wire-handler.js';

const SECRET = '/srv/secret/home/session.jsonl';
const fsError = () => new Error(`EACCES: permission denied, open '${SECRET}'`);
const refuse = async (): Promise<never> => {
  throw fsError();
};

const PNG = (() => {
  const out = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out);
  out.writeUInt32BE(13, 8);
  out.write('IHDR', 12, 'ascii');
  out.writeUInt32BE(1, 16);
  out.writeUInt32BE(1, 20);
  out.writeUInt8(8, 24);
  out.writeUInt8(2, 25);
  return out.toString('base64');
})();

const THREAD = 't1';

interface Rig {
  readonly client: WireClient;
  readonly lines: string[];
}

interface Parts extends Partial<WireHandlerOptions> {
  readonly agent?: Record<string, unknown>;
  readonly background?: BackgroundSubagentControl;
}

async function rig(parts: Parts): Promise<Rig> {
  const { agent, background, ...options } = parts;
  const lines: string[] = [];
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    warn: (line) => lines.push(line),
    createAgent: async () => ({
      agent: {} as PumpAgent,
      commands: emptyCommandPoint(),
      dispose: async () => undefined,
      attachSessions: () => ({
        detach: async () => undefined,
        ...(background !== undefined && { background }),
      }),
      ...agent,
    }),
    ...options,
  });
  const client = createWireClient({
    baseUrl: 'http://withheld.test',
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  // 走得到 `threads.get` 的路（評分、子代理）要 thread 先在。
  await client.slashList(THREAD);
  return { client, lines };
}

interface Route {
  readonly name: string;
  readonly parts: Parts;
  readonly call: (client: WireClient) => Promise<unknown>;
  readonly message: string;
  readonly log: string;
}

const refusedStore = {
  save: refuse,
  saveImages: refuse,
} as unknown as AttachmentStore;

const ROUTES: readonly Route[] = [
  {
    name: 'skill.list',
    parts: { agent: { skillCatalog: refuse } },
    call: (client) => client.skillList(THREAD),
    message: '技能清單讀不出來，原因記在 serve 的日誌',
    log: `[技能] thread ${THREAD} 的技能清單讀不出來：`,
  },
  {
    name: 'feedback.put 寫不進去',
    parts: { agent: { feedback: { put: refuse } } },
    call: (client) =>
      client.feedbackPut(THREAD, { messageId: 'm1', rating: 'positive', ifVersion: null }),
    message: '評分沒存成，原因記在 serve 的日誌',
    log: `[回饋] thread ${THREAD} 的評分沒存成：`,
  },
  {
    name: '上傳',
    parts: { attachments: refusedStore },
    call: (client) => client.uploadFile(THREAD, new Uint8Array([1]), 'x.txt'),
    message: '上傳沒存成，原因記在 serve 的日誌',
    log: `[上傳] thread ${THREAD} 的上傳沒存成：`,
  },
  {
    name: 'run.start 帶圖',
    parts: { attachments: refusedStore },
    call: (client) =>
      client.runStart(THREAD, '看圖', {
        attachments: [{ type: 'image', mediaType: 'image/png', data: PNG }],
      }),
    message: '圖存不下，原因記在 serve 的日誌',
    log: `[附件] thread ${THREAD} 的圖存不下：`,
  },
  {
    name: 'subagent.send 叫不醒',
    parts: {
      background: {
        sendFromUser: () =>
          Promise.reject(
            new BackgroundSubagentError('resume-failed', `背景子代理 bg-x 叫不醒：${SECRET}`),
          ),
        interrupt: () => false,
        hasRunning: () => false,
      } as unknown as BackgroundSubagentControl,
    },
    call: (client) => client.subagentSend(THREAD, 'bg-x', '嗨'),
    message: '子代理叫不醒，原因記在 serve 的日誌',
    log: '[子代理] run bg-x：',
  },
  {
    name: '分叉的來源',
    parts: { readStoredThread: refuse },
    call: (client) => client.threadFork(THREAD, 'm1'),
    message: '分叉的來源讀不出來，原因記在 serve 的日誌',
    log: `[thread] "${THREAD}" 分叉的來源讀不出來：`,
  },
  {
    name: '列 thread',
    parts: { listThreads: refuse },
    call: (client) => client.listThreads(),
    message: '以前的 thread 列不出來，原因記在 serve 的日誌',
    log: '[列表] 以前的 thread 列不出來：',
  },
  {
    name: '搜尋：不是搜尋自己的錯',
    parts: { searchThreads: refuse },
    call: (client) => client.searchThreads('字'),
    message: '搜尋失敗，原因記在 serve 的日誌',
    log: '[搜尋] 搜尋失敗：',
  },
  {
    name: '搜尋：persistence-failed',
    parts: {
      searchThreads: () =>
        Promise.reject(new ThreadSearchError('persistence-failed', `讀不到日誌：${SECRET}`)),
    },
    call: (client) => client.searchThreads('字'),
    message: '搜尋失敗，原因記在 serve 的日誌',
    log: '[搜尋] 搜尋失敗：',
  },
  {
    name: '搜尋：index-failed',
    parts: {
      searchThreads: () =>
        Promise.reject(new ThreadSearchError('index-failed', `寫不進搜尋索引：${SECRET}`)),
    },
    call: (client) => client.searchThreads('字'),
    message: '搜尋失敗，原因記在 serve 的日誌',
    log: '[搜尋] 搜尋失敗：',
  },
  {
    name: '軌跡',
    parts: {
      agent: {
        projections: {
          list: () => [
            {
              key: TRAJECTORY_PROJECTION,
              stateVersion: 0,
              init: () => ({}),
              apply: (state: unknown) => state,
              view: () => ({}),
              detail: () => {
                throw fsError();
              },
            } as unknown as ProjectionUnit,
          ],
        },
      },
    },
    call: (client) => client.trajectoryTurn(THREAD, { seq: 1 }),
    message: '軌跡折不出來，原因記在 serve 的日誌',
    log: `[軌跡] thread ${THREAD} 折不出細節：`,
  },
  {
    name: '列檔',
    // 真的走訪：根不存在，Node 的 ENOENT 帶著這個路徑。
    parts: { agent: { workspaceRoot: SECRET } },
    call: (client) => client.fileReferences(THREAD, 'READ'),
    message: '列不出檔案，原因記在 serve 的日誌',
    log: `[檔案] thread ${THREAD} 列不出檔案：`,
  },
  {
    name: '列會話',
    parts: { listSessionReferences: refuse },
    call: (client) => client.sessionReferences(THREAD, ''),
    message: '列不出會話，原因記在 serve 的日誌',
    log: `[會話] thread ${THREAD} 列不出會話：`,
  },
];

describe.each(ROUTES)('$name', (route) => {
  it('回應是固定訊息、不帶路徑；原因在日誌', async () => {
    const { client, lines } = await rig(route.parts);
    const outcome = await route.call(client);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    // `subagent.send` 與 `thread.fork` 的 client 回原始封包，其餘回 `rejected`。
    const { code, error, message } = outcome as Record<string, unknown>;
    expect(code ?? error).toBe('unknown_error');
    expect(message).toBe(route.message);
    const logged = lines.find((line) => line.startsWith(route.log));
    expect(logged).toContain(SECRET);
  });
});

describe('搜尋自己說得清楚、又不帶路徑的', () => {
  it.each([
    ['aborted', '搜尋被中止了'],
    ['source-conflict', 'thread "a" 列表給的 header 與讀到的對不上'],
  ] as const)('%s：訊息照舊上線', async (kind, message) => {
    const { client } = await rig({
      searchThreads: () => Promise.reject(new ThreadSearchError(kind, message)),
    });
    expect(await client.searchThreads('字')).toMatchObject({ code: 'unknown_error', message });
  });
});
