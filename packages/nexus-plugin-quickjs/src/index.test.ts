/**
 * QuickJS plugin 的驗收。
 *
 * 判準跟 `contained-backend.test.ts` 同一條：**看行為，不看措辭**。這裡的「行為」是
 * 兩種邊界——
 *
 * 1. **能力邊界**：VM 裡拿不到 host 的東西（`require` / `fetch` / `process` / `import`）。
 * 2. **資源邊界**：無限迴圈會被中斷、吃記憶體會被擋、無窮遞迴會被擋。
 *
 * 第 2 組是這個套件敢自稱隔離的**唯一**理由。QuickJS-in-WASM 天生就有第 1 種邊界
 * （它是個裸引擎，沒人 bridge 就什麼都沒有），但第 2 種完全是我們自己設的：不設上限的
 * 話一個 `while(true){}` 會把主執行緒塞死到 vitest 逾時。所以這三條測試如果紅了，
 * 「隔離」這個詞就是假的。
 */

import type { StructuredTool } from '@langchain/core/tools';
import { loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { createQuickJsPlugin, QUICKJS_CAPABILITY, RUN_JAVASCRIPT_TOOL_NAME } from './index.js';
import type { QuickJsPluginOptions } from './index.js';

/** 掛一次 plugin，把註冊出來的那個工具拿出來，餵它一段程式。 */
async function runTool(options: QuickJsPluginOptions, code: string): Promise<string> {
  const { registry } = await loadPlugins([createQuickJsPlugin(options)]);
  const entry = registry.tools.resolve(RUN_JAVASCRIPT_TOOL_NAME);
  if (entry === undefined) throw new Error(`${RUN_JAVASCRIPT_TOOL_NAME} 沒有註冊上`);
  return String(await (entry.value as StructuredTool).invoke({ code }));
}

describe('正常的路', () => {
  it('求值一段 JavaScript，回傳最後一個運算式的值', async () => {
    expect(await runTool({}, '1 + 1')).toBe('2');
    expect(await runTool({}, '[1,2,3].map((n) => n * 2)')).toBe('[2,4,6]');
    expect(await runTool({}, '"哈" + "囉"')).toBe('哈囉');
  });

  it('沒有回傳值的程式有自己的講法，不是空回應', async () => {
    expect(await runTool({}, 'const x = 1;')).toBe('（沒有回傳值）');
  });

  it('VM 裡丟出來的錯誤原樣轉述給模型', async () => {
    expect(await runTool({}, 'throw new TypeError("壞了")')).toContain('TypeError: 壞了');
  });

  // 每次呼叫一個新 runtime 的行為證據。共用的話第二次看得到第一次留下的 global。
  it('兩次呼叫之間不共用狀態', async () => {
    await runTool({}, 'globalThis.留下來的 = 1');
    expect(await runTool({}, 'typeof globalThis.留下來的')).toBe('undefined');
  });
});

describe('能力邊界——VM 裡沒有外界', () => {
  it.each(['require', 'fetch', 'process', 'globalThis.XMLHttpRequest', 'globalThis.WebAssembly'])(
    '%s 在 VM 裡是 undefined',
    async (name) => {
      expect(await runTool({}, `typeof ${name}`)).toBe('undefined');
    },
  );

  // 沒掛 module loader，所以 `import` 連解析都過不了。這一條與上面那組不同軸：上面問
  // 「這個全域在不在」，這一條問「模組系統通不通」。
  it('import 進不來——沒有 module loader', async () => {
    expect(await runTool({}, 'import("node:fs")')).toContain("could not load module 'node:fs'");
  });
});

/**
 * 非同步的程式碼。
 *
 * 這一組守的是求值之後那一步 `executePendingJobs()`。少了它，每個 `async` 函式都停在
 * pending——模型拿到的不是答案而是「沒完成」，而且看不出是自己寫錯還是工具不支援。
 */
describe('非同步', () => {
  it('async 函式跑得完，拿得到值', async () => {
    expect(await runTool({}, '(async () => { const a = await 1; return a + 41; })()')).toBe('42');
  });

  // 被 reject 的 promise 對模型來說跟 throw 是同一件事，措辭因此刻意相同。原樣把
  // `dump()` 攤出來的 `{type:"rejected",…}` JSON 出去的話，失敗會長得像成功。
  it('被 reject 的 promise 讀起來就是錯誤', async () => {
    expect(await runTool({}, 'Promise.reject(new Error("拒絕了"))')).toBe('錯誤：Error: 拒絕了');
  });

  // 等得到的都等到了還是 pending，代表它在等一個 VM 裡不存在的東西。這是永遠不會變的
  // 狀態，不是「再等一下就好」——所以不能讓它讀起來像個值。
  it('等不到的 promise 講清楚它等不到', async () => {
    const result = await runTool({}, 'new Promise(() => {})');

    expect(result).toContain('永遠不會完成');
  });

  // 「這是不是 promise」問的是引擎（`getPromiseState`），不是 dump 出來的形狀。基座的
  // `dump()` 把 promise 攤成 `{ type, value }`，而那個形狀一般物件也戴得起來——靠形狀猜
  // 的話，這兩個完全正常的回傳值會被讀成 promise。
  it.each([
    ["({ type: 'pending' })", '{"type":"pending"}'],
    ["({ type: 'fulfilled', value: 1 })", '{"type":"fulfilled","value":1}'],
    ["({ type: 'rejected', error: 'x' })", '{"type":"rejected","error":"x"}'],
  ])('%s 是一般物件，不是 promise', async (code, expected) => {
    expect(await runTool({}, code)).toBe(expected);
  });
});

describe('資源邊界——只有設定的那麼強', () => {
  it('無限迴圈被中斷，不是讓測試逾時', async () => {
    const started = Date.now();
    const result = await runTool({ timeoutMs: 200 }, 'while (true) {}');

    expect(result).toContain('執行超過 200 毫秒');
    // 上限是「最多塞住多久」。放寬到 10 倍是給 CI 的排程噪音留的餘裕——這一條要證明的是
    // 「有沒有被擋下來」，不是中斷的精度。
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('吃記憶體被擋', async () => {
    // 時間上限刻意放寬，否則擋下它的可能是逾時而不是記憶體上限，這條就測不到想測的東西。
    // 斷言的是 `out of memory` 而不是泛泛的「錯誤」，理由同上：訊息不對就代表擋它的是別的東西。
    const result = await runTool(
      { memoryLimitBytes: 1024 * 1024, timeoutMs: 10_000 },
      'const held = []; for (;;) held.push(new Array(10000).fill(0));',
    );

    expect(result).toContain('out of memory');
  });

  // 堆疊與記憶體是兩條軸：無窮遞迴吃的是前者，只設記憶體上限擋不住它。這一條要是紅了，
  // 八成是有人把 `maxStackSizeBytes` 拿掉了，覺得記憶體上限已經涵蓋。
  it('無窮遞迴撞的是堆疊上限，不是記憶體上限', async () => {
    const result = await runTool(
      { maxStackSizeBytes: 64 * 1024, timeoutMs: 10_000 },
      'function 遞迴() { return 遞迴(); } 遞迴()',
    );

    expect(result).toContain('stack overflow');
  });
});

describe('plugin 的接線', () => {
  it('宣告 quickjs 能力', async () => {
    const { registry } = await loadPlugins([createQuickJsPlugin()]);

    expect(registry.capabilities.has(QUICKJS_CAPABILITY)).toBe(true);
  });

  // 這條釘住「不接 lifecycle」那個決定（見 index.ts）。接了一個什麼都不做的 disposer
  // 會讓關機清單看起來比實際上熱鬧，而關機清單是診斷「誰沒收乾淨」時看的東西。
  it('沒有登記關機清理——行程內的 VM 沒有活 handle 要收', async () => {
    const { registry } = await loadPlugins([createQuickJsPlugin()]);

    expect(registry.lifecycle.disposers()).toHaveLength(0);
  });

  // 工具名不叫 `execute` 是刻意的（見 index.ts）。這條把那個決定釘住：改回 `execute`
  // 會撞上基座 sandbox backend 的同名工具。
  it('工具名不是 execute', () => {
    expect(RUN_JAVASCRIPT_TOOL_NAME).toBe('run_javascript');
  });
});
