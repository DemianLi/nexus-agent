# @nexus/plugin-mcp

把一台外部 [MCP](https://modelcontextprotocol.io/) server 的工具接進 agent，以
`mcp__<serverName>__<rawName>` 的名字註冊到 `registry.tools`。

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

| 欄位 | transport | 必填 | 說明 |
| --- | --- | --- | --- |
| `serverName` | 兩者 | 是 | 這台 server 的命名空間，`[A-Za-z0-9_-]{1,32}`；不合法在建 plugin 當場報錯 |
| `connection.transport` | 兩者 | 是 | `"stdio"` 或 `"http"` |
| `connection.command` | stdio | 是 | 要執行的程式 |
| `connection.args` | stdio | 否 | 參數 |
| `connection.env` | stdio | 否 | 額外的環境變數，疊在清洗過的父環境上（見下） |
| `connection.cwd` | stdio | 否 | 子行程的工作目錄 |
| `connection.url` | http | 是 | server 網址 |
| `connection.headers` | http | 否 | 額外標頭（授權用） |
| `toolCallTimeoutMs` | 兩者 | 否 | 一次 `tools/call` 的逾時，預設 60000 |
| `failOnStartupError` | 兩者 | 否 | 掛上那一刻連不上、列不出工具或註冊不上時要不要讓這一列失敗，預設 `false`（見行為） |

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
- **`failOnStartupError: true` 讓這一列失敗。** 同樣三件事改成在 `apply` 裡拋：清單上的這一列
  掉了（啟動時的警告指名它），手搭清單則整個載入失敗。`serve` 啟動時就掉了的列之後每條對話都
  算沒掛、不再重連，要到重啟。
- **關機收線。** plugin 經 `registry.lifecycle.onDispose()` 登記關閉連線，由組裝點的
  `dispose()` 觸發。stdio 子行程的 pipe 是活的 handle，沒收掉的話行程不會退出。
- **`apply` 中途失敗自己收拾。** 連線開了但註冊撞名時，plugin 先關掉 client 再收成警告或
  拋出——那時登記還沒發生，`lifecycle` 通道接不到它。

## 明文限制

照 dsh 的 `Known Limitations` 模式：這些是缺口，不是待補的功能。

- **MCP 工具自己的檔案存取不受任何管束。** 它們是外部程序、走自己的檔案系統，既不經過
  `permissions` 也不經過 backend——deepagents 明文「custom tools from the agent or other
  middleware are left untouched」。harness 管得住的是「MCP 讀來的資料經由內建 `write_file`
  寫進虛擬 FS」那條路。要圍堵 MCP server 本身只能從啟動它的方式下手（沙箱／容器），
  不在 Phase 2 範圍（[#34](https://github.com/DemianLi/nexus-agent/issues/34)）。
- **只橋接工具。** Resources 與 Prompts 沒有 harness 消費端，延後。
- **不重連。** 連線掉了之後那台 server 的工具留在註冊表上、呼叫會失敗，直到重新組裝
  agent；掛上時就連不上的那台，這一次組裝都沒有它的工具。dsh 有指數退避的重連監督與
  `notifications/tools/list_changed` 的重新同步，連上了就把工具補上；deepagents 建構後不可變，
  工具集合換不掉，重連回來也沒有地方放。`serve` 每條對話各組裝一次，所以下一條對話會再連。
- **結果的呈現由 adapter 決定。** 文字與圖片進 `content`、embedded resource 進 `artifact`
  是 `@langchain/mcp-adapters` 的預設，我們不改。dsh 那套「圖片要先證明這條 model route
  真的收圖片才落地」在這裡沒有對應物。
- **server 回 `isError` 時，plugin 把它拋回去。** `@langchain/mcp-adapters` 2.0.0 在有 `tool_call_id`
  時不拋，回一則 `status: 'error'` 的訊息、文字是 server 的原文；1.x 是拋 `ToolException`。plugin 在每個
  工具外面把前者改回拋，錯誤才走圍堵（`containment.ts`）那條出口，模型看到 `Error: 工具 … 執行失敗：<原文>`
  ——Chat Completions 轉換器只送 content，前綴不在文字裡模型就分不出這是失敗（照 dsh 的 `throw new Error(text)`）。
- **不處理 server 的 elicitation（向使用者追問）。** 2.0.0 對現代協定的 server 預設開啟，問到時走 LangGraph
  interrupt、等一次 resume；nexus 沒有這條 resume 路徑，所以每個連線一律 `elicitation: false`，這種呼叫
  當作工具失敗。舊協定的 server 要問需要 `onElicitation`，我們不給，所以它不會宣告這個能力。現代協定的
  elicitation **沒有被測**：測試用的假 server 走舊協定。
- **工具的參數 schema 原樣送給模型。** 2.0.0 不再簡化 server 公告的 JSON Schema，`anyOf`、可為 null 與
  `$schema` 都會帶到供應商。收不收由供應商決定；見 #1074 的實跑紀錄。
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
「MCP content block 翻成 LangChain 工具結果」整段重寫一次。上面的明文限制裡，不重連、
結果呈現、`stderr` 三條就是這個選擇的代價。

**基座沒有內建 MCP。** `deepagents@1.13.1` 整包沒有一處提到 MCP；MCP 在 LangChain JS 這一
側是 `@langchain/mcp-adapters` 這個獨立套件。
