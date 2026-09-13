/**
 * `@nexus/plugin-validation`——**兩半都搬進 core 了，這裡只剩相容的名字。**
 *
 * - **圍堵**（工具拋錯不殺掉整場 run）：[#159](https://github.com/DemianLi/nexus-agent/issues/159)
 *   搬進 `@nexus/core` 的 fold 打底（`packages/nexus-core/src/containment.ts`）。
 * - **輸出 schema 校驗**：[#252](https://github.com/DemianLi/nexus-agent/issues/252) 搬進
 *   `@nexus/core`（`packages/nexus-core/src/output-schema.ts`）。schema 改由工具註冊時帶
 *   （`registry.tools.register(tool, { outputSchema })`），fold 打底一份校驗器進 root 與每個
 *   subagent。
 *
 * 兩次搬家是同一條論證：dsh 那側兩件事都是**註冊表執行管線自己做的**，是性質不是功能，做成
 * 一個掛不掛隨人的 plugin 才是偏離。而這個 plugin 從來不在任何一份正式清單裡——兩件事住在
 * 這裡的期間，產品路徑上都等於沒有。
 *
 * **不變量與業務規則不歸任何地方，認帳不做**（#252 第 2 項）：dsh 那側也沒有它們的家——
 * 訂 `tools/post-execute` 的全是政策與呈現，外加轉接使用者外部鉤子的橋接；業務規則住在工具
 * 本體，或人在核准卡上看。
 */

import type { NexusPlugin } from '@nexus/core';

// 兩半都搬去 core 了。這幾個名字留在這裡是**相容用的 re-export**，不是實作——
// 新的呼叫端請直接從 `@nexus/core` 拿。
export {
  CONTAINMENT_MIDDLEWARE_NAME,
  createContainmentMiddleware,
  createOutputSchemaMiddleware,
  formatSchemaViolation,
  formatToolFailure,
  formatValidatorFailure,
  OUTPUT_SCHEMA_MIDDLEWARE_NAME,
  resolveToolName,
} from '@nexus/core';

/** 這個 plugin 宣告的能力名。要相依它的 plugin 把這個字串放進自己的 `requires`。 */
export const VALIDATION_CAPABILITY = 'validation';

/**
 * 只認領 `validation` 這個能力名的 plugin。**一個 middleware 都不掛**——輸出校驗與圍堵都由
 * fold 打底，掛不掛這個 plugin 不影響它們在不在。
 *
 * @returns 可載入的 plugin。
 */
export function createValidationPlugin(): NexusPlugin {
  return {
    name: 'validation',
    apply(registry) {
      registry.capabilities.provide(VALIDATION_CAPABILITY);
    },
  };
}
