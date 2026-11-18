# 注入源的分項預算：設計草案（#2777 的 B 半）

狀態：2026-11-16 核可（「要你決定的」四項都照建議）。B1 做完（表、算法、`context/measure.sources`，不改任何源的行為），B2 還沒開始。§4、§5 已改成 B1 實際落地的樣子。

盤點由子代理做（唯讀），下面標「核過」的是我自己再讀過原始碼的，其餘是子代理的報告、我沒有逐條核。

## 要解決的事

除了對話與工具結果，還有十幾個來源會把文字放進送給模型的請求。它們各管各的：有的有上限、超過就截斷；有的完全沒有上限；沒有一張表講誰能佔多少。總量只有摘要門檻一道，而摘要只動對話，動不了這些來源——一個 60 KB 的 `AGENTS.md` 在窗口 32,768 的模型上自己就佔掉大半，摘要救不了。

卡上要三件事：一張表、超過時整項延後並留一行指標（必帶項放不下就組裝失敗）、各源用量看得到。`agent-instructions` 是例外：它截到預算上限、通知其餘用 `read_file` 讀（〈agent-instructions 改成截斷〉）。

## 現況

| 來源 | 接在哪 | 現有上限 | 超過時 | 另一條讀全的路 |
|---|---|---|---|---|
| agent-instructions（`AGENTS.md` 等） | 尾端的一則機器訊息，每條 thread 一次 | 65,536 位元組（`packages/nexus-plugin-agent-instructions/src/index.ts:182` 的 `DEFAULT_MAX_BYTES`，核過）；單檔 1 MiB | 整份放得下的先放（最具體的先），剩下最具體的那份截到預算放得下的最長檔頭，其餘整份不放，通知行在最前面（`render.ts` 的 `renderAgentInstructions`） | `read_file` |
| skills 目錄 | system prompt | 每則描述 1,024 字元（`packages/nexus-core/src/skill-catalog.ts:121`，核過）；**總量與則數沒有上限** | 描述截斷 | `read_file` 讀 `SKILL.md` |
| `/名字` 技能叫用的正文 | 尾端的一則機器訊息，叫用那一輪 | 單檔 10 MiB，**沒有進請求的上限** | — | `read_file` |
| 記憶檔（不在出廠清單） | system prompt 最後一塊 | **沒有** | — | 讀記憶檔 |
| MCP server 的 instructions | system prompt 中段 | 每台 32,768 位元組（`packages/nexus-plugin-mcp/src/index.ts:51`，核過）；**台數與合計沒有上限** | 那一台算連線失敗 | 沒有 |
| system prompt 頭尾段、計劃模式指引 | system prompt | **沒有** | — | 沒有（部署設定） |
| 工具 schema（含 MCP 工具、子代理清單） | 請求的 `tools` | **沒有** | — | 沒有 |
| time-context、重複工具提醒、沙箱政策等固定中段 | 訊息或 system | 內容由程式產生，大小本來就有界 | — | 不需要 |
| 摘要訊息 | 訊息串最前面 | `<state>` 24,000 字元；`<index>` 條目數沒有上限 | 重生一次，仍超過就不摘要 | `history_read`／`history_search` |
| `@` 會話引用 | 使用者訊息 | `max(65536, 窗口×4×0.1)` 位元組（`apps/harness/src/session-reference-budget.ts:8`，核過） | — | 開原會話 |
| 工具結果 | 工具訊息 | 12,500 token，超過落檔留一行 | 整項移出、留指標 | 讀落檔 |

用量（#2774 的 `context/measure`）今天看不到分項：

- `messageParts.injectedTokens` 把所有機器訊息與提醒合成一格（`summarization.ts:1929-1934`，核過），分不出 agent-instructions 與 time-context。
- `systemTokens` 只算得到基底那句與 Skills；頭尾段、中段、記憶都在摘要器內層，它看不到（`packages/nexus-core/src/prompt-sections.ts:9-14`，核過）。

## dsh 怎麼做（SHA `8bd0733`）

dsh **沒有跨源的預算表，也沒有「整項延後、留指標」**。它有的是各源自己的上限：

- agent-instructions：每條鏈（使用者全域、專案）各 `maxBytes`，出廠 65,536（`packages/context/agent-instructions/src/config.ts:21-26`、`packages/bundle/base/cordis.patch.yml:307-310`，核過）。超過時先丟整份較寬的檔、再截斷最具體的那份、留一行通知；兩條鏈的預算不共用（`README.zh.md:74`，核過）。它這樣做的理由是「最具體的指示最該留」，代價是模型拿到半份檔案而且不知道後半寫什麼。
- skills 目錄：每則描述 500 字元、超過截斷加 `...`（`packages/skill/tool-skill/src/index.ts:28`、`:413`，核過）；總量沒有上限；載入的正文沒有上限。
- MCP instructions：每台 32,768 位元組，超過就拋（子代理報告，`mcp-client/src/connection.ts:55`，沒核）。
- 量測的組成只有 system／tools／messages 三格（`packages/llm/token-meter/src/projection.ts:61-68`，核過）。

所以這張不能用「照 dsh」帶過。能沿用的是：各源自己的上限值、通知行的寫法、「各源預算不共用」。

卡上另一個參照 `kiaqyn/hierarchical-attention-memory`（SHA `31a8a8c`，`scripts/hfa_manager.py:2030-2043`）2026-11-17 對過原文，與卡上寫的一致：總量超過 `context_token_budget` 時，從排在最後的召回記錄開始整筆移到 `deferred`、原因記「total context budget」，不截斷，直到不超過或記錄移完；仍超過的話，依序丟掉兩段選用的提示與一段提醒，每丟一段重量一次；還是超過就拋錯，訊息要人縮短 summary 或明確調高預算。這個 repo 不進版控，也不在本機 `references/`，讀的是那個 SHA 的單支檔。

## 別的做法

| | 做法 | 好處 | 問題 |
|---|---|---|---|
| 甲 | 現狀加一張文件表，不改行為 | 零風險 | 沒上限的源照樣沒上限；截斷照樣截斷；卡的第 2 點沒做 |
| 乙 | 一個總預算，各源照優先序搶 | 總量有保證 | 一個源變大會擠掉別的源，結果難預測、難重現；跟 dsh「預算不共用」相反 |
| 丙 | 每個源各自的上限，寫在一張表；超過時該項整項延後、留指標；必帶項超過就組裝失敗 | 每個源的行為只看它自己，可以單獨測；跟現有三個「整項移出留指標」的先例（工具結果落檔、舊圖換佔位字、instructions 的省略行）同一個形狀 | 總量只是各上限的和，不是硬保證 |

選丙。總量仍由摘要門檻管；這張補的是「摘要動不了的那些」。

## 選定的做法

### 1. 三種源

- **必帶**：沒有就不成立，模型也沒有別的路讀到。system prompt 頭尾段、計劃模式指引。內容在組裝當下就知道（部署設定）。超過上限 → `createNexusAgent` 拋錯，訊息寫出是哪一項、多大、上限多少，形狀照現有的「組裝失敗：…」（`agent-factory.ts` 的 `AssemblyDropError`）。
- **可延後**：內容來自工作區，模型有別的路讀全。agent-instructions（逐檔）、skills 目錄（逐則）、技能叫用的正文、記憶檔。大小要到 invoke 當下才知道。超過上限 → **整項不放**，原位留一行指標。
- **本來有界**：time-context、重複提醒、固定中段。表上列出、不加執行期檢查；各有一條測試釘住大小。

### 2. 上限怎麼算

單位用 **UTF-8 位元組**：便宜、確定、跟現有的鍵（`maxBytes`）與 dsh 一致。每個可延後的源：

```
上限 = min(該源的絕對上限, floor(模型窗口 × 4 × 該源的窗口比例))
```

「每 token 4 位元組」沿用 `session-reference-budget.ts` 的估法；窗口用這條 thread 下一步要走的模型。預設模型（窗口 784,369）上絕對上限生效，行為跟今天差不多；小窗口的模型上自動變小。

| 源 | 類別 | 絕對上限 | 窗口比例 | 預設模型上 | 窗口 32,768 上 |
|---|---|---|---|---|---|
| agent-instructions（整則） | 可延後，逐檔 | 65,536（現值） | 10% | 65,536 | 13,107 |
| skills 目錄（整段） | 可延後，逐則 | 32,768 | 5% | 32,768 | 6,553 |
| 技能叫用的正文 | 可延後 | 65,536 | 10% | 65,536 | 13,107 |
| 記憶檔 | 可延後 | 32,768 | 5% | 32,768 | 6,553 |
| system prompt 頭段、尾段（各自） | 必帶 | 16,384 | — | 16,384 | 16,384 |
| 計劃模式指引 | 必帶 | 16,384 | — | 16,384 | 16,384 |
| MCP instructions（每台） | 現狀 | 32,768（現值） | — | 不動 | 不動 |

這些數字除了兩個「現值」都是我訂的，**沒有量過**。必帶項不看窗口：組裝時不知道之後會換哪個模型。

### 3. 延後的樣子

指標一行，寫三件事：哪一項、多大、怎麼讀。下面是草案；實際的順序與指標原文以〈B2 實際落地的樣子〉與 `docs/operations.md` 為準。

- agent-instructions：整份放得下的先放，剩下最具體的那份截成放得下的最長檔頭，其餘整份不放；通知行三種寫法見 `docs/operations.md`〈各注入源的用量〉。
  `Workspace instruction budget 13107 bytes: truncated /AGENTS.md from 48210 to 12636 bytes; read the rest of /AGENTS.md with read_file before acting on this workspace.`
- skills 目錄：照現有順序逐則放，放不下的不列。
  `12 more skills not listed (budget 6553 bytes): list /skills with ls and read a SKILL.md with read_file.`
- 技能叫用的正文：`Skill "report" is 91200 bytes, over the 65536-byte budget: read /skills/report/SKILL.md with read_file.`
- 記憶檔：同形狀。

`agent-instructions` 放不下時怎麼辦，先前選的是整份延後（不截斷），2026-11-18 改成截斷，理由與對照見〈agent-instructions 改成截斷〉。

skills 每則描述的 1,024 字元截斷不動：那是目錄的摘要欄，正文本來就要另外讀。

### 4. 用量看得到

`context/measure` 加一個選填欄位 `sources`：這一次請求裡每個來源一筆 `{ id, bytes, limit? }`，照 `id` 排序。`limit` 只有表上有、而且不是「每台」那一類的來源才帶。`deferred` 等 B2 真的會延後時再加。

怎麼收：

- **system prompt 上的源**（頭尾段、中段各段、記憶、Skills 目錄）：`SystemPromptPiece` 多一格選填的 `source`，`systemPromptWrapWith` 在放進請求的當下回報 `{ id, bytes }`。摘要器在叫內層的那一段開一個收集器（`AsyncLocalStorage`），內層的源直接報進去；同一個 `id` 後寫的蓋掉先寫的（串流重試會把內層重跑一次）。
- **root 的 Skills 目錄在摘要器外層**（`agent-assembly.ts:451-478`，核過；子代理的 Skills 在內層）：它回報時收集器還沒開，改成把回報掛在往下傳的請求上（一個 symbol 鍵），摘要器開收集器時當種子。
- **訊息上的源**（agent-instructions、技能叫用的正文）：摘要器從送出的訊息認，靠訊息上已有的 `nexus_source`。
- 中段各段用段名當 `id`（`plan:policy`、`mcp:servers`、`sandbox:policy`、`nexus:approval-policy`、`nexus:fs-observation`、`file-reference`）。`mcp:servers` 是所有 server 合成的一塊（`packages/nexus-plugin-mcp/src/hub.ts:142-154`，核過），分不出各台。

這樣不必改 `systemTokens` 的算法（它決定什麼時候摘要，不能動）。落盤格式是加法，歷史紀錄在 `docs/persistence-changes/2026-11-16-context-measure-sources.md`。wire 與 web 不帶這一格。

`messageParts.injectedTokens` 不拆：`sources` 已經回答同一個問題。

### 5. 放哪一層

- 表與算法：`packages/nexus-core/src/injection-budget.ts`（純函式：源的 id、類別、預設值、`injectionLimitFor(source, contextWindow)`）。文件的表在 `docs/operations.md`〈各注入源的用量〉，由 `injection-budget.test.ts` 逐列比對。
- 回報與收集：`packages/nexus-core/src/injection-sources.ts`。
- B2：各源照舊在自己的套件裡執行。插件的正式程式碼今天不 import `@nexus/core`（子代理報告，沒逐一核），上限怎麼交到插件手上 B2 再定。
- 設定：各源的鍵留在各自那一列（`agent-instructions.maxBytes` 沿用為絕對上限），每個可延後的源多一個 `contextFraction`。不另設一個集中的設定區塊。

## agent-instructions 改成截斷（#2934，2026-11-18）

放不下時，`agent-instructions` 現在是：整份放得下的先放（最具體的先），剩下最具體的那一份截成預算放得下的最長檔頭，其餘整份不放；
通知行放在最前面，寫明哪一份被截、從幾位元組截到幾位元組、哪幾份整份沒放、各多大，以及其餘用 `read_file` 讀（路徑是 `readPath ?? displayPath`）。
截下來不到 256 位元組（`MIN_TRUNCATED_BYTES`，`render.ts`；一個標題或半條規則，比一行指標更容易誤導）就不截，退回整份不放。
`deferredBytes` 記沒放進去的位元組：被截的算被截掉的那一段。其餘三個可延後的來源不變。

### 為什麼從整份延後改成截斷

整份延後只留一行指標，賭的是模型看到指標會自己去讀。量到的不是這樣：

- #2929：真模型（nemotron-3.5-lightning-30b-a3b）13 次延後，**0 次**去讀 `AGENTS.md`。
- #2934：小檔（2,177 位元組，預算 1,024）六種做法（現況、加強指標、搬進 system prompt、檔頭摘錄 512 位元組、dsh 式截斷、宿主替模型先讀一頁）
  共 13 格（現況 3 格、其餘五種各 2 格），每格 5 次，「去讀了」**全是 0**（截斷那格規則在檔尾的一格是 0/4，有 1 次到上限中止），共 65 次、129 個請求、0 次執行失敗；
  其中宿主先讀那 10 次，每次都印出一筆 `tool-result-without-call` 違規，但沒有讓執行失敗（留言：https://github.com/DemianLi/nexus-agent/issues/2934#issuecomment-6966716707）。
  規則在檔頭那一格，檔頭摘錄、截斷、宿主先讀三種做法都讓規則在第一個請求裡（「規則已在請求」5/5）；現況、加強指標、搬進 system prompt 是 0/5。
  規則在檔尾那一格，檔頭摘錄與截斷是 0（截到的檔頭沒有它；截斷那格有 1 次到上限中止，去讀了的分母是 4），宿主先讀是 5/5（小檔一頁讀完）。
- 這輪量測有一個限制：「照做」在每一格都是 0，包括不延後的對照（規則已在請求，仍沒有寫那一行）。題目只問「列出檔名」，推測是模型沒有把
  「每次最後一行寫核可編號」當成要遵守的事（這是推測，沒有另外驗證）。所以這輪排不出哪個做法讓模型更照做；能下結論的只有「靠指標叫模型自己讀，不可靠」。

結論：不能靠模型自己去讀。截得到 256 位元組以上時，截斷讓檔頭一定在請求裡，不需要模型做任何決定；通知行告訴它被截了、其餘在哪。

### 對照 dsh（`8bd0733`，`packages/context/agent-instructions/src/render.ts`）

**dsh 怎麼做、為什麼。** `renderInstructionContext`（`:363-420`）整份放得下就整份放（`:372-375`）；放不下時從最寬的檔開始整份丟，找第一個放得下的後綴（`:377-384`）；
連最具體的一份單獨都放不下，才把那一份二分截到放得下的最長檔頭（`truncateToFit`，`:333-357`；`truncateUtf8` 不切碎字元，`:84-94`），其餘全丟（`:386-405`）。
再放不下依序退成較短的開場白（`COMPACT_AGENT_INSTRUCTIONS_INTRO`，`:392`）、只有標題加通知（`:407-418`）、只有通知（`:419-420`）。
入口是 `renderInstructionChains`（`:440`）：使用者全域鏈與專案鏈各有自己的 `maxBytes`；nexus 沒有使用者全域鏈，只有一條。
通知是一行（`markerText`，`:303-313`）：`omitted <路徑>, …; truncated <路徑> from A to B bytes`，沒有被丟的檔的大小，也沒有怎麼讀。
dsh 的 `README.md`（`packages/context/agent-instructions/README.md:74`）寫它 keeps the most specific files first；代價是模型拿到半份檔，通知不說去哪讀。

**別的做法，同一組標準**（正確性、失敗與恢復、效能、維護成本、產品需求、基座做不做得到）：

| 做法 | 結果 |
|---|---|
| 整份延後、一行指標（#2777 當時的選擇） | 實作最簡單，行為好預測；但 13 次延後 0 次去讀，延後的檔等於不存在。**正確性不成立** |
| 加強指標／搬進 system prompt | 小檔各 5 次，去讀 0/5。沒有改善 |
| 宿主替模型先讀一頁（`read_file` 的呼叫與結果進請求） | 模型看得到內容，但要補寫整套工具事件（會話日誌的 `tool/call`、`meta`，否則 `tool-result-without-call` 不變量違規、web 沒有工具卡，量過），多一條路徑要維護，而且繞過核准與路徑權限那幾層。**維護成本與風險最高** |
| 截斷、通知只講被截（dsh） | 檔頭在請求裡；但被丟掉的整份檔沒有大小、模型不知道去哪讀 |
| **截斷、通知寫明大小與讀檔路徑（選的）** | 檔頭在請求裡；被截與被丟的都有大小與讀法 |

**選哪個、好在哪。** 選最後一個。跟 dsh 一樣的是：放得下就整份、截最具體、二分取最大值、不切碎字元、通知放最前面。不一樣的兩處：

1. **通知多了讀檔指標與大小。** dsh 的 `omitted a, b; truncated x from A to B bytes` 沒有大小與讀法；我們寫 `read the rest of <路徑> with read_file`，被丟的每一份寫大小與路徑。理由是整份延後那條路量出來的教訓：模型不會憑空知道去讀。代價是通知比 dsh 的多約八十位元組（只有截斷的那一種）。這個差別值得：省下的位元組換不到模型自己去讀。
2. **多檔時先整份放得下的、再截最具體放不下的那一份。** dsh 只有在連最具體的一份單獨都放不下時才截，截的時候其餘全丟，哪怕較寬的小檔放得下（檔組 [寬小, 窄大]：dsh 截窄大、丟寬小）；較寬的大檔放不下、較窄的小檔放得下時，dsh 整份丟掉寬大（檔組 [寬大, 窄小]）。我們保留放得下的整份（最具體的先），只動放不下的那一份：[寬小, 窄大] 時較窄的大檔不會把較寬的小檔擠掉，[寬大, 窄小] 時較寬的大檔仍留一段檔頭，[小, 大, 小] 的兩個小檔都整份留下。
   代價：被截的可能是較寬的檔，較窄的整份放；兩者的取捨沒有量過，是我們訂的。

沒有照 dsh 做的：較短的開場白（`:392`）與只有標題的退路（`:407-418`）。通知行實測（路徑 `/AGENTS.md`、`/CLAUDE.md`）整份沒放 134、只截斷 165、兩者都有 221 位元組，路徑越長、沒放的檔越多就越長，外框、開場白與標題另有固定約 300 位元組，省下幾十位元組的開場白換不到多少檔頭，退路多一層就多一份要釘的模型可見字串；放不下時退成只有通知（與 dsh `:419-420` 同形）。

逐字照 dsh 的三處：引言同 `:18-20`；UTF-8 退位迴圈同 `:90-92`；`</system-reminder>` 的跳脫同 `:96-98`。

### 沒量過的

- 截斷之後模型的照做率：見上，這輪的題目排不出來。
- 256 位元組的下限、截斷點落在一行中間對模型的影響：沒有量。
- 實際送出的通知字串沒有在真模型上量過：量到的 `truncate` 那一格用的是 dsh 式的通知，沒有讀檔指標。
- 量測用的候選做法的程式碼不在 develop 上；要重現得靠 #2934 的留言，與引入這一段的那張 PR 的 commits 頁：`8c9573bc`（`variants.ts`，四種候選做法）、`e9287267`（宿主先讀）。

## 不做的

- **工具 schema**：只量、不設上限。它是必帶項，但組裝時 MCP 可能還沒連上，設了上限會讓「多掛一台 MCP」變成整個組裝失敗。先看量到的數字再決定。
- **MCP instructions 的合計**：維持每台一個上限。模型沒有別的路讀它，延後等於丟掉。
- **摘要訊息的 `<index>` 條目數**：屬於摘要，另一張卡。
- **`@` 會話引用、工具結果**：已經有上限與指標，只列進表。

## 不相容變更

接了大型 `AGENTS.md`（超過上限）的部署：小窗口的模型上，上限比以前小。`agent-instructions` 放不下時的做法見〈agent-instructions 改成截斷〉。同一張 PR 附升級指南。

## 拆 PR

1. **B1**：`injection-budget.ts` 的表與 `limitFor`、`context/measure.sources`、各源回報用量（不改任何源的行為）、文件的表。
2. **B2**：可延後的四個源改成整項延後加指標；必帶項的組裝檢查；升級指南；卡上要求的測試。

B1 先合，可以先在真實會話上看到各源實際多大，再回頭校 B2 的數字。

## B2 實際落地的樣子（2026-11-16）

跟上面草案不同或當時沒定的，以這一段為準；送出的指標原文見 `docs/operations.md`〈各注入源的用量〉。

- **上限怎麼交到插件手上**：`@nexus/agent-loop` 契約 1.4.0，`agent/pre-step` 的 listener 多收一格選填的 `contextWindow`（這條 thread 下一步會走的模型的窗口）。宿主從 `model-selection` 那一列問（`model-selection-host.ts` 的 `nextContextWindowOf`），每次呼叫問一次。插件照抄預設值與算法，`apps/harness/src/injection-budget-pins.test.ts` 把它們跟 core 的表釘成相等。
- **agent-instructions 的順序**：從最具體的那一層往外試（草案寫的是由寬到窄）。放不下的先跳過，其餘照樣試著整份放；全部試過之後，取沒能整份放的那幾份裡最具體的，截成放得下的最長檔頭（〈agent-instructions 改成截斷〉）。
- **skills 目錄**：整段放不下時從清單尾端往前留（草案寫的是照現有順序逐則放）。清單照每個名字第一次出現的先後排，後登記的來源才有的技能在尾端。
- **記憶檔攔得到**：渲染在我們自己的 `memory-middleware.ts`，不在基座裡；照登記的先後一份一份放。
- **system prompt 上兩段的窗口**：`FoldedAgentParams.contextWindowOf`（取自 `FoldOptions.modelLimits`），用的是那一次請求實際走的模型。
- **必帶項**：頭尾段在 `createSystemPromptMiddleware`（組 thread 時）檢查，拋 `SystemPromptBudgetError`；`plan:policy` 在 plan-mode 的設定驗證檢查。換模型後重新代入 `{{model}}` 的那一份不再檢查。
- **`deferred` 那一格**：叫 `deferredBytes`，是沒放進去的原文位元組數。訊息上的兩個源由插件寫在那一則訊息 `additional_kwargs` 的 `nexus_injection_deferred_bytes`，摘要器從送出的串上讀。
- **沒做的**：`skill-catalog`、`memory` 沒有設定鍵，只用表上的值；兩段各自的固定說明文字不縮，小窗口上整段仍可能超過上限。

## 已決定的（2026-11-16，四項都照建議）

1. **最具體的那份 instructions 放不下時整份延後**（卡的寫法），還是照 dsh 截斷。當時選延後；2026-11-18 改成截斷，見〈agent-instructions 改成截斷〉。
2. **單位用位元組、上限取 `min(絕對, 窗口×4×比例)`**。建議：照這樣。
3. **工具 schema 與 MCP 合計這張不設上限**。建議：不設，先量。
4. **拆成 B1（量）與 B2（執行）兩張**。建議：拆。

## 沒查清楚的

- 子代理結算通知、goal 續行輪的頭有沒有大小上限：沒找到，產生處沒讀。它們不在上面的表裡。
- `toolsTokens` 與實際送出的工具描述差多少：沒驗。
- skills 目錄在 system prompt、而且在摘要器外層：少列幾則會改變 `systemTokens`，也就改變摘要的時機。影響多大沒有量（B2 落地後仍沒有量）。
