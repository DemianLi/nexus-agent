/**
 * host 的堆疊用完之後換新模組（[#1841](https://github.com/DemianLi/nexus-agent/issues/1841)）。
 *
 * 停在一半的舊模組下一次呼叫照樣回得來答案，壞的只有它留在 WASM 記憶體裡收不掉的東西，從工具的輸出看不出來。所以這裡包住
 * `newQuickJSWASMModule`，記下建了哪些模組、每次求值用的是哪一個。
 */

import type { StructuredTool } from '@langchain/core/tools';
import { loadPlugins } from '@nexus/core';
import type { QuickJSWASMModule } from 'quickjs-emscripten';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuickJsPlugin, RUN_JAVASCRIPT_TOOL_NAME } from './index.js';

const seen = vi.hoisted(() => ({
  created: [] as QuickJSWASMModule[],
  used: [] as QuickJSWASMModule[],
}));

vi.mock('quickjs-emscripten', async (importOriginal) => {
  const actual = await importOriginal<typeof import('quickjs-emscripten')>();
  return {
    ...actual,
    newQuickJSWASMModule: async () => {
      const module = await actual.newQuickJSWASMModule();
      seen.created.push(module);
      const newRuntime = module.newRuntime.bind(module);
      module.newRuntime = (options) => {
        seen.used.push(module);
        return newRuntime(options);
      };
      return module;
    },
  };
});

/** Node 預設的堆疊下，這個 VM 堆疊上限會讓 host 的堆疊先用完（見 `index.test.ts` 的同名測試）。 */
const HOST_OVERFLOW_STACK_BYTES = 2 * 1024 * 1024;

const RECURSE = '(function f() { return f(); })()';

async function mount(): Promise<StructuredTool> {
  const { registry } = await loadPlugins([
    createQuickJsPlugin({ maxStackSizeBytes: HOST_OVERFLOW_STACK_BYTES, timeoutMs: 10_000 }),
  ]);
  return registry.tools.resolve(RUN_JAVASCRIPT_TOOL_NAME)!.value as StructuredTool;
}

beforeEach(() => {
  seen.created.length = 0;
  seen.used.length = 0;
});

describe('host 的堆疊用完之後換新模組', () => {
  it('下一次呼叫跑在新模組上，不再用停在一半的那個', async () => {
    const tool = await mount();
    await expect(tool.invoke({ code: RECURSE })).rejects.toThrow(
      'Maximum call stack size exceeded',
    );
    expect(await tool.invoke({ code: '1 + 1' })).toBe('2');

    expect(seen.created).toHaveLength(2);
    expect(seen.used).toEqual([seen.created[0], seen.created[1]]);
  });

  it('VM 自己的錯不換模組', async () => {
    const tool = await mount();
    await expect(tool.invoke({ code: 'throw new Error("壞了")' })).rejects.toThrow('壞了');
    expect(await tool.invoke({ code: '1 + 1' })).toBe('2');

    expect(seen.created).toHaveLength(1);
  });

  // 同一輪的工具呼叫會並行，已經在等舊模組的呼叫要改等新的。
  it('並行的呼叫：排在中止之後的都跑在新模組上', async () => {
    const tool = await mount();
    const results = await Promise.allSettled([
      tool.invoke({ code: RECURSE }),
      tool.invoke({ code: '1 + 1' }),
      tool.invoke({ code: '2 + 2' }),
    ]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(
      results.slice(1).map((result) => (result as PromiseFulfilledResult<unknown>).value),
    ).toEqual(['2', '4']);
    expect(seen.created).toHaveLength(2);
    expect(seen.used).toEqual([seen.created[0], seen.created[1], seen.created[1]]);
  });
});
