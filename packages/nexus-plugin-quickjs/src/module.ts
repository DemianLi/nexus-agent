/**
 * `run_javascript` 用的 WASM 模組，由這個插件持有、整個行程共用；停在一半的模組由呼叫端換掉（見 `index.ts` 的 `runInVm`）。
 *
 * @module
 */

import { newQuickJSWASMModule } from 'quickjs-emscripten';
import type { QuickJSWASMModule } from 'quickjs-emscripten';

/** 行程裡目前的 WASM 模組，所有掛載共用。 */
let sharedModule: Promise<QuickJSWASMModule> | undefined;

/** 建一個新模組、換掉目前的。建不起來就清掉，下一次要用時重建，一次失敗不會卡住整個行程。 */
export function replaceModule(): Promise<QuickJSWASMModule> {
  const next = newQuickJSWASMModule();
  sharedModule = next;
  next.catch(() => {
    if (sharedModule === next) sharedModule = undefined;
  });
  return next;
}

/**
 * 目前的模組，還沒有就建。等待期間模組可能被別的呼叫換掉（同一輪並行的，或別條對話的），那就改等新的。
 * 新模組建不起來時原樣 reject，下一次呼叫重建（見 {@link replaceModule}）。
 */
export async function currentModule(): Promise<QuickJSWASMModule> {
  for (;;) {
    const awaited = sharedModule ?? replaceModule();
    const quickjs = await awaited;
    if (awaited === sharedModule) return quickjs;
  }
}
