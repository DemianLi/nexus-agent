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
 *    讀得到；線以下的要看那份日誌的 header 有沒有記工作區根——記了就讀得到、沒記才拒
 *    （[#519](https://github.com/DemianLi/nexus-agent/issues/519)）。只驗「活著就讀得到」的
 *    測試對這個分岔是瞎的。
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
import { locateDeliverable } from './deliverable-files.js';
import {
  deliverableFilesConfigSchema,
  DEFAULT_DELIVERABLE_MAX_LINES,
  type DeliverableFilesConfig,
} from './settings/deliverable-files.js';
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
 *   `seed` 讓這條 thread 看起來是續接回來的，用來把分界線推上去；`resumedRoot` 是接回來那份
 *   header 記的工作區根（`'same'` 就是這一次這個根，`'other'` 是另一個目錄），缺席代表那份
 *   header 沒記那一格（[#519](https://github.com/DemianLi/nexus-agent/issues/519)）。
 * @returns 那一輪的結果。
 */
async function present(
  files: Record<string, string | Uint8Array>,
  declared: readonly string[],
  options: {
    workspace?: boolean;
    seed?: readonly SessionEvent[];
    resumedRoot?: 'same' | 'other';
    setup?: (root: string) => Promise<void>;
    /** 交給 `createWireHandler` 的三個上限。缺席即那一列 schema 的預設值。 */
    limits?: DeliverableFilesConfig;
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
    ...(options.limits !== undefined && { deliverableLimits: options.limits }),
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
      ...(options.resumedRoot !== undefined && {
        resumedWorkspaceRoot:
          options.resumedRoot === 'same' ? root : join(root, '..', '別的工作區'),
      }),
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
    // **取最後一顆，不是第一顆**：帶 `seed` 的那幾條測試裡，seed 自己就有一顆交付落在 `seq 0`，
    // 而這個欄位要講的是**這一輪自己**宣告的那一顆。沒帶 seed 時全程只有一顆，兩種取法一樣。
    const at = sessions.root.events.findLastIndex(
      (event) => event.type === 'deliverables/presented',
    );
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

  /**
   * **`maxLines` 是雙用的，這兩條一起釘住它**（[#529](https://github.com/DemianLi/nexus-agent/issues/529)）。
   *
   * 那一格同時是「沒給 `limit` 查詢參數時用的預設」（`wire-handler.ts` 的
   * `handleDeliverableFile`）與「給了就不准超過的上限」（`deliverable-files.ts` 的
   * `readDeliverablePage`）。dsh 同形，兩處讀同一個 `this.config.maxLines`。
   *
   * **只接其中一處的話，兩個方向都會壞**：設定高於另一邊寫死的上限 → 不帶 `limit` 的請求全部
   * 400；設定低於另一邊寫死的預設 → 一樣。所以第一條刻意**不帶 `limit`**——一條每次都明著傳
   * `limit` 的測試會從這個缺陷底下綠著走過去。
   *
   * 7 這個數字挑得比檔案的 20 行小、也跟預設的 5000 差得遠：兩邊任何一處退回讀常數，行數都對不上。
   */
  describe('三個上限從設定來', () => {
    /** 20 行，行號寫在內容裡，切到第幾行看得出來。 */
    const twenty = `${Array.from({ length: 20 }, (_, index) => `line ${String(index)}`).join('\n')}\n`;
    const withMaxLines = (maxLines: number): DeliverableFilesConfig =>
      deliverableFilesConfigSchema.parse({ maxLines });

    it('不給 limit 時用設定的行數當預設，不是那個常數', async () => {
      const outcome = await present({ 'a.md': twenty }, ['a.md'], { limits: withMaxLines(7) });
      try {
        // **不帶 `limit`**：這一條的全部價值在這裡。
        const page = (await (
          await outcome.get(filePath(`seq=${outcome.seq}&index=0`))
        ).json()) as DeliverableFilePage;
        expect(page.lines).toBe(7);
        expect(page.text).toBe('line 0\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6');
        expect(page.eof).toBe(false);
      } finally {
        await outcome.close();
      }
    });

    it('明著要超過設定的行數是拒絕——上限那一半也接上了', async () => {
      const outcome = await present({ 'a.md': twenty }, ['a.md'], { limits: withMaxLines(7) });
      try {
        const refused = await outcome.get(filePath(`seq=${outcome.seq}&index=0&limit=8`));
        expect(refused.status).toBe(400);
        expect(await refused.text()).toContain('limit 最多 7 行');
        // 正好等於上限的那一個要過——擋的是「超過」，不是「碰到」。
        const ok = await outcome.get(filePath(`seq=${outcome.seq}&index=0&limit=7`));
        expect(ok.status).toBe(200);
      } finally {
        await outcome.close();
      }
    });

    it('整檔上限也從設定來：比檔案小就拒，而且講得出是幾', async () => {
      const outcome = await present({ 'a.md': twenty }, ['a.md'], {
        limits: deliverableFilesConfigSchema.parse({ maxFileBytes: 10 }),
      });
      try {
        const refused = await outcome.get(filePath(`seq=${outcome.seq}&index=0`));
        expect(refused.status).toBe(413);
        expect(await refused.text()).toContain('超過 10 的上限');
      } finally {
        await outcome.close();
      }
    });

    /**
     * **serve 那條線只能這樣釘，而理由是量出來的。**
     *
     * 上面四條證的是「`createWireHandler` 收到什麼就用什麼」。缺的那一步是「`serve.ts` 起動期
     * 解出來的那一份，真的傳給了 handler」——而那一步**在 serve 上觀察不到**：要看見它就得有一個
     * 宣告過的交付檔，而 serve 不帶 `--live` 時的假模型腳本（`cli.ts` 的 `CLI_SCRIPT`）只呼叫
     * `echo` 與 `write_file`，一次都不呼叫 `present`。為了測試去改產品腳本是本末倒置。
     *
     * **實測過缺口是真的**：把 `serve.ts` 那一行 `deliverableLimits,` 刪掉，`apps/harness` 全套
     * 1234 條**全綠**。一條用參數傳的線天生沒有觀察點（同 `settings/startup.test.ts` 的檔頭），
     * 而這一格連那個檔的兩臂手法都用不上。
     *
     * 所以退到結構性檢查，形狀照 `eval/session-absence.test.ts`。它擋的正是那次突變：那一行被
     * 刪掉、或那一列不再被解出來，這裡當場紅。
     */
    it('serve 起動期解出那一列，而且真的傳給 handler', async () => {
      const source = await readFile(new URL('./serve.ts', import.meta.url), 'utf8');
      expect(source).toContain('startupSetting(plugins, deliverableFilesPlugin)');
      // `createWireHandler({` 那一段裡要有它——不是檔案裡任何地方有這個字就算。
      const call = source.slice(source.indexOf('createWireHandler({'));
      expect(call.slice(0, call.indexOf('createAgent'))).toContain('deliverableLimits,');
    });

    it('一頁的位元組上限也從設定來', async () => {
      const outcome = await present({ 'a.md': twenty }, ['a.md'], {
        limits: deliverableFilesConfigSchema.parse({ maxBytes: 12 }),
      });
      try {
        const refused = await outcome.get(filePath(`seq=${outcome.seq}&index=0`));
        expect(refused.status).toBe(413);
        expect(await refused.text()).toContain('超過 12 的上限');
      } finally {
        await outcome.close();
      }
    });
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
        filePath(`seq=${outcome.seq}&index=0&limit=${DEFAULT_DELIVERABLE_MAX_LINES + 1}`),
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
    // 同一份日誌，這一次整段當成「上一個行程寫的」接回來，而且那份 header **沒記**工作區根
    // （13 以前的日誌都是這樣）。**agent 照樣建得起來、thread 照樣活著**，分界只看 seq。
    const seeded = await present({ 'a.md': 'one\n' }, ['a.md'], {
      seed: await seedWithDeliverable(),
    });
    try {
      const refused = await seeded.get(filePath('seq=0&index=0'));
      expect(refused.status).toBe(404);
      expect(await refused.text()).toContain('header 沒記工作區根');
    } finally {
      await seeded.close();
    }
  });

  /**
   * [#519](https://github.com/DemianLi/nexus-agent/issues/519) 的驗收句：**同一份 seed，只差
   * header 有沒有記那一格**——沒記照舊 404（上面那條），記了就讀得到。兩條合起來才證得出
   * 判準是那一格，不是「線以下」本身。
   */
  it('線以下的事件，header 記著同一個根：讀得到，而且內容是對的那一份', async () => {
    const seeded = await present({ 'a.md': 'one\n' }, ['a.md'], {
      seed: await seedWithDeliverable(),
      resumedRoot: 'same',
    });
    try {
      const response = await seeded.get(filePath('seq=0&index=0'));
      expect(response.status).toBe(200);
      const page = (await response.json()) as DeliverableFilePage;
      expect(page.path).toBe('a.md');
      expect(page.text).toBe('one');
      // 下載那條走同一個前半，所以它也跟著開了。
      expect((await seeded.get(downloadPath('seq=0&index=0'))).status).toBe(200);
    } finally {
      await seeded.close();
    }
  });

  /**
   * **這一道今天永遠不會響**：`assertSameWorkspaceRoot` 在續接那一刻就擋下了不等的情形，所以
   * 產品路徑上 `resumedWorkspaceRoot` 與 `workspaceRoot` 只要都有值就相等。留著它是為了讓那個
   * 保證**有觀察點**——守衛哪天鬆掉、或 `serve.ts` 的轉交被換成別的值，這裡當場 404，而不是
   * 靜靜去另一個工作區讀同名檔。拿掉這三行，這條測試是唯一會紅的東西。
   */
  it('線以下的事件，header 記的是別的根：拒，而且訊息指名兩個根', async () => {
    const seeded = await present({ 'a.md': 'one\n' }, ['a.md'], {
      seed: await seedWithDeliverable(),
      resumedRoot: 'other',
    });
    try {
      const refused = await seeded.get(filePath('seq=0&index=0'));
      expect(refused.status).toBe(404);
      const text = await refused.text();
      expect(text).toContain('別的工作區');
      expect(text).toContain(seeded.root);
    } finally {
      await seeded.close();
    }
  });

  /**
   * **`resume-guards.ts` 四格表第二列的理由不准被這一刀弄壞。** 那一列（header 記了、這一次
   * 沒給 `--workspace`）放行，靠的正是「沒有根的時候每一次交付讀檔都拒」。記了根也一樣拒。
   */
  it('header 記著根、但這台 server 這一次沒給 --workspace：照樣拒', async () => {
    const seeded = await present({ 'a.md': 'one\n' }, ['a.md'], {
      seed: await seedWithDeliverable(),
      resumedRoot: 'same',
      workspace: false,
    });
    try {
      const refused = await seeded.get(filePath('seq=0&index=0'));
      expect(refused.status).toBe(404);
      expect(await refused.text()).toContain('--workspace');
    } finally {
      await seeded.close();
    }
  });

  /**
   * **同一條 seeded thread 上，線的兩側**（原本在 `locateDeliverable` 上量的那個 off-by-one，
   * 判準搬到 `locateRequested` 之後跟著搬過來）。
   *
   * 兩個方向要分開講，因為只有一個是靜默的：
   *
   * - 把線以下判成以上 ⟹ **靜默錯檔**。seed 長度是 1，所以上面那條測試裡的 `seq 0` 就是
   *   `storedCount - 1`，少算一格的實作會讓它通過而那條測試紅——那個方向已經有人守著。
   * - 把線以上判成以下 ⟹ 讀不到自己這一輪剛交付的檔。**這一條守的是它**：拒絕的依據要是
   *   `seq`，不是「這條 thread 是接回來的」。
   */
  it('同一條 seeded thread，線以上那顆讀得到——拒的依據是 seq，不是「接回來的」', async () => {
    const seed = await seedWithDeliverable();
    const seeded = await present({ 'a.md': 'one\n' }, ['a.md'], { seed });
    try {
      // 前提：這一輪自己那顆交付真的在線以上。不然下面那句證的是別的事。
      expect(seeded.seq).toBeGreaterThanOrEqual(seed.length);
      expect((await seeded.get(filePath(`seq=${seeded.seq}&index=0`))).status).toBe(200);
      expect((await seeded.get(filePath(`seq=${seed.length - 1}&index=0`))).status).toBe(404);
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

/**
 * `locateDeliverable` 只剩形狀檢查——**錨錨不錨得住是 `locateRequested` 的事**，證它的測試
 * 在上面那一組「錨」（[#519](https://github.com/DemianLi/nexus-agent/issues/519)）。
 */
describe('locateDeliverable', () => {
  const event = (seq: number, paths: readonly string[]): SessionEvent =>
    ({
      type: 'deliverables/presented',
      seq,
      time: 0,
      data: { callId: 'c', files: paths.map((path) => ({ path })) },
    }) as unknown as SessionEvent;

  it('那個 seq 上是交付宣告，就把原路徑字串交出來', () => {
    const events = [event(0, ['a.md']), event(1, ['b.md'])];
    expect(locateDeliverable(events, 0, 0)).toEqual({ kind: 'ok', value: 'a.md' });
    expect(locateDeliverable(events, 1, 0)).toEqual({ kind: 'ok', value: 'b.md' });
  });

  it('那個 seq 上沒有事件、或它不是交付宣告：not-found', () => {
    const other = { type: 'run/started', seq: 0, time: 0, data: {} } as unknown as SessionEvent;
    expect(locateDeliverable([other], 0, 0)).toMatchObject({
      kind: 'refused',
      reason: 'not-found',
    });
    expect(locateDeliverable([], 0, 0)).toMatchObject({ kind: 'refused', reason: 'not-found' });
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
