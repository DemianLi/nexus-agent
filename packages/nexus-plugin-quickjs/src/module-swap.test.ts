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
import { currentModule, replaceModule } from './module.js';

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

/** Node 預設的堆疊下，這個 VM 堆疊上限會讓 host 的堆疊先用完（見 `index.test.ts` 的同名常數與它上面的量測說明）。 */
const HOST_OVERFLOW_STACK_BYTES = 2 * 1024 * 1024;

const RECURSE = '(function f() { return f(); })()';

async function mount(): Promise<StructuredTool> {
  const { registry } = await loadPlugins([
    createQuickJsPlugin({ maxStackSizeBytes: HOST_OVERFLOW_STACK_BYTES, timeoutMs: 10_000 }),
  ]);
  return registry.tools.resolve(RUN_JAVASCRIPT_TOOL_NAME)!.value as StructuredTool;
}

beforeEach(() => {
  seen.used.length = 0;
});

/** 模組是整個行程共用的，前一條測試留下的那個照樣在：每條測試只看自己這段期間新建的。 */
function createdSince(count: number): QuickJSWASMModule[] {
  return seen.created.slice(count);
}

describe('模組由插件持有、整個行程共用', () => {
  // 每組一次 agent 就 apply 一次；各自建模組的話，每條對話都多一個。
  it('掛載兩次只建一個模組，兩邊用的是同一個', async () => {
    const before = seen.created.length;
    const first = await mount();
    const second = await mount();
    expect(await first.invoke({ code: '1' })).toBe('1');
    expect(await second.invoke({ code: '2' })).toBe('2');

    const current = seen.created.at(-1);
    expect(createdSince(before).length).toBeLessThanOrEqual(1);
    expect(seen.used).toEqual([current, current]);
  });
});

describe('host 的堆疊用完之後換新模組', () => {
  it('下一次呼叫跑在新模組上，不再用停在一半的那個', async () => {
    const tool = await mount();
    const before = seen.created.length;
    const broken = seen.created.at(-1);
    await expect(tool.invoke({ code: RECURSE })).rejects.toThrow(
      'Maximum call stack size exceeded',
    );
    expect(await tool.invoke({ code: '1 + 1' })).toBe('2');

    const fresh = createdSince(before);
    expect(fresh).toHaveLength(1);
    expect(seen.used).toEqual([broken, fresh[0]]);
  });

  it('另一次掛載的工具也改用新模組', async () => {
    const tool = await mount();
    const other = await mount();
    const before = seen.created.length;
    await expect(tool.invoke({ code: RECURSE })).rejects.toThrow(
      'Maximum call stack size exceeded',
    );
    expect(await other.invoke({ code: '1 + 1' })).toBe('2');

    expect(seen.used.at(-1)).toBe(createdSince(before)[0]);
  });

  it('VM 自己的錯不換模組', async () => {
    const tool = await mount();
    const before = seen.created.length;
    await expect(tool.invoke({ code: 'throw new Error("壞了")' })).rejects.toThrow('壞了');
    expect(await tool.invoke({ code: '1 + 1' })).toBe('2');

    expect(createdSince(before)).toHaveLength(0);
  });

  // 同一輪的工具呼叫會並行。哪一個先跑不一定，這裡只看結果：中止的那個回錯，其餘照常。
  it('並行的呼叫裡有一個讓 host 的堆疊用完：其餘照常', async () => {
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
  });

  // 等待的那一刻拿到的是舊模組、醒來時已經被換掉：要改等新的，不能用停在一半的那個。
  it('等待期間模組被換掉：拿到的是新的', async () => {
    const old = await currentModule();
    const waiting = currentModule();
    const replacement = replaceModule();

    const got = await waiting;
    expect(got).toBe(await replacement);
    expect(got).not.toBe(old);
  });
});
