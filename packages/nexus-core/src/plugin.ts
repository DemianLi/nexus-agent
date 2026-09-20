/**
 * NexusPlugin 契約本身：plugin 的形狀、它帶的 Config、條目的形狀，以及「是誰註冊的」這個身分。
 *
 * ## 設定是資料，不是閉包（[#453](https://github.com/DemianLi/nexus-agent/issues/453)）
 *
 * **本檔推翻了兩條舊決定**：
 *
 * - [#104](https://github.com/DemianLi/nexus-agent/issues/104) 的頭條決定 (b)——`id` 與
 *   `disabled` 掛在 plugin 上。現在它們掛在**條目**上，照 dsh
 *   （`vendor/loader/src/config/entry.ts:9-22` 的 `EntryOptions`）。
 * - [#28](https://github.com/DemianLi/nexus-agent/issues/28) 決議 9——設定由
 *   `createXPlugin(opts)` 關進工廠閉包。現在 plugin 可以帶一份 {@link NexusPlugin.Config}
 *   schema，設定是**條目上的一格資料**，載入時驗過才交給 `apply`。
 *
 * 理由是外部設定（[#454](https://github.com/DemianLi/nexus-agent/issues/454) 的 YAML）
 * 傳不進閉包，也驗不了閉包：一份從檔案讀進來的設定只能是資料。
 *
 * ## 照 dsh 的什麼
 *
 * dsh 的 plugin 模組匯出 `Config`（schemastery schema）與 `apply(ctx, config)`；載入器
 * import 條目的 `name` 拿到 plugin，cordis 在啟動 fiber 之前用
 * `Config['~standard'].validate(config)` 驗過，驗不過就拋 `ValidationError`
 * （`vendor/cordis/src/fiber.ts:50-62` 的 `resolveConfig`）。走的是 Standard Schema
 * 介面，而 **zod 4 自己就實作了這個介面**，所以我們直接用 core 本來就在用的 zod，
 * 不引進 schemastery。
 *
 * ## 登記的偏離：未知欄位讓載入失敗
 *
 * dsh **放行**未知欄位：schemastery 的 `~standard.validate` 跑非嚴格模式
 * （`vendor/schemastery/src/index.ts:282`、`:470` 的 `strict = false`），而 object 在
 * 非嚴格模式下把未知欄位原樣併進去（`:761`）——拼錯的欄位名因此悄悄沒有作用。
 *
 * 我們讓它**載入失敗**：每一層 object 都用 `z.strictObject`。理由是 YAML 拼錯字會悄悄
 * 失效，而這是一台多人共用的內網主機，沒有人會發現。前例是
 * `createAgentInstructionsPlugin` 拒絕 dsh 用 `0` 代表關掉。
 *
 * @module
 */

import { z } from 'zod';
import type { PluginRegistry } from './registry.js';

/**
 * 一個 plugin。`apply` 是命令式註冊——plugin 拿到 registry，自己決定往哪幾個
 * 擴充點放東西，而不是交出一份靜態宣告讓 harness 去解讀。
 *
 * **它是模組層級的一顆常數**，不是每次掛載現做的閉包產物：設定走 {@link Config} 那條
 * 路進來，所以同一顆 plugin 可以被好幾次組裝各 `apply` 一次。**因此每次掛載才有的狀態
 * 一律活在 `apply` 裡**——寫在模組層級的話，`serve.ts` 的兩個 thread 會串台，而且不會拋。
 *
 * @typeParam TConfig - 這個 plugin 驗過之後拿到的設定。沒有 {@link Config} 時是 `void`。
 */
export interface NexusPlugin<TConfig = void> {
  /**
   * 純標籤，唯一用途是錯誤訊息指名。**不唯一**：同一個 plugin 掛載多次是合法的
   * （`mcp` 接兩台 server 就是兩個條目、同一個 `name`），真撞了會撞在它們註冊的東西
   * 那一層，不是在這裡。指認某一次掛載是 {@link PluginEntry.id} 的工作。
   */
  readonly name: string;
  /**
   * 需要的能力名，不是 plugin 名。只做存在性檢查、不排序——載入順序由清單決定，
   * `requires` 不參與。
   */
  readonly requires?: readonly string[];
  /**
   * 這個 plugin 的設定 schema。省略即**這個 plugin 不收設定**，條目給了 `config` 就是
   * 錯誤（見 {@link parseEntryConfig}）。
   *
   * 每一層 object 都要 `z.strictObject`——未知欄位讓載入失敗是登記過的偏離，見檔頭。
   * 預設值寫在 schema 裡，不寫在 `apply` 裡：`--dump-config`（#454）要印得出實際生效的值。
   */
  readonly Config?: z.ZodType<TConfig, unknown>;
  /**
   * 把這一次掛載註冊進 registry。
   *
   * @param registry - 這一次掛載的 registry（已經記著是誰註冊的）。
   * @param config - 驗過的設定。沒有 {@link Config} 的 plugin 拿到的是 `undefined`。
   */
  apply(registry: PluginRegistry, config: TConfig): void | Promise<void>;
}

/**
 * 清單裡的一個**條目**：掛哪一顆 plugin、用什麼設定、這一次掛載叫什麼。
 *
 * 形狀照 dsh 的 `EntryOptions`（`vendor/loader/src/config/entry.ts:9-22`）。**#454 從 YAML
 * 載入時就是這個形狀**：`name` import 出 {@link plugin}，其餘欄位原樣照搬。
 *
 * `plugin` 那一格是 `NexusPlugin<unknown>`：清單是異質的（每顆 plugin 的 `Config` 都不同），
 * 而 `unknown` 是唯一收得下全部的那個——`Config` 的型別參數在 zod 那邊是**協變**的
 * （`interface ZodType<out Output, out Input>`），所以只有上界放得進去；`apply` 那一側
 * 則靠方法參數的雙變。型別安全來自**工廠**（`createEchoPlugin(options)` 的簽名），
 * 不是來自這一格。
 */
export interface PluginEntry {
  /**
   * **這一次掛載**的識別。省略即由 {@link resolveEntries} 補一個 `<name>#<序號>`。
   *
   * 要一個不隨清單變動的名字就自己寫——`name` 不用動，它本來就不唯一：
   *
   * ```ts
   * { ...createMcpPlugin({ serverName: 'github', connection }), id: 'mcp-github' }
   * ```
   *
   * 射程見 {@link PluginOrigin}。
   */
  readonly id?: string;
  /**
   * 這一次掛載**不要跑**。`apply` 一次都不會被呼叫，所以它不註冊任何東西、也不宣告
   * 任何能力；它的 {@link NexusPlugin.requires} 跟著不檢查（沒跑的東西不需要任何能力），
   * 它的 {@link config} 也跟著**不驗**——理由見 {@link resolveEntries}。
   *
   * **與「把這一行從清單裡刪掉」不同的地方只有兩件，而那兩件就是它存在的理由**：
   * 條目仍然拿得到 id、仍然出現在 {@link ../load.ts | LoadResult} 的 `entries` 裡
   * （診斷看得到「它在清單裡，只是關著」），而且**其他條目的自動 id 不會位移**——
   * 編號在停用之前就發完了。
   *
   * 只收字面布林。dsh 那邊可以寫 `!!js` 運算式對 loader context 求值
   * （`vendor/loader/src/config/entry.ts:105`），我們刻意不接——理由見
   * [#104](https://github.com/DemianLi/nexus-agent/issues/104) 的偏離標註。
   */
  readonly disabled?: boolean;
  /** 掛哪一顆。 */
  readonly plugin: NexusPlugin<unknown>;
  /**
   * 交給它的設定，**原始的那一份**：驗證在 {@link resolveEntries} 裡做，`apply` 拿到的
   * 是驗過的結果。plugin 沒有 {@link NexusPlugin.Config} 時給它就是錯誤。
   */
  readonly config?: unknown;
}

/**
 * plugin 自己的 manifest：只驗 `name` 與 `requires`。
 *
 * 擴充內容不驗：那些東西的合法性由各註冊點自己的規則守（同名 tool、同名 subagent），
 * 驗兩次只會讓規則有兩個出處。設定由 {@link NexusPlugin.Config} 自己驗。
 */
export const pluginManifestSchema = z.object({
  name: z.string().min(1, 'plugin 的 name 不能是空字串'),
  requires: z.array(z.string().min(1, 'requires 裡的能力名不能是空字串')).optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/**
 * 條目自己的 manifest：`id` 與 `disabled`。
 *
 * `id` 的前後空白擋在這裡而不是靜默 trim：**id 會原樣出現在每一則錯誤訊息裡**，
 * 一個看不見的空白讓兩個長得一樣的 id 是兩個東西。
 *
 * `disabled` **一定要驗**：不驗的話 `disabled: 'false'` 這種寫法會是真值，一個以為
 * 自己開著的 plugin 靜靜地不跑，而且沒有任何訊息。
 */
export const entryManifestSchema = z.object({
  id: z
    .string()
    .min(1, '條目的 id 不能是空字串')
    .refine((value) => value.trim() === value, '條目的 id 不能有前後空白')
    .optional(),
  disabled: z.boolean().optional(),
});

export type EntryManifest = z.infer<typeof entryManifestSchema>;

/**
 * 某次掛載的身分。
 *
 * **`id` 在一次 {@link resolveEntries} 裡唯一**，條目自己沒寫就補一個
 * `<name>#<序號>`。補出來的沒有隨機成分：同一份清單解析幾次都是同一批 id。
 *
 * **但它不承諾跨清單穩定，也不要存下來。** 清單裡多一個同名的 plugin，後面那些的
 * 序號就會移動。這是刻意的射程：dsh 的自動 id 之所以能當長期識別，是因為 loader
 * 產完就寫回設定檔（`vendor/loader/src/config/group.ts:21` → `tree.ts:102`），
 * 而我們沒有那個檔——[#104](https://github.com/DemianLi/nexus-agent/issues/104)
 * 明著把設定檔排除在範圍外。**要跨版本穩定的指名，就自己寫 `id`。**
 */
export interface PluginOrigin {
  /** 這一次掛載的識別。 */
  id: string;
  /** 該 plugin 的 `name`。 */
  name: string;
}

/** 一份清單解析出來的一次掛載：那個 plugin、驗過的設定，配上它這一次的身分。 */
export interface ResolvedPluginEntry {
  readonly plugin: NexusPlugin<unknown>;
  readonly origin: PluginOrigin;
  /** 這一次掛載關著——{@link PluginEntry.disabled} 的解析結果，省略即 `false`。 */
  readonly disabled: boolean;
  /**
   * 驗過的設定，直接交給 `apply`。沒有 `Config` 的 plugin 是 `undefined`；
   * **停用的條目也是 `undefined`**（它的設定根本沒驗）。
   */
  readonly config: unknown;
}

/** 錯誤訊息裡指名一次掛載的寫法，例如 `mcp-github (mcp)`。 */
export function formatOrigin(origin: PluginOrigin): string {
  return `${origin.id} (${origin.name})`;
}

/** 把 zod 的問題清單翻成「欄位路徑: 說明」，路徑空的時候講 `(root)`。 */
function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * 驗一個條目的形狀，並把 zod 的錯誤翻成指得出是清單裡哪一個的訊息。
 *
 * **這裡的訊息用清單位置指名，不用 id**：manifest 還沒驗過的時候，`id` 與 `name`
 * 都還不能信，位置是當下唯一可靠的說法。
 *
 * `id` 與 `disabled` 掛在**條目**上（#453 推翻 #104 的 (b)）。留在 plugin 物件上的那兩個
 * 欄位**明著擋下來**，不是靜靜忽略：型別上包不成條目的寫法編譯不過，但動態組出來的物件
 * 編譯器看不到，而「設了卻沒有作用」正是這張卡要消滅的那種病。
 *
 * @param entry - 待驗的條目。
 * @param index - 它在載入清單裡的位置。
 * @returns 通過驗證的兩份 manifest。
 */
export function parseEntry(
  entry: PluginEntry,
  index: number,
): { manifest: PluginManifest; entryManifest: EntryManifest } {
  const plugin: unknown = entry?.plugin;
  if (plugin === undefined || plugin === null) {
    // 清單元素從「plugin」換成「條目」之後最可能的寫法錯誤，直接講出改法。
    const looksLikePlugin = typeof (entry as { apply?: unknown })?.apply === 'function';
    throw new TypeError(
      looksLikePlugin
        ? `plugins[${index}] 看起來是一個 plugin，但清單的元素是條目——把它包成 { plugin: … }`
        : `plugins[${index}] 沒有 plugin 這一格，不是一個條目`,
    );
  }
  if (typeof (plugin as { apply?: unknown }).apply !== 'function') {
    throw new TypeError(`plugins[${index}].plugin 沒有 apply 方法，不是一個 NexusPlugin`);
  }
  for (const moved of ['id', 'disabled'] as const) {
    if (moved in (plugin as object)) {
      throw new TypeError(
        `plugins[${index}].plugin 上還留著 ${moved}——它已經搬到條目上了（#453）。` +
          `寫成 { ${moved}: …, plugin: … }，留在 plugin 上的那個不會有任何作用。`,
      );
    }
  }
  const parsedPlugin = pluginManifestSchema.safeParse(plugin);
  if (!parsedPlugin.success) {
    throw new TypeError(
      `plugins[${index}] 的 plugin manifest 不合法 — ${formatIssues(parsedPlugin.error.issues)}`,
    );
  }
  const parsedEntry = entryManifestSchema.safeParse(entry);
  if (!parsedEntry.success) {
    throw new TypeError(
      `plugins[${index}] 的條目不合法 — ${formatIssues(parsedEntry.error.issues)}`,
    );
  }
  return { manifest: parsedPlugin.data, entryManifest: parsedEntry.data };
}

/**
 * 驗一個條目的設定。
 *
 * 兩條規則各擋一種錯：
 *
 * - plugin **沒有** `Config` 卻給了 `config`——設了一份不會有任何作用的設定。
 * - plugin **有** `Config`：用 `config ?? {}` 去驗，預設值因此寫得進 schema。未知欄位
 *   讓它失敗（登記的偏離，見檔頭）。
 *
 * 訊息照 dsh 的 `<id> (<name>)`（`vendor/loader/src/config/entry.ts` 的 `id`／`name` 那一對），
 * 並附上欄位路徑——沒有路徑的話，一份十幾格的 YAML 設定錯在哪一格是猜的。
 *
 * @param entry - 待驗的條目。
 * @param plugin - 它掛的那顆 plugin。
 * @param origin - 已經解析好的身分，用來指名。
 * @returns 驗過的設定；plugin 沒有 `Config` 時是 `undefined`。
 */
export function parseEntryConfig(
  entry: PluginEntry,
  plugin: NexusPlugin<unknown>,
  origin: PluginOrigin,
): unknown {
  const schema = plugin.Config;
  if (schema === undefined) {
    if (entry.config === undefined) return undefined;
    throw new TypeError(
      `${formatOrigin(origin)} 不收 config——這顆 plugin 沒有 Config schema，` +
        `給它的設定不會有任何作用。`,
    );
  }
  const result = schema.safeParse(entry.config ?? {});
  if (!result.success) {
    throw new TypeError(
      `${formatOrigin(origin)} 的 config 不合法 — ${formatIssues(result.error.issues)}`,
    );
  }
  return result.data;
}

/**
 * 把一份清單解析成每一次掛載的身分與設定。
 *
 * 驗 manifest、補 id 與驗 config 在同一個地方，因為補號是**整份清單**的性質——逐個條目
 * 看不出來自己是第幾個 `mcp`，也看不出來有沒有人手寫了同一個 id。
 *
 * **三種失敗都在任何 `apply` 跑之前就報。** 重複的 id 尤其不能放過：它會讓之後每一則
 * 訊息同時指向兩次掛載，那比少載一個 plugin 更難查。設定的驗證排在補號**之後**，
 * 理由是它的訊息要指得出 id——而 id 這時候才發完。
 *
 * dsh 是每個 fiber 啟動時才驗自己那一份（`vendor/cordis/src/fiber.ts:50-62`），也就是
 * 邊跑邊驗。我們提早到全部驗完才開始跑，**只影響失敗路徑**：清單裡第三個條目的設定打錯
 * 時，前兩個的 `apply` 一次都不會跑，不會留下一個載了一半的 registry。
 *
 * 補號規則是 `<name>#<序號>`，序號從 0 起、**跳過已經被手寫 id 佔走的**。沒有隨機
 * 成分（dsh 的 `ensureId` 有，理由與射程見 {@link PluginOrigin}）。
 *
 * **停用的條目照樣編號、照樣回傳，但設定不驗。** 編號如果跳過它們，把一個 `mcp` 關掉就會
 * 讓它後面每一個 `mcp` 的 id 往前移一格——那正是 {@link PluginOrigin} 承諾之外、而且沒有人
 * 預期的位移。至於設定：`disabled` 的意思是「這一條整個不跑」，`requires` 已經因此不檢查，
 * 設定跟著不驗是同一條規則的同一面，也是 dsh 的行為（`Entry.refresh` 開頭就
 * `if (this.disabled) return`，根本走不到 `resolveConfig`）。打錯的那一格會在有人把它
 * 打開的那一次當場失敗——那時它才真的有作用。
 *
 * @param entries - 待解析的清單，順序有意義。
 * @returns 與清單等長、同序的掛載。
 * @throws 某個條目的形狀不合法、兩個條目寫了同一個 id、或某個條目的設定不合法——三種都
 *   指得出是清單裡哪一個。
 */
export function resolveEntries(entries: readonly PluginEntry[]): ResolvedPluginEntry[] {
  const parsed = entries.map((entry, index) => ({ entry, ...parseEntry(entry, index) }));

  // 先把手寫的 id 全部收進來再補號：補號要跳過它們，而它們可能出現在清單的任何位置。
  const taken = new Map<string, number>();
  for (const [index, { entryManifest }] of parsed.entries()) {
    if (entryManifest.id === undefined) continue;
    const owner = taken.get(entryManifest.id);
    if (owner !== undefined) {
      throw new Error(
        `plugins[${owner}] 與 plugins[${index}] 寫了同一個 id ${JSON.stringify(entryManifest.id)}。` +
          `id 是「哪一次掛載」的答案，兩個人共用它，之後每一則訊息都會同時指向兩個。`,
      );
    }
    taken.set(entryManifest.id, index);
  }

  const counters = new Map<string, number>();
  const resolved = parsed.map(({ entry, manifest, entryManifest }, index) => {
    const disabled = entryManifest.disabled ?? false;
    if (entryManifest.id !== undefined) {
      return { entry, origin: { id: entryManifest.id, name: manifest.name }, disabled };
    }
    let ordinal = counters.get(manifest.name) ?? 0;
    let id = `${manifest.name}#${ordinal}`;
    while (taken.has(id)) {
      ordinal += 1;
      id = `${manifest.name}#${ordinal}`;
    }
    counters.set(manifest.name, ordinal + 1);
    taken.set(id, index);
    return { entry, origin: { id, name: manifest.name }, disabled };
  });

  // **設定全部驗完才回傳**，不是邊回傳邊驗：`loadPlugins` 拿到清單就開始跑 `apply`，
  // 所以「第三個條目的設定打錯時第一個的 apply 不能跑」這條驗收句活在這一圈裡。
  return resolved.map(({ entry, origin, disabled }) => ({
    plugin: entry.plugin,
    origin,
    disabled,
    config: disabled ? undefined : parseEntryConfig(entry, entry.plugin, origin),
  }));
}
