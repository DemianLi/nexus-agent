# 注入源的分項預算：設計草案（#2777 的 B 半）

狀態：2026-11-16 核可（「要你決定的」四項都照建議）。B1 做完（表、算法、`context/measure.sources`，不改任何源的行為），B2 還沒開始。§4、§5 已改成 B1 實際落地的樣子。

盤點由子代理做（唯讀），下面標「核過」的是我自己再讀過原始碼的，其餘是子代理的報告、我沒有逐條核。

## 要解決的事

除了對話與工具結果，還有十幾個來源會把文字放進送給模型的請求。它們各管各的：有的有上限、超過就截斷；有的完全沒有上限；沒有一張表講誰能佔多少。總量只有摘要門檻一道，而摘要只動對話，動不了這些來源——一個 60 KB 的 `AGENTS.md` 在窗口 32,768 的模型上自己就佔掉大半，摘要救不了。

卡上要三件事：一張表、超過時整項延後並留一行指標（不截斷；必帶項放不下就組裝失敗）、各源用量看得到。

## 現況

| 來源 | 接在哪 | 現有上限 | 超過時 | 另一條讀全的路 |
|---|---|---|---|---|
| agent-instructions（`AGENTS.md` 等） | 尾端的一則機器訊息，每條 thread 一次 | 65,536 位元組（`packages/nexus-plugin-agent-instructions/src/index.ts:175`，核過）；單檔 1 MiB | 先整份省略較寬的檔，再**截斷**最具體的那份，留一行通知（`render.ts:82-103`，核過） | `read_file` |
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

卡上另一個參照 `kiaqyn/hierarchical-attention-memory`（`scripts/hfa_manager.py:2030-2043`）**本機沒有，我沒讀過**；要讀得另外核可下載。我的判斷是不需要：卡上已經把它的規則寫成三句話了。

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

指標一行，寫三件事：哪一項、多大、怎麼讀。

- agent-instructions：由寬到窄逐檔放，放不下的檔整份不放（不截斷，**包含最具體的那份**）。
  `Workspace instruction budget 13107 bytes: not loaded AGENTS.md (48210 bytes); read it with read_file before acting on this workspace.`
- skills 目錄：照現有順序逐則放，放不下的不列。
  `12 more skills not listed (budget 6553 bytes): list /skills with ls and read a SKILL.md with read_file.`
- 技能叫用的正文：`Skill "report" is 91200 bytes, over the 65536-byte budget: read /skills/report/SKILL.md with read_file.`
- 記憶檔：同形狀。

跟 dsh 不同的地方：最具體的那份 instructions 放不下時，dsh 截斷，這裡整份延後。理由：截斷的檔沒有告訴模型缺了什麼，而且截斷點可能落在一條規則中間；延後加指標，模型知道有這份檔、多大、要去讀。代價：模型得多一次工具呼叫，而且可能不讀。這是卡上明寫的方向（「不截斷內文」）。

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

## 不做的

- **工具 schema**：只量、不設上限。它是必帶項，但組裝時 MCP 可能還沒連上，設了上限會讓「多掛一台 MCP」變成整個組裝失敗。先看量到的數字再決定。
- **MCP instructions 的合計**：維持每台一個上限。模型沒有別的路讀它，延後等於丟掉。
- **摘要訊息的 `<index>` 條目數**：屬於摘要，另一張卡。
- **`@` 會話引用、工具結果**：已經有上限與指標，只列進表。

## 不相容變更

接了大型 `AGENTS.md`（超過上限）的部署：最具體的那份以前是截斷後放進去，之後是整份不放、只留指標。小窗口的模型上，上限比今天小。同一張 PR 附升級指南。

## 拆 PR

1. **B1**：`injection-budget.ts` 的表與 `limitFor`、`context/measure.sources`、各源回報用量（不改任何源的行為）、文件的表。
2. **B2**：可延後的四個源改成整項延後加指標；必帶項的組裝檢查；升級指南；卡上要求的測試。

B1 先合，可以先在真實會話上看到各源實際多大，再回頭校 B2 的數字。

## 已決定的（2026-11-16，四項都照建議）

1. **最具體的那份 instructions 放不下時整份延後**（卡的寫法），還是照 dsh 截斷。建議：延後。
2. **單位用位元組、上限取 `min(絕對, 窗口×4×比例)`**。建議：照這樣。
3. **工具 schema 與 MCP 合計這張不設上限**。建議：不設，先量。
4. **拆成 B1（量）與 B2（執行）兩張**。建議：拆。

## 沒查清楚的

- 子代理結算通知、goal 續行輪的頭有沒有大小上限：沒找到，產生處沒讀。它們不在上面的表裡。
- `toolsTokens` 與實際送出的工具描述差多少：沒驗。
- 記憶檔插件不在出廠清單，它的讀取點在基座裡（子代理報告），能不能在那裡攔下整項延後沒有確認；做不到的話記憶檔退成「只量」。
- skills 目錄在 system prompt、而且在摘要器外層：少列幾則會改變 `systemTokens`，也就改變摘要的時機。影響多大沒有量。
