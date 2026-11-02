/**
 * `@nexus/plugin-echo`——第一顆搬上 Cordis 樹的插件（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416) PR 2）。
 *
 * 它的功能刻意薄到沒有意義：一個把輸入原樣回聲的工具。**它的價值不在功能，在相依關係**
 * （[#30](https://github.com/DemianLi/nexus-agent/issues/30)）：這個套件只相依 `@nexus/sdk`（規範）、`@nexus/tools`
 * （服務定義）、`@nexus/cordis`（型別）、`@langchain/core` 與 `zod`，**沒有一行 import `@nexus/core` 或
 * `@nexus/harness`**——外部插件只該看見 SDK 與服務定義（決議 §3-4 第 17 條）。
 *
 * ## 形狀
 *
 * 函式插件，具名匯出 `name`／`inject`／`Config`／`manifest`／`apply`，**沒有 default**：Loader 的 `unwrapExports`
 * 有 default 就取 default，具名的 `inject`／`Config` 會被丟掉（一致性套件的 `export-form` 格擋這個）。
 *
 * - 要的服務經 `inject` 宣告（`tools`，`^1.0.0`），在 `apply` 裡經 token 取；沒宣告就讀，Cordis 當場拋。
 * - 註冊工具是 effect：這一列卸載時登記處自己撤掉，不靠誰記得呼叫 disposer。
 * - 工具本體是純函式 {@link createEchoTool}，只閉包 `prefix`、不碰 `ctx`：樹上這一列卸了之後，開著的對話手上的舊工具
 *   物件照樣能跑（決議 §3-2 第 6 條，插件更新只給新對話）。
 *
 * 舊的 `NexusPlugin` 外殼（`createEchoPlugin`、`echoPlugin`）不在這裡：它是測試夾具，住在 `apps/harness` 的
 * `echo.fixture.ts`，包同一個 {@link createEchoTool}，讓工具定義只有一個出處。
 *
 * @module
 */

import { tool } from '@langchain/core/tools';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { Context } from '@nexus/cordis';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { toolsToken } from '@nexus/tools';
import { z } from 'zod';

/** 註冊出來的工具名。組裝點要把它排進 `toolOrder` 時用得到。 */
export const ECHO_TOOL_NAME = 'echo';

/** 前綴的預設值。 */
export const DEFAULT_ECHO_PREFIX = '回聲';

/**
 * 這個插件的設定。
 *
 * `strictObject` 不是隨手選的：未知欄位讓載入失敗是登記過的偏離，理由見 `@nexus/core` 的 `plugin.ts` 檔頭；
 * manifest 的 `config` 也必須是 `strictObject`。預設值寫在 schema 裡，不寫在 `apply` 裡。
 */
export const echoConfigSchema = z.strictObject({
  /**
   * 回聲前面加的前綴。同一顆插件掛載多次是合法的（列 id 不同），但兩次都註冊 `echo` 這個工具名會在登記處撞名。
   */
  prefix: z.string().default(DEFAULT_ECHO_PREFIX),
});

/** 驗過的設定。 */
export type EchoConfig = z.infer<typeof echoConfigSchema>;

/** 工廠收的東西：schema 的**輸入面**，所以每一格都可以省略。 */
export type EchoPluginOptions = z.input<typeof echoConfigSchema>;

const echoToolSchema = z.object({
  message: z.string().describe('要回聲的訊息'),
});

/**
 * 造那個回聲工具。純函式：只閉包 `prefix`。
 *
 * @param prefix - 回聲前面加的前綴。
 * @returns 工具實例。
 */
export function createEchoTool(
  prefix: string = DEFAULT_ECHO_PREFIX,
): DynamicStructuredTool<typeof echoToolSchema> {
  return tool(({ message }) => `${prefix}：${message}`, {
    name: ECHO_TOOL_NAME,
    description: '把收到的訊息原樣回聲，用來確認工具接線是通的。',
    schema: echoToolSchema,
  });
}

/** 插件在樹上的列用的名字（`ctx.fiber.runtime.name`，錯誤訊息與 log 用）。 */
export const name = 'echo';

/** 要的服務：`tools`，契約 `^1.0.0`。範圍在這裡宣告，經 `Service.resolveIntercept` 合併，提供者的 `check` 讀得到。 */
export const inject = injectOf(need(toolsToken, '^1.0.0'));

/** 設定的 schema，與 {@link manifest}.config 是同一個物件（一致性套件比對）。 */
export const Config = echoConfigSchema;

export const manifest = defineManifest({
  id: 'echo',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [],
  consumes: [{ token: toolsToken.name, range: '^1.0.0' }],
  config: echoConfigSchema,
  // 換程式碼要重啟行程；設定一改，下一條 thread 看到新值，開著的不動（#1405、決議 §3-2 第 6 條）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * 掛上：把回聲工具登記進行程級的工具登記處。
 *
 * @param ctx - 這一列的 Cordis context。
 * @param config - 驗過的設定。
 */
export function apply(ctx: Context, config: EchoConfig): void {
  service(ctx, toolsToken).register(createEchoTool(config.prefix));
}
