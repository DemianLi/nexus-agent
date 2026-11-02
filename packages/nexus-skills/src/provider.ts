/**
 * 技能來源登記處的**提供者**（三角色紀律的提供者那一角，決議 §3-4 第 16 條；#1446）。
 *
 * 跟定義（`./index.ts`）分在兩個入口：消費者只 import `@nexus/skills`，永遠不 import 這裡。理由同
 * `@nexus/tools/provider`：它的測試要被每一顆消費者的一致性套件重用（`checkConformance` 的 `providers`）。
 *
 * ## 行程級、一列；只收路徑，不掃描
 *
 * 一棵樹只掛一列提供者。每顆消費者經 `ctx.skillSources.addSource(path)` 登記，登記是 effect，消費者那一列卸載時登記處自己撤掉。
 * **宿主**（`apps/harness`）經 {@link SkillSourcesProviderHandle.entries} 讀每一條路徑連同登記它的那一列的 id，把來源是那一列的
 * 路徑折進每條 thread 的 `registry.skills.addSource`（照那一列登記的順序，`sources` 依序即優先序）；那一面不在
 * {@link SkillSourceRegistry} 的契約裡，消費者看不到。
 *
 * ## 驗證在這裡（#1446 Q2 (a)）
 *
 * 路徑格式在**登記時**就驗：寫錯的列在讀清單那一步就掉在 `apply` 階段，訊息帶列 id，不用等到組 thread。實作是 `@nexus/core` 匯出
 * 的 `assertLoadableSkillsPath`，**不搬進定義套件**：定義套件不 import core，搬過去 core 的 registry 就得反過來 import 它。
 * core registry 那一側仍保留給相容層的列用，兩邊呼叫同一支函式，同一個錯誤沒有兩個出處。
 *
 * ## 重名（#1446 Q3 (a)）
 *
 * 同一個目錄（正規化後，`/skills/` 等於 `/skills`）只收一次，不論是同一列登記兩次還是兩列各一次，後登記的拋。照 dsh 的 skills
 * （同一層撞名就拋，`skill/src/index.ts:328-337`；dsh 撞的是提供者名字，路徑形狀下鍵就是目錄），也跟 core 的 `NamedEntries` 一致。**這跟投影接縫的引用計數共用不同**：投影共用是因為多列貢獻同一個
 * 單元是正常的，技能來源兩列指到同一個目錄只會讓同名 skill 自己覆蓋自己。
 *
 * 同一列改設定重掛不會被自己舊的那一份判成重名：卸載的 effect 先撤掉舊的登記，新的才掛上（有測試釘著）。
 *
 * @module
 */

import type { Context } from '@nexus/cordis';
import { assertLoadableSkillsPath } from '@nexus/core';
import { ContractService } from '@nexus/sdk';

import { skillSourcesToken } from './index.js';
import type { SkillSourceRegistry } from './index.js';

/** 一條路徑的登記。 */
export interface SkillSourceEntry {
  /** 登記時寫的原文（可能帶結尾斜線）。 */
  readonly path: string;
  /** 登記者那一列的 id（Cordis 的列 id；沒有列就是插件名）。 */
  readonly source: string;
}

/** {@link createSkillSourcesProvider} 的回傳：交給 Loader 當內建插件的類別，與讀登記內容的那一面。 */
export interface SkillSourcesProviderHandle {
  /** 掛進 Loader 的 `builtins` 的那個服務類別。每次 {@link createSkillSourcesProvider} 的狀態都是新的。 */
  readonly Provider: new (ctx: Context) => SkillSourceRegistry;
  /** 目前每一條路徑的登記，依登記順序；快照。 */
  entries(): readonly SkillSourceEntry[];
  /** 登記筆數：一致性套件的 `residue` 用它。 */
  registrations(): number;
}

/** 造一個提供者。登記處的狀態活在回傳的 handle 裡，不在模組層級。 */
export function createSkillSourcesProvider(): SkillSourcesProviderHandle {
  /** key 是正規化後的路徑（`/skills/` 與 `/skills` 同一把）；`Map` 保住登記順序。 */
  const slots = new Map<string, SkillSourceEntry>();

  class SkillSourcesRegistryService
    extends ContractService<SkillSourceRegistry>
    implements SkillSourceRegistry
  {
    constructor(ctx: Context) {
      super(ctx, skillSourcesToken);
    }

    addSource(path: string): () => void {
      // `this.ctx` 追蹤到呼叫者（消費者）：登記者那一列的 id 取自它。
      const caller = this.ctx.fiber;
      const source = caller.entry?.id ?? caller.runtime?.name ?? '(未知)';
      const normalized = assertLoadableSkillsPath(path, {
        id: source,
        name: caller.runtime?.name ?? source,
      });
      return this.ctx.effect(() => {
        const existing = slots.get(normalized);
        if (existing !== undefined) {
          throw new Error(
            `skill 來源 "${path}" 與 ${existing.source} 登記的 "${existing.path}" 是同一個目錄：` +
              `同一個目錄只收一次（後登記的 ${source} 拒絕），兩列指到同一處只會讓同名 skill 自己覆蓋自己`,
          );
        }
        const slot: SkillSourceEntry = { path, source };
        slots.set(normalized, slot);
        return () => {
          // 只撤自己那一筆：同一個目錄被別的登記者拿走之後，這支 disposer 什麼也不動。
          if (slots.get(normalized) === slot) slots.delete(normalized);
        };
      }, 'skillSources.addSource()');
    }

    sources(): readonly string[] {
      return [...slots.values()].map((slot) => slot.path);
    }
  }

  return {
    Provider: SkillSourcesRegistryService,
    entries: () => [...slots.values()],
    registrations: () => slots.size,
  };
}
