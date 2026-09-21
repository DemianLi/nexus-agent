/**
 * 一個**一律報違規**的配套入口 plugin。
 *
 * ```
 * pnpm --filter @nexus/harness run cli --patch src/cli-invariant-violation.patch.yml "回聲一下"
 * ```
 *
 * **它證的是「違規真的看得見」，不是「檢查真的對」。** 那兩件事需要相反的素材：正確性
 * 要一份不吭聲的檢查跑在真流量上（出貨清單現在就有——見
 * [#107](https://github.com/DemianLi/nexus-agent/issues/107)，跑一次 `run cli` 沒有任何
 * `[不變量]` 就是通過），可見性要一份保證會吭聲的。
 *
 * 這一份取代了原本的 `cli-invariant.fixture.ts`：那份是「預設清單 ＋ core 的配套入口」，
 * 而配套入口進了預設清單之後，兩者就會變成一模一樣的執行。這一份現在是「出貨 27 列 ＋ 這顆」
 * ——形狀上似乎跟那份舊的一樣，但區別在於這顆是保證會拋（吭聲），那份舊的是不拋（不吭聲）。
 *
 * 印出來的每一行都帶 `[不變量]` 前綴走 stderr，而不是 runner 預設的 `console.error`
 * ——CLI 的輸出全部走 `Printer`，違規不是例外。
 *
 * **不要 `import` `cli.js`——那會死鎖。** `cli.ts` 當腳本跑時最後一行是 top-level
 * `await main()`，而這份 fixture 是 `main()` 裡面 `loadPluginModule()` 動態載進來的：
 * 靜態 import 回 `./cli.js` 等於等一個還沒結束的模組求值，行程會停在
 * `Detected unsettled top-level await` 然後以 13 退出。**單元測試看不到這件事**
 * （vitest 是 import 這個模組，`main()` 的 guard 是 false），是手動跑 `run cli --patch`
 * 才炸出來的。
 */

import type { NexusPlugin } from '@nexus/core';

/** 這份清單認領的假 package 名。真的 package 不會用它，所以撞不到任何人。 */
export const NOISY_INVARIANT_PACKAGE = '@nexus/noisy';

const noisyInvariant: NexusPlugin = {
  name: 'noisy-invariant',
  apply(registry) {
    registry.invariants.register(NOISY_INVARIANT_PACKAGE, (subject, fail) => {
      subject.observe((event) => fail(`看到 ${event.type}`));
    });
  },
};

export default noisyInvariant;
