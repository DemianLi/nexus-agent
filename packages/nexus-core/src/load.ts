/**
 * 載入：把一份 plugin 清單跑進一個 registry。
 *
 * **與 dsh 的偏離**（AGENTS.md 的偏離規則）：dsh 的撤銷靠 Cordis 的
 * `ctx.effect`——每次註冊的 undo 掛在註冊者的 context 上，context 一收掉就整批
 * 回收。deepagents / LangChain JS / LangGraph JS 沒有 context 樹這種東西，表達
 * 不出來，所以退到最接近的實作：**registry 內、以註冊者為單位的 undo 堆疊，出錯時逆序排掉**。
 * 載體跟 dsh 一樣掛在註冊點上——每個回傳 undo 的註冊方法自己經 `effect` 記下撤銷
 * （見 {@link ./registry.ts | InternalPluginRegistry.rollback}），載入器只在失敗時叫一次
 * 回滾，不替註冊方法鏡像一份表。射程因此限定為載入期回滾，不承諾執行期熱插拔——
 * deepagents 建構後本來就不可變。
 */

import { createRegistry } from './registry.js';
import type { Disposer, InternalPluginRegistry, PluginRegistry } from './registry.js';
import { formatOrigin, resolveEntries, resolveEntriesPerEntry } from './plugin.js';
import type { PluginEntry, PluginOrigin, ResolvedPluginEntry } from './plugin.js';

export interface LoadResult {
  /** 載入完成的 registry，接著交給 fold。 */
  registry: InternalPluginRegistry;
  /**
   * 依清單順序的每一次掛載，錯誤訊息與診斷用。
   *
   * **停用的也在裡面**（`entry.disabled` 是 `true`）。那是 `disabled: true` 與「把這一行
   * 刪掉」的差別所在：關著的條目仍然指得出名字，診斷才講得出「它在清單裡，只是關著」。
   */
  entries: readonly ResolvedPluginEntry[];
  /**
   * 這一次掉了的條目，依發生順序。**只有 {@link LoadOptions.perEntry} 開著時才可能不空**：預設模式下一列
   * 失敗就整個拋，走不到回傳。
   */
  dropped: readonly DroppedEntry[];
  /**
   * 收掉 plugin 經 `lifecycle.onDispose()` 登記的東西，逆序、冪等。
   *
   * **不碰 registry 上的註冊內容**——agent 建構完之後那些是基座的了，撤掉也追不回去。
   * 這裡收的是 plugin 自己開的活資源（MCP 的 stdio 子行程是第一個）。
   */
  dispose: () => Promise<void>;
}

/** 一列掉在哪一步。 */
export type DropStage = 'config' | 'apply' | 'requires';

/** 逐列掉模式下掉了的一列。 */
export interface DroppedEntry {
  readonly origin: PluginOrigin;
  readonly stage: DropStage;
  /** 指名那一列的完整訊息，跟預設模式下同一種失敗拋的訊息同一句。 */
  readonly message: string;
  readonly cause: unknown;
}

export interface LoadOptions {
  /**
   * **逐列掉**（[#751](https://github.com/DemianLi/nexus-agent/issues/751)），照 dsh 的載入器：一列自己的失敗只讓
   * 那一列掉，其他列照樣掛上，掉了哪幾列從 {@link LoadResult.dropped} 讀。
   *
   * dsh 的載入器本身不管嚴不嚴，嚴格的語意由用它的那一方持有：app-boot 全部結算之後才套必掛名單
   * （dsh `packages/boot/app-boot/README.zh.md:137`，`477b4f4`）。所以**哪幾列掉了要整個失敗，由呼叫端判**，
   * 不在這裡。呼叫端判出要整個失敗時，自己 {@link LoadResult.dispose}。
   *
   * 一列自己的失敗有三種，各對到 {@link DropStage}：
   *
   * - `config`：設定驗不過。
   * - `apply`：`apply` 拋錯，或 {@link afterApply} 拋錯。照預設模式先撤掉它自己的註冊，但**不收其他列的資源**。
   * - `requires`：宣告要的能力或服務沒人提供。**連鎖照 dsh**：一列掉了，要用它服務的列也掉
   *   （dsh `packages/boot/app-boot/README.zh.md:109`）。它的 `apply` 已經跑完、可能開了資源，所以先跑它自己登記的
   *   清理，再撤它的註冊。dsh 的可少掛列在這一格是等著（`:103`）；我們的載入一趟到底、表達不出等待
   *   （`.docs/development-plan.md` 已登記），退到那一列掉了。
   *
   * 整份清單的性質照舊整個拋：條目形狀不合法、兩個條目寫了同一個 id（dsh 失敗表第一列，`:96`）。
   *
   * 掉了的列**算沒掛**，跟 `disabled: true` 一樣經 `markDisabled` 標記，折疊那側照停用處理。
   *
   * 省略即預設模式：一列失敗就整個失敗，手搭清單的呼叫端靠它。
   */
  readonly perEntry?: boolean;
  /**
   * 每一列 `apply` 跑完之後的檢查，拋錯就算那一列 `apply` 失敗（訊息裡講的是它拋的那一句）。
   *
   * 給只有呼叫端知道的規則用，例如撞到基座保留的工具名：名單在 harness，載入器不知道。
   *
   * @param registry - 載入中的 registry。
   * @param origin - 剛跑完 `apply` 的那一列。
   */
  readonly afterApply?: (registry: PluginRegistry, origin: PluginOrigin) => void;
}

/**
 * 依序跑完一份 plugin 清單。
 *
 * 任何一個 plugin 的 `apply` 拋錯，先把它自己註冊過的東西逆序撤乾淨，再讓整個
 * 載入失敗——fail-closed，不接受「載了一半的 agent」。先前成功的 plugin 註冊的
 * 東西留在 registry 上不動，錯誤處理與診斷才有東西可看。
 *
 * 帶 `disabled: true` 的條目**整個跳過**——`apply` 不跑、`requires` 不驗、`config` 不驗。
 * 它仍然佔著自己的 id 與回傳的 `entries` 裡的位置，理由見
 * {@link ../plugin.ts | PluginEntry.disabled}。
 *
 * 逐列掉的模式見 {@link LoadOptions.perEntry}。
 *
 * @param plugins - 待載入的條目清單，順序有意義。
 * @param registry - 要載入進去的 registry，省略即開一個新的。
 * @param options - 省略即預設模式。
 * @returns 載入結果。
 */
export async function loadPlugins(
  plugins: readonly PluginEntry[],
  registry: InternalPluginRegistry = createRegistry(),
  options: LoadOptions = {},
): Promise<LoadResult> {
  if (options.perEntry === true) return loadPerEntry(plugins, registry, options);
  // **整份清單先解析完才開始跑。** 補 id、抓重複 id 與驗設定都是整份清單的性質，而且這三種
  // 失敗要發生在任何 `apply` 之前——已經有 plugin 掛上去之後才發現身分或設定是壞的，那些
  // 註冊留在 registry 上就沒有名字可以指。
  const entries = resolveEntries(plugins);

  for (const { plugin, origin, disabled, config } of entries) {
    // **停用＝`apply` 一次都不跑**，不是「跑了再撤」。照 dsh 的載入路徑：`refresh()`
    // 開頭就是 `if (this.disabled) return`（`vendor/loader/src/config/entry.ts` 的
    // `Entry.refresh`），從來不 `init()`。dsh 那條「跑了再撤」只存在於 `update()`
    // ——即時重載的路徑，而我們**沒有** `update()`，設定只在組裝時讀一次。
    if (disabled) {
      // **跳過之前留一個痕跡。** 少了這一行，「這一顆沒有提供服務」的兩種成因——被關掉、
      // 與這次組裝根本沒有經過部署設定層——在折疊那側長得一模一樣，而正確答案相反
      // （[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。理由見
      // {@link ./registry.ts | DisabledEntryView}。
      registry.markDisabled(plugin.name);
      continue;
    }
    const leave = registry.enter(origin);
    try {
      // `config` 是 `resolveEntries` 驗過的那一份（沒有 `Config` 的 plugin 是條目上原樣的那一份）。
      await plugin.apply(registry, config);
      options.afterApply?.(registry, origin);
    } catch (error) {
      registry.rollback(origin);
      // **註冊內容留著、活資源不留。** 先前成功的 plugin 的註冊留在 registry 上是刻意的
      // （錯誤處理與診斷要有東西可看），但它們開的連線與子行程沒有這個理由——載入失敗
      // 的呼叫端拿到的是一個 exception，不是 handle，沒有第二個人知道那些東西還開著。
      // 清理自己失敗的話不能蓋掉原本的錯誤：那個才是使用者要修的。
      await disposeAll(registry).catch(() => {});
      // 把原因接進訊息本身，不只掛在 cause 上：重名錯誤的價值是指名撞的是哪兩個
      // plugin 與哪個名字，而只印 `error.message` 是錯誤處理最常見的形狀。
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${formatOrigin(origin)} 的 apply 失敗，它註冊的東西已全數撤銷 — ${reason}`, {
        cause: error,
      });
    } finally {
      leave();
    }
  }

  try {
    assertRequires(entries, registry);
  } catch (error) {
    // `requires` 缺件跟 `apply` 拋錯同一個道理：載入沒成功，呼叫端拿不到 `dispose`。
    await disposeAll(registry).catch(() => {});
    throw error;
  }
  return { registry, entries, dropped: [], dispose: () => disposeAll(registry) };
}

/** 掛上了、還可能因 `requires` 連鎖掉的一列。 */
interface Mounted {
  readonly entry: ResolvedPluginEntry;
}

/** {@link LoadOptions.perEntry} 的那一條路。 */
async function loadPerEntry(
  plugins: readonly PluginEntry[],
  registry: InternalPluginRegistry,
  options: LoadOptions,
): Promise<LoadResult> {
  const resolutions = resolveEntriesPerEntry(plugins);
  const dropped: DroppedEntry[] = [];
  const drop = (entry: DroppedEntry): void => {
    dropped.push(entry);
    registry.markDisabled(entry.origin.name);
  };
  const mounted: Mounted[] = [];

  for (const { plugin, origin, disabled, config, configError } of resolutions) {
    if (disabled) {
      registry.markDisabled(plugin.name);
      continue;
    }
    if (configError !== undefined) {
      drop({ origin, stage: 'config', message: configError.message, cause: configError });
      continue;
    }
    const leave = registry.enter(origin);
    try {
      await plugin.apply(registry, config);
      options.afterApply?.(registry, origin);
      mounted.push({ entry: { plugin, origin, disabled, config } });
    } catch (error) {
      registry.rollback(origin);
      const reason = error instanceof Error ? error.message : String(error);
      drop({
        origin,
        stage: 'apply',
        message: `${formatOrigin(origin)} 的 apply 失敗，它註冊的東西已全數撤銷 — ${reason}`,
        cause: error,
      });
    } finally {
      leave();
    }
  }

  // **連鎖到不再有人掉為止**：一列掉了，它提供的能力與服務跟著撤掉，要用它們的下一輪才看得到。
  for (let changed = true; changed;) {
    changed = false;
    for (const item of [...mounted]) {
      const missing = (item.entry.plugin.requires ?? []).filter(
        (capability) =>
          !registry.capabilities.has(capability) &&
          registry.services.provider(capability) === undefined,
      );
      if (missing.length === 0) continue;
      mounted.splice(mounted.indexOf(item), 1);
      // 要先跑它自己登記的清理再撤它的註冊：撤了登記，就找不到是哪幾個了。
      const own = registry.lifecycle
        .disposers()
        .filter((disposer) => disposer.origin === item.entry.origin)
        .map((disposer) => disposer.value);
      const cleanup = await runOwn(own);
      registry.rollback(item.entry.origin);
      const gone = dropped.map((entry) => formatOrigin(entry.origin));
      const hint = gone.length === 0 ? '' : `。這一次掉了的條目：${gone.join('、')}`;
      drop({
        origin: item.entry.origin,
        stage: 'requires',
        message:
          `${formatOrigin(item.entry.origin)} 需要能力 ${missing.map((name) => `"${name}"`).join('、')}，` +
          `沒有人提供，它註冊的東西已全數撤銷${hint}${cleanup}`,
        cause: undefined,
      });
      changed = true;
    }
  }

  return {
    registry,
    entries: resolutions.map(({ plugin, origin, disabled, config }) => ({
      plugin,
      origin,
      disabled,
      config,
    })),
    dropped,
    dispose: () => disposeAll(registry),
  };
}

/**
 * 逆序跑完一列自己登記的清理，失敗不拋：要掉的那一列已經在掉了，清理失敗附在它的訊息後面。
 *
 * @returns 空字串，或一段接在訊息後面的說明。
 */
async function runOwn(disposers: readonly Disposer[]): Promise<string> {
  const reasons: string[] = [];
  for (const dispose of [...disposers].reverse()) {
    try {
      await dispose();
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }
  return reasons.length === 0 ? '' : `；收掉它開的資源時也失敗了：${reasons.join('；')}`;
}

/**
 * 逆序跑完所有登記的清理。
 *
 * 三件事刻意這樣：**逆序**（後開的先收，與回滾同一個方向）、**跑完才報錯**（關機途中
 * 有人拋錯不是停下來的理由——剩下的資源更需要被收掉），以及**跑過就撤掉登記**，
 * 所以呼叫第二次是 no-op，不必另外記一個旗標。
 *
 * @param registry - 載入完成的 registry。
 * @throws 有清理拋錯時，訊息指名是哪幾個 plugin 的，並把第一個原因掛在 `cause` 上。
 */
async function disposeAll(registry: InternalPluginRegistry): Promise<void> {
  const failures: { origin: PluginOrigin; error: unknown }[] = [];
  for (const entry of registry.lifecycle.takeDisposers().reverse()) {
    try {
      await entry.value();
    } catch (error) {
      failures.push({ origin: entry.origin, error });
    }
  }
  if (failures.length === 0) return;
  const detail = failures
    .map(({ origin, error }) => {
      const reason = error instanceof Error ? error.message : String(error);
      return `${formatOrigin(origin)} — ${reason}`;
    })
    .join('；');
  throw new Error(`關機清理有失敗的：${detail}。其餘的清理都已經跑過了。`, {
    cause: failures[0]?.error,
  });
}

/**
 * 全部 `apply` 跑完之後才驗 `requires`。
 *
 * 只能是之後：`requires` 明文不排序，清單裡靠前的 plugin 需要的能力可以由靠後的
 * plugin 提供。
 *
 * **能力與服務兩邊都查**（[#459](https://github.com/DemianLi/nexus-agent/issues/459)）。
 * 服務名**不寫進 `capabilities`**：寫進去的話，一句與任何服務都無關的
 * `capabilities.provide('sandboxPolicy')` 就能滿足 `requires: ['sandboxPolicy']`，
 * 而那條 `requires` 要的是真的有東西可以 `use()`。兩個集合的碰撞政策也不同
 * （能力冪等多提供者、服務單一佔位），合成一個就得犧牲一邊。
 *
 * **這裡是事後的網，不是唯一的閘門**：硬相依在 `services.use()` 當下就拋，訊息更精準
 * （消費者不會先撞上一個 `undefined`）。這條守的是「宣告了 `requires` 卻從來沒 `use()`」
 * 的那一半。
 *
 * **停用的條目兩邊都不算**：它的 `requires` 不檢查（沒跑的東西不需要任何能力），而它
 * 本來會提供的能力也真的沒被提供。所以缺件訊息把它們列出來——`disabled` 一加進來，
 * 「我關錯了東西」就會是這條錯誤最常見的原因，而那件事從「有能力沒人提供」看不出來。
 */
function assertRequires(
  entries: readonly ResolvedPluginEntry[],
  registry: InternalPluginRegistry,
): void {
  const missing: string[] = [];
  for (const { plugin, origin, disabled } of entries) {
    if (disabled) continue;
    for (const capability of plugin.requires ?? []) {
      if (registry.capabilities.has(capability)) continue;
      if (registry.services.provider(capability) !== undefined) continue;
      missing.push(`${formatOrigin(origin)} 需要能力 "${capability}"`);
    }
  }
  if (missing.length === 0) return;
  const available = [...registry.capabilities.names(), ...registry.services.names()];
  const known =
    available.length === 0 ? '（沒有任何 plugin 宣告能力或提供服務）' : available.join('、');
  const off = entries.filter((entry) => entry.disabled).map((entry) => formatOrigin(entry.origin));
  const hint =
    off.length === 0 ? '' : `。清單裡有停用的條目，它們一個能力都沒提供：${off.join('、')}`;
  throw new Error(
    `載入失敗，有能力沒人提供：${missing.join('；')}。目前被提供的能力：${known}${hint}`,
  );
}
