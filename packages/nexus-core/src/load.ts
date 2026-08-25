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
import { formatOrigin, parsePluginManifest } from './plugin.js';
import type { NexusPlugin, PluginOrigin } from './plugin.js';

export interface LoadResult {
  /** 載入完成的 registry，接著交給 fold。 */
  registry: InternalPluginRegistry;
  /** 依清單順序的來源，錯誤訊息與診斷用。 */
  origins: PluginOrigin[];
}

/**
 * 依序跑完一份 plugin 清單。
 *
 * 任何一個 plugin 的 `apply` 拋錯，先把它自己註冊過的東西逆序撤乾淨，再讓整個
 * 載入失敗——fail-closed，不接受「載了一半的 agent」。先前成功的 plugin 註冊的
 * 東西留在 registry 上不動，錯誤處理與診斷才有東西可看。
 *
 * @param plugins - 待載入的清單，順序有意義。
 * @param registry - 要載入進去的 registry，省略即開一個新的。
 * @returns 載入結果。
 */
export async function loadPlugins(
  plugins: readonly NexusPlugin[],
  registry: InternalPluginRegistry = createRegistry(),
): Promise<LoadResult> {
  const origins: PluginOrigin[] = [];

  for (const [index, plugin] of plugins.entries()) {
    const manifest = parsePluginManifest(plugin, index);
    const origin: PluginOrigin = { index, name: manifest.name };
    origins.push(origin);

    const undos: (() => void)[] = [];
    const tracked = trackUndo(registry, undos);
    const leave = registry.enter(origin);
    try {
      await plugin.apply(tracked);
    } catch (error) {
      for (const undo of undos.reverse()) undo();
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

  assertRequires(plugins, origins, registry);
  return { registry, origins };
}

/**
 * 包一層 registry，把這一輪 `apply` 拿到的每個 undo 都記進堆疊。
 *
 * 只包會產生 undo 的方法——讀取路徑原封轉發，plugin 在自己的 `apply` 裡讀得到
 * 先前 plugin 註冊的東西。**九個註冊點一個都不能漏**：漏掉的那個不會有任何現有測試
 * 發現，只會在回滾時默默留下一筆孤兒。`load.test.ts` 有一條九個點各註冊一樣東西後
 * throw 的測試守著這件事。
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
  };
}

/**
 * 全部 `apply` 跑完之後才驗 `requires`。
 *
 * 只能是之後：`requires` 明文不排序，清單裡靠前的 plugin 需要的能力可以由靠後的
 * plugin 提供。
 */
function assertRequires(
  plugins: readonly NexusPlugin[],
  origins: readonly PluginOrigin[],
  registry: InternalPluginRegistry,
): void {
  const missing: string[] = [];
  for (const [index, plugin] of plugins.entries()) {
    const origin = origins[index];
    if (origin === undefined) continue;
    for (const capability of plugin.requires ?? []) {
      if (!registry.capabilities.has(capability)) {
        missing.push(`${formatOrigin(origin)} 需要能力 "${capability}"`);
      }
    }
  }
  if (missing.length === 0) return;
  const available = registry.capabilities.names();
  const known = available.length === 0 ? '（沒有任何 plugin 宣告能力）' : available.join('、');
  throw new Error(`載入失敗，有能力沒人提供：${missing.join('；')}。目前被提供的能力：${known}`);
}
