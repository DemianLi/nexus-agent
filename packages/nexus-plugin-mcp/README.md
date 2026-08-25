# @nexus/plugin-mcp

把一台外部 [MCP](https://modelcontextprotocol.io/) server 的工具接進 agent，以
`mcp__<serverName>__<rawName>` 的名字註冊到 `registry.tools`。

## 用法

**一個 plugin 實例對一台 server。** `NexusPlugin.name` 不唯一，所以同一個工廠掛幾次都行：

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
server-qualified 形狀。

## 設定

| 欄位 | transport | 必填 | 說明 |
| --- | --- | --- | --- |
| `serverName` | 兩者 | 是 | 這台 server 的命名空間，`[A-Za-z0-9_-]{1,32}`；不合法在建 plugin 當場報錯 |
| `connection.transport` | 兩者 | 是 | `"stdio"` 或 `"http"` |
| `connection.command` | stdio | 是 | 要執行的程式 |
| `connection.args` | stdio | 否 | 參數 |
| `connection.env` | stdio | 否 | 額外的環境變數 |
| `connection.cwd` | stdio | 否 | 子行程的工作目錄 |
| `connection.url` | http | 是 | server 網址 |
| `connection.headers` | http | 否 | 額外標頭（授權用） |
| `toolCallTimeoutMs` | 兩者 | 否 | 一次 `tools/call` 的逾時，預設 60000 |

秘密一律從呼叫端的環境變數來，不寫進程式碼、設定檔或測試 fixture（見
[`docs/standards.md`](../../docs/standards.md)）。

## 工具名

每個 MCP 工具有兩個名字：走 `tools/call` **上線**的 raw name，與**註冊給模型看**的 public
name。public name 是 `(serverName, rawName)` 的純函式——連線順序、別台 server 都不會讓它改名。

供應商的 function name 契約是 64 字元的 `[A-Za-z0-9_-]`。名字帶了契約外的字元或超長時，
換字並截斷，並補一段 12 位十六進位指紋，所以兩個原本會被壓成同一個名字的工具不會併成
一個——併掉的下場是模型呼叫到另一個工具，而且沒有任何錯誤。

- 兩台 server 公告同一個 raw name（例如 `search`）在各自的命名空間下共存。
- 兩個 plugin 實例用同一個 `serverName` 會在 registry 那一層以「同層同名工具」撞掉，
  訊息指名是清單裡哪兩個。
- 一台 server 公告兩個同名工具，同樣撞在那一層。

## 行為

- **載入期連線。** `apply` 連上 server、`tools/list`、逐個註冊，三件事都在 agent 跑起來
  之前。連不上、列不出、註冊撞名，任何一件都讓**整份 plugin 清單載入失敗**，而不是安靜
  地少幾個工具。
- **關機收線。** plugin 經 `registry.lifecycle.onDispose()` 登記關閉連線，由組裝點的
  `dispose()` 觸發。stdio 子行程的 pipe 是活的 handle，沒收掉的話行程不會退出。
- **`apply` 中途失敗自己收拾。** 連線開了但註冊撞名時，plugin 在拋出之前先關掉 client
  ——那時登記還沒發生，`lifecycle` 通道接不到它。

## 明文限制

照 dsh 的 `Known Limitations` 模式：這些是缺口，不是待補的功能。

- **MCP 工具自己的檔案存取不受任何管束。** 它們是外部程序、走自己的檔案系統，既不經過
  `permissions` 也不經過 backend——deepagents 明文「custom tools from the agent or other
  middleware are left untouched」。harness 管得住的是「MCP 讀來的資料經由內建 `write_file`
  寫進虛擬 FS」那條路。要圍堵 MCP server 本身只能從啟動它的方式下手（沙箱／容器），
  不在 Phase 2 範圍（[#34](https://github.com/DemianLi/nexus-agent/issues/34)）。
- **只橋接工具。** Resources 與 Prompts 沒有 harness 消費端，延後。
- **不重連。** 連線掉了之後那台 server 的工具留在註冊表上、呼叫會失敗，直到重新組裝
  agent。dsh 有指數退避的重連監督與 `notifications/tools/list_changed` 的重新同步；
  deepagents 建構後不可變，工具集合換不掉，重連回來也沒有地方放。
- **失敗即載入失敗，沒有 `failOnStartupError` 那個旋鈕。** dsh 預設連不上照樣啟動（沒有
  工具）。nexus 的共同軸線是 fail-closed、載入期失敗，`@langchain/mcp-adapters` 的預設
  （`onConnectionError: 'throw'`、`throwOnLoadError: true`）站在同一邊，所以照它走。
- **結果的呈現由 adapter 決定。** 文字與圖片進 `content`、embedded resource 進 `artifact`
  是 `@langchain/mcp-adapters` 的預設，我們不改。dsh 那套「圖片要先證明這條 model route
  真的收圖片才落地」在這裡沒有對應物。
- **子行程的 stderr 直接接到父行程。** 這是 MCP 的慣例（server 的診斷要看得到），代價是
  一台吵的 server 會把 CLI 的輸出洗掉。

## 與 dsh 的偏離

技術實現以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的
`packages/mcp/mcp-client` 為標準（見 [AGENTS.md](../../AGENTS.md)）。這裡走
`@langchain/mcp-adapters` 而不是自己接 `@modelcontextprotocol/sdk`：adapter 產出的是
`DynamicStructuredTool`，正是 `registry.tools.register()` 收的東西，自己接 SDK 等於把
「MCP content block 翻成 LangChain 工具結果」整段重寫一次。上面的明文限制裡，不重連、
結果呈現、`stderr` 三條就是這個選擇的代價。

**基座沒有內建 MCP。** `deepagents@1.13.1` 整包沒有一處提到 MCP；MCP 在 LangChain JS 這一
側是 `@langchain/mcp-adapters` 這個獨立套件。
