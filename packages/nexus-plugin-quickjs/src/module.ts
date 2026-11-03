/**
 * `run_javascript` 用的 WASM 模組。樹上那一列在 `apply` 裡建一份持有者，那一列的工具共用它；停在一半的模組由呼叫端換掉
 * （見 `index.ts` 的 `runInVm`）。
 *
 * @module
 */

import { newQuickJSWASMModule } from 'quickjs-emscripten';
import type { QuickJSWASMModule } from 'quickjs-emscripten';

/** 一份 WASM 模組的持有者。 */
export interface QuickJsModules {
  /**
   * 目前的模組，還沒有就建。等待期間模組可能被別的呼叫換掉（同一輪並行的，或別條對話的），那就改等新的。
   * 新模組建不起來時原樣 reject，下一次呼叫重建（見 {@link replace}）。
   */
  current(): Promise<QuickJSWASMModule>;
  /** 建一個新模組、換掉目前的。建不起來就清掉，下一次要用時重建，一次失敗不會卡住這份持有者。 */
  replace(): Promise<QuickJSWASMModule>;
}

/**
 * 建一份持有者。
 *
 * @returns 還沒有模組的持有者，第一次 `current()` 才建。
 */
export function createModuleHolder(): QuickJsModules {
  let shared: Promise<QuickJSWASMModule> | undefined;
  const replace = (): Promise<QuickJSWASMModule> => {
    const next = newQuickJSWASMModule();
    shared = next;
    next.catch(() => {
      if (shared === next) shared = undefined;
    });
    return next;
  };
  return {
    replace,
    async current() {
      for (;;) {
        const awaited = shared ?? replace();
        const quickjs = await awaited;
        if (awaited === shared) return quickjs;
      }
    },
  };
}
