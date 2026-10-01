/**
 * **兩個交付讀檔方法（`deliverable.read`、`deliverable.readBytes`）在真的圖、真的 pump 與真的 HTTP 上跑一次**——
 * [#452](https://github.com/DemianLi/nexus-agent/issues/452) 第二刀的驗收，傳送方式在 [#747](https://github.com/DemianLi/nexus-agent/issues/747) 換成命令通道。
 *
 * 證的是這幾件，每一件都有一個「錯了也不會有別的測試紅」的失敗方向：
 *
 * 1. **整檔讀回來的位元組跟磁碟上完全相同**——這一條是衝著基座那支 `readRaw` 寫的：它會把二進位
 *    當 UTF-8 解掉、`error` 還是 `undefined`（量測見 `deliverable-files.ts` 的
 *    `readDeliverableBytes`）。走那條路下載一張 PNG 是壞的而且沒有徵兆，所以這裡的斷言是
 *    `toEqual` 整串位元組，不是長度、不是「有內容」。
 * 2. **錨的分界是 `seq < storedCount`，不是 thread 活不活著**：同一條活著的 thread，線以上的
 *    讀得到；線以下的要看那份日誌的 header 有沒有記工作區根——記了就讀得到、沒記才拒
 *    （[#519](https://github.com/DemianLi/nexus-agent/issues/519)）。只驗「活著就讀得到」的
 *    測試對這個分岔是瞎的。
 * 3. **符號連結拒**：`virtualMode` 的圍堵是 lexical 的，擋不到它。
 * 4. **五種拒絕各有各的碼**：壓成同一個的話前端分不出該畫什麼，而畫面上看不出來。
 * 5. **上限是拒絕不是截斷**。
 *
 * **走產品組裝**（#670）：agent 是 `createCliAgent`（出貨清單、組裝點建的 backend 與沙箱控制器）組的，模型換成清單上的腳本
 * 提供者；handler 這一層（上限、續接的 seed、header 記的根、錨）由測試明著給，因為那幾格正是各條測試要變動的東西。
 * `workspaceRoot` 取自 `createCliAgent` 回傳的那一個，就是 `serve.ts` 轉交的那一個。
 *
 * **零憑證、零外部連線**：模型是腳本，工作區是暫存目錄，測試不碰真的 `~/.nexus-agent`。
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionEvent, SessionRegistry } from '@nexus/core';
import { PRESENT_TOOL_NAME } from '@nexus/plugin-present';
import type {
  DeliverableBytes,
  DeliverableReadBytesResult,
  DeliverableReadError,
  DeliverableReadResult,
  RpcMethod,
} from '@nexus/wire';
import {
  commandPath,
  createDeliverableClient,
  createWireClient,
  decodeBinaryResult,
  isBinaryResponse,
} from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
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
  withScriptedModel,
} from './fixtures.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
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
  /** 命令通道上送一個方法（#747）：帶會話 cookie 與 `content-type: application/json`，`init` 可蓋掉。 */
  post(method: string, params: unknown, init?: RequestInit): Promise<Response>;
  /** 原樣把一個請求交給 handler：測閘門用，不替它補 cookie 與 header。 */
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/**
 * 跑一輪 `present`，回一個可以打命令通道的把手。
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
  // **agent 一律帶 `--workspace`**：`workspace: false` 要模擬的是「handler 沒拿到工作區根」，不是「agent 沒有工作區」——
  // 後者連 `present` 都叫不動，也就沒有交付可讀。
  const built = await createCliAgent(
    { live: false, workspace: root },
    withScriptedModel(shipped, [
      {
        content: '交付。',
        toolCalls: [
          { name: PRESENT_TOOL_NAME, args: { files: declared.map((path) => ({ path })) } },
        ],
      },
      { content: '交付好了。' },
    ]),
    root,
  );
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    ...(options.limits !== undefined && { deliverableLimits: options.limits }),
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      dispose: built.dispose,
      attachSessions: (registry, backgroundPort) => {
        sessions = registry;
        return built.attachSessions(registry, backgroundPort);
      },
      ...(workspace && { workspaceRoot: built.workspaceRoot }),
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
      post: (method, params, init) =>
        handler.handle(
          loopbackRequest(`${BASE_URL}${commandPath(THREAD_ID, method as RpcMethod)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: 1, method, params }),
            ...init,
          }),
        ),
      handle: (request) => handler.handle(request),
      close: () => handler.close(),
    };
  } catch (error) {
    await handler.close();
    throw error;
  }
}

/** 一次 `deliverable.read`：座標預設是這一輪那顆交付的第 0 個檔，`params` 蓋掉。回應結果，不是 HTTP 回應。 */
async function readPage(
  outcome: Outcome,
  params: Record<string, unknown> = {},
): Promise<DeliverableReadResult> {
  const response = await outcome.post('deliverable.read', {
    seq: outcome.seq,
    index: 0,
    ...params,
  });
  expect(response.status).toBe(200);
  expect(isBinaryResponse(response)).toBe(false);
  return ((await response.json()) as { result: DeliverableReadResult }).result;
}

/** 一次 `deliverable.readBytes`：成功且帶位元組是多段表單，拒絕是 JSON。 */
async function readWindow(
  outcome: Outcome,
  params: Record<string, unknown> = {},
): Promise<Response> {
  const response = await outcome.post('deliverable.readBytes', {
    seq: outcome.seq,
    index: 0,
    ...params,
  });
  expect(response.status).toBe(200);
  return response;
}

async function bytesResult(response: Response): Promise<DeliverableReadBytesResult> {
  if (isBinaryResponse(response)) {
    return (await decodeBinaryResult(response)).result as unknown as DeliverableReadBytesResult;
  }
  return ((await response.json()) as { result: DeliverableReadBytesResult }).result;
}

/** 讀位元組並取成功的值；讀不到就拋，訊息帶碼。 */
async function windowOf(
  outcome: Outcome,
  params: Record<string, unknown> = {},
): Promise<DeliverableBytes> {
  return okOf(await bytesResult(await readWindow(outcome, params)));
}

/** 取成功的值；被拒就拋，訊息帶碼與理由，斷言失敗時看得出是哪一種拒絕。 */
function okOf<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: DeliverableReadError },
): T {
  if (!result.ok) throw new Error(`讀不到：${result.error.code} ${result.error.message}`);
  return result.value;
}

/** 取被拒的那個 `error`；讀得到就拋。 */
function refusedOf(
  result: { readonly ok: true } | { readonly ok: false; readonly error: DeliverableReadError },
): DeliverableReadError {
  if (result.ok) throw new Error('應該被拒，卻讀到了');
  return result.error;
}

/** 參數不合格：協定錯誤 `invalid_argument`，回它的訊息。 */
async function invalidArgumentOf(
  outcome: Outcome,
  method: string,
  params: unknown,
): Promise<string> {
  const response = await outcome.post(method, params);
  expect(response.status, JSON.stringify(params)).toBe(200);
  const body = (await response.json()) as { type: string; error: string; message: string };
  expect(body, JSON.stringify(params)).toMatchObject({ type: 'error', error: 'invalid_argument' });
  return body.message;
}

describe('預覽', () => {
  it('讀得到宣告過的檔，帶不透明的 version 與位元組數', async () => {
    const outcome = await present({ 'a.md': 'one\ntwo\nthree\n' }, ['a.md']);
    try {
      const page = okOf(await readPage(outcome));
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
   * 那一格同時是「沒給 `limit` 時用的預設」（`wire-handler.ts` 的 `handleDeliverableCommand`）與
   * 「給了就不准超過的上限」（`deliverable-files.ts` 的 `readDeliverablePage`）。dsh 同形，兩處讀同一個
   * `this.config.maxLines`。
   *
   * **只接其中一處的話，兩個方向都會壞**：設定高於另一邊寫死的上限 → 不帶 `limit` 的請求全部
   * 被拒；設定低於另一邊寫死的預設 → 一樣。所以第一條刻意**不帶 `limit`**——一條每次都明著傳
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
        const page = okOf(await readPage(outcome));
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
        expect(
          await invalidArgumentOf(outcome, 'deliverable.read', {
            seq: outcome.seq,
            index: 0,
            limit: 8,
          }),
        ).toContain('limit 最多 7 行');
        // 正好等於上限的那一個要過——擋的是「超過」，不是「碰到」。
        expect(okOf(await readPage(outcome, { limit: 7 })).lines).toBe(7);
      } finally {
        await outcome.close();
      }
    });

    /**
     * **翻面過的絆索**（#544）：原本這一條斷言的是**預覽**被整檔上限拒。預覽改成串流、整檔不設上限之後
     * （照 dsh：「The file itself has no size cap: a caller pages through it」），那一格只剩整檔讀在用
     * ——dsh 的不帶範圍的 `readBytes`。所以兩臂都要釘：同一個上限底下，預覽讀得到、整檔讀拒。
     */
    it('整檔上限只管整檔讀：預覽照樣讀得到，整檔讀拒而且講得出是幾', async () => {
      const outcome = await present({ 'a.md': twenty }, ['a.md'], {
        limits: deliverableFilesConfigSchema.parse({ maxFileBytes: 10 }),
      });
      try {
        const page = okOf(await readPage(outcome));
        // 前提：檔案真的比上限大，不然上面那個讀得到什麼都沒證明。
        expect(page.bytes).toBeGreaterThan(10);
        expect(page.lines).toBe(20);
        expect(page.eof).toBe(true);

        const whole = refusedOf(await bytesResult(await readWindow(outcome)));
        expect(whole).toMatchObject({ code: 'deliverable/too-large', maxBytes: 10 });
        expect(whole.message).toContain('超過 10 的上限');
      } finally {
        await outcome.close();
      }
    });

    /**
     * **serve 那條線的結構性檢查，行為那一半在 `serve-scripted-provider.test.ts`。**
     *
     * 上面四條證的是「`createWireHandler` 收到什麼就用什麼」。缺的那一步是「`serve.ts` 起動期
     * 解出來的那一份，真的傳給了 handler」。以前那一步**在 serve 上觀察不到**：要看見它就得有一個
     * 宣告過的交付檔，而不帶 `--live` 的假模型腳本（`CLI_SCRIPT`）一次都不呼叫 `present`——#536 量過，
     * 把 `serve.ts` 那一行 `deliverableLimits,` 刪掉，`apps/harness` 全套 1234 條全綠。
     *
     * [#670](https://github.com/DemianLi/nexus-agent/issues/670) 之後有了行為測試：`serve-scripted-provider.test.ts` 在
     * 真的 `runServe` 上用 patch 換掉模型提供者、叫一次 `present`，上限調小的那一組讀不動。**這一條留著當第二道**：
     * 它便宜，而且擋的是同一次突變——那一行被刪掉、或那一列不再被解出來，這裡當場紅。
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
        const refused = refusedOf(await readPage(outcome));
        expect(refused).toMatchObject({ code: 'deliverable/too-large', maxBytes: 12 });
        expect(refused.message).toContain('超過 12 的上限');
      } finally {
        await outcome.close();
      }
    });
  });

  it('version 的契約：內容沒動就同值，動過就換值', async () => {
    const outcome = await present({ 'a.md': 'one\n' }, ['a.md']);
    try {
      const first = okOf(await readPage(outcome));
      const again = okOf(await readPage(outcome));
      // 讀兩次不會換值——換了的話前端每次都以為檔變了。
      expect(again.version).toBe(first.version);
      await writeFile(join(outcome.root, 'a.md'), 'one\ntwo\n');
      const changed = okOf(await readPage(outcome));
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
      const first = okOf(await readPage(outcome, { offset: 0, limit: 4 }));
      expect(first.text).toBe('line0\nline1\nline2\nline3');
      expect(first.eof).toBe(false);
      const last = okOf(await readPage(outcome, { offset: 8, limit: 4 }));
      expect(last.text).toBe('line8\nline9');
      expect(last.lines).toBe(2);
      expect(last.eof).toBe(true);
    } finally {
      await outcome.close();
    }
  });

  it('含 NUL 的檔是 not-text，而且那個碼跟「忘了帶 content-type」分得開', async () => {
    const outcome = await present({ 'b.bin': new Uint8Array([0, 1, 2, 3, 255, 254]) }, ['b.bin']);
    try {
      expect(refusedOf(await readPage(outcome)).code).toBe('deliverable/not-text');
      // 同一個方法、同一個座標，只差沒帶 header：這是載體層的 415，不是業務結果，前端才分得出該做什麼。
      const noHeader = await outcome.post(
        'deliverable.read',
        { seq: outcome.seq, index: 0 },
        { headers: {} },
      );
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
      const result = await readPage(outcome);
      expect(refusedOf(result).code).toBe('deliverable/too-large');
      // **回的不是一頁切短的內容**——切短的一頁看起來就是整頁，那是這條上限存在的全部理由。
      expect(result).not.toHaveProperty('value');
    } finally {
      await outcome.close();
    }
  });

  it('limit 超過上限是拒絕，不是給到上限為止', async () => {
    const outcome = await present({ 'a.md': 'one\n' }, ['a.md']);
    try {
      await invalidArgumentOf(outcome, 'deliverable.read', {
        seq: outcome.seq,
        index: 0,
        limit: DEFAULT_DELIVERABLE_MAX_LINES + 1,
      });
    } finally {
      await outcome.close();
    }
  });

  /**
   * **串流切頁**（#544）。底下幾條的檔案都比 `createReadStream` 一片的 64 KiB 大，行、字元、
   * NUL 都刻意放在片與片的邊界兩側——只用小檔的話，整份一片就讀完，串流那幾條路一條都沒被問到。
   */
  describe('串流切頁', () => {
    /** 200 000 個位元組的一行，跨好幾片。 */
    const long = 'y'.repeat(200_000);

    it('讀到這一頁就停：頁後 200 KB 才出現的 NUL 不會讓第一頁讀不到', async () => {
      // 整檔讀進來再掃 NUL 的舊寫法，這一條是 not-text。
      const outcome = await present({ 'a.md': `first\n${long}\n\u0000\n` }, ['a.md']);
      try {
        const page = okOf(await readPage(outcome, { limit: 1 }));
        expect(page.text).toBe('first');
        expect(page.eof).toBe(false);
      } finally {
        await outcome.close();
      }
    });

    /**
     * **行為變了，而且是照標準變的**：NUL 只掃這一頁，照 dsh（「the NUL scan runs on the page
     * itself」）。從前整檔掃，前段那一頁也拒。
     */
    it('NUL 只掃這一頁：前段讀得到，有 NUL 的那一頁才 not-text', async () => {
      const outcome = await present({ 'a.md': 'a\nb\n\u0000\n' }, ['a.md']);
      try {
        expect(okOf(await readPage(outcome, { limit: 2 })).text).toBe('a\nb');
        expect(refusedOf(await readPage(outcome, { offset: 2, limit: 1 })).code).toBe(
          'deliverable/not-text',
        );
      } finally {
        await outcome.close();
      }
    });

    it('不是 UTF-8 就是 not-text，照 dsh 的 streamText——即使沒有 NUL', async () => {
      const bytes = new Uint8Array([...new TextEncoder().encode('hello\n'), 0xff, 0xfe, 0x0a]);
      const outcome = await present({ 'latin.txt': bytes }, ['latin.txt']);
      try {
        const refused = refusedOf(await readPage(outcome));
        expect(refused.code).toBe('deliverable/not-text');
        expect(refused.message).toContain('不是 UTF-8');
      } finally {
        await outcome.close();
      }
    });

    it('頁前那一條長行只數不留：它自己超過頁上限，後面那一行照樣讀得到', async () => {
      const outcome = await present({ 'a.md': `${long}\nok\n` }, ['a.md'], {
        limits: deliverableFilesConfigSchema.parse({ maxBytes: 64 }),
      });
      try {
        const page = okOf(await readPage(outcome, { offset: 1, limit: 1 }));
        expect(page.text).toBe('ok');
        expect(page.eof).toBe(true);
        // 對照組：要的就是那一條長行，那就是拒——頁的上限仍然是拒絕，不是截斷。
        expect(refusedOf(await readPage(outcome, { offset: 0, limit: 1 })).code).toBe(
          'deliverable/too-large',
        );
      } finally {
        await outcome.close();
      }
    });

    it('多位元組字元切在兩片之間也解得對', async () => {
      // 150 000 個位元組；65 536 不是 3 的倍數，所以第一片的邊界一定切在某個字的中間。
      const han = '中'.repeat(50_000);
      const outcome = await present({ 'han.md': `${han}\n` }, ['han.md']);
      try {
        const page = okOf(await readPage(outcome));
        expect(page.text).toBe(han);
        expect(page.lines).toBe(1);
      } finally {
        await outcome.close();
      }
    });

    it('翻到最後一頁：兩萬行、兩百多 KB，最後十行是對的，eof 只在那一頁', async () => {
      const text = `${Array.from({ length: 20_000 }, (_, at) => `line ${String(at)}`).join('\n')}\n`;
      const outcome = await present({ 'a.md': text }, ['a.md']);
      try {
        const last = okOf(await readPage(outcome, { offset: 19_990, limit: 10 }));
        expect(last.text.split('\n')).toEqual(
          Array.from({ length: 10 }, (_, at) => `line ${String(19_990 + at)}`),
        );
        expect(last.eof).toBe(true);
        expect(okOf(await readPage(outcome, { offset: 19_980, limit: 10 })).eof).toBe(false);
      } finally {
        await outcome.close();
      }
    });

    it('空檔是零行，照 dsh；開頭的 BOM 照舊吃掉', async () => {
      const outcome = await present({ 'empty.md': '', 'bom.md': '﻿hi\n' }, ['empty.md', 'bom.md']);
      try {
        expect(okOf(await readPage(outcome, { index: 0 }))).toMatchObject({
          text: '',
          lines: 0,
          eof: true,
        });
        expect(okOf(await readPage(outcome, { index: 1 })).text).toBe('hi');
      } finally {
        await outcome.close();
      }
    });
  });
});

describe('整檔讀', () => {
  it('回來的位元組跟磁碟上一模一樣——二進位不會被當 UTF-8 解掉', async () => {
    // **這一串是刻意挑的**：`00` 讓它不是文字，`ff fe` 是 UTF-8 裡永遠不合法的兩個位元組。
    // 走基座 `readRaw` 的話這 6 個位元組會變成 10 個，而且 `error` 是 `undefined`。
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 254]);
    const outcome = await present({ 'logo.png': bytes }, ['logo.png']);
    try {
      const got = (await windowOf(outcome)).data;
      expect([...got]).toEqual([...bytes]);
      const truth = await readFile(join(outcome.root, 'logo.png'));
      expect([...got]).toEqual([...truth]);
    } finally {
      await outcome.close();
    }
  });

  it('二進位預覽不了，但整檔讀照給——同一個檔、兩個方法、兩種結局', async () => {
    const outcome = await present({ 'b.bin': new Uint8Array([0, 1, 2]) }, ['b.bin']);
    try {
      expect(refusedOf(await readPage(outcome)).code).toBe('deliverable/not-text');
      expect((await bytesResult(await readWindow(outcome))).ok).toBe(true);
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
      okOf(await readPage(outcome));
    } finally {
      await outcome.close();
    }
    // 同一份日誌，這一次整段當成「上一個行程寫的」接回來，而且那份 header **沒記**工作區根
    // （13 以前的日誌都是這樣）。**agent 照樣建得起來、thread 照樣活著**，分界只看 seq。
    const seeded = await present({ 'a.md': 'one\n' }, ['a.md'], {
      seed: await seedWithDeliverable(),
    });
    try {
      const refused = refusedOf(await readPage(seeded, { seq: 0 }));
      expect(refused.code).toBe('deliverable/no-anchor');
      expect(refused.message).toContain('header 沒記工作區根');
    } finally {
      await seeded.close();
    }
  });

  /**
   * [#519](https://github.com/DemianLi/nexus-agent/issues/519) 的驗收句：**同一份 seed，只差
   * header 有沒有記那一格**——沒記照舊拒（上面那條），記了就讀得到。兩條合起來才證得出
   * 判準是那一格，不是「線以下」本身。
   */
  it('線以下的事件，header 記著同一個根：讀得到，而且內容是對的那一份', async () => {
    const seeded = await present({ 'a.md': 'one\n' }, ['a.md'], {
      seed: await seedWithDeliverable(),
      resumedRoot: 'same',
    });
    try {
      const page = okOf(await readPage(seeded, { seq: 0 }));
      expect(page.path).toBe('a.md');
      expect(page.text).toBe('one');
      // 讀位元組走同一個前半，所以它也跟著開了。
      okOf(await bytesResult(await readWindow(seeded, { seq: 0 })));
    } finally {
      await seeded.close();
    }
  });

  /**
   * **這一道今天永遠不會響**：`assertSameWorkspaceRoot` 在續接那一刻就擋下了不等的情形，所以
   * 產品路徑上 `resumedWorkspaceRoot` 與 `workspaceRoot` 只要都有值就相等。留著它是為了讓那個
   * 保證**有觀察點**——守衛哪天鬆掉、或 `serve.ts` 的轉交被換成別的值，這裡當場拒，而不是
   * 靜靜去另一個工作區讀同名檔。拿掉這三行，這條測試是唯一會紅的東西。
   */
  it('線以下的事件，header 記的是別的根：拒，而且訊息指名兩個根', async () => {
    const seeded = await present({ 'a.md': 'one\n' }, ['a.md'], {
      seed: await seedWithDeliverable(),
      resumedRoot: 'other',
    });
    try {
      const refused = refusedOf(await readPage(seeded, { seq: 0 }));
      expect(refused.code).toBe('deliverable/no-anchor');
      expect(refused.message).toContain('別的工作區');
      expect(refused.message).toContain(seeded.root);
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
      const refused = refusedOf(await readPage(seeded, { seq: 0 }));
      expect(refused.code).toBe('deliverable/no-anchor');
      expect(refused.message).toContain('--workspace');
    } finally {
      await seeded.close();
    }
  });

  /**
   * **同一條 seeded thread 上，線的兩側**（原本在 `locateDeliverable` 上量的那個 off-by-one，
   * 判準搬到 `locateAt` 之後跟著搬過來）。
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
      okOf(await readPage(seeded));
      expect(refusedOf(await readPage(seeded, { seq: seed.length - 1 })).code).toBe(
        'deliverable/no-anchor',
      );
    } finally {
      await seeded.close();
    }
  });

  it('沒給 --workspace 時兩個方法都錨不住', async () => {
    const outcome = await present({ 'a.md': 'one\n' }, ['a.md'], { workspace: false });
    try {
      expect(refusedOf(await readPage(outcome)).code).toBe('deliverable/no-anchor');
      expect(refusedOf(await bytesResult(await readWindow(outcome))).code).toBe(
        'deliverable/no-anchor',
      );
    } finally {
      await outcome.close();
    }
  });

  it('座標指到的不是交付事件、或沒有那個 index，都是 not-found；座標本身不合格是 invalid_argument', async () => {
    const outcome = await present({ 'a.md': 'one\n' }, ['a.md']);
    try {
      expect(refusedOf(await readPage(outcome, { seq: 0 })).code).toBe('deliverable/not-found');
      expect(refusedOf(await readPage(outcome, { index: 9 })).code).toBe('deliverable/not-found');
      await invalidArgumentOf(outcome, 'deliverable.read', { seq: 'abc', index: 0 });
      await invalidArgumentOf(outcome, 'deliverable.read', { seq: outcome.seq });
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
      const refused = refusedOf(await readPage(outcome));
      expect(refused.code).toBe('deliverable/not-regular-file');
      expect(refused.message).toContain('符號連結');
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

describe('真的 serve 上，錨從組裝點傳到方法', () => {
  /**
   * **這一組不驗讀得到什麼，只驗錨有沒有到。**
   *
   * 上面每一條測試都自己手搭 `createAgent`、直接交 `workspaceRoot`，所以
   * `createCliAgent` 回傳它、`serve.ts` 轉交它那兩行**完全沒有觀察點**——量過：兩行都拔掉，
   * 全樹 1169 條一條都不紅，而真的 serve 上每一顆交付都會被拒。
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
   * 起一台 serve、開一條 thread（拿歷史就會把它建起來），然後呼叫 `deliverable.read`。
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
    const fetchAs = fetchWithCookie(cookie);
    // **拿歷史就把 thread 建起來了**（`handleHistory` → `threadOrError` → `threadFor`），
    // 所以 `ready` 有它——這正是 #452 修訂決議查出來的那件事。
    const page = await createWireClient({ baseUrl: server.url, fetch: fetchAs }).threadHistory(
      'anchored',
    );
    if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
    const read = await createDeliverableClient({ baseUrl: server.url, fetch: fetchAs }).read(
      'anchored',
      { seq: 0, index: 0 },
    );
    if (read.kind !== 'ok') throw new Error(`被載體層擋下：${read.message}`);
    return refusedOf(read.result).message;
  }

  it('給了 --workspace：錨到得了方法，拒絕的理由是座標而不是沒錨', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-deliverable-serve-'));
    roots.push(root);
    expect(await refusalText(['--workspace', root])).toContain('沒有交付宣告');
  });

  it('沒給 --workspace：拒絕的理由就是沒有錨', async () => {
    expect(await refusalText([])).toContain('--workspace');
  });
});

/**
 * `locateDeliverable` 只剩形狀檢查——**錨錨不錨得住是 `locateAt` 的事**，證它的測試
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

/**
 * **位元組窗口**（#544 的 B，照 dsh 的 `readBytes`）。它存在是為了文字頁讀不動的那種檔：一行本身
 * 就超過頁的位元組上限，按行切永遠是 too-large。頁的拒絕不動，讀不動的改用窗口一段一段讀。
 */
describe('位元組窗口', () => {
  const small = (maxBytes: number): DeliverableFilesConfig =>
    deliverableFilesConfigSchema.parse({ maxBytes });

  it('單行超過頁上限的檔：文字頁永遠 too-large，窗口一段一段接得回整份——連切在字中間的中文也是', async () => {
    // 一行 206 個位元組，頁上限 64：按行切一定 too-large。中文三個位元組一個字，窗口邊界一定會切在字中間。
    const line = `${'x'.repeat(200)}中文\n`;
    const outcome = await present({ 'min.json': line }, ['min.json'], { limits: small(64) });
    try {
      expect(refusedOf(await readPage(outcome, { limit: 1 })).code).toBe('deliverable/too-large');

      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      let offset = 0;
      let windows = 0;
      for (;;) {
        const window = await windowOf(outcome, { offset });
        expect(window.offset).toBe(offset);
        expect(window.data.length).toBeLessThanOrEqual(64);
        text += decoder.decode(window.data, { stream: !window.eof });
        windows += 1;
        if (window.eof) break;
        // 不是最後一個窗口就一定是滿的——否則呼叫端分不出「讀完了」與「讀少了」。
        expect(window.data.length).toBe(64);
        offset += window.data.length;
      }
      expect(text).toBe(line);
      expect(windows).toBe(Math.ceil(Buffer.byteLength(line) / 64));
    } finally {
      await outcome.close();
    }
  });

  it('不解碼、不擋二進位：NUL 照給，位元組跟磁碟上一模一樣', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254]);
    const outcome = await present({ 'b.bin': bytes }, ['b.bin']);
    try {
      // 對照組：同一個檔的文字頁是 not-text。
      expect(refusedOf(await readPage(outcome)).code).toBe('deliverable/not-text');
      const window = await windowOf(outcome, { offset: 0, length: 64 });
      expect([...window.data]).toEqual([...bytes]);
      expect(window).toMatchObject({ path: 'b.bin', bytes: 5, offset: 0, eof: true });
    } finally {
      await outcome.close();
    }
  });

  it('沒給 length 只給 offset：長度是頁的位元組上限，同 dsh', async () => {
    const outcome = await present({ 'a.md': 'abcdefghijklmnopqrst' }, ['a.md'], {
      limits: small(8),
    });
    try {
      const window = await windowOf(outcome, { offset: 0 });
      expect(new TextDecoder().decode(window.data)).toBe('abcdefgh');
      expect(window.eof).toBe(false);
      const last = await windowOf(outcome, { offset: 16 });
      expect(new TextDecoder().decode(last.data)).toBe('qrst');
      expect(last.eof).toBe(true);
    } finally {
      await outcome.close();
    }
  });

  it('offset 在檔尾或之後：空的窗口，eof 是真的', async () => {
    const outcome = await present({ 'a.md': 'abc' }, ['a.md']);
    try {
      for (const offset of [3, 1000]) {
        const window = await windowOf(outcome, { offset });
        expect(window.data.length).toBe(0);
        expect(window.eof).toBe(true);
      }
    } finally {
      await outcome.close();
    }
  });

  it('length 超過頁上限是 too-large，不是給到上限為止；正好等於上限的過', async () => {
    const outcome = await present({ 'a.md': 'abc' }, ['a.md'], { limits: small(8) });
    try {
      const refused = refusedOf(await bytesResult(await readWindow(outcome, { length: 9 })));
      expect(refused).toMatchObject({ code: 'deliverable/too-large', maxBytes: 8 });
      expect(refused.message).toContain('超過 8 的上限');
      okOf(await bytesResult(await readWindow(outcome, { length: 8 })));
    } finally {
      await outcome.close();
    }
  });
});

/**
 * **命令通道上的交付檔讀取**（[#747](https://github.com/DemianLi/nexus-agent/issues/747)）：`deliverable.read` 與
 * `deliverable.readBytes`。上面幾組證讀出來的內容對不對；這一組證的是這幾件只有命令通道才有的，
 * 每一件都有一個「錯了也不會有別的測試紅」的方向：
 *
 * 1. **位元組是多段表單裡的位元組**，逐位元組等於檔案內容，含 NUL 與非 UTF-8；外殼裡沒有 base64。
 * 2. **業務上的拒絕是回應結果裡的碼，不是狀態碼**；參數不合格是協定錯誤 `invalid_argument`；`too-large` 帶上限數字。
 * 3. **閘門**：命令通道本來就有瀏覽器會話認證與 `content-type` 閘門，交付方法沒有繞過（401、415 各一條）。
 */
describe('命令通道上的交付檔讀取', () => {
  const small = (maxBytes: number): DeliverableFilesConfig =>
    deliverableFilesConfigSchema.parse({ maxBytes });

  it('一頁文字：翻頁的範圍原樣對得上', async () => {
    const outcome = await present({ 'a.md': 'one\ntwo\nthree\nfour\n' }, ['a.md']);
    try {
      const all = await readPage(outcome);
      expect(all).toMatchObject({ ok: true, value: { text: 'one\ntwo\nthree\nfour', eof: true } });
      const part = await readPage(outcome, { offset: 1, limit: 2 });
      expect(part).toMatchObject({
        ok: true,
        value: { text: 'two\nthree', offset: 1, lines: 2, eof: false },
      });
    } finally {
      await outcome.close();
    }
  });

  it('整檔（不給 offset 與 length）：位元組跟磁碟上一模一樣，含 NUL 與非 UTF-8', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 0x80, 0xc3, 0x28]);
    const outcome = await present({ 'b.bin': bytes }, ['b.bin']);
    try {
      const response = await readWindow(outcome);
      // 成功且帶位元組：多段表單，不是 JSON；位元組是獨立的一段，外殼裡沒有 base64 那一格。
      expect(isBinaryResponse(response)).toBe(true);
      const form = await response.clone().formData();
      expect([...form.keys()].sort()).toEqual(['bytes-0', 'metadata']);
      const metadata = JSON.parse(form.get('metadata') as string) as Record<string, unknown>;
      expect(JSON.stringify(metadata)).not.toContain(Buffer.from(bytes).toString('base64'));

      const value = okOf(await bytesResult(response));
      expect([...value.data]).toEqual([...bytes]);
      expect(value).toMatchObject({ path: 'b.bin', bytes: 8, offset: 0, eof: true });
    } finally {
      await outcome.close();
    }
  });

  it('五種業務拒絕：都是回應結果裡的碼，狀態碼一律 200', async () => {
    const symlinked = await present({ 'real.md': 'secret\n' }, ['link.md'], {
      setup: async (root) => {
        await symlink(join(root, 'real.md'), join(root, 'link.md'));
      },
    });
    const bare = await present({ 'a.md': 'abc' }, ['a.md'], { workspace: false });
    const binary = await present({ 'b.bin': new Uint8Array([0, 1, 2]) }, ['b.bin']);
    const missing = await present({ 'a.md': 'abc' }, ['a.md']);
    const fat = await present(
      { 'big.md': Array.from({ length: 4000 }, () => 'x'.repeat(600)).join('\n') },
      ['big.md'],
    );
    try {
      expect(refusedOf(await readPage(bare)).code).toBe('deliverable/no-anchor');
      expect(refusedOf(await readPage(missing, { index: 99 })).code).toBe('deliverable/not-found');
      expect(refusedOf(await readPage(symlinked)).code).toBe('deliverable/not-regular-file');
      expect(refusedOf(await readPage(binary)).code).toBe('deliverable/not-text');
      expect(refusedOf(await readPage(fat)).code).toBe('deliverable/too-large');
      // 對照組：同一個二進位檔，讀位元組不擋。
      expect((await bytesResult(await readWindow(binary))).ok).toBe(true);
    } finally {
      await Promise.all([symlinked, bare, binary, missing, fat].map((outcome) => outcome.close()));
    }
  });

  it('too-large：頁、窗口、整檔三處都帶被超過的上限', async () => {
    const fat = Array.from({ length: 4000 }, () => 'x'.repeat(600)).join('\n');
    const page = await present({ 'big.md': fat }, ['big.md']);
    const windowed = await present({ 'a.md': 'abc' }, ['a.md'], { limits: small(8) });
    const whole = await present({ 'a.md': 'x'.repeat(20) }, ['a.md'], {
      limits: deliverableFilesConfigSchema.parse({ maxFileBytes: 10 }),
    });
    try {
      expect(await readPage(page)).toMatchObject({
        ok: false,
        error: { code: 'deliverable/too-large', maxBytes: 2 * 1024 * 1024 },
      });
      expect(await bytesResult(await readWindow(windowed, { length: 9 }))).toMatchObject({
        ok: false,
        error: { code: 'deliverable/too-large', maxBytes: 8 },
      });
      expect(await bytesResult(await readWindow(whole))).toMatchObject({
        ok: false,
        error: { code: 'deliverable/too-large', maxBytes: 10 },
      });
      // 對照組：正好等於窗口上限的過。
      expect((await bytesResult(await readWindow(windowed, { length: 8 }))).ok).toBe(true);
    } finally {
      await Promise.all([page, windowed, whole].map((outcome) => outcome.close()));
    }
  });

  it('參數本身不合格是協定錯誤 invalid_argument，不是業務碼', async () => {
    const outcome = await present({ 'a.md': 'abc' }, ['a.md'], { limits: small(8) });
    try {
      const cases: [string, unknown][] = [
        ['deliverable.read', undefined],
        ['deliverable.read', { index: 0 }],
        ['deliverable.read', { seq: -1, index: 0 }],
        ['deliverable.read', { seq: outcome.seq, index: 1.5 }],
        ['deliverable.read', { seq: outcome.seq, index: 0, offset: -1 }],
        [
          'deliverable.read',
          { seq: outcome.seq, index: 0, limit: DEFAULT_DELIVERABLE_MAX_LINES + 1 },
        ],
        ['deliverable.read', { seq: outcome.seq, index: 0, limit: 'abc' }],
        ['deliverable.readBytes', { seq: outcome.seq, index: 0, length: 0 }],
        ['deliverable.readBytes', { seq: outcome.seq, index: 0, offset: -1 }],
        ['deliverable.readBytes', { seq: outcome.seq, index: 0, length: 1.5 }],
        ['deliverable.readBytes', { seq: outcome.seq, index: 0, offset: 'abc' }],
      ];
      for (const [method, params] of cases) {
        await invalidArgumentOf(outcome, method, params);
      }
    } finally {
      await outcome.close();
    }
  });

  it('窗口參數先驗、再找檔：座標沒有檔，length 太大照樣是 too-large', async () => {
    const outcome = await present({ 'a.md': 'abc' }, ['a.md'], { limits: small(8) });
    try {
      // 對照組：同一個不存在的座標、合格的窗口，是 not-found。
      const missing = await bytesResult(await readWindow(outcome, { index: 99 }));
      expect(missing).toMatchObject({ ok: false, error: { code: 'deliverable/not-found' } });
      const tooLarge = await bytesResult(await readWindow(outcome, { index: 99, length: 9 }));
      expect(tooLarge).toMatchObject({ ok: false, error: { code: 'deliverable/too-large' } });
    } finally {
      await outcome.close();
    }
  });

  it('跟其他命令一樣受閘門管：沒有會話 401、沒帶 application/json 415', async () => {
    const outcome = await present({ 'a.md': 'abc' }, ['a.md']);
    try {
      for (const method of ['deliverable.read', 'deliverable.readBytes']) {
        const url = `${BASE_URL}${commandPath(THREAD_ID, method as RpcMethod)}`;
        const body = JSON.stringify({ id: 1, method, params: { seq: outcome.seq, index: 0 } });
        const anonymous = await outcome.handle(
          new Request(url, {
            method: 'POST',
            headers: { host: 'localhost', 'content-type': 'application/json' },
            body,
          }),
        );
        expect({ method, status: anonymous.status }).toEqual({ method, status: 401 });
        const plain = await outcome.post(
          method,
          { seq: outcome.seq, index: 0 },
          {
            headers: { 'content-type': 'text/plain' },
          },
        );
        expect({ method, status: plain.status }).toEqual({ method, status: 415 });
      }
    } finally {
      await outcome.close();
    }
  });

  it('舊的三條專用網址已經不在：GET 打過去是 404', async () => {
    const outcome = await present({ 'a.md': 'abc' }, ['a.md']);
    try {
      for (const name of ['file', 'download', 'bytes']) {
        const response = await outcome.handle(
          loopbackRequest(
            `${BASE_URL}/threads/${THREAD_ID}/deliverables/${name}?seq=${outcome.seq}&index=0`,
            { method: 'GET', headers: { 'content-type': 'application/json' } },
          ),
        );
        expect({ name, status: response.status }).toEqual({ name, status: 404 });
      }
    } finally {
      await outcome.close();
    }
  });

  it('沒開過的 thread：回 no-anchor，不為了回這句建一個 agent', async () => {
    const outcome = await present({ 'a.md': 'abc' }, ['a.md']);
    try {
      const response = await outcome.handle(
        loopbackRequest(
          `${BASE_URL}${commandPath('never-opened', 'deliverable.read' as RpcMethod)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: 1,
              method: 'deliverable.read',
              params: { seq: outcome.seq, index: 0 },
            }),
          },
        ),
      );
      expect(((await response.json()) as { result: DeliverableReadResult }).result).toMatchObject({
        ok: false,
        error: { code: 'deliverable/no-anchor' },
      });
    } finally {
      await outcome.close();
    }
  });

  it('wire 的 client 走一遍：成功、拒絕、位元組都經過同一個編解碼', async () => {
    const outcome = await present({ 'a.md': 'one\ntwo\n' }, ['a.md']);
    try {
      const client = createDeliverableClient({
        baseUrl: BASE_URL,
        fetch: async (input, init) => outcome.handle(loopbackRequest(input as string, init)),
      });
      const page = await client.read(THREAD_ID, { seq: outcome.seq, index: 0 });
      expect(page).toMatchObject({
        kind: 'ok',
        result: { ok: true, value: { text: 'one\ntwo' } },
      });
      const bytes = await client.readBytes(THREAD_ID, { seq: outcome.seq, index: 0 });
      if (bytes.kind !== 'ok' || !bytes.result.ok) throw new Error('位元組讀不到');
      expect(new TextDecoder().decode(bytes.result.value.data)).toBe('one\ntwo\n');
      const refused = await client.read(THREAD_ID, { seq: outcome.seq, index: 99 });
      expect(refused).toMatchObject({
        kind: 'ok',
        result: { ok: false, error: { code: 'deliverable/not-found' } },
      });
      // 參數不合格是「這條線收不了」，不是業務結果。
      const invalid = await client.read(THREAD_ID, { seq: -1, index: 0 });
      expect(invalid.kind).toBe('rejected');
      // 而且帶著碼：網頁靠它分辨「終局的協定錯誤」與「載體層擋下」，不去比對訊息字串。
      expect(invalid).toMatchObject({ code: 'invalid_argument' });
      expect(invalid).not.toHaveProperty('status');
    } finally {
      await outcome.close();
    }
  });
});
