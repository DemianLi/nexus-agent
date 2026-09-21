/**
 * 組裝點測試用的假 plugin。只給本套件的測試用，不從 `index.ts` 對外匯出。
 *
 * 正面路徑要兩個 plugin：一個是 `packages/nexus-plugin-echo`（真的 workspace package，
 * 零 harness import——那是「契約沒有偷偷要求你伸手進組裝點內部」的證據），另一個就是
 * 這裡的 fixture。兩邊都要呼叫得到，才算證明了「一份清單 fold 出來的 agent 真的把各
 * plugin 的工具都接上了」。
 */

import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import type { CommandRegistrationPoint, PluginEntry } from '@nexus/core';
import type { PendingApproval, PendingInput, WireClient } from '@nexus/wire';
import { createWireClient, isApprovalPending } from '@nexus/wire';
import { createRegistry } from '@nexus/core';
import { StateBackend } from 'deepagents';
import { z } from 'zod';
import { BrowserAuth } from './browser-auth.js';
import { loadPluginConfig } from './plugin-config.js';

/**
 * 出貨那份清單，載一次就快取。
 *
 * **測試要的是產品真的組出來的那一份**，所以這裡讀的是 `apps/harness/cordis.yml`，不是
 * 另一份寫死在測試裡的清單——[#490](https://github.com/DemianLi/nexus-agent/issues/490) 的
 * 教訓：一份「跟產品一樣」的副本守的是副本相等，不是產品是對的。
 *
 * **只讀出貨那一層，不疊使用者的 patch**：測試要的是「出廠是什麼樣」，而不是跑測試的這台
 * 機器上那個人的偏好。`loadPluginConfig` 不給 `userPatch` 就不讀 home——這比傳一個暫存目錄
 * 更直接，因為連「有沒有讀到」這件事都不必假設。
 *
 * **快取是安全的**：[#453](https://github.com/DemianLi/nexus-agent/issues/453) 之後每個 plugin
 * 都是模組層級的常數（設定是條目上的資料，不在閉包裡），所以兩次組裝共用同一顆 plugin 物件
 * 跟以前共用 `DEFAULT_PLUGINS` 那份模組常數（#454 之前）是同一回事。
 *
 * @returns 出貨清單，跟產品路徑上零設定時組出來的那一份相同。
 */
let shipped: Promise<readonly PluginEntry[]> | undefined;
export function shippedPlugins(): Promise<readonly PluginEntry[]> {
  shipped ??= loadPluginConfig();
  return shipped;
}

/**
 * 一個真的、但沒有人註冊過任何命令的命令註冊點。
 *
 * `ThreadAgent.commands` 是必填的（理由見它自己的說明），所以只驗線的測試也得給一個。
 * **給真的註冊點而不是 `undefined as never`**：後者型別上騙得過去，但那樣 `slash.list`
 * 走到的就不是真的程式碼了——同 `invariant-companions.test.ts` 給真日誌的理由。
 *
 * @returns 一個空的註冊點，只露出這條線用得到的兩支。
 */
export function emptyCommandPoint(): Pick<CommandRegistrationPoint, 'find' | 'list'> {
  return createRegistry().commands;
}

/**
 * 測試用的瀏覽器會話密鑰與認證（#424）。
 *
 * **換的是密鑰，不是那道檢查**：`createWireHandler` 的 `auth` 是必填的，測試把這一個交進去，
 * 請求再帶一顆用同一把密鑰換來的 cookie。產品路徑上的密鑰來自 harness home 的檔（`serve.ts`）。
 */
export const TEST_BROWSER_SESSION_SECRET = Buffer.alloc(32, 7);
export const TEST_BROWSER_AUTH = new BrowserAuth(TEST_BROWSER_SESSION_SECRET);

/**
 * 用 {@link TEST_BROWSER_AUTH} 走一次真的 token 交換，換一顆給某個 authority 的 cookie。
 *
 * **每次呼叫當下才換**：cookie 的簽發時間取當下的 `Date.now()`，用假時鐘的測試因此不會拿到一顆
 * 「未來才簽發」或「已經過期」的 cookie。
 *
 * @param authority - 請求的 `Host`（cookie 的名字與簽章都綁它）。
 * @returns `名字=值`，可以直接放進 `cookie` 標頭。
 */
export function testSessionCookie(authority = 'localhost'): string {
  const response = TEST_BROWSER_AUTH.authorizeIndex(
    new Request(TEST_BROWSER_AUTH.authenticatedUrl(`http://${authority}`), {
      headers: { host: authority },
    }),
  );
  const setCookie = response?.headers.get('set-cookie');
  if (response?.status !== 303 || setCookie === null || setCookie === undefined) {
    throw new Error('測試的 token 交換沒有換到 cookie');
  }
  return setCookie.split(';', 1)[0]!;
}

/**
 * 把 handler 當 fetch 用時的請求：補上一個 loopback 的 `Host` 與一顆有效的會話 cookie。
 *
 * handler 在任何路徑判斷之前先過瀏覽器信任圍欄（`request-trust.ts`，#387），再驗會話（#424）；而
 * `new Request(url)` 不會替你帶 `Host`——真的 HTTP/1.1 請求一定有，所以圍欄缺 Host 就拒、不退回去讀 URL。
 * 測試的 base URL（`http://wire.test` 之類）跟 Host 無關，保留原樣。呼叫端自己帶了 `cookie` 就不蓋。
 *
 * @param input - 請求 URL。
 * @param init - 其餘照 `fetch` 傳進來的原樣。
 * @returns 帶著 `host: localhost` 與 {@link TEST_BROWSER_AUTH} 認得的 cookie 的請求。
 */
export function loopbackRequest(input: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set('host', 'localhost');
  if (!headers.has('cookie')) headers.set('cookie', testSessionCookie('localhost'));
  return new Request(input, { ...init, headers });
}

/**
 * 對一台真的 `runServe` 走產品路徑上的 token 交換，拿到會話 cookie。
 *
 * @param authenticatedUrl - `RunningServe.authenticatedUrl`（啟動時印出的那一個）。
 * @returns `名字=值`。
 */
export async function exchangeServeToken(authenticatedUrl: string): Promise<string> {
  const response = await fetch(authenticatedUrl, { redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 303 || setCookie === null) {
    throw new Error(`token 交換失敗：${response.status}`);
  }
  return setCookie.split(';', 1)[0]!;
}

/**
 * 每個請求都帶同一顆 cookie 的 `fetch`。
 *
 * @param cookie - `名字=值`。
 * @returns 可以交給 `createWireClient` 的 `fetch`。
 */
export function fetchWithCookie(cookie: string): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookie);
    return fetch(input, { ...init, headers });
  };
}

/**
 * 一台真的 serve 的 wire client：先走產品路徑上的 token 交換，之後每個請求都帶那顆 cookie（#424）。
 *
 * cookie 綁的是那台 server 的 authority（含 port），所以重開在別的 port 上要重新換一顆——
 * 對新的那台再叫一次這個函式就是。
 *
 * @param running - `runServe` 回的那台。
 * @returns 帶著會話的 client。
 */
export async function serveClient(running: {
  readonly url: string;
  readonly authenticatedUrl: string;
}): Promise<WireClient> {
  const cookie = await exchangeServeToken(running.authenticatedUrl);
  return createWireClient({ baseUrl: running.url, fetch: fetchWithCookie(cookie) });
}

/** fixture plugin 註冊的工具名。 */
export const NOTE_TOOL_NAME = 'take_note';

/**
 * 一個記筆記的假 plugin。
 *
 * 它同時示範了 plugin 端的三個註冊點：宣告能力、註冊工具、擋掉一組路徑。**那條 deny
 * 是刻意放的**——`permissions` 是 fold 的輸出裡唯一會被基座再驗一次的東西
 * （`createFilesystemMiddleware()` 只要看到規則就跑 `validatePermissionPaths()`：
 * 非絕對路徑、含 `..`、含 `~` 一律拋錯），而那道檢查 `fold.test.ts` 碰不到。正面路徑
 * 帶著一條真的 deny 走完，兩個驗證器才會在這裡碰一次面。
 *
 * @param options - `deny` 給 `false` 可以拿掉那條規則。
 * @returns 可載入的 plugin。
 */
export function createNotePlugin(options: { deny?: boolean } = {}): PluginEntry {
  return {
    plugin: {
      name: 'note',
      apply(registry) {
        registry.capabilities.provide('note');
        registry.tools.register(
          tool(({ text }) => `已記下：${text}`, {
            name: NOTE_TOOL_NAME,
            description: '把一段文字記下來。',
            schema: z.object({ text: z.string().describe('要記下的內容') }),
          }),
        );
        if (options.deny !== false) {
          registry.permissions.deny(['/secrets/**'], { except: ['/secrets/public/**'] });
        }
      },
    },
  };
}

/**
 * 一個只把 backend 掛到某個路徑前綴上的假 plugin。
 *
 * 用來證明**組裝點真的有給 default backend**：fold 對「有人掛了路由卻沒有兜底的那個」
 * 是報錯的，所以這個 plugin 載得起來本身就是那件事的證據。
 *
 * @param routePrefix - 掛載點，要以 `/` 開頭且結尾。
 * @returns 可載入的 plugin。
 */
export function createMountPlugin(routePrefix: string): PluginEntry {
  return {
    plugin: {
      name: 'mount',
      apply: (registry) => void registry.backend.mount(routePrefix, new StateBackend()),
    },
  };
}

/**
 * 一個什麼都不做、只有名字有意義的工具。
 * @param name - 工具名。
 * @returns 可註冊的工具。
 */
export function fakeTool(name: string): StructuredTool {
  return tool(() => `${name} 跑過了`, {
    name,
    description: `測試用的 ${name}`,
    schema: z.object({}),
  });
}

/**
 * 一個只註冊指定工具名的假 plugin，用來製造撞名。
 * @param name - 要註冊的工具名。
 * @param scope - 註冊到哪一層，省略即全域。
 * @returns 可載入的 plugin。
 */
export function createToolPlugin(name: string, scope?: string): PluginEntry {
  return {
    plugin: {
      name: `provides-${name}`,
      apply(registry) {
        registry.tools.register(fakeTool(name), scope === undefined ? undefined : { scope });
      },
    },
  };
}

/**
 * 從 `pendings` 取第 n 顆，並斷言它是**核准**請求。
 *
 * `pendings` 現在裝得下兩種中斷（[#231](https://github.com/DemianLi/nexus-agent/issues/231)），
 * 而以前那種 `pendings[0]?.actions` 的寫法在型別上已經不成立。**窄化寫成會拋的斷言而不是
 * `?.`**：「拿到的是問答那一顆」與「一顆都沒有」在 `?.` 之下都是 `undefined`，
 * 而那會讓一條測錯東西的測試綠著。
 */
export function approvalAt(pendings: readonly PendingInput[], index = 0): PendingApproval {
  const pending = pendings[index];
  if (pending === undefined || !isApprovalPending(pending)) {
    throw new Error(`pendings[${index}] 不是核准請求：${JSON.stringify(pending)}`);
  }
  return pending;
}

/** `pendings` 裡每一顆核准請求的工具名，攤平。 */
export function approvalToolNames(pendings: readonly PendingInput[]): string[] {
  return pendings.flatMap((pending) =>
    isApprovalPending(pending) ? pending.actions.map((action) => action.name) : [],
  );
}
