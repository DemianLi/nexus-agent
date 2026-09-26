/**
 * LLM 標題的**設定條目**（[#650](https://github.com/DemianLi/nexus-agent/issues/650)）。行為見 `../session-title-llm.ts`。
 *
 * 照 dsh `base` bundle 的 `session-title-llm` 那一列（`@deepseek-ai/dsh-session-title-first-prompt-llm`，
 * `packages/bundle/base/cordis.patch.yml:62-69`，`477b4f4`），**五個數字一模一樣**。dsh 的 web-app 與 headless 沿用
 * `base`，所以出廠就開；acp-app、sdk-app 用 `disabled: true` 關掉。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-title` 那一列：值由 `startupSetting` 在起動期讀出來，
 * 往下傳給建模型的那一段。理由與偏離見 `thread-title.ts` 的檔頭。
 *
 * ## 這一列關得掉
 *
 * 跟 `thread-title` 相反。關掉它就真的沒有 LLM 標題（只剩退回標題），同 dsh 關那一列的效果。所以它不在
 * `PROTECTED_ENTRY_NAMES` 上，掛沒掛由 `startupEntryMounted` 判，不是 `startupSetting`——後者把關掉的列讀成預設值。
 *
 * ## 沒有 `provider`／`model` 覆寫
 *
 * dsh 這一列另有一對選配的 `provider`／`model`，讓標題走獨立的路由；不給就沿用主請求的路由。**我們只有一條
 * 連線**（`live-model` 那一列），一律沿用它。這一對是選配、預設不給，沒有它不改變出廠行為；要做的話它跟
 * `thinkingOffBody` 那一格是綁著的（換模型要一起換關推理的寫法），不是單純多兩格。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const THREAD_TITLE_LLM_PLUGIN_NAME = 'thread-title-llm';

/** 逾時的上限：Node 計時器收得住的最大延遲，同 dsh 的 `MAX_TIMER_DELAY_MS`。 */
export const MAX_THREAD_TITLE_LLM_TIMEOUT_MS = 2_147_483_647;

/**
 * 五個數字，照 dsh `session-title-llm` 的 `Config`。dsh 全部必填、沒有預設值；我們的預設值就是 dsh `base` 那一列寫的值，
 * 理由同 `live-model` 那一列：量出來（或抄來）的值當 schema 預設。`strictObject`：多寫一個欄位是打錯字。
 */
export const threadTitleLlmConfigSchema = z.strictObject({
  /** 非 CJK 標題的目標詞數，寫進系統提示。 */
  targetWords: z.number().int().positive().default(5),
  /** 中日韓標題的目標字數，寫進系統提示。 */
  targetCjkCharacters: z.number().int().positive().default(10),
  /** 包成 JSON 之後的整段 user 訊息最多幾個 UTF-8 位元組。超過就不送，不截斷。 */
  maxInputBytes: z.number().int().positive().default(4096),
  /** 標題呼叫的 `max_tokens`。 */
  maxOutputTokens: z.number().int().positive().default(64),
  /** 從送出到收到的整段時限（毫秒）。 */
  timeoutMs: z.number().int().positive().max(MAX_THREAD_TITLE_LLM_TIMEOUT_MS).default(60_000),
});

/** 驗過的設定。 */
export type ThreadTitleLlmConfig = z.infer<typeof threadTitleLlmConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const threadTitleLlmPlugin: NexusPlugin<ThreadTitleLlmConfig> = {
  name: THREAD_TITLE_LLM_PLUGIN_NAME,
  Config: threadTitleLlmConfigSchema,
  apply: (_registry: PluginRegistry, _config: ThreadTitleLlmConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default threadTitleLlmPlugin;
