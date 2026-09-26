/**
 * 會話標題兩個上限的**設定條目**（[#457](https://github.com/DemianLi/nexus-agent/issues/457)／
 * [#529](https://github.com/DemianLi/nexus-agent/issues/529)）。規則見 `../session-title.ts`。
 *
 * **這一顆不裝功能，只講設定**——同 `@nexus/core/tool-result-pruner` 那一列（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。
 * 差別在消費者跑的時刻：剪刀的消費者是 `foldRegistry`，拿得到註冊表；**這兩個數字的第一個消費者是
 * `serve.ts` 的冷讀清單**（`listStoredThreads`），它一條 thread 都不啟動，所以那一刻沒有 agent、
 * 沒有註冊表、也沒有 `ThreadAgent`。值因此由 {@link ../settings/startup.ts | startupSetting} 在起動期
 * 從已解析的條目讀出來，`apply` 是空的。
 *
 * 另外三個消費者（[#647](https://github.com/DemianLi/nexus-agent/issues/647)）跑在 agent 出生之後：web 的 pump 與
 * CLI 的 `runTurn` 寫退回標題，歷史路由替舊日誌推標題。**它們吃的是同一份起動期的值**，不另外從註冊表讀：同一個
 * 數字有兩條來路的話，列表推的與日誌寫的就可能不一樣。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **擁有者是 package-internal specifier（`#settings/thread-title`），不是套件名。** dsh 的每個
 *    可調值都由一個**套件**擁有——這兩個數字在 dsh 是 `- id: session-title` /
 *    `@deepseek-ai/dsh-session-title` 那一列的 `fallbackMaxWords`、`fallbackMaxBytes`
 *    （`packages/bundle/base/cordis.patch.yml:55-60`，`ddefc45`，**數字一模一樣**）。
 *    我們表達不出來的是：**`apps/harness` 解不到自己**——條目走 `plugin-config.ts` 的
 *    `import(entry.name)`，而 `@nexus/harness` 沒有連進自己的 `node_modules`（實測
 *    `Cannot find package '@nexus/harness'`）。退到 Node 的 `imports` 欄位，映射寫在
 *    `package.json` 裡看得見；為幾個設定值開套件是另一個方向，代價更大。
 * 2. **`apply` 是空的，也不註冊服務。** 照 dsh 的 `fs-observation-policy`（「it registers no
 *    service」）那條先例：組裝期沒有消費者，發一顆服務只會讓人以為有人在讀。
 *
 * ## 這一列關不掉
 *
 * `disabled: true` 在載入期當場拋（`plugin-config.ts` 的 `PROTECTED_ENTRY_NAMES`）。**理由不是
 * 它很重要，是「關掉」對它沒有意義**：這一列不裝任何東西，關掉它不會讓標題不再被裁切，只會讓
 * 部署以為自己關掉了什麼。同一份名單上 `approval-gate` 的理由逐字是「讀起來像成功關掉了」。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const THREAD_TITLE_PLUGIN_NAME = 'thread-title';

/**
 * 標題最多幾個詞。照 dsh `session-title` 的 `fallbackMaxWords`。
 *
 * **中文咬不到這一格**：中文沒有空白，所以實務上擋住的是 {@link DEFAULT_THREAD_TITLE_MAX_BYTES}。
 */
export const DEFAULT_THREAD_TITLE_MAX_WORDS = 5;

/** 標題最多幾個 UTF-8 位元組。照 dsh 的 `fallbackMaxBytes`；40 個位元組是 13 個中文字。 */
export const DEFAULT_THREAD_TITLE_MAX_BYTES = 40;

/**
 * 任何來源的標題最多幾個 UTF-8 位元組（[#650](https://github.com/DemianLi/nexus-agent/issues/650)）。照 dsh `session-title` 的
 * `maxTitleBytes`：模型產生的標題照它正規化；退回標題的 {@link DEFAULT_THREAD_TITLE_MAX_BYTES} 不得超過它。
 */
export const DEFAULT_THREAD_TITLE_MAX_TITLE_BYTES = 80;

/** 三個上限。`strictObject`：多寫一個欄位是打錯字，不是擴充點。 */
export const threadTitleConfigSchema = z
  .strictObject({
    /** 見 {@link DEFAULT_THREAD_TITLE_MAX_WORDS}。 */
    maxWords: z.number().int().positive().default(DEFAULT_THREAD_TITLE_MAX_WORDS),
    /** 見 {@link DEFAULT_THREAD_TITLE_MAX_BYTES}。 */
    maxBytes: z.number().int().positive().default(DEFAULT_THREAD_TITLE_MAX_BYTES),
    /** 見 {@link DEFAULT_THREAD_TITLE_MAX_TITLE_BYTES}。 */
    maxTitleBytes: z.number().int().positive().default(DEFAULT_THREAD_TITLE_MAX_TITLE_BYTES),
  })
  // 照 dsh：`fallbackMaxBytes` 不得超過 `maxTitleBytes`。
  .refine((config) => config.maxBytes <= config.maxTitleBytes, {
    message: 'maxBytes 不能大於 maxTitleBytes',
    path: ['maxBytes'],
  });

/** 驗過的設定。 */
export type ThreadTitleConfig = z.infer<typeof threadTitleConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const threadTitlePlugin: NexusPlugin<ThreadTitleConfig> = {
  name: THREAD_TITLE_PLUGIN_NAME,
  Config: threadTitleConfigSchema,
  apply: (_registry: PluginRegistry, _config: ThreadTitleConfig): void => {
    // 空的，見檔頭偏離 2：組裝期沒有消費者。
  },
};

export default threadTitlePlugin;
