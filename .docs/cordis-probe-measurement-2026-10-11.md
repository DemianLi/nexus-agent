# 核心底座探針：量測報告

回答 [#1386](https://github.com/DemianLi/nexus-agent/issues/1386)（地圖 [#1385](https://github.com/DemianLi/nexus-agent/issues/1385)）。驗收條件見卡面，量測前已寫死，這裡沒有改。

**量測日期**：2026-10-11。nexus `b88d8339`（develop）上的分支 `chore/cordis-probe-1386`。上游 `cordiverse/cordis` `c261dd2c13d65b1994adb1cdc10d7dba61542523`（`cordis` 4.0.0-rc.10、`@cordisjs/plugin-loader` 1.0.0-rc.7）。Node 25.9.0、macOS arm64、tsx 4.23.12、vitest 4.1.11、TypeScript 5.9.3。

> **更正（2026-10-11，[#1401](https://github.com/DemianLi/nexus-agent/issues/1401)）**：探針把上游 `FiberState` 的 3 誤當成 UNLOADING，其實上游的順序是 FAILED 3、DISPOSED 4、UNLOADING 5。所以下文 ③ 負對照的「停在 `UNLOADING`（3）」是**撤掉之前**讀到的 FAILED，那是撞名失敗的正常狀態，不是 #127。#127 本身確實重現（照 issue 的 repro，以及 #1401 拿掉修補後變紅的測試），只是不是在 ③ 撞到的。#1401 讓 ③ 在撤掉之後再讀一次：沒有修補停在 FAILED（3），有修補收斂到 DISPOSED（4）。套件名與目錄也在 #1401 換成 `@nexus/cordis`、`vendor/loader`。其餘數字是當時的快照，沒有改。

探針程式在 `apps/harness/src/measure/cordis-1386/`，沒有接進出貨路徑。vendor 的套件在 `vendor/cordis`、`vendor/cordis-loader`，清單與本地修改登記在 [`vendor/README.md`](../vendor/README.md)。

## 結論

| # | 要證明的 | 結果 | 要不要重開決議 |
| --- | --- | --- | --- |
| ① | NodeNext 下型別可用 | **有條件成立。** 上游原樣不行：消費者的四道型別牙全部失效，整個匯出面退化成 `any`。補上本地修改第 1 條（等同上游還開著的 #125，也就是 dsh 第 4 條的 core 那一半）並建出宣告檔之後，`ctx.get`、`inject` 回呼裡的 `ctx`、`provide` 的回傳都解得到；`provide` 的值型別與 `inject` 的鍵名仍然不檢查（上游的型別設計，見 ①）。卡面括號裡已經預期要靠本地修改補，所以條件沒有超出卡的預期 | §3-1 第 1 條**不重開** |
| ② | 相容層讓出貨清單原樣跑 | **成立，但證明的範圍比字面窄**：證明的是「包進 Cordis 的 fiber 不會擾動組裝」，不是「插件已經是 Cordis 的成員」（見 ②） | §3-1 第 5 條**不重開** |
| ③ | 新舊版並存加排水 | **成立。** 用真的開子行程的 `nexus-plugin-mcp`：兩版各在一個 isolate realm，v1 的最後一個 thread 結束後由引用計數撤掉，它開的 1 個 `ProcessWrap`、2 個 `PipeWrap` 逐一收回，全部收掉後活資源與載入前相同 | §3-2 第 6 條**不重開** |
| ④ | 樹由變更紀錄導出 | **成立。** 不 fork Include，Loader 不寫 YAML；逐筆重播與冷啟動折疊都與現場的樹逐欄相同。「Loader 不寫任何檔」只在內建插件的列上成立，見 ④ 的發現 | §3-5 **不重開** |
| ⑤ | 服務契約的 semver 檢查 | **成立。** 走的就是 `provide` 的第三個參數 `check`（`vendor/cordis/src/reflect.ts` 的 `provide(name, value?, check?)`）。要讓 `check` 讀得到消費者宣告的範圍，提供者得是 `Service`；plain object 提供者做不到 | §3-4 第 15 條**不重開** |

①～③ 都沒有觸發重開條件，所以決議 §3-1 第 1 條與 §3-2 第 6 條照舊。

## 要 demian 決定的三件事

探針有三處沒有照卡面的「做法約束」或 dsh 的做法走。三處都不影響上面的結論，但都要拍板。

1. **本地修改超出「只補 #6 與 #127」。** 實際登記了三條：
   - 第 1 條是 `.ts` 副檔名，等同 #125。
   - 第 2 條重寫 `package.json`。
   - 第 3 條換成我們自己的 `tsconfig`。

   沒有這三條，① 不成立（數字見 ①）。卡面 ① 的括號寫了「dsh 靠本地修改第 4、10 條加 gate 補」，第 1 條就是 dsh 第 4 條的 core 那一半，gate 是 `nodenext.test.ts`。

   dsh 第 10 條沒有移植。它是為了 Node 原生的 TypeScript 轉譯，把被抹掉的 import 明確標成 `type`。我們只用 tsx 與 vitest 跑原始碼，碰不到那條路；`utils.ts` 那一行 `import type` 已經順手拆好了。
2. **卡面要補的 #6 與 #127，兩條都沒補。** 理由是先量「上游 main 原樣」本身行不行，不然補丁會把上游的毛病遮掉。
   - #127 在 c261dd2c 上照 issue 的 repro 仍然重現，③ 的負對照也撞到了：撞名失敗的 v2 fiber 停在 `UNLOADING`（3），收斂不到 `DISPOSED`（4）。補了之後這個數字預期是 4，但沒有實測。
   - #6 的情境（在 setup 裡發起卸載）沒有一格觸及。
   - 要決定的是：在這張卡裡補，還是留給遷移地圖的第一張卡。
3. **套件名保留上游的，沒有像 dsh 第 17 條那樣換成自己的 scope。** 這是「形狀不同」，不是「現有基礎建設表達不出來」，達不到 AGENTS.md 的偏離門檻。照規則標成偏離：
   - 換 scope 要再改 Loader 原始碼裡所有指向 `cordis` 的 specifier，等於多一條本地修改。
   - 探針階段不發佈，所以沒換。
   - 正式 vendor 時要不要換，等決定。

## ① NodeNext 下的型別

**量法**：

- `nodenext/consumer.ts` 只相依 `cordis` 與 `@cordisjs/plugin-loader`，用 strict、`module: NodeNext` 的 tsconfig 檢查。
- 「解得到」不靠 tsc 綠來證明。消費者裡有四行標了 `@ts-expect-error` 的錯用法：
  - `hello(1)`
  - `get('greeter')` 指派給 `number`
  - `loader` 指派給 `Greeter`
  - `provide()` 的回傳指派給 `number`
- 型別一旦退化成 `any`，這幾行就不再報錯，標記變成未使用（TS2578），tsc 會紅。
- 突變對照把標記拿掉，必須恰好報 4 個錯、而且沒有 TS2578。

| 版本 | 模式 | 設定 | 錯誤數 | 其中 TS2578 |
| --- | --- | --- | --- | --- |
| 上游原樣 | 原始碼 | NodeNext 消費者 | 107 | 4 |
| 上游原樣 | 建 `cordis` 宣告檔 | vendor 的 tsconfig | 41（36 個 TS2835：相對 import 缺副檔名） | — |
| 上游原樣 | 建 Loader 宣告檔 | vendor 的 tsconfig | 67 | — |
| 上游原樣 | 宣告檔 | NodeNext 消費者 | 7 | **4**（四道牙全部失效） |
| vendor | 原始碼 | NodeNext 消費者 | 50（全在 vendor 內部：TS7053 等隱含 any） | 0 |
| vendor | 原始碼 | nexus 的 `tsconfig.base.json` | 155（59 個 TS5097、24 個 TS1484 `verbatimModuleSyntax`、38 個 TS7053…） | 0 |
| vendor | 建兩個宣告檔 | vendor 的 tsconfig | 0 | — |
| **vendor** | **宣告檔** | **NodeNext 消費者** | **0** | **0**（突變：恰好 4 個錯） |
| vendor | 宣告檔 | nexus 的 `tsconfig.base.json` | 0 | 0 |

所以消費者**一定要讀宣告檔、不讀原始碼**：上游原始碼過不了 nexus 的 strict。這就是本地修改第 2、3 條存在的理由：

- `exports` 用 `types` 條件指向 `lib/types`。
- `prepare` 在 `pnpm install` 時建宣告檔。CI 的 setup 跑 `pnpm install --frozen-lockfile`，所以 CI 上也會建。

**型別面上量到的四件事**：

| API | 有沒有被型別檢查 |
| --- | --- |
| `ctx.get(name)`、服務屬性 `ctx.greeter` | 有（牙） |
| `inject([...], (ctx) => …)` 回呼裡的 `ctx` | 有（牙） |
| `provide(name, value)` 的回傳 | 有（牙） |
| `provide(name, value)` 的**值型別** | **沒有**：值不合時落到 `provide(name: string, value?: any)` 那個重載，不報錯（`consumer.ts` 刻意留一行不標） |
| `inject([...])` 的**鍵名** | **沒有**：名字打錯也不報錯（同上，留一行） |
| `Context` 上的 `provide` 帶 `check` | **型別上沒有這個參數**：`Context` 的宣告只有兩個參數，`check` 只在 `ctx.reflect.provide` 與 `Service` 那條路上 |

**重跑**：

```bash
pnpm install
pnpm --filter @nexus/harness exec vitest run src/measure/cordis-1386/nodenext.test.ts
```

上表的對照數字是手動量測，不在 CI 裡。量測需要一份停在 c261dd2c 的上游 clone，腳本在 mktemp 的目錄裡自己接 `node_modules`，不碰工作樹：

```bash
git clone https://github.com/cordiverse/cordis.git references/cordis
git -C references/cordis checkout c261dd2c13d65b1994adb1cdc10d7dba61542523
bash apps/harness/src/measure/cordis-1386/nodenext/baseline.sh references/cordis
```

## ② 相容層讓出貨清單原樣跑

**做法**：

- Cordis 當根、vendor 的 Loader 掛兩列。
- `compat` 那一列是 `compatLayer`：在 fiber 的 async `apply` 裡自己用 `loadDefaultPlugins` 解出貨清單，以服務 `nexus.assembly` 提供「用這份清單組一個 agent」。設定（`serve`）從那一列的 config 來。
- `loop` 那一列 `inject: ['nexus.assembly']`，拿到服務後組 agent、跑一輪。
- 對照組是今天的路：`loadDefaultPlugins` 加 `createNexusAgent`。
- 兩邊各用一支腳本模型跑一輪，比四樣：
  - 送給模型的每一次請求（含系統提示）
  - 綁定的工具（名稱、描述、參數 schema，轉成 OpenAI 格式的 JSON）
  - 圖的節點（middleware 名稱與順序）
  - 命令名

比法照 `assembly-parity.test.ts`。

| 清單 | 列數 | 結果 |
| --- | --- | --- |
| CLI（`cordis.yml`） | 49 | 四樣逐位元組相同 |
| serve（疊 `cordis.serve.yml`） | 50 | 四樣逐位元組相同 |
| 對照：交換三組（`agent-instructions`↔`system-prompt`、`plan-mode`↔`goal`、`repeat-reminder`↔`tool-result-pruner`） | 49 | **仍然相同** |
| 突變：拿掉 `todo` | 48 | **不同**（比對有牙） |

交換之後仍然相同是**發現，不是缺陷**：middleware 的順序由 fold 的槽位表決定，不靠清單順序。這一點只從三組推出來，沒有窮舉。

**這一格證明得比字面窄，三件事要講明**：

- 兩條路呼叫的是**同一個** `createNexusAgent`，Cordis 只看得到一顆插件。所以它證明的是「搬進 fiber、清單經 Loader 的列進來、服務經 inject 交給另一顆 fiber」不會擾動組裝，**不是**「20 顆 `nexus-plugin-*` 各自成為 Cordis 的成員」。後者是遷移地圖的工作。
- 比對點是 `createNexusAgent`，它在裡面呼叫卡面點名的 `assembleAgent`。產品的 CLI 與 serve 實際還經過 `assembly-root.ts`：清單最前面多插一顆 `createHostServicesPlugin`，另外傳 channel、核准政策、token 錨點本這些選項。這一層**沒有**在 Cordis 底下量。
- 相容層本身沒有生命週期：它不登記 `ctx.effect`，組出來的 agent 由 `loop` 那一列自己 `dispose`。

**重跑**：

```bash
pnpm --filter @nexus/harness exec vitest run src/measure/cordis-1386/compat.test.ts
```

## ③ 新舊版並存加排水

**做法**：選 `nexus-plugin-mcp`，因為它是出貨插件裡少數 `apply` 會開**真的**行程級資源的：一台 stdio 的 MCP server 子行程加三條管線。用不開資源的插件量「回到載入前」，那是空的通過。

- `packages/nexus-plugin-mcp/src` 複製成 `v1`、`v2` 兩份，各自 `import()`：兩份模組、兩個實例。
- **一個版本＝Loader 的一列**：`nexusVersion` 把一顆 `NexusPlugin` 包成 Cordis 插件。`apply` 裡 `loadPlugins`、用 `ctx.effect` 登記 `dispose`，再以服務 `mcp` 提供出去。列上帶 `isolate: { mcp: <版本標籤> }`。
- **thread＝Loader 的一列**：`inject: ['mcp']`，列上的 `isolate` 指向它被路由到的版本，`apply` 時真的呼叫一次 MCP 工具。
- `VersionRouter` 持有版本表：新 thread 一律導到最新版，thread 結束時引用計數減一，不是最新版又歸零就 `loader.remove()`。
- 在 tsx 子行程裡跑（理由同 `plugin-coexist.test.ts`）。活資源用 `process.getActiveResourcesInfo()` 計數。

實跑一次的原始輸出（節錄）：

| 量到的 | 值 |
| --- | --- |
| 兩版是不同的模組實例 | 是 |
| thread-a → `mcp@1`，thread-b、thread-c → `mcp@2`，各自拿到工具回應 | 是 |
| v1 還有 thread 時沒有被撤 | 是 |
| v1 開的活資源 | `ProcessWrap` 1、`PipeWrap` 2 |
| v1 最後一個 thread 結束後 | 列被移除、fiber 收斂到 `DISPOSED`（4）、活資源 `ProcessWrap` −1、`PipeWrap` −2 |
| v2 照常服務 | 是 |
| 全部收掉後與載入前的差 | `{}` |
| 子行程總耗時 | 約 4.3 秒 |

**負對照**（拿掉 `isolate`）：

- 第二版 `provide` 同名服務時撞名：`service "mcp" has been registered at <mcp-version>`。
- 它開的子行程照樣收掉，差是 `{}`。
- 失敗的 fiber 停在 `UNLOADING`（3）：上游 #127。

**有一個順序是承重的**：`ctx.effect(() => () => loaded.dispose())` 要排在 `ctx.provide` **前面**。寫成 `apply` 回傳收尾函式的話，`provide` 撞名拋錯時收尾還沒登記，子行程就漏了，行程結束不了。

**重跑**：

```bash
pnpm --filter @nexus/harness exec vitest run src/measure/cordis-1386/coexist.test.ts
```

或直接看原始輸出：

```bash
cd apps/harness
node --import tsx src/measure/cordis-1386/coexist-cli.ts
```

## ④ 樹由變更紀錄導出

**做法**：

- `ChangeJournal` 只能往後加，每一筆在加進去時複製並凍結。
- 管理動作先 `append` 再呼叫 Loader 的 `create`／`update`／`remove`。
- Loader 自己發起的變更都經過 `EntryTree.commit()`：
  - 插件 `ctx.fiber.dispose()` 自我停用，上游寫 `disabled: true`
  - 插件 `ctx.fiber.update()` 改自己的設定
- 根 Loader 的 `commit()` 上游本來就是空的，這裡把它換成寫紀錄。
- 冷啟動時把整份紀錄折成巢狀列表，交給 `loader.root.update()`。

量了六條：

| 量的 | 結果 |
| --- | --- |
| 10 筆管理動作外，紀錄裡多出的恰好是 Loader 回報的兩筆（`quitter` 自我停用、`tuner` 改設定） | 是 |
| 逐筆重播到一顆全新的 Loader，樹逐欄相同（選項、有沒有在跑、group 子列） | 是 |
| 冷啟動：紀錄折成列表交給 `root.update()`，樹逐欄相同 | 是 |
| 負對照：少一筆（`memory` 搬家那一筆），樹不同 | 是 |
| spy `node:fs` 與 `node:fs/promises` 的寫入函式，整個過程寫檔次數 | 0 |
| 正對照：spy 抓得到 vendor Loader 唯一寫檔的那條路 | 抓得到 |

**發現**：

- **「Loader 不寫任何檔」只在內建插件的列上成立。** 按套件名（裸 specifier）載入的列會經過 `createResolve`，在設定目錄寫出 `.cordis/{.gitignore,resolve.mjs}`；沒裝選配的 `node-addon-require-builtin` 時會走這條。它寫的不是樹的狀態，卡面的「不寫回 YAML」仍然成立。但在內網多人共用的主機上，二選一：
  - 設定目錄要可寫；
  - 要裝那顆 addon。
- **換掉 `loader.commit` 要靠型別轉換**：那不是有型別的公開接縫，上游隨時可能改動它。正式做的時候要嘛登記成本地修改，要嘛向上游要一個 hook。
- **Loader 回報的那兩筆是「結果」，不是「原因」**：紀錄記的是「`quitter` 被停用了」。重播時插件照樣會自己再停用一次，所以拿掉這兩筆重播仍然綠，因為插件的行為是確定的。插件行為不確定時（看時間、看外部狀態），重播出的樹可能和紀錄不一致。這要在事件溯源的設計裡決定：哪一份是真相。

**重跑**：

```bash
pnpm --filter @nexus/harness exec vitest run src/measure/cordis-1386/journal.test.ts
```

## ⑤ 服務契約的 semver 檢查

**做法**：

- 提供者是 `Service` 子類別，`[Service.check]` 讀消費者宣告的範圍，用 `semver.satisfies` 檢查。不相容就拋 `ContractError`，裡面指名消費者那一列、提供者那一列、服務、兩邊版本。
- `Service` 把 `[Service.check]` 當作 `provide` 的第三個參數交出去（`vendor/cordis/src/service.ts`）。
- 它由**消費者的** fiber 呼叫（`Fiber._checkImpl`），`this` 是追蹤到消費者 ctx 的代理，所以讀得到消費者宣告的範圍。
- 範圍可以寫在插件自己的 `inject: { memory: { range } }`，也可以寫在 Loader 列上的 `intercept`。

| 量的 | 結果 |
| --- | --- |
| 範圍相容 | 消費者 `ACTIVE`、拿到服務 |
| `^3.0.0` 對上 2.3.0 | 消費者停在 `PENDING`；錯誤是「插件 consumer-new 要的服務 memory 是 ^3.0.0，provider 提供的是 2.3.0」 |
| 範圍寫在 Loader 列的 `intercept` | 同樣擋下、指名那一列 |
| 換上 3.0.1 的提供者 | 被擋的消費者自己接上，原本相容的那個換成被擋 |
| 負對照：plain object 提供者，`check` 的 `this` 是什麼 | 就是值本身，讀不到消費者的範圍，不相容的也放行（`ACTIVE`） |

**發現**：

- **錯誤進的是提供者的 logger**（`impl.fiber.ctx.logger`），不是消費者的。消費者那一列只會安靜地停在 `PENDING`，自己的 logger 沒有任何一行。後台要顯示「這一列為什麼沒起來」，得另外蒐集。
- 契約檢查只能做在 `Service` 上。plain object 的 `provide` 要嘛拿不到消費者，要嘛得改成 `Service`。
- `check` 拋錯與回 `false` 的效果一樣，都是不給。只有拋錯會留下可讀的原因。

**重跑**：

```bash
pnpm --filter @nexus/harness exec vitest run src/measure/cordis-1386/contract.test.ts
```

## 給遷移地圖的發現

- **`entry.fiber` 是 PromiseLike 的包裝，不是 Fiber 本身**：真的 Fiber 是 `entry.fiber.ctx.fiber`。拿它比身分或改狀態時會對錯對象。dsh 第 20 條修的就是這個，探針用 `tree.ts` 的 `fiberOf()` 繞過。
- **#127 實際撞到**：失敗的 fiber 停在 `UNLOADING`，見 ③ 的負對照。
- **② 與 ③ 的轉接形狀不同**：
  - ② 是「整個 PluginRegistry 包成一顆相容層」，沒有生命週期。
  - ③ 是「單顆 `NexusPlugin` 包成一列」，用 `ctx.effect` 綁住 `dispose`。
  - 「相容層底下做版本並存」這個組合沒有被任何一格證明。遷移時大概要走 ③ 的形狀：一顆插件一列。
- **宣告檔要建**：`vendor/*/lib/` 不進版控，靠 `prepare`。換機器、換 worktree 先 `pnpm install`。
- **服務名的型別靠 `declare module 'cordis'` 擴充 `Context`**：鍵名與值型別都不檢查（見 ①），插件數一多就容易打錯名字而不自知。要靠 lint 或 gate 補。
- **錯誤的歸屬**：⑤ 的契約錯誤進提供者的 logger，不是被擋的那一列。後台要把錯誤掛回正確的列，得自己從錯誤內容對回去。

## 只讀過、沒有跑的

- **dsh 第 6 條的情境**（在 setup 裡發起卸載）：沒有任何一格觸及。
- **HMR**：照卡面不 vendor、不量。
- **Include 讀完 YAML 之後呼叫 `root.update()`**：讀上游原始碼得到的。④ 的冷啟動直接呼叫 `root.update()`，沒有經過 Include。
- **isolate realm 底下的記憶體累積**：[`plugin-coexist-measurement-2026-10-07.md`](plugin-coexist-measurement-2026-10-07.md) 量到每載一個新版本就線性增長、不回收。這次只量活資源（handle），沒有在 Cordis 底下重量堆。
- **交換清單順序不影響組裝**：只從三組推出來，沒有窮舉。
- **不在出貨清單上的插件**：`mcp`、`memory`、`quickjs`、`skills`、`telemetry-otel` 沒有走 ② 的比對。`mcp` 在 ③ 跑過真的 `apply`，但沒有比組裝結果。
- **`assembly-root.ts` 那一層**（host services、channel、核准政策）：見 ②。
- **#127 修補後 ③ 負對照的狀態**：預期是 `DISPOSED`（4），沒有實測。

## 全部重跑

```bash
pnpm install
pnpm --filter @nexus/harness exec vitest run src/measure/cordis-1386
```

5 個測試檔、20 條，本機約 5 秒（③ 的子行程佔大半）。
