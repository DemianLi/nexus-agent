/**
 * `fs` 服務：**工具拿到工具實際讀寫的那一個 backend** 的地方（[#694](https://github.com/DemianLi/nexus-agent/issues/694)）。
 *
 * dsh 只有一個 `fs` 服務（`packages/fs/fs/src/index.ts:89` 的 `super(ctx, 'fs')`，SHA `477b4f4`），
 * 檔案工具、`present` 與 `agent-instructions` 注入的都是同一個（`packages/fs/tool-fs/src/index.ts:22`、
 * `packages/deliverables/tool-present/src/index.ts:26`）。我們照它：要讀寫工作區檔案的工具從這裡拿，
 * 拿到的是 {@link foldRegistry} 折出來、也交給基座檔案工具的那一個——包含組裝點在 fold 之前包的路由
 * （`apps/harness/src/agent-factory.ts` 的會話歷史與工具結果暫存）與 plugin `backend.mount()` 掛的路由。
 *
 * ## 偏離登記：服務的值是一格把手，不是檔案系統本身
 *
 * **哪一條**：dsh 的 `ctx.fs` 就是那個檔案系統，提供方在自己的 `apply` 裡交出它。
 *
 * **為什麼表達不出來**：同 `@nexus/plugin-agent-instructions` 的偏離 2——plugin 在 `apply` 裡看不到折後的
 * backend，它要等 `foldRegistry` 把路由與兜底那個折起來才算得出來；而 `services.provide()` 只能在 `apply`
 * 裡呼叫（`registry.ts` 的 `requireOrigin`）。
 *
 * **退到什麼**：組裝點在 `apply` 裡先提供一格（{@link createFsService}），fold 折完把折出來的那一個填進去
 * （{@link settleFsService}）。消費者**在工具被叫時才讀** {@link FsService.backend}，所以排在提供者前面
 * 或後面都一樣；這次組裝一個 backend 都沒有時讀到 `undefined`，同 dsh 拿不到提供方。
 *
 * @module
 */

import type { AnyBackendProtocol } from 'deepagents';

/** 服務名，照 dsh。 */
export const FS_SERVICE = 'fs';

/** {@link FS_SERVICE} 的值。 */
export interface FsService {
  /**
   * 折出來的那一個 backend。
   * @returns 工具實際讀寫的 backend；這次組裝沒有 backend、或還沒 fold 時是 `undefined`。
   */
  backend(): AnyBackendProtocol | undefined;
}

/** 填值的那一半只留在這個模組裡：消費者手上的把手只讀得到、改不了。 */
const settlers = new WeakMap<object, (backend: AnyBackendProtocol | undefined) => void>();

/**
 * 建一格還沒填值的 `fs` 服務。組裝點在 `apply` 裡把它提供出去（例如經 `createHostServicesPlugin`）。
 * @returns 一格把手，fold 之前讀到 `undefined`。
 */
export function createFsService(): FsService {
  let folded: AnyBackendProtocol | undefined;
  const service: FsService = { backend: () => folded };
  settlers.set(service, (backend) => {
    folded = backend;
  });
  return service;
}

/**
 * 把折出來的 backend 填進那一格。**只有 fold 呼叫**。
 *
 * 不是 {@link createFsService} 建的那一種（測試直接交一個物件、或根本沒人提供）就不碰：那個值是誰提供的，
 * 就由誰說了算。
 *
 * @param service - `registry.services.get(FS_SERVICE)` 拿到的東西。
 * @param backend - `foldBackend` 折出來的那一個。
 */
export function settleFsService(service: unknown, backend: AnyBackendProtocol | undefined): void {
  if (typeof service !== 'object' || service === null) return;
  settlers.get(service)?.(backend);
}
