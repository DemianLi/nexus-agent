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
 * ## 標題走另一顆模型：`modelId`（[#657](https://github.com/DemianLi/nexus-agent/issues/657)）
 *
 * dsh 這一列另有一對選配、必須成對的 `provider`／`model`（`packages/session/session-title-llm/src/index.ts:71-74`，
 * 給一半就在載入期拋，同檔 `:136-139`）：不給就沿用主請求記下的路由，給了就走獨立路由（例如一顆便宜、沒有推理的模型）。
 *
 * **我們是選配的 `modelId`，從 `live-model` 的型錄挑一筆**（#729）：關推理的寫法、窗口等跟著那一筆走，「只換模型 id 不換
 * 關推理的寫法，標題會在新模型上靜靜失敗」那個坑由型錄收掉。不給就沿用 `live-model` 的預設模型，出廠行為不變。
 * 標題的輸出上限照舊是這一列的 `maxOutputTokens`，不從條目來（dsh 也是用標題自己的上限，同檔 `:266`）。
 *
 * **與 dsh 的差異：沒有 `provider`。** 我們一個組裝只有一條連線（`live-model` 那一列的端點與那一把 key），挑同一個端點上的
 * 模型就是同一把 key，所以沒有「成對」這回事；「給一半就拋」對應成「給的 id 不在型錄裡就拋」（`cli.ts` 的
 * `titleLlmFor`，組裝時、serve 是啟動時的那次試組，訊息指名這一列與那個 id）。哪天有第二條連線（#730 的按名字取 key），
 * 再加 `provider` 並補上成對驗證。
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
  /**
   * 標題改走 `live-model` 型錄裡的另一顆模型，見檔頭。省略就沿用 `live-model` 的預設模型。
   * 換模型之前照 #650 的量法量一次（`maxOutputTokens` 64 下，關推理與不關推理各跑 6 次）。
   */
  modelId: z.string().min(1).optional(),
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
