/**
 * fs 查找的**提供者**（三角色紀律的提供者那一角，決議 §3-4 第 16 條；#1466）。
 *
 * 跟定義（`./index.ts`）分在兩個入口：消費者只 import `@nexus/fs`，永遠不 import 這裡。理由同 `@nexus/session/provider`：
 * 它的測試要被每一顆消費者的一致性套件重用（`checkConformance` 的 `providers`）。
 *
 * ## 行程級、一列、挑法由宿主交進來
 *
 * 「行程裡現在有哪幾條 thread 活著、各自的 fs 把手是哪一個」是**宿主的事實**，不是設定檔上的值；所以提供者**不自己保存任何
 * 登記**，只收宿主交進來的一支查找函式。那支函式在 harness 裡是 `@nexus/core` 的 `pickBoundForCall` 套在「活著的那幾筆登記」上
 * ——與會話查找、相容層的 `registry.sessions.forCall` 是同一份挑法，這裡**不再寫一份**。
 *
 * 服務的方法是**自己的屬性、閉包住那支函式**，不是原型方法：消費者在 `apply` 當下抓住這個服務，提供者那一列卸載之後開著的
 * thread 仍要能問它，方法不碰 `this.ctx`。
 *
 * @module
 */

import type { Context } from '@nexus/cordis';
import { ContractService } from '@nexus/sdk';

import { fsToken } from './index.js';
import type { FsLookup, FsLookupService } from './index.js';

/** {@link createFsLookupProvider} 的回傳：交給 Loader 當內建插件的類別。 */
export interface FsLookupProviderHandle {
  /** 掛進 Loader 的 `builtins` 的那個服務類別。 */
  readonly Provider: new (ctx: Context) => FsLookupService;
}

/**
 * 造一個提供者。
 *
 * @param lookup - 宿主的挑法：拿到這次呼叫的 config，回 {@link FsLookup}。**每次呼叫都問它**，不快取結果。
 * @param workspaceRoot - 這個行程的工作區根（#1491 Q4 (a)），由宿主交進來；`undefined` 是沒有圍堵。行程級、不隨 thread 變，所以建構時定死。
 */
export function createFsLookupProvider(
  lookup: (config: unknown) => FsLookup,
  workspaceRoot?: string,
): FsLookupProviderHandle {
  class FsLookupServiceImpl extends ContractService<FsLookupService> implements FsLookupService {
    readonly forCall: (invocation: unknown) => FsLookup;
    readonly workspaceRoot: () => string | undefined;

    constructor(ctx: Context) {
      super(ctx, fsToken);
      this.forCall = (invocation) => lookup(invocation);
      this.workspaceRoot = () => workspaceRoot;
    }
  }

  return { Provider: FsLookupServiceImpl };
}
