# vendor 的套件

上游原始碼直接複製進 monorepo，不經 npm 相依。格式照 dsh 的 `vendor/README.md`：清單記上游 commit，本地修改逐條登記，每個套件目錄保留上游的 MIT `LICENSE`。

目前這裡只是 [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 探針的素材，沒有接進出貨路徑。為什麼 vendor、為什麼是上游 main，見 [`.docs/decisions-2026-10-11.md`](../.docs/decisions-2026-10-11.md) §3-1。

## 清單

| 目錄 | 套件名 | 版本 | 上游 | commit |
|---|---|---|---|---|
| `cordis/` | `cordis` | 4.0.0-rc.10 | https://github.com/cordiverse/cordis（`packages/core`） | `c261dd2c13d65b1994adb1cdc10d7dba61542523` |
| `cordis-loader/` | `@cordisjs/plugin-loader` | 1.0.0-rc.7 | https://github.com/cordiverse/cordis（`packages/loader`） | `c261dd2c13d65b1994adb1cdc10d7dba61542523` |

套件名保留上游的，不像 dsh 改成自己的 scope：我們不發佈這兩個套件，換名只會多一條本地修改。

第三方相依留在 npm：`cosmokit`、`@standard-schema/spec`。`node-addon-require-builtin` 是 Loader 的選配 peer，沒有裝，Loader 走「沒有 Node internals」那條路。

刻意不 vendor：`hmr`（決議 §3-1 第 1 條）、`include`（決議 §3-5，樹由變更紀錄導出）、`group`、`timer`、`logger-console`、`create`、`utils`。

## 本地修改

逐條列出與上游的每一處不同。

1. **`cordis/src/*.ts` 相對路徑加 `.ts` 副檔名**：九個檔的相對 import、export 與 `declare module './context'` 都加 `.ts`，`utils.ts` 的 `import type { Context, Service } from '.'` 拆成兩行各指 `./context.ts`、`./service.ts`。內容與上游還開著的 [cordiverse/cordis#125](https://github.com/cordiverse/cordis/pull/125)（修 [#124](https://github.com/cordiverse/cordis/issues/124)）逐檔行數相同；#125 的 diff 在 `events.ts` 與 c261dd2c 衝突，所以用腳本照它的規則重做，沒有直接套 patch。理由：上游原樣在 NodeNext 下整個匯出面是空的（探針 ① 的數字）。#125 合併後這條撤掉。等同 dsh 第 4 條的 core 那一半。
2. **兩個 `package.json` 重寫**：`exports["."]` 的 `types` 指向 `lib/types/index.d.ts`、`default` 指向 `src/index.ts`（tsx 與 vitest 直接跑原始碼，不建 JS）；加 `prepare: tsc -p tsconfig.json`，`pnpm install` 時產生宣告檔；去掉上游的 build、repository、files 等發佈欄位；Loader 的 `cordis` 從 peer 改成 `workspace:*` 相依。等同 dsh 第 2 條。
3. **兩個 `tsconfig.json` 是我們的**：NodeNext，只產生宣告檔到 `lib/types`，嚴格度照上游（`noImplicitAny: false`，core 另有 `noImplicitThis: false`、`strictFunctionTypes: false`）。理由：上游原始碼過不了 nexus 的 strict 與 `verbatimModuleSyntax`（探針 ① 的 (c)：155 個錯），所以消費者只讀宣告檔。等同 dsh 第 3 條。

### 沒有移植的

- **dsh 第 6 條（fiber 重入卸載三處）**：探針沒有觸及在 setup 裡發起卸載的情形，先不移植，才量得出「以上游 main 為底」本身行不行。上游對應的修補是還開著的 [#185](https://github.com/cordiverse/cordis/pull/185)。
- **[#127](https://github.com/cordiverse/cordis/issues/127)（非 ACTIVE 的 fiber 卸載後停不到 DISPOSED）**：在 c261dd2c 上照 issue 的 repro 實跑仍然重現（PENDING 停在 0、失敗過的停在 3）。上游的修補 #133、#140 都還開著。

## 同步

1. 在上游 clone 記下 `git rev-parse HEAD`，對過 `git ls-remote https://github.com/cordiverse/cordis HEAD`。
2. 把 `packages/core/src`、`packages/loader/src` 蓋過對應目錄的 `src`，`LICENSE` 有變就一起換。
3. 重做上面的本地修改；上游已經做了的就撤掉那一條，登記表照改。
4. 更新清單的 commit 與版本，跑 `pnpm install`（重建宣告檔）與 `pnpm --filter @nexus/harness exec vitest run src/measure/cordis-1386`。
