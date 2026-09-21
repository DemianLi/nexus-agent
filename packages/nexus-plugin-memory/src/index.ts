/**
 * `@nexus/plugin-memory`——**選配的**、基座那套「模型自己維護」的記憶。
 *
 * **它不是 dsh `agent-instructions` 的等價物，也不在出貨清單裡**
 * （[#388](https://github.com/DemianLi/nexus-agent/issues/388)）。差別有兩處是模型看得到的：基座的
 * `wrapModelCall` 每次都附一段 `<memory_guidelines>`，**叫模型主動去改記憶檔**（沒有記憶檔時也照附），
 * 而 dsh 的模板寫的是反過來的那句（「Use them as guidance... They do not override system, developer,
 * or direct user instructions」）；載體也不同——這一顆併進 system prompt、不進會話日誌，dsh 那邊是一則
 * 持久的 `user/message`。工作區指令那條路由 `@nexus/plugin-agent-instructions` 走，預設掛著。
 *
 * **兩顆同時掛時，同一份 `AGENTS.md` 會在 prompt 裡出現兩次**（一次在 system prompt、一次在那則訊息），
 * 而且只有這一顆會附上寫入指示。要模型自己維護一份記憶就掛它，否則預設那顆就夠了。
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

import type { NexusPlugin, PluginEntry, PluginRegistry } from '@nexus/core';
import { z } from 'zod';

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

/**
 * 這個 plugin 的設定。
 *
 * **空清單擋在 schema 裡**：它會讓 `foldRegistry` 直接省略 `memory` 參數、基座連 middleware
 * 都不建，結果與「沒掛這個 plugin」一模一樣——而呼叫端顯然以為自己掛了。這種要嘛全有要嘛
 * 全無的差別不該是靜默的。
 */
export const memoryConfigSchema = z.strictObject({
  /**
   * 記憶來源，依序併進 prompt（基座的 `formatMemoryContents(contents, sources)` 照這個
   * 順序串）。省略即只有 {@link DEFAULT_MEMORY_SOURCE}。
   */
  sources: z
    .array(z.string())
    .min(1, '空的來源清單等於沒掛這個 plugin——真的不要記憶就別把它放進清單')
    .default([DEFAULT_MEMORY_SOURCE]),
});

/** 驗過的設定。 */
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;

/** 工廠收的東西：schema 的輸入面。 */
export type MemoryPluginOptions = z.input<typeof memoryConfigSchema>;

/**
 * memory plugin。
 *
 * **這個 plugin 只覆蓋 root agent。** 基座組裝 subagent 的那段
 * （`buildSubagentMiddleware(input, isForkable)`）只在 `isForkable` 為真時才把 root 的
 * memory middleware 併進去，而 `SubAgent` 定義上**沒有 `memory` 欄位**可以自帶
 * ——`createSubagentDefaultMiddleware` 有處理 `input.skills`，沒有對應的 memory 分支。
 * general-purpose subagent 也拿不到：它由 `foldRegistry` 註冊成一般的 subagent，走
 * `normalizeSubagentSpec`（`isForkable` 為 false）。基座自己補的那份也一樣拿不到。
 *
 * 也就是說「subagent 也有記憶」在 1.13.1 上**沒有任何公開介面可以做到**（`mode: 'fork'`
 * 的 subagent 除外）。這是基座的邊界，不是這裡漏寫；`apps/harness` 有一條絆索測試釘著它，
 * 基座哪天補上了那條會紅。
 *
 * **模組層級的一顆常數**，給 [#454](https://github.com/DemianLi/nexus-agent/issues/454)
 * 從設定檔 import。設定走 {@link Config} 進來，所以同一顆可以被好幾次組裝各 `apply` 一次
 * ——**每次掛載才有的狀態一律活在 `apply` 裡**。
 */
export const memoryPlugin: NexusPlugin<MemoryConfig> = {
  name: 'memory',
  Config: memoryConfigSchema,
  apply(registry: PluginRegistry, config: MemoryConfig): void {
    const { sources } = config;
    registry.capabilities.provide(MEMORY_CAPABILITY);
    // 路徑格式的檢查在 registry 那一側（`assertLoadableMemoryPath`），不在這裡。
    for (const source of sources) registry.memory.addSource(source);
  },
};

export default memoryPlugin;

/**
 * 建一個條目。**薄薄一層**：設定不在這裡驗，驗在載入的時候——那時候才有 id 可以指名。
 *
 * @param options - 設定，形狀見 {@link memoryConfigSchema}。
 * @returns 可以放進組裝點清單的條目。
 */
export function createMemoryPlugin(options: MemoryPluginOptions = {}): PluginEntry {
  return { plugin: memoryPlugin, config: options };
}
