/**
 * 一顆**關機清理會拋錯**的 plugin。
 *
 *   pnpm --filter @nexus/harness run cli --patch src/cli-dispose-failure.patch.yml "說點什麼"
 *
 * 獨立成一個模組的理由與 [`cli-collision.fixture.ts`](./cli-collision.fixture.ts) 同一條——
 * 注入點是 `--patch`，而 `runCli` 仍是唯一打動清單的地方——承重的是後面那半句。
 *
 * 它守的是 `runCli` 裡「收拾」與「原本的錯誤」誰優先：清理失敗**不能**蓋掉那一輪真正
 * 壞掉的東西，但那一輪跑成功時清理失敗就要浮上來——沒收乾淨代表可能有子行程還活著。
 */

import type { NexusPlugin } from '@nexus/core';

/** 清理拋出的訊息，測試靠它認出浮上來的是哪一個錯誤。 */
export const DISPOSE_FAILURE = '這個 plugin 關不掉';

const leaky: NexusPlugin = {
  name: 'leaky',
  apply: (registry) =>
    void registry.lifecycle.onDispose(() => {
      throw new Error(DISPOSE_FAILURE);
    }),
};

export default leaky;
