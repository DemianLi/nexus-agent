/**
 * `@nexus/plugin-memory`——把 AGENTS.md 這類長期記憶掛進 agent 的 plugin。
 *
 * **它薄，而且薄是對的。** 基座的 `createMemoryMiddleware` 已經做完了載入與注入，
 * `@nexus/core` 的 `memory` 註冊點與 `foldRegistry` 在 Phase 1 就接好了，所以這個套件
 * 真正提供的只有兩件事：一個**慣例路徑**（{@link DEFAULT_MEMORY_SOURCE}），與一個
 * 讓別的 plugin 可以 `requires` 的**能力名**（{@link MEMORY_CAPABILITY}）。
 *
 * 動工前查過基座（`deepagents@1.13.1`）。三件事決定了這個套件能承諾什麼、不能承諾
 * 什麼——都是實測，不是文件上的說法：
 *
 * 1. **memory middleware 是唯讀的。** 它只有 `beforeAgent`（讀）與 `wrapModelCall`
 *    （把內容併進 system prompt），**不註冊任何工具**。記憶要寫回去，唯一的路是模型
 *    自己呼叫 `edit_file`／`write_file`——那條路會經過 `permissions` 與（我們的）
 *    backend fence。所以「記憶留不留得住」是 **backend 的問題**，跟 checkpointer 無關：
 *    checkpointer 存的是 thread 內的對話狀態，不是磁碟上的那個檔。
 * 2. **載入失敗是靜默的。** 見 `@nexus/core` 的 `assertLoadableMemoryPath`——這也是
 *    路徑檢查為什麼在 registry 而不在這裡：一道只有這個 plugin 做的檢查，補不住一個
 *    「不經過這個 plugin 就完全沒人擋」的洞。
 * 3. **subagent 拿不到 root 的記憶。** 見 {@link createMemoryPlugin} 的說明。
 */

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這個 plugin 宣告的能力名。要相依它的 plugin 把這個字串放進自己的 `requires`。 */
export const MEMORY_CAPABILITY = 'memory';

/**
 * 省略 `sources` 時用的來源。
 *
 * **是 backend 命名空間下的絕對路徑，不是磁碟路徑。** 它實際落在哪由組裝點給的
 * backend 決定：`StateBackend` 下它活在 state 裡（換個 agent 就沒了），
 * `ContainedFilesystemBackend` 下它是可寫根裡的 `AGENTS.md`（真的留得住）。
 */
export const DEFAULT_MEMORY_SOURCE = '/AGENTS.md';

export interface MemoryPluginOptions {
  /**
   * 記憶來源，依序併進 prompt（基座的 `formatMemoryContents(contents, sources)` 照這個
   * 順序串）。省略即只有 {@link DEFAULT_MEMORY_SOURCE}。
   */
  readonly sources?: readonly string[];
}

/**
 * 建一個 memory plugin。
 *
 * **這個 plugin 只覆蓋 root agent。** 基座組裝 subagent 的那段
 * （`buildSubagentMiddleware(input, isForkable)`）只在 `isForkable` 為真時才把 root 的
 * memory middleware 併進去，而 `SubAgent` 定義上**沒有 `memory` 欄位**可以自帶
 * ——`createSubagentDefaultMiddleware` 有處理 `input.skills`，沒有對應的 memory 分支。
 * 連內建的 general-purpose subagent 也拿不到：它走 `normalizeSubagentSpec`
 * （`isForkable` 為 false），而它那次 `mergeMiddlewareStack` 帶 `{ appendNew: false }`，
 * 所以連從 `middleware` 參數塞一個同名的進去都會被丟掉。
 *
 * 也就是說「subagent 也有記憶」在 1.13.1 上**沒有任何公開介面可以做到**（`mode: 'fork'`
 * 的 subagent 除外）。這是基座的邊界，不是這裡漏寫；`apps/harness` 有一條絆索測試釘著它，
 * 基座哪天補上了那條會紅。
 *
 * @param options - 來源清單。
 * @returns 可以放進組裝點清單的 plugin。
 * @throws `sources` 給了空陣列。空清單會讓 `foldRegistry` 直接省略 `memory` 參數、
 *   基座連 middleware 都不建，結果與「沒掛這個 plugin」一模一樣——而呼叫端顯然以為
 *   自己掛了。這種要嘛全有要嘛全無的差別不該是靜默的。
 */
export function createMemoryPlugin(options: MemoryPluginOptions = {}): NexusPlugin {
  const sources = options.sources ?? [DEFAULT_MEMORY_SOURCE];
  if (sources.length === 0) {
    throw new Error(
      'createMemoryPlugin({ sources: [] })：空的來源清單等於沒掛這個 plugin——' +
        'fold 會省略 memory 參數，基座連 memory middleware 都不會建。' +
        '真的不要記憶就別把這個 plugin 放進清單。',
    );
  }

  return {
    name: 'memory',
    apply(registry: PluginRegistry): void {
      registry.capabilities.provide(MEMORY_CAPABILITY);
      // 路徑格式的檢查在 registry 那一側（`assertLoadableMemoryPath`），不在這裡。
      for (const source of sources) registry.memory.addSource(source);
    },
  };
}
