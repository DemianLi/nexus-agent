/**
 * `@nexus/plugin-validation` 的單元驗收。
 *
 * **兩半都不在這裡了**：圍堵搬進 `@nexus/core`（#159，測試在
 * `packages/nexus-core/src/containment.test.ts`），輸出 schema 校驗也搬了（#252，測試在
 * `packages/nexus-core/src/output-schema.test.ts`）。這裡剩下的是**翻過面的絆索**：這個
 * plugin 一個 middleware 都不掛。
 */

import { loadPlugins, OUTPUT_SCHEMA_MIDDLEWARE_NAME as CORE_NAME } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import {
  createValidationPlugin,
  OUTPUT_SCHEMA_MIDDLEWARE_NAME,
  VALIDATION_CAPABILITY,
} from './index.js';

describe('plugin 掛上去的形狀', () => {
  /**
   * 圍堵與輸出校驗都由 fold 打底。這個 plugin 再掛一份就是**兩個擁有者**——比任一個單獨
   * 擁有更糟。這裡紅了代表有人把它掛回來了。
   */
  it('**一個 middleware 都不掛**，只認領能力名', async () => {
    const { registry } = await loadPlugins([createValidationPlugin()]);
    expect(registry.middleware.list()).toEqual([]);
    expect(registry.capabilities.has(VALIDATION_CAPABILITY)).toBe(true);
  });

  it('名字是 core 那一個的 re-export，不是第二份實作', () => {
    expect(OUTPUT_SCHEMA_MIDDLEWARE_NAME).toBe(CORE_NAME);
  });
});
