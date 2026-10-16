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
  /**
   * 組裝點在 fold **之前**包上去、**不在工作區磁碟上**的路由前綴（會話歷史、工具結果暫存）。
   *
   * 為什麼組裝點要明著交出來：折出來的 backend 是巢狀的 `CompositeBackend`，最外層只露得出 plugin 掛的那幾格，
   * 裡面那兩層的前綴在 private 欄位裡（[#951](https://github.com/DemianLi/nexus-agent/issues/951)）。
   *
   * **plugin 自己用 `backend.mount()` 掛的路由也在這裡**（[#1469](https://github.com/DemianLi/nexus-agent/issues/1469)，`@nexus/fs`
   * 1.1.0 起）：fold 填 backend 的同一處（{@link settleFsService}）把 `registry.backend.mounts()` 的前綴併進來，所以消費者
   * 只讀這一個東西，不必另外握著 registry 去問 mounts。
   *
   * 消費者是要把檔案**交給磁碟那一側**讀的工具（`present`：讀端只認工作區磁碟）；走 backend 讀寫的不需要它。
   * @returns 路由前綴，原樣（有沒有結尾斜線由組裝點決定，比對的人自己正規化）。fold 之前只有組裝點明著交的那幾格。
   */
  offWorkspacePrefixes(): readonly string[];
  /**
   * 這次組裝有沒有工作區（[#1469](https://github.com/DemianLi/nexus-agent/issues/1469) Q2 (a)，`@nexus/fs` 1.1.0 起）。
   *
   * 就是 fold 當下 `registry.capabilities.has(WORKSPACE_CAPABILITY)` 的結果——`sandbox-policy` 只在有圍堵時（給了 `--workspace`）
   * 宣告那個能力，而 fold 在所有 `apply` 之後，所以跟「工具被叫時才讀能力」的結果相同。**逐條 thread**：能力每次組裝各提供一次，
   * 這個把手是這次組裝的那一格，不會出現「這條 thread 的 backend 配上別條的工作區」。
   * @returns 有工作區就是 `true`；還沒 fold 或這次組裝沒有工作區是 `false`。
   */
  hasWorkspace(): boolean;
}

/** {@link settleFsService} 在 fold 當下算好、一起填進把手的事實（#1469）。 */
export interface FsFacts {
  /** 這次組裝有沒有工作區（`registry.capabilities.has(WORKSPACE_CAPABILITY)`）。 */
  readonly hasWorkspace: boolean;
  /** plugin 用 `backend.mount()` 掛上的路由前綴（`registry.backend.mounts()` 的鍵），原樣。 */
  readonly mountPrefixes: readonly string[];
}

/** {@link createFsService} 的參數。 */
export interface FsServiceOptions {
  /** 見 {@link FsService.offWorkspacePrefixes}。省略即沒有。 */
  offWorkspacePrefixes?: readonly string[];
}

/** 填值的那一半只留在這個模組裡：消費者手上的把手只讀得到、改不了。 */
const settlers = new WeakMap<
  object,
  (backend: AnyBackendProtocol | undefined, facts: FsFacts) => void
>();

/**
 * 建一格還沒填值的 `fs` 服務。組裝點在 `apply` 裡把它提供出去（例如經 `createHostServicesPlugin`）。
 * @param options - 組裝點自己包的、不在磁碟上的路由前綴。
 * @returns 一格把手，fold 之前讀到 `undefined`。
 */
export function createFsService(options: FsServiceOptions = {}): FsService {
  let folded: AnyBackendProtocol | undefined;
  let workspace = false;
  const assembly = [...(options.offWorkspacePrefixes ?? [])];
  let prefixes: readonly string[] = assembly;
  const service: FsService = {
    backend: () => folded,
    offWorkspacePrefixes: () => prefixes,
    hasWorkspace: () => workspace,
  };
  settlers.set(service, (backend, facts) => {
    folded = backend;
    workspace = facts.hasWorkspace;
    // 組裝點明著交的在前，plugin 掛的在後；重複填（同一格 fold 兩次）不累加。
    prefixes = [...assembly, ...facts.mountPrefixes];
  });
  return service;
}

/**
 * 把折出來的 backend 填進那一格。**只有 fold 呼叫**。
 *
 * 不是 {@link createFsService} 建的那一種（測試直接交一個物件、或根本沒人提供）就不碰：那個值是誰提供的，
 * 就由誰說了算。
 *
 * **這是「這次組裝有沒有工作區」與「plugin 掛了哪些路由」唯一被算的地方**（#1469）：fold 把兩樣一起交進來，消費者之後
 * 只從把手讀，不在別處再算一次。
 *
 * @param service - `registry.services.get(FS_SERVICE)` 拿到的東西。
 * @param backend - `foldBackend` 折出來的那一個。
 * @param facts - fold 當下算好的工作區事實與掛載前綴。
 */
export function settleFsService(
  service: unknown,
  backend: AnyBackendProtocol | undefined,
  facts: FsFacts,
): void {
  if (typeof service !== 'object' || service === null) return;
  settlers.get(service)?.(backend, facts);
}
