# 插件規範

樹上的插件怎麼寫、怎麼被驗、怎麼被換。**這是最小切片**（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416)，
屬於 [#1385](https://github.com/DemianLi/nexus-agent/issues/1385)）：manifest、帶型別的 token、semver 契約檢查、
一致性套件。lint、capabilities 的執行、版本路由與兩版並存不在這一刀，見文末。

決議出處是 [`.docs/decisions-2026-10-11.md`](../.docs/decisions-2026-10-11.md) §3-4。程式碼在
[`packages/nexus-sdk`](../packages/nexus-sdk)（`@nexus/sdk`）與
[`packages/nexus-tools`](../packages/nexus-tools)（`@nexus/tools`，第一個服務定義套件）。

## 這份規範管誰

**只管 Cordis 樹上的函式插件。** 今天樹上只有相容層與入口兩列加上逐顆遷出的插件；還留在相容層裡的 20 顆是
`NexusPlugin` 物件，照舊 `export default`（`cordis.yml` 的 `name` 要靠它指到那顆物件），不受下面「不能有 default」
的約束。遷出一顆，它就從物件形式換成這裡的函式插件形式。

## 插件的形狀

具名匯出 `name`、`inject`、`Config`、`apply`，外加 `manifest`；**不能有 `default`**：

```ts
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { toolsToken } from '@nexus/tools';
import type { Context } from '@nexus/cordis';
import { z } from 'zod';

export const name = 'echo';
export const Config = z.strictObject({ prefix: z.string().default('回聲') });
export const inject = injectOf(need(toolsToken, '^1.0.0'));
export const manifest = defineManifest({ /* 見下表 */ });

export function apply(ctx: Context, config: z.infer<typeof Config>) {
  service(ctx, toolsToken).register(/* … */);
}
```

- **為什麼不能有 default**：Loader 的 `unwrapExports` 有 `default` 就取 `default`（`vendor/loader/src/index.ts`），
  具名的 `inject` 與 `Config` 會被靜靜丟掉，插件掛上去卻沒有依賴宣告。一致性套件的 `export-form` 一格專抓這個。
- **`Config` 必須就是 `manifest.config`**：設定的 schema 只能有一個出處。
- **`inject` 與 `manifest.consumes` 是同一份宣告的兩個面**：必要的依賴兩邊都要有、範圍要一樣；選配的依賴**不**放進
  `inject`，用 `optionalService(ctx, token)` 讀（dsh `packages/AGENTS.md:6`）。
- **所有副作用走 `ctx.effect`／`ctx.on`**（決議第 11 條）。註冊就是 effect：提供者的 `register()` 內部包
  `ctx.effect`，註冊者那一列卸載時登記處自己撤掉，不靠呼叫者記得呼叫回傳的 disposer。
- **列沒寫 `config` 時 Loader 交 `undefined`**，`strictObject` 收不下它。建列的宿主要補 `{}`。

## manifest

載入期驗證是 `validateManifest(raw, rowId)`：**缺任何一個必填欄位就拒收**，錯誤指名列 id、（讀得到時的）插件 id 與缺的
欄位；欄位在場但不合格、有不認得的欄位也拒收，不靜默放過。

| 欄位 | 內容 |
| --- | --- |
| `id` | 插件身分，跨版本不變 |
| `version` | 這一版的 semver |
| `owner` | 負責的團隊；後台插件頁要指得出找誰 |
| `provides` | `[{ token, version }]`，提供出去的服務與契約版本；可以是空陣列 |
| `consumes` | `[{ token, range, optional? }]`，依賴的服務、semver 範圍、必要或選配；可以是空陣列 |
| `config` | zod `strictObject`；未知鍵讓載入失敗是登記過的偏離 |
| `reload` | `{ code, config }`，見下 |
| `capabilities` | 子行程、網路、檔案系統等特權；這一刀只驗它在場，「不宣告就不給」另開一張 |

**「必填」的意思是鍵要在。** `provides: []` 合法：`echo` 不提供任何服務也不要任何特權。

### `reload` 拆兩軸

一條「即時／需重啟」說不清「改程式碼」與「改設定」是兩回事（[#1136](https://github.com/DemianLi/nexus-agent/issues/1136)）：

| 軸 | 值 | 意思 |
| --- | --- | --- |
| `code` | `coexist` | 新舊兩版並存，舊版留給開著的對話，新對話走新版 |
| `code` | `restart` | 換程式碼要重啟行程 |
| `config` | `next-thread` | 設定一改，下一條 thread 看到新值，開著的不動 |
| `config` | `restart` | 設定一改要重啟行程 |

- **`code: 'coexist'` 今天被拒收**，訊息指名那一列與原因。兩版並存的案例要等版本路由那張卡落地才驗得到，先收下就是
  一個沒驗過的宣告（demian 2026-10-13 拍板）。案例補上之後再放行。
- **插件只宣告自己知道的那一半。** 宿主那一半（這一列被宿主 import、自建、起動期讀）由宿主機械算出，今天是
  `apps/harness/src/plugin-row-classes.ts`。`effectiveReload(manifest.reload, hostReload)` 每一軸取較嚴的，不是只
  看 manifest：宿主起動期就把設定讀掉了，插件再怎麼宣告 `next-thread` 也不會在下一條 thread 生效。
  預期的對映是 `startup-read` 與 `mount-restart` → `config: 'restart'`、`next-thread` → `config: 'next-thread'`，
  **但那是還沒接線也沒驗過的推論**：這一刀的載入期驗證只是函式庫，不接進 `plugin-config.ts`，PR 2 接 `echo` 時才驗。

## 帶型別的 token 與三角色

一個能力接縫由三個角色組成（決議第 16 條，dsh 的紀律）：

| 角色 | 是誰 | 依賴什麼 |
| --- | --- | --- |
| 定義 | 服務定義套件，例如 `@nexus/tools`：token、介面、契約版本 | 只有 `@nexus/sdk`（與介面用到的型別） |
| 提供者 | 樹上一列，繼承 `ContractService` | 定義套件、`@nexus/sdk` |
| 消費者 | 想用這個服務的插件 | **只有定義套件與 `@nexus/sdk`**，永不 import 提供者 |

- token 是一個值：`defineToken<ToolRegistry>('tools', '1.0.0')`。名字與型別綁在一起、由定義套件擁有，打錯名字或拿錯型別
  在 `tsc` 就停下（`token.test.ts` 的 `typePins`，用 `@ts-expect-error` 釘住）。字串鍵只留給框架內部。
- 取值：`service(ctx, token)` 讀已宣告的服務（沒宣告就讀，Cordis 拋錯）；`optionalService(ctx, token)` 讀選配的。
- **定義套件不放在 `@nexus/plugin-*` 底下**：R2 的 grep 與 `plugin-coexist-real.ts` 把那個前綴當插件看。
- 這個慣例 dsh 也只是慣例，沒有 gate 強制；這裡同樣不加 gate。`@nexus/tools` 有一條測試守它的相依只有 SDK 與工具型別。

## 契約版本走 semver

提供者繼承 `ContractService`（建構時給 token，服務名與契約版本都取自 token）；消費者在 `inject` 宣告範圍。範圍不含提供者的
契約版本時，**消費者不起來**（停在 PENDING），錯誤指名消費者那一列、提供者那一列、服務、兩邊的版本與範圍。

做法是 Cordis 本來就有的 `provide` 的 `check`（探針 [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) ⑤）：

- **提供者必須是 `Service`。** `[Service.check]` 由**消費者的** fiber 呼叫，`this` 是追蹤到消費者的代理，所以讀得到消費者
  宣告的範圍與列 id。plain object 提供者的 `check` 讀不到這些，**不相容也會放行**——所以契約服務一律繼承
  `ContractService`，不要自己 `ctx.provide` 一個物件。
- **錯誤進的是提供者的 logger**，不是消費者的。要把它對回消費者那一列（啟動結算、後台插件頁），靠 `ContractError` 上的
  結構化欄位 `consumer`／`provider`／`service`／`provided`／`range`，不要解析訊息。
- 範圍也可以寫在 Loader 列的 `intercept`；`manifest.consumes` 的範圍最後落在同一處。

## 一致性套件

`checkConformance(target)` 對一顆插件跑四格，回結構化結果（空陣列代表全過）。純函式，不相依 vitest，量的全部走真的
Loader 與 fiber。插件自己的測試只要：

```ts
expect(await checkConformance({ row, module, providers, residue })).toEqual([]);
```

| 格 | 量什麼 |
| --- | --- |
| `manifest` | manifest 在場、通過載入期驗證 |
| `export-form` | 沒有 default；`name`／`apply` 在場；`unwrapExports` 取回的就是這個命名空間；`Config` 就是 `manifest.config`；`inject` 與 `consumes` 一致 |
| `unload` | 掛上後活資源變多、**直接卸載那顆 fiber** 之後回到掛載前、fiber 收斂到 `DISPOSED` |
| `missing` | 缺提供者時停在 PENDING，等的服務名正好是 `consumes` 裡必要的那幾個 |

- **`residue` 要指到插件貢獻的地方**（登記處裡的工具數、監聽器數⋯）。掛上後沒有變多就是量不到卸載，同樣判不合格，
  不讓一顆「什麼都沒貢獻」的插件因為沒東西可留而過。
- **卸載是從 fiber 觀察的**，不呼叫 `register()` 回傳的 disposer：否則「沒包進 `ctx.effect`、只回一個會撤的
  disposer」這種缺陷照樣綠。這是 dsh「dispose the fiber and observe removal」的要求。
- **`loader.remove(id)` 發起卸載卻不等它**（`entry.fiber?.dispose()`），回來時 fiber 還在 `UNLOADING`；對同一顆 fiber
  再呼叫一次 `dispose()` 也只拿到單次結果而提早返回（`loader.remove` 之後的 `fiber.dispose()` 回來時仍是
  `UNLOADING`，隔一個計時器 tick 才是 `DISPOSED`，實測）。要等一列收斂得自己第一個呼叫 `fiber.dispose()`。任何「改了紀錄
  才開新 thread」的路徑都要等到收斂，不能靠碰運氣的等待時間；**經紀錄與 Loader 重掛的那條路怎麼等，在 #1416 PR 2
  接線時驗**，這一刀只量了直接卸載的這一條。
- 兩版並存與逾時留給版本路由那張卡。

## 能比版本路由早上樹的插件

**樹上那一列是行程級的，一改（停用、改設定）Loader 就重載那一列；組 thread 時拿的是快照**（決議 §3-2 第 6 條「插件更新
只給新對話」）：開著的對話不變，下一條才看到新的。

所以**只有能做快照的插件，才能比版本路由早上樹**：快照拿走的是「註冊進登記處的東西」（工具、命令⋯），它們在
列卸載後仍然可以呼叫。**有狀態的插件不行**，它們得等版本路由的引用計數排水，舊版的最後一段對話結束才撤。

## 偏離 dsh

| 偏離 dsh 的什麼 | 理由類別 | 說明 |
| --- | --- | --- |
| manifest 必填欄位 | 產品需求超出 dsh | dsh 的身分只有 `package.json` 的 name／version 加 Loader 列 id，`dsh` 欄位沒有 id、owner、provides、consumes、capabilities、reload（`packages/util/package-manifest/src/types.ts:8-39`）。決議 §3-4 第 10 條 |
| `Config` 用 zod `strictObject` | 沿用既有偏離 | dsh 用 schemastery 而且非 strict（`vendor/schemastery/src/index.ts:812-822`）。代價：沒有 `.volatile()`，Loader 的 `equalExceptVolatile` 不適用，設定一改那一列就重載 |
| 帶型別的 token | 已登記（決議 §五，第 14 條） | 取代 declaration merging 加 `scripts/gen-cordis-catalog.ts` |
| 服務契約用 `check` 做 semver | 產品需求超出 dsh | dsh 一處都沒用（`Service.check` 在 `packages`、`apps` 為 0）；它的版本相容檢查在套件層，比整個 runtime 的版本（`packages/boot/app-boot/src/plugin-compatibility.ts:61-88`） |
| 共用的一致性套件 | 產品需求超出 dsh | dsh 的卸載測試是每個套件各寫一份；插件層級沒有共用套件，只有後端層級的 contract suite（`packages/storage/storage/tests/contract.ts`）。決議 §3-4 第 12 條 |

## 這一刀沒有的

- **lint**（禁 `internal/*`、`ctx.root`、`ctx.registry`）：dsh 沒有這條 lint，而且自己的生產碼大量在用，屬於 nexus 自加，
  另開一張。
- **capabilities 的執行**：「不宣告就不給」另開一張。
- **版本路由、兩版並存、逾時**。
- **載入期驗證接進 `plugin-config.ts`**：這一刀只是函式庫，接進去會改到清單載入器的行為。
