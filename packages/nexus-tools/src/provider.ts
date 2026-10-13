/**
 * 工具登記處的**提供者**（三角色紀律的提供者那一角，決議 §3-4 第 16 條；#1416 PR 2）。
 *
 * 跟定義（`./index.ts`）分在兩個入口：消費者只 import `@nexus/tools`，永遠不 import 這裡。提供者放在同一個套件而不是
 * 另開一個，理由是它的測試要被每一顆消費者的一致性套件重用（`checkConformance` 的 `providers`）：消費者把
 * `@nexus/tools/provider` 當 devDependency，CI 改了消費者就跑得到真的提供者。
 *
 * ## 行程級、一列
 *
 * 一棵樹只掛一列提供者，登記處是行程級的：每顆消費者經 `ctx.tools.register(tool)` 登記，登記是 effect，消費者那一列
 * 卸載時登記處自己撤掉。**宿主**（`apps/harness`）經 {@link ToolsProviderHandle.entries} 讀每一筆登記連同登記者那一列的
 * id，把工具折進每條 thread 的組裝；那一面不在 {@link ToolRegistry} 的契約裡，消費者看不到。
 *
 * @module
 */

import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Context } from '@nexus/cordis';
import { ContractService } from '@nexus/sdk';

import { toolsToken } from './index.js';
import type { ToolRegistry } from './index.js';

/** 一筆登記：工具與登記它的那一列（Cordis 的列 id；沒有列就是插件名）。 */
export interface ToolEntry {
  readonly tool: StructuredToolInterface;
  readonly source: string;
}

/** {@link createToolsProvider} 的回傳：交給 Loader 當內建插件的類別，與讀登記內容的那一面。 */
export interface ToolsProviderHandle {
  /** 掛進 Loader 的 `builtins`（或 `ctx.plugin`）的那個服務類別。每次 {@link createToolsProvider} 的狀態都是新的。 */
  readonly Provider: new (ctx: Context) => ToolRegistry;
  /** 目前每一筆登記，依登記順序；快照。 */
  entries(): readonly ToolEntry[];
}

/** 造一個提供者。登記處的狀態活在回傳的 handle 裡，不在模組層級。 */
export function createToolsProvider(): ToolsProviderHandle {
  const items: ToolEntry[] = [];

  class ToolsRegistryService extends ContractService<ToolRegistry> implements ToolRegistry {
    constructor(ctx: Context) {
      super(ctx, toolsToken);
    }

    register(tool: StructuredToolInterface): () => void {
      // `this.ctx` 追蹤到呼叫者（消費者）：登記者那一列的 id 取自它。
      const caller = this.ctx.fiber;
      const source = caller.entry?.id ?? caller.runtime?.name ?? '(未知)';
      return this.ctx.effect(() => {
        const existing = items.find((item) => item.tool.name === tool.name);
        if (existing !== undefined) {
          throw new Error(
            `工具名 ${tool.name} 已經由 ${existing.source} 登記，${source} 不能再登記同名的工具`,
          );
        }
        const entry: ToolEntry = { tool, source };
        items.push(entry);
        return () => {
          const index = items.indexOf(entry);
          if (index >= 0) items.splice(index, 1);
        };
      }, 'tools.register()');
    }

    list(): readonly StructuredToolInterface[] {
      return items.map((item) => item.tool);
    }
  }

  return {
    Provider: ToolsRegistryService,
    entries: () => [...items],
  };
}
