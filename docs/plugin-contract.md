# 插件規範

樹上的插件怎麼寫、怎麼被驗、怎麼被換。**這是最小切片**（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416)，
屬於 [#1385](https://github.com/DemianLi/nexus-agent/issues/1385)）：manifest、帶型別的 token、semver 契約檢查、
一致性套件，以及強制它們的 lint 與 gate（[#1420](https://github.com/DemianLi/nexus-agent/issues/1420)）。
capabilities 的執行、版本路由與兩版並存不在這一刀，見文末。

決議出處是 [`.docs/decisions-2026-10-11.md`](../.docs/decisions-2026-10-11.md) §3-4。程式碼在
[`packages/nexus-sdk`](../packages/nexus-sdk)（`@nexus/sdk`）與
[`packages/nexus-tools`](../packages/nexus-tools)（`@nexus/tools`，第一個服務定義套件）與
[`packages/nexus-projections`](../packages/nexus-projections)（`@nexus/projections`，第二個，#1421）。

## 這份規範管誰

**只管 Cordis 樹上的函式插件。** 今天樹上有相容層與入口兩列、`tools`（工具登記處）、`projections`（投影登記處，#1421）、
`include`（讀出貨清單的那一列），加上逐顆遷出的插件，**今天是 `echo`**（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416) PR 2）
**與 `token-meter`**（[#1421](https://github.com/DemianLi/nexus-agent/issues/1421)）；還留在
相容層裡的 19 顆是 `NexusPlugin` 物件，照舊 `export default`（`cordis.yml` 的 `name` 要靠它指到那顆物件），不受下面
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
- **第二個接縫：投影登記處**（`@nexus/projections`，#1421）。形狀照 `@nexus/tools`：`ProjectionRegistry` 的 `register(unit)` 是
  effect（登記者那一列卸載時登記處自己撤掉）；提供者放同一個套件的另一個入口 `@nexus/projections/provider`，宿主在樹上
  掛一列 `projections`。**行程級的登記處只收定義**；把事件折進單元、送 `projection` frame 的推動照舊留在 `@nexus/core` 每條
  thread 的登記處（見偏離表）。消費者宣告 `inject = injectOf(need(projectionsToken, '^1.0.0'))`、
  `manifest.consumes = [{ token: 'projections', range: '^1.0.0' }]`，在 `apply` 裡 `service(ctx, projectionsToken).register(unit)`。
  `ProjectionUnit`、`SessionEvent`、`isLogicalTurnStart` 由這個定義套件**單向轉出** `@nexus/core` 的那三樣，插件只 import
  定義套件，不 import `@nexus/core`（lint 擋它）。
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

## lint 與 gate（#1420）

決議 §3-4 第 12 條的四層強制（SDK 型別、lint、載入期驗證、一致性套件）裡，後兩層之一是「每顆插件的 CI 都跑一致性
套件」，另一層是 lint。這一節是它們怎麼落地、管到誰、漏什麼。

### 誰受管

**遷出的插件**：模組有 `manifest` 具名匯出，判別就是 `apps/harness/src/plugin-tree.ts` 的 `isFunctionPluginModule`。
Include 的 allow-list、`tool-catalog` 與 gate 用的是**同一支**（`migrated-plugin-gate.test.ts` 的 E 那組釘住：定義只有
一份、三處都 import 並呼叫、harness 沒有第二份手寫的「有沒有 manifest」）。沒有 `manifest` 匯出的舊插件，這一節
一概不管；它們遷出時才受管。

### lint：`@nexus/sdk/lint`

SDK 匯出一份 ESLint flat config，**只用 ESLint 內建的 `no-restricted-*`**（純語法，SDK 不多任何相依），範圍是插件的
`src/`、**不含測試檔**（測試可以用假計時器、直接操作 fiber）。它**不帶 parser**：`typescript-eslint` 由消費者自己的
base 設定提供，套用時排在後面：

```js
import { pluginLintConfig } from '@nexus/sdk/lint';

import base from '../../eslint.config.js';

export default [...base, ...pluginLintConfig];
```

這個檔會被 `eslint.config.js` 用 Node 原生載入（它是 `.ts`），要求 Node 的 type stripping 開著（本 repo 的 `engines`
是 `>=22.19.0`，22.18 起預設開）。

**目前只有 monorepo 內的插件拿得到。** Node 不對 `node_modules` 底下的檔做 type stripping：`pnpm pack` 出來的 tarball
裝進空目錄，`import('@nexus/sdk/lint')` 在 Node 22.19.0 與 25 都丟 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`
（`import('@nexus/sdk')` 同樣，因為整包 SDK 今天出貨的是 TS 原始碼）。決議說外部插件在自己的 CI 也要拿得到這份設定，
所以 **SDK 對外發佈前要先建置成 JS**，這是那一刀的事，不在這張。

| 規則 | 擋什麼 | 改用什麼 |
| --- | --- | --- |
| `ctx-root` | `ctx.root`（含 `ctx['root']`、`this.ctx.root`、`const { root } = ctx`） | `inject` 宣告服務，`apply` 裡 `ctx.get(token)` |
| `ctx-registry` | `ctx.registry`（同上各種寫法） | 服務的 `register()`（內部包 `ctx.effect`）、`inject` 後 `ctx.get(token)` |
| `internal-name` | 以 `internal/` 開頭的字串或樣板字串（服務名、事件名） | 公開的事件用 `ctx.on`，登記東西用 `ctx.effect` |
| `process-on` ／ `process-once` ／ `process-addListener` ／ `process-prependListener` | `process.on`／`once`／`addListener`／`prependListener`，以及從 `node:process` 具名 import 它們 | 今天宿主沒有行程事件的服務；必須用時，`ctx.effect` 裡掛、回傳撤除函式（`process.off`），那一行寫窄例外 |
| `setInterval`（含 `globalThis.`／`global.` 與從 `node:timers` 具名 import） | 全域 `setInterval` | 今天沒有不經全域的計時器服務（vendor 的 Cordis 沒有）；必須用時，`ctx.effect` 裡呼叫、回傳清除函式（`clearInterval`），那一行寫窄例外 |
| `top-level-let-var` | 模組頂層的 `let`／`var`（含 `export let`） | 狀態放進 `apply` 的閉包，生命週期交給 `ctx.effect` |
| `top-level-collection` | 模組頂層的 `new Map`／`Set`／`WeakMap`／`WeakSet`（含 `export const`、`as`／`satisfies` 包著的） | 放進 `apply` 的閉包 |
| `import-nexus-core`（含 `import type`、`export … from`、動態 `import()`） | import `@nexus/core` 與它的子路徑 | `@nexus/sdk` 與服務定義套件（例如 `@nexus/tools`） |

**沒收的**（Q2 (a)，決議點名的才收）：`crypto.randomUUID`（dsh 禁它是因為瀏覽器的 secure context，插件跑在 Node 端，
理由不成立）與 `setTimeout`（要先確認 vendor 的 Cordis 有沒有對應的計時器服務，由第一顆真的需要計時器的遷移卡提出）。
選配服務與 capabilities 留給 capabilities 那張卡。

**例外一律窄**：`// eslint-disable-next-line <規則> -- <理由>`，不整檔關、不整條關。PR 內文逐條列出。`setInterval` 與行程
監聽器今天就只有這一條路（`lint.test.ts` 的 B 組實跑這個寫法：`ctx.effect` 裡呼叫、回傳清除函式、那一行寫例外，lint 0
則訊息）：

```ts
ctx.effect(() => {
  // eslint-disable-next-line no-restricted-globals -- 輪詢外部狀態，沒有不經全域的計時器服務
  const timer = setInterval(poll, 1000);
  return () => clearInterval(timer);
}, 'poll');
```

後面又寫一份
`no-restricted-syntax` 等於把整份蓋掉（flat config 的規則不合併），gate 量的是解析後的設定，會紅。

**已知的洞**（Q3 (a) 的代價）：純語法認不出別名。

- `const c = ctx; c.root`、把參數取別的名字、從別的名字解構，抓不到；它只認叫 `ctx` 的識別字。
- 頂層的 `const state = { count: 0 }`（物件本身可變）不在清單裡。
- 頂層的**常數查表**也會中 `top-level-collection`（`const KNOWN = new Set([...])`）：語法分不出它是不是只讀。**不為它
  放寬**（PM 決定）：遷移卡碰到時二選一，把它搬進 `apply` 的閉包，或寫一行窄例外並寫理由。
- 這些由審查與一致性套件的 `unload` 那一格補：副作用沒走 `ctx.effect`，卸載後就有殘留，`unload` 會紅。真的有人繞過，
  再升級成帶型別的規則。

### gate：`apps/harness/src/migrated-plugin-gate.ts`

形狀照 dsh 的 verify gate（`AGENTS.md:171`），nexus 的前例是 `package-invariants.ts`：純函式，由
`migrated-plugin-gate.test.ts` 在 `pnpm -r run test` 裡跑，CI 不必多一個 step。它依檔案路徑 import 每個
`packages/nexus-plugin-*` 的入口（新插件不一定在 harness 的相依裡；載不進來是違規，不跳過），對遷出的每一顆查：

1. **lint 設定生效**：量解析後的設定，不 grep 字串。對 `<pkg>/src/index.ts` 問 ESLint 最後的規則，逐條比對
   `@nexus/sdk/lint` 的值。`files` 寫錯、後面蓋掉，都抓得到。
2. **有一條測試呼叫從 `@nexus/sdk` import 的 `checkConformance`**（TS AST；註解、字串、沒呼叫的 import 都不算）。它
   **不看結果有沒有被斷言**，跟 `package-invariants` 一樣只量機械判得出來的東西。
3. **`scripts.lint` 與 `scripts.test` 在場**：少了它們，`pnpm -r run` 會靜靜跳過這個套件，上面兩項在 CI 上就沒跑。

「一支中央測試自動對每顆跑 `checkConformance`」做不到，因為 `row`、`providers`、`residue` 是每顆插件各自的東西，所以
gate 檢查的是「這條測試存在」。

**CI 上哪裡跑**：lint 在 static job 的 `pnpm -r run lint`；gate 在 harness 的測試。只動某顆插件的 PR 走選擇性測試，
harness 只跑 import 圖上的測試，而 gate 是動態載入、不在圖上，所以 `plan_ci.py` 的 harness 必跑集合用
`collectMigratedPluginViolations` 這個字面（gate 測試本來就會呼叫它）把它釘進去。只動 `packages/nexus-sdk` 的 PR 一律
全跑（`FULL_RES`）。

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
| **逐條 thread 的東西，呼叫當下才拿** | 要會話日誌用 `registry.sessions.forCall(config)`，要答題管道用 `registry.services.get(CHANNEL_FOR_THREAD_SERVICE)?.(callThreadId(config))`；**這支函式沒提供、或提供了但對這條 thread 回 `undefined`，都退回 `channel`**。工具 handler 與 middleware 都從呼叫設定的 `configurable.thread_id` 拿身分，`PipelineExecution.thread` 是同一個值 | `apply` 只跑一次；`thread_id` 在 root、同步子代理、背景子代理三種位置都到得了 handler 與 middleware（`apps/harness/src/thread-id-reaches-handlers.test.ts` 實測） |
| **狀態以日誌為準，閉包裡的暫存表鍵要帶 thread** | 暫存表（例如 present 的「已呼叫、尚未落定」）的鍵是 `thread \0 位址 \0 callId`，不是 `callId` | 模型給的 `tool_call.id` 是各 thread 各自編號的，兩條 thread 同時懸著同一個 `callId` 是會發生的 |

**身分三種位置**：root 與同步子代理的 `thread_id` 是 root 那一條（子代理身分靠 `checkpoint_ns`）；背景子代理的
`thread_id` 是它自己的日誌 id（`<root>/<runId>`）並帶 `nexus_background_session`。`forCall` 就是用這個挑會話註冊表：
綁著一張時不看 `thread_id`（跟以前一樣），綁著多張時依 `thread_id` 挑**恰好認得它的那一張**，挑不出仍回 `ambiguous`。

**這條規則怎麼被守住**：`@nexus/sdk` 的 `checkSharedAcrossThreads` 是一格通用的一致性檢查——同一份序列各條
thread 各自掛一份跑一遍當基準，再掛**一份**服務所有 thread 跑一遍，兩邊結果對不上就紅並指名是第幾步、哪條 thread、
各回了什麼。它不 import `@nexus/core`：每顆插件在自己的套件裡寫一個轉接器（ask-user 與 present 各一份，`shared-across-threads.test.ts`）。
這一格**不要求插件上樹**——ask-user 與 present 仍是相容層的 `NexusPlugin`，不匯出 `manifest`
（`apps/harness/src/pilot-plugins-stay-compat.test.ts` 釘住）。

**出貨路徑不變**：組裝點只提供 `channel`，不提供 `channelForThread`，所以產品路徑上答題管道的取法與以前一樣
（一條 thread 一份組裝，現在提供它只會是一支恆等函式）。assembly-root 提供 `channelForThread` 由 ask-user 自己的
遷移卡接手。

**宿主的義務：同一份組裝服務多條 thread 時，`channel` 是每一條都會拿到的預設。** `channel` 只能放每條 thread 都適用的值；
逐條不同的答題者一律走 `channelForThread`，並且不提供 `channel`（或只放每條都適用的那個）。理由是對應 dsh 沒有標籤的
監聽者：它的答題者用 `scopeTarget(agent, agent)` 分發，對沒有標籤的監聽者一律放行，只有帶標籤的才看是不是這個
agent 或它的上層（`packages/core/scope/src/index.ts:170-185`），所以行程級的答題者服務每一個 agent。我們的
`channel` 就是那個沒有標籤的監聽者，`channelForThread` 回 `undefined` 往下退回它是同一個語意。

**一個前提**：背景子代理的日誌在送出時就已經開好（`background-subagents.ts` 的 `start()`，`sessions.open` 在 `submit`
拉起背景圖之前），`forCall` 靠日誌 id 認出它屬於哪一張。日後改成延後才開的話，多張綁定下背景那一輪的第一筆會回 `ambiguous`。

## 偏離 dsh

| 偏離 dsh 的什麼 | 理由類別 | 說明 |
| --- | --- | --- |
| manifest 必填欄位 | 產品需求超出 dsh | dsh 的身分只有 `package.json` 的 name／version 加 Loader 列 id，`dsh` 欄位沒有 id、owner、provides、consumes、capabilities、reload（`packages/util/package-manifest/src/types.ts:8-39`）。決議 §3-4 第 10 條 |
| `Config` 用 zod `strictObject` | 沿用既有偏離 | dsh 用 schemastery 而且非 strict（`vendor/schemastery/src/index.ts:812-822`）。代價：沒有 `.volatile()`，Loader 的 `equalExceptVolatile` 不適用，設定一改那一列就重載 |
| 帶型別的 token | 已登記（決議 §五，第 14 條） | 取代 declaration merging 加 `scripts/gen-cordis-catalog.ts` |
| 服務契約用 `check` 做 semver | 產品需求超出 dsh | dsh 一處都沒用（`Service.check` 在 `packages`、`apps` 為 0）；它的版本相容檢查在套件層，比整個 runtime 的版本（`packages/boot/app-boot/src/plugin-compatibility.ts:61-88`） |
| 共用的一致性套件 | 產品需求超出 dsh | dsh 的卸載測試是每個套件各寫一份；插件層級沒有共用套件，只有後端層級的 contract suite（`packages/storage/storage/tests/contract.ts`）。決議 §3-4 第 12 條。**並由 gate 保證每顆遷出的插件都有一條呼叫它的測試**（dsh 沒有這道 gate，靠每個檔 100% 覆蓋率間接保證，`docs/testing.md:9`） |
| 插件邊界的 lint | 產品需求超出 dsh | dsh 沒有這條 lint：`.oxlintrc.json` 唯一的 `no-restricted-properties` 禁的是 `crypto.randomUUID`，而它自己的生產碼大量在用 `ctx.root`（`packages` 非測試碼 11 處）與 `internal/*`。決議 §3-4 第 12 條、grilling Q18 (c)（#1420） |
| 投影登記處的定義套件相依 `@nexus/core`（#1421 Q2 (a)） | 表達不出來，退到最接近的實作 | dsh 的 `dsh-session-projection` 相依 `dsh-session`，`SessionEvent` 在 `dsh-session`。我們的 `SessionEvent` 與 `isLogicalTurnStart` 在 `@nexus/core` 的 `session-log.ts`，抽一個 `@nexus/session` 定義套件是橫跨整個核心的一刀（Q2 (b)），這一張不做。所以 `ProjectionUnit`、`SessionEvent`、`isLogicalTurnStart` 留在 core、由定義套件單向轉出，`@nexus/core` 放定義套件的 `peerDependencies`（`devDependencies` 留 `workspace:*`，不能讓安裝結果出現第二份 core）。**這是第一個相依 core 的定義套件。撤除條件**：SDK 與定義套件要發布到私有 registry 之前，要先做 Q2 (b)，讓定義套件不再相依 `@nexus/core` |
| 投影的 provider 只收定義，不負責推動（#1421，PM 決策 2） | 表達不出來，退到最接近的實作 | dsh 的 `SessionProjectionRegistry` 自己監聽 `session/created` 與 `session/event`，逐 session 推動每一格（`session-projection/src/index.ts`）。我們把推動留在 `@nexus/core` 每條 thread 的登記處（`createProjectionFold`）：推動綁在會話日誌與 wire 的投影通道上，搬過去就是 Q2 (b) 那一刀。**撤除條件**：跟 Q2 (b) 一起做 |
| 投影：provider 這一層同 key 同 `stateVersion` 引用計數共用、`stateVersion` 不同才拒絕；每條 thread 的登記處每個 key 只收一份、重複照舊拒絕（#1421，PM 決策 1） | 照 dsh；thread 那一層是沿用的舊偏離 | provider 層照 dsh（`session-projection/src/index.ts:253-292`）：同一個套件可能掛 N 次，引用計數歸零之前一直用第一個登記者的定義，版本不同報 `refusing to share`。thread 層的重複拒絕登記在 `.docs/session-projections-design.md:95` 與 `:110`，理由是「一次組裝一張註冊表、不熱換」——這個理由對每條 thread 的登記處仍然成立，對樹上的 provider 不成立（它是行程級的，樹會熱換；重掛時新舊兩份 fiber 可能短暫重疊）。所以兩層各自的規則不同：共用的 key 由宿主（`plugin-tree.ts` 的 `#assignProjections`）只交給**這一份清單上起來了的第一個登記者**折進 thread |
| 樹上那一列改了或停了，開著的對話照舊有它的投影（#1421，照 #1416 Q3 的快照語意） | 產品需求超出 dsh | dsh 在卸載時把那個 key 從活的快照拿掉（引用計數歸零就刪，`session-projection/src/index.ts:273-292`）。我們不跟：組 thread 時拿的是快照（決議 §3-2 第 6 條「插件更新只給新對話」），單元是純函式的折疊，樹上那一列卸了之後開著的對話手上的單元照樣折得動，下一條 thread 才看到新的 |
| `present` 的暫存表以身分（thread＋位址＋`callId`）當鍵，不用 `WeakMap<ToolExecution>` | 表達不出來，退到最接近的實作 | dsh 的工具執行與 `tools/result` 拿到的是**同一個物件**，所以 `WeakMap` 夠用；我們的 `exec` 每次都在 `tool-pipeline.ts` 的 `toolExecutionOf` 重建，物件身分對不上。照它的意思改用身分當鍵（#1418） |
| 答題管道是函式服務 `channelForThread`，不是 exec 上的欄位 | 表達不出來，退到最接近的實作 | dsh 的答題者從 `exec.agent` 分發；我們的答題管道是宿主服務（`channel`），不在 `exec` 上，沒有地方放「隨呼叫傳進來」的值。呼叫當下依 `callThreadId(config)` 問一支函式，回 `undefined` 退回 `channel`（見上一節）（#1418） |
| 卡上寫「會話位址加上 thread 身分」，實作是另外加 `exec.thread` 與 `callThreadId`，`SessionAddress` 沒動 | **對卡上字面的改動，不是對 dsh 的偏離** | `SessionAddress` 是**一張 `SessionRegistry` 之內**的位址：每張註冊表就是一條 thread（根日誌 id 就是那條 thread 的 id、子代理日誌 id 是 `<root>/<runId>`，`session-registry.ts`），`sessionAddressKey` 只用來在那一張裡當 Map 鍵。thread 在「挑哪一張註冊表」那一步就用掉了，放進位址會在同一張表裡重複一份永遠相同的值。實測的足跡：24 個檔案提到 `SessionAddress`，原始碼與測試裡有 38 處 `kind: 'root'`、33 處 `kind: 'subagent'` 的字面比對、20 個檔案走 `toolCallSessionAddress`——加欄位要全部改，不加成可選欄位則又回到「沒填就挑不出」。而且背景子代理的 `thread_id` 本身就是 `<root>/<runId>`，已經含 `runId`，放進位址會有兩種寫法指同一個身分（`thread-id-reaches-handlers.test.ts` 量到）。所以 thread 走呼叫設定（`callThreadId`），在 `forCall` 與 `exec.thread` 用 |
| `live-model` 的 `retryPolicy.mode` 只收 `normal`，`always` 拒收（#1427） | 產品需求超出 dsh | dsh 的 `retryPolicy` 有 `normal` 與 `always` 兩種模式（`packages/llm/llm/src/retry-policy.ts:37-57`），`always` 對每一次模型請求失敗無限重試到成功、取消或卸載。我們是企業內部聊天機器人：一輪沒有盡頭，中段失敗每次都重付整個回覆，無限重試會無限重付。其餘照 dsh：`mode` 寫了就必填，`maxRetries`／`retryableCodes`／`backoff` 逐條照 `resolveRetryPolicy`／`resolveBackoff` 驗（登記在 `apps/harness/src/settings/live-model.ts` 檔頭「偏離二」）。**撤除條件**：demian 提出需要無限重試的情境 |

## 接進清單（#1416 PR 2）

`echo` 是第一顆遷上樹的插件，`token-meter` 是第二顆（#1421）。清單（`cordis.yml`、home 的變更紀錄、`--patch`）仍由相容層的 `loadPluginConfig` 讀、疊、驗，
**樹那一側不是第二份清單，是清單的一個消費者**：

| 東西 | 在哪 | 做什麼 |
| --- | --- | --- |
| 載入器的分辨 | `plugin-config.ts` 的 `resolveEntryModule` | 模組有 `manifest` 具名匯出就是函式插件，走 `validateManifest`；沒有就照舊是 `NexusPlugin`。判別式只有一個（`plugin-tree.ts` 的 `isFunctionPluginModule`），Include 的允許名單也從它算 |
| 橋接列 | `plugin-config.ts` 的 `isBridgeEntry` | 函式插件在相容層清單上的代表：同一個 id、同一個位置、`Config` 是 manifest 的 `config`，所以設定驗證、停用、補號、快照、會話 header 都照舊。它的 `apply` 不自己掛任何東西，只把**登記者是這一列**的工具與投影單元折進這一條 thread 的 registry（每一種接縫一格，見下） |
| 樹 | `plugin-tree.ts` 的 `PluginTree` | `tools` 一列（工具登記處）、`projections` 一列（投影登記處）、`include` 一列（Include 讀出貨的 `cordis.yml`、疊 patch），函式插件在 `include:<id>` |

- **變更紀錄怎麼到樹上**：折出來的 patch 原樣經 `entry.update({ config: { ...includeConfig, patches } })` 推給 Include（dsh
  `app-boot` 的做法）。**Include 不寫回任何檔**——寫入口只有變更紀錄一個（`vendor/README.md` 第 7 條，上游三條寫回路徑全關）；Loader 上游會在安裝樹建 `.cordis/` 輔助檔，宿主給了解析函式就不建（第 9 條），所以安裝樹唯讀也不影響掛載。
- **兩支疊 patch 的演算法**：相容層的 `applyEntryPatches` 與上游的 `applyPatches` 對下面五種操作疊出一樣的 id／name／
  disabled／config 與順序（停用、啟用、改設定、還原設定、`--patch` 改與插入；`echo-on-tree-edges.test.ts`）。已知的差別是
  帶 `id` 的 `insert`（相容層接到尾巴，上游往群組裡塞），推給樹的 patch 把那個 `id` 拿掉，兩邊就一致。每次同步還會比一次
  樹上那一列的 `disabled` 與 `config` 跟相容層疊出來的是否相同，不同那一列算掉了，不靜靜地各走各的。
- **樹上的結果怎麼對回清單上的掉列**：樹上那一列 FAILED 或缺席是 `apply` 階段、PENDING（缺服務、契約不相容）是 `requires`
  階段，在**讀清單那一步**就判定（以前 echo 重名要到組裝那一刻才掉）。契約不相容的訊息帶消費者列 id（樹上的 `include:<id>`）。
- **橋接列折入多種接縫（#1421）**：`RowVerdict` 的 `active` 帶每一種接縫的貢獻（`tools`、`projections`），橋接列的 `apply` 把
  來源是那一列的各自折進這條 thread 的 registry：工具走 `registry.tools.register`，投影單元走 `registry.projections.register`。
  同一個 key 由兩列共用時，只交給其中一列（見偏離表），這條 thread 的登記處才不會撞上它自己的重複拒絕。
- **加一個新接縫要動哪幾處**：(1) 定義套件（token、介面、契約版本，`@nexus/*` 但不放 `@nexus/plugin-*`）與提供者
  （`<定義>/provider`，`createXxxProvider()` 回 `{ Provider, entries(), … }`）；(2) `plugin-tree.ts`：掛一列內建列
  （`PluginTree.#build` 與 `mountDetached` 兩處）、`RowVerdict.active` 多一格、`#snapshot` 把登記處的 `entries()` 分給列；
  (3) `startup-audit.ts` 的 `REQUIRED_TREE_ENTRY_IDS` 加上那一列的 id（它起不來，函式插件沒有地方掛）；
  (4) `plugin-config.ts` 的 `FoldedContributions` 與 `registerFolded` 多一格，折進 registry 的對應通道；
  (5) 一致性套件的 `residue` 由消費者的測試指到提供者的登記筆數（`registrations()`），而且要掛上後比掛上前多。
- **設定帶 `__jsExpr` 整份拒絕**：Loader 的 `interpolate` 會把它當 JavaScript `eval`。相容層讀清單時掃走橋接那幾列的最終
  `config`（寫入前驗證走同一條，所以寫入口當場擋下，不會把一條讓之後每次啟動都失敗的東西寫進紀錄），推上樹之前再掃一遍
  整份 patch 當後盾。
- **沒有樹的呼叫端**（手搭 `PluginEntry` 清單的測試、基準任務、`shippedPlugins()`）：橋接列在組裝時單獨掛一次、取工具與
  投影單元、立刻卸載，走的是同一個 Loader 與 `tools`、`projections` 提供者。產品路徑（`cli.ts`、`serve.ts`）不走這條。

### 已知限制

- **插件自我停用只在記憶體**（PM 決議）：插件自己 `ctx.fiber.dispose()`，Loader 的 case 7 把那一列在樹上標成 `disabled`，
  Include 不寫檔、也不進變更紀錄。清單是「想要的狀態」，所以下一條 thread 同步時會把它重新掛上、它再停用一次——
  **每條 thread 閃動一次**。要不要把自我停用也寫進變更紀錄，等 demian 決定（`echo-on-tree-edges.test.ts` 的閃動那一條釘住
  今天的行為）。
- **`cordis.serve.yml` 那一層不經 Include**：Include 只有一個 `path`，serve 專屬層是相容層疊在出貨層後面的另一個檔。那一層裡的
  函式插件上不了樹，會在讀清單時掉在 `apply` 階段並指名原因；今天那一層沒有函式插件。要放進去，得讓 Include 讀多個檔或
  把那一層併進出貨檔。
- **橋接列是過渡的**：卡上寫「拿掉」，留著是因為清單上其餘 19 列還是 `NexusPlugin`，要跟 echo 排在同一份清單、同一個順序裡
  （PM 決議 Q-A）。最後一顆搬出相容層時橋接連同整個相容層一起拿掉。這是對卡上字面的偏離，登記在這裡與 PR 內文。

## 這一刀沒有的

- **帶型別的 lint 規則**：別名繞過今天抓不到（見「lint 與 gate」的「已知的洞」），有人真的繞過再升級。
- **capabilities 的執行**：「不宣告就不給」另開一張。
- **版本路由、兩版並存、逾時**。
