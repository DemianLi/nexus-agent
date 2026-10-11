/**
 * [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 驗收 ② 的素材：Cordis 當根，現有的 `PluginRegistry`＋組裝流程包成**一顆**相容層插件。
 *
 * 決議 §3-1 第 5 條的第一步：舊插件原樣跑在相容層裡，Cordis 只看得到這一顆。
 *
 * - {@link compatLayer}：Loader 的一列。設定從那一列來（`serve`、對照用的 `mutate`），`apply` 裡自己解出貨清單
 *   （`loadDefaultPlugins`，與 serve／CLI 同一個函式），以服務 `nexus.assembly` 提供「組一個 agent」。
 * - {@link loopPlugin}：thread 那一列，`inject: ['nexus.assembly']`。拿到服務後組 agent、跑一輪，把觀察交回去。
 *   這是 §3-1 第 4 條第一段「`createAgent` 原樣包成一顆 loop 插件」的最小形狀。
 *
 * 組裝本身一行沒改——那正是相容層的定義。這裡要證明的是「搬進 Cordis 的 fiber 之後照樣組出同一個東西」：
 * 清單經 Loader 的列設定進來、在 fiber 的 async apply 裡解、服務經 inject 交給另一顆 fiber 使用。
 *
 * @module
 */

import type { Context } from 'cordis';
import type { PluginEntry } from '@nexus/core';
import { createNexusAgent } from '../../agent-factory.js';
import { loadDefaultPlugins } from '../../plugin-config.js';

/** 相容層那一列的設定。 */
export interface CompatConfig {
  /** 疊 serve 專屬的出貨清單。 */
  readonly serve?: boolean;
  /** 突變對照用：交換清單上這兩顆的位置，或拿掉一顆。 */
  readonly mutate?: { readonly swap?: readonly [string, string]; readonly drop?: string };
}

type AgentOptions = Omit<Parameters<typeof createNexusAgent>[0], 'plugins'>;

/** 相容層提供的服務。 */
export interface NexusAssembly {
  /** 這顆相容層手上的清單（解析完、套過突變）。 */
  readonly plugins: readonly PluginEntry[];
  /** 用這份清單組一個 agent。 */
  create(options: AgentOptions): ReturnType<typeof createNexusAgent>;
}

declare module 'cordis' {
  interface Context {
    'nexus.assembly': NexusAssembly;
  }
}

/** 照設定改清單：只給突變對照用。 */
function mutated(plugins: readonly PluginEntry[], mutate: CompatConfig['mutate']): PluginEntry[] {
  const list = [...plugins];
  const at = (name: string) => {
    const index = list.findIndex((entry) => entry.plugin.name === name);
    if (index < 0) throw new Error(`清單上沒有 ${name}`);
    return index;
  };
  if (mutate?.swap !== undefined) {
    const [a, b] = [at(mutate.swap[0]), at(mutate.swap[1])];
    [list[a], list[b]] = [list[b]!, list[a]!];
  }
  if (mutate?.drop !== undefined) list.splice(at(mutate.drop), 1);
  return list;
}

/** 相容層：一顆 Cordis 插件包住整個 PluginRegistry 與組裝流程。 */
export const compatLayer = {
  name: 'nexus-compat',
  async apply(ctx: Context, config: CompatConfig | undefined) {
    const loaded = await loadDefaultPlugins({ serve: config?.serve === true });
    const plugins = mutated(loaded.plugins, config?.mutate);
    ctx.provide('nexus.assembly', {
      plugins,
      create: (options) => createNexusAgent({ ...options, plugins: [...plugins] }),
    } satisfies NexusAssembly);
  },
};

/** loop 那一列：拿相容層的服務組 agent，交給呼叫端給的 `run`。 */
export function loopPlugin(run: (assembly: NexusAssembly) => Promise<void>) {
  return {
    name: 'nexus-loop',
    inject: ['nexus.assembly'],
    async apply(ctx: Context) {
      await run(ctx['nexus.assembly']);
    },
  };
}
