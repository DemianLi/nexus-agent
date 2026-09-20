/**
 * `@nexus/plugin-echo`——第一個真的住在 `packages/` 裡的 plugin。
 *
 * 它的功能刻意薄到沒有意義：一個把輸入原樣回聲的工具。**它的價值不在功能，在相依
 * 關係**（[#30](https://github.com/DemianLi/nexus-agent/issues/30)）——這個套件只
 * 相依 `@nexus/core`、`@langchain/core` 與 `zod`，**沒有一行 import `@nexus/harness`**，
 * 所以它是「NexusPlugin 契約沒有偷偷要求你伸手進組裝點內部」的唯一證據。
 *
 * 那條保護不寫成測試——要驗它得從測試裡跑 `tsc` 子行程。保護的來源是 pnpm 的相依
 * 隔離加 typecheck gate：這個 package 的 `package.json` 沒宣告 `@nexus/harness`，
 * 真的寫了那行 import，`tsc` 會以 `TS2307` 當場擋下。
 */

import { tool } from '@langchain/core/tools';
import type { NexusPlugin, PluginEntry, PluginRegistry } from '@nexus/core';
import { z } from 'zod';

/** 這個 plugin 宣告的能力名。要相依它的 plugin 把這個字串放進自己的 `requires`。 */
export const ECHO_CAPABILITY = 'echo';

/** 註冊出來的工具名。組裝點要把它排進 `toolOrder` 時用得到。 */
export const ECHO_TOOL_NAME = 'echo';

/** 前綴的預設值。 */
export const DEFAULT_ECHO_PREFIX = '回聲';

/**
 * 這個 plugin 的設定。
 *
 * `strictObject` 不是隨手選的：未知欄位讓載入失敗是登記過的偏離，理由見
 * `@nexus/core` 的 `plugin.ts` 檔頭。預設值寫在 schema 裡，不寫在 `apply` 裡。
 */
export const echoConfigSchema = z.strictObject({
  /**
   * 回聲前面加的前綴。同一顆 plugin 掛載多次是合法的（`name` 不唯一），但兩次都註冊
   * `echo` 這個工具名會在 registry 那一層撞名——真要掛兩份，其中一個得改註冊到某個
   * subagent 層。
   */
  prefix: z.string().default(DEFAULT_ECHO_PREFIX),
});

/** 驗過的設定。 */
export type EchoConfig = z.infer<typeof echoConfigSchema>;

/** 工廠收的東西：schema 的**輸入面**，所以每一格都可以省略。 */
export type EchoPluginOptions = z.input<typeof echoConfigSchema>;

/**
 * echo plugin。
 *
 * **模組層級的一顆常數**，給 [#454](https://github.com/DemianLi/nexus-agent/issues/454)
 * 從設定檔 import。每次掛載才有的狀態一律活在 `apply` 裡——這裡一格都沒有。
 */
export const echoPlugin: NexusPlugin<EchoConfig> = {
  name: 'echo',
  Config: echoConfigSchema,
  apply(registry: PluginRegistry, config: EchoConfig): void {
    registry.capabilities.provide(ECHO_CAPABILITY);
    registry.tools.register(
      tool(({ message }) => `${config.prefix}：${message}`, {
        name: ECHO_TOOL_NAME,
        description: '把收到的訊息原樣回聲，用來確認工具接線是通的。',
        schema: z.object({
          message: z.string().describe('要回聲的訊息'),
        }),
      }),
    );
  },
};

export default echoPlugin;

/**
 * 建一個 echo 條目。
 *
 * **薄薄一層**：設定不在這裡驗，驗在載入的時候——那時候才有 id 可以指名
 * （`<id> (<name>)`）。
 *
 * @param options - 回聲的前綴。
 * @returns 可以放進組裝點清單的條目。
 */
export function createEchoPlugin(options: EchoPluginOptions = {}): PluginEntry {
  return { plugin: echoPlugin, config: options };
}
