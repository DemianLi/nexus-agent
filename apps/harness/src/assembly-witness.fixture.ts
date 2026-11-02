/**
 * 一顆**只記次數**的見證 plugin：`apply` 跑了幾次、收掉了幾次（#749）。
 *
 * `runServe` 不交出 agent，這條路離開行程的只有日誌與線上的回應，而「組了幾份 agent、收掉了幾份」兩邊都看不到。
 * 每組一份 agent 就 `apply` 一次，所以次數就是份數。記在模組層：測試 import 同一個模組，讀的是同一份（同
 * `conversation-restore.fixture.ts`）。
 *
 * 它量兩件事：
 *
 * - serve 啟動時那一次試組**真的收掉了**：起來之後是「apply 1、收掉 1」。
 * - 冷讀的路（列表）**一份 agent 都不建**：列完之後 apply 還是 1，切過去一條才變 2。
 *
 * dsh 的 web 失敗矩陣也用一顆這樣的見證 plugin（dsh `apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts:172-189`，
 * `477b4f4`）。旁邊那份 patch 檔把它 `insert` 到出貨清單上。
 */

import type { NexusPlugin } from '@nexus/core';

/** 到目前為止的次數。測試自己歸零（{@link resetAssemblyWitness}）。 */
export const assemblyWitness = { applied: 0, disposed: 0 };

export function resetAssemblyWitness(): void {
  assemblyWitness.applied = 0;
  assemblyWitness.disposed = 0;
}

const witness: NexusPlugin = {
  name: 'assembly-witness',
  apply(registry) {
    assemblyWitness.applied += 1;
    registry.lifecycle.onDispose(() => {
      assemblyWitness.disposed += 1;
    });
  },
};

export default witness;
