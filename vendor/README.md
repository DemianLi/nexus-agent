# vendor 的套件

上游原始碼直接複製進 monorepo，不經 npm 相依。格式照 dsh 的 `vendor/README.md`：清單記上游 commit，本地修改逐條登記，每個套件目錄保留上游的 MIT `LICENSE`。

為什麼 vendor、為什麼是上游 main，見 [`.docs/decisions-2026-10-11.md`](../.docs/decisions-2026-10-11.md) §3-1。探針 [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 量過可行；[#1401](https://github.com/DemianLi/nexus-agent/issues/1401) 起是正式 vendor（demian 2026-10-11）。

## 清單

| 目錄 | 套件名 | 上游套件名 | 版本 | 上游 | commit |
|---|---|---|---|---|---|
| `cordis/` | `@nexus/cordis` | `cordis` | 4.0.0-rc.10 | https://github.com/cordiverse/cordis（`packages/core`） | `c261dd2c13d65b1994adb1cdc10d7dba61542523` |
| `loader/` | `@nexus/cordis-plugin-loader` | `@cordisjs/plugin-loader` | 1.0.0-rc.7 | https://github.com/cordiverse/cordis（`packages/loader`） | `c261dd2c13d65b1994adb1cdc10d7dba61542523` |
| `include/` | `@nexus/cordis-plugin-include` | `@cordisjs/plugin-include` | 1.1.0 | https://github.com/cordiverse/cordis（`packages/include`） | `c261dd2c13d65b1994adb1cdc10d7dba61542523` |

第三方相依留在 npm：`cosmokit`、`@standard-schema/spec`、`js-yaml`（Include 讀 YAML）。`node-addon-require-builtin` 是 Loader 的選配 peer，沒有裝，Loader 走「沒有 Node internals」那條路。

刻意不 vendor：`hmr`（決議 §3-1 第 1 條）、`group`、`timer`、`logger-console`、`create`、`utils`。

`include` 在 [#1416](https://github.com/DemianLi/nexus-agent/issues/1416) PR 2 vendor 進來：決議 §3-5「樹由變更紀錄導出」的做法就是 dsh 的做法——變更紀錄折出 patch 清單，經 `entry.update({ config: { ...includeConfig, patches } })` 推給 Include。原先寫「不 vendor」是因為當時沒有任何一列在樹上；echo 上樹之後那個理由不成立。

## 本地修改

逐條列出與上游的每一處不同。標「腳本」的由 [`sync.mjs`](sync.mjs) 重做，同步時不必手改。

1. **`cordis/src/*.ts` 相對路徑加 `.ts` 副檔名**（腳本）：相對 import、export 與 `declare module './context'` 都加 `.ts`，`utils.ts` 的 `import type { Context, Service } from '.'` 拆成兩行各指 `./context.ts`、`./service.ts`。等同上游還開著的 [cordiverse/cordis#125](https://github.com/cordiverse/cordis/pull/125)（修 [#124](https://github.com/cordiverse/cordis/issues/124)）與 dsh 第 4 條的 core 那一半。理由：上游原樣在 NodeNext 下整個匯出面退化成 `any`（探針 ① 的數字）。#125 合併後撤掉。
2. **兩個 `package.json` 重寫**：`exports["."]` 的 `types` 指向 `lib/types/index.d.ts`、`default` 指向 `src/index.ts`（tsx 與 vitest 直接跑原始碼，不建 JS）；`prepare: tsc -p tsconfig.json` 在 `pnpm install` 時產生宣告檔，它同時是 vendor 原始碼的型別檢查；core 另有 `test: vitest run`；去掉上游的 build、repository、files 等發佈欄位。等同 dsh 第 2 條。
3. **兩個 `tsconfig.json` 是我們的**：NodeNext，只產生宣告檔到 `lib/types`，嚴格度照上游（`noImplicitAny: false`，core 另有 `noImplicitThis: false`、`strictFunctionTypes: false`）。理由：上游原始碼過不了 nexus 的 strict 與 `verbatimModuleSyntax`，所以消費者只讀宣告檔。等同 dsh 第 3 條。
4. **換成 `@nexus` scope**（腳本）：套件名、套件之間的相依、指向它們的 module specifier 與 `declare module` 都換。執行期的識別字不改：`Symbol.for(...)` 的鍵、Loader 的 `cordis:` 內建前綴、logger 名照上游。照 dsh 第 17 條。
5. **`cordis/tests/tsconfig.json` 拿掉**（腳本）：它 extends 上游根目錄的 `tsconfig.test`，那份沒有 vendor；拿掉後 vitest 用套件自己的 tsconfig。上游測試整包搬進來，在 CI 全跑時執行。
6. **`patches/0001-cordis-185-disposal-order.patch`：上游 [#185](https://github.com/cordiverse/cordis/pull/185) 原樣**（腳本套用），修 fiber 啟用與卸載的四個順序缺陷，是 dsh 第 6 條在上游的對應，附它自己的四條測試。**它同時修好了 [#127](https://github.com/cordiverse/cordis/issues/127)**（非 ACTIVE 的 fiber 卸載後停不到 `DISPOSED`）：從沒啟用過與失敗過的 fiber 卸載時也跑 `_unload()`，經過 UNLOADING 收斂到 DISPOSED。驗證在 `cordis/nexus-tests/settle.spec.ts`（PENDING、LOADING、FAILED 三種起點）與探針 ③ 的負對照；拿掉這份修補，PENDING 停在 0、FAILED 停在 3。#185 合併後撤掉。

7. **`include/src/index.ts` 關掉寫回、拿掉 HMR 監看**（腳本，`closeWriteBack`）：樹只由 `patches` 驅動，Include 不寫任何檔。上游有三條路會寫檔，三條都關：(a) 樹側的變更（`commit`）不記進 journal、不排寫入；(b) 缺檔時上游把 `initial` 寫成檔，這裡缺檔就是 `config file not found`（那一列 FAILED），不建檔；(c) Loader 對插件自我停用（`loader/src/index.ts` 的 case 7）會 `tree.commit`，同 (a)，只改記憶體裡那一列的 `disabled`，不進檔。縱深：`_loop` 也不呼叫 `_write`。`hmr` 不 vendor（決議 §3-1 第 1 條），所以 `ctx.inject(['hmr'], …watch…)` 與型別宣告一起拿掉。每一處都要在上游原樣裡剛好命中一次，沒命中同步直接失敗。理由：變更紀錄是**唯一**的寫入口（`plugin-journal.ts`），清單上的列由它導出；Include 再寫回 `cordis.yml` 就是第二個寫入口，而 `cordis.yml` 是出貨檔（跟安裝樹同權限）。**偏離 dsh**：dsh 的 Include 寫回 `cordis.patch.yml`，那是它的持久化路徑；我們的持久化是變更紀錄，所以關掉。三條路各有測試（`include/nexus-tests/write-back.spec.ts`）。
8. **`include/src/index.ts` 允許名單 `only`**（腳本）：`Include.Config` 多一格 `only?: string[]`，疊完 patch 之後只留 `name` 在名單裡的頂層列。沒給就不濾，等同上游。理由：`cordis.yml` 裡多數列還是相容層的 `NexusPlugin`（沒有 `manifest` 匯出），上樹的只有函式插件；名單由宿主以「模組有 `manifest` 匯出」那同一支謂詞算出（`resolveEntryModule`，單一出處）。**先疊後濾**：patch 指到名單外的列照樣命中，不會多出「找不到」的警告。測試 `include/nexus-tests/write-back.spec.ts`。

### 對照 dsh `vendor/README.md` 的逐條判斷（#1416 PR 2）

dsh 對 include 的第 8、11、13、14、15 條，逐條是否跟、為什麼（上游 `c261dd2c`，dsh `d743267`）：

| dsh 條 | 內容 | 判斷 | 理由與證據 |
|---|---|---|---|
| 8 | 檔案刷新的韌性（#514）：頂層陣列驗過才快取、記錄刷新失敗、改檔或改 Include 設定後重疊 patch、`initial` 只在 `ENOENT` 後用 | **上游已有，其中 `initial` 那條我們關掉** | 上游 `include/src/index.ts` 的 `_read` 有頂層陣列驗證（`config file must be a top-level array`）、`internal/update` 重疊 patch、`isENOENT` 才走 `initial`。我們的第 7 條 (b) 把 `initial` 改成缺檔即錯：不建檔 |
| 11 | 匯出 `applyEntryPatches` 與 `entryListSchema` 供 `--dump-config` 共用；插入的列當場進索引 | **索引那半已在上游；匯出那半不照**（PM 已核可，Q-B） | 上游 `applyPatches` 已有 `buildMap(clone)`，插入的列當場可 patch。匯出那半：我們的 `--dump-config` 走自己的 `applyEntryPatches`（`plugin-config.ts`，無 `group`、訊息中文且有測試釘著），換成上游那支會改 `insert` 帶 `id` 的語意與每一句警告。**基礎建設表達得出來（上游 `patch.ts` 可直接 import），不照是範圍取捨**：這張卡不動 dump 路徑。補償：兩支的等價測試（disable／enable／config-set／config-reset／patch 五種操作），差異在快照的 `sync` 看得到；收斂成一支另開卡 |
| 13 | `writeTask` 型別放寬（`exactOptionalPropertyTypes`） | **不適用** | 上游這一版沒有 `writeTask`（寫入走 `_draining`），nexus 的 tsconfig 也沒開 `exactOptionalPropertyTypes` |
| 14 | 寫入的串行化與暫態 `EACCES`/`EBUSY`/`EPERM` 重試 | **上游已有，且寫入路徑已關** | 上游有 `RENAME_RETRIES`、`isTransientRenameError`、`_writeText`；第 7 條關了寫入，這些是不會執行的程式碼 |
| 15 | 惰性設定解析（`internal/config`）；Include 宣告 `EntryGroup.key` 讓自己的設定不被插值 | **前半已在上游；後半（Include 的 `EntryGroup.key`）不照** | 上游 core `fiber.ts` 與 loader `index.ts` 已有 `internal/config` 與 `interpolate`。Include 不是 `EntryGroup`，它的設定（`path`、`patches`、`only`）會過 `interpolate`：宿主給的是純資料，深複製反而是我們要的（Include 的 `ensureInsertIds` 會就地補 id，不能改到宿主的物件）。**但 `interpolate` 會 `eval` 任何帶 `__jsExpr` 鍵的物件**：宿主在推 patch 之前掃過，有就整份拒絕（`tree-sync.ts`，有測試） |

`cordis/nexus-tests/` 與 `include/nexus-tests/` 是我們自己的回歸測試，不是上游的，腳本不碰。

### 沒有移植的

- **[#133](https://github.com/cordiverse/cordis/pull/133)、[#140](https://github.com/cordiverse/cordis/pull/140)（上游為 #127 開的修補）**：兩份的程式改動是同一行，在 #185 之上是多餘的；它們的測試預期 PENDING／FAILED 直接跳到 DISPOSED，與 #185 經過 UNLOADING 的語意衝突。上游若先合了其中一份，下次同步時要重看 #185 是否還套得上。
- **dsh 第 10 條（被抹掉的 import 標成 `type`）**：那是給 Node 原生 TypeScript 轉譯用的，我們只用 tsx 與 vitest 跑原始碼，碰不到。

## 同步

1. 在上游 clone 記下 `git rev-parse HEAD`，對過 `git ls-remote https://github.com/cordiverse/cordis HEAD`。
2. 看 `patches/` 裡每一份對應的上游 PR 合了沒；合了就刪掉那一份，登記表照改。
3. `node vendor/sync.mjs <上游 clone>` 重建 `cordis/{src,tests}`、`loader/src` 與 `include/src`；修補套不上時腳本直接失敗。`LICENSE` 有變就手動換。
4. 更新清單的 commit 與版本，跑 `pnpm install`（重建宣告檔）、`pnpm --filter ./vendor/cordis run test`、`pnpm --filter ./vendor/include run test` 與 `pnpm --filter @nexus/harness exec vitest run src/measure/cordis-1386`。

`node vendor/sync.mjs <上游 clone> --check` 只比對不寫入：從上游加上登記的修改重建一份，與 vendor 逐檔比，有差異就列出並以 1 退出。登記表外的手改會在這裡現形。
