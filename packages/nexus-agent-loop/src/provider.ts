/**
 * agent loop 登記處的**提供者**（三角色紀律的提供者那一角，決議 §3-4 第 16 條；#1474）。
 *
 * 跟定義（`./index.ts`）分在兩個入口：消費者只 import `@nexus/agent-loop`，永遠不 import 這裡。理由同
 * `@nexus/tools/provider`：它的測試要被每一顆消費者的一致性套件重用（`checkConformance` 的 `providers`）。
 *
 * ## 行程級、一列；只收 listener，不建 middleware
 *
 * 一棵樹只掛一列提供者。每顆消費者經 `ctx.agentLoop.preStep(name, listener)` 登記，登記是 effect，消費者那一列卸載時登記處自己撤掉。
 * **宿主**（`apps/harness`）經 {@link AgentLoopProviderHandle.preSteps} 讀每一位 listener 連同登記者那一列的 id，把登記者是某一列的
 * 那幾位建成 middleware、折進每條 thread 的 `registry.middleware`；那一面不在 {@link AgentLoop} 的契約裡，消費者看不到。
 * 建 middleware 要 core 的 `effectiveMessages` 與 langchain 的 `createMiddleware`，定義套件不寫這種實作。
 *
 * ## 重名
 *
 * 名字是 middleware 的名字，也是日誌 `source.plugin`：同一個登記處內重名當場拋，後登記的那一列掉在 `apply` 階段。
 * 同一列改設定重掛不會被自己舊的那一份判成重名：卸載的 effect 先撤掉舊的登記，新的才掛上。
 *
 * @module
 */

import type { Context } from '@nexus/cordis';
import { ContractService } from '@nexus/sdk';

import { agentLoopToken } from './index.js';
import type { AgentLoop, PreStepListener } from './index.js';

/** 一位 `agent/pre-step` listener 的登記：名字、listener，與登記它的那一列。 */
export interface PreStepEntry {
  /** 登記時給的名字：middleware 的名字，也是日誌 `source.plugin`。 */
  readonly name: string;
  readonly listener: PreStepListener;
  /** 登記者那一列的 id（Cordis 的列 id；沒有列就是插件名）。 */
  readonly source: string;
}

/** {@link createAgentLoopProvider} 的回傳：交給 Loader 當內建插件的類別，與讀登記內容的那一面。 */
export interface AgentLoopProviderHandle {
  /** 掛進 Loader 的 `builtins`（或 `ctx.plugin`）的那個服務類別。每次 {@link createAgentLoopProvider} 的狀態都是新的。 */
  readonly Provider: new (ctx: Context) => AgentLoop;
  /** 目前每一位 `agent/pre-step` listener，依登記順序；快照。宿主把登記者是某一列的那幾位建成 middleware、折進那一條 thread。 */
  preSteps(): readonly PreStepEntry[];
  /** 登記筆數：一致性套件的 `residue` 用它。 */
  registrations(): number;
}

/** 造一個提供者。登記處的狀態活在回傳的 handle 裡，不在模組層級。 */
export function createAgentLoopProvider(): AgentLoopProviderHandle {
  const items: PreStepEntry[] = [];

  class AgentLoopRegistryService extends ContractService<AgentLoop> implements AgentLoop {
    constructor(ctx: Context) {
      super(ctx, agentLoopToken);
    }

    preStep(name: string, listener: PreStepListener): () => void {
      // `this.ctx` 追蹤到呼叫者（消費者）：登記者那一列的 id 取自它。
      const caller = this.ctx.fiber;
      const source = caller.entry?.id ?? caller.runtime?.name ?? '(未知)';
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error(
          `${source} 登記 agent/pre-step listener 時沒有給名字：名字是 middleware 的名字，不能是空的`,
        );
      }
      return this.ctx.effect(() => {
        const existing = items.find((item) => item.name === name);
        if (existing !== undefined) {
          throw new Error(
            `agent/pre-step listener 名 ${name} 已經由 ${existing.source} 登記，${source} 不能再登記同名的 listener`,
          );
        }
        const entry: PreStepEntry = { name, listener, source };
        items.push(entry);
        return () => {
          const index = items.indexOf(entry);
          if (index >= 0) items.splice(index, 1);
        };
      }, 'agentLoop.preStep()');
    }
  }

  return {
    Provider: AgentLoopRegistryService,
    preSteps: () => [...items],
    registrations: () => items.length,
  };
}
