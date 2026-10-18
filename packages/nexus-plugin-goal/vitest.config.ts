import { defineConfig } from 'vitest/config';

import { pathsPlugin, sourceHook } from '../../vitest.shared.ts';

/**
 * `eslint-exclusion.test.ts` 用 `new ESLint({ overrideConfigFile })` 量這個套件真的那份 `eslint.config.js`，而 ESLint 是用 Node
 * 原生 `import` 載設定，設定裡的 `@nexus/sdk/lint` 看不到 vite 的 `paths`：要經 tsx 的 hook（理由與撤除條件見 `vitest.shared.ts`）。
 */
export default defineConfig({
  plugins: [pathsPlugin()],
  test: {
    execArgv: sourceHook(),
  },
});
