/**
 * 「活著的設定版本 → 用到它的 thread」那張表（[#1442](https://github.com/DemianLi/nexus-agent/issues/1442)，Part of #1385，
 * 版本路由的第一刀；決策卡 #1431）。
 *
 * ## 回答什麼
 *
 * 改了設定之後，進行中的舊 thread 還握著組裝當下那一份宣告，新 thread 才用新的（`docs/plugin-contract.md`，#1416 Q3 (a)）。
 * 「哪些 thread 還在用舊設定」今天看不到（#1138 缺口 1）。這張表是 serve 行程記憶體裡的一份對照：
 * **列 id → 宣告的簽章 → 綁著它的 thread id**，經快照檔（`plugin-snapshot.ts` 每列的 `live`）列給管理員。
 *
 * **交付的是「設定版本 → thread」，不是「程式碼版本 → thread」**：寫入口沒有換模組的動作，`import()` 有 ESM 快取，所以同一列
 * 在一個行程裡只會因為**宣告**（模組名加設定）改了而出現兩版。程式碼版本要等第二刀（每一版一個 entry id）；到時這張表照樣
 * 用「列 id＋版本」分得出來，格式不用再改。
 *
 * ## 綁什麼、什麼時候綁、什麼時候放
 *
 * - **只綁實際掛上的列**（判準同 #1423）：交給組裝的那一顆沒停用，而且不在這一次的 `dropped` 裡。所以停用的列、這條 thread
 *   掉的列、樹上自我停用判成 `off` 的橋接列（交給組裝時是停用的）都不綁。
 * - **起動期讀的 13 列不進表**（`STARTUP_READ_PLUGINS`）：它們生效的是啟動那一份，不是 thread 清單上的宣告；改了就是
 *   `sync: restart`，快照已經表達了。
 * - **組裝成功之後才綁**：`read()` 在組裝之前就寫了快照，組裝還可能失敗（`serve.ts`）。
 * - **thread 拆掉才放**：今天只有 serve 關機才拆（`wire-handler.ts` 的 `close()`），所以清單只增不減，直到重啟（Q4 (a)）。
 *   只看過歷史、沒跑過一輪的 thread 也算，因為它下一輪真的會用那一版。
 * - **只綁 root thread id**：子代理沿用 root 那一份清單，不另綁自己的 id。
 * - **引用計數不跨重啟**（Q1 (a)）：表只活在行程記憶體裡。
 *
 * ## 偏離登記（對 dsh `agent-preset-registry`，`packages/preset/agent-preset-registry/src/index.ts`）
 *
 * dsh 的代際（`Generation { scope, key, mount, users, retired }`，`:31-37`）更新或移除定義時把舊代際標成 `retired`
 * （`:93-96`），Agent 綁定時 `users++`、卸載時用 `ctx.effect` 遞減（`:245`、`:258-273`），`retired` 而且 `users === 0`
 * 才回收（`:148-152`），`inspectCompositions` 列出所有仍保留的代際（`:164-172`）。這一刀照它的「綁定＋檢視」那一半；
 * 四條偏離的理由類別都是「產品需求超出 dsh 的射程」（決議 §五）：
 *
 * 1. **單位**：dsh 一代是一整組 preset 組合；這裡一版是一列的一份宣告。本專案判過不做 preset
 *    （`.docs/seven-layer-inventory-2026-09-26.md:328`，T-29），版本路由以列為單位（決議 §3-2 第 6 條）。
 * 2. **計數 → 清單**：dsh 的 `users` 是私有計數；這裡記 thread id，因為要「列出受影響的 thread」（#1431 Q3 (a)）。
 * 3. **出口**：dsh 經 `inspectCompositions` 在行程內查；這裡寫進快照檔，沿用 #1406 已登記的偏離（沒有管理員身分，不開
 *    wire 路由）。
 * 4. **不回收**：`retired` 且 `users === 0` 時的回收留給第二刀。今天舊版只是 thread 的閉包，沒有 fiber 可撤。
 *
 * @module
 */

import type { PluginEntry } from '@nexus/core';

import type { LoadedPluginConfig } from './plugin-config.js';
import { classOfRow } from './plugin-row-classes.js';
import { declarationSignature } from './plugin-row-state.js';

/** 一條 thread 綁著的一列：列 id 與它那一份宣告的簽章（{@link declarationSignature}，含設定明文，不往外送）。 */
export interface LiveRowBinding {
  readonly id: string;
  readonly signature: string;
}

/** 組裝時掉了的條目，只用到辨認是哪一列的那幾格（`AssemblyDropInput` 的子集）。 */
export interface LiveDropInput {
  readonly entry: PluginEntry;
  readonly drop?: { readonly origin?: { readonly id: string } };
}

/**
 * 一條 thread 組裝成功之後，它實際掛上的列與各自的宣告簽章。
 *
 * @param list - 這條 thread 讀到的那一份（`ThreadPluginList` 的子集）。
 * @param dropped - 這一次組裝時掉了的條目（`built.dropped`）。
 * @returns 每一列一筆，照清單順序。
 */
export function liveBindingsOf(
  list: {
    readonly loaded: Pick<LoadedPluginConfig, 'entries' | 'ids' | 'rows'>;
    readonly plugins: readonly PluginEntry[];
  },
  dropped: readonly LiveDropInput[],
): LiveRowBinding[] {
  const droppedIds = new Set<string>();
  for (const { entry, drop } of dropped) {
    // 判準同 `thread-plugin-list.ts` 的 `noteDropped`：優先用掉的來源那一列，沒有再用條目自己那一列。
    const id = drop?.origin?.id ?? list.loaded.rows.get(entry)?.id;
    if (id !== undefined) droppedIds.add(id);
  }
  const mounted = new Map<string, PluginEntry>();
  for (const entry of list.plugins) {
    const row = list.loaded.rows.get(entry);
    if (row !== undefined) mounted.set(row.id, entry);
  }
  const bindings: LiveRowBinding[] = [];
  for (const [index, declared] of list.loaded.entries.entries()) {
    const id = list.loaded.ids[index];
    if (id === undefined) continue;
    const entry = mounted.get(id);
    // 交給組裝的那一顆不在（模組那一步就掉了）、停用的（含樹上自我停用判成 `off` 的）、這條 thread 掉的：沒掛上。
    if (entry === undefined || entry.disabled === true || droppedIds.has(id)) continue;
    // 起動期讀的列生效的是啟動那一份，不是這條 thread 的清單。
    if (classOfRow(id, entry.plugin.name) === 'startup-read') continue;
    bindings.push({ id, signature: declarationSignature(id, declared.name, declared.config) });
  }
  return bindings;
}

/** 一列底下各版本綁著的 thread：簽章 → thread id 集合，照第一次出現的順序。 */
export type LiveVersionRows = ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;

/** 這張表。 */
export interface LiveVersionTable {
  /**
   * 一條 thread 綁上它實際掛上的那幾列。同一個 thread id 再綁一次，先放掉上一次的。
   *
   * @param threadId - root thread id。
   * @param bindings - {@link liveBindingsOf} 的結果。
   * @returns 放掉：只動記憶體，不寫檔；呼叫第二次是空操作。
   */
  bind(threadId: string, bindings: readonly LiveRowBinding[]): () => void;
  /** 目前的對照：列 id → 簽章 → thread id。**唯讀的一份，之後的綁定與放掉不影響已經拿到的。** */
  rows(): LiveVersionRows;
}

/**
 * 建一張表。
 *
 * @returns 空表。
 */
export function createLiveVersionTable(): LiveVersionTable {
  const rows = new Map<string, Map<string, Set<string>>>();
  const held = new Map<string, readonly LiveRowBinding[]>();

  function release(threadId: string, bindings: readonly LiveRowBinding[]): void {
    for (const { id, signature } of bindings) {
      const versions = rows.get(id);
      const threads = versions?.get(signature);
      if (versions === undefined || threads === undefined) continue;
      threads.delete(threadId);
      if (threads.size === 0) versions.delete(signature);
      if (versions.size === 0) rows.delete(id);
    }
  }

  return {
    bind(threadId, bindings) {
      const previous = held.get(threadId);
      if (previous !== undefined) release(threadId, previous);
      held.set(threadId, bindings);
      for (const { id, signature } of bindings) {
        let versions = rows.get(id);
        if (versions === undefined) rows.set(id, (versions = new Map()));
        let threads = versions.get(signature);
        if (threads === undefined) versions.set(signature, (threads = new Set()));
        threads.add(threadId);
      }
      return () => {
        // 已經被同一個 thread id 的下一次綁定換掉的，這一支什麼也不放。
        if (held.get(threadId) !== bindings) return;
        held.delete(threadId);
        release(threadId, bindings);
      };
    },
    rows() {
      return new Map(
        [...rows].map(
          ([id, versions]) =>
            [
              id,
              new Map([...versions].map(([signature, threads]) => [signature, new Set(threads)])),
            ] as const,
        ),
      );
    },
  };
}
