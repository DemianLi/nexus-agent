/**
 * 測試用的 plugin 清單：關機清理會拋錯的一個 plugin。
 *
 * 獨立成一個模組的理由與 [`cli-collision.fixture.ts`](./cli-collision.fixture.ts) 同一條
 * ——`runCli` 的清單只從 `--plugins` 指的模組來，沒有別的注入點。
 *
 * 它守的是 `runCli` 裡「收拾」與「原本的錯誤」誰優先：清理失敗**不能**蓋掉那一輪真正
 * 壞掉的東西，但那一輪跑成功時清理失敗就要浮上來——沒收乾淨代表可能有子行程還活著。
 */

import type { NexusPlugin } from '@nexus/core';

/** 清理拋出的訊息，測試靠它認出浮上來的是哪一個錯誤。 */
export const DISPOSE_FAILURE = '這個 plugin 關不掉';

export default [
  {
    name: 'leaky',
    apply: (registry) =>
      void registry.lifecycle.onDispose(() => {
        throw new Error(DISPOSE_FAILURE);
      }),
  },
] satisfies NexusPlugin[];
