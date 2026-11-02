/**
 * 投影登記處的**提供者**（三角色紀律的提供者那一角，決議 §3-4 第 16 條；#1421）。
 *
 * 跟定義（`./index.ts`）分在兩個入口：消費者只 import `@nexus/projections`，永遠不 import 這裡。理由同
 * `@nexus/tools/provider`：它的測試要被每一顆消費者的一致性套件重用（`checkConformance` 的 `providers`）。
 *
 * ## 行程級、一列；只收定義，不推動
 *
 * 一棵樹只掛一列提供者，登記處是行程級的：每顆消費者經 `ctx.projections.register(unit)` 登記，登記是 effect，消費者那一列
 * 卸載時登記處自己撤掉。**宿主**（`apps/harness`）經 {@link ProjectionsProviderHandle.entries} 讀每一個 key 連同登記它的
 * 那幾列的 id，把單元折進每條 thread 的登記處；那一面不在 {@link ProjectionRegistry} 的契約裡，消費者看不到。
 *
 * ## 偏離登記：provider 只收定義，不負責推動（PM 決策 2）
 *
 * dsh 的 `SessionProjectionRegistry` 自己監聽 `session/created` 與 `session/event`，逐 session 推動每一格
 * （`session-projection/src/index.ts`）。這裡**只收定義**：推動（把事件折進單元、送 `projection` frame）留在
 * `@nexus/core` 每條 thread 的登記處（`createProjectionFold`）。理由：推動綁在會話日誌與 wire 的投影通道上，搬到 provider
 * 就是 #1421 Q2 (b) 那一刀。**撤除條件**：跟 Q2 (b)（抽 `@nexus/session` 定義套件）一起做。
 *
 * ## 共用語意（PM 決策 1，照 dsh）
 *
 * - 同一個 key、同一個 `stateVersion`：引用計數共用；引用計數沒歸零時一直用**第一個**登記者的單元。
 * - `stateVersion` 不同：拒絕，錯誤指名 key、兩個版本與兩邊登記者（`ctx.effect` 內拋，掛第二個的那一列 FAILED）。
 * - 每條 thread 的登記處**照舊**每個 key 只收一份、重複拒絕保留（`@nexus/core` 的 `NamedEntries`）：那一層「一次組裝一張
 *   註冊表、不熱換」，共用只發生在行程級的這一層。由宿主決定共用的 key 由哪一列折進 thread。
 *
 * @module
 */

import type { Context } from '@nexus/cordis';
import { normalizeProjectionUnit } from '@nexus/core';
import type { ProjectionUnit } from '@nexus/core';
import { ContractService } from '@nexus/sdk';

import { projectionsToken } from './index.js';
import type { ProjectionRegistry } from './index.js';

/** 一個 key 的登記：共用的單元與登記它的那幾列。 */
export interface ProjectionEntry {
  /** 這個 key 的單元：第一個登記者的定義，引用計數歸零之前不換。 */
  readonly unit: ProjectionUnit;
  /** 登記者那幾列的 id（Cordis 的列 id；沒有列就是插件名），依登記順序；同一列登記兩次出現兩次。 */
  readonly sources: readonly string[];
}

/** {@link createProjectionsProvider} 的回傳：交給 Loader 當內建插件的類別，與讀登記內容的那一面。 */
export interface ProjectionsProviderHandle {
  /** 掛進 Loader 的 `builtins` 的那個服務類別。每次 {@link createProjectionsProvider} 的狀態都是新的。 */
  readonly Provider: new (ctx: Context) => ProjectionRegistry;
  /** 目前每一個 key 的登記，依第一次登記的順序；快照。 */
  entries(): readonly ProjectionEntry[];
  /** 登記筆數（每一次 `register` 一筆，共用的 key 每個登記者各算一筆）：一致性套件的 `residue` 用它。 */
  registrations(): number;
}

/** 造一個提供者。登記處的狀態活在回傳的 handle 裡，不在模組層級。 */
export function createProjectionsProvider(): ProjectionsProviderHandle {
  interface Slot {
    readonly unit: ProjectionUnit;
    readonly sources: string[];
  }
  const slots = new Map<string, Slot>();

  class ProjectionsRegistryService
    extends ContractService<ProjectionRegistry>
    implements ProjectionRegistry
  {
    constructor(ctx: Context) {
      super(ctx, projectionsToken);
    }

    register(unit: ProjectionUnit): () => void {
      // `this.ctx` 追蹤到呼叫者（消費者）：登記者那一列的 id 取自它。
      const caller = this.ctx.fiber;
      const source = caller.entry?.id ?? caller.runtime?.name ?? '(未知)';
      const normalized = normalizeProjectionUnit(unit);
      return this.ctx.effect(() => {
        const existing = slots.get(normalized.key);
        if (existing === undefined) {
          slots.set(normalized.key, { unit: normalized, sources: [source] });
        } else if (existing.unit.stateVersion === normalized.stateVersion) {
          existing.sources.push(source);
        } else {
          throw new Error(
            `投影 ${normalized.key} 已經由 ${existing.sources.join('、')} 以 stateVersion ` +
              `${String(existing.unit.stateVersion)} 登記，${source} 要登記的是 stateVersion ` +
              `${String(normalized.stateVersion)}：版本不同不共用，拒絕`,
          );
        }
        return () => {
          const slot = slots.get(normalized.key);
          if (slot === undefined) return;
          const index = slot.sources.indexOf(source);
          if (index >= 0) slot.sources.splice(index, 1);
          if (slot.sources.length === 0) slots.delete(normalized.key);
        };
      }, 'projections.register()');
    }

    list(): readonly ProjectionUnit[] {
      return [...slots.values()].map((slot) => slot.unit);
    }
  }

  return {
    Provider: ProjectionsRegistryService,
    entries: () =>
      [...slots.values()].map((slot) => ({ unit: slot.unit, sources: [...slot.sources] })),
    registrations: () => [...slots.values()].reduce((sum, slot) => sum + slot.sources.length, 0),
  };
}
