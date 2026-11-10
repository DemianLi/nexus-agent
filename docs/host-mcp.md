# 宿主的 HTTP MCP 連線

Rust 宿主（`native/sandbox-spawner/host/`）連 HTTP MCP server 的現有行為（[#2570](https://github.com/DemianLi/nexus-agent/issues/2570) PR-D）。
寫給要改這一層、或要對照 TS 的人。管理者怎麼設一列 MCP，看 [`operations.md`](operations.md)，這裡不重寫。

**現況：還沒有呼叫方。** 設定、一代連線、監督者、連線池、TLS 與代理都在，只接到測試；跑它們的執行緒與插件 `mcp` 還沒進來。
今天的 MCP 一律由 TS 的 `packages/nexus-plugin-mcp` 連。語意照那邊，下面標了「同 TS」的，訊息的英文也逐字相同（例外見〈跟 TS 的差距〉）。

- 程式：`host/src/mcp/`（`config.rs` 設定、`connection.rs` 一代連線、`supervisor.rs` 退避重連、`pool.rs` 連線池）、`host/src/tls.rs`、`host/src/proxy.rs`。
- 測試：`host/tests/mcp.rs`、`mcp_supervisor.rs`、`tls.rs`、`tls_env.rs`、`proxy.rs`。

## 設定

一台 server 一個物件，是 TS `mcpConfigSchema` 的 HTTP 那一支。不認得的欄位整列拒絕；錯誤訊息只講欄位名，不帶值。

| 欄位 | 內容 |
| --- | --- |
| `serverName` | 必填，1 到 32 個 `[A-Za-z0-9_-]`。 |
| `connection` | 必填，`{ transport: "http", url, headers? }`。`url` 只收 `http:`／`https:`，帶帳號或密碼的拒絕（訊息不印網址）。`headers` 的值只收字串；憑證引用（`{ credential, prefix? }`）還不支援，整列拒絕。`transport: "stdio"` 拒絕。 |
| `toolCallTimeoutMs` | 正整數（不大於 2^53−1，`60000.0` 也收，同 zod 的 `int`），預設 60000。 |
| `livenessTimeoutMs` | 正整數（同 `toolCallTimeoutMs`，但不大於 2^31−1），預設 15000。照收、不用（只給 stdio），只進池的鍵。 |
| `failOnStartupError` | 預設 `false`。 |
| `maxInstructionBytes` | 正整數（同 `toolCallTimeoutMs`），預設 32768。 |
| `reconnect` | `{ enabled?, initialDelayMs?, maxDelayMs?, maxAttempts? }`，預設 `true`／500／30000／10；`initialDelayMs` 不能大於 `maxDelayMs`。 |
| `elicitation` | 預設 `true`。 |

`approval` 不經宿主，寫了拒絕。

**秘密**：header 的值、網址的 query（整串、每個值的原樣與解碼後）是這一列的秘密（`Server::secrets`），
錯誤訊息裡出現的一律換成 `[redacted]`，長的先換（`scrub`）。`Server` 的 `Debug` 不印這些。`scrub` 只做逐字替換，不處理其他編碼與重疊區間。

## 一代連線

`connection.rs` 照 TS `connection.ts` 的 HTTP 那一半，三步都過才算連上一代：握手、`tools/list` 分頁走完、查指引上限。

- transport 是 rmcp 的 Streamable HTTP，客戶端由呼叫方傳入，要用 `tls::http_client` 建，TLS 與代理才會照下面〈TLS 與代理〉。設定的 header 每個請求都帶。
- rmcp 自己的重試全關（SSE 重連、session 過期重建），重連只交給監督者，同 TS 的 `maxRetries: 0`。
- 協定版本自動協商：先試新協定（`server/discover`），對方是舊協定就退回 `initialize`。握手報的身分同 TS（`@nexus/plugin-mcp`），
  不宣告任何 client 能力；新協定、而且開了 `elicitation` 時，`tools/call` 要在 `_meta` 帶反問能力，值由 `call_meta` 給（同 TS `tool-call.ts` 的 `inBand`）。
- `tools/list` 同一個 cursor 再出現就停，沒有名字的工具略過。指引去掉結尾空白、全空白當沒有，加上 `### MCP server: <name>` 標頭之後超過 `maxInstructionBytes` 就連不上。
- server 一則回應最多 16 MiB（`MAX_RESPONSE_BYTES`），JSON 回應與 SSE 的一個事件一樣；巢狀層數照 serde_json 的預設上限 128。
- 錯誤訊息的英文同 TS（`Failed to connect to streamable HTTP server …`、`Failed to load tools from server …`），網址不帶 query，這一列的秘密換成 `[redacted]`。
- 掉線：transport 關了，或呼叫端判斷線（`Live::lost`）。收一代時 rmcp 對有 session 的 server 送 `DELETE` 刪掉 session。
- 池經 `Http`（`pool::Connector`）拿一代，同一個池的每一代共用一個客戶端。

## 監督者

`supervisor.rs` 照 TS `supervisor.ts`：

- 退避：第一次等 `initialDelayMs`，每次連續失敗加倍，上限 `maxDelayMs`；同一次中斷最多 `maxAttempts` 次，超過就放棄。
  連上之後撐過 `maxDelayMs` 才掉線，失敗次數歸零。`reconnect.enabled: false` 時第一次失敗或掉線就停。
- 收連上過的一代最多等 5 秒（`GENERATION_CLOSE_TIMEOUT`，同 dsh）；等不到就停止重連，寧可停下也不讓兩代同時活著。
- `failOnStartupError: true` 的那一列第一次就失敗時不在背景重試。
- 進度與放棄寫進日誌（`reconnecting in <n>ms (attempt <i>/<max>)`、`giving up after <max> consecutive failed reconnect attempts` 等，同 TS）。

## 連線池

`pool.rs` 照 TS `pool.ts`：

- **一份設定一份連線**，整個連線池共用。鍵是整份設定加實際的 elicitation 旗標，同 TS 的 `poolKey`：設定先照 zod 填好預設值，
  數字一律當浮點數，物件的鍵照碼位排（`json::encode`）。省略一個欄位跟寫出它的預設值、`500` 跟 `500.0`、鍵的順序不同，都是同一份。
  `connection.headers` 寫了空物件跟沒寫是兩份，同 zod 的 `optional`。憑證值的指紋還沒做。
- 舊的一份留到池關：不數使用者、不回收。
- 建立那一份的取用等第一次連線落定（建池時給了上限、又沒寫 `failOnStartupError` 的列最多等那麼久）；寫了 `failOnStartupError` 就回錯、
  那一份從表裡拿掉並收掉，但留在關池時要收的清單裡（同 TS 的 `opened`），
  反覆取用連不上的 server，已收掉的那幾份會一直留在清單裡到池關。其餘的取用最多等 5 秒，到期是 `still connecting after <ms>ms` 那一句，連線照樣在背景繼續。到期或第一次失敗時，
  寫了 `failOnStartupError` 就回錯，否則錯誤跟著取用的結果照樣回。
- 斷線空窗裡沒有活著的一代（`Shared::current` 是 `None`），清單照最近一代的（`Shared::listed`）。
- 放棄重連之後，下一次取用替這一份重開一個監督者、重新起算預算。
- 關池時同時收每一份（含被重開取代的、還在連第一次的），不等卡住的握手。
- 一代怎麼連由建池時給的 `Connector` 決定；池把池的秘密（代理帳密等）加上這一列的秘密交給它。測試用記憶體裡的假 `Connector`。

## TLS 與代理

- **只信設定的根**：`tls::client_config` 從設定指定的 PEM 檔讀根憑證，固定 ring；不讀系統的信任庫。測試用兩張 P-256 CA 實際連本機的 rustls 伺服器驗：
  簽發者對的連得上，另一張 CA 驗不過，經 CONNECT 隧道也一樣。
- **證明不了的退化**：設定的根之外又信了系統的信任庫。測試的 CA 在哪裡都不受信任，系統信任庫加不加都一樣驗不過；要測出來得有一張公開受信任的憑證，
  完全內網做不到。這種退化只靠原始碼掃描擋。
- **代理照政策走**：政策由呼叫端解析好交進來（`{ httpProxy?, httpsProxy?, noProxy? }`），宿主不讀環境變數；
  直連時也明確關掉 reqwest 讀環境代理，走代理時環境的 `NO_PROXY` 也不讓請求繞過它（`tls_env.rs` 設了 `HTTPS_PROXY`、`NO_PROXY` 驗）。代理只收 `http:`／`https:`，SOCKS 拒絕。
- **比對規則同 TS `policy.ts`**：迴圈位址一律直連；放行清單只比主機名與埠，開頭的 `.` 或 `*.` 視為同一件事，`*` 放行全部，不比 CIDR。
  兩邊跑同一份 `native/sandbox-spawner/proxy-vectors.json`（TS 端是 `packages/nexus-core/src/http-proxy/policy-vectors.test.ts`）。
- 代理帳密：網址帶了帳密時送 `Proxy-Authorization`（Basic）。代理拒絕時錯誤不帶帳密，有測試。

## 跟 TS 的差距

- stdio 不支援；只給 stdio 的存活探測也沒有。
- header 的憑證引用還不支援；遮蔽只做逐字替換。
- 設定：`approval` 整列拒絕（TS 收下、不放進池的鍵）；`url` 只收 `http:`／`https:`（TS 只要求非空字串）。
- 帶帳號或密碼的網址：宿主解設定時就拒；TS 收下設定，連線時才失敗（Node 的 `fetch` 不收帶帳密的網址）。
- 舊式 HTTP+SSE 的退回沒有做（rmcp 沒有這個 transport）。
- `tools/list` 拿不到工具的 `execution.taskSupport`：rmcp 的工具型別沒有這一欄，解析時丟掉。所以 TS 對 `taskSupport: 'required'` 的工具在呼叫前先擋，宿主做不到；
  新協定本來就沒有 `execution`，影響只在舊協定。
- 呼叫結果只帶 `content` 與 `structuredContent`：rmcp 把回應解成自己的型別再序列化，規格外的欄位會丟掉，TS 的 SDK 原樣留著。這是 #1827 的 D290 接受的失真。
- 新協定的 `server/discover` 10 秒沒回就退回 `initialize`，這 10 秒關不掉（rmcp 的私有常數）。TS 用 `startupTimeoutMs` 當握手期限，逾時就是錯、不退回。
- 監督者的訊息有兩處不逐字：小於 1e-6 或不小於 1e21 的毫秒數，宿主不寫成指數；超過 2^31−1 ms 的延遲，TS 的 `setTimeout` 改成 1 ms，宿主照設定的時間等。
