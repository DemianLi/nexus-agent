/**
 * NexusPlugin 契約本身：plugin 的形狀、它的 manifest 驗證，以及「是誰註冊的」這個身分。
 */

import { z } from 'zod';
import type { PluginRegistry } from './registry.js';

/**
 * 一個 plugin。`apply` 是命令式註冊——plugin 拿到 registry，自己決定往哪幾個
 * 擴充點放東西，而不是交出一份靜態宣告讓 harness 去解讀。
 */
export interface NexusPlugin {
  /**
   * **這一次掛載**的識別。省略即由 {@link resolveEntries} 補一個 `<name>#<序號>`。
   *
   * 要一個不隨清單變動的名字就自己寫——`name` 不用動，它本來就不唯一：
   *
   * ```ts
   * { ...createMcpPlugin({ server: 'github' }), id: 'mcp-github' }
   * ```
   *
   * 射程見 {@link PluginOrigin}。
   */
  id?: string;
  /**
   * 這一次掛載**不要跑**。`apply` 一次都不會被呼叫，所以它不註冊任何東西、也不宣告
   * 任何能力；它的 {@link requires} 跟著不檢查（沒跑的東西不需要任何能力）。
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
  disabled?: boolean;
  /**
   * 純標籤，唯一用途是錯誤訊息指名。**不唯一**：同一個 plugin 工廠掛載多次是
   * 合法的（`createMcpPlugin({ server: 'github' })` 與
   * `createMcpPlugin({ server: 'linear' })` 都叫 `mcp`），真撞了會撞在它們註冊
   * 的東西那一層，不是在這裡。指認某一次掛載是 {@link id} 的工作。
   */
  name: string;
  /**
   * 需要的能力名，不是 plugin 名。只做存在性檢查、不排序——載入順序由清單決定，
   * `requires` 不參與。
   */
  requires?: string[];
  apply(registry: PluginRegistry): void | Promise<void>;
}

/**
 * manifest 只驗 `id` / `name` / `requires`。擴充內容不驗：那些東西的合法性由各註冊點
 * 自己的規則守（同名 tool、同名 subagent），驗兩次只會讓規則有兩個出處。
 *
 * `id` 的前後空白擋在這裡而不是靜默 trim：**id 會原樣出現在每一則錯誤訊息裡**，
 * 一個看不見的空白讓兩個長得一樣的 id 是兩個東西。
 */
export const pluginManifestSchema = z.object({
  id: z
    .string()
    .min(1, 'plugin 的 id 不能是空字串')
    .refine((value) => value.trim() === value, 'plugin 的 id 不能有前後空白')
    .optional(),
  name: z.string().min(1, 'plugin 的 name 不能是空字串'),
  requires: z.array(z.string().min(1, 'requires 裡的能力名不能是空字串')).optional(),
  // **一定要驗**：不驗的話 `disabled: 'false'` 這種寫法會是真值，一個以為自己開著的
  // plugin 靜靜地不跑，而且沒有任何訊息。
  disabled: z.boolean().optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/**
 * 某次掛載的身分。
 *
 * **`id` 在一次 {@link resolveEntries} 裡唯一**，plugin 自己沒寫就補一個
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

/** 一份清單解析出來的一次掛載：那個 plugin，配上它這一次的身分。 */
export interface PluginEntry {
  readonly plugin: NexusPlugin;
  readonly origin: PluginOrigin;
  /** 這一次掛載關著——{@link NexusPlugin.disabled} 的解析結果，省略即 `false`。 */
  readonly disabled: boolean;
}

/** 錯誤訊息裡指名一次掛載的寫法，例如 `mcp-github (mcp)`。 */
export function formatOrigin(origin: PluginOrigin): string {
  return `${origin.id} (${origin.name})`;
}

/**
 * 驗一個 plugin 的 manifest，並把 zod 的錯誤翻成指得出是清單裡哪一個的訊息。
 *
 * **這裡的訊息用清單位置指名，不用 id**：manifest 還沒驗過的時候，`id` 與 `name`
 * 都還不能信，位置是當下唯一可靠的說法。
 *
 * @param plugin - 待驗的 plugin。
 * @param index - 它在載入清單裡的位置。
 * @returns 通過驗證的 manifest。
 */
export function parsePluginManifest(plugin: NexusPlugin, index: number): PluginManifest {
  if (typeof plugin?.apply !== 'function') {
    throw new TypeError(`plugins[${index}] 沒有 apply 方法，不是一個 NexusPlugin`);
  }
  const result = pluginManifestSchema.safeParse(plugin);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new TypeError(`plugins[${index}] 的 manifest 不合法 — ${detail}`);
  }
  return result.data;
}

/**
 * 把一份清單解析成每一次掛載的身分。
 *
 * 驗 manifest 與補 id 在同一個地方，因為補號是**整份清單**的性質——逐個 plugin
 * 看不出來自己是第幾個 `mcp`，也看不出來有沒有人手寫了同一個 id。
 *
 * **兩種失敗都在任何 `apply` 跑之前就報。** 重複的 id 尤其不能放過：它會讓之後每一則
 * 訊息同時指向兩次掛載，那比少載一個 plugin 更難查。
 *
 * 補號規則是 `<name>#<序號>`，序號從 0 起、**跳過已經被手寫 id 佔走的**。沒有隨機
 * 成分（dsh 的 `ensureId` 有，理由與射程見 {@link PluginOrigin}）。
 *
 * **停用的條目照樣編號、照樣回傳。** 編號如果跳過它們，把一個 `mcp` 關掉就會讓它後面
 * 每一個 `mcp` 的 id 往前移一格——那正是 {@link PluginOrigin} 承諾之外、而且沒有人
 * 預期的位移。要不要跑是載入那一層的事（見 {@link ../load.ts | loadPlugins}），
 * 不是身分這一層的。
 *
 * @param plugins - 待解析的清單，順序有意義。
 * @returns 與清單等長、同序的掛載。
 * @throws 某個 manifest 不合法，或兩個 plugin 手寫了同一個 id——兩種都指得出是清單裡
 *   哪一個。
 */
export function resolveEntries(plugins: readonly NexusPlugin[]): PluginEntry[] {
  const parsed = plugins.map((plugin, index) => ({
    plugin,
    manifest: parsePluginManifest(plugin, index),
  }));

  // 先把手寫的 id 全部收進來再補號：補號要跳過它們，而它們可能出現在清單的任何位置。
  const taken = new Map<string, number>();
  for (const [index, { manifest }] of parsed.entries()) {
    if (manifest.id === undefined) continue;
    const owner = taken.get(manifest.id);
    if (owner !== undefined) {
      throw new Error(
        `plugins[${owner}] 與 plugins[${index}] 寫了同一個 id ${JSON.stringify(manifest.id)}。` +
          `id 是「哪一次掛載」的答案，兩個人共用它，之後每一則訊息都會同時指向兩個。`,
      );
    }
    taken.set(manifest.id, index);
  }

  const counters = new Map<string, number>();
  return parsed.map(({ plugin, manifest }, index) => {
    const disabled = manifest.disabled ?? false;
    if (manifest.id !== undefined) {
      return { plugin, origin: { id: manifest.id, name: manifest.name }, disabled };
    }
    let ordinal = counters.get(manifest.name) ?? 0;
    let id = `${manifest.name}#${ordinal}`;
    while (taken.has(id)) {
      ordinal += 1;
      id = `${manifest.name}#${ordinal}`;
    }
    counters.set(manifest.name, ordinal + 1);
    taken.set(id, index);
    return { plugin, origin: { id, name: manifest.name }, disabled };
  });
}
