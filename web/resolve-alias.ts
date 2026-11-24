import { fileURLToPath, URL } from 'node:url';

import type { AliasOptions } from 'vite';

/**
 * `vite.config.ts` 與 `vitest.config.ts` 共用的模組解析（tsconfig 的 `paths` 是另一份，`resolve-alias.test.ts` 對過兩邊）。
 *
 * **裸的 `cn` 解析到 `src/lib/utils.ts`**（#1523）：vendor 的 solid-glass 元件原樣 `import { cn } from "cn"`，npm 的 `cn`
 * 不認得 nexus 自訂的字級與圓角名（`text-ui`、`rounded-row`），會把 #1141 帶回來；vendor 的檔不動（#1468 Q9），所以在解析層換掉。
 * 用正規式只比對**整個**specifier：字串鍵 `cn` 也會比對 `cn/` 開頭的路徑，`utils.ts` 自己的 `cn/config` 就會被改寫壞掉。
 */
export const RESOLVE_ALIAS: AliasOptions = [
  { find: /^cn$/, replacement: fileURLToPath(new URL('./src/lib/utils.ts', import.meta.url)) },
  { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
];
