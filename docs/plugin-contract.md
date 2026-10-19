# 插件規範

樹上的插件怎麼寫、怎麼被驗、怎麼被換。**這是最小切片**（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416)，
屬於 [#1385](https://github.com/DemianLi/nexus-agent/issues/1385)）：manifest、帶型別的 token、semver 契約檢查、
一致性套件，以及強制它們的 lint 與 gate（[#1420](https://github.com/DemianLi/nexus-agent/issues/1420)）。
capabilities 的執行、版本路由與兩版並存不在這一刀，見文末。

決議出處是 [`.docs/decisions-2026-10-11.md`](../.docs/decisions-2026-10-11.md) §3-4。程式碼在
[`packages/nexus-sdk`](../packages/nexus-sdk)（`@nexus/sdk`）與
[`packages/nexus-tools`](../packages/nexus-tools)（`@nexus/tools`，第一個服務定義套件）與
[`packages/nexus-projections`](../packages/nexus-projections)（`@nexus/projections`，第二個，#1421）與
[`packages/nexus-skills`](../packages/nexus-skills)（`@nexus/skills`，第三個，#1446）、
[`packages/nexus-commands`](../packages/nexus-commands)（`@nexus/commands`，第四個，#1456）與
[`packages/nexus-feedback`](../packages/nexus-feedback)（`@nexus/feedback`，第五個，#1456，**第一個由插件提供、宿主消費的服務**）、
[`packages/nexus-approval-channel`](../packages/nexus-approval-channel)（`@nexus/approval-channel`，第六個，#1458，**宿主在建樹時給值的預設答題管道**）與
[`packages/nexus-tool-result`](../packages/nexus-tool-result)（`@nexus/tool-result`，#1458，工具回結果的三個寫法，**不是接縫**，只是單向轉出）與
[`packages/nexus-session`](../packages/nexus-session)（`@nexus/session`，#1435 起單向轉出會話日誌的讀法，**#1463 起多一個接縫：第七個，會話查找**，宿主在樹上提供「這次呼叫的會話」）與
[`packages/nexus-fs`](../packages/nexus-fs)（`@nexus/fs`，第八個，#1466，宿主在樹上提供「這次呼叫的那條 thread 的 fs 把手」）與
[`packages/nexus-system-prompt`](../packages/nexus-system-prompt)（`@nexus/system-prompt`，#1477，**第二個由插件提供、宿主消費的服務**：系統提示詞的各段與變數名）與
[`packages/nexus-goal`](../packages/nexus-goal)（`@nexus/goal`，#1486，**第三個由插件提供、宿主消費的服務**：每份 root 日誌上的 goal 域，查找時才建）與
[`packages/nexus-permission-presets`](../packages/nexus-permission-presets)（`@nexus/permission-presets`，#1491，**第四個由插件提供、宿主消費的服務**：組一條 thread 時決定權限組合的起始值與目錄）。

## 這份規範管誰

**只管 Cordis 樹上的函式插件。** 樹上有相容層與入口兩列、各接縫的登記處與宿主給值的內建列（`tools`、`projections`、`skill-sources`、`commands`、
`approval-channel`、`session-lookup`、`fs`）、`include`（讀出貨清單的那一列），加上逐顆遷出的函式插件。**哪些宿主列、哪幾顆已經遷出，以兩處為準，這一節不寫名單與數字**
（每張遷出卡都會改，寫在這裡一定漏）：宿主列看 `apps/harness/src/startup-audit.ts` 的 `REQUIRED_TREE_ENTRY_IDS` 與下面「接進清單」的樹表；
遷出的插件看「接進清單」開頭的順序與 `apps/harness/src/migrated-plugin-gate.test.ts` 的 `EXPECTED_MIGRATED`（gate 會對它量，漏一顆就紅）。
還留在相容層裡的是 `NexusPlugin` 物件，照舊 `export default`（`cordis.yml` 的 `name` 要靠它指到那顆物件），不受下面
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

## 收尾順序（#1636）

照 dsh `docs/cordis-primer.md:45`：「If teardown order matters, keep the related work in one effect」。Cordis 只保證下面三件事，
不做全域的逐一收尾（dsh 的 proposed note 否決，`.agents/notes/proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.md:73`）。

- **兄弟 effect 同時收。** 同一列裡兩個 `ctx.effect`、同一個 fiber 底下的子 fiber，卸載時一起開跑，誰先收完不保證。
- **有順序要求的收尾，放進同一個 effect。** 用 generator effect 依序 `yield` 每一步的 disposer：卸載時倒序，前一個收完
  才跑下一個（disposer 要是 async 才會等）。例如「先送完最後一筆、再關連線」，兩步就要在同一個 effect 裡，不能各掛一個。
- **依賴者先收完，提供者才收**，由 Cordis 保證。但這不保證**兄弟 effect 關掉的資源**還活著：自己的收尾用得到的資源，
  由同一個 effect 管到底（dsh 同一份 note `:9-11`）。

宿主這一側：清單少一列時，`PluginTree.sync` 等那一列收完才回傳；同一個 id 刪掉又加回來，新的那一份掛上時舊的已經收完。
收尾沒有逾時，所以 disposer 一定要會結束：永遠不 resolve 的 disposer 會讓那一次 `sync` 一直等，排在它後面的組裝也跟著等。
需要上限（例如等一個遠端行程退出），就在自己的 disposer 裡設，宿主不替插件加。
上面前兩條由 `packages/nexus-sdk/src/teardown-order.test.ts` 釘住，vendor 的 Cordis 改了行為會先紅。

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
- **第三個接縫：技能來源登記處**（`@nexus/skills`，#1446）。形狀照 `@nexus/projections`，但**收的是路徑，不是 dsh 的提供者**：
  `SkillSourceRegistry` 的 `addSource(path)` 是 effect（登記者那一列卸載時登記處自己撤掉）；提供者放
  `@nexus/skills/provider`，宿主在樹上掛一列 `skill-sources`。消費者宣告 `inject = injectOf(need(skillSourcesToken, '^1.0.0'))`、
  在 `apply` 裡 `service(ctx, skillSourcesToken).addSource(path)`。**主入口不 import `@nexus/core`**（有測試掃）；`provider` 入口
  import core 匯出的 `assertLoadableSkillsPath`，在**登記時**就驗路徑格式（寫錯的列在讀清單那一步掉在 `apply`，不等組 thread），
  所以 `@nexus/core` 放 `peerDependencies`、`devDependencies` 留 `workspace:*`。**同一個目錄只收一次**（`/skills/` 等於 `/skills`，
  不論同一列寫兩次還是兩列各一次）：後登記的那一列掉在 `apply`，訊息指名兩邊。這跟投影接縫的引用計數共用不同——兩列指到
  同一個目錄只會讓同名 skill 自己覆蓋自己。同一列改設定重掛不會被自己舊的那一份判成重名（卸載的 effect 先撤掉舊的）。
- **第四個接縫：命令登記處**（`@nexus/commands`，#1456）。形狀照 `@nexus/projections`：`CommandRegistry` 的 `register(definition)` 是
  effect（登記者那一列卸載時登記處自己撤掉）、`list()` 依名字排序不帶 handler；提供者放 `@nexus/commands/provider`，宿主在樹上
  掛一列 `commands`。消費者宣告 `inject = injectOf(need(commandsToken, '^1.0.0'))`、`manifest.consumes` 同步，在 `apply` 裡
  `service(ctx, commandsToken).register({ name, description, handler })`。**中繼資料在登記時就驗**（規則同 core 的
  `normalizeCommandDefinition`），**同一個名字只收一次**（Q5 (a)）：後登記的那一列掉在 `apply`，訊息指名兩邊；同一列改設定重掛不會
  被自己舊的那一份判成重名。命令的型別（`CommandDefinition`、`CommandInvocation`、`CommandResult`……）由這個定義套件**單向轉出**
  `@nexus/core`，插件只 import 定義套件。**跟 `@nexus/plugin-commands` 的分工**：`@nexus/commands` 管**登記**（有哪些命令、誰登記的、
  重名怎麼擋），`@nexus/plugin-commands` 管**執行**（解析一行輸入、查命令、寫 `command/run`／`command/done`、呼叫 handler）；
  執行器只讀每條 thread 的 `registry.commands`，宿主把樹上登記的命令折進那一張 registry，所以執行那一半不動。
  **契約 1.1.0（#1516，minor）**：`CommandDefinition` 多一格**選填**的 `runWhileBusy?: readonly string[]`——命令宣告「一輪跑著、
  或停在核准點時也放行」的完整字面值（資料，不是函式也不是整個命令的布林；每一格非空、頭尾無空白，重複的收成一格）。宿主的閘門與
  `slash.list` 的 descriptor 讀同一份資料。舊的 1.0.0 消費者不受影響（範圍 `^1.0.0` 仍相容）；`goal` 的 `need` 與 manifest 收緊到 `^1.1.0`。
  **已知的縫**：樹上的命令跟**相容層**的命令撞名，要到組 thread 時才掉（相容層的列直接寫進 `registry.commands`，不經提供者）；有測試
  釘住今天的行為。
- **第五個接縫：插件提供、宿主消費的服務**（`@nexus/feedback`，#1456）。前面的接縫都是宿主提供登記處、插件消費；這一個**反過來**：
  - **提供者是插件**：定義套件只有 token（`feedbackToken`，服務名 `messageFeedback`）、介面與契約版本，沒有提供者入口。插件在
    `apply` 裡 `new` 一個繼承 `ContractService` 的類別（建構時 `provide`），`manifest.provides` 宣告它（**第一顆 `provides` 非空的
    遷出插件**）。用 `new` 不用 `ctx.plugin(Class)`；歸屬（`.provider`）是那一列的 id。
  - **消費者是宿主**：組 thread 時 `PluginTree.#snapshot` 從樹上 `root.get(token.name)` 取，比 `.provider` 判斷歸屬，**只交給 `active`
    的那一列**，折進 `registry.services.provide`（`registerFolded` 的 `services` 格）。
  - **服務的方法不碰 `this.ctx`**：宿主手上是組 thread 時取的快照，那一列之後卸載、開著的 thread 仍要能呼叫（traceable proxy 讀屬性
    不檢查提供的 fiber 還在不在）。需要的設定在建構時進閉包、日誌由呼叫端逐次傳進來；方法用自己的屬性閉包規則，不用 `#私有欄位`
    （proxy 的 shadow 上私有欄位會拋）。
  - **同名第二份當場拋**：Cordis 在 `provide` 拋 `service "…" has been registered at …`，後掛的那一列掉在 `apply`。
  - **一致性套件量得到撤除**：`residue` 是呼叫端的閉包，量不到服務還在不在 root 上，所以 `checkConformance` 的 `unload` 格自己讀 root：
    `manifest.provides` 宣告的服務掛上後要讀得到（歸屬是這一列、契約版本同宣告），卸載後要讀不到。
- **第六個接縫：預設答題管道**（`@nexus/approval-channel`，#1458 Q1 (c)、Q2 (a)）。形狀跟前五個都不一樣：**值由宿主在建樹時給，不是插件登記進來的**。
  - **定義套件**：token（`approvalChannelToken`，服務名 `approvalChannel`）、`ApprovalChannelService`（只有 `current(): ApprovalChannel | undefined`）、
    契約版本，與 `@nexus/core` 的 `ApprovalChannel`、`ChannelForThread`、`QUESTION_INTERRUPT_KIND`、`CHANNEL_SERVICE`、`CHANNEL_FOR_THREAD_SERVICE`、
    `QuestionReply`⋯的**單向轉出**（core 放 `peerDependencies`，同 `@nexus/session` 的前例）。`channelForThread` 的 token 與型別留在這個定義套件，**今天沒有提供者**。
  - **提供者**：`@nexus/approval-channel/provider` 的 `createApprovalChannelProvider(channel | undefined)`，宿主在樹上掛一列 `approval-channel`（`PluginTree.#build` 與
    `mountDetached` 兩處）；值是進入點算出來、建樹時交進去的那一份——serve「有人在」是 `human`、CLI headless 是 `policy-never`
    （`cordis-root.ts` 的 `entryApprovalChannel`、`createCordisRoot({ channel })`）。**沒有樹的呼叫端**（`bindDetached`）從組裝根的 `channel` 服務讀、交給
    `mountDetached`，讀不到就是「沒有指定」。
  - **消費者**：ask-user 的 `inject` 是 `need(approvalChannelToken, '^1.0.0')`，在 `apply` 當下 `service(ctx, token)` 把**服務**抓進閉包，`current()` 是**呼叫當下**才問的（值是宿主交給這個行程的，今天是常數）；**不再逐條 thread 查**
    （不把 `channelForThread` 放進 `inject`：選配的相依會讓匯出形式那一格紅）。服務**一定在**、值可能是 `undefined`，所以必要相依照常成立，
    「沒有人指定」是呼叫當下拒絕（fail-closed，#669），不是載入失敗。服務的方法是屬性閉包、不碰 `this.ctx`，卸載之後開著的 thread 手上的那份照樣能問。
  - **為什麼不是提供者掛 `provide`**：兩個進入點的答題者是**情境**（有沒有人在），不是一個可以註冊的東西；放進 `cordis.yml` 的一列要有設定，而這個值沒有設定、也不該被 patch 改。
- **第七個接縫：會話查找**（`@nexus/session`，#1463 Q1 (a)；逐條 thread 接縫的第三段，#1418 → #1458 → 這一張）。形狀同第六個：**值由宿主給、插件消費**，但它是**逐次呼叫**才有答案的服務。
  - **定義套件**：token（`sessionLookupToken`，服務名 `sessionLookup`，契約版本 `1.0.0`）、`SessionLookupService`（只有 `forCall(invocation: unknown): SessionLookup`），
    與 `@nexus/core` 的 `SessionLookup`、`SessionAddress`、`TodoItem`、`TodoStatus`、`TODO_STATUSES` 的**單向轉出**（core 放 `peerDependencies`，同前例；`todo/write` 的事件擴充搬進 core 的 `session-log.ts`，
    因為它原本寫在 `@nexus/plugin-todo` 的 `declare module`，消費者不能再 import 那個套件）。
  - **提供者**：`@nexus/session/provider` 的 `createSessionLookupProvider(lookup)`，宿主掛一列 `session-lookup`（`PluginTree.#build` 與 `mountDetached` 兩處，列在必掛名單，`startup-audit.ts`）。
    查找函式是**行程級的**：樹那一邊是 `apps/harness/src/thread-sessions.ts` 的 `ThreadSessions`（每條活著的 thread 一張註冊表，鍵是 root 日誌 id）；沒有樹的那一邊是**那一次組裝自己的** `registry.sessions.forCall`
    （`bindDetached` 交給 `mountDetached`），兩份無樹組裝互不相見。
  - **挑法只有一份實作**：`@nexus/core` 的 `pickSessionForCall(bound, config)`——沒有就 `not-attached`；一張時：相容層不看 `thread_id`，樹上的行程級查找（`ThreadSessions`）**也核對**——呼叫帶了 `thread_id` 而那一張不擁有它就是 `ambiguous`（#1482，選項 `verifySingle`），沒帶 `thread_id` 的呼叫維持直接挑它；多張依 `thread_id` 挑「有一份日誌的 id 等於它」的**恰好一張**，挑不出一律 `ambiguous`（寧可明說也不猜）；
    挑到之後算不出位址是 `unknown-caller`。相容層的 `registry.sessions.forCall` 與樹上的服務**都是它**，不另寫一份。
  - **登記與撤除**：`createNexusAgent` 的 `attachSession` 在綁上註冊表、背景 host 建好、參與者訂閱成功之後才登記，撤除掛在它回傳的 detach 上（與解綁、退訂同一個函式）。**登記排在那一步的最後**，所以組裝在中間任何一步拋，都不會在行程級的查找裡留下沒收的註冊表。
    **同一條 thread id 重組**時後登記的**取代**先登記的（`ThreadSessions` 以 root 日誌 id 為鍵），舊的那一份遲到的 detach 只撤自己；所以行程裡不會有兩張都認得同一條 thread 的登記（那會讓下一次呼叫變成 `ambiguous`）。
    會重組同一個 id 的時機：(1) serve 的 thread 在 `attachSessions` 之後、`ready.set` 之前建不起來，條目被刪、下一次請求同 id 重組；舊的那份由 `wire-handler.ts` 的 catch 收掉（#1467 之前 catch 只收 `threadAgent`，舊的會話接線、落盤、標題沒人收；現在和成功路徑的 `state.dispose` 共用同一支 `release`）；
    (2) 同一棵樹上先後組同一個 id（測試、同一個行程裡 `resume` 接回同一份日誌）；(3) 行程重啟是新的一棵樹，沒有殘留。
  - **消費者**：todo 的 `inject` 只要 `need(sessionLookupToken, '^1.0.0')`，`apply` 當下 `service(ctx, token)` 把**服務**抓進閉包，`forCall` 在**呼叫當下**才問。服務方法是屬性閉包、不碰 `this.ctx`，樹上那一列卸載之後開著的 thread 照樣寫得進自己的日誌（同 #1456 的快照語意）。
  - **三個入口各自接，各有一條會紅的測試**（`apps/harness/src/todo-on-tree.test.ts`）：CLI 與 serve 都是 `cordis-root.ts` 的 `boot` 把 `tree.threadSessions` 交進相容層（`compatLayer.create` → `createCliAgent` → `attachSession`），沒有樹的路徑走 `bindDetached` → `mountDetached`。
    **宿主的義務**：載入了樹上的插件、卻不經 `root.boot` 就呼叫 `createCliAgent`，todo 會回 `not-attached`（產品路徑一律 boot）。
- **第八個接縫：fs 查找**（`@nexus/fs`，#1466 Q2 (a)、Q2-1 (a)；逐條 thread 接縫的第四段，#1418 → #1458 → #1463 → 這一張）。形狀同第七個：**值由宿主給、插件消費**，逐次呼叫才有答案。
  - **定義套件**：token（`fsToken`，服務名 `fs`，契約版本 `1.0.0`）、`FsLookupService`（只有 `forCall(invocation: unknown): FsLookup`）、`FsLookup` 四種結果（`ok` 帶 `fs` 把手與位址、`not-attached`、
    `unknown-caller`、`ambiguous{count}`），與 `@nexus/core` 的 `FsService`、`SessionAddress` 的**單向轉出**（只轉型別，core 放 `peerDependencies`，同 `@nexus/session`）。
    **把手**就是這次組裝 host-services 裡那一格 `fs` 服務（`createFsService`／`settleFsService`，fold 之後填值），不另建 backend；消費者在呼叫當下才讀 `backend()`。
  - **提供者**：`@nexus/fs/provider` 的 `createFsLookupProvider(lookup)`，宿主掛一列 `fs`（`PluginTree.#build` 與 `mountDetached` 兩處，列在必掛名單，`startup-audit.ts`）。
    樹那一邊是 `thread-sessions.ts` 的 `ThreadSessions.fsForCall`；沒有樹的那一邊是 `registry-fs-lookup.ts` 的 `registryFsLookup(registry)`（**那一次組裝自己的** `fs` 服務，兩份無樹組裝互不相見）。
  - **同一張登記表、同一支挑法**：一次 `attachSession` 登記**一筆**，這一筆**同時帶這條 thread 的會話註冊表與 fs 把手**（`ThreadEntry = { sessions, fs }`）；會話查找與 fs 查找都套同一支
    `@nexus/core` 的 `pickBoundForCall`（`pickSessionForCall` 是它外面包一層「開日誌」），**挑法只有一份實作**，不另寫一份。所以兩個查找對「這次呼叫屬於哪一條 thread」永遠給同一個答案。
  - **登記與撤除**：同第七個（`attachSession` 的最後一步登記、撤除掛在它回傳的 detach、同 id 重組時後者取代前者且舊的遲到的 detach 只撤自己），不另開一條。
  - **消費者**：submit-record 的 `inject` 是 `need(toolsToken, '^1.2.0')` 加 `need(fsToken, '^1.0.0')`，`apply` 當下兩個服務都抓進閉包；工具本體 `fs.forCall(invocation)`，**一律同一句話**回報三種失敗
    （`not-attached`／`unknown-caller`／`ambiguous` 全是 `SUBMIT_RECORD_NO_BACKEND_MESSAGE`，#1466 Q3 逐字不變）。
  - **三個入口各自接，各有一條會紅的測試**（`apps/harness/src/submit-record-on-tree.test.ts` 的「三個入口各有一條」）：CLI（`boot('cli')` 的樹上內建列）、serve（`submit-record-wire.test.ts`，真的 `runServe`、真的核准卡、
    `--workspace` 磁碟上的檔案）、沒有樹的呼叫端（兩份無樹組裝互不相見）。多條 thread 同時活著時每一次呼叫靠 `thread_id` 認主人，另有 root、同步子代理、背景子代理、重組、組裝失敗、撤除六種形狀的紅燈（同檔「E」）。
  - **只剩一筆登記時也核對 `thread_id`（#1482）**：行程級的查找（`ThreadSessions.forCall`／`fsForCall`）在只剩一筆登記時，呼叫若帶了 `thread_id` 而那一筆不擁有它，回 `ambiguous`（數量是 1），不再把唯一剩下的那一條當成它的主人。**這是 fs 的安全邊界**：fence 是每條 thread 各一顆（`/permission` 切的就是它），一條 thread 收尾途中還在跑的工具若被挑到別人身上，會寫進別人的 backend、套用別人的 fence。核對只在帶了 `thread_id` 時做；相容層的 `registry.sessions.forCall` 與沒帶 `thread_id` 的呼叫維持「只有一筆就是它」。挑法仍只寫在 core 的 `pickBoundForCall` 一處（選項 `verifySingle`，行程級查找傳 `true`）。
    代價：`ambiguous` 的拒絕句（todo／goal 的「接了 N 份會話…」）在 N 為 1 時讀起來怪，今天不另開結果種類。
    **收尾順序是這條的另一半**（#1482，照 dsh 的 cancel → drain → flush → dispose）：`attachSession` 回傳的 detach 在有背景 host 時是非同步的，**先等背景 host 收完（中止進行中的輪、等它寫完 `turn/end` 與結算通知），才撤登記、解綁、停參與者**；serve 的 `release` 再接著收落盤與 agent。撤得太早，收尾中的工具會問不到自己的登記，落盤先退訂則讓被中止那一輪的事件到不了後端。
    **之後開「閒置 thread 回收」的卡（#1464 量到每條 thread 常駐約 2.1 MB、不回收）要先處理它**，兩個做法擇一：detach 等背景 host 收完再撤登記，或行程級查找一律核對 `thread_id`（改挑法要 demian 拍板）。
- **工具接縫 1.2.0：核准閘門**（`@nexus/tools`，#1466 Q1 (a)）。`ToolRegistry` 多一個**選配**方法 `gate(listener)`：登記一位 pre-execute 閘門，`(exec, next) => allow | deny | ask`，鏈底 `allow`（照 dsh
  `ctx.on('tools/pre-execute')` 的 waterfall）。**消費者**宣告 `^1.2.0`，並在呼叫前檢查 `gate` 存在（`1.0.0`／`1.1.0` 的提供者沒有它，缺就是啟動失敗而不是靜靜少一道閘）。**折進去**：
  `RowVerdict.active.gates` → `FoldedContributions.gates` → `registerFolded` 逐位進這條 thread 的 `registry.approvals.gate`，**來源仍是那一列的 `name`（`submit-record (submit-record)`）**，
  所以 `approval-gate-order.test.ts` 的順序守衛與問人時顯示的來源都不變；問人仍走 `nexusApprovalGate` 中介層（管道、政策、確定拒絕照舊，CLI headless 與背景子代理仍是 policy-never）。
  次版號升級：既有消費者（`echo`、`ask-user`、`todo` 等）不呼叫它，照常。
- **工具接縫 1.3.0：`tools/result` 觀察者**（`@nexus/tools`，#1469 Q1 (a)）。`ToolRegistry` 多一個**選配**方法 `onResult(listener)`：登記一位工具結果的觀察者，`(exec, result) => void | Promise<void>`，
  `exec` 帶 `callId`、`name`、`args`、`agent`（root 或子代理 `runId`，認不出是 `undefined`）與 `thread`（#1418 要的逐條 thread 暫存鍵），`result` 只暴露 `isError`——**全是結構型別寫在 `@nexus/tools` 裡，套件不 import core**。
  **消費者**宣告 `^1.3.0`，並在 `apply` 裡檢查 `onResult` 存在（`1.2.0` 以前的提供者沒有它，缺就是**掛載失敗**而不是靜靜不交付，前例是 submit-record 對 `gate()`）。**折進去**：提供者記下登記者是哪一列，
  `RowVerdict.active.resultListeners` → `FoldedContributions.resultListeners` → `registerFolded` 逐位進這條 thread 的 `registry.events.on('tools/result', l)`——**派發的時機與次序仍是核心圍堵的**
  （`tool/call` → 觀察者 → `tool/result`，觀察者的失敗被隔離），這一層只決定「誰聽」。工具與觀察者是**同一次折疊進同一條 thread**，所以之後列被卸載也不拆開。
  次版號升級：宣告 `^1.2.0` 的 `submit-record`、`echo`、`ask-user` 不呼叫它，照常（`packages/nexus-tools/src/provider.test.ts` 的 `old-120` 消費者釘住）。
- **fs 接縫 1.1.0：工作區事實跟著把手走**（`@nexus/fs`，#1469 Q2 (a)）。`FsService` 多 `hasWorkspace(): boolean`；`offWorkspacePrefixes()` 把 plugin 用 `backend.mount()` 掛的路由前綴也併進來（組裝點明著交的在前、plugin 掛的在後，重複 fold 不累加）。
  兩樣都在 **fold 填 backend 的同一處**算（`settleFsService(service, backend, facts)` 是唯一的算法，`fold.ts` 把 `registry.capabilities.has(WORKSPACE_CAPABILITY)` 與 `registry.backend.mounts()` 當 `facts` 交進去），不在別處再算一次。
  fold 在所有 `apply` 之後跑，所以 `hasWorkspace()` 與工具呼叫當下才讀 `capabilities.has` 等價（`sandbox-policy` 在 `apply` 裡提供能力）。另轉出 `virtualPathOf`（路徑換算，實作留在 core，同其他轉出）。
  向後相容的新增：只用 `backend()` 的消費者（`submit-record`，宣告 `^1.0.0`）照常。
- **第九個接縫：`agent/pre-step`——一次 agent 呼叫開頭追加訊息**（`@nexus/agent-loop` 1.0.0，#1474 Q1 (a)、Q2 (a)）。對應 dsh 的 `agent/pre-step`：插件在模型看到這一步之前，往訊息批次加一則持久的使用者訊息，`agent-instructions` 的 `AGENTS.md` 基線是第一個消費者。
  - **定義套件**：`@nexus/agent-loop`（token `agentLoop`，契約 `1.0.0`；模樣同 `@nexus/tools`，提供者在 `@nexus/agent-loop/provider`）。介面只有 `preStep(name, listener)`：listener 收 `(visible, { configurable })`，回 `{ content, additionalKwargs? }[]`（0 則是 `undefined` 或空陣列）。**不 import `@nexus/core`**；`visible` 是模型看得到的那一串（摘要之後是 `[summary, ...切點之後]`），摘要器的私有鍵留在宿主。
  - **提供者**：樹上一列內建列 **`pre-step`**（內建列從七列變八列；id 不能叫 `agent-loop`：`startup-audit.ts` 已經把 dsh 的 `agent-loop` 對到「組裝本身」），行程級登記處，只收 listener（名字、listener、登記者那一列的 id）、**不建 middleware**。重名當場拋，後登記的那一列掉在 `apply`；列卸載時登記自己撤。
  - **誰建 middleware、建訊息、記日誌**：都是宿主（`apps/harness/src/pre-step-middleware.ts`）。`registerFolded` 為登記者是某一列的每一位 listener 建**一顆** `beforeAgent` middleware、名字就是登記時給的名字，經 `registry.middleware.use(mw)` 折進**這條 thread 自己的**註冊點（不帶 `prepend`／`last`，所以位置就是那一列在出貨清單上的位置，與遷移前 `useWithBackend` 的落點相同；一份實例走遍 root 與每個子代理，**listener 不能把逐 thread 的狀態放進閉包**）。建的時候不看 backend 在不在：沒有 `--workspace` 時組裝點墊 `StateBackend`，middleware 照建，輪數與 develop 一致。
  - **兩個容易靜靜壞掉的形狀**：宿主交給 listener 的是 `{ configurable: runtime.configurable }`——原樣交給 `fs.forCall(invocation)` 才認得出這次呼叫（交裸的 `configurable` 回 `unknown-caller`，基線會靜靜消失）；日誌經**這條 thread 的** `registry.sessions.forCall` 記一筆 `user/message`（`source: { kind: 'plugin', plugin: 名字 }`），**不走**行程級的 `session-lookup`（多條 thread 時它可能 `ambiguous`），記不進去原錯往外拋、這一輪失敗（#1665，照 dsh：注入的訊息進模型歷史，吞掉的話記憶體與日誌分岔）。
  - **三個入口各自接**：`FoldedContributions`（樹上相容層）與 `DetachedContributions`（沒有樹的路徑，`mountDetached` 掛一次就卸載，所以消費者必須在 `apply` 當下把服務抓進閉包）各加 `preSteps` 欄；內建列加在四處（`#create`、`mountDetached`、`REQUIRED_TREE_ENTRY_IDS`、`cordis-root.ts` 的列表）。
  - **消費者**：`agent-instructions` 的 `inject` 是 `need(agentLoopToken, '^1.0.0')` 加 `need(fsToken, '^1.1.0')`，`apply` 裡把兩個服務抓進閉包，listener 每次呼叫 `fs.forCall(invocation)`；不是 `ok`、或 `backend()` 是 `undefined` 就不注入。**行為逐字不變**（Q4）：記號、渲染、四個候選、`maxBytes`、middleware 名字與位置、日誌 `source`、每次 invoke 一格、摘要後下一次 invoke 補回。
  - **紅燈**：`pre-step-middleware.test.ts`（宿主 middleware 本身）與 `agent-instructions-on-tree.test.ts`（B：列與快照；D：32 輪有沒有 `--workspace` 都一樣；E：兩條以上 serve thread 各有不同 AGENTS.md、root／同步子代理 worker 與 general-purpose／背景子代理、CLI／serve／無樹三個入口，每一格兩個方向都量）。舊外殼（`NexusPlugin`、`createAgentInstructionsMiddleware`）搬到 `agent-instructions.fixture.ts`，給還在相容層組裝的測試用。
  - **只剩一筆登記時也核對 `thread_id`**（見第八個接縫，#1482）：對不屬於那一筆的呼叫，注入拿到 `ambiguous`，不注入。
- **第十個接縫：`systemPrompt`——插件提供、宿主取快照渲染的系統提示詞**（`@nexus/system-prompt` 1.0.0，#1477 Q1 (a)）。形狀同第五個接縫（`feedback`，插件提供、宿主消費），差在**宿主消費的是一份純資料的快照，不是活服務**。
  - **定義套件**：token `systemPrompt`、`SystemPrompt`（`section(section)`、`variable(name)`、`assemble()`）、`SECTION_ORDERS`、嚴格插值 `interpolateStrict` 與前後段的組法 `composeSystemPromptParts`、契約版本。只依賴 `@nexus/sdk`，不 import `@nexus/core`，也不碰訊息型別。
  - **提供者**：`system-prompt` 那一列（`@nexus/plugin-system-prompt`，`manifest.provides` 宣告）。`apply` 裡 `new` 一個 `ContractService`，三格設定（`includeHarnessIdentity`、`personaPrefix`、`personaSuffix`）是這個服務自己的設定，登記身分句、前綴、後綴三段與 `model`、`cwd` 兩個變數名。**掛載當下**用空值把前後綴走一遍（寫壞的語法、不存在的變數名當場拋，那一列掉在 `apply`，必掛，所以起不來，#720）。
  - **宿主取快照**：組 thread 時，`PluginTree.#snapshot` 在 `run` 的臨界區裡對 `active` 且 `provides` 含 `systemPrompt` 的列呼叫 `assemble()` 一次，存成 `RowVerdict.active.systemPrompt`（各段原文與變數名，不含值）；沒有樹的路徑在 `mountDetached` 卸載之前取。**活服務不折進 thread 的 `registry.services`**（相容層的插件拿到就能呼叫 `section()`，段會跨 thread 疊加）。宣告了 `provides` 卻取不到服務、歸屬不符、契約範圍不符、或 `assemble()` 拋，那一列掉成 `dropped`（`apply` 或 `requires`），並帶原因。
  - **宿主建 middleware**：`registerFolded` 以快照建一顆 `nexusSystemPrompt`（`registry.middleware.use(mw, { last: true })`，位置在鏈的最內側；`agent-instructions-on-tree.test.ts` 的三張鏈名守衛原樣不動）。每次模型呼叫代入 `{ model, cwd }`：`model` 取模型實例上的路由標籤（#723，沒貼標籤的用組裝時定的那份），`cwd` 取組裝點給的值。**代入之後頭尾都是空的就不掛**。
  - **預設值走宿主內部的路，不擴充 `NexusServices`**：組裝點（`createNexusAgent`）在清單最前面放一個條目，把 `model`／`cwd` 記在以 `registry.middleware` 為鍵的 `WeakMap` 上，`registerFolded` 讀回。不經 `registry.services`，相容層的插件讀不到。
  - **紅燈**：`system-prompt-middleware.test.ts`（宿主 middleware 本身）、`system-prompt-on-tree.test.ts`（B：列與快照；D2：合法改一次後舊 thread 不動、新 thread 看新的；E：同一份清單兩條 thread 各是各的，加組裝點建的、貼了路由標籤的模型實例）、`startup-audit.test.ts`（D：CLI 與 serve 起動時寫壞的變數名都起不來；已知缺口：必掛列自我停用不進 `dropped`，由一條測試釘住）。
  - **已知缺口（Q3）**：樹上自我停用（`off`）的必掛列不進 `dropped`，必掛名單接不住；`system-prompt` 沒有自我停用的呼叫，這張卡不修。
- **第十一個接縫：`goals`——插件提供、宿主查找的逐份日誌 goal 域**（`@nexus/goal` 1.0.0，#1486 Q1 (a)、Q3 (a)）。形狀同第五個接縫（`feedback`），差在**服務是一張查找表，不是一顆狀態**。
  - **定義套件**：token `goals`、`GoalServices`（`serviceFor(log)`、`existingFor(log)`）、宿主要用的 `GoalService` 窄介面（`get`／`block`／`pause`／`disarm`），加上單向轉出的純函式與型別（`foldGoal`、`applyGoalChange`、`renderGoalRoundPrompt`、`GoalView`…，Q4 (a)）。只依賴 `@nexus/core`（`peerDependencies`）與 `@nexus/sdk`；`hasDirectHumanTurn` 留在插件裡（只有工具與命令用）。
  - **提供者**：`goal` 那一列（`@nexus/plugin-goal`）。`apply` 裡建一份 `WeakMap<SessionLog, GoalService>`（閉包內，模組層級沒有任何一格），`serviceFor` **第一次被問到才建**：建構子在同一個同步區塊裡「讀 `log.events` 重播 → `log.subscribe`」（`SessionLog.append` 先凍住監聽清單、再 push、再同步發布，所以不漏、不重）；建立時不碰 `ctx`、訂閱不掛 effect，所以列卸載之後已經建好的服務照常運作。`serviceFor` **只收 root 日誌**；工具層自己看 `address.kind`，subagent 呼叫得到「這一份會話上沒有接 goal 域，所以沒有動。」（逐字同遷移前的 `GOAL_TOOL_NO_SERVICE_MESSAGE`，常數改名為 `GOAL_TOOL_NOT_ROOT_MESSAGE`）。`existingFor(log)` 是**不建、不重播**的讀，給閒置逐出的判斷用（見下）。
  - **宿主**：`HOST_SERVICES` 多一格（`goals`，帶 `^1.0.0` 的範圍），組 thread 時從樹上取、折進該條 thread 的 `registry.services`（與 `messageFeedback` 同一條路）。**這不是 #1477 的「活服務不折進 registry.services」那一條**：那一條防的是相容層插件拿到活服務就能呼叫 `section()`，段跨 thread 疊加；`goals` 的消費者就是相容層裡的宿主程式（續行排程器、thread-pump、wire-handler），而查找表本身以日誌為鍵，跨 thread 不會疊加。宿主的 production 碼對 `@nexus/plugin-goal` 零 import（`git grep -n "@nexus/plugin-goal" -- apps/harness/src ':!*.test.ts' ':!*.fixture.ts'`）；`apps/harness/package.json` 保留這個依賴，因為 `cordis.yml` 的 `name` 是裸 specifier。
  - **閒置逐出（#1484）怎麼讀**：`GoalDriverPort.armed?()` 走 `existingFor`（**非建立式讀**）：從沒被問過 goal 的 thread 與「沒有武裝的目標」在那個判斷上等價——授權只活在行程內（`fold.ts` 的 `activation` 不落盤），只有服務自己的 `create`／`resume` 才掛得出 `armed`，沒有服務就沒有人掛過。續行排程器的 `block`／`disarm`／`pause` 與 `goal()` 仍走 `serviceFor`（要寫的路）。服務建好卻重放失敗（`#failure`）時 `get()` 會拋，逐出判斷把拋當成「不閒置」。**重建的 thread 是未武裝的**（授權不落盤，重放回 `disarmed`），與重啟一致。
  - **紅燈**：`packages/nexus-plugin-goal/src/tree.test.ts`（一致性、套一次服務兩條 thread、lazy 的四個方向、subagent 不建服務）、`eslint-exclusion.test.ts`；宿主端——`goal-on-tree.test.ts`（逐出判斷走非建立式讀；撤掉再開拿到新日誌新服務、查找以日誌為鍵；撤掉的日誌可回收）、`serve-idle-eviction.test.ts`（走真的 serve：撤掉再開 ＝ 重啟再開，目標從落盤的日誌折回來）、`goal-reload.test.ts`（設定中途改了：開著的 thread 不動、新的 thread 看新的；reload 後工具、`/goal`、宿主打到同一個實例）、`goal-driver-cli.test.ts` 與 `serve.test.ts`（接線：出貨清單上的 goal 列、`goalDriverPort` 打在注入的那一份、續行）。舊外殼（`NexusPlugin`、`createGoalPlugin`）搬到 `apps/harness/src/goal.fixture.ts` 與插件包內的 `goal-shell.test.helper.ts`，給還在相容層組裝的測試用；兩者共用同一份 `createGoalCore`／`mountGoal`，行為只有一個出處。
- **工具接縫 1.1.0：登記選項**（`@nexus/tools`，#1458 Q3 (a)）。`register(tool, options?)` 多一個**選配**的第二參數：`rootOnly`（`true`，或 `{ message, error? }` 帶自己的拒絕句與碼，
  照 dsh `DELEGATED_CALLER`）與 `outputSchema`（有 `safeParse` 的東西，成功輸出照它驗）。選項隨工具一起折進 thread 的註冊點（`RowVerdict.active.toolOptions`、
  `registerFolded`）；**沒有 `scope`**（`rootOnly` 配 `scope` 是矛盾，註冊點當場拋，這裡不開這個口）。次版號升級：`^1.0.0` 的舊消費者照常（不傳第二參數），要用選項的消費者宣告 `^1.1.0`。
- **工具結果的三個寫法**（`@nexus/tool-result`，#1458 Q4）：`toolRefusal`（回給模型的拒絕）、`toolCallIdOf`（從呼叫設定取呼叫 id）、`markToolError`（替一則拒絕訊息掛錯誤內容）。實作留在 `@nexus/core`，
  這個套件只做單向轉出（core 放 `peerDependencies`）——表達不出來，退到最接近的實作（偏離表）：抽出實作是橫跨核心的一刀（同 `@nexus/session`、`@nexus/projections`），而 `markToolError` 與 core 讀它的 `toolErrorOf` 共用同一個 `WeakMap`，複製一份寫入端就是靜默失效。
  `callThreadId`、`toolCallSessionAddress` 在 #1469 加進來（present 要用：交付表的鍵帶 thread 與呼叫者位址，這是 #1458 檔頭預留的位置）。放這裡而不放 `@nexus/tools`／`@nexus/sdk`：前者的 `package.json` 只准相依 SDK 與工具型別（測試釘著），後者不 import core。
  現有消費者：`@nexus/plugin-ask-user`（三個寫法）、`@nexus/plugin-present`（`toolCallIdOf`、`toolRefusal`、`callThreadId`、`toolCallSessionAddress`）。
- 這個慣例 dsh 也只是慣例，沒有 gate 強制；這裡同樣不加 gate。`@nexus/tools` 有一條測試守它的相依只有 SDK 與工具型別。依賴的放法照 dsh：宿主給的 `@nexus/sdk`、`@nexus/cordis`、服務定義套件（`@nexus/tools`）放 `peerDependencies`，`devDependencies` 留 `workspace:*` 供開發與測試——`ContractError` 的 `instanceof` 與 Cordis 的 `Context` 類別都要求宿主與插件看到同一份，放進 `dependencies` 在套件獨立安裝時就可能各裝一份。`@nexus/plugin-echo` 與 `@nexus/tools` 各有測試釘著。

- **第十二個接縫：會話參與者（`sessionLookup.join`）與 `permissionPresets` 服務**（`@nexus/session` 1.1.0、`@nexus/fs` 1.2.0、`@nexus/permission-presets` 1.0.0，#1491 Q2、Q3、Q4、Q5）。
  - **會話參與者**：`sessionLookup.join(installer)` 登記一位參與者；每條 thread 的 `registry.sessions` 在組裝時把登記者是某一列的那幾位一位一位折進去，**位置就是那一列在清單上的位置**（`bindToTree` 照清單順序呼叫），所以日誌上事件的相對順序（`approval/policy` → `sandbox/mode` → `permission/preset`）靠清單順序。參與者拿到的 subject 是 `{ address, log, rootLog（唯讀的 SessionLogView）, observe }`；`rootLog` 讓子代理的參與者讀父代理當下的狀態，不必碰控制器。次版號升級：`^1.0.0` 的舊消費者照常。
  - **兩顆旋鈕的寫入面**（#1494 起控制器跟著 root 日誌走，所以寫入面就是日誌的寫入面）：`/permission` 的 `handler` 在 `packages/nexus-plugin-permission-presets/src/index.ts` 內三處 `sessionLog.append`（`permission/preset`、`sandbox/mode`、`approval/policy`，只寫真的不同的那顆）；root 參與者在新會話釘起始組合時 `subject.log.append('permission/preset', …)`；宿主組 thread 時對控制器的靜默 `switchTo` 只改格子、不寫日誌。控制器本身不再有第二個寫入口。
  - **安裝失敗只記 warn**（R3）：沿用相容層七位會話參與者本來就有的語意（偏離表）。
  - **冷復活（R2）**：背景子代理重啟後被叫醒，日誌以上一個行程的事件為 seed，結尾補 `session/end-seed`。參與者讀「這一次接上時寫的」事件要停在 `session/end-seed`——seed 裡舊的 `sandbox/mode { source: 'delegation' }` 不算數（`permission-presets` 的參與者就是這樣，單元測試與 `permission-presets-on-tree.test.ts` 各有一條紅燈）。
  - **工作區根**：`@nexus/fs` 1.2.0 的 `workspaceRoot()`（行程級；沒給 `--workspace` 是 `undefined`）由入口建樹時交進來（`createCordisRoot({ workspaceRoot })`，CLI 與 serve 都照 `resolveWorkspaceRoot`，跟組裝點是同一支函式、同一個 cwd），`permission-presets` 在 `apply` 當下據它決定掛不掛。拿掉入口那一行交接，`/permission` 整顆不註冊、有 `--workspace` 的 thread 建不起來（訊息指名 `permission-presets`）。
  - **提供者**：`permission-presets` 那一列（`@nexus/plugin-permission-presets`）。`apply` 裡註冊 `/permission`、`permissions` 投影、一位會話參與者，並 `provide` 一個 `permissionPresets` 服務；`start(request)` 是**自己的屬性、閉包住組合表與設定**，純函式（不碰日誌也不碰控制器）。
  - **宿主**：`HOST_SERVICES` 多一格（`permissionPresets`，`^1.2.0`）。組 thread 時 `createNexusAgent` 之後向它要 `start`，據回傳值靜默 `switchTo` 兩顆控制器，目錄也從回傳值拿（`wire` 的 `permission.catalog`）。兩種錯（跟 `--sandbox` 矛盾、起始值對不上任何一組）包成以 `permission-presets` 為不能少掛條目的 `AssemblyDropError`，serve 試組與逐條 thread、CLI 都照「那一列掉了」記錄與轉換；產品路徑上（CLI `cli.ts`、serve 的試組與逐條 thread 都傳 `optionalEntries`，`optionalEntriesOf` 把必掛名單排除在外）以前這兩種錯也是 `apply` 拋、經 `dropped` 變成 `AssemblyDropError`，所以**外層型別與紀錄行為沒變**；實際變的只有那一行 drop 文字，從 `load.ts` 的「`…` 的 apply 失敗，它註冊的東西已全數撤銷 — 〔原因〕」換成 `agent-factory.ts` 的 `assemblyDropErrorFor` 寫的「`…` 在組裝這條 thread 時失敗 — 〔原因〕」，原因（內層訊息）逐字不變。
  - **續接收回（`@nexus/permission-presets` 1.1.0，#1621 第 2 步）**：`PermissionStarted` 多一個選填的 `narrowed`（`PermissionNarrowing`：預設組名與兩顆旋鈕的來源、目標值）。續接的日誌記的沙箱比表裡每一組都寬時才有；`start` 回的 `sandbox`／`approval` 仍是日誌原值，**收回由會話參與者往 root 日誌寫**（`permission/preset` → `sandbox/mode` → `approval/policy`，只寫變了的），因為沙箱與核准的參與者排在前面、會把控制器釘回日誌的值，宿主在 `start` 之後切控制器會被蓋回去。宿主只用 `narrowed` 在 serve 日誌／CLI 標準錯誤留一行 `[權限]`。沒有新事件種類，日誌格式不動。寬窄序在插件裡放一份（`isSandboxWider`，不 import `@nexus/plugin-sandbox-policy`），`permission-resume-narrow.test.ts` 對 `isStrictlyWider` 逐格釘一致。
  - **委派快照收回（`@nexus/permission-presets` 1.2.0，#1739）**：`PermissionPresetsService` 多一個純函式 `narrowDelegated(sandbox)`（只增不減，`^1.0.0`／`^1.1.0` 的舊消費者不受影響；宿主範圍抬到 `^1.2.0`）。背景子代理被叫醒時，宿主在 `SandboxModeController.delegateFromLog` 讀回自己日誌上的委派沙箱之後問它：比表裡每一組都寬就回要收到的那一格（條件與目標同 `narrowingOf`：`defaultPreset`，沒設是表裡檔案政策最寬的一組），否則 `undefined`。只收沙箱、核准不動；只看「表＋這一格快照」，不讀 root 當下的狀態、不碰日誌（子代理日誌仍記委派當時那一格）；同步子代理走 `delegate`，不過這一道。宿主在 `presets.start` 之後把它包成 `setDelegationCeiling` 交給控制器。偏離登記見偏離表與插件檔頭第 10 條。
  - **紅燈**：`packages/nexus-plugin-permission-presets/src/index.test.ts`（一致性、套一次服務兩條 thread、參與者含 R2、`/permission`）、`packages/nexus-session/src/provider.test.ts`（登記簿）；宿主端——`permission-presets-on-tree.test.ts`（三顆事件順序、冷復活、目錄來自服務、工作區根沒交到樹上）、`permission-presets.test.ts`（`--sandbox`、續接、必掛名單、wire）、`serve-plugin-failed-record.test.ts`（矛盾時紀錄指名 `permission-presets`）、`permission-presets-audit.test.ts`（`apply` 拋 → 稽核接住，CLI 啟動、serve 起動、serve 中途換設定後組 thread 三處；換表後開著的 thread 照舊表、新 thread 用新表）。既有測試：D1 `sandbox-mode.test.ts:68`、E2 `serve-idle-eviction.test.ts:99`。

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
- **宿主消費的服務，宿主自己檢查（#1456）。** 上面這道檢查只在**消費者的 fiber** 注入時跑；宿主從 root 讀服務**沒有 fiber**，
  `check` 不會發生。所以宿主在取服務的那一處（`plugin-tree.ts` 的 `HOST_SERVICES`）宣告它期望的範圍（具名常數，今天是
  `FEEDBACK_SERVICE_RANGE = '^1.0.0'`），讀服務上的 `contractVersion` 比 `semver.satisfies`；不合就判**提供者那一列**掉在
  `requires`，訊息的消費者寫「宿主」，指名提供者那一列與兩個版本。沒有樹的呼叫端（`mountDetached`）同一條規則，不合就拋。

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
| `unload` | 掛上後活資源變多、**直接卸載那顆 fiber** 之後回到掛載前、fiber 收斂到 `DISPOSED`；`manifest.provides` 宣告的服務掛上後在 root 上讀得到（歸屬是這一列、契約版本同宣告）、卸載後讀不到（#1456） |
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

這個檔會被 `eslint.config.js` 用 Node 原生載入，載入的是編好的 `lib/lint.js`（#1502 起每個套件的 manifest 都指 `lib/`），
所以不再需要 Node 的 type stripping；代價是**原始碼樹裡要先 `pnpm run build:lib`**，`pnpm -r run lint` 才找得到它
（CI 的 static job 先建置再 lint；`eslint-exclusion.test.ts` 這類在測試裡呼叫 ESLint 的測試，vitest worker 裝了 tsx 的 ESM hook，
把 `@nexus/sdk/lint` 解到 `src/`，不必先建置）。

**外部插件拿得到。** `pnpm pack` 出來的 SDK 帶的是 `lib/`（`files` 只收 `lib`），裝進空目錄 `import('@nexus/sdk/lint')`
載得進來；Fog「SDK 對外發佈前要先建置成 JS」由 #1502 收掉。

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
- **已登記的窄例外**（#1435 Q2 (b)）：`trajectory` 的 `inPlaceSizes`（`trajectory.ts`，`top-level-collection`）。它是以投影重放
  自己的歸屬表物件為鍵的 `WeakMap` 快取：鍵被回收項目就消失，不跨單元實例共用到別人的狀態，卸載後沒有會被誤用的東西；
  dsh 的生產碼有同樣的做法（`packages/compaction/compaction/src/tool-pairing.ts:26` 的 `balanceCacheBySession`）。同一支的
  `TURN_KINDS` 是常數查表，改成唯讀陣列加 `includes`，不必例外。
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

**「有狀態」不等於閉包裡有一張表。** 要分的是這張表的壽命：present 的交付表（#1469）只放**單次呼叫內的過渡狀態**——工具本體記一筆、`tools/result` 到了取走並刪掉，不是要跨呼叫、跨 thread 保留的東西；
工具與觀察者又被**同一次折疊進同一條 thread**、共用同一個閉包，所以列被停用或重載之後，開著的 thread 手上仍是成對的、懸著的那一次交付仍寫得進日誌。這樣的插件**不算**有狀態的插件，可以比版本路由早上樹
（驗收見 `apps/harness/src/present-on-tree.test.ts` 的 D 組）。真正有狀態的是「表的內容要跨呼叫存活並影響下一次呼叫」那一類。

## 逐條 thread 的東西在呼叫當下拿，狀態以日誌為準（#1418）

插件在一次組裝裡**只套一次**，可是這個行程可能同時服務好幾條 thread（serve 一條連線一條 thread）。所以 `apply`
閉包裡抓到的東西，凡是「每條 thread 各一份」的，在第二條 thread 進來的那一刻就是錯的——而且錯得靜默：
工具寫進別條 thread 的日誌，或問到別條 thread 的人。

規則只有兩條，對應 dsh 的 `exec.agent`（身分隨呼叫明確傳進來，不靠 `apply` 當下）：

| 規則 | 怎麼做 | 為什麼 |
| --- | --- | --- |
| **逐條 thread 的東西，呼叫當下才拿** | 要會話日誌，相容層的插件用 `registry.sessions.forCall(config)`、**樹上的插件用 `sessionLookupToken` 服務的 `forCall(config)`**（#1463，兩者是同一支 `pickSessionForCall`），要答題管道用 `registry.services.get(CHANNEL_FOR_THREAD_SERVICE)?.(callThreadId(config))`；**這支函式沒提供、或提供了但對這條 thread 回 `undefined`，都退回 `channel`**。工具 handler 與 middleware 都從呼叫設定的 `configurable.thread_id` 拿身分，`PipelineExecution.thread` 是同一個值 | `apply` 只跑一次；`thread_id` 在 root、同步子代理、背景子代理三種位置都到得了 handler 與 middleware（`apps/harness/src/thread-id-reaches-handlers.test.ts` 實測） |
| **狀態以日誌為準，閉包裡的暫存表鍵要帶 thread** | 暫存表（例如 present 的「已呼叫、尚未落定」）的鍵是 `thread \0 位址 \0 callId`，不是 `callId` | 模型給的 `tool_call.id` 是各 thread 各自編號的，兩條 thread 同時懸著同一個 `callId` 是會發生的 |

**身分三種位置**：root 與同步子代理的 `thread_id` 是 root 那一條（子代理身分靠 `checkpoint_ns`）；背景子代理的
`thread_id` 是它自己的日誌 id（`<root>/<runId>`）並帶 `nexus_background_session`。`forCall` 就是用這個挑會話註冊表：
相容層綁著一張時不看 `thread_id`（跟以前一樣）；樹上的行程級查找一張也核對（#1482）。綁著多張時依 `thread_id` 挑**恰好認得它的那一張**，挑不出仍回 `ambiguous`。

**這條規則怎麼被守住**：`@nexus/sdk` 的 `checkSharedAcrossThreads` 是一格通用的一致性檢查——同一份序列各條
thread 各自掛一份跑一遍當基準，再掛**一份**服務所有 thread 跑一遍，兩邊結果對不上就紅並指名是第幾步、哪條 thread、
各回了什麼。它不 import `@nexus/core`：每顆插件在自己的套件裡寫一個轉接器（ask-user 與 present 各一份，`shared-across-threads.test.ts`）。
這一格**不要求插件上樹**：present 當年是試點，留在相容層（#1418）；**#1469 起 present 也遷上樹**（原本釘住「它不匯出 `manifest`」的 `pilot-plugins-stay-compat.test.ts` 整檔拿掉），轉接器照留，改成對樹上那一份量
（兩條 thread 各有**自己的工作區**，fs 把手挑錯 thread 檔案就「找不到」，也會紅）。ask-user 在 #1458 遷上樹，轉接器照留，改成對「行程級的預設答題管道」量（見下）。

**答題管道（#1458 起）**：ask-user 只消費樹上 `approval-channel` 那一列給的**行程級預設值**，不再逐條 thread 查 `channelForThread`——
這是 demian 拍板的 Q1 (c)（PM 補了兩件：沒有樹的那條路也要接、ask-user 不再查 `channelForThread`）：今天兩個進入點各是一個行程級的情境（serve 有人在、CLI headless），沒有「同一份組裝裡逐條 thread 不同」的產品需求。
`channelForThread` 的 token 與型別留在 `@nexus/approval-channel`，等真的有第二種答題者再接。`apply` 當下把服務抓進閉包，所以**同一棵樹上多條 thread
共用同一個答題者**；「一條有人在、一條沒人在」是兩個行程級組裝（serve 與 headless CLI）的事，各一棵樹、各自的 `channel`。
相容層的測試夾具（`apps/harness/src/ask-user.fixture.ts`）保留舊外殼的取法（先問 `channelForThread`，沒有再用 `channel`），給手搭清單的測試用，不在產品路徑上。

**宿主的義務：進入點建樹時要把自己的答題管道交進去。** 不交就是「沒有指定」，ask-user 在呼叫當下拒絕（`NO_CHANNEL_MESSAGE`）；
拿掉任何一個進入點的那一行交接，`ask-user-assembly.test.ts`（`runCli`、`runServe`）與 `ask-user-on-tree.test.ts` 都會紅。
同一個行程裡的兩份無樹組裝（`bindDetached`）各自從自己組裝根的 `channel` 讀，不共用。

**會話查找（#1463 起）**：todo 是第三顆逐條 thread 的插件，也是第一顆「寫進會話日誌」的：它只消費樹上 `session-lookup` 那一列的**行程級服務**，每次呼叫依 `configurable.thread_id` 挑（root、同步子代理、背景子代理、resume 四種呼叫形狀都量過，且全都是「另一條 thread 活著」的情況——
單條 thread 時 `forCall` 根本不讀 `thread_id`，那種情況量不出任何東西）。這一格的 `checkSharedAcrossThreads` 轉接器直接對服務量。

**一個前提**：背景子代理的日誌在送出時就已經開好（`background-subagents.ts` 的 `start()`，`sessions.open` 在 `submit`
拉起背景圖之前），`forCall` 靠日誌 id 認出它屬於哪一張。日後改成延後才開的話，多張綁定下背景那一輪的第一筆會回 `ambiguous`。

**fs 查找與核准閘門（#1466 起）**：submit-record 是第四顆逐條 thread 的插件、第一顆**要讀寫工作區磁碟**的。
它的 backend 是逐條 thread 的物件（會話歷史與工具結果暫存的路由帶 thread 的鑰匙，`--workspace` 的 fence 是每條 thread 一顆的 controller），
所以走**同一張登記表**：`attachSession` 登記一筆，同時帶會話註冊表與 fs 把手，兩個查找共用 `pickBoundForCall`。
**單一登記時也核對 `thread_id`**（#1482，見第八個接縫），fs 這邊是安全邊界；多條 thread 同時活著靠 `thread_id` 分——
兩條 serve thread 各有自己的工作區、交錯跑、檔案互不串線，是同檔 E 那一組量的。
背景子代理（`<root>/<runId>`）解析到的是**同一份 fs 把手與同一個 backend**（#1466 Q2-2 實測）：它叫 `submit_record` 時閘門釘 policy-never、沒有人被問到、什麼都不寫，所以沒有「寫進誰的工作區」的問題。

**交付與工作區事實（#1469 起）**：present 是第五顆逐條 thread 的插件，也是會話查找的第三個消費者（寫進哪一份日誌）、fs 查找的第二個消費者（讀哪一條 thread 的 backend）。它另外用了兩樣新接縫：
`tools/result` 觀察者（`tools` 服務 `1.3.0`，交付在結果說成功的當下同步寫，次序 `tool/call` → `deliverables/presented` → `tool/result` 與遷出前逐筆相同）與 fs 把手上的工作區事實
（`hasWorkspace()`、併了 mounts 的 `offWorkspacePrefixes()`，`fs` `1.1.0`）。三個入口各有一條會紅的測試（`present-on-tree.test.ts` 的「三個入口各有一條」：CLI 落盤日誌、`boot('cli')` 的樹、沒有樹的呼叫端；serve 是同檔 E 組的
`assembly.create` 形狀，端到端另有 `serve-scripted-provider.test.ts`）。**「只剩一筆登記時也核對 `thread_id`」（見第八個接縫，#1482）對交付同樣成立**：不屬於那一筆的呼叫拿到 `ambiguous`，不會寫進別條 thread。

**交付表的壽命（#1469 Q3 (a)）**：表在 `apply` 的閉包裡，一個行程一張（`apply` 只跑一次），鍵維持 `thread \0 位址 \0 callId`。以前組裝收掉時整張清空（`registry.lifecycle.onDispose`）；上樹之後**拿掉那一行，也不改成列卸載（`ctx.effect`）時清**——
開著的 thread 握著快照裡的工具與觀察者，列一卸表就清的話，懸著的交付會寫不進日誌。
**已知缺口（#1484 已處理）**：被中斷又沒有 resume 的那一筆留在表裡，原本條目握著那條 thread 的 `SessionLog`，thread 收掉之後整份日誌仍被那一筆引用。閒置逐出（#1484）讓 thread 會在行程活著期間被撤，所以這一筆現在**只弱引用日誌**
（`WeakRef<SessionLog>`，仍在 `apply` 閉包裡，不是模組層級）：日誌隨 thread 一起可回收；`onResult` 取不回日誌就丟掉那一筆，下一次寫入時順手清掉殘留鍵。
**不需要新接縫、插件也不必知道 thread 何時被撤——鍵（日誌）自己消失**；重建的 thread 有全新的日誌，碰不到舊的那一筆（`shared-across-threads.test.ts` 的「thread 被撤掉又重建」）。
resume 之後同一個 `callId` 覆寫那一筆、只交付一次（`packages/nexus-plugin-present/src/index.test.ts`）。

**注入與 fs 查找（#1474 起）**：agent-instructions 是第六顆逐條 thread 的插件，也是 fs 查找的第三個消費者（讀哪一條 thread 的工作區）。它的 listener 是**一份服務所有 thread**，所以判準放在訊息的記號上（`additional_kwargs`），不放在閉包裡；fs 一律 `fs.forCall(invocation)` 呼叫當下才問。
`agent-instructions-on-tree.test.ts` 的 E 組全部讓**第二條 thread 活著、AGENTS.md 內容不同**，再從這一條跑，兩個方向都量（對的有、錯的沒有）：認錯主人的樣子是「甲的規矩被注入乙的對話」，而兩邊各自都注入成功，沒有任何例外。

## 偏離 dsh

| 偏離 dsh 的什麼 | 理由類別 | 說明 |
| --- | --- | --- |
| vitest worker 的 `execArgv` 裝 tsx 的 ESM hook，`TSX_TSCONFIG_PATH` 指 `tsconfig.runtime.json`（#1502，PM 改判 A） | 表達不出來（理由 1） | dsh 處理 workspace 裸名插件只有兩種做法：開子行程（`packages/test-support/loader-smoke/src/index.ts:100-127`），或在 `mkdtemp` 底下手寫 `node_modules`（`app-boot.spec.ts` 約 `:934-990`）。兩種都表達不出 `apps/harness` 約 80 個測試檔對行程內物件的斷言（函式身分 `toBe(applyX)`、樹上的列、middleware 鏈、ctx 服務物件）；`plugin-tree.ts` 的 `resolveBareSpecifier` 是 Node 原生的 `import.meta.resolve`，看不到 vite 的 paths 外掛，要經 tsx 的 resolve hook。退到：只在 worker 的 `execArgv` 裝 ESM hook（dsh source-launch 筆記的機制），子行程的**啟動指令**不動；但 hook 的 `TSX_TSCONFIG_PATH` 是在 vitest 主行程設的，測試裡開的每個 `node --import tsx` 子行程（例如沒傳 `env` 的 `entry-main.test.ts`）都會繼承，實際解析因此也改走 runtime 那份 tsconfig。撤除條件：這批測試改走子行程或 `lib` 模式。不違反 `docs/testing.md:49`（那條管載入 Cordis 設定的子行程） |
| `tsconfig.runtime.json` 第二份 tsconfig（#1502） | 表達不出來（理由 1） | dsh 只有一份 `tsconfig.base.json`（`:100-108` 把 vendor 也映到 `src`），嚴格度靠 project references 隔開，base 本身就是 `verbatimModuleSyntax: false`（`:18`）。nexus 的 base 是嚴格單檔、沒有 project references：vendor 放進去 `tsc` 多出 186 個錯，所以分兩份（base 不含 vendor、runtime 含 vendor 並關 `verbatimModuleSyntax`，後者因 cosmokit `Dict` 這類未標 `type` 的 import 在 tsx 下載入失敗），由同一支 `scripts/gen-tsconfig-paths.ts` 寫、`--check` 同查。撤除條件：改用 project references 隔開 vendor |
| tsdown 的 `deps.neverBundle: true`（#1502） | 表達不出來（理由 1） | dsh 靠 tsdown 預設只外掛 `dependencies`／`peerDependencies`，再用 `scripts/check-workspace-constraints.ts:513-521` 強制每個套件把 cordis 同時列進 peer 與 dev。nexus 沒有那支約束檢查，devDependencies 裡的 workspace 套件（例如 `@nexus/cordis`）預設會被內嵌成第二份、單例就壞了，所以退到 `neverBundle`：效果相同（套件之間不內嵌）。撤除條件：補上那支約束檢查 |
| manifest 必填欄位 | 產品需求超出 dsh | dsh 的身分只有 `package.json` 的 name／version 加 Loader 列 id，`dsh` 欄位沒有 id、owner、provides、consumes、capabilities、reload（`packages/util/package-manifest/src/types.ts:8-39`）。決議 §3-4 第 10 條 |
| `Config` 用 zod `strictObject` | 沿用既有偏離 | dsh 用 schemastery 而且非 strict（`vendor/schemastery/src/index.ts:812-822`）。代價：沒有 `.volatile()`，Loader 的 `equalExceptVolatile` 不適用，設定一改那一列就重載 |
| 帶型別的 token | 已登記（決議 §五，第 14 條） | 取代 declaration merging 加 `scripts/gen-cordis-catalog.ts` |
| 服務契約用 `check` 做 semver | 產品需求超出 dsh | dsh 一處都沒用（`Service.check` 在 `packages`、`apps` 為 0）；它的版本相容檢查在套件層，比整個 runtime 的版本（`packages/boot/app-boot/src/plugin-compatibility.ts:61-88`） |
| 共用的一致性套件 | 產品需求超出 dsh | dsh 的卸載測試是每個套件各寫一份；插件層級沒有共用套件，只有後端層級的 contract suite（`packages/storage/storage/tests/contract.ts`）。決議 §3-4 第 12 條。**並由 gate 保證每顆遷出的插件都有一條呼叫它的測試**（dsh 沒有這道 gate，靠每個檔 100% 覆蓋率間接保證，`docs/testing.md:9`） |
| 插件邊界的 lint | 產品需求超出 dsh | dsh 沒有這條 lint：`.oxlintrc.json` 唯一的 `no-restricted-properties` 禁的是 `crypto.randomUUID`，而它自己的生產碼大量在用 `ctx.root`（`packages` 非測試碼 11 處）與 `internal/*`。決議 §3-4 第 12 條、grilling Q18 (c)（#1420） |
| 投影登記處的定義套件相依 `@nexus/core`（#1421 Q2 (a)） | 表達不出來，退到最接近的實作 | dsh 的 `dsh-session-projection` 相依 `dsh-session`，`SessionEvent` 在 `dsh-session`。我們的 `SessionEvent` 與 `isLogicalTurnStart` 在 `@nexus/core` 的 `session-log.ts`，抽一個 `@nexus/session` 定義套件是橫跨整個核心的一刀（Q2 (b)），這一張不做。所以 `ProjectionUnit`、`SessionEvent`、`isLogicalTurnStart` 留在 core、由定義套件單向轉出，`@nexus/core` 放定義套件的 `peerDependencies`（`devDependencies` 留 `workspace:*`，不能讓安裝結果出現第二份 core）。**這是第一個相依 core 的定義套件。** #1435 Q1 (c) 之後多一個同形狀的 `@nexus/session`（`packages/nexus-session`）：只做單向轉出，轉出的是會話日誌的四個讀法（`loggedContentBlocks`、`loggedMessageId`、`toolCallIds`、`REPEAT_REMINDER_MARKER`），`@nexus/core` 同樣放 `peerDependencies`；`ProjectionDetailError` 屬於投影，由 `@nexus/projections` 轉出。**撤除條件**（兩個套件一起）：SDK 與定義套件要發布到私有 registry 之前，把日誌讀法的實作搬進 `@nexus/session`（Q2 (b)），屆時 `SessionEvent`、`isLogicalTurnStart` 也從 `@nexus/projections` 移到 `@nexus/session`，`@nexus/projections` 改成從 `@nexus/session` 轉出，讓兩個定義套件都不再相依 `@nexus/core` |
| 投影的 provider 只收定義，不負責推動（#1421，PM 決策 2） | 表達不出來，退到最接近的實作 | dsh 的 `SessionProjectionRegistry` 自己監聽 `session/created` 與 `session/event`，逐 session 推動每一格（`session-projection/src/index.ts`）。我們把推動留在 `@nexus/core` 每條 thread 的登記處（`createProjectionFold`）：推動綁在會話日誌與 wire 的投影通道上，搬過去就是 Q2 (b) 那一刀。**撤除條件**：跟 Q2 (b) 一起做 |
| 投影：provider 這一層同 key 同 `stateVersion` 引用計數共用、`stateVersion` 不同才拒絕；每條 thread 的登記處每個 key 只收一份、重複照舊拒絕（#1421，PM 決策 1） | 照 dsh；thread 那一層是沿用的舊偏離 | provider 層照 dsh（`session-projection/src/index.ts:253-292`）：同一個套件可能掛 N 次，引用計數歸零之前一直用第一個登記者的定義，版本不同報 `refusing to share`。thread 層的重複拒絕登記在 `.docs/session-projections-design.md:95` 與 `:110`，理由是「一次組裝一張註冊表、不熱換」——這個理由對每條 thread 的登記處仍然成立，對樹上的 provider 不成立（它是行程級的，樹會熱換；重掛時新舊兩份 fiber 可能短暫重疊）。所以兩層各自的規則不同：共用的 key 由宿主（`plugin-tree.ts` 的 `#assignProjections`）只交給**這一份清單上起來了的第一個登記者**折進 thread |
| 技能來源接縫收**路徑**，不收 dsh 的提供者（`registerProvider(create)`）（#1446，demian Q1 (a)） | 遷移卡不改行為（暫時） | dsh 的 `SkillRegistry` 收 `SkillProvider { name, list, get }`，掃描與取回由提供者負責（`skill/src/index.ts:247-268`、`:390-424`）。我們收路徑、掃描留給基座的 `createSkillsMiddleware`。**理由不是「表達不出」**：nexus 已自己組裝、取代 `createDeepAgent`，skills 中介層也已用 `createMiddleware` 包過一層，照 dsh 的形狀做得到；做了就等於自寫 skills 中介層（掃描、prompt 那段、格式化都不能從基座重用），模型看到的 prompt 位元組會變。這張是遷移卡，驗收是行為不變，換成 provider 是行為變更。**撤除條件**：自寫 skills 中介層，或拿掉 deepagents 的時候；到時 provider 形狀升這個契約的 major，消費者的 `inject` 範圍擋下不相容的提供者 |
| 技能來源的路徑驗證放在提供者登記時（`@nexus/core` 的 `assertLoadableSkillsPath`），不搬進定義套件（#1446，demian Q2 (a)） | 沿用既有偏離 | 定義套件不 import core，驗證函式搬過去 core 的 registry 就得反過來 import 它。所以函式留在 core 匯出、提供者入口 import 它；core registry 那一側保留給相容層的列用，兩邊呼叫同一支函式。與 `@nexus/projections` 的 core 相依是同一條撤除條件（Q2 (b)） |
| 宿主取服務是組 thread 時的快照，dsh 的 gateway 每次呼叫讀 live（#1456 Q1） | 產品需求超出 dsh | 同下一列的快照類別。dsh 的 gateway 每次呼叫當下讀全域 store 的 `ctx.get('messageFeedback')`（`packages/api/gateway/src/index.ts:384-399`、`:874-889`），沒有快照。我們組 thread 時取一次（決議 §3-2 第 6 條「插件更新只給新對話」）：樹上 `feedback` 停了或改了，開著的對話照舊評得到、上限照舊，下一條才看到新的。**要成立的前提**是服務方法不碰 `this.ctx`（驗收 D 實測：列卸下後取到的那一份照樣能呼叫） |
| 評分與評語的兩個服務（`messageFeedback`、`sessionFeedback`）併成一個（#1456 Q3 (a)） | 遷移卡不改行為（暫時） | dsh 的 `message-feedback` 管 list／put／delete、`command-feedback` 另外提供 `sessionFeedback`（方法 `record`）（`feedback/message-feedback/src/index.ts:118-140`、`feedback/command-feedback/src/index.ts:40-41`、`:85-126`）。nexus 的 `FeedbackService` 把 `record` 併成第四個方法（#278 起如此，`feedback.ts` 與插件檔頭先前沒有登記這一條）。遷移卡的驗收是行為不變，拆成兩個服務要改 wire handler 讀兩個服務。**撤除條件**：要拆時另開卡，連同 home 變更紀錄裡 `feedback` 列 id 的遷移一起處理 |
| 評分與評語的兩顆套件（`message-feedback`、`command-feedback`）併成一顆（#1456 Q3 (a)） | 遷移卡不改行為（暫時） | 同上一列。拆成兩顆套件，列 id `feedback` 會變：使用者 home 紀錄裡指著 `feedback` 的 patch 在 `plugin-config.ts` 找不到 id 時只警告就跳過，**停用過的列會靜靜重新啟用**。**撤除條件**：同上一列 |
| 命令登記處不做 dsh 的 `ScopedLayers`、`commands/change` 通知與 `definitionId`（#1456） | 沿用既有偏離 | 理由與撤除條件在 `@nexus/core` 的 `CommandRegistrationPoint` 檔頭（一次組裝一張 registry、沒有 per-agent 遮蔽，通知與 `definitionId` 今天沒有消費者）；定義套件只轉出同一份型別 |
| 樹上那一列改了或停了，開著的對話照舊有它的投影（#1421，照 #1416 Q3 的快照語意） | 產品需求超出 dsh | dsh 在卸載時把那個 key 從活的快照拿掉（引用計數歸零就刪，`session-projection/src/index.ts:273-292`）。我們不跟：組 thread 時拿的是快照（決議 §3-2 第 6 條「插件更新只給新對話」），單元是純函式的折疊，樹上那一列卸了之後開著的對話手上的單元照樣折得動，下一條 thread 才看到新的 |
| `present` 的暫存表以身分（thread＋位址＋`callId`）當鍵，不用 `WeakMap<ToolExecution>` | 表達不出來，退到最接近的實作 | dsh 的工具執行與 `tools/result` 拿到的是**同一個物件**，所以 `WeakMap` 夠用；我們的 `exec` 每次都在 `tool-pipeline.ts` 的 `toolExecutionOf` 重建，物件身分對不上。照它的意思改用身分當鍵（#1418）。#1469 起表是行程級的一張、不在列卸載時清（壽命見上面「交付表的壽命」） |
| 答題管道是函式服務 `channelForThread`，不是 exec 上的欄位 | 表達不出來，退到最接近的實作 | dsh 的答題者從 `exec.agent` 分發；我們的答題管道是宿主服務（`channel`），不在 `exec` 上，沒有地方放「隨呼叫傳進來」的值。呼叫當下依 `callThreadId(config)` 問一支函式，回 `undefined` 退回 `channel`（#1418）。**#1458 之後 ask-user 不再用它**：token 與型別留在 `@nexus/approval-channel`，今天沒有提供者；舊外殼（測試夾具）還走這條 |
| 預設答題管道是宿主在建樹時給的一列內建列，不是 dsh 的 `session.interrupt` 事件監聽者（#1458，demian Q1 (c)） | 表達不出來，退到最接近的實作 | dsh 的答題者是 `userQuestions` 服務上的監聽者（`packages/interaction/user-questions/src/index.ts:132`），headless runner 與 webserver 各自掛自己的、依 `scopeTarget` 分發。我們沒有那個事件系統（中斷由 LangGraph 的 `interrupt()` 發、折疊器收）。退到最接近的：**進入點算出它的答題情境、建樹時交進 `approval-channel` 那一列**，ask-user 只消費。**撤除條件**：有第二種答題者要同時存在於一個行程裡（例如 serve 同時服務有人在與 headless 的連線），那時 `channelForThread` 才接上提供者 |
| `toolRefusal`／`toolCallIdOf`／`markToolError` 由 `@nexus/tool-result` 單向轉出 `@nexus/core`（#1458，demian Q4 (a)） | 表達不出來，退到最接近的實作 | dsh 的工具結果寫法在 `dsh-tool` 這一類定義套件裡，實作與型別同處。我們的實作在 `@nexus/core`（`markToolError` 與 `toolErrorOf` 共用一個 `WeakMap`，複製寫入端會靜默失效），抽出實作是橫跨核心的一刀。所以只做轉出，`@nexus/core` 放 `peerDependencies`。**撤除條件**：與 `@nexus/session`、`@nexus/projections` 同（Q2 (b)，SDK 與定義套件發布到私有 registry 之前把實作搬進定義套件） |
| 卡上寫「會話位址加上 thread 身分」，實作是另外加 `exec.thread` 與 `callThreadId`，`SessionAddress` 沒動 | **對卡上字面的改動，不是對 dsh 的偏離** | `SessionAddress` 是**一張 `SessionRegistry` 之內**的位址：每張註冊表就是一條 thread（根日誌 id 就是那條 thread 的 id、子代理日誌 id 是 `<root>/<runId>`，`session-registry.ts`），`sessionAddressKey` 只用來在那一張裡當 Map 鍵。thread 在「挑哪一張註冊表」那一步就用掉了，放進位址會在同一張表裡重複一份永遠相同的值。實測的足跡：24 個檔案提到 `SessionAddress`，原始碼與測試裡有 38 處 `kind: 'root'`、33 處 `kind: 'subagent'` 的字面比對、20 個檔案走 `toolCallSessionAddress`——加欄位要全部改，不加成可選欄位則又回到「沒填就挑不出」。而且背景子代理的 `thread_id` 本身就是 `<root>/<runId>`，已經含 `runId`，放進位址會有兩種寫法指同一個身分（`thread-id-reaches-handlers.test.ts` 量到）。所以 thread 走呼叫設定（`callThreadId`），在 `forCall` 與 `exec.thread` 用 |
| `live-model` 的 `retryPolicy.mode` 只收 `normal`，`always` 拒收（#1427） | 產品需求超出 dsh | dsh 的 `retryPolicy` 有 `normal` 與 `always` 兩種模式（`packages/llm/llm/src/retry-policy.ts:37-57`），`always` 對每一次模型請求失敗無限重試到成功、取消或卸載。我們是企業內部聊天機器人：一輪沒有盡頭，中段失敗每次都重付整個回覆，無限重試會無限重付。其餘照 dsh：`mode` 寫了就必填，`maxRetries`／`retryableCodes`／`backoff` 逐條照 `resolveRetryPolicy`／`resolveBackoff` 驗（登記在 `apps/harness/src/settings/live-model.ts` 檔頭「偏離二」）。**撤除條件**：demian 提出需要無限重試的情境 |
| `live-model` 多兩格：全機的模型請求並行上限 `maxConcurrentRequests`（預設不限）與排隊逾時 `maxWaitMs`，名額滿了**排隊**（#1505，demian 2026-10-17 全照建議拍板） | 產品需求超出 dsh | dsh 沒有任何跨 session 的模型請求並行閘或速率閘（它是一個人用自己的 key）；我們是多人共用一把 key，供應商的配額是全機共用的資源，一條失控的 thread 會讓所有人一起撞 429。形狀借 dsh 背景工作的准入（數量從現況現算、訊息寫上限與下一步、預設不限）；**排隊是 dsh 沒有的部分**，dsh 的決策紀錄明著否決過全域一桶、排隊、全域准入門控、用速率代替計數，逐條回答在 `apps/harness/src/request-gate.ts` 的檔頭（登記在 `apps/harness/src/settings/live-model.ts` 檔頭「偏離六」）。**撤除條件**：身分上線（#1428／#1429）後改成每人一桶，或 dsh 補上同類的閘 |
| 插件自我停用只在行程裡停著，不改清單、不寫檔，宣告沒變就不重掛（#1424，demian Q1 (b)） | 表達不出來，退到最接近的實作 | dsh 的 Include 把樹側的變更與插件自我停用寫回根檔，持久化靠它；我們關掉了寫回（變更紀錄是唯一的寫入口，決議 §3-5 第 18 條），所以自我停用只改記憶體。dsh 在這一點上其實也是行程內的：每次開機重寫根檔（`apps/cli/src/profile-boot.ts:152-172`），任何一次協調都會把 Include 的樹重疊一遍、把停用的列蓋回啟用（未實測的推論）。我們每條 thread 都重推一次清單，照 dsh「每次協調都蓋回」就是每條 thread 重掛一次的閃動；而「每條 thread 重讀清單」源自 #1416 Q3 (a) 的快照語意，這條偏離跟著它走。所以：宿主記下停用當時的宣告（整份，簽章輸入是列 id、模組名、設定三格，序列化用 `rowKey` 同一支 `stable-stringify.ts`），**宣告沒變就替那一列推一條 `{ id, disabled: true }` 給 Include**，不論 Include 怎麼重疊都維持停用；宣告改了或重啟才重試。紀錄多一筆只記不折的 `self-disabled`。**撤除條件**：讀清單改成不是每條 thread 都推 |
| 會話查找是行程級的服務，工具呼叫當下依 `thread_id` 從活著的註冊表挑，不是 dsh 的 `exec.agent`（#1463，demian Q1 (a)） | 表達不出來，退到最接近的實作 | dsh 的工具拿到的 `exec` 帶著 `agent`，指到它所屬的會話（工具分發點在 dsh 自己的 pipeline）。我們的工具分發點是 LangGraph 的 `ToolNode`，handler 拿到的只有呼叫設定，沒有地方塞一個宿主算好的會話。退到最接近的：**身分隨呼叫設定傳進來**（`configurable.thread_id` 與 `checkpoint_ns`，`thread-id-reaches-handlers.test.ts` 實測三種位置都到得了），宿主在樹上提供一個查找服務，呼叫當下才問、並從那一刻的活著的註冊表挑。**撤除條件**：工具分發自己握分發點（自寫 pipeline）時，把身分放進 `exec`，這個服務與 `pickSessionForCall` 一起退場 |
| `TodoItem`、`TodoStatus`、`TODO_STATUSES` 與 `todo/write` 事件的型別擴充留在 `@nexus/core`，由 `@nexus/session` 單向轉出（#1463，demian Q2 (a)） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：`TodoItem` 定義在插件自己的套件（`packages/todo/tool-todo/src/types.ts:21`），`todo/write` 的事件擴充也在同一個檔（`:28-31`），用 `declare module '@deepseek-ai/dsh-session/types'` 補進 `SessionEventMap`——型別與事件擴充都住在插件裡，插件去擴充會話套件（對讀版本 86a40220）。**我們做不到的原因**：`SessionEventMap` 在 `@nexus/core`，而遷出的插件被 #1420 的 lint 禁止 import `@nexus/core`，所以沒辦法在插件裡對它寫 `declare module`。**退到哪裡**：事件擴充搬進 core 的 `session-log.ts`，`TodoItem`、`TodoStatus`、`TODO_STATUSES` 三個名字留在 core、由 `@nexus/session` 單向轉出（消費者不能再 import `@nexus/plugin-todo` 取型別）。**撤除條件**（理由是抽出實作橫跨核心，同 Q2 (b)，不是表達不出來的原因）：與 `@nexus/session` 的其他轉出一起——SDK 與定義套件發布到私有 registry 之前把實作搬進定義套件，屆時事件擴充可回到插件側 |
| `@nexus/plugin-todo` 的 lint 排除 `src/invariant.ts`（#1463，demian Q3 (a)） | 產品需求超出 dsh | `invariant.ts` 是相容層的配套入口（`todo-invariant` 那一列），寫的是 `NexusPlugin`，import `@nexus/core` 並在模組層有 `new Set`，SDK 規則一條都過不了；把它改到綠不是機械改動（`PluginEntry` 是相容層的型別）。排除**只蓋到這一個檔**（`packages/nexus-plugin-todo/src/eslint-exclusion.test.ts` 量：`src/index.ts` 完整受管、暫存的違規檔照樣紅、同一份違規碼放在 `src/invariant.ts` 的路徑才不紅）。**撤除條件**：2026-11-03 配套入口重審——拿掉就連檔一起刪，留下就另開卡遷它 |
| fs 是呼叫當下依 thread 找回把手的查找服務，不是 dsh 的行程全域一份 `fs`＋每次呼叫傳進去的參數（#1466，demian Q2 (a)） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：`fs` 是行程全域一份的 Cordis 服務（`packages/fs/fs/src/index.ts:45-48`、`:87-90`；提供者是 `fs-local` 與 `fs-sandbox` 兩種），工具 `inject: ['fs']`（`packages/fs/tool-fs/src/index.ts:23`）後從閉包取用；每個 agent 不同的 cwd 與沙箱政策在呼叫當下當參數傳入（cwd：`session-cwd.ts:23` 的 `ctx.workingDirectory.ensure(exec.agent, …)`；政策：`write.ts:117-124` 的 `sandbox.resolvePolicy` 結果當 `writeText` 的參數；對讀版本 86a40220）。**我們做不到的原因**：我們每條 thread 的 backend 是 deepagents 的 `CompositeBackend`，路由（會話歷史、工具結果暫存、附件、plugin 的 `backend.mount()`）與 fence 都綁在每次組裝新建的物件上，沒有「同一個 fs、換參數」的介面；拆成「全域 fs＋每次呼叫的政策參數」等於重寫整層 backend，遷移卡做不到（#1466 Q2 (c)）。**退到哪裡**：呼叫當下依 `thread_id` 從行程級的登記表找回那條 thread 自己的把手（同 #1463 的會話查找，同一張登記表、同一支挑法）。**撤除條件**：backend 改成「全域一份＋呼叫時帶政策」之後，這個服務退場，消費者改 `inject` 全域 `fs` |
| `FsService`、`SessionAddress` 留在 `@nexus/core`，由 `@nexus/fs` 單向轉出型別（#1466，demian Q2-1 (a)） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：`fs` 的服務類別與型別在 `dsh-fs` 這個定義套件裡，實作與型別同處（`packages/fs/fs/src/index.ts`，對讀版本 86a40220）。**我們做不到的原因**：`createFsService`／`settleFsService` 綁著 `foldRegistry` 的 fold 與 `@nexus/core` 的 host-services（填值的那一半只在 core 模組裡，消費者手上的把手只讀不能改），抽出實作是橫跨核心的一刀（#1421 Q2 (b)）。**退到哪裡**：只轉出型別，`@nexus/core` 放 `peerDependencies`。**撤除條件**：與 `@nexus/session`、`@nexus/projections` 同（Q2 (b)） |
| 核准閘門是 `tools` 服務上的方法 `gate(listener)`，不是 dsh 的 `ctx.on('tools/pre-execute')` 事件（#1466，demian Q1 (a)） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：核准是 `tools` 服務發的 waterfall 事件，任何插件 `ctx.on('tools/pre-execute', …)` 註冊，鏈底 `allow`（`packages/core/tools/src/index.ts:1512-1516`、決定三格 `PreToolDecision` 同檔；對讀版本 86a40220）。**我們做不到的原因**：樹上沒有事件匯流排的 token，而核准也不搬上匯流排（demian 2026-10-09 決議）；我們的核准是 LangGraph 中介層（`nexusApprovalGate`）從每條 thread 自己的 `registry.approvals` 讀，樹上的列拿不到那張表。**退到哪裡**：`tools` 服務 `1.2.0` 的選配方法 `gate(listener)`，宿主把那一列登記的 listener 折進每條 thread 的 `registry.approvals`（來源仍是那一列的名字）。**撤除條件**：核准搬上事件匯流排時，這個方法退場、消費者改成 `ctx.on` |
| `tools/result` 觀察者是 `tools` 服務上的方法 `onResult(listener)`，不是 dsh 的 `ctx.on('tools/result')` 事件（#1469，demian Q1 (a)） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：`tool-present` 用 `ctx.on('tools/result', …)` 取出等著的那一筆再寫交付（`packages/deliverables/tool-present/src/index.ts:100-108`；對讀版本 86a40220）。**我們做不到的原因**：樹上沒有事件匯流排的 token（同核准閘門那一列），而 `tools/result` 由核心圍堵在每條 thread 自己的 `registry.events` 上派發，樹上的列拿不到那張表。**退到哪裡**：`tools` 服務 `1.3.0` 的選配方法 `onResult(listener)`，宿主把那一列登記的 listener 折進每條 thread 的 `registry.events.on('tools/result', …)`，派發時機與次序不變。**撤除條件**：事件匯流排上樹時，這個方法退場、消費者改成 `ctx.on` |
| `PresentedFile` 由 `@nexus/session` 轉出、`deliverables/presented` 的事件擴充搬進 core 的 `session-log.ts`（#1469，demian Q4 (a)） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：型別與事件擴充都在插件自己的 `src/types.ts`，用 `declare module` 補進 `SessionEventMap`（`packages/deliverables/tool-present/src/types.ts:12-17`；對讀版本 86a40220）。**我們做不到的原因**：`SessionEventMap` 在 `@nexus/core`，遷出的插件被 #1420 的 lint 禁止 import core，無法對它寫 `declare module`；宿主（wire、web 的事件讀端、`conversation-history`）又要不經插件就讀到這份型別。**退到哪裡**：同 `todo/write`——事件擴充進 core、型別由 `@nexus/session` 單向轉出，宿主那三處 `import type {} from '@nexus/plugin-present'` 拿掉。**撤除條件**：同 `todo/write` 那一列（Q2 (b)） |
| fs 把手帶 `hasWorkspace()` 與併了 mounts 的 `offWorkspacePrefixes()`（#1469，demian Q2 (a)） | 產品需求超出 dsh | dsh 的 `tool-present` 沒有「工作區」與「掛載前綴」的概念（`src` 裡 grep `workspace\|sandbox\|mount\|capabilit`：0 筆；對讀版本 86a40220）。我們的 backend 是一顆複合 backend，會話歷史、工具結果暫存、附件與 plugin 掛的路由都不在工作區磁碟上，交付的讀端只認磁碟（#951），所以「有沒有工作區」與「哪些前綴不在磁碟」是 present 的前提。**放在 fs 把手上**（不放在插件裡自己再算一次）：算法只有一處，`settleFsService` 在 fold 填 backend 的同一處算 |
| `@nexus/plugin-present` 的 lint 排除 `src/invariant.ts`（#1469，demian Q5，照 #1463 Q3 (a)） | 產品需求超出 dsh | 理由、量法與撤除條件同 `@nexus/plugin-todo` 那一列：`invariant.ts` 是相容層的配套入口（`present-invariant` 那一列），寫的是 `NexusPlugin`；排除只蓋到這一個檔（`packages/nexus-plugin-present/src/eslint-exclusion.test.ts`）。**撤除條件**：2026-11-03 配套入口重審 |
| `agent/pre-step` 只能追加訊息，沒有 `reject`，也沒有「留到下一步」（#1474，demian Q1 (a)） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：waterfall，listener 收 `next()`、拿到這一步的決定（`enter`／`reject`）後可以 splice 進批次的任何位置、可以 `reject` 整步（`packages/core/agent-loop/src/agent.ts:267-288`、`runtime-types.ts:309-320`（`agent/pre-step` 的說明與簽名；`:321` 起是 `agent/request`））；`agent-instructions` 遇到 `reject`、或第 1 步批次是空的就不 splice，把基線留在收件匣等下一步（`packages/context/agent-instructions/src/index.ts:345`）。**我們做不到的原因**：載體是 middleware 的 `beforeAgent`，只能回要追加的訊息（`interception-index.test.ts` 第 2 列 `permissionDelta`），拿不到整個批次，也沒有收件匣。**退到哪裡**：`@nexus/agent-loop` 的 `preStep` 只追加，位置由基座決定（今天落在使用者那一句之後，與 dsh 同位）。**撤除條件**：#389 重開，或 core 開了讓多個貢獻者共用一格的 pre-step 節點 |
| `agent/pre-step` 每次 invoke 跑一次，不是每一步（#1474，沿用 #389 的拍板） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：每個 step 一次——`preStep()` 在迴圈裡每一步被叫（`packages/core/agent-loop/src/agent.ts:318` 呼叫、`:267-288` 實作；對讀版本 86a40220）。**我們做不到的原因**：每一步要 `beforeModel`，它是圖裡的節點，預設上限 100 下每輪多一格＝33 輪變 24 輪（#389 triage 實測）；#389 拍板每一步的那一半先不做。**退到哪裡**：`beforeAgent`，每次 invoke 一格、每輪零格（100 下 32 輪，有沒有 `--workspace` 都一樣）。名字叫 `preStep` 而不叫 `beforeInvoke`：#389 重開時名字不必改。**撤除條件**：同上一列 |
| listener 收到的是「模型看得到的那一串」與 `{ configurable }`，不是 dsh 的「這一步領出來的批次」與 `agent`（#1474，demian Q1-1 (a)） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：listener 收 `{ agent, messages, turn, step, signal }`（簽名在 `runtime-types.ts:320`），`messages` 是這一步從收件匣領出來的批次（`runtime-types.ts:313`）。**我們做不到的原因**：沒有收件匣，訊息批次在圖的 state 裡；沒有 `agent` 物件，這次呼叫屬於哪條 thread 由呼叫設定認。**退到哪裡**：`effectiveMessages`（摘要之後是 `[summary, ...切點之後]`）加 `{ configurable }`。**撤除條件**：同第一列 |
| `user/message` 在注入當下記，不是 dsh 的「請求被接受的第一次嘗試」才記（#1474，demian Q2 (a)） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：由 agent loop 在請求被接受的第一次嘗試記（`packages/core/agent-loop/src/agent.ts:426-436`，`if (firstAttempt)` 底下；對讀版本 86a40220），插件不寫日誌。**我們做不到的原因**：`beforeAgent` 在請求之前就跑，看不到「這一步是不是第一次嘗試」。重試是模型呼叫那一層的事（`retryModelCall`），不會重跑 `beforeAgent`，所以同一次 invoke 不會因重試記兩筆。**退到哪裡**：宿主在回傳 `{ messages }` 之前經這條 thread 自己的 `registry.sessions.forCall` 記；插件一樣不寫日誌。**撤除條件**：同第一列 |
| agent-instructions 把 `fs` 放進 `inject`（必填，`^1.1.0`），不是 dsh 的選配 `ctx.get('fs')`（#1474，demian Q3 (a)） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：`inject = ['sessionProjections', 'workingDirectory']`，`ctx.get('fs')` 拿不到就返回（`packages/context/agent-instructions/src/index.ts:36`、`:121-127`；對讀版本 86a40220）。**我們做不到的原因**：要在 `apply` 當下就把服務抓進閉包——沒有樹的路徑上插件被 `mountDetached` 掛一次就卸載，呼叫當下才經 `ctx` 取服務會拋；而不經 `inject` 的選用服務在 `apply` 當下沒有次序保證，`fs` 那一列還沒提供就會永遠拿到 `undefined`，基線靜靜消失。**退到哪裡**：`fs` 必填；它是宿主內建列、永遠先起來，不會讓清單上的這一列多掉一種原因。查找不是 `ok`、或 `backend()` 是 `undefined` 就不注入，等於 dsh 拿不到提供方時直接返回。**撤除條件**：選配服務有次序保證時 |
| `systemPrompt` 只組頭尾兩段，不是整份提示詞（#1477，偏離登記第 1 列） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：整份提示詞由 `assemble` 組（`packages/core/system-prompt/src/index.ts`，對讀版本 86a40220）。**我們做不到的原因**：基座（deepagents）自己組它的提示詞，它的段不經我們的服務。**退到哪裡**：只組身分句＋前綴（前）與後綴（後），中間是基座與相容層 middleware 已經組好的。**撤除條件**：基座提示詞可以由服務組裝，或中間段的規則有第一個消費者（`plan-mode`／`sandbox-policy`）時 |
| 宿主取的是組 thread 時的快照，每次模型呼叫只代入變數，不是 dsh 的每一步 `assemble`（#1477，第 4 列） | 產品需求超出 dsh | dsh 每一步重新 `assemble`，段的增減即時生效。我們照決議 §3-2 第 6 條「插件更新只給新對話」：組 thread 時 `assemble()` 一次取純資料快照；若每次呼叫都問活服務，合法地改一次這一列（`next-thread`），舊列卸載、段被撤，開著的 thread 下一次呼叫就靜靜少了身分與 persona。`system-prompt-on-tree.test.ts` 的 D2 釘住 |
| `variable(name)` 只登記名字，值由宿主每次模型呼叫交（#1477，第 6 列，PM 更正） | 表達不出來，退到最接近的實作 | dsh 的 `variable(name, provider)` 每次 `assemble` 求值，`model`／`provider` 由 agent loop 登記。我們要 `{{model}}` 跟著那一步實際用的模型走（#723），組 thread 時求值就定死了。**`model` 名字目前由這一列登記**：日後 `@nexus/agent-loop` 若照 dsh 再登記同名 `model`，同服務內重名當場拋；到時把登記搬去 agent loop 那一列、這一列改成只讀（登記只有一行） |
| 設定三格，不是 dsh 的五格（#1477，第 7 列） | 遷移卡不改行為（暫時） | dsh 另有 `includeRuntimeContext`、`toolOrder`，管執行期上下文與工具段，第一刀沒有消費者。**撤除條件**：需要時另開卡 |
| `{{cwd}}` 是我們多的變數（#1477，第 8 列） | 產品需求超出 dsh | dsh 沒有 `cwd` 變數（dsh 只覆寫前綴：web-app :17-20、headless :11、acp-app :5、sdk-minimal :118）；我們的出貨後綴引用了 `{{cwd}}`，要不要拿掉不在這張卡。舊註解對 dsh 的引用有誤，已更正（插件檔頭與 `cordis.yml`） |
| 掛載當下驗前後綴的語法與名字，不是渲染時才拋；訊息是中文（#1477，第 9 列） | 表達不出來，退到最接近的實作 | dsh 渲染時才嚴格插值、才拋，每一輪都紅，壞掉的設定不可能被忽略。我們的載入器把 `apply` 拋的錯變成「那一列掉了」，所以在掛載當下驗，並把這一列留在必掛名單（`startup-audit.ts`）。D 的失敗變成：同一類錯、同一列、同一格、同一個變數名，外層由「組裝失敗」變成「起不來」，CLI 的失敗時刻提早到 `cli.ts:953`（讀清單那一次） |
| `section()` 只收字串 `text`，order 落在前綴與後綴之間的、帶 `complete`／`interpolate` 的登記當場拋（#1477，第 5、10 列） | 遷移卡不改行為（暫時） | dsh 的 `text` 可以是函式、`PromptSection` 另有 `complete`／`interpolate`、order 任意。快照要完整，中間段的渲染規則留給第一個用到的遷移卡。大聲拒絕，不靜靜丟掉 |
| goal 的持久狀態由服務自己折疊（訂閱日誌），不走 `sessionProjections` 的投影（#1486，demian Q1 (a)） | 表達不出來，退到最接近的實作 | **dsh 怎麼做**：`goal` 登記成投影，持久狀態由註冊表的事件驅動維護，服務用 `stateOf(session, 'goal')` 讀（`packages/goal/goal/src/index.ts:258`、`:476-481`；對讀版本 86a40220）；行程內那一半（授權、等待掛上的那一格）放在 `WeakMap<Session, GoalRuntimeState>`（`:248`、`:484-493`）。**我們做不到的原因**：`@nexus/projections` 今天只有給 wire 的 `register`，沒有插件讀狀態的 `stateOf(log, key)`（`nexus-projections/src/index.ts:44-56`）；補上它是一個新接縫，這張卡是搬家，不加接縫。**退到哪裡**：保留遷移前的做法（狀態不走投影註冊表，`service.ts` 檔頭）——折疊住在服務裡，建構子重放加訂閱。行程內那一半與 dsh 同形（逐份日誌的 `WeakMap`）。**撤除條件**：投影的讀法（`stateOf`）另開卡，goal 可改走它 |
| `GoalView`、折疊與提示詞渲染由 `@nexus/goal` 提供，事件與快照型別轉出自 `@nexus/core`（#1486，demian Q4 (a)） | 表達不出來，退到最接近的實作 | dsh 的型別與純函式住在 `goal` 定義套件（`packages/goal/goal/src/types.ts`，對讀版本 86a40220）。我們的 `goal/change` 事件與 `GoalSnapshot` 等型別在 `@nexus/core`，折疊與提示詞渲染搬進 `@nexus/goal`（宿主要用），`core` 放 `peerDependencies`。`hasDirectHumanTurn` 只有工具與命令用，留在插件 |
| `AttachmentRef` 由 `@nexus/commands` 轉出、`SessionEventMap` 由 `@nexus/session` 轉出，`goal/change` 的事件擴充搬進 core 的 `session-log.ts`（#1486） | 表達不出來，退到最接近的實作 | 同 `PresentedFile`（#1469）那一列：`SessionEventMap` 在 `@nexus/core`，遷出的插件不能 `declare module` 補它（#1420 的 lint 擋 `@nexus/core` import）。轉出是單向的，`core` 放 `peerDependencies` |
| `@nexus/plugin-goal` 的 lint 排除 `src/invariant.ts`（#1486，demian Q5，照 #1463 Q3 (a)） | 產品需求超出 dsh | 理由、量法與撤除條件同 `@nexus/plugin-todo` 那一列：`invariant.ts` 是相容層的配套入口（`goal-invariant` 那一列），寫的是 `NexusPlugin`；排除只蓋到這一個檔（`packages/nexus-plugin-goal/src/eslint-exclusion.test.ts`）。**撤除條件**：2026-11-03 配套入口重審 |
| 命令的「忙的時候放行」是宣告出來的資料（`CommandDefinition.runWhileBusy`，字面值清單），dsh 沒有這一格（#1516，demian 經 PM 認可） | 產品需求超出 dsh | **dsh 怎麼做**：命令沒有「跑著能不能執行」的閘門，（`packages/interaction/commands/src` 裡沒有 busy／running 的判斷）。**我們的閘門是 #123 的前提**：斜線命令一定跑在兩輪之間，所以 `/plan`、`/goal <目標>` 這類會改狀態的命令跑著時被擋。dsh 的暫停鈕（`goal-round-driver/src/index.ts:302-312`）跑著時當場中止，這件事我們需要放行**一個**呼叫（`/goal pause`），但不能放寬整個閘門。**為什麼是資料**：一個函式或整個命令的布林讓「哪些呼叫放行」散在 handler 裡、`slash.list` 讀不到；字面值清單讓閘門與 web 讀同一份。**撤除條件**：dsh 日後有同義的閘門，改讀那一份 |
| 服務是查找時才建（lazy），`/goal` 的「一份都沒接」「接了不只一份」兩句拿掉（#1486，demian Q1 (a)、Q2 (a)） | 行為改變（這張卡唯一承認的一條） | 完整說明在 PR 內文的「行為改變」一節；這裡只記來龍去脈。遷移前每份會話裝一次參與者、registry 只能接一份 root 日誌，所以 `/goal` 要先問「接了幾份」；lazy 之後命令帶來的 `sessionLog` 就是它要動的那一份，兩句失去生產者。工具層的「不是 root」那句保留（逐字不變）。同一個 registry 想接幾份日誌都行 |
| 權限組合的目錄是逐條 thread 的，dsh 整台共用（#1491，登記第 1 列） | 遷移卡不改行為（暫時） | dsh 的 `catalog()` 預設組只從設定或行程預設推（`packages/interaction/permission-presets/src/index.ts:293-299`）；我們今天的預設組是這條 thread 的起始值推出來的（續接的 thread 沒設 `defaultPreset` 時是日誌記著的那一組），wire 的 `permission.catalog` 逐條 thread 回。照 dsh 做會讓新會話的日誌多一顆 `sandbox/mode`、續接的目錄預設組變動，都是行為改變。撤除條件：之後的權限卡定 |
| 子代理的組名由會話參與者寫，不是委派那一側寫（#1491 Q2-1，登記第 2 列） | 表達不出來，退到最接近的實作 | dsh 在委派側寫（`packages/subagent/subagent/src/child-agent.ts:248-279`）。委派那一刻拍下沙箱那一格靠包住 `task` 的 `wrapToolCall` 與 ALS（`sandbox-policy`），樹上沒有包工具呼叫的接縫。撤除條件：`sandbox-policy` 遷上樹時一起做 |
| 會話參與者安裝失敗只記 warn、已寫的收不回（#1491，R3，登記第 3 列） | 表達不出來，退到最接近的實作 | dsh 的 `session/created` listener 同步拋錯會否決並回滾這次接上（`core/session/src/index.ts:1258-1286`）；相容層的七位會話參與者本來就是記 warn 的語意，`join` 沿用。撤除條件：會話註冊表能在參與者拋錯時回滾這次接上（`registry.sessions` 與 `join` 一起改，連同相容層其餘的參與者同一天換） |
| 起始值在宿主的組 thread 那一步算，不在參與者裡套（#1491 Q3 (a)，登記第 4 列） | 遷移卡不改行為（暫時） | dsh 在 `session/created` 上整組套預設；我們把「算出預設組」放進 `permissionPresets.start`（純函式），宿主據回傳值靜默切兩顆控制器，之後參與者才釘組名，新會話的日誌只有一顆 `sandbox/mode`、順序逐字不變。撤除條件：兩顆控制器整個拿掉、fence 與閘門改讀日誌投影（#1491 Q1 (c)）時，宿主不再靜默切控制器，起始值就能直接由參與者往日誌套 |
| `/permission` 切換核准政策時不對模型注入一則使用者訊息（#1491，登記第 5 列） | 遷移卡不改行為（暫時） | dsh 的 `user-approval` 在政策變動時 `agent.inject` 一則「The approval policy changed from … to …」給下一步模型（`packages/interaction/user-approval/src/index.ts:184-187`，`687f282e`）；我們的 `/permission` 從相容層起就沒有這一步，這張不改行為。撤除條件：之後的權限卡決定要不要補（補了是行為改變，自己一張卡） |
| `/permission` 的回覆拿掉「這次切換沒有完整記進日誌」那一句（#1491 Q1 (a)，demian 拍板） | 行為改變（這張卡承認的一條） | 兩顆旋鈕現在以日誌為準，切換就是往 root 日誌追加，這句失去生產者（`UNRECORDED_NOTE` 拿掉）。**失敗方向反過來**：以前「日誌沒接上」時切換仍然生效、只是沒留痕跡，所以要提示；現在日誌記了切換、控制器卻沒訂閱日誌時，fence 與閘門**不動**，而且沒有任何提示（兩顆控制器訂閱 root 日誌是 #1494 守的，這張的單元測試不重複）。完整說明在 PR #1727 內文的「行為改變」一節 |
| 續接時日誌記的沙箱比表裡每一組都寬就收回預設組（#1621 第 2 步，插件檔頭第 9 條） | 理由 2：產品需求超出 dsh 的射程 | dsh 續接照日誌裡的值，表怎麼變都不動它；我們出廠表拿掉全開（偏離 #1621 第 1 步）之後，升級前已經切到全開的會話不收就永遠留著表裡不存在的全開。收的條件只有「比每一組都寬」，目標是 `defaultPreset`，沒設是表裡檔案政策最寬的一組。冷復活的背景子代理讀回的委派快照不在這一列，見下一列。不照 dsh 的 `inferredDefault`（`permission-presets/src/index.ts:222-231`）是理由 1：參與者拿不到行程的 `--sandbox`、沒有 thread 鍵，只有 `--sandbox read-only` 起動且沒設 `defaultPreset` 那一格結果不同（dsh 收到 `read-only`，這裡收到 `workspace-write`）；dsh 對照點 `:446-455`（續接保留日誌值）、前例 `:431-436`。撤除條件：沒有 |
| 冷復活的背景子代理讀回的委派沙箱比表裡每一組都寬，這一輪就收回預設組（#1739，插件檔頭第 10 條；`@nexus/permission-presets` 1.2.0 的 `narrowDelegated`） | 理由 2：產品需求超出 dsh 的射程（同 #1621） | dsh 的表也是部署方可設的，全開只是預設值（`permission-presets/src/index.ts:158-166`、`:183-195`），部署方拿掉全開之後既有子代理的快照一樣可以比表寬；dsh 的答案是取消再重派（`2026-07-25-subagent-policy-inheritance.md:34`「cancel-and-respawn picks up a tightening」），冷復活只重播持久化的委派政策事件（`subagent/subagent/src/manager.ts:881-882`，`687f282e`），fence 取 session 自己的 override（`sandbox/sandbox-policy/src/index.ts:164-168`）。我們共用一台主機：改表的人看不到別人的會話，改表就是要對整台生效，沒有人能逐一取消重派，所以改成讀回時收。做法：宿主在 `SandboxModeController.delegateFromLog` 讀回時過 `narrowDelegated`（純函式，條件與目標同上一列）；只收這一輪實際用的那一格，**不寫子代理日誌**（日誌仍記委派當時那一格，代價是日誌與實際行為不一致）；核准照舊釘 `never`；同步子代理不在內。不看父代理即時狀態是照 dsh。撤除條件：`sandbox-policy` 遷上樹、fence 改讀投影的時候（可改成直接寫日誌） |

## 接進清單（#1416 PR 2）

`echo` 是第一顆遷上樹的插件，`token-meter` 是第二顆（#1421），`trajectory` 是第三顆（#1435，只換接縫的使用者，沒有新接縫），`skills` 是第四顆（#1446，新增技能來源接縫），`feedback` 是第五顆（#1456，新增命令接縫與第一個插件提供、宿主消費的服務），`ask-user` 是第六顆（#1458，新增預設答題管道接縫與工具登記選項），`todo` 是第七顆（#1463，新增會話查找接縫），`submit-record` 是第八顆（#1466，新增 fs 查找接縫與 `tools` 1.2.0 的核准閘門），`present` 是第九顆（#1469，新增 `tools/result` 觀察者與 fs 把手上的工作區事實），`agent-instructions` 是第十顆（#1474，新增 `agent/pre-step` 接縫），`system-prompt` 是第十一顆（#1477，第二個插件提供、宿主消費的服務：`systemPrompt` 快照），`goal` 是第十二顆（#1486，第三個插件提供、宿主消費的服務：`goals` 查找表，服務查找時才建），`time-context` 是第十三顆（#1625，`agent/pre-step` 的第二位消費者，沒有新接縫：同一個 `agentLoop` 登記 listener、同一個 `sessionLookup` 讀這條 thread 的日誌；排在 `agent-instructions` 正下方，同一次 invoke 裡讀數在 AGENTS.md 基線之後），`permission-presets` 是第十四顆（#1491，第四個插件提供、宿主消費的服務：`permissionPresets`，加上會話參與者接縫 `sessionLookup.join` 與 `@nexus/fs` 的 `workspaceRoot()`；兩顆旋鈕改成以日誌為準）。清單（`cordis.yml`、home 的變更紀錄、`--patch`）仍由相容層的 `loadPluginConfig` 讀、疊、驗，
**樹那一側不是第二份清單，是清單的一個消費者**：

| 東西 | 在哪 | 做什麼 |
| --- | --- | --- |
| 載入器的分辨 | `plugin-config.ts` 的 `resolveEntryModule` | 模組有 `manifest` 具名匯出就是函式插件，走 `validateManifest`；沒有就照舊是 `NexusPlugin`。判別式只有一個（`plugin-tree.ts` 的 `isFunctionPluginModule`），Include 的允許名單也從它算 |
| 橋接列 | `plugin-config.ts` 的 `isBridgeEntry` | 函式插件在相容層清單上的代表：同一個 id、同一個位置、`Config` 是 manifest 的 `config`，所以設定驗證、停用、補號、快照、會話 header 都照舊。它的 `apply` 不自己掛任何東西，只把**登記者是這一列**的工具、投影單元、技能來源路徑與命令，加上**這一列提供**的服務，折進這一條 thread 的 registry（每一種接縫一格，見下） |
| 樹 | `plugin-tree.ts` 的 `PluginTree` | `tools` 一列（工具登記處）、`projections` 一列（投影登記處）、`skill-sources` 一列（技能來源登記處）、`commands` 一列（命令登記處）、`approval-channel` 一列（預設答題管道，值是進入點在建樹時給的，#1458）、`session-lookup` 一列（會話查找，行程級的活著的 thread 註冊簿，#1463）、`fs` 一列（fs 查找，同一張登記簿帶 fs 把手，**列在必掛名單**，#1466）、`include` 一列（Include 讀出貨的 `cordis.yml`、疊 patch），函式插件在 `include:<id>` |

- **變更紀錄怎麼到樹上**：折出來的 patch 原樣經 `entry.update({ config: { ...includeConfig, patches } })` 推給 Include（dsh
  `app-boot` 的做法）。**Include 不寫回任何檔**——寫入口只有變更紀錄一個（`vendor/README.md` 第 7 條，上游三條寫回路徑全關）；Loader 上游會在安裝樹建 `.cordis/` 輔助檔，宿主給了解析函式就不建（第 9 條），所以安裝樹唯讀也不影響掛載。
- **兩支疊 patch 的演算法**：相容層的 `applyEntryPatches` 與上游的 `applyPatches` 對下面五種操作疊出一樣的 id／name／
  disabled／config 與順序（停用、啟用、改設定、還原設定、`--patch` 改與插入；`echo-on-tree-edges.test.ts`）。已知的差別是
  帶 `id` 的 `insert`（相容層接到尾巴，上游往群組裡塞），推給樹的 patch 把那個 `id` 拿掉，兩邊就一致。每次同步還會比一次
  樹上那一列的 `disabled` 與 `config` 跟相容層疊出來的是否相同，不同那一列算掉了，不靜靜地各走各的。
- **樹上的結果怎麼對回清單上的掉列**：樹上那一列 FAILED 或缺席是 `apply` 階段、PENDING（缺服務、契約不相容）是 `requires`
  階段，在**讀清單那一步**就判定（以前 echo 重名要到組裝那一刻才掉）。契約不相容的訊息帶消費者列 id（樹上的 `include:<id>`）。
- **橋接列折入多種接縫（#1421、#1446、#1456、#1458、#1466）**：`RowVerdict` 的 `active` 帶每一種接縫的貢獻（`tools`、`toolOptions`、`gates`、`projections`、`skillSources`、`commands`、`services`），橋接列的 `apply` 把
  來源是那一列的各自折進這條 thread 的 registry：工具走 `registry.tools.register`（**帶它登記時的 `rootOnly`／`outputSchema` 選項**，#1458），核准閘門走 `registry.approvals.gate`（**來源是那一列的名字**，#1466，照登記順序），投影單元走 `registry.projections.register`，
  技能來源走 `registry.skills.addSource`（**照那一列登記的順序**：`sources` 依序即優先序，後面的來源贏過前面的同名 skill），
  命令走 `registry.commands.register`（照登記順序），**那一列提供的服務**走 `registry.services.provide`。
  同一個投影 key 由兩列共用時，只交給其中一列（見偏離表），這條 thread 的登記處才不會撞上它自己的重複拒絕；技能來源不共用，
  每條路徑只屬於一列。
- **加一個新接縫要動哪幾處**：(1) 定義套件（token、介面、契約版本，`@nexus/*` 但不放 `@nexus/plugin-*`）與提供者
  （`<定義>/provider`，`createXxxProvider()` 回 `{ Provider, entries(), … }`）；(2) `plugin-tree.ts`：掛一列內建列
  （`PluginTree.#build` 與 `mountDetached` 兩處）、`RowVerdict.active` 多一格、`#snapshot` 把登記處的 `entries()` 分給列；
  (3) `startup-audit.ts` 的 `REQUIRED_TREE_ENTRY_IDS` 加上那一列的 id（它起不來，函式插件沒有地方掛）；
  (4) `plugin-config.ts` 的 `FoldedContributions` 與 `registerFolded` 多一格，折進 registry 的對應通道；
  (5) 一致性套件的 `residue` 由消費者的測試指到提供者的登記筆數（`registrations()`），而且要掛上後比掛上前多；
  (6) `.github/scripts/plan_ci.py` 的 `FULL_RES` 加上新的定義套件（遷出的插件都相依它，改了就不能只跑改動的那幾顆插件）。
- **設定帶 `__jsExpr` 整份拒絕**：Loader 的 `interpolate` 會把它當 JavaScript `eval`。相容層讀清單時掃走橋接那幾列的最終
  `config`（寫入前驗證走同一條，所以寫入口當場擋下，不會把一條讓之後每次啟動都失敗的東西寫進紀錄），推上樹之前再掃一遍
  整份 patch 當後盾。第三道在 vendor 的 Include（`vendor/README.md` 本地修改第 11 條，#1461）：它讀完出貨檔、疊完 patch、
  交給 Loader 之前，掃那份真正會被 eval 的樹，有就整份拒絕（`PluginTree.sync` 報成 `PluginTreeError`）。rc.11 起 Loader
  連 `disabled` 都會 eval，而出貨檔那一列不經 patch，前兩道看不到它。
- **沒有樹的呼叫端**（手搭 `PluginEntry` 清單的測試、基準任務、`shippedPlugins()`）：橋接列在組裝時單獨掛一次、取工具、
  投影單元、技能來源路徑、命令與提供的服務、立刻卸載，走的是同一個 Loader 與 `tools`、`projections`、`skill-sources`、`commands` 提供者。產品路徑（`cli.ts`、`serve.ts`）不走這條。
  會話查找那一列在這條路上看的是**那一次組裝自己的** `registry.sessions`（#1463），所以工具在 `attachSession` 之後才綁上來的註冊表也問得到。
  `fs` 那一列同理（#1466）：看的是**那一次組裝自己的** `fs` 服務（`registry-fs-lookup.ts`，**每次呼叫都讀**，所以提供它的那一列排前排後一樣），
  不依 `thread_id` 挑——一份無樹組裝只有一個 backend，沒有別的 thread 的 fs 可以挑錯；仍要算得出位址，與樹上同一個 `unknown-caller` 判準。

### 已知限制

- **插件自我停用只在行程裡停著**（[#1424](https://github.com/DemianLi/nexus-agent/issues/1424)，demian 決議 Q1 (b)、Q2 (a)）：
  插件自己 `ctx.fiber.dispose()`，Loader 處理自我停用的那一格把那一列在樹上標成 `disabled`；Include 不寫檔，所以只改記憶體。
  Loader 在自我停用那一格的呼叫點發 `loader/self-disable`（`vendor/README.md` 第 10 條；`ctx.fiber.update()` 走的 `internal/commit`
  帶同樣的參數，所以只能在呼叫點區分），`PluginTree` 記下當時整份宣告的簽章：**宣告沒變就不再推 `epoch`、不重掛**，
  清單判成 `off`、插件列標 `disabled`（不進 `dropped`，所以沒有 `failed`），並由宿主替那一列推一條 `{ id, disabled: true }`
  給 Include——Include 每次重疊（樹上別列的設定改了、整列重建）都把每一列的 options 整份換掉，不推就會被蓋回啟用。
  宣告改了或重啟才再試一次；清單自己把它停用（`disable`）算了結，之後啟用回同一份宣告會重掛、再停用，去重鍵同，不再記一筆。
  序列化的出口是變更紀錄的 `self-disabled`（只記不折，`isAcceptedRecord` 為 false、`touchesRow` 不算碰到那一列），
  由 serve 掛在 `PluginTree.onSelfDisable` 上的記錄器寫；沒有紀錄檔就不記（閃動照樣止住，靠的是記憶體那一頭）。
  不做：`ctx.fiber.update(config)` 的持久化、非同步的自我停用窗口（記在迷霧裡）。已知的縫：必掛的列（`startup-audit.ts`
  的必掛名單）今天都在相容層；等必掛的列搬上樹之後，它自我停用會被判成 `off`，serve 缺了它還照樣起來——第一顆必掛的列
  上樹時處理（記在 #1385 的迷霧）。
- **`cordis.serve.yml` 那一層不經 Include**：Include 只有一個 `path`，serve 專屬層是相容層疊在出貨層後面的另一個檔。那一層裡的
  函式插件上不了樹，會在讀清單時掉在 `apply` 階段並指名原因；今天那一層沒有函式插件。要放進去，得讓 Include 讀多個檔或
  把那一層併進出貨檔。
- **橋接列是過渡的**：卡上寫「拿掉」，留著是因為清單上還有 `NexusPlugin` 的列（沒遷出的插件與設定列），要跟函式插件排在同一份清單、同一個順序裡
  （PM 決議 Q-A）。最後一顆搬出相容層時橋接連同整個相容層一起拿掉。這是對卡上字面的偏離，登記在這裡與 PR 內文。

## 這一刀沒有的

- **帶型別的 lint 規則**：別名繞過今天抓不到（見「lint 與 gate」的「已知的洞」），有人真的繞過再升級。
- **capabilities 的執行**：「不宣告就不給」另開一張。
- **版本路由、兩版並存、逾時**。
