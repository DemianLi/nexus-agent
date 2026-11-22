import { defineConfig } from 'tsdown';

import { workspacePackages } from './scripts/workspace-packages.ts';

/**
 * 每個 workspace 套件各編一份 `lib/`（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502)）：ESM、`platform: 'node'`、`es2024`、不產 dts、不產 sourcemap。
 *
 * - **一個套件一份，不併成一個檔。** Cordis Loader 依設定裡的套件名在執行期動態 import 插件（`vendor/loader/src/config/tree.ts`），
 *   產物必須保留套件結構。
 * - **入口從 manifest 推**（`scripts/workspace-packages.ts`）：`main`、`exports`、`bin`、`imports` 指的 `./lib/<路徑>.js`
 *   對到 `./src/<路徑>.ts`。manifest 加一個 subpath，這裡自動多一個入口。
 * - **所有裸 specifier 都不打進去**（`deps.neverBundle: true`）：套件之間、套件與第三方一律在執行期解析。
 *   tsdown 預設只外掛 `dependencies`／`peerDependencies`，devDependencies 裡的 workspace 套件（例如 `@nexus/cordis`）會被內嵌，單例就壞了，
 *   所以用 `neverBundle`：套件之間不內嵌、單例只有一份。**撤除條件**：補上一支檢查每個套件把 cordis 同時列進 peer 與 dev 的約束檢查
 *   （登記在 `docs/plugin-contract.md:588`）。
 * - **直接編 TypeScript，不經 `tsc -b`，所以 `files: ["lib"]` 也不逐檔列**：#1502 規定不產 dts。
 */
export default defineConfig(
  workspacePackages().map((pkg) => ({
    cwd: pkg.dir,
    entry: pkg.entries,
    outDir: 'lib',
    format: ['esm' as const],
    platform: 'node' as const,
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: true as const },
  })),
);
