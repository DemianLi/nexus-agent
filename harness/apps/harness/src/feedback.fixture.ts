/**
 * feedback 的**舊外殼**：`NexusPlugin` 形狀，給還在相容層底下的測試用（[#1456](https://github.com/DemianLi/nexus-agent/issues/1456)）。
 *
 * feedback 本身已經是樹上的函式插件（`packages/nexus-plugin-feedback`，沒有一行 `@nexus/core`）。手搭 `PluginEntry` 清單、直接
 * `createNexusAgent` 的測試要一顆「提供評分服務、登記 `/feedback`」的 `NexusPlugin`，就走這個外殼——**規則、設定的形狀、命令的
 * 名字與用法說明都取自同一份**（`createFeedbackService`、`feedbackConfigSchema`），所以行為只有一個出處。同 `skills.fixture.ts`、
 * `echo.fixture.ts` 的前例。
 *
 * **不能出現在任何產品路徑上**：`resolveEntryModule`、出貨清單（`cordis.yml`）、`fixtures.ts` 的 `shippedPlugins` 都不引用它。
 * 想驗「feedback 經樹進來」的測試用 `shippedPlugins()`（出貨清單上的那一列是橋接列），不要用這個。
 *
 * @module
 */

import { MESSAGE_FEEDBACK_SERVICE } from '@nexus/core';
import type { NexusPlugin, PluginEntry } from '@nexus/core';
import {
  createFeedbackService,
  FEEDBACK_COMMAND_NAME,
  FEEDBACK_USAGE,
  feedbackConfigSchema,
} from '@nexus/plugin-feedback';
import type { FeedbackConfig, FeedbackPluginOptions } from '@nexus/plugin-feedback';
import type { SessionDurabilityService } from '@nexus/session';

/**
 * 一份**直接放行**的落盤確認：不排空、不讀回。給只驗評分規則與 wire 形狀、不驗落盤的測試用；落盤本身的驗收（#1606 A–E）走真的
 * store 與樹上那一列，不用這個。
 */
export const MEMORY_DURABILITY: SessionDurabilityService = {
  checkpoint: () => Promise.resolve(),
};

/**
 * feedback 的 `NexusPlugin` 外殼：提供 `messageFeedback` 服務、登記 `/feedback`。
 *
 * @param durability - 評分那三個方法每次呼叫取的落盤確認；省略就是這個組裝沒掛落盤（評分回 `not_supported`，評語照常），同樹上那一列
 *   沒有 `session-durability` 時。
 */
export function feedbackPluginWith(
  durability?: SessionDurabilityService,
): NexusPlugin<FeedbackConfig> {
  return {
    name: 'feedback',
    Config: feedbackConfigSchema,
    apply(registry, config: FeedbackConfig) {
      // 服務建在 `apply` 裡，不在模組層級：設定是這一次掛載的（兩列各掛一次各算各的上限）。
      const service = createFeedbackService(config, () => durability);
      registry.services.provide(MESSAGE_FEEDBACK_SERVICE, service);
      registry.commands.register({
        name: FEEDBACK_COMMAND_NAME,
        description: '記下對這個會話的回饋',
        input: { hint: '<內容>' },
        recordInput: false,
        handler: async ({ rawInput, sessionLog }) => {
          if (rawInput.trim().length === 0) return { kind: 'error', text: FEEDBACK_USAGE };
          await service.record(sessionLog, { text: rawInput });
          return { kind: 'success', text: `已記下對這個會話的回饋（${sessionLog.sessionId}）。` };
        },
      });
    },
  };
}

/** 不碰磁碟的那一顆：評分規則照常、落盤確認直接放行（{@link MEMORY_DURABILITY}）。 */
export const feedbackPlugin: NexusPlugin<FeedbackConfig> = feedbackPluginWith(MEMORY_DURABILITY);

/**
 * 建一個 feedback 條目，可以放進組裝點清單。
 *
 * @param options - 設定。
 * @param durability - 見 {@link feedbackPluginWith}；省略即 {@link MEMORY_DURABILITY}。
 */
export function createFeedbackPlugin(
  options: FeedbackPluginOptions,
  durability: SessionDurabilityService | null = MEMORY_DURABILITY,
): PluginEntry {
  return {
    plugin:
      durability === MEMORY_DURABILITY
        ? feedbackPlugin
        : feedbackPluginWith(durability ?? undefined),
    config: options,
  };
}
