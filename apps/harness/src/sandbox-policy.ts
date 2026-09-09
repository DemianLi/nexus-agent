/**
 * 把「現在是哪一格圍堵」講給模型聽——dsh `sandbox:policy` 那條系統提示貢獻的對應物。
 *
 * ## 為什麼這一句是承重的，不是裝飾
 *
 * 模式擋得下寫入，但**擋下來之後模型要知道發生了什麼**。不講的話，被擋只會讓它把同一件事
 * 再試一次（或者更糟：它去找一條沒被擋的路）。dsh 把這件事寫成一條每次請求前都貢獻的
 * `sandbox:policy` 段落（`references/deepseek-harness/packages/sandbox/sandbox-policy/src/index.ts:142`）。
 *
 * ## 三件照抄的事
 *
 * 1. **逐次算，不是組裝期算一次。** `text` 在 dsh 那邊是個函式，每次組 prompt 都跑一次。
 *    我們用 `wrapModelCall`，每一次模型呼叫重算——執行期切換那一刀落地時這裡不必動。
 * 2. **`read-only` 那一句明著叫模型「不要先拒絕」。** dsh 的原文是
 *    「Do not refuse a required modification from this policy alone: try an available tool
 *    normally and follow any denial and escalation guidance it returns.」少了這句，模型會
 *    把政策當成「這件事做不到」，於是連試都不試——**那是把一道圍堵變成一個能力謊報**。
 * 3. **`workspace-write` 那一句要指名可寫根。** 「在工作區之內」對模型不是一個位址。
 *
 * ## 這個 plugin 只在真的有圍堵時才掛
 *
 * dsh 的 `ctx.fs.sandboxMode` 在沒掛圍堵 backend 時是 `undefined`，於是升級欄位不宣告、
 * 政策段落也不貢獻。我們這側對應的事實是 `--workspace`：沒給就沒有
 * `ContainedFilesystemBackend`，檔案跑在基座的 `StateBackend` 裡，**一格圍堵都沒有**。
 * 那種組裝底下講「目前的檔案政策：workspace-write」是**對模型說謊**——它會以為根外被擋著，
 * 而其實整道 fence 不在路徑上。所以掛不掛這個 plugin 由組裝點判，不是由這個檔案判。
 *
 * ## 為什麼是 `wrapModelCall` 而不是 `beforeModel`
 *
 * 照 `@nexus/plugin-plan-mode` 的先例：`beforeModel` 是圖裡的一個節點，每輪多一格；
 * 而這裡要做的只是把一段話接到 system prompt 後面。**用 `concat` 不用取代**——記憶 plugin
 * 與基座的摘要器都在同一份 prompt 上加東西，取代會把它們吃掉。
 *
 * @module
 */

import type { NexusPlugin } from '@nexus/core';
import { createMiddleware } from 'langchain';
import type { ContainmentMode, ContainmentModeSource } from './contained-backend.js';

/** 這個 middleware 的名字。排序斷言與錯誤訊息用得到。 */
export const SANDBOX_POLICY_MIDDLEWARE_NAME = 'nexusSandboxPolicy';

/**
 * 一格模式對模型講的那一段話。
 *
 * @param mode - 這一刻的圍堵強度。
 * @param rootDir - 可寫根的絕對路徑；`workspace-write` 那一句要指名它。
 * @returns 接到 system prompt 後面的那段話。
 */
export function sandboxPolicySentence(mode: ContainmentMode, rootDir: string): string {
  switch (mode) {
    case 'read-only':
      return (
        '目前的檔案政策：read-only。這個組裝的檔案工具改不動任何檔案。' +
        '**不要只憑這一條就拒絕使用者要的修改**：照常去呼叫工具，被擋下來時讀它回的那句拒絕再決定下一步。'
      );
    case 'workspace-write':
      return (
        `目前的檔案政策：workspace-write。檔案工具只改得動 ${JSON.stringify(rootDir)} 之下的東西；` +
        '那個範圍之內的變更直接放行，不會另外問人。範圍之外的會被擋下來。'
      );
    case 'danger-full-access':
      return '目前的檔案政策：danger-full-access。這道圍堵不限制檔案變更。';
  }
}

/**
 * 造那個把政策講給模型聽的 plugin。
 *
 * **只在掛了 `ContainedFilesystemBackend` 的組裝上掛它**，理由見模組註解。
 *
 * @param resolveMode - 這一刻的圍堵強度。**傳來源不傳值**：跟 backend 讀的是同一顆，
 *   兩邊各存一份快照的話，切換那天畫面上講的與實際擋的會是兩格。
 * @param rootDir - 可寫根的絕對路徑。
 * @returns 可以放進組裝點清單的 plugin。
 */
export function createSandboxPolicyPlugin(
  resolveMode: ContainmentModeSource,
  rootDir: string,
): NexusPlugin {
  return {
    name: 'sandbox-policy',
    apply(registry) {
      registry.middleware.use(
        createMiddleware({
          name: SANDBOX_POLICY_MIDDLEWARE_NAME,
          wrapModelCall: (request, handler) => {
            const sentence = sandboxPolicySentence(resolveMode(), rootDir);
            // 兩條路是同一件事的兩個入口，照抄 plan-mode 那段註解：`systemMessage` 在的
            // 時候接在它後面，不在的時候由 `systemPrompt` 這個字串欄位承接。基座兩個都讀，
            // 給錯那一個等於沒講。
            const { systemMessage } = request;
            return handler(
              systemMessage === undefined
                ? { ...request, systemPrompt: sentence }
                : { ...request, systemMessage: systemMessage.concat(`\n${sentence}`) },
            );
          },
        }),
      );
    },
  };
}
