# vendor 的套件

上游原始碼直接複製進 monorepo，不經 npm 相依。格式照 dsh 的 `vendor/README.md`：清單記上游 commit，本地修改逐條登記，每個套件目錄保留上游的 MIT `LICENSE`。

為什麼 vendor、為什麼是上游 main，見 [`.docs/decisions-2026-10-11.md`](../.docs/decisions-2026-10-11.md) §3-1。探針 [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 量過可行；[#1401](https://github.com/DemianLi/nexus-agent/issues/1401) 起是正式 vendor（demian 2026-10-11）。

## 清單

| 目錄 | 套件名 | 上游套件名 | 版本 | 上游 | commit |
|---|---|---|---|---|---|
| `cordis/` | `@nexus/cordis` | `cordis` | 4.0.0-rc.10 | https://github.com/cordiverse/cordis（`packages/core`） | `c261dd2c13d65b1994adb1cdc10d7dba61542523` |
| `loader/` | `@nexus/cordis-plugin-loader` | `@cordisjs/plugin-loader` | 1.0.0-rc.7 | https://github.com/cordiverse/cordis（`packages/loader`） | `c261dd2c13d65b1994adb1cdc10d7dba61542523` |

第三方相依留在 npm：`cosmokit`、`@standard-schema/spec`。`node-addon-require-builtin` 是 Loader 的選配 peer，沒有裝，Loader 走「沒有 Node internals」那條路。

刻意不 vendor：`hmr`（決議 §3-1 第 1 條）、`include`（決議 §3-5，樹由變更紀錄導出）、`group`、`timer`、`logger-console`、`create`、`utils`。

## 本地修改

逐條列出與上游的每一處不同。標「腳本」的由 [`sync.mjs`](sync.mjs) 重做，同步時不必手改。

1. **`cordis/src/*.ts` 相對路徑加 `.ts` 副檔名**（腳本）：相對 import、export 與 `declare module './context'` 都加 `.ts`，`utils.ts` 的 `import type { Context, Service } from '.'` 拆成兩行各指 `./context.ts`、`./service.ts`。等同上游還開著的 [cordiverse/cordis#125](https://github.com/cordiverse/cordis/pull/125)（修 [#124](https://github.com/cordiverse/cordis/issues/124)）與 dsh 第 4 條的 core 那一半。理由：上游原樣在 NodeNext 下整個匯出面退化成 `any`（探針 ① 的數字）。#125 合併後撤掉。
2. **兩個 `package.json` 重寫**：`exports["."]` 的 `types` 指向 `lib/types/index.d.ts`、`default` 指向 `src/index.ts`（tsx 與 vitest 直接跑原始碼，不建 JS）；`prepare: tsc -p tsconfig.json` 在 `pnpm install` 時產生宣告檔，它同時是 vendor 原始碼的型別檢查；core 另有 `test: vitest run`；去掉上游的 build、repository、files 等發佈欄位。等同 dsh 第 2 條。
3. **兩個 `tsconfig.json` 是我們的**：NodeNext，只產生宣告檔到 `lib/types`，嚴格度照上游（`noImplicitAny: false`，core 另有 `noImplicitThis: false`、`strictFunctionTypes: false`）。理由：上游原始碼過不了 nexus 的 strict 與 `verbatimModuleSyntax`，所以消費者只讀宣告檔。等同 dsh 第 3 條。
4. **換成 `@nexus` scope**（腳本）：套件名、套件之間的相依、指向它們的 module specifier 與 `declare module` 都換。執行期的識別字不改：`Symbol.for(...)` 的鍵、Loader 的 `cordis:` 內建前綴、logger 名照上游。照 dsh 第 17 條。
5. **`cordis/tests/tsconfig.json` 拿掉**（腳本）：它 extends 上游根目錄的 `tsconfig.test`，那份沒有 vendor；拿掉後 vitest 用套件自己的 tsconfig。上游測試整包搬進來，在 CI 全跑時執行。
6. **`patches/0001-cordis-185-disposal-order.patch`：上游 [#185](https://github.com/cordiverse/cordis/pull/185) 原樣**（腳本套用），修 fiber 啟用與卸載的四個順序缺陷，是 dsh 第 6 條在上游的對應，附它自己的四條測試。**它同時修好了 [#127](https://github.com/cordiverse/cordis/issues/127)**（非 ACTIVE 的 fiber 卸載後停不到 `DISPOSED`）：從沒啟用過與失敗過的 fiber 卸載時也跑 `_unload()`，經過 UNLOADING 收斂到 DISPOSED。驗證在 `cordis/nexus-tests/settle.spec.ts`（PENDING、LOADING、FAILED 三種起點）與探針 ③ 的負對照；拿掉這份修補，PENDING 停在 0、FAILED 停在 3。#185 合併後撤掉。

`cordis/nexus-tests/` 是我們自己的回歸測試，不是上游的，腳本不碰。

### 沒有移植的

- **[#133](https://github.com/cordiverse/cordis/pull/133)、[#140](https://github.com/cordiverse/cordis/pull/140)（上游為 #127 開的修補）**：兩份的程式改動是同一行，在 #185 之上是多餘的；它們的測試預期 PENDING／FAILED 直接跳到 DISPOSED，與 #185 經過 UNLOADING 的語意衝突。上游若先合了其中一份，下次同步時要重看 #185 是否還套得上。
- **dsh 第 10 條（被抹掉的 import 標成 `type`）**：那是給 Node 原生 TypeScript 轉譯用的，我們只用 tsx 與 vitest 跑原始碼，碰不到。

## 同步

1. 在上游 clone 記下 `git rev-parse HEAD`，對過 `git ls-remote https://github.com/cordiverse/cordis HEAD`。
2. 看 `patches/` 裡每一份對應的上游 PR 合了沒；合了就刪掉那一份，登記表照改。
3. `node vendor/sync.mjs <上游 clone>` 重建 `cordis/{src,tests}` 與 `loader/src`；修補套不上時腳本直接失敗。`LICENSE` 有變就手動換。
4. 更新清單的 commit 與版本，跑 `pnpm install`（重建宣告檔）、`pnpm --filter ./vendor/cordis run test` 與 `pnpm --filter @nexus/harness exec vitest run src/measure/cordis-1386`。

`node vendor/sync.mjs <上游 clone> --check` 只比對不寫入：從上游加上登記的修改重建一份，與 vendor 逐檔比，有差異就列出並以 1 退出。登記表外的手改會在這裡現形。
