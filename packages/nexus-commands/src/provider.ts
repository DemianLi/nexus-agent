/**
 * 命令登記處的**提供者**（三角色紀律的提供者那一角，決議 §3-4 第 16 條；#1456）。
 *
 * 跟定義（`./index.ts`）分在兩個入口：消費者只 import `@nexus/commands`，永遠不 import 這裡。理由同
 * `@nexus/tools/provider`：它的測試要被每一顆消費者的一致性套件重用（`checkConformance` 的 `providers`）。
 *
 * ## 行程級、一列；只收定義，不執行
 *
 * 一棵樹只掛一列提供者。每顆消費者經 `ctx.commands.register(definition)` 登記，登記是 effect，消費者那一列卸載時登記處
 * 自己撤掉。**宿主**（`apps/harness`）經 {@link CommandsProviderHandle.entries} 讀每一個命令連同登記它的那一列的 id，把
 * active 的那一列登記的命令折進每條 thread 的 `registry.commands`；那一面不在 {@link CommandRegistry} 的契約裡，消費者
 * 看不到。**執行**（解析、寫 `command/run`、呼叫 handler）留在 `@nexus/plugin-commands`，這裡不碰。
 *
 * ## 驗證與重名在這裡（#1456 Q5 (a)）
 *
 * 中繼資料在**登記時**就驗，同名在 `ctx.effect` 內拋，所以寫錯或撞名的那一列在讀清單那一步就掉在 `apply`，訊息帶列 id，
 * 不用等到組 thread。同一列改設定重掛不會被自己舊的那一份判成重名：卸載的 effect 先撤掉舊的登記，新的才掛上。
 *
 * **已知的縫**：樹上的命令跟**相容層**的命令撞名，要到組 thread 時才掉——相容層的列直接寫進 `registry.commands`，不經這個
 * 提供者，所以這裡看不到它們。那一刻拋的是 core `NamedEntries` 的訊息，掛 `registry.commands.register` 的那一列失敗。
 *
 * @module
 */

import type { Context } from '@nexus/cordis';
import { normalizeCommandDefinition } from '@nexus/core';
import type { CommandDefinition, CommandDescriptor } from '@nexus/core';
import { ContractService } from '@nexus/sdk';

import { commandsToken } from './index.js';
import type { CommandRegistry } from './index.js';

/** 一個命令的登記。 */
export interface CommandEntry {
  /** 驗過、凍過的定義（含 handler）。 */
  readonly definition: CommandDefinition;
  /** 登記者那一列的 id（Cordis 的列 id；沒有列就是插件名）。 */
  readonly source: string;
}

/** {@link createCommandsProvider} 的回傳：交給 Loader 當內建插件的類別，與讀登記內容的那一面。 */
export interface CommandsProviderHandle {
  /** 掛進 Loader 的 `builtins` 的那個服務類別。每次 {@link createCommandsProvider} 的狀態都是新的。 */
  readonly Provider: new (ctx: Context) => CommandRegistry;
  /** 目前每一個命令的登記，依登記順序；快照。 */
  entries(): readonly CommandEntry[];
  /** 登記筆數：一致性套件的 `residue` 用它。 */
  registrations(): number;
}

/** 造一個提供者。登記處的狀態活在回傳的 handle 裡，不在模組層級。 */
export function createCommandsProvider(): CommandsProviderHandle {
  interface Slot extends CommandEntry {
    readonly descriptor: CommandDescriptor;
  }
  /** key 是命令名；`Map` 保住登記順序。 */
  const slots = new Map<string, Slot>();

  class CommandsRegistryService
    extends ContractService<CommandRegistry>
    implements CommandRegistry
  {
    constructor(ctx: Context) {
      super(ctx, commandsToken);
    }

    register(definition: CommandDefinition): () => void {
      // `this.ctx` 追蹤到呼叫者（消費者）：登記者那一列的 id 取自它。
      const caller = this.ctx.fiber;
      const source = caller.entry?.id ?? caller.runtime?.name ?? '(未知)';
      const normalized = normalizeCommandDefinition(definition);
      const name = normalized.definition.name;
      return this.ctx.effect(() => {
        const existing = slots.get(name);
        if (existing !== undefined) {
          throw new Error(
            `命令 "/${name}" 已經由 ${existing.source} 登記過，${source} 又登記一次：` +
              '一個名字只能有一個 handler——讓後來的靜靜蓋掉前面的，等於使用者打的那一行意思會隨載入順序改變',
          );
        }
        const slot: Slot = {
          definition: normalized.definition,
          descriptor: normalized.descriptor,
          source,
        };
        slots.set(name, slot);
        return () => {
          // 只撤自己那一筆：同一個名字被別的登記者拿走之後，這支 disposer 什麼也不動。
          if (slots.get(name) === slot) slots.delete(name);
        };
      }, 'commands.register()');
    }

    list(): readonly CommandDescriptor[] {
      return [...slots.values()]
        .map((slot) => slot.descriptor)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
  }

  return {
    Provider: CommandsRegistryService,
    entries: () => [...slots.values()].map(({ definition, source }) => ({ definition, source })),
    registrations: () => slots.size,
  };
}
