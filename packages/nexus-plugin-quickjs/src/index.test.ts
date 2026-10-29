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
import {
  CodeRunFailedError,
  createQuickJsPlugin,
  DEFAULT_MAX_STACK_SIZE_BYTES,
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_TIMEOUT_MS,
  quickJsConfigSchema,
  quickJsPlugin,
  RUN_JAVASCRIPT_TOOL_NAME,
} from './index.js';
import type { QuickJsPluginOptions } from './index.js';

/** 掛一次 plugin，把註冊出來的那個工具拿出來，餵它一段程式。 */
async function runTool(options: QuickJsPluginOptions, code: string): Promise<string> {
  const { registry } = await loadPlugins([createQuickJsPlugin(options)]);
  const entry = registry.tools.resolve(RUN_JAVASCRIPT_TOOL_NAME);
  if (entry === undefined) throw new Error(`${RUN_JAVASCRIPT_TOOL_NAME} 沒有註冊上`);
  return String(await (entry.value as StructuredTool).invoke({ code }));
}

/**
 * 同 {@link runTool}，但這段程式**該失敗**：回傳工具拋出來的 {@link CodeRunFailedError}。
 * 沒拋、或拋的不是它，這裡就讓測試紅。
 */
async function runFailing(
  options: QuickJsPluginOptions,
  code: string,
): Promise<CodeRunFailedError> {
  const error: unknown = await runTool(options, code).then(
    (value) => {
      throw new Error(`預期失敗，卻回了：${value}`);
    },
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof CodeRunFailedError)) throw error;
  expect(error.code).toBe('CODE_RUN_FAILED');
  return error;
}

describe('正常的路', () => {
  it('求值一段 JavaScript，回傳最後一個運算式的值', async () => {
    expect(await runTool({}, '1 + 1')).toBe('2');
    expect(await runTool({}, '[1,2,3].map((n) => n * 2)')).toBe('[\n  2,\n  4,\n  6\n]');
    expect(await runTool({}, '"哈" + "囉"')).toBe('哈囉');
  });

  it('沒有回傳值的程式有自己的講法，不是空回應', async () => {
    expect(await runTool({}, 'const x = 1;')).toBe('（沒有回傳值）');
  });

  // #615：以前回一句 `錯誤：TypeError: 壞了` 的字串，工具算成功。翻面之後守的是「拋、而且
  // 文字帶得出原因」——模型讀得到原因才能自己修，這一半沒有變。
  it('VM 裡丟出來的錯誤：拋 CodeRunFailedError，原因原樣帶著，沒有 `錯誤：` 前綴', async () => {
    const error = await runFailing({}, 'throw new TypeError("壞了")');
    expect(error.kind).toBe('exception');
    expect(error.message).toBe('code run failed (exception): TypeError: 壞了');
  });

  // 每次呼叫一個新 runtime 的行為證據。共用的話第二次看得到第一次留下的 global。
  it('兩次呼叫之間不共用狀態', async () => {
    await runTool({}, 'globalThis.留下來的 = 1');
    expect(await runTool({}, 'typeof globalThis.留下來的')).toBe('undefined');
  });
});

/** 逾時看的是 interrupt handler 有沒有觸發，程式丟出來的值偽造不了種類（[#1846](https://github.com/DemianLi/nexus-agent/issues/1846)）。 */
describe('失敗種類由 host 判定', () => {
  it('頂層 throw null：exception', async () => {
    const error = await runFailing({}, 'throw null');
    expect(error.kind).toBe('exception');
    expect(error.message).toBe('code run failed (exception): null');
  });

  it.each([
    ['丟假的中斷物件', 'throw { name: "InternalError", message: "interrupted" }'],
    [
      '丟名字是 InternalError 的例外',
      'throw Object.assign(new Error("interrupted"), { name: "InternalError" })',
    ],
    ['用假的中斷物件 reject', 'Promise.reject({ name: "InternalError", message: "interrupted" })'],
  ])('%s：照一般例外轉述，不是逾時', async (_label, code) => {
    const error = await runFailing({}, code);
    expect(error.kind).toBe('exception');
    expect(error.message).toBe('code run failed (exception): InternalError: interrupted');
  });
});

/**
 * 完成值必須是無損的 JSON（[#1572](https://github.com/DemianLi/nexus-agent/issues/1572) N0672），照 dsh 的 `prepareCompletion`
 * （`ptc-runtime-node/src/bootstrap.ts:164-188`）。以前 `0/0` 回 `null`、`new Map()` 回 `{}`、`{a: undefined}` 少一格，全部當成功——
 * 模型拿到錯的值，照著告訴使用者。
 */
describe('完成值必須是無損的 JSON', () => {
  const LOSSLESS = 'program completion must be lossless JSON';

  it.each([
    ['NaN', '0/0'],
    ['Infinity', '1/0'],
    ['-Infinity', '-1/0'],
    ['-0', '-0'],
    ['Map', 'new Map([[1, 2]])'],
    ['Set', 'new Set([1])'],
    ['Date', 'new Date(0)'],
    ['函式', '() => 1'],
    ['bigint', '1n'],
    ['symbol', 'Symbol("s")'],
    ['物件欄位是 undefined', '({ a: undefined })'],
    ['物件欄位是函式', '({ f() {} })'],
    ['物件裡有 NaN', '({ a: 0 / 0, b: 1 })'],
    ['陣列裡有 undefined', '[1, undefined, 2]'],
    ['陣列裡有 NaN', '[1, 0 / 0]'],
    ['稀疏陣列', '[, 1]'],
    ['陣列帶了多的屬性', '(() => { const a = [1]; a.extra = 2; return a; })()'],
    ['accessor 的 getter 回 NaN', '({ get a() { return 0 / 0; } })'],
    ['accessor 的 getter 回 undefined', '({ get a() { return undefined; } })'],
    ['accessor 的 getter 拋錯', '({ get a() { throw new Error("x"); } })'],
    [
      '陣列索引是 accessor、getter 回 NaN',
      '(() => { const a = []; Object.defineProperty(a, 0, { get() { return 0 / 0; }, enumerable: true }); return a; })()',
    ],
    ['陣列有洞又帶多的屬性', '(() => { const a = [, 1]; a.x = 1; return a; })()'],
    ['Array 的子類', '(() => { class A extends Array {} return A.from([1, 2]); })()'],
    ['說謊的 Proxy（trap 拋錯）', 'new Proxy({}, { ownKeys() { throw new Error("x"); } })'],
    [
      '原型被改掉的陣列',
      '(() => { const a = [1]; Object.setPrototypeOf(a, Object.create(Array.prototype)); return a; })()',
    ],
    [
      '陣列的洞被原型補上（索引加多的屬性湊成同樣的鍵數）',
      '(() => { Array.prototype[0] = 5; const a = [, 1]; a.x = 1; return a; })()',
    ],
    ['symbol 鍵', '({ [Symbol("k")]: 1 })'],
    [
      '不可列舉的欄位',
      '(() => { const o = {}; Object.defineProperty(o, "h", { value: 1 }); return o; })()',
    ],
    ['class 實例', '(() => { class P { constructor() { this.x = 1; } } return new P(); })()'],
    ['包裝物件', 'new Number(1)'],
    ['藏在深處的 NaN', '({ a: [{ b: [{ c: 0 / 0 }] }] })'],
  ])('%s：拋 invalid-output，不再默默變成 null 或 {}', async (_label, code) => {
    const error = await runFailing({}, code);
    expect(error.kind).toBe('invalid-output');
    expect(error.message).toBe(`code run failed (invalid-output): ${LOSSLESS}`);
  });

  it('promise 兌現的值、async 函式的回傳值一樣要檢查', async () => {
    expect((await runFailing({}, 'Promise.resolve(0 / 0)')).kind).toBe('invalid-output');
    expect((await runFailing({}, '(async () => new Map())()')).kind).toBe('invalid-output');
  });

  // 檢查用的內建函式在使用者的程式之前就收進閉包了。事後把其中一個改成「一律放行」，騙不了它：每一列只動一個內建函式，
  // 配一個只有那個函式擋得住的壞值（改成讀即時綁定的話，那一列就會放行而紅）。
  it.each([
    [
      'Object.getPrototypeOf',
      'Object.getPrototypeOf = () => Object.prototype;',
      'new Map([[1, 2]])',
    ],
    ['Reflect.ownKeys', 'Reflect.ownKeys = () => [];', '({ [Symbol("k")]: 1 })'],
    [
      'Object.prototype.propertyIsEnumerable',
      'Object.prototype.propertyIsEnumerable = () => true;',
      '(() => { const o = {}; Object.defineProperty(o, "h", { value: 1 }); return o; })()',
    ],
    [
      'Object.prototype.hasOwnProperty',
      'Object.prototype.hasOwnProperty = () => true; Array.prototype[0] = 5;',
      '(() => { const a = [, 1]; a.x = 1; return a; })()',
    ],
    ['Number.isFinite', 'Number.isFinite = () => true;', '0 / 0'],
    ['Object.is', 'Object.is = () => false;', '-0'],
    [
      'Array.isArray',
      'Array.isArray = () => false;',
      '(() => { const a = [1]; a.x = 2; return a; })()',
    ],
    [
      'WeakSet.prototype.has',
      'WeakSet.prototype.has = () => false;',
      '(() => { const a = {}; a.a = a; return a; })()',
    ],
  ])('程式事後改掉 %s 也騙不過', async (_name, tamper, bad) => {
    const error = await runFailing({ timeoutMs: 2_000 }, `(() => { ${tamper} return ${bad}; })()`);
    expect(error.kind).toBe('invalid-output');
  });

  // dsh 的快照一邊驗一邊抄、只讀一次（`snapshotPtcJsonValue`）：輸出就是驗過的那一份，不再去讀活的值。
  // 以前驗完再 dump 原本的 handle，原型上的 `toJSON` 與說謊的 Proxy 讓兩次讀到的不一樣，錯的值當成功回去（#1842 審查）。
  describe('驗過的就是輸出的：活的值動不了手腳', () => {
    it('Object.prototype.toJSON 改不了輸出', async () => {
      expect(
        await runTool(
          {},
          '(() => { Object.prototype.toJSON = function () { return 0 / 0; }; return { a: 1 }; })()',
        ),
      ).toBe('{\n  "a": 1\n}');
    });

    it('Array.prototype.toJSON 改不了輸出', async () => {
      expect(
        await runTool(
          {},
          '(() => { Array.prototype.toJSON = function () { return "x"; }; return [1, 2, 3]; })()',
        ),
      ).toBe('[\n  1,\n  2,\n  3\n]');
    });

    it('每個值只讀一次：getter 每讀一次換一個值，輸出就是它被讀到的那一個', async () => {
      expect(
        await runTool({}, '(() => { let n = 0; return { get a() { n += 1; return n; } }; })()'),
      ).toBe('{\n  "a": 1\n}');
    });

    it('Proxy 的 get 與 getOwnPropertyDescriptor 說不同的話：不會輸出驗過之外的值', async () => {
      const code = `(() => {
        let reads = 0;
        return new Proxy({ a: 1 }, {
          get(target, key) { reads += 1; return reads === 1 ? 1 : 0 / 0; },
        });
      })()`;
      expect(await runTool({}, code)).toBe('{\n  "a": 1\n}');
    });

    it('accessor 的 getter 回合格的值：照 dsh 收下', async () => {
      expect(await runTool({}, '({ get a() { return 1; } })')).toBe('{\n  "a": 1\n}');
    });
  });

  // 快照裡撞到記憶體上限算 invalid-output，所以記憶體上限給大、逾時給短：循環檢查壞了的話快照停不下來，跑成 timeout 而紅。
  it('循環參照：拋 invalid-output', async () => {
    const error = await runFailing(
      { memoryLimitBytes: 256 * 1024 * 1024, timeoutMs: 200 },
      '(() => { const a = {}; a.self = a; return a; })()',
    );
    expect(error.kind).toBe('invalid-output');
  });

  // 中斷觸發過就是逾時，跟它在快照的哪一步發生無關。
  it('快照裡的 getter 無窮迴圈：逾時，不是 invalid-output', async () => {
    const error = await runFailing({ timeoutMs: 200 }, '({ get a() { for (;;) {} } })');
    expect(error.kind).toBe('timeout');
  });

  // 沒觸發中斷，快照拋什麼都是「讀不出一份無損的值」，種類不看丟出來的值長什麼樣（#1846）。
  it.each([
    ['throw null', '({ get a() { throw null; } })'],
    [
      '丟假的中斷物件',
      '({ get a() { throw { name: "InternalError", message: "interrupted" }; } })',
    ],
    [
      '丟名字是 InternalError 的例外',
      '({ get a() { throw Object.assign(new Error("interrupted"), { name: "InternalError" }); } })',
    ],
  ])('快照裡的 getter %s：invalid-output', async (_label, code) => {
    const error = await runFailing({}, code);
    expect(error.kind).toBe('invalid-output');
    expect(error.message).toBe(`code run failed (invalid-output): ${LOSSLESS}`);
  });

  // 快照迭代走訪、不遞迴（#1841 當初量到 5000 層以上整顆 VM 中止）。
  it('一萬層巢狀的陣列照常回得來', async () => {
    const out = await runTool(
      { timeoutMs: 20_000, memoryLimitBytes: 256 * 1024 * 1024 },
      '(() => { let v = 1; for (let i = 0; i < 10000; i += 1) v = [v]; return v; })()',
    );
    expect(out.length).toBeGreaterThan(10_000);
  }, 30_000);

  it('stack 上限小到連快照函式都放不下：乾淨的失敗，不是 WASM abort', async () => {
    const error = await runFailing({ maxStackSizeBytes: 1000 }, '1');
    expect(['exception', 'timeout']).toContain(error.kind);
  });

  it('頂層的 undefined 不是失敗：仍是「沒有回傳值」', async () => {
    expect(await runTool({}, 'undefined')).toBe('（沒有回傳值）');
  });

  it('合格的值照常成功：null、布林、有限數字、字串、空容器、原型是 null 的物件', async () => {
    expect(await runTool({}, 'null')).toBe('null');
    expect(await runTool({}, 'true')).toBe('true');
    expect(await runTool({}, '-1.5')).toBe('-1.5');
    expect(await runTool({}, '[]')).toBe('[]');
    expect(await runTool({}, '({})')).toBe('{}');
    expect(await runTool({}, 'Object.assign(Object.create(null), { a: 1 })')).toBe(
      '{\n  "a": 1\n}',
    );
    // 同一個物件出現兩次不是循環。
    expect(await runTool({}, '(() => { const s = [1]; return [s, s]; })()')).toBe(
      '[\n  [\n    1\n  ],\n  [\n    1\n  ]\n]',
    );
  });
});

/** 非字串的結果用 dsh `renderJsonValue` 的縮排格式（`packages/core/tools/src/ptc.ts:214-281`），字串原樣。 */
describe('結果的呈現', () => {
  it('兩個空白縮排；字串不加引號', async () => {
    expect(await runTool({}, '({ a: 1, b: [true, null, "x"] })')).toBe(
      '{\n  "a": 1,\n  "b": [\n    true,\n    null,\n    "x"\n  ]\n}',
    );
    expect(await runTool({}, '"哈囉"')).toBe('哈囉');
  });

  it('總縮排超過 10 個字元之後的子樹改緊湊', async () => {
    const expected = [
      '{',
      '  "a": {',
      '    "b": {',
      '      "c": {',
      '        "d": {',
      '          "e": {"f":1,"g":[1,2]}',
      '        }',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    expect(await runTool({}, '({ a: { b: { c: { d: { e: { f: 1, g: [1, 2] } } } } } })')).toBe(
      expected,
    );
  });

  it('字串值與鍵走 JSON 跳脫', async () => {
    expect(await runTool({}, '({ "a\\nb": "x\\"y" })')).toBe('{\n  "a\\nb": "x\\"y"\n}');
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
    const error = await runFailing({}, 'import("node:fs")');
    expect(error.message).toContain("could not load module 'node:fs'");
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

  // 被 reject 的 promise 對模型來說跟 throw 是同一件事，所以走同一條。原樣把
  // `dump()` 攤出來的 `{type:"rejected",…}` JSON 出去的話，失敗會長得像成功。
  it('被 reject 的 promise 跟 throw 一樣是失敗', async () => {
    const error = await runFailing({}, 'Promise.reject(new Error("拒絕了"))');
    expect(error.kind).toBe('exception');
    expect(error.message).toBe('code run failed (exception): Error: 拒絕了');
  });

  // 等得到的都等到了還是 pending，代表它在等一個 VM 裡不存在的東西。這是永遠不會變的
  // 狀態，不是「再等一下就好」。#615 之前它算成功、回一句話；demian 拍板照 dsh 的結局算失敗
  // （dsh 等到預算用完，收在 `timeout`）。
  it('等不到的 promise 是失敗，種類是 timeout，原因講清楚它等不到', async () => {
    const error = await runFailing({}, 'new Promise(() => {})');
    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('永遠不會完成');
  });

  // 「這是不是 promise」問的是引擎（`getPromiseState`），不是 dump 出來的形狀。基座的
  // `dump()` 把 promise 攤成 `{ type, value }`，而那個形狀一般物件也戴得起來——靠形狀猜
  // 的話，這兩個完全正常的回傳值會被讀成 promise。
  it.each([
    ["({ type: 'pending' })", '{\n  "type": "pending"\n}'],
    ["({ type: 'fulfilled', value: 1 })", '{\n  "type": "fulfilled",\n  "value": 1\n}'],
    ["({ type: 'rejected', error: 'x' })", '{\n  "type": "rejected",\n  "error": "x"\n}'],
  ])('%s 是一般物件，不是 promise', async (code, expected) => {
    expect(await runTool({}, code)).toBe(expected);
  });
});

describe('資源邊界——只有設定的那麼強', () => {
  // **`timeoutMs` 的精度等於「最長的那一個操作」。** interrupt handler 是 QuickJS 在執行
  // 中回呼的，兩次回呼之間跑多久不歸我們管。這條測的是便宜的迴圈（每圈幾乎不花時間），
  // 所以攔得準；配置大塊記憶體那種昂貴操作攔不準，見 README 的邊界說明與底下那條。
  it('無限迴圈被中斷，不是讓測試逾時', async () => {
    const started = Date.now();
    const error = await runFailing({ timeoutMs: 200 }, 'while (true) {}');

    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('執行超過 200 毫秒');
    // 上限是「最多塞住多久」。放寬到 10 倍是給 CI 的排程噪音留的餘裕——這一條要證明的是
    // 「有沒有被擋下來」，不是中斷的精度。
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('吃記憶體被擋', async () => {
    // 時間上限刻意放寬，否則擋下它的可能是逾時而不是記憶體上限，這條就測不到想測的東西。
    // 斷言的是 `out of memory` 而不是泛泛的「錯誤」，理由同上：訊息不對就代表擋它的是別的東西。
    //
    // **指數成長，不是一次一小塊。** 原本寫的是 `push(new Array(10000))` 慢慢磨到上限，
    // 本地 2.1 秒、CI runner 上 5.03 秒——撞爆 vitest 預設的 5000ms testTimeout，gate 紅了
    // （CI #88）。倍增只要幾十步就到，本地量到 18ms。慢測試不是「調高 timeout」的理由，
    // 是測試寫法的問題。
    const error = await runFailing(
      { memoryLimitBytes: 1024 * 1024, timeoutMs: 10_000 },
      'let 越長越大 = [0]; for (;;) 越長越大 = 越長越大.concat(越長越大);',
    );

    expect(error.message).toContain('out of memory');
  });

  // 上限真的是我們設的那個在起作用，而不是撞到 QuickJS 自己的什麼天花板：同一段程式，
  // 上限放大 64 倍就要跑久得多（實測 18ms → 563ms）。少了這一條，一個「這段程式無論如何
  // 都會 out of memory」的世界也會讓上面那條通過。
  it('上限放大，撐得比較久', async () => {
    const code = 'let 越長越大 = [0]; for (;;) 越長越大 = 越長越大.concat(越長越大);';
    const 小的 = Date.now();
    await runFailing({ memoryLimitBytes: 1024 * 1024, timeoutMs: 10_000 }, code);
    const 小的耗時 = Date.now() - 小的;

    const 大的 = Date.now();
    await runFailing({ memoryLimitBytes: 32 * 1024 * 1024, timeoutMs: 10_000 }, code);
    const 大的耗時 = Date.now() - 大的;

    expect(大的耗時).toBeGreaterThan(小的耗時);
  });

  // 堆疊與記憶體是兩條軸：無窮遞迴吃的是前者，只設記憶體上限擋不住它。這一條要是紅了，
  // 八成是有人把 `maxStackSizeBytes` 拿掉了，覺得記憶體上限已經涵蓋。
  // 刻意斷言一個**限制**而不是一個保證：一段瘋狂配置記憶體的程式跑得遠遠超過
  // `timeoutMs`，因為 interrupt handler 只在兩個操作之間被回呼，而單一次巨量配置本身
  // 就很久。所以擋這一類的是 `memoryLimitBytes`，不是逾時——README 那句「最多塞住多久」
  // 有這個但書。
  //
  // 記憶體上限刻意給得大（32 MiB）但**有界**：真的設 `-1` 的話收場的是 host 的 WASM heap
  // 耗盡，本地量到 6.7 秒而且時間取決於機器有多少記憶體，那種測試進不了 gate。
  it('逾時攔不住瘋狂配置記憶體的程式——那是記憶體上限的工作', async () => {
    const started = Date.now();
    const error = await runFailing(
      { memoryLimitBytes: 32 * 1024 * 1024, timeoutMs: 50 },
      'let 越長越大 = [0]; for (;;) 越長越大 = 越長越大.concat(越長越大);',
    );
    const 實際耗時 = Date.now() - started;

    // 收場的是記憶體上限，不是逾時——訊息本身就是證據。
    expect(error.message).toContain('out of memory');
    // 而且它跑得比逾時久得多。攔得住的話這條會紅，那代表 README 該改的是另一邊。
    expect(實際耗時).toBeGreaterThan(50);
  });

  it('無窮遞迴撞的是堆疊上限，不是記憶體上限', async () => {
    const error = await runFailing(
      { maxStackSizeBytes: 64 * 1024, timeoutMs: 10_000 },
      'function 遞迴() { return 遞迴(); } 遞迴()',
    );

    expect(error.message).toContain('stack overflow');
  });

  // #1841
  it('預設上限下的無窮遞迴：VM 的 stack overflow，不是 host 的堆疊先用完', async () => {
    for (const code of [
      '(function f() { return f(); })()',
      'try { (function f() { return f(); })(); } catch (e) { throw e; }',
      '({ get x() { return this.x; } }).x',
    ]) {
      const error = await runFailing({}, code);
      expect(error.kind, code).toBe('exception');
      expect(error.message, code).toContain('stack overflow');
    }
  });

  // #1841：要 host 的堆疊比 VM 上限先用完（機制見 index.ts 的 runInVm）。Node 預設的堆疊下，大約 0.3 到 4 MiB 之間是 host
  // 先用完；再大的話先到的是 WASM 自己的上限，又變回 VM 裡的錯。取 2 MiB 落在中間。
  const HOST_OVERFLOW_STACK_BYTES = 2 * 1024 * 1024;

  it('host 的堆疊先用完：回 exception，下一次呼叫照常', async () => {
    const { registry } = await loadPlugins([
      createQuickJsPlugin({ maxStackSizeBytes: HOST_OVERFLOW_STACK_BYTES, timeoutMs: 10_000 }),
    ]);
    const tool = registry.tools.resolve(RUN_JAVASCRIPT_TOOL_NAME)!.value as StructuredTool;

    for (let round = 0; round < 3; round += 1) {
      const error: unknown = await tool.invoke({ code: '(function f() { return f(); })()' }).then(
        (value: unknown) => new Error(`預期失敗，卻回了：${String(value)}`),
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(CodeRunFailedError);
      expect((error as CodeRunFailedError).kind).toBe('exception');
      expect((error as CodeRunFailedError).message).toContain('Maximum call stack size exceeded');
      expect(String(await tool.invoke({ code: '1 + 1' }))).toBe('2');
    }
  });
});

describe('plugin 的接線', () => {
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

describe('設定（#453）', () => {
  it('省略時三格都由 schema 補上預設值', () => {
    expect(quickJsConfigSchema.parse({})).toEqual({
      timeoutMs: DEFAULT_TIMEOUT_MS,
      memoryLimitBytes: DEFAULT_MEMORY_LIMIT_BYTES,
      maxStackSizeBytes: DEFAULT_MAX_STACK_SIZE_BYTES,
    });
  });

  it('不是正整數就讓載入失敗，訊息帶 `<id> (<name>)` 與欄位路徑', async () => {
    for (const bad of [{ timeoutMs: 0 }, { memoryLimitBytes: -1 }, { maxStackSizeBytes: 1.5 }]) {
      const field = Object.keys(bad)[0]!;
      await expect(loadPlugins([createQuickJsPlugin(bad)])).rejects.toThrow('quickjs#0 (quickjs)');
      await expect(loadPlugins([createQuickJsPlugin(bad)])).rejects.toThrow(field);
    }
  });

  it('未知欄位讓載入失敗（登記的偏離：dsh 放行）', async () => {
    await expect(
      loadPlugins([{ plugin: quickJsPlugin, config: { timeoutMS: 100 } }]),
    ).rejects.toThrow(/timeoutMS/);
  });
});
