# 插件規範

樹上的插件怎麼寫、怎麼被驗、怎麼被換。**這是最小切片**（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416)，
屬於 [#1385](https://github.com/DemianLi/nexus-agent/issues/1385)）：manifest、帶型別的 token、semver 契約檢查、
一致性套件。lint、capabilities 的執行、版本路由與兩版並存不在這一刀，見文末。

決議出處是 [`.docs/decisions-2026-10-11.md`](../.docs/decisions-2026-10-11.md) §3-4。程式碼在
[`packages/nexus-sdk`](../packages/nexus-sdk)（`@nexus/sdk`）與
[`packages/nexus-tools`](../packages/nexus-tools)（`@nexus/tools`，第一個服務定義套件）。

## 這份規範管誰

**只管 Cordis 樹上的函式插件。** 今天樹上有相容層與入口兩列、`tools`（工具登記處）、`include`（讀出貨清單的那一列），
加上逐顆遷出的插件，**今天只有 `echo`**（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416) PR 2）；還留在
相容層裡的 20 顆是 `NexusPlugin` 物件，照舊 `export default`（`cordis.yml` 的 `name` 要靠它指到那顆物件），不受下面
「不能有 default」的約束。遷出一顆，它就從物件形式換成這裡的函式插件形式。載入器怎麼分辨兩種形式，見下面
「接進清單」。

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
  **那是推論；`echo` 是第一個驗它的**（#1416 PR 2）：echo 的宿主分類是 `next-thread`，它宣告 `config: 'next-thread'`，
`apps/harness/src/echo-on-tree-edges.test.ts` 的 H 格釘住兩邊不矛盾（宿主若有一天把 echo 挪進 `startup-read`，那份宣告就是
謊話，這一條會紅），驗收 E／F 量到的行為也一樣——改前綴之後下一條 thread 是新值、開著的是舊值。`effectiveReload` 還沒有
消費者（後台插件頁還沒做），所以「取較嚴」今天只在測試裡算。

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
- 這個慣例 dsh 也只是慣例，沒有 gate 強制；這裡同樣不加 gate。`@nexus/tools` 有一條測試守它的相依只有 SDK 與工具型別。依賴的放法照 dsh：宿主給的 `@nexus/sdk`、`@nexus/cordis`、服務定義套件（`@nexus/tools`）放 `peerDependencies`，`devDependencies` 留 `workspace:*` 供開發與測試——`ContractError` 的 `instanceof` 與 Cordis 的 `Context` 類別都要求宿主與插件看到同一份，放進 `dependencies` 在套件獨立安裝時就可能各裝一份。`@nexus/plugin-echo` 與 `@nexus/tools` 各有測試釘著。

## 契約版本走 semver

提供者繼承 `ContractService`（建構時給 token，服務名與契約版本都取自 token）；消費者在 `inject` 宣告範圍。範圍不含提供者的
契約版本時，**消費者不起來**（停在 PENDING），錯誤指名消費者那一列、提供者那一列、服務、兩邊的版本與範圍。

做法是 Cordis 本來就有的 `provide` 的 `check`（探針 [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) ⑤）：

- **提供者必須是 `Service`。** `[Service.check]` 由**消費者的** fiber 呼叫，`this` 是追蹤到消費者的代理，所以讀得到消費者
  宣告的範圍與列 id。plain object 提供者的 `check` 讀不到這些，**不相容也會放行**——所以契約服務一律繼承
  `ContractService`，不要自己 `ctx.provide` 一個物件。
- **錯誤進的是提供者的 logger**，不是消費者的。要把它對回消費者那一列（啟動結算、後台插件頁），靠 `ContractError` 上的
  結構化欄位 `consumer`／`provider`／`service`／`provided`／`range`，不要解析訊息。
- **範圍的權威是插件自己的 `inject`**（實測，`packages/nexus-sdk/src/contract.test.ts`，vendor `c261dd2c`）：Loader 列的
  `intercept` 只在插件**沒有**宣告範圍時才算，蓋不掉插件自己宣告的（往嚴往鬆都蓋不掉）；列的 `inject` 寫範圍對檢查沒有作用。
  所以宿主對一顆插件的範圍沒有否決權，只能在插件沒講的時候補一句。`manifest.consumes` 不是第三個地方：它跟 `inject`
  是同一份宣告的兩個面，一致性套件的 `export-form` 一格比對兩邊。

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
  才開新 thread」的路徑都要等到收斂，不能靠碰運氣的等待時間。**經紀錄與 Loader 重掛的那條路怎麼等**（#1416 PR 2 實測，
  `vendor/include/nexus-tests/convergence.spec.ts`）：`await entry.update({ config: { ...includeConfig, patches } })` 回來時
  Include 底下的樹已經收斂——停用的那一列已卸載、登記處已撤；啟用的已重掛；改設定的舊值已撤、新值已進；設定沒變的什麼都沒
  動。**不用輪詢，也不靠等待時間**；取工具快照在這之後。「讀清單、推給樹、等收斂、取快照」是一段臨界區
  （`plugin-tree.ts` 的 `PluginTree.run`），兩條 thread 同時組裝時各拿一份跟自己讀到的清單相符的工具。
- 兩版並存與逾時留給版本路由那張卡。

## 能比版本路由早上樹的插件

**樹上那一列是行程級的，一改（停用、改設定）Loader 就重載那一列；組 thread 時拿的是快照**（決議 §3-2 第 6 條「插件更新
只給新對話」）：開著的對話不變，下一條才看到新的。

所以**只有能做快照的插件，才能比版本路由早上樹**：快照拿走的是「註冊進登記處的東西」（工具、命令⋯），它們在
列卸載後仍然可以呼叫。**有狀態的插件不行**，它們得等版本路由的引用計數排水，舊版的最後一段對話結束才撤。

## 逐條 thread 的東西在呼叫當下拿，狀態以日誌為準（#1418）

插件在一次組裝裡**只套一次**，可是這個行程可能同時服務好幾條 thread（serve 一條連線一條 thread）。所以 `apply`
閉包裡抓到的東西，凡是「每條 thread 各一份」的，在第二條 thread 進來的那一刻就是錯的——而且錯得靜默：
工具寫進別條 thread 的日誌，或問到別條 thread 的人。

規則只有兩條，對應 dsh 的 `exec.agent`（身分隨呼叫明確傳進來，不靠 `apply` 當下）：

| 規則 | 怎麼做 | 為什麼 |
| --- | --- | --- |
| **逐條 thread 的東西，呼叫當下才拿** | 要會話日誌用 `registry.sessions.forCall(config)`，要答題管道用 `registry.services.get(CHANNEL_FOR_THREAD_SERVICE)?.(callThreadId(config))`（沒提供就退回 `channel`）。工具 handler 與 middleware 都從呼叫設定的 `configurable.thread_id` 拿身分，`PipelineExecution.thread` 是同一個值 | `apply` 只跑一次；`thread_id` 在 root、同步子代理、背景子代理三種位置都到得了 handler 與 middleware（`apps/harness/src/thread-id-reaches-handlers.test.ts` 實測） |
| **狀態以日誌為準，閉包裡的暫存表鍵要帶 thread** | 暫存表（例如 present 的「已呼叫、尚未落定」）的鍵是 `thread \0 位址 \0 callId`，不是 `callId` | 模型給的 `tool_call.id` 是各 thread 各自編號的，兩條 thread 同時懸著同一個 `callId` 是會發生的 |

**身分三種位置**：root 與同步子代理的 `thread_id` 是 root 那一條（子代理身分靠 `checkpoint_ns`）；背景子代理的
`thread_id` 是它自己的日誌 id（`<root>/<runId>`）並帶 `nexus_background_session`。`forCall` 就是用這個挑會話註冊表：
綁著一張時不看 `thread_id`（跟以前一樣），綁著多張時依 `thread_id` 挑**恰好認得它的那一張**，挑不出仍回 `ambiguous`。

**這條規則怎麼被守住**：`@nexus/sdk` 的 `checkSharedAcrossThreads` 是一格通用的一致性檢查——同一份序列各條
thread 各自掛一份跑一遍當基準，再掛**一份**服務所有 thread 跑一遍，兩邊結果對不上就紅並指名是第幾步、哪條 thread、
各回了什麼。它不 import `@nexus/core`：每顆插件在自己的套件裡寫一個轉接器（ask-user 與 present 各一份，`shared-across-threads.test.ts`）。
這一格**不要求插件上樹**——ask-user 與 present 仍是相容層的 `NexusPlugin`，不匯出 `manifest`
（`apps/harness/src/pilot-plugins-stay-compat.test.ts` 釘住）。

**出貨路徑不變**：組裝點只提供 `channel`，不提供 `channelForThread`，所以產品路徑上答題管道的取法與以前一樣；
只有同一次組裝真的服務多條 thread 的呼叫端才需要提供 `channelForThread`。

## 偏離 dsh

| 偏離 dsh 的什麼 | 理由類別 | 說明 |
| --- | --- | --- |
| manifest 必填欄位 | 產品需求超出 dsh | dsh 的身分只有 `package.json` 的 name／version 加 Loader 列 id，`dsh` 欄位沒有 id、owner、provides、consumes、capabilities、reload（`packages/util/package-manifest/src/types.ts:8-39`）。決議 §3-4 第 10 條 |
| `Config` 用 zod `strictObject` | 沿用既有偏離 | dsh 用 schemastery 而且非 strict（`vendor/schemastery/src/index.ts:812-822`）。代價：沒有 `.volatile()`，Loader 的 `equalExceptVolatile` 不適用，設定一改那一列就重載 |
| 帶型別的 token | 已登記（決議 §五，第 14 條） | 取代 declaration merging 加 `scripts/gen-cordis-catalog.ts` |
| 服務契約用 `check` 做 semver | 產品需求超出 dsh | dsh 一處都沒用（`Service.check` 在 `packages`、`apps` 為 0）；它的版本相容檢查在套件層，比整個 runtime 的版本（`packages/boot/app-boot/src/plugin-compatibility.ts:61-88`） |
| 共用的一致性套件 | 產品需求超出 dsh | dsh 的卸載測試是每個套件各寫一份；插件層級沒有共用套件，只有後端層級的 contract suite（`packages/storage/storage/tests/contract.ts`）。決議 §3-4 第 12 條 |

## 接進清單（#1416 PR 2）

`echo` 是第一顆遷上樹的插件。清單（`cordis.yml`、home 的變更紀錄、`--patch`）仍由相容層的 `loadPluginConfig` 讀、疊、驗，
**樹那一側不是第二份清單，是清單的一個消費者**：

| 東西 | 在哪 | 做什麼 |
| --- | --- | --- |
| 載入器的分辨 | `plugin-config.ts` 的 `resolveEntryModule` | 模組有 `manifest` 具名匯出就是函式插件，走 `validateManifest`；沒有就照舊是 `NexusPlugin`。判別式只有一個（`plugin-tree.ts` 的 `isFunctionPluginModule`），Include 的允許名單也從它算 |
| 橋接列 | `plugin-config.ts` 的 `isBridgeEntry` | 函式插件在相容層清單上的代表：同一個 id、同一個位置、`Config` 是 manifest 的 `config`，所以設定驗證、停用、補號、快照、會話 header 都照舊。它的 `apply` 不自己掛任何東西，只把**登記者是這一列**的工具折進這一條 thread 的 registry |
| 樹 | `plugin-tree.ts` 的 `PluginTree` | `tools` 一列（工具登記處）、`include` 一列（Include 讀出貨的 `cordis.yml`、疊 patch），函式插件在 `include:<id>` |

- **變更紀錄怎麼到樹上**：折出來的 patch 原樣經 `entry.update({ config: { ...includeConfig, patches } })` 推給 Include（dsh
  `app-boot` 的做法）。**Include 不寫回任何檔**——寫入口只有變更紀錄一個（`vendor/README.md` 第 7 條，上游三條寫回路徑全關）；Loader 上游會在安裝樹建 `.cordis/` 輔助檔，宿主給了解析函式就不建（第 9 條），所以安裝樹唯讀也不影響掛載。
- **兩支疊 patch 的演算法**：相容層的 `applyEntryPatches` 與上游的 `applyPatches` 對下面五種操作疊出一樣的 id／name／
  disabled／config 與順序（停用、啟用、改設定、還原設定、`--patch` 改與插入；`echo-on-tree-edges.test.ts`）。已知的差別是
  帶 `id` 的 `insert`（相容層接到尾巴，上游往群組裡塞），推給樹的 patch 把那個 `id` 拿掉，兩邊就一致。每次同步還會比一次
  樹上那一列的 `disabled` 與 `config` 跟相容層疊出來的是否相同，不同那一列算掉了，不靜靜地各走各的。
- **樹上的結果怎麼對回清單上的掉列**：樹上那一列 FAILED 或缺席是 `apply` 階段、PENDING（缺服務、契約不相容）是 `requires`
  階段，在**讀清單那一步**就判定（以前 echo 重名要到組裝那一刻才掉）。契約不相容的訊息帶消費者列 id（樹上的 `include:<id>`）。
- **設定帶 `__jsExpr` 整份拒絕**：Loader 的 `interpolate` 會把它當 JavaScript `eval`。相容層讀清單時掃走橋接那幾列的最終
  `config`（寫入前驗證走同一條，所以寫入口當場擋下，不會把一條讓之後每次啟動都失敗的東西寫進紀錄），推上樹之前再掃一遍
  整份 patch 當後盾。
- **沒有樹的呼叫端**（手搭 `PluginEntry` 清單的測試、基準任務、`shippedPlugins()`）：橋接列在組裝時單獨掛一次、取工具、
  立刻卸載，走的是同一個 Loader 與 `tools` 提供者。產品路徑（`cli.ts`、`serve.ts`）不走這條。

### 已知限制

- **插件自我停用只在記憶體**（PM 決議）：插件自己 `ctx.fiber.dispose()`，Loader 的 case 7 把那一列在樹上標成 `disabled`，
  Include 不寫檔、也不進變更紀錄。清單是「想要的狀態」，所以下一條 thread 同步時會把它重新掛上、它再停用一次——
  **每條 thread 閃動一次**。要不要把自我停用也寫進變更紀錄，等 demian 決定（`echo-on-tree-edges.test.ts` 的閃動那一條釘住
  今天的行為）。
- **`cordis.serve.yml` 那一層不經 Include**：Include 只有一個 `path`，serve 專屬層是相容層疊在出貨層後面的另一個檔。那一層裡的
  函式插件上不了樹，會在讀清單時掉在 `apply` 階段並指名原因；今天那一層沒有函式插件。要放進去，得讓 Include 讀多個檔或
  把那一層併進出貨檔。
- **橋接列是過渡的**：卡上寫「拿掉」，留著是因為清單上其餘 20 列還是 `NexusPlugin`，要跟 echo 排在同一份清單、同一個順序裡
  （PM 決議 Q-A）。最後一顆搬出相容層時橋接連同整個相容層一起拿掉。這是對卡上字面的偏離，登記在這裡與 PR 內文。

## 這一刀沒有的

- **lint**（禁 `internal/*`、`ctx.root`、`ctx.registry`）：dsh 沒有這條 lint，而且自己的生產碼大量在用，屬於 nexus 自加，
  另開一張。
- **capabilities 的執行**：「不宣告就不給」另開一張。
- **版本路由、兩版並存、逾時**。
