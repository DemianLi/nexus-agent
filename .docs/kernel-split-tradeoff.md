# `@nexus/core` 要不要拆成容器／領域／打底 —— 取捨與決定

`@nexus/core` 一個包同時扮三個角色。dsh 把同樣的三件事拆在三處：**容器**是 vendored 的
Cordis，**領域**是 `packages/core/*`，**打底**是 `packages/bundle/base`。這份筆記回答
「我們要不要照做」，並登記決定與重新開啟這個決定的條件。

**調研日期**：2026-09-16。對讀版本：dsh `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`（master，
2026-09-15）；vendored Cordis `4.0.2`；基座 `deepagents@~1.13.1`。dsh 的 clone 在
`references/`，不進版控。

## 這份筆記的來源與可信度

| 區塊 | 來源 | 核對狀況 |
| --- | --- | --- |
| 我們這側的相依與 import 事實（§二） | 讀原始碼與 `package.json` | 第一手；每個數字都附得出指令 |
| Cordis 的相依與行數（§二、§五） | 讀 `vendor/cordis/` | 第一手 |
| dsh 的三角色規則（§五） | `references/deepseek-harness/AGENTS.md` | 第一手，逐句引用 |
| 我們過去「從 plugin 收回 core」的次數（§三） | [`plugin-architecture-gap-survey.md`](plugin-architecture-gap-survey.md) | **二手**——編號取自那份筆記，本次沒有再逐個 `gh` 核一次 |
| 取捨判斷（§三–§六） | 判斷，不是事實 | 理由逐條附出處 |

§二的每個數字都是本次實跑量的，指令記在 §七。

## 一、決定

**維持三合一，不拆。** 同時**加一條相依絆索**（§七），把「容器層沒有領域相依」這件今天靠紀律
維持的事變成會紅的測試。

理由一句話：**拆分的收益今天一個都不需要，三合一的收益每個月都在用，而拆分的成本會隨時間
漂高——絆索讓那個成本停在今天的水位。**

重開這個決定的條件在 §六，三個，任一成立就拆。

## 二、今天的事實

### 2.1 三個角色在 `@nexus/core` 裡的分布

| 角色 | dsh 放哪 | 我們放哪 |
| --- | --- | --- |
| 容器（持有 plugin、載入、回滾） | `vendor/cordis/` | `plugin.ts`／`load.ts`／`entries.ts` |
| 領域（會話日誌、工具註冊、摘要） | `packages/core/*` | `session-log.ts`／`registry.ts`／`summarization.ts` … |
| 打底（預設掛什麼） | `packages/bundle/base` | `fold.ts` |

### 2.2 容器層今天是乾淨的

`plugin.ts`／`load.ts`／`entries.ts` 的**全部** import 來源只有三種：`zod`、`./registry.js`、
`./plugin.js`。**零領域相依。**

接縫落在 `registry.ts`，而且是型別：

```ts
// packages/nexus-core/src/registry.ts:19-21
import type { StructuredTool } from '@langchain/core/tools';
import type { AnyBackendProtocol, SubAgent } from 'deepagents';
import type { ZodType } from 'zod';
```

三條都是 `import type`，編譯後抹掉，**執行期 `registry.ts` 不載入 deepagents**。

這條線不是本筆記提議的理想切法，是既有程式碼已經在守的線。**這是「拆分成本今天很低」這個
判斷的全部依據**——低到只是把三個檔案搬進另一個包，再讓它們以泛型收下 registry 介面。

### 2.3 但**包**是纏在一起的

`@nexus/core` 的 `dependencies` 有 `@langchain/core`、`@langchain/langgraph`、`deepagents`、
`langchain`、`zod`——因為 `fold.ts`、`summarization.ts`、`containment.ts` 這些領域檔真的在
執行期需要它們。

後果落在每個 plugin 身上：

```json
// packages/nexus-plugin-memory/package.json
"dependencies": { "@nexus/core": "workspace:*" }
```

`@nexus/plugin-memory` 只呼叫一次 `registry.memory.addSource(path)`，卻透過 `@nexus/core`
相依到整個 agent stack。dsh 那側一個插件只 peer 到 `@deepseek-ai/cordis`，而 Cordis 的
runtime 相依有兩個：`@standard-schema/spec` 與自家的 `cosmokit`。

**今天這不痛**：單一 repo、`workspace:*`、`private: true`、`main: src/index.ts`（不發版、沒有
build 產物）。它痛的那天見 §六第 1 條。

### 2.4 規模

| | 行數 | 測試 |
| --- | --- | --- |
| `vendor/cordis/src/*.ts` | 2,693 | （dsh 自己的） |
| `packages/nexus-core/src/*.ts` | 20,299 | 29 檔 626 tests，5.57s |

行數差 7.5 倍不是寫得囉嗦，是種類不同：Cordis 的 `description` 是
「Meta-Framework for Modern JavaScript Applications」，它不知道什麼是 agent；
`@nexus/core` 的 `index.ts` 檔頭自己寫著「這裡是純轉換層：只產出參數，不呼叫
`createDeepAgent`」——**它整個存在的理由就是產 deepagents 的參數**。

## 三、三合一的優點

**1. 改動便宜，而且這個便宜一直在被用。**

加第六條通道 `feedback`（[#278](https://github.com/DemianLi/nexus-agent/issues/278)→[#282](https://github.com/DemianLi/nexus-agent/pull/282)）：改 `registry.ts` ＋ `fold.ts` ＋
`load.ts` 的 `trackUndo` ＋ 測試，一個包、一張 PR。

更關鍵的是**收回**。調研筆記記了至少三次把東西從 plugin 收回 core：
[#252](https://github.com/DemianLi/nexus-agent/issues/252)（輸出 schema 校驗）、
[#159](https://github.com/DemianLi/nexus-agent/issues/159)（工具錯誤圍堵）、
[#142](https://github.com/DemianLi/nexus-agent/issues/142)（compaction 門檻與 subagent 射程）。
三次都是「這東西藏在選配 plugin 裡等於沒有」的同一個判斷。

在三合一裡，收回是搬檔案。在拆開的結構裡，收回是改套件邊界、相依、README、文件，再過
hygiene gate。**我們的架構還在動，三合一讓「動」幾乎免費。**

**2. 型別免費。** 15 個具名欄位直接帶完整型別。Cordis 的 `ctx.<key>` 是動態鍵，型別得靠
declaration merging 補回來，dsh 為此養了 `scripts/gen-cordis-catalog.ts` 生成器與
`verify-cordis-catalog` gate 兩套機器，外加 `@mode`／`@param` 的 JSDoc 約定。

**3. 沒有版本偏移。** `workspace:*` ＋ `private: true` ＋ 原始碼直接當 entry，沒有發版、沒有
peer 範圍、沒有 build 產物要對齊。dsh 得靠「`@deepseek-ai/cordis` 是每個 harness 套件的
peerDependency」這條約定加 `pnpm run hygiene` 守住同一件事。

## 四、三合一的缺點

**1. 容器沒辦法被獨立信任。** 回滾、id 補號、`requires` 檢查的正確性，跟摘要器、pruner、
session log 綁在同一次 `vitest run`。今天 5.57s 跑完，不痛；它變痛的那天見 §六第 3 條。

**2. 插件生態長不出 repo 外。** §2.3 那條：任何插件作者都得先吃下整個 agent stack。dsh 的
`dsh-plugin` GitHub topic 那種外部生態，在我們這個形狀下對方的成本高一個量級。

**3. 邊界靠紀律不靠編譯器。** §2.2 的乾淨今天沒有任何機制守著。沒有東西擋住誰明天在
`load.ts` 裡 import `summarization.ts`——而那一刻起，拆分從「一天」變成「先拆執行期相依」。

**這第 3 點是本筆記唯一提議動手的地方**，見 §七。

## 五、拆分要付的稅，以及一個不對稱

**稅一：泛用容器＝動態鍵＝型別要自己補。** 就是 §三第 2 點那三套機器，反過來欠。

**稅二：三角色紀律。** dsh 的 `AGENTS.md` 寫死：

> **A capability seam comprises Service Definition / Service Provider / Consumer roles.**
> It is complete, never one role; split only when roles evolve independently

加一個能力＝一次設計三個角色。我們今天加一個能力＝在 registry 上多一個欄位。

**稅三：文件同步。** dsh 每個套件都有 `README.md` ＋ `README.zh.md` ＋ `.i18n.yaml`，配
`doc-sync`、`verify-export-jsdoc`、`verify-doc-budgets` 一整排 gate。

**不對稱（這條最容易被忽略）**：**dsh 沒有付建容器的成本。** Cordis 不是 DeepSeek 寫的——
`vendor/cordis/package.json` 的 `author` 是 `Shigma`，它是 Koishi 生態的既有框架，DeepSeek
只是 vendor 進來、rescope、釘住 SHA。他們拿到的是一個成熟的通用容器。

LangChain／LangGraph 生態裡**沒有 Cordis 的對應物**。所以「拆成三個」對我們不是拆，是
**從零寫一個通用插件容器**：fiber 狀態機、服務容器、依賴就緒、事件分發、reload。那是 Cordis
那 2,693 行裡最難寫對的部分——[#356](https://github.com/DemianLi/nexus-agent/pull/356) 那次
對照已經量到 Cordis 自己在 `_unload()` 是 `Promise.all` ＋ 逐個吞錯只記 log，順序與失敗回報
兩件事都沒有保證。

**照 AGENTS.md 的偏離規則，方向也是這樣**：規則要求「現有基礎建設表達不出來才退到最接近的
實作」。它沒有要求我們把 dsh 的**套件邊界**也照抄——邊界不是實現方法，是組織方式，而我們與
dsh 在這一格的前提（有沒有現成容器可拿）不同。

## 六、重開這個決定的條件

任一成立就拆，不必再調研一次：

1. **出現第一個 repo 外的插件作者。** 那一刻 §四第 2 點從理論變成帳單。
2. **決定要換掉 deepagents。** 那時需要容器在基座換人時活下來，容器必須先獨立。
3. **容器層的測試被領域層拖到不想跑。** 今天 5.57s；超過「改一行 registry 要等一分鐘」就到了。

三個都沒發生之前，拆分是為了像 dsh 而拆，不是為了解決問題而拆。

## 七、絆索

`packages/nexus-core/src/kernel-boundary.test.ts`。兩條規則，強度不同：

- **容器層**（`plugin.ts`／`load.ts`／`entries.ts`）對領域套件**零相依，型別也不行**——它們要能
  原封搬進一個不認識 deepagents 的包。
- **接縫**（`registry.ts`）指名得了領域型別，但**只能 `import type`**——那是讓拆分成本停在
  「改 import」而不是「拆執行期相依」的原因。

只認 `import type` 這個寫法，不認 `import { type X }`：兩者編譯後等價，但絆索要看得懂，而
統一寫法的成本是一次改寫。

它**不阻止三合一**。它保證的只有一件事：**拆分這個選項不會在無人察覺時失效。**

### 驗證方式

實際跑過的指令與結果：

```sh
cd packages/nexus-core

pnpm vitest run src/kernel-boundary.test.ts   # 5 passed
pnpm typecheck                                 # 無輸出
pnpm lint                                      # 無輸出
pnpm test                                      # 29 檔 626 passed，5.57s
```

**負向也證過**（絆索的價值全在會不會紅）。臨時注入兩種違規後重跑，兩條各自失敗並指出行號：

```
× load.ts 對領域套件零相依
  → expected [ 'load.ts:11 import "deepagents"' ] to deeply equal []
× registry.ts 只用 import type 認領域套件
  → expected [ 'registry.ts:20 import "deepagents"' ] to deeply equal []
```

注入的兩行事後已還原，`git diff` 對那兩個檔為空。

**沒跑的**：repo 全量 `pnpm -r test`、`lint`、`typecheck`。這次只動一個新檔，範圍在
`@nexus/core` 之內。

### §二數字的取得方式

```sh
# 容器層的全部 import
grep -h "from '" packages/nexus-core/src/{plugin,load,entries}.ts | sort -u

# 接縫的外部 import
grep -n "from '@\|from 'deepagents'" packages/nexus-core/src/registry.ts

# 行數
cat packages/nexus-core/src/*.ts | wc -l
cat references/deepseek-harness/vendor/cordis/src/*.ts | wc -l
```

## 八、沒查清楚的

1. **§三那三次「收回」的編號是二手的**，取自 `plugin-architecture-gap-survey.md`，本次沒有再
   逐個用 `gh` 核標題。次數這個量級可信，個別編號要引用前請自己核一次。
2. **「插件作者要吃下整個 stack」的成本沒有實測。** pnpm 的 hoist 與 peer 行為可能讓實際安裝
   體積比相依圖看起來小。§六第 1 條觸發時該補一次真實量測，而不是照這份筆記的推論行事。
3. **絆索只掃靜態 import。** `await import('deepagents')` 這種動態寫法它看不到。今天容器層
   一個動態 import 都沒有，所以沒有為此加規則；真的出現了，那條規則要補在同一個檔案。
