/**
 * host 的堆疊用完之後換新模組（[#1841](https://github.com/DemianLi/nexus-agent/issues/1841)）。
 *
 * 停在一半的舊模組下一次呼叫照樣回得來答案，壞的只有它留在 WASM 記憶體裡收不掉的東西，從工具的輸出看不出來。所以這裡包住
 * `newQuickJSWASMModule`，記下建了哪些模組、每次求值用的是哪一個。
 */

import type { NexusTool, NexusToolResult, ToolExec } from '@nexus/tools';
import type { QuickJSWASMModule } from 'quickjs-emscripten';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunJavascriptTool, quickJsConfigSchema } from './index.js';
import { createModuleHolder } from './module.js';
import type { QuickJsModules } from './module.js';

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

const exec: ToolExec = {
  callId: 'c1',
  threadId: undefined,
  agent: undefined,
  signal: undefined,
  concludeTurn: () => {},
  deferContext: () => {},
  interrupt: () => Promise.resolve(undefined),
};

/** 一個工具，共用給定的持有者（同一列的工具共用它那一份）。 */
function toolOn(modules: QuickJsModules): NexusTool {
  return createRunJavascriptTool(
    quickJsConfigSchema.parse({ maxStackSizeBytes: HOST_OVERFLOW_STACK_BYTES, timeoutMs: 10_000 }),
    modules,
  );
}

/** 跑一段程式：成功回文字，失敗回 `Error: <內容>` 的被拒 promise，讓下面用 `resolves`／`rejects` 斷言。 */
async function run(tool: NexusTool, code: string): Promise<string> {
  const result: NexusToolResult = await tool.execute({ code }, exec);
  if (!result.ok) throw new Error(result.content);
  return String(result.content);
}

beforeEach(() => {
  seen.used.length = 0;
});

/** `seen.created` 跨測試累積：每條測試只看自己這段期間新建的。 */
function createdSince(count: number): QuickJSWASMModule[] {
  return seen.created.slice(count);
}

describe('模組由那一列持有，那一列的工具共用', () => {
  // 這一列掛著的期間，`serve` 的每條 thread 用的都是它登記的工具；各自建模組的話，每條對話都多一個。
  it('同一份持有者的兩個工具只建一個模組，兩邊用的是同一個', async () => {
    const before = seen.created.length;
    const modules = createModuleHolder();
    const first = toolOn(modules);
    const second = toolOn(modules);
    expect(await run(first, '1')).toBe('1');
    expect(await run(second, '2')).toBe('2');

    const fresh = createdSince(before);
    expect(fresh).toHaveLength(1);
    expect(seen.used).toEqual([fresh[0], fresh[0]]);
  });
});

describe('host 的堆疊用完之後換新模組', () => {
  it('下一次呼叫跑在新模組上，不再用停在一半的那個', async () => {
    const tool = toolOn(createModuleHolder());
    expect(await run(tool, '0')).toBe('0');
    const before = seen.created.length;
    const broken = seen.created.at(-1);
    seen.used.length = 0;
    await expect(run(tool, RECURSE)).rejects.toThrow('Maximum call stack size exceeded');
    expect(await run(tool, '1 + 1')).toBe('2');

    const fresh = createdSince(before);
    expect(fresh).toHaveLength(1);
    expect(seen.used).toEqual([broken, fresh[0]]);
  });

  it('同一份持有者的另一個工具也改用新模組', async () => {
    const modules = createModuleHolder();
    const tool = toolOn(modules);
    const other = toolOn(modules);
    expect(await run(tool, '0')).toBe('0');
    const before = seen.created.length;
    await expect(run(tool, RECURSE)).rejects.toThrow('Maximum call stack size exceeded');
    expect(await run(other, '1 + 1')).toBe('2');

    expect(seen.used.at(-1)).toBe(createdSince(before)[0]);
  });

  it('VM 自己的錯不換模組', async () => {
    const tool = toolOn(createModuleHolder());
    expect(await run(tool, '0')).toBe('0');
    const before = seen.created.length;
    await expect(run(tool, 'throw new Error("壞了")')).rejects.toThrow('壞了');
    expect(await run(tool, '1 + 1')).toBe('2');

    expect(createdSince(before)).toHaveLength(0);
  });

  // 同一輪的工具呼叫會並行。哪一個先跑不一定，這裡只看結果：中止的那個回錯，其餘照常。
  it('並行的呼叫裡有一個讓 host 的堆疊用完：其餘照常', async () => {
    const tool = toolOn(createModuleHolder());
    const results = await Promise.allSettled([
      run(tool, RECURSE),
      run(tool, '1 + 1'),
      run(tool, '2 + 2'),
    ]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(
      results.slice(1).map((result) => (result as PromiseFulfilledResult<unknown>).value),
    ).toEqual(['2', '4']);
  });

  // 等待的那一刻拿到的是舊模組、醒來時已經被換掉：要改等新的，不能用停在一半的那個。
  it('等待期間模組被換掉：拿到的是新的', async () => {
    const modules = createModuleHolder();
    const old = await modules.current();
    const waiting = modules.current();
    const replacement = modules.replace();

    const got = await waiting;
    expect(got).toBe(await replacement);
    expect(got).not.toBe(old);
  });
});
