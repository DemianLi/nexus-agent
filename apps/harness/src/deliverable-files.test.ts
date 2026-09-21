/**
 * **兩條交付讀檔路由在真的圖、真的 pump 與真的 HTTP 上跑一次**——
 * [#452](https://github.com/DemianLi/nexus-agent/issues/452) 第二刀的驗收。
 *
 * 證的是這幾件，每一件都有一個「錯了也不會有別的測試紅」的失敗方向：
 *
 * 1. **下載回來的位元組跟磁碟上完全相同**——這一條是衝著基座那支 `readRaw` 寫的：它會把二進位
 *    當 UTF-8 解掉、`error` 還是 `undefined`（量測見 `deliverable-files.ts` 的
 *    `readDeliverableBytes`）。走那條路下載一張 PNG 是壞的而且沒有徵兆，所以這裡的斷言是
 *    `toEqual` 整串位元組，不是長度、不是「有內容」。
 * 2. **錨的分界是 `seq < storedCount`，不是 thread 活不活著**：同一條活著的 thread，線以上的
 *    讀得到、線以下的拒。只驗「活著就讀得到」的測試對這個分岔是瞎的。
 * 3. **符號連結拒**：`virtualMode` 的圍堵是 lexical 的，擋不到它。
 * 4. **四種拒絕各有各的狀態碼**：壓成同一個的話前端分不出該畫什麼，而畫面上看不出來。
 * 5. **上限是拒絕不是截斷**。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，工作區是暫存目錄，測試不碰真的 `~/.nexus-agent`。
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import type { SessionEvent, SessionRegistry } from '@nexus/core';
import { createHostServicesPlugin } from '@nexus/core';
import { PRESENT_TOOL_NAME } from '@nexus/plugin-present';
import { createSandboxPolicyPlugin, SandboxModeController } from '@nexus/plugin-sandbox-policy';
import type { DeliverableFilePage } from '@nexus/wire';
import { createWireClient, deliverableDownloadPath, deliverableFilePath } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { DELIVERABLE_MAX_LINES, locateDeliverable } from './deliverable-files.js';
import {
  exchangeServeToken,
  fetchWithCookie,
  loopbackRequest,
  shippedPlugins,
  TEST_BROWSER_AUTH,
} from './fixtures.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const shipped = await shippedPlugins();

const BASE_URL = 'http://deliverable.test';
const THREAD_ID = 'deliverable';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Outcome {
  /** 那顆 `deliverables/presented` 在 root 日誌裡的位置。 */
  readonly seq: number;
  readonly root: string;
  get(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/**
 * 跑一輪 `present`，回一個可以打兩條路由的把手。
 *
 * @param files - 工作區裡先擺好的檔，值是 `string` 就照 UTF-8 寫，是 `Uint8Array` 就照位元組寫。
 * @param declared - 模型宣告的那幾個路徑。
 * @param options - `workspace` 為否時不交 `workspaceRoot`（沒給 `--workspace` 的組裝）；
 *   `seed` 讓這條 thread 看起來是續接回來的，用來把分界線推上去。
 * @returns 那一輪的結果。
 */
async function present(
  files: Record<string, string | Uint8Array>,
  declared: readonly string[],
  options: {
    workspace?: boolean;
    seed?: readonly SessionEvent[];
    setup?: (root: string) => Promise<void>;
  } = {},
): Promise<Outcome> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-deliverable-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), content);
  }
  await options.setup?.(root);
  const workspace = options.workspace ?? true;
  const sandboxMode = new SandboxModeController('workspace-write');
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        {
          content: '交付。',
          toolCalls: [
            { name: PRESENT_TOOL_NAME, args: { files: declared.map((path) => ({ path })) } },
          ],
        },
        { content: '交付好了。' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [
      createHostServicesPlugin({ sandboxPolicy: { controller: sandboxMode, rootDir: root } }),
      ...shipped,
      createSandboxPolicyPlugin(),
    ],
    backend: new ContainedFilesystemBackend({
      rootDir: root,
      mode: sandboxMode.source,
      grants: sandboxMode,
    }),
  });
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      dispose: built.dispose,
      attachSession: (registry) => {
        sessions = registry;
        return built.attachSession(registry);
      },
      ...(workspace && { workspaceRoot: root }),
      ...(options.seed !== undefined && { rootSeed: options.seed }),
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  try {
    const events = await client.openEvents(THREAD_ID);
    await client.runStart(THREAD_ID, '交付吧。');
    for (;;) {
      const next = await events.next();
      if (next.done === true) break;
      const data = next.value.params.data as { event?: string; graph_name?: string };
      if (next.value.method === 'lifecycle' && data.graph_name === 'root') {
        if (data.event === 'completed' || data.event === 'failed') break;
      }
    }
    // 交付排在下一個 microtask，而它在 root 收工之前就落定了。
    await new Promise((resolve) => setImmediate(resolve));
    await events.return?.(undefined);
    if (sessions === undefined) throw new Error('attachSession 沒被叫到');
    const at = sessions.root.events.findIndex((event) => event.type === 'deliverables/presented');
    return {
      seq: at,
      root,
      get: (path, init) =>
        handler.handle(
          loopbackRequest(`${BASE_URL}${path}`, {
            method: 'GET',
            headers: { 'content-type': 'application/json' },
            ...init,
          }),
        ),
      close: () => handler.close(),
    };
  } catch (error) {
    await handler.close();
    throw error;
  }
}

function filePath(query: string): string {
  return `${deliverableFilePath(THREAD_ID)}?${query}`;
}

function downloadPath(query: string): string {
  return `${deliverableDownloadPath(THREAD_ID)}?${query}`;
}

describe('預覽', () => {
  it('讀得到宣告過的檔，帶不透明的 version 與位元組數', async () => {
    const outcome = await present({ 'a.md': 'one\ntwo\nthree\n' }, ['a.md']);
    try {
      const response = await outcome.get(filePath(`seq=${outcome.seq}&index=0`));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const page = (await response.json()) as DeliverableFilePage;
      expect(page.text).toBe('one\ntwo\nthree');
      expect(page.lines).toBe(3);
      expect(page.eof).toBe(true);
      expect(page.offset).toBe(0);
      // 回的是模型宣告時給的那個字串，**不是** server 上的絕對路徑。
      expect(page.path).toBe('a.md');
      expect(page.bytes).toBe(14);
    } finally {
      await outcome.close();
    }
  });

  it('version 的契約：內容沒動就同值，動過就換值', async () => {
    const outcome = await present({ 'a.md': 'one\n' }, ['a.md']);
    try {
      const query = filePath(`seq=${outcome.seq}&index=0`);
      const first = (await (await outcome.get(query)).json()) as DeliverableFilePage;
      const again = (await (await outcome.get(query)).json()) as DeliverableFilePage;
      // 讀兩次不會換值——換了的話前端每次都以為檔變了。
      expect(again.version).toBe(first.version);
      await writeFile(join(outcome.root, 'a.md'), 'one\ntwo\n');
      const changed = (await (await outcome.get(query)).json()) as DeliverableFilePage;
      // **這就是決議 3 說的「這是現在的檔案，不是快照」的載體。** 不換值的話前端分不出新舊，
      // 而畫面上看起來完全正常。
      expect(changed.version).not.toBe(first.version);
      expect(changed.text).toBe('one\ntwo');
    } finally {
      await outcome.close();
    }
  });

  it('翻得了頁：offset 之後那幾行，eof 只在最後一頁是真的', async () => {
    const lines = Array.from({ length: 10 }, (_, at) => `line${at}`).join('\n');
    const outcome = await present({ 'a.md': lines }, ['a.md']);
    try {
      const first = (await (
        await outcome.get(filePath(`seq=${outcome.seq}&index=0&offset=0&limit=4`))
      ).json()) as DeliverableFilePage;
      expect(first.text).toBe('line0\nline1\nline2\nline3');
      expect(first.eof).toBe(false);
      const last = (await (
        await outcome.get(filePath(`seq=${outcome.seq}&index=0&offset=8&limit=4`))
      ).json()) as DeliverableFilePage;
      expect(last.text).toBe('line8\nline9');
      expect(last.lines).toBe(2);
      expect(last.eof).toBe(true);
    } finally {
      await outcome.close();
    }
  });

  it('含 NUL 的檔回 422，而且那個碼跟「忘了帶 content-type」分得開', async () => {
    const outcome = await present({ 'b.bin': new Uint8Array([0, 1, 2, 3, 255, 254]) }, ['b.bin']);
    try {
      const binary = await outcome.get(filePath(`seq=${outcome.seq}&index=0`));
      expect(binary.status).toBe(422);
      // 同一條路由、同一個座標，只差沒帶 header：兩個碼必須不一樣，否則前端分不出該做什麼。
      const noHeader = await outcome.get(filePath(`seq=${outcome.seq}&index=0`), { headers: {} });
      expect(noHeader.status).toBe(415);
    } finally {
      await outcome.close();
    }
  });

  it('一頁超過位元組上限是拒絕，不是切短', async () => {
    // 5000 行以內、但位元組超過 2 MiB：行數那道閘過得了，位元組那道過不了。
    const fat = Array.from({ length: 4000 }, () => 'x'.repeat(600)).join('\n');
    const outcome = await present({ 'big.md': fat }, ['big.md']);
    try {
      const response = await outcome.get(filePath(`seq=${outcome.seq}&index=0`));
      expect(response.status).toBe(413);
      // **回的不是一頁切短的內容**——切短的一頁看起來就是整頁，那是這條上限存在的全部理由。
      expect(response.headers.get('content-type')).not.toContain('json');
    } finally {
      await outcome.close();
    }
  });

  it('limit 超過上限是拒絕，不是給到上限為止', async () => {
    const outcome = await present({ 'a.md': 'one\n' }, ['a.md']);
    try {
      const response = await outcome.get(
        filePath(`seq=${outcome.seq}&index=0&limit=${DELIVERABLE_MAX_LINES + 1}`),
      );
      expect(response.status).toBe(400);
    } finally {
      await outcome.close();
    }
  });
});

describe('下載', () => {
  it('回來的位元組跟磁碟上一模一樣——二進位不會被當 UTF-8 解掉', async () => {
    // **這一串是刻意挑的**：`00` 讓它不是文字，`ff fe` 是 UTF-8 裡永遠不合法的兩個位元組。
    // 走基座 `readRaw` 的話這 6 個位元組會變成 10 個，而且 `error` 是 `undefined`。
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 254]);
    const outcome = await present({ 'logo.png': bytes }, ['logo.png']);
    try {
      const response = await outcome.get(downloadPath(`seq=${outcome.seq}&index=0`));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      const got = new Uint8Array(await response.arrayBuffer());
      expect([...got]).toEqual([...bytes]);
      const truth = await readFile(join(outcome.root, 'logo.png'));
      expect([...got]).toEqual([...truth]);
    } finally {
      await outcome.close();
    }
  });

  it('二進位預覽不了，但下載照給——同一個檔、兩條路由、兩種結局', async () => {
    const bytes = new Uint8Array([0, 1, 2]);
    const outcome = await present({ 'b.bin': bytes }, ['b.bin']);
    try {
      expect((await outcome.get(filePath(`seq=${outcome.seq}&index=0`))).status).toBe(422);
      expect((await outcome.get(downloadPath(`seq=${outcome.seq}&index=0`))).status).toBe(200);
    } finally {
      await outcome.close();
    }
  });

  it('content-disposition 帶得出檔名，非 ASCII 兩種寫法都給', async () => {
    const outcome = await present({ '報告.md': 'hi\n' }, ['報告.md']);
    try {
      const response = await outcome.get(downloadPath(`seq=${outcome.seq}&index=0`));
      const disposition = response.headers.get('content-disposition') ?? '';
      expect(disposition).toContain('attachment;');
      // 舊瀏覽器那一份：非 ASCII 換成底線，不會把 header 值切成兩半。
      expect(disposition).toContain('filename="__.md"');
      expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('報告.md')}`);
    } finally {
      await outcome.close();
    }
  });
});

describe('錨', () => {
  it('線以下的事件拒絕，而那條 thread 是活著的——分界是 seq，不是 thread', async () => {
    const outcome = await present({ 'a.md': 'one\n' }, ['a.md']);
    try {
      // 線以上：讀得到。
      expect((await outcome.get(filePath(`seq=${outcome.seq}&index=0`))).status).toBe(200);
    } finally {
      await outcome.close();
    }
    // 同一份日誌，這一次整段當成「上一個行程寫的」接回來。**agent 照樣建得起來、thread 照樣活著**，
    // 分界只看 seq。
    const seeded = await present({ 'a.md': 'one\n' }, ['a.md'], {
      seed: await seedWithDeliverable(),
    });
    try {
      const refused = await seeded.get(filePath('seq=0&index=0'));
      expect(refused.status).toBe(404);
      expect(await refused.text()).toContain('工作區根');
    } finally {
      await seeded.close();
    }
  });

  it('沒給 --workspace 時兩條路由都錨不住', async () => {
    const outcome = await present({ 'a.md': 'one\n' }, ['a.md'], { workspace: false });
    try {
      expect((await outcome.get(filePath(`seq=${outcome.seq}&index=0`))).status).toBe(404);
      expect((await outcome.get(downloadPath(`seq=${outcome.seq}&index=0`))).status).toBe(404);
    } finally {
      await outcome.close();
    }
  });

  it('座標指到的不是交付事件、或沒有那個 index，都是 404', async () => {
    const outcome = await present({ 'a.md': 'one\n' }, ['a.md']);
    try {
      expect((await outcome.get(filePath('seq=0&index=0'))).status).toBe(404);
      expect((await outcome.get(filePath(`seq=${outcome.seq}&index=9`))).status).toBe(404);
      expect((await outcome.get(filePath('seq=abc&index=0'))).status).toBe(400);
      expect((await outcome.get(filePath(`seq=${outcome.seq}`))).status).toBe(400);
    } finally {
      await outcome.close();
    }
  });
});

describe('閘門', () => {
  it('最後一段是符號連結就拒——lexical 的圍堵擋不到它', async () => {
    const outcome = await present({ 'real.md': 'secret\n' }, ['link.md'], {
      setup: async (root) => {
        await writeFile(join(root, 'real.md'), 'secret\n');
        await symlink(join(root, 'real.md'), join(root, 'link.md'));
      },
    });
    try {
      const response = await outcome.get(filePath(`seq=${outcome.seq}&index=0`));
      expect(response.status).toBe(404);
      expect(await response.text()).toContain('符號連結');
    } finally {
      await outcome.close();
    }
  });

  it('目錄不是一般檔', async () => {
    const outcome = await present({}, ['sub'], {
      setup: async (root) => {
        await mkdir(join(root, 'sub'));
        await writeFile(join(root, 'sub', 'x.md'), 'x\n');
      },
    });
    try {
      // `present` 自己就擋掉目錄了，所以這一輪根本不會有交付事件——那也是一道閘。
      expect(outcome.seq).toBe(-1);
    } finally {
      await outcome.close();
    }
  });
});

describe('真的 serve 上，錨從組裝點傳到路由', () => {
  /**
   * **這一組不驗讀得到什麼，只驗錨有沒有到。**
   *
   * 上面每一條測試都自己手搭 `createAgent`、直接交 `workspaceRoot`，所以
   * `createCliAgent` 回傳它、`serve.ts` 轉交它那兩行**完全沒有觀察點**——量過：兩行都拔掉，
   * 全樹 1169 條一條都不紅，而真的 serve 上每一顆交付都會 404。
   *
   * 判別靠的是兩句不同的拒絕：錨到了，才問得到「那個 seq 上沒有交付宣告」；錨沒到，講的是
   * 「沒給 --workspace」。
   */
  let running: RunningServe | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  /**
   * 起一台 serve、開一條 thread（拿歷史就會把它建起來），然後打預覽那條路由。
   *
   * @param argv - 額外的旗標。
   * @returns 那一次拒絕的文字。
   */
  async function refusalText(argv: readonly string[]): Promise<string> {
    running = (await runServe({
      argv: ['--port', '0', ...argv],
      log: () => undefined,
      env: {},
    })) as RunningServe;
    const server = running;
    const cookie = await exchangeServeToken(server.authenticatedUrl);
    const client = createWireClient({ baseUrl: server.url, fetch: fetchWithCookie(cookie) });
    // **拿歷史就把 thread 建起來了**（`handleHistory` → `threadOrError` → `threadFor`），
    // 所以 `ready` 有它——這正是 #452 修訂決議查出來的那件事。
    const page = await client.threadHistory('anchored');
    if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
    const response = await fetchWithCookie(cookie)(
      `${server.url}${deliverableFilePath('anchored')}?seq=0&index=0`,
      { method: 'GET', headers: { 'content-type': 'application/json' } },
    );
    expect(response.status).toBe(404);
    return response.text();
  }

  it('給了 --workspace：錨到得了路由，拒絕的理由是座標而不是沒錨', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-deliverable-serve-'));
    roots.push(root);
    expect(await refusalText(['--workspace', root])).toContain('沒有交付宣告');
  });

  it('沒給 --workspace：拒絕的理由就是沒有錨', async () => {
    expect(await refusalText([])).toContain('--workspace');
  });
});

describe('locateDeliverable', () => {
  const event = (seq: number, paths: readonly string[]): SessionEvent =>
    ({
      type: 'deliverables/presented',
      seq,
      time: 0,
      data: { callId: 'c', files: paths.map((path) => ({ path })) },
    }) as unknown as SessionEvent;

  it('線正好在 storedCount 上：等於它的那一顆通過，小一的那一顆拒', () => {
    const events = [event(0, ['a.md']), event(1, ['b.md'])];
    expect(locateDeliverable(events, 1, 1, 0)).toEqual({ kind: 'ok', value: 'b.md' });
    const refused = locateDeliverable(events, 1, 0, 0);
    expect(refused).toMatchObject({ kind: 'refused', reason: 'no-anchor' });
  });

  it('沒續接時 storedCount 是 0，第一顆就通過', () => {
    expect(locateDeliverable([event(0, ['a.md'])], 0, 0, 0)).toEqual({ kind: 'ok', value: 'a.md' });
  });
});

/** 一份看起來像「上一個行程寫過」的 seed：`seq` 從 0 連續，第一顆就是交付。 */
async function seedWithDeliverable(): Promise<readonly SessionEvent[]> {
  return [
    {
      type: 'deliverables/presented',
      seq: 0,
      time: 0,
      data: { callId: 'old', files: [{ path: 'a.md' }] },
    } as unknown as SessionEvent,
  ];
}
