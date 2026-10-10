# @nexus/plugin-mcp

把一台外部 [MCP](https://modelcontextprotocol.io/) server 的工具接進 agent，以
`mcp__<serverName>__<rawName>` 的名字註冊到 `registry.tools`；server 的**使用指引**（`initialize` 回的
`instructions`）接進系統提示詞，server 的**資源**（resources）經三支共用工具讀取。

## 用法

**一個條目對一台 server。** `NexusPlugin.name` 不唯一，所以同一個工廠掛幾次都行
（工廠回的是條目，[#453](https://github.com/DemianLi/nexus-agent/issues/453)；設定不在
工廠裡驗，驗在載入的時候，訊息因此帶得出 `<id> (<name>)`）：

```ts
import { createMcpPlugin } from '@nexus/plugin-mcp';

export default [
  createMcpPlugin({
    serverName: 'github',
    connection: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '' },
    },
  }),
  createMcpPlugin({
    serverName: 'web',
    connection: {
      transport: 'http',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: `Bearer ${process.env.MCP_TOKEN ?? ''}` },
    },
  }),
];
```

模型看到的是 `mcp__github__create_issue`、`mcp__web__search`——與 Claude Code、Codex 同一種
server-qualified 形狀。（**只有乾淨的名字對得上**，被正規化過的那些不會，見明文限制。）

## 設定

| 欄位                   | transport | 必填 | 說明                                                                                       |
| ---------------------- | --------- | ---- | ------------------------------------------------------------------------------------------ |
| `serverName`           | 兩者      | 是   | 這台 server 的命名空間，`[A-Za-z0-9_-]{1,32}`；不合法在建 plugin 當場報錯                  |
| `connection.transport` | 兩者      | 是   | `"stdio"` 或 `"http"`                                                                      |
| `connection.command`   | stdio     | 是   | 要執行的程式                                                                               |
| `connection.args`      | stdio     | 否   | 參數                                                                                       |
| `connection.env`       | stdio     | 否   | 額外的環境變數，疊在清洗過的父環境上（見下）                                               |
| `connection.cwd`       | stdio     | 否   | 子行程的工作目錄                                                                           |
| `connection.url`       | http      | 是   | server 網址                                                                                |
| `connection.headers`   | http      | 否   | 額外標頭（授權用）                                                                         |
| `toolCallTimeoutMs`    | 兩者      | 否   | 一次 `tools/call` 的逾時，預設 60000                                                       |
| `failOnStartupError`   | 兩者      | 否   | 掛上那一刻連不上、列不出工具或註冊不上時要不要讓這一列失敗，預設 `false`（見行為）         |
| `maxInstructionBytes`  | 兩者      | 否   | server 指引**連同出處標頭**的 UTF-8 位元組上限，預設 32768；超過算連線失敗（同上，不截斷） |

秘密一律從呼叫端的環境變數來，不寫進程式碼、設定檔或測試 fixture（見
[`docs/standards.md`](../../docs/standards.md)）。

**stdio server 的環境照 dsh 以清洗過的父環境為底**（[#726](https://github.com/DemianLi/nexus-agent/issues/726)）：
子行程拿到的是 nexus 這個行程的環境，扣掉名字像憑證的（`/KEY|PASSWORD|SECRET|TOKEN/i`，不分大小寫）與
`NEXUS_*`，再疊上 `connection.env`。所以語系、代理（`HTTPS_PROXY`／`NO_PROXY`）、`NODE_EXTRA_CA_CERTS`、
`TMPDIR` 這類照繼承，不必逐個填；要交給 server 的憑證得明著寫進 `connection.env`（上面範例的
`GITHUB_TOKEN`），同名時 `connection.env` 的值優先。清洗的定義跟 git 快照共用一份（`@nexus/core` 的
`scrubbedParentEnv`）。代理變數到得了子行程，但 Node 寫的 server 要自己開 `NODE_USE_ENV_PROXY` 才會照它走；
替子行程補這個旗標是 [#746](https://github.com/DemianLi/nexus-agent/issues/746) 的事。

## 工具名

每個 MCP 工具有兩個名字：走 `tools/call` **上線**的 raw name，與**註冊給模型看**的 public
name。public name 是 `(serverName, rawName)` 的純函式——連線順序、別台 server 都不會讓它改名。

供應商的 function name 契約是 64 字元的 `[A-Za-z0-9_-]`。名字帶了契約外的字元或超長時，
換字並截斷，並補一段 12 位十六進位指紋，所以兩個原本會被壓成同一個名字的工具不會併成
一個——併掉的下場是模型呼叫到另一個工具，而且沒有任何錯誤。

- 兩台 server 公告同一個 raw name（例如 `search`）在各自的命名空間下共存。
- 兩個 plugin 實例用同一個 `serverName`：後掛的那一個在連線之前就失敗，訊息指名是清單裡
  哪兩個。照 dsh 先佔名字再連線，所以這一條不受 `failOnStartupError` 管。
- 一台 server 公告兩個同名工具，同樣撞在那一層。

## 行為

- **載入期連線。** `apply` 連上 server、`tools/list`、逐個註冊，三件事都在 agent 跑起來
  之前。
- **連不上照樣掛上，照 dsh**（[#751](https://github.com/DemianLi/nexus-agent/issues/751)）。
  連不上、列不出、註冊撞名，任何一件發生時：已經註冊的工具撤掉、連線收掉、這一列照樣掛上但
  **這台 server 一個工具都沒有**，並經 `registry.logger` 交出一則警告。出貨的啟動程式把它印在
  啟動時那段警告裡（「警告：N 則外掛掛上時交出的話」），`serve` 每條對話組裝時又連不上的話在
  伺服器日誌記一行 `[組裝] thread "…" 警告：…`。
- **掛上之後掉了線會自動重連，照 dsh**（[#1099](https://github.com/DemianLi/nexus-agent/issues/1099)）：500 ms 起每次連續失敗加倍、
  上限 30000 ms；同一次中斷連續失敗 10 次就放棄；連上之後撐過 30000 ms 才又掉線，失敗次數歸零。**斷線期間工具照樣列在
  清單上，但呼叫會失敗**（`mcp-client(<名字>): server is disconnected`）。連回來之後同一批工具物件又叫得動，工具定義逐位元組
  不變，提示詞前綴不會因重連失效。**放棄之後**那台的工具從每次模型請求的工具清單拿掉（註冊表上仍在，呼叫得到「已放棄重連」），
  要等重新組裝（`serve` 的下一條對話、或重啟）才恢復。`reconnect.enabled: false` 關掉自動重連（工具照列、呼叫失敗，直到
  重新組裝）。重連的進度——掉線、第 n 次嘗試、放棄、連回來——交給 `registry.logger`（在 `apply` 裡 `bind()`
  綁好是誰，組裝之後也叫得動；外掛不自己寫標準錯誤，CLI 印到標準錯誤、`serve` 記進伺服器日誌，都帶 `[外掛]` 前綴）。偵測有兩個來源：SDK client 的 `onclose`（子行程被殺立刻觸發），與工具／資源呼叫
  失敗且錯誤是 `Not connected`／`Connection closed`（沒掛 `onclose` 的傳輸也能觸發）。
- **`failOnStartupError: true` 讓這一列失敗。** 同樣三件事改成在 `apply` 裡拋：清單上的這一列
  掉了（啟動時的警告指名它），手搭清單則整個載入失敗。`serve` 啟動時就掉了的列之後每條對話都
  算沒掛、不再重連，要到重啟。
- **關機收線。** plugin 經 `registry.lifecycle.onDispose()` 登記關閉連線，由組裝點的
  `dispose()` 觸發。stdio 子行程的 pipe 是活的 handle，沒收掉的話行程不會退出。
- **`apply` 中途失敗自己收拾。** 連線開了但註冊撞名時，plugin 先關掉 client 再收成警告或
  拋出——那時登記還沒發生，`lifecycle` 通道接不到它。

## 指引與資源（[#431](https://github.com/DemianLi/nexus-agent/issues/431)、[#430](https://github.com/DemianLi/nexus-agent/issues/430)）

照 dsh 的 `mcp-client` 與 `mcp-resources`（`packages/mcp/`，`5badb150`）：

- **server 指引**：`initialize` 回的 `instructions` 去掉結尾空白後，加上出處標頭 `### MCP server: <serverName>`
  接在系統提示詞後面（空白或沒有就不加）。**大括號原樣**，不做任何插值。上限 `maxInstructionBytes` 算的是
  **加上標頭之後整串的 UTF-8 位元組數**（dsh `connection.ts:318-322`），超過就算這一列連線失敗，走 `failOnStartupError`
  那條路（預設撤工具、收連線、警告）。文字在載入期定下來，之後每一輪逐位元組相同，不動 KV cache。
- **資源**：所有 `mcp` 列共用三支工具，名字、描述、參數與 dsh 一字不差——`list_mcp_resources`、
  `list_mcp_resource_templates`（`server`、選填 `cursor`）、`read_mcp_resource`（`server`、`uri`）。`list` 沒帶
  `cursor` 時由 SDK 走完所有頁並合併（dsh README 同寫，`mcp-resources/README.md:36`），帶了 `cursor` 就只回那一頁、
  `nextCursor` 原樣給模型；`read` 結果裡的二進位 `blob` 在給模型的文字換成一句
  描述（完整內容留在工具的 artifact）。server 沒宣告資源能力時，`list` 得到空清單、`read` 拋 server 的錯。
  協議在結果上加的 `_meta`、`ttlMs`、`cacheScope` 只在頂層從模型看的文字裡拿掉。
- **提示詞另有一段 `## MCP resource servers`**，列出所有已登記的 server 名字，讓模型知道 `server` 參數能填什麼。
- **連不上的那一列也登記**（照 dsh）：名字照列，叫它得到 dsh 那句 `mcp-client(<name>): server is disconnected`；問不存在的名字得到 `MCP resource server "<name>" is unavailable in this agent's scope`。寫了
  `failOnStartupError: true` 而掉了的列不留任何東西。
- **偏離**：dsh 的兩種提示詞是 `systemPrompt.section(...)`；我們沒有段落註冊點，提示詞是 middleware 一層層接的，
  所以用 `wrapModelCall` 把文字**接**（不是取代）到 system message 後面，與 goal、plan-mode 同一條已登記的偏離。
  dsh 的 `instructions()` 讀最近一次成功連線的快照、重連成功會換；我們重連之後不換（工具集合與提示詞都在組裝時定下，`supervisor.ts` 檔頭偏離 3）。
  Prompts（`prompts/*`）dsh 也不支援（「MCP prompt templates are unsupported」），這裡同樣不做。

## 明文限制

照 dsh 的 `Known Limitations` 模式：這些是缺口，不是待補的功能。

- **MCP 工具自己的檔案存取不受任何管束。** 它們是外部程序、走自己的檔案系統，既不經過
  `permissions` 也不經過 backend——deepagents 明文「custom tools from the agent or other
  middleware are left untouched」。harness 管得住的是「MCP 讀來的資料經由內建 `write_file`
  寫進虛擬 FS」那條路。要圍堵 MCP server 本身只能從啟動它的方式下手（沙箱／容器），
  不在 Phase 2 範圍（[#34](https://github.com/DemianLi/nexus-agent/issues/34)）。
- **Prompts 不橋接。** dsh 也不支援 MCP prompt templates；工具、指引與資源見上一節。
- **`tools/list_changed` 不處理，重連也不改工具集合。** dsh 在 server 通知工具清單變了、或重連之後會重新同步並換掉註冊的工具；
  deepagents 建好之後工具集合不可變，註冊表上的工具換不掉。所以：新工具要到下一次組裝才有；重連回來的新一代若少了某個原本有的
  工具，呼叫它得到 `tool "x" is no longer offered by the server`。這是登記過的偏離（`supervisor.ts` 檔頭偏離 2），範圍是「工具集合」，
  連線恢復本身照 dsh 做了。
- **掛上那一刻就連不上的那台不重連**，這一次組裝都沒有它的工具（補不了工具，見上）；`serve` 每條對話各組裝一次，所以下一條對話會再連。
- **重連只對 stdio 的子行程掉線有實測。** HTTP 傳輸是每個請求各自連，沒有「連線掉了」這回事；server 重啟之後 session 失效那一類錯誤
  不在 `Not connected`／`Connection closed` 的辨識裡，不會觸發重連。
- **結果的呈現由 adapter 決定。** 文字與圖片進 `content`、embedded resource 進 `artifact`
  是 `@langchain/mcp-adapters` 的預設，我們不改。dsh 那套「圖片要先證明這條 model route
  真的收圖片才落地」在這裡沒有對應物。
- **resource link 寫成 `Resource link: <name> (<uri>)`，並要求模型標出處**（[#1319](https://github.com/DemianLi/nexus-agent/issues/1319)，
  **超出 dsh**）。名稱與 URI 照 dsh 拼，adapter 2.0.0 的 metadata 帶著 `name`，所以不再只剩網址。dsh 只對 `web_search`／`web_fetch`
  要求引用（`search.ts:92` 的結果結尾、`:315-323` 的系統提示詞），MCP 沒有；我們的 web 搜尋判過不做，內部資料全走 MCP，所以把同一套
  移過來：系統提示詞多一段「說出是哪個 server、結果裡的連結用 markdown 連結標出來」（有任何 MCP 列登記就有，不看 resources 能力），
  工具結果**只在**含 resource link 時結尾多一句 `Cite the relevant resource links above as markdown links in your answer.`
  （措辭用 resource links 而不是 URLs，因為 MCP 的 URI 不一定是 http）。模型有沒有照做不保證，實機結果記在 PR。
- **server 回 `isError` 時，plugin 把它拋回去。** `@langchain/mcp-adapters` 2.0.0 在有 `tool_call_id`
  時不拋，回一則 `status: 'error'` 的訊息、文字是 server 的原文；1.x 是拋 `ToolException`。plugin 在每個
  工具外面把前者改回拋，錯誤才走圍堵（`containment.ts`）那條出口，模型看到 `Error: 工具 … 執行失敗：<原文>`
  ——Chat Completions 轉換器只送 content，前綴不在文字裡模型就分不出這是失敗（照 dsh 的 `throw new Error(text)`）。
- **server 的 elicitation（執行到一半向使用者追問）只在有人可以回答時才開**（[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)）。
  2.0.0 的現代協定 server 要問時走 LangGraph interrupt、等一次 resume。**連線握手時就得宣告能力**，所以是組裝期決定：
  設定 `elicitation`（預設 `true`）加上這次組裝的 `channel.kind === 'human'`（同 `ask_user_question`）才開；沒有人在的入口
  （`--print`、沒有 channel 的測試組裝）維持關閉，這種呼叫落成帶 `Error: ` 前綴的工具失敗。**超出 dsh**：dsh 的 client 宣告
  `capabilities: {}`（`connection.ts:261`）。舊協定的 server 要問需要 `onElicitation`，我們不給，所以它不會宣告這個能力。
  中斷發出去之後怎麼問人、怎麼回，在 `apps/harness` 的 `mcp-elicitation.ts`：`form` 變成問答卡（帶 `origin`），
  `url` 與子代理（前景、背景）一律由系統回絕並記 `interrupt/system-answered`。「關著」這條有人守（#1095）：新協議（`2026-07-28`）
  的測試 server 起了 stdio 與 HTTP 兩台，server 端量到沒有 channel 時 client 沒宣告 elicitation；
  把任一行改成恆為 `true` 都有測試紅。
- **工具的參數 schema 原樣送給模型。** 2.0.0 不再簡化 server 公告的 JSON Schema，`anyOf`、可為 null 與
  `$schema` 都會帶到供應商。收不收由供應商決定。實跑（#1074、#1095）：NVIDIA 端點上六個家族共七顆模型
  （OpenAI、NVIDIA、Meta、智譜、Poolside、DeepSeek）都收，沒有被拒收的；**沒有驗到 NVIDIA 以外的端點**，
  換端點要重量。結果表在 #1095 的 PR 內文。
- **子行程的 stderr 直接接到父行程。** 這是 MCP 的慣例（server 的診斷要看得到），代價是
  一台吵的 server 會把 CLI 的輸出洗掉。
- **正規化過的名字只在 nexus 內部一致。** 指紋是我們自己算的（`sha256("<serverName> <rawName>")` 取前 12 位），dsh 的 preimage 沒有公開，Claude Code 與 Codex 也各有各的算法。所以同一支
  工具在不同 harness 下的正規化名字**不會相同**——乾淨的名字才是跨工具一致的那一種。
  這不影響任何東西：public name 只是註冊表的 key 與模型看到的字串，上線的永遠是 raw name。

## 與 dsh 的偏離

技術實現以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的
`packages/mcp/mcp-client` 為標準（見 [AGENTS.md](../../AGENTS.md)）。這裡走
`@langchain/mcp-adapters` 而不是自己接 `@modelcontextprotocol/sdk`：adapter 產出的是
`DynamicStructuredTool`，正是 `registry.tools.register()` 收的東西，自己接 SDK 等於把
「MCP content block 翻成 LangChain 工具結果」整段重寫一次。上面的明文限制裡，結果呈現、`stderr` 三條就是這個選擇的代價；重連因此是自己包的 supervisor，沒開 adapter 內建的 `restart`（固定間隔、固定次數，表達不出 dsh 的指數退避與穩定期重置，而且重連之後已註冊的舊工具物件仍綁著死掉的 client，實測 `Not connected`）。

**基座沒有內建 MCP。** `deepagents@1.13.1` 整包沒有一處提到 MCP；MCP 在 LangChain JS 這一
側是 `@langchain/mcp-adapters` 這個獨立套件。
