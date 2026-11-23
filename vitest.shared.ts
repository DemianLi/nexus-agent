import { fileURLToPath } from 'node:url';

import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * 每個套件的 `vitest.config.ts` 共用的模組解析：測試裡的裸 workspace 名一律解析到 `src/`，不經 `exports` 走到建出來的 `lib/`，
 * 否則 `lib/` 過期時會載到第二份模組單例。
 *
 * 這一份讀 `tsconfig.runtime.json` 而不是 `tsconfig.base.json`：兩份由 `harness/scripts/gen-tsconfig-paths.ts` 一起寫、
 * `--check` 一起查，差別只在 `harness/vendor/*` 要不要映到 `src/`（vendor 的原始碼不過 base 的嚴格設定，映進去 `tsc` 會多出 186 個錯；
 * 但測試與 tsx 沒有型別檢查，要的是 vendor 也走 `src/`，不然 Cordis 會有 `lib/` 與 `src/` 兩份）。
 */
const RUNTIME_TSCONFIG = fileURLToPath(new URL('./tsconfig.runtime.json', import.meta.url));

/**
 * @returns 讓 vite 轉換的 `import` 照 `paths` 解析的外掛。
 */
export const pathsPlugin = (): ReturnType<typeof tsconfigPaths> =>
  tsconfigPaths({ projects: [RUNTIME_TSCONFIG] });

/**
 * `plugin-tree.ts` 的 `resolveBareSpecifier` 是 Node 原生的 `import.meta.resolve`，看不到 vite 的 `paths` 外掛，
 * 要經 tsx 的 resolve hook 才會照 `paths` 解析。所以只在 vitest worker 的 `execArgv` 裝 tsx 的 ESM hook，
 * `TSX_TSCONFIG_PATH` 指到上面那份 tsconfig。
 *
 * **影響範圍比「只動 worker」寬一格**：這個函式在 vitest **主行程**設 `process.env.TSX_TSCONFIG_PATH`，所以測試裡開的
 * `node --import tsx` 子行程，沒自己給 `env` 的（例如 `entry-main.test.ts`）會繼承它，實際解析改走 runtime 那份 tsconfig，
 * 即使啟動指令沒改。自己給 `env`、又沒展開 `process.env` 的不會繼承，要明確帶上（例如 `conversation-process.test.ts`），否則 tsx 把 `@nexus/*`
 * 解到 `lib/`，在乾淨的樹（CI）上找不到。這是刻意的：子行程測試也因此能把 `@nexus/*` 解到 `src/`。
 * 要在子行程裡驗「沒有 tsx 蓋著」的情況，用 `harness/scripts/smoke-built-bin.ts`（它清掉 `NODE_OPTIONS`、`NODE_PATH` 與這個變數）。
 *
 * 撤除條件：`harness/apps/harness` 那批對行程內物件下斷言（函式身分、樹上的列、middleware 鏈、ctx 服務物件）的測試改走子行程或 `lib` 模式的那一天，
 * 就拿掉這個函式（那批測試的分類與不能改的理由見 `docs/plugin-contract.md` 裡 vitest worker 的 `execArgv` 那一列）。
 * @returns 要放進 `test.execArgv` 的參數。
 */
export const sourceHook = (): string[] => {
  process.env.TSX_TSCONFIG_PATH = RUNTIME_TSCONFIG;
  return ['--import', 'tsx/esm'];
};
