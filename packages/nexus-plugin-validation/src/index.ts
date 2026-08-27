/**
 * `@nexus/plugin-validation`——工具失敗回饋與輸出 schema 校驗。
 *
 * 動工前驗過基座，計劃原本那句「工具輸出 schema 驗證、失敗自動回饋重試」的兩個子句
 * **壞的方向不一樣**：
 *
 * - **「輸出 schema 驗證」是真的缺口。** `toolRetryMiddleware` 與 `toolErrorMiddleware`
 *   都只 `catch`，沒有人看 `handler()` 成功回來的那個值（`langchain@1.5.10`）。
 *   輸入那一半則早就有了，不必做第二次——見 {@link createOutputSchemaMiddleware}。
 * - **「失敗自動回饋」不是還沒做，是被我們自己踩掉了。** 基座本來會把工具拋的錯翻成
 *   一則回饋，但只要有任何一個 middleware 定義了 `wrapToolCall`，那條路就整個關掉、
 *   改成讓整場 run 死掉——而 `createDeepAgent` 永遠掛著一個這樣的 middleware。
 *   細節見 {@link createContainmentMiddleware}。
 *
 * 所以這個 plugin 掛**兩個** middleware，射程刻意不同：
 *
 * | middleware | 位置 | 管什麼 |
 * | --- | --- | --- |
 * | {@link createContainmentMiddleware} | `prepend`，最外 | 內層任何一處拋錯 → error ToolMessage |
 * | {@link createOutputSchemaMiddleware} | 最內 | 成功的輸出合不合宣告的 schema |
 *
 * 外圍內驗這個排法不是美學：校驗器自己的 bug 一樣會讓整場 run 死掉（實測），
 * 而圍堵在外剛好接得住它。
 *
 * **這一版只收 schema。** 不變量與業務規則歸
 * [#16](https://github.com/DemianLi/nexus-agent/issues/16)——那是計劃 §7 第 5 點的決議：
 * schema 是工具作者自己說得清楚的東西，不變量不是。
 */

import type { NexusPlugin } from '@nexus/core';
import { createContainmentMiddleware } from './containment.js';
import { createOutputSchemaMiddleware } from './output-schema.js';
import type { ToolOutputSchemas } from './output-schema.js';

export { CONTAINMENT_MIDDLEWARE_NAME, createContainmentMiddleware } from './containment.js';
export { OUTPUT_SCHEMA_MIDDLEWARE_NAME, createOutputSchemaMiddleware } from './output-schema.js';
export type { ToolOutputSchemas } from './output-schema.js';
export {
  formatSchemaViolation,
  formatToolFailure,
  formatValidatorFailure,
  resolveToolName,
} from './feedback.js';

/** 這個 plugin 宣告的能力名。要相依它的 plugin 把這個字串放進自己的 `requires`。 */
export const VALIDATION_CAPABILITY = 'validation';

export interface ValidationPluginOptions {
  /**
   * 工具名 → 輸出 schema。**沒列到的工具不驗**，明文放行。
   *
   * 省略即完全不驗輸出——這時這個 plugin 只剩圍堵那一半，而那一半本身就值得掛。
   */
  readonly schemas?: ToolOutputSchemas;
}

/**
 * 造一個把工具失敗變成回饋、並（選加地）驗工具輸出的 plugin。
 *
 * @param options - 見 {@link ValidationPluginOptions}。
 * @returns 可載入的 plugin。
 */
export function createValidationPlugin(options: ValidationPluginOptions = {}): NexusPlugin {
  const schemas = options.schemas ?? {};
  return {
    name: 'validation',
    apply(registry) {
      registry.capabilities.provide(VALIDATION_CAPABILITY);
      // 圍堵在最外：射程要蓋過內層每一個 plugin middleware，包含下面這一個。
      registry.middleware.use(createContainmentMiddleware(), { prepend: true });
      // 沒有任何 schema 就不掛校驗那一半——掛一個什麼都放行的 middleware，只會讓
      // 「有沒有在驗」這件事從清單上看不出來。
      if (Object.keys(schemas).length > 0) {
        registry.middleware.use(createOutputSchemaMiddleware(schemas));
      }
    },
  };
}
