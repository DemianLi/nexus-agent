/**
 * 載入：把一份 plugin 清單跑進一個 registry。
 *
 * **與 dsh 的偏離**（AGENTS.md 的偏離規則）：dsh 的撤銷靠 Cordis 的
 * `ctx.effect`——每次註冊的 undo 掛在註冊者的 context 上，context 一收掉就整批
 * 回收。deepagents / LangChain JS / LangGraph JS 沒有 context 樹這種東西，表達
 * 不出來，所以退到最接近的實作：**per-plugin 的 undo 堆疊，出錯時逆序排掉**。
 * 射程因此限定為載入期回滾，不承諾執行期熱插拔——deepagents 建構後本來就不可變。
 */

import { createRegistry } from './registry.js';
import type { InternalPluginRegistry } from './registry.js';
import { formatOrigin, resolveEntries } from './plugin.js';
import type { NexusPlugin, PluginEntry, PluginOrigin } from './plugin.js';

export interface LoadResult {
  /** 載入完成的 registry，接著交給 fold。 */
  registry: InternalPluginRegistry;
  /**
   * 依清單順序的每一次掛載，錯誤訊息與診斷用。
   *
   * **停用的也在裡面**（`entry.disabled` 是 `true`）。那是 `disabled: true` 與「把這一行
   * 刪掉」的差別所在：關著的條目仍然指得出名字，診斷才講得出「它在清單裡，只是關著」。
   */
  entries: readonly PluginEntry[];
  /**
   * 收掉 plugin 經 `lifecycle.onDispose()` 登記的東西，逆序、冪等。
   *
   * **不碰 registry 上的註冊內容**——agent 建構完之後那些是基座的了，撤掉也追不回去。
   * 這裡收的是 plugin 自己開的活資源（MCP 的 stdio 子行程是第一個）。
   */
  dispose: () => Promise<void>;
}

/**
 * 依序跑完一份 plugin 清單。
 *
 * 任何一個 plugin 的 `apply` 拋錯，先把它自己註冊過的東西逆序撤乾淨，再讓整個
 * 載入失敗——fail-closed，不接受「載了一半的 agent」。先前成功的 plugin 註冊的
 * 東西留在 registry 上不動，錯誤處理與診斷才有東西可看。
 *
 * 帶 `disabled: true` 的條目**整個跳過**——`apply` 不跑、`requires` 不驗。它仍然佔著
 * 自己的 id 與回傳的 `entries` 裡的位置，理由見 {@link ../plugin.ts | NexusPlugin.disabled}。
 *
 * @param plugins - 待載入的清單，順序有意義。
 * @param registry - 要載入進去的 registry，省略即開一個新的。
 * @returns 載入結果。
 */
export async function loadPlugins(
  plugins: readonly NexusPlugin[],
  registry: InternalPluginRegistry = createRegistry(),
): Promise<LoadResult> {
  // **整份清單先解析完才開始跑。** 補 id 與抓重複 id 都是整份清單的性質，而且這兩種
  // 失敗要發生在任何 `apply` 之前——已經有 plugin 掛上去之後才發現身分是壞的，那些
  // 註冊留在 registry 上就沒有名字可以指。
  const entries = resolveEntries(plugins);

  for (const { plugin, origin, disabled } of entries) {
    // **停用＝`apply` 一次都不跑**，不是「跑了再撤」。照 dsh 的載入路徑：`refresh()`
    // 開頭就是 `if (this.disabled) return`（`vendor/loader/src/config/entry.ts` 的
    // `Entry.refresh`），從來不 `init()`。dsh 那條「跑了再撤」只存在於 `update()`
    // ——即時重載的路徑，而我們**沒有** `update()`，設定只在組裝時讀一次。
    if (disabled) continue;
    const undos: (() => void)[] = [];
    const tracked = trackUndo(registry, undos);
    const leave = registry.enter(origin);
    try {
      await plugin.apply(tracked);
    } catch (error) {
      for (const undo of undos.reverse()) undo();
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
  return { registry, entries, dispose: () => disposeAll(registry) };
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
 * 包一層 registry，把這一輪 `apply` 拿到的每個 undo 都記進堆疊。
 *
 * 只包會產生 undo 的方法——讀取路徑原封轉發，plugin 在自己的 `apply` 裡讀得到
 * 先前 plugin 註冊的東西。**九個註冊點一個都不能漏**：漏掉的那個不會有任何現有測試
 * 發現，只會在回滾時默默留下一筆孤兒。`load.test.ts` 有一條九個點各註冊一樣東西後
 * throw 的測試守著這件事。
 *
 * `lifecycle` 也在追蹤範圍，但它撤銷的意思不同：撤掉的是**登記**，不是跑那個清理。
 * 回滾期的資源釋放由 plugin 自己的 `try` / `catch` 負責——理由見
 * {@link ../registry.ts} 的 `LifecycleRegistrationPoint`。
 *
 * `telemetry` 兩個方法都要追：`use` 漏了會讓回滾過的 plugin 佔著那個唯一的後端
 * 位子，後面的 plugin 掛不上去卻看不出為什麼；`redact` 漏了會留下一條沒有主人的
 * 脫敏規則，而它是在熱路徑上同步跑的。
 */
function trackUndo(
  registry: InternalPluginRegistry,
  undos: (() => void)[],
): InternalPluginRegistry {
  const remember = (undo: () => void): (() => void) => {
    undos.push(undo);
    return undo;
  };
  return {
    ...registry,
    tools: {
      ...registry.tools,
      register: (tool, options) => remember(registry.tools.register(tool, options)),
    },
    subagents: {
      ...registry.subagents,
      register: (subagent) => remember(registry.subagents.register(subagent)),
    },
    capabilities: {
      ...registry.capabilities,
      provide: (name) => remember(registry.capabilities.provide(name)),
    },
    backend: {
      ...registry.backend,
      mount: (routePrefix, backend) => remember(registry.backend.mount(routePrefix, backend)),
    },
    middleware: {
      ...registry.middleware,
      use: (middleware, options) => remember(registry.middleware.use(middleware, options)),
    },
    permissions: {
      ...registry.permissions,
      deny: (paths, options) => remember(registry.permissions.deny(paths, options)),
    },
    interrupts: {
      ...registry.interrupts,
      require: (toolName, options) => remember(registry.interrupts.require(toolName, options)),
    },
    skills: {
      ...registry.skills,
      addSource: (path) => remember(registry.skills.addSource(path)),
    },
    memory: {
      ...registry.memory,
      addSource: (path) => remember(registry.memory.addSource(path)),
    },
    lifecycle: {
      ...registry.lifecycle,
      onDispose: (dispose) => remember(registry.lifecycle.onDispose(dispose)),
    },
    telemetry: {
      ...registry.telemetry,
      redact: (rule) => remember(registry.telemetry.redact(rule)),
      use: (service) => remember(registry.telemetry.use(service)),
    },
  };
}

/**
 * 全部 `apply` 跑完之後才驗 `requires`。
 *
 * 只能是之後：`requires` 明文不排序，清單裡靠前的 plugin 需要的能力可以由靠後的
 * plugin 提供。
 *
 * **停用的條目兩邊都不算**：它的 `requires` 不檢查（沒跑的東西不需要任何能力），而它
 * 本來會提供的能力也真的沒被提供。所以缺件訊息把它們列出來——`disabled` 一加進來，
 * 「我關錯了東西」就會是這條錯誤最常見的原因，而那件事從「有能力沒人提供」看不出來。
 */
function assertRequires(entries: readonly PluginEntry[], registry: InternalPluginRegistry): void {
  const missing: string[] = [];
  for (const { plugin, origin, disabled } of entries) {
    if (disabled) continue;
    for (const capability of plugin.requires ?? []) {
      if (!registry.capabilities.has(capability)) {
        missing.push(`${formatOrigin(origin)} 需要能力 "${capability}"`);
      }
    }
  }
  if (missing.length === 0) return;
  const available = registry.capabilities.names();
  const known = available.length === 0 ? '（沒有任何 plugin 宣告能力）' : available.join('、');
  const off = entries.filter((entry) => entry.disabled).map((entry) => formatOrigin(entry.origin));
  const hint =
    off.length === 0 ? '' : `。清單裡有停用的條目，它們一個能力都沒提供：${off.join('、')}`;
  throw new Error(
    `載入失敗，有能力沒人提供：${missing.join('；')}。目前被提供的能力：${known}${hint}`,
  );
}
