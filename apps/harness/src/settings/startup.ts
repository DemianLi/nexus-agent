/**
 * 起動期讀一顆**只講設定的條目**（[#529](https://github.com/DemianLi/nexus-agent/issues/529)）。
 *
 * ## 為什麼不是走服務
 *
 * #456 那幾列的消費者是 `foldRegistry`，它手上有註冊表，所以設定走「`apply` 提供一顆服務、
 * fold 去讀」。**這一層沒有那個選項**：至少有一個消費者（`serve.ts` 的冷讀清單、`BrowserAuth` 的建構子）
 * 跑在任何 agent 出生之前，那一刻註冊表還不存在。
 *
 * 能做到的是「**起動期解一次、往下傳一份**」——形狀上仍是「值從一個地方來」，機制上不是
 * cordis 服務。這條偏離登記在 #529 上，射程就是這個函式的呼叫者。
 *
 * **值仍然是驗過的**：`parseEntryConfig` 是 `@nexus/core` 匯出的純函式，跟組裝期用的是同一支，
 * 所以「不合法的值在載入時就失敗」這條驗收在這一層照樣成立，而且失敗訊息跟組裝期同一種。
 *
 * ## 沒有那一列的時候
 *
 * 回 schema 的預設值。**那不是退讓，是 dsh 的常態**：`workspace-files` 在 dsh 就是一列沒寫
 * `config:` 的列，吃 schema 預設。我們多一種情形——**連列都沒有**（手搭清單的測試、或一份把它
 * 拿掉的 patch），兩種都回同一份預設值，因為「沒人講」的答案只有一個。
 *
 * @module
 */

import { parseEntryConfig } from '@nexus/core';
import type { NexusPlugin, PluginEntry } from '@nexus/core';

/**
 * 從這一次的條目清單裡讀出某一顆只講設定的 plugin 的設定。
 *
 * **以 `plugin.name` 比對，不是物件identity**：同一個檔經由 `#settings/…`（條目）與
 * `./settings/…`（原始碼）兩個 specifier 進來，今天解析到同一個 URL、因此是同一顆物件——但那是
 * 一個會隨打包方式改變的巧合，不是契約。名字是契約。
 *
 * **關掉的那一列當成沒有那一列**。只講設定的那幾列大多在 `PROTECTED_ENTRY_NAMES` 上，關了會在
 * 載入期拋，所以對它們走不到；留著是因為判斷「關掉＝沒講」比「關掉＝undefined 然後炸在別處」
 * 好讀。**也正因為這樣，它不能拿來判「那一列掛了沒」**——關掉與預設在這裡長得一模一樣。
 * 關得掉的那一列（落盤，#612）要另外問 {@link startupEntryMounted}。
 *
 * @param plugins - 這一次解析好的條目清單。
 * @param plugin - 要讀誰的設定。
 * @returns 驗過的設定；清單上沒有那一列就是 schema 的預設值。
 * @throws {TypeError} 那一列的 `config` 不合法，訊息與組裝期同一種。
 */
export function startupSetting<T>(plugins: readonly PluginEntry[], plugin: NexusPlugin<T>): T {
  const found = plugins.find(
    (entry) => entry.plugin.name === plugin.name && entry.disabled !== true,
  );
  const entry: PluginEntry = found ?? { plugin: plugin as NexusPlugin<unknown> };
  return parseEntryConfig(entry, plugin as NexusPlugin<unknown>, {
    id: found?.id ?? plugin.name,
    name: plugin.name,
  }) as T;
}

/**
 * 某一顆起動期的 plugin 這一次**有沒有掛**：清單上有它、而且沒寫 `disabled: true`。
 *
 * **語意照 dsh：沒有那一列就是沒掛。** dsh 的會話落盤是清單上的一列
 * （`session-persistence-jsonl`，`packages/bundle/base/cordis.patch.yml:130-133`，`477b4f4`），
 * 不掛就沒有持久化服務，消費端各自 `ctx.get('sessionPersistence')` 拿到 `undefined`。
 * 產品路徑上那一列一定在（出貨的 `cordis.yml` 寫著它，patch 刪不掉列），所以「沒有那一列」
 * 只發生在手搭清單的呼叫端——那裡照 dsh 算沒掛，不另發明一個「沒講就開」。
 *
 * **跟 {@link startupSetting} 分開是承重的**：那一支把關掉的列當成沒有、回 schema 預設，
 * 拿它判開關會讀成「永遠開著」——正是 #612 要擋的那個誤會。
 *
 * @param plugins - 這一次解析好的條目清單。
 * @param plugin - 要問的是誰。
 * @returns 掛了就是 `true`。
 */
export function startupEntryMounted<T>(
  plugins: readonly PluginEntry[],
  plugin: NexusPlugin<T>,
): boolean {
  return plugins.some((entry) => entry.plugin.name === plugin.name && entry.disabled !== true);
}
