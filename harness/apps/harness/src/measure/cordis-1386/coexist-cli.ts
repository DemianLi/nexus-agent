/**
 * `coexist.ts` 的入口：在 tsx 子行程裡跑，結果一行一個 JSON 印到 stdout。
 *
 * ```bash
 * pnpm --filter @nexus/harness exec node --import tsx src/measure/cordis-1386/coexist-cli.ts
 * ```
 *
 * @module
 */

import { runCoexist, runWithoutIsolate } from './coexist.js';

console.log(JSON.stringify({ kind: 'coexist', ...(await runCoexist()) }));
console.log(JSON.stringify({ kind: 'without-isolate', ...(await runWithoutIsolate()) }));
