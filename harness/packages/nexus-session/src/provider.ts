/**
 * 會話查找的**提供者**（三角色紀律的提供者那一角，決議 §3-4 第 16 條；#1463）。
 *
 * 跟定義（`./index.ts`）分在兩個入口：消費者只 import `@nexus/session`，永遠不 import 這裡。理由同
 * `@nexus/tools/provider`、`@nexus/approval-channel/provider`：它的測試要被每一顆消費者的一致性套件重用（`checkConformance` 的
 * `providers`）。
 *
 * ## 行程級、一列、挑法由宿主交進來
 *
 * 「行程裡現在有哪幾條 thread 活著」是**宿主的事實**（serve 組好一條 thread 才有、收掉才沒有），不是設定檔上的值；所以提供者
 * **不自己保存註冊表**，只收宿主交進來的一支查找函式（{@link createSessionLookupProvider} 的參數）。那支函式在 harness 裡是
 * `@nexus/core` 的 `pickSessionForCall` 套在「活著的那幾張」上——與相容層的 `registry.sessions.forCall` 是同一份挑法，
 * 這裡**不再寫一份**。
 *
 * 服務的方法是**自己的屬性、閉包住那支函式**，不是原型方法：消費者在 `apply` 當下抓住這個服務（traceable proxy），
 * 提供者那一列卸載之後開著的 thread 仍要能問它（#1456 驗收 D 的同一個形狀），方法不碰 `this.ctx`。
 *
 * @module
 */

import type { Context } from '@nexus/cordis';
import { ContractService } from '@nexus/sdk';

import { sessionDurabilityToken, sessionLookupToken } from './index.js';
import type {
  SessionDurabilityService,
  SessionInstaller,
  SessionLog,
  SessionLookup,
  SessionLookupService,
} from './index.js';

/** 一位會話參與者的登記（#1491）：安裝函式，與登記它的那一列。 */
export interface SessionParticipantEntry {
  readonly participant: SessionInstaller;
  /** 登記者那一列的 id（Cordis 的列 id；沒有列就是插件名）。 */
  readonly source: string;
}

/** {@link createSessionLookupProvider} 的回傳：交給 Loader 當內建插件的類別。 */
export interface SessionLookupProviderHandle {
  /** 掛進 Loader 的 `builtins` 的那個服務類別。 */
  readonly Provider: new (ctx: Context) => SessionLookupService;
  /** 目前每一位會話參與者，依登記順序；快照。宿主把登記者是某一列的那幾位折進每條 thread 的 `registry.sessions.join`（#1491）。 */
  participants(): readonly SessionParticipantEntry[];
  /** 登記筆數：一致性套件的 `residue` 用它。 */
  registrations(): number;
}

/**
 * 造一個提供者。
 *
 * @param lookup - 宿主的挑法：拿到這次呼叫的 config，回 {@link SessionLookup}。**每次呼叫都問它**，不快取結果（行程裡活著的
 *   thread 會變）。
 */
export function createSessionLookupProvider(
  lookup: (config: unknown) => SessionLookup,
): SessionLookupProviderHandle {
  const items: SessionParticipantEntry[] = [];

  class SessionLookupServiceImpl
    extends ContractService<SessionLookupService>
    implements SessionLookupService
  {
    readonly forCall: (invocation: unknown) => SessionLookup;

    constructor(ctx: Context) {
      super(ctx, sessionLookupToken);
      this.forCall = (invocation) => lookup(invocation);
    }

    join(participant: SessionInstaller): () => void {
      // `this.ctx` 追蹤到呼叫者（消費者）：登記者那一列的 id 取自它。
      const caller = this.ctx.fiber;
      const source = caller.entry?.id ?? caller.runtime?.name ?? '(未知)';
      if (typeof participant !== 'function') {
        throw new TypeError(`${source} 登記會話參與者時給的不是函式`);
      }
      return this.ctx.effect(() => {
        const entry: SessionParticipantEntry = { participant, source };
        items.push(entry);
        return () => {
          const index = items.indexOf(entry);
          if (index >= 0) items.splice(index, 1);
        };
      }, 'sessionLookup.join()');
    }
  }

  return {
    Provider: SessionLookupServiceImpl,
    participants: () => [...items],
    registrations: () => items.length,
  };
}

/**
 * 造落盤確認的提供者（[#1606](https://github.com/DemianLi/nexus-agent/issues/1606)）。**做法由宿主交進來**：排空哪一張註冊表、
 * 從哪一個 store 讀回，是宿主的事實。方法是自己的屬性、閉包住那支函式，同 {@link createSessionLookupProvider}：消費者在 `apply`
 * 當下抓住服務，提供者那一列卸載之後抓住的那份仍能呼叫。
 *
 * @param checkpoint - 宿主的做法，見 {@link SessionDurabilityService.checkpoint}。
 * @returns 交給 Loader 當內建列的類別。
 */
export function createSessionDurabilityProvider(
  checkpoint: (log: SessionLog) => Promise<void>,
): new (ctx: Context) => SessionDurabilityService {
  return class SessionDurabilityServiceImpl
    extends ContractService<SessionDurabilityService>
    implements SessionDurabilityService
  {
    readonly checkpoint: (log: SessionLog) => Promise<void>;

    constructor(ctx: Context) {
      super(ctx, sessionDurabilityToken);
      this.checkpoint = (log) => checkpoint(log);
    }
  };
}
