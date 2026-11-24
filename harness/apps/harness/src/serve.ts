#!/usr/bin/env node
/**
 * `nexus-serve` 的入口（`bin` 指的 `lib/serve.js`）。本體在 `serve-run.ts`。
 *
 * **這支不 export 任何東西，也不准被任何模組 import**（[#2657](https://github.com/DemianLi/nexus-agent/issues/2657)）：
 * 被別的入口 import 時，打包會把它的本體搬進共用 chunk，`lib/serve.js` 只剩一行 re-export，
 * 下面的 `import.meta.main` 在 chunk 裡永遠是 false，serve 什麼都不印、以 0 結束。
 * 要 serve 的程式碼一律 import `serve-run.ts`（`smoke-built-bin` 檢查第 3 條會擋）。
 *
 * @module
 */

import { serveMain } from './serve-run.js';

// 用 `import.meta.main`，不比路徑：裝好之後經 `node_modules/.bin` 的符號連結啟動時，
// `argv[1]` 是連結、`import.meta.url` 是真實路徑，比路徑會靜靜不執行、以 0 結束。
if (import.meta.main) {
  await serveMain();
}
