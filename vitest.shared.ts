import { fileURLToPath } from 'node:url';

import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * 每個套件的 `vitest.config.ts` 共用的模組解析（照 dsh 根目錄 `vitest.config.ts` 的 `pathsPlugin` 與 `docs/testing.md`
 * 「Test resolution: source plane only」）：測試裡的裸 workspace 名一律解析到 `src/`，不經 `exports` 走到建出來的 `lib/`，
 * 否則 `lib/` 過期時會載到第二份模組單例。
 *
 * 這一份讀 `tsconfig.runtime.json` 而不是 `tsconfig.base.json`：兩份由 `scripts/gen-tsconfig-paths.ts` 一起寫、
 * `--check` 一起查，差別只在 `vendor/*` 要不要映到 `src/`（vendor 的原始碼不過 base 的嚴格設定，映進去 `tsc` 會多出 186 個錯；
 * 但測試與 tsx 沒有型別檢查，要的是 vendor 也走 `src/`，不然 Cordis 會有 `lib/` 與 `src/` 兩份）。
 */
const RUNTIME_TSCONFIG = fileURLToPath(new URL('./tsconfig.runtime.json', import.meta.url));

/**
 * @returns 讓 vite 轉換的 `import` 照 `paths` 解析的外掛。
 */
export const pathsPlugin = (): ReturnType<typeof tsconfigPaths> =>
  tsconfigPaths({ projects: [RUNTIME_TSCONFIG] });

/**
 * **偏離 dsh，理由 1（基座表達不出來）。** dsh 處理 workspace 裸名插件只有兩種做法：開子行程
 * （`loader-smoke/src/index.ts:100-127`），或在 `mkdtemp` 底下手寫 `node_modules`（`app-boot.spec.ts` 約 `:934-990`）。
 * 兩種都表達不出 `apps/harness` 那 80 個測試檔對行程內物件的斷言（函式身分 `toBe(applyX)`、樹上的列、middleware 鏈、
 * ctx 服務物件）；要表達只能重寫斷言。`plugin-tree.ts` 的 `resolveBareSpecifier` 是 Node 原生的 `import.meta.resolve`，
 * 看不到 vite 的 `paths` 外掛，要經 tsx 的 resolve hook 才會照 `paths` 解析。
 *
 * 退到最接近的做法：只在 vitest worker 的 `execArgv` 裝 tsx 的 ESM hook（dsh 的 source-launch 筆記
 * `2026-07-29-dsh-source-launch-tsx-esm.zh.md` 的機制），`TSX_TSCONFIG_PATH` 指到上面那份 tsconfig。
 * 子行程的**啟動指令**不動。`docs/testing.md:49` 管的是載入 Cordis 設定的子行程，不管 worker。
 *
 * **影響範圍比「只動 worker」寬一格**：這個函式在 vitest **主行程**設 `process.env.TSX_TSCONFIG_PATH`，所以測試裡開的每個
 * `node --import tsx` 子行程（例如 `entry-main.test.ts` 沒傳 `env`）都會繼承它，實際解析改走 runtime 那份 tsconfig，
 * 即使啟動指令沒改。這是退到的做法的一部分，不是副作用：子行程測試也因此能把 `@nexus/*` 解到 `src/`（乾淨樹上沒有 `lib/`）。
 * 要在子行程裡驗「沒有 tsx 蓋著」的情況，用 `scripts/smoke-built-bin.ts`（它清掉 `NODE_OPTIONS`、`NODE_PATH` 與這個變數）。
 *
 * 撤除條件：這批測試改走子行程或 `lib` 模式的那一天，就拿掉這個函式。
 * @returns 要放進 `test.execArgv` 的參數。
 */
export const sourceHook = (): string[] => {
  process.env.TSX_TSCONFIG_PATH = RUNTIME_TSCONFIG;
  return ['--import', 'tsx/esm'];
};
