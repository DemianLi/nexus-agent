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
import type { NexusPlugin, PluginRegistry } from '@nexus/core';
import { z } from 'zod';

/** 這個 plugin 宣告的能力名。要相依它的 plugin 把這個字串放進自己的 `requires`。 */
export const ECHO_CAPABILITY = 'echo';

/** 註冊出來的工具名。組裝點要把它排進 `toolOrder` 時用得到。 */
export const ECHO_TOOL_NAME = 'echo';

export interface EchoPluginOptions {
  /**
   * 回聲前面加的前綴。同一個工廠掛載多次是合法的（`name` 不唯一），但兩次都註冊
   * `echo` 這個工具名會在 registry 那一層撞名——真要掛兩份，其中一個得改註冊到某個
   * subagent 層。
   */
  readonly prefix?: string;
}

/**
 * 建一個 echo plugin。
 *
 * @param options - 回聲的前綴。
 * @returns 可以放進組裝點清單的 plugin。
 */
export function createEchoPlugin(options: EchoPluginOptions = {}): NexusPlugin {
  const prefix = options.prefix ?? '回聲';

  return {
    name: 'echo',
    apply(registry: PluginRegistry): void {
      registry.capabilities.provide(ECHO_CAPABILITY);
      registry.tools.register(
        tool(({ message }) => `${prefix}：${message}`, {
          name: ECHO_TOOL_NAME,
          description: '把收到的訊息原樣回聲，用來確認工具接線是通的。',
          schema: z.object({
            message: z.string().describe('要回聲的訊息'),
          }),
        }),
      );
    },
  };
}
