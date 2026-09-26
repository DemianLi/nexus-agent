/**
 * agent 迴圈上限的**設定條目**（[#457](https://github.com/DemianLi/nexus-agent/issues/457)／
 * [#529](https://github.com/DemianLi/nexus-agent/issues/529)）。
 *
 * **這一顆不裝功能，只講設定**——同 `@nexus/core/tool-result-pruner` 那一列（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。
 * 跟同目錄那兩列（`thread-title`、`browser-session`）的差別是**消費點跑的時刻**：那兩個都有消費者
 * （`serve.ts` 的冷讀清單、`BrowserAuth` 的建構子）跑在任何 agent 出生之前，所以值由
 * {@link ./startup.ts | startupSetting} 在起動期讀；**這一個的消費點在組裝期**
 * （`agent-factory.ts` 的 `createDeepAgent(...).withConfig(...)`，跑在 `loadPlugins` 之後），
 * 註冊表就在手上。所以它走的是 #456 那三列的形狀：`apply` 把驗過的值提供成
 * {@link RECURSION_LIMIT_SERVICE}，消費點去讀服務。
 *
 * **那正是 #529 triage 要求的那一條**——「任何答案都要讓值經過一個服務，不要讓消費點直接讀
 * 條目」。第一層（起動期）做不到字面所以退到 `startupSetting`，這一層做得到，就不該繼承那個退讓。
 *
 * ## 為什麼不是 `@nexus/core/recursion-limit`
 *
 * 另外三列只講設定的都住在 `@nexus/core`，而這一列的消費點跟它們同一層——最明顯的替代是把它也
 * 搬進 core，省掉下面那條 `#settings/*` 的偏離。不那樣做的理由是**這個值是 harness 組裝形狀的
 * 性質，不是 core 的**：它換算成幾輪模型呼叫取決於 harness 這一次掛了哪些 middleware（見
 * {@link DEFAULT_RECURSION_LIMIT} 檔頭那三段換算——每輪兩格、三格、`beforeAgent` 再吃一格），
 * 而 core 不知道組裝長什麼樣。把一個「要知道組裝才講得出來的數字」放進 core，等於讓它的預設值
 * 在 core 裡沒有任何可以校準的對象。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **擁有者是 package-internal specifier（`#settings/recursion-limit`），不是套件名。** 同
 *    {@link ./thread-title.ts | thread-title} 那一列登記過的同一條，成因也一樣：`apps/harness`
 *    解不到自己（條目走 `plugin-config.ts` 的 `import(entry.name)`，`@nexus/harness` 沒有連進
 *    自己的 `node_modules`）。
 * 2. **旗標贏過這一列的那個「贏」，載體跟 dsh 不同。** dsh 沒有「旗標層」與「設定層」兩條路，
 *    只有一條——**設定值本身是一個運算式，旗標是第一個運算元**：`port: !!js ctx.webStartup.port
 *    ?? 3080`（`packages/bundle/web-app/cordis.patch.yml:136-139`，配 `inject: [webStartup]`），
 *    而 `packages/boot/cmdline/src/index.ts:11-15` 逐字寫著「**No row has launcher-level
 *    command-line status**」（`ddefc45`）。
 *
 *    **我們表達不出來的是兩樣東西**：條目的 `inject`（`plugin-config.ts` 的 `entrySchema` 是
 *    `strictObject`，只有 `id`／`name`／`config`／`disabled`），以及**延後解析的設定值**（我們的
 *    `config` 是 YAML 原值，沒有 `!!js` 這種在樹組好之後才求值的東西）。
 *
 *    **退到**：這一列的 `config` 持有部署預設，CLI 的 `--recursion-limit` 在**組裝點**覆蓋它
 *    （{@link ../agent-factory.ts | recursionLimitFor} 的第一態）。**觀察得到的優先序跟 dsh 一樣
 *    （旗標贏），載體不一樣**——dsh 的優先序寫在那一列自己身上，我們的寫在讀它的那個函式裡。
 *    代價是：將來有第二個值也要「旗標贏」時，那個優先序同樣得在它自己的消費點各寫一次。
 *
 *    **刻意不做的**：不把 `inject` ＋ 延後解析補出來。那是設定機制本身的能力（地圖 #46），在這
 *    一刀做會把一張搬常數的卡變成一張改載入器的卡——[#457](https://github.com/DemianLi/nexus-agent/issues/457)
 *    的 triage 明著這樣要求。
 * 3. **dsh 對這個值本身沒有意見**：它不跑 LangGraph，`recursionLimit` 這個概念在 `bundle/*` 的
 *    patches 與 `core/agent-loop` 全樹零命中（`ddefc45`）。所以這一列的形狀抄的是 #456 那三列，
 *    不是抄 dsh 的某一列。
 *
 * ## 這一列關不掉
 *
 * `disabled: true` 在載入期當場拋（`plugin-config.ts` 的 `PROTECTED_ENTRY_NAMES`）。**理由跟同
 * 目錄那兩列不同，而且更硬**：那兩列關掉沒有意義（不裝東西，關了也照樣裁切標題），這一列關掉
 * 在機制上確實是「沒有人提供服務」、於是落回 {@link DEFAULT_RECURSION_LIMIT}——**看起來像關掉了
 * 護欄，實際上護欄還在**。兩種都會讓部署以為自己關掉了什麼，所以一律在載入期擋。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const RECURSION_LIMIT_PLUGIN_NAME = 'recursion-limit';

/**
 * 驗過的上限，由 `#settings/recursion-limit` 這個條目提供。見
 * {@link ../agent-factory.ts | createNexusAgent} 那三態。
 */
export const RECURSION_LIMIT_SERVICE = 'recursionLimit';

/**
 * 迴圈上限的預設值。
 *
 * ## 為什麼要自己設一個
 *
 * **基座把它調到一個保證不會觸發的值。** `createDeepAgent` 最後一步是
 * `createAgent(...).withConfig({ recursionLimit: 1e4 })` —— 一萬個 super-step，換算成
 * **約 5,000 輪模型呼叫**。2026-08-28 用 [`LoopingChatModel`](../looping-model.ts) 實測過：裸基座與我們的
 * 組裝點都跑到 `GraphRecursionError: Recursion limit of 10000 reached`，模型分別被叫了
 * 5000 與 4999 次。**那不是護欄，是一個關掉的護欄。**
 *
 * 這是 [`baseline.test.ts`](../baseline.test.ts) 那條「基座還是不是我們以為的那個形狀」
 * 的另一型：上次是我們掛的 middleware 關掉了基座的預設，這次是**基座自己**把預設轉到底，
 * 而且它藏在 dist 的一行 `withConfig` 裡 —— 型別、文件、README 全都看不到。
 *
 * ## 為什麼是 100
 *
 * 換算後約 49 輪模型呼叫。實測跑掉的那一次（[#86](https://github.com/DemianLi/nexus-agent/pull/86)，
 * `llama-3.2-11b` 在一題基準任務上多叫了 25 次工具、792.8 秒、110,936 token）大約要
 * 57 個 super-step，所以這個值攔得住它，而正常的基準任務（最長 3 次工具呼叫 ≈ 8 個
 * super-step）離它還很遠。**它是「跑掉了」的界線，不是「複雜任務」的界線** —— 真的需要
 * 更長的呼叫端自己傳一個大的，那時那個數字會出現在呼叫端的程式碼裡而不是沒有人設過。
 *
 * **上面那兩個 super-step 數字都是每輪兩格算的**（57 與 8），跟下一段的新換算不同尺，
 * 不要拿它們互比。換成每輪三格是 ≈ 85 與 ≈ 12：跑掉的那次照樣攔得住，正常任務照樣很遠。
 *
 * ## 上面那個換算是裸組裝的，預設組裝比它短
 *
 * `2 × 輪數 + 2` 只在「圖裡沒有 `beforeModel` 節點」時成立，而
 * [#147](https://github.com/DemianLi/nexus-agent/issues/147) 打底的
 * `CreateNexusAgentOptions.repeatReminder` 就是一個。通式是
 * `模型輪數 = floor((recursionLimit - 1) / 每輪格數)`，所以**預設組裝每一輪是三格，
 * 100 換算成 33 輪而不是 49**。2026-09-03 實測，逐格對照見
 * [`looping-model.ts`](../looping-model.ts) 的檔頭。`beforeAgent` 也是節點，只是每次 invoke 走一次：
 * CLI 與 serve 給了 `--workspace` 時，出貨清單裡的工作區指令那顆每次 invoke 再吃一格，
 * 100 換算成 32 輪（2026-09-18 實測，見 `@nexus/plugin-agent-instructions` 檔頭「代價」）。
 *
 * **這個常數沒有跟著動。** 方向是護欄變嚴不是變鬆，而校準的兩端換算過去都還成立（見
 * 上一段）。要拿回原本的預算就自己傳一個大的 `recursionLimit`，或明著關掉提醒器。
 *
 * ## 它現在是 schema 的預設值
 *
 * [#529](https://github.com/DemianLi/nexus-agent/issues/529) 之後這個常數有了一個條目擁有者，
 * 所以它同時是兩件事：`cordis.yml` 那一列沒寫 `config:` 時 schema 填的值，以及**清單上連這一列
 * 都沒有時**（手搭清單的測試）消費點落回的值。兩種情形答案相同，因為「沒人講」的答案只有一個。
 */
export const DEFAULT_RECURSION_LIMIT = 100;

/** 一格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。 */
export const recursionLimitConfigSchema = z.strictObject({
  /** 見 {@link DEFAULT_RECURSION_LIMIT}。單位是 LangGraph 的 super-step，不是模型輪數。 */
  limit: z.number().int().positive().default(DEFAULT_RECURSION_LIMIT),
});

/** 驗過的設定。 */
export type RecursionLimitConfig = z.infer<typeof recursionLimitConfigSchema>;

declare module '@nexus/core' {
  interface NexusServices {
    /**
     * agent 迴圈的上限，由 `#settings/recursion-limit` 這個條目提供
     * （[#529](https://github.com/DemianLi/nexus-agent/issues/529)）。名字見
     * {@link RECURSION_LIMIT_SERVICE}。
     *
     * **沒人提供時是 `undefined`，而那與「關掉」不必分辨**——這一列關不掉（見檔頭），而且
     * 就算關得掉，「關掉」與「沒講」的答案都是 {@link DEFAULT_RECURSION_LIMIT}。這一點跟
     * `repeatReminder`／`toolResultPruning` 相反，那兩個的兩種成因答案是相反的。
     */
    recursionLimit: number;
  }
}

/**
 * 只講設定的那一顆，見檔頭。
 *
 * **服務的值是那個數字本身，不是整份 config。** 這一列只有一格，包成物件只會讓消費點多寫一個
 * `.limit` 而讀不出任何額外意圖；#456 那三列提供整份是因為它們真的有多格。
 */
export const recursionLimitPlugin: NexusPlugin<RecursionLimitConfig> = {
  name: RECURSION_LIMIT_PLUGIN_NAME,
  Config: recursionLimitConfigSchema,
  apply: (registry: PluginRegistry, config: RecursionLimitConfig): void => {
    registry.services.provide(RECURSION_LIMIT_SERVICE, config.limit);
  },
};

export default recursionLimitPlugin;
