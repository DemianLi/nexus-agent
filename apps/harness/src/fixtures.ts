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
import type { CommandRegistrationPoint, NexusPlugin } from '@nexus/core';
import { createRegistry } from '@nexus/core';
import { StateBackend } from 'deepagents';
import { z } from 'zod';

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
export function createNotePlugin(options: { deny?: boolean } = {}): NexusPlugin {
  return {
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
export function createMountPlugin(routePrefix: string): NexusPlugin {
  return {
    name: 'mount',
    apply: (registry) => void registry.backend.mount(routePrefix, new StateBackend()),
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
export function createToolPlugin(name: string, scope?: string): NexusPlugin {
  return {
    name: `provides-${name}`,
    apply(registry) {
      registry.tools.register(fakeTool(name), scope === undefined ? undefined : { scope });
    },
  };
}
