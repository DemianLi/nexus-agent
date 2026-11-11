# 宿主的 HTTP MCP 連線

Rust 宿主（`native/sandbox-spawner/host/`）連 HTTP MCP server 的現有行為（[#2570](https://github.com/DemianLi/nexus-agent/issues/2570) PR-D）。
寫給要改這一層、或要對照 TS 的人。管理者怎麼設一列 MCP，看 [`operations.md`](operations.md)，這裡不重寫。

**現況：對話行程那一側還沒接上。** 插件 `mcp` 與它 expose 的服務 `mcp/client` 都在，但對話行程還不會叫它。
今天的 MCP 一律由 TS 的 `packages/nexus-plugin-mcp` 連。語意照那邊，下面標了「同 TS」的，訊息的英文也逐字相同（例外見〈跟 TS 的差距〉）。

- 程式：`host/src/mcp/`（`config.rs` 設定、`connection.rs` 一代連線、`supervisor.rs` 退避重連、`pool.rs` 連線池、`bridge.rs` 跑它們的執行緒、
  `service.rs` 插件與服務）、`host/src/wake.rs`、`host/src/tls.rs`、`host/src/proxy.rs`。
- 測試：`host/tests/mcp.rs`、`mcp_supervisor.rs`、`tls.rs`、`tls_env.rs`、`proxy.rs`，與 `host.rs` 的 `calls::mcp`（真的宿主行程）；
  本機的 HTTPS 假 server 在 `host/tests/common/fake_mcp.rs`，`host/examples/fake_mcp_server.rs` 把它包成獨立的執行檔。

## 插件與服務

`--plugins` 的一列 `{ "name": "mcp", "config": { "roots": <PEM 檔路徑>, "proxy"?: <代理政策> } }`。apply 時讀根憑證、建 HTTP 客戶端、
起橋；expose 服務 `mcp/client`，兩個方法都是串流：

| 方法 | payload | 塊 | 收尾 |
| --- | --- | --- | --- |
| `open` | `{ server: <下面〈設定〉的一列>, elicitation?: bool }` | 清單文件 `{"tools":[...],"instructions":"...","warning":...}` 切成的字串塊，再一塊 `{"ready":{"chunks":n,"bytes":b}}` | 不收尾：一直掛著當綁定，取消或斷線時放掉 |
| `call` | `{ open: <同一條連線上 open 的呼叫編號>, method, params: <JSON 文字> }` | server 回的結果切成的字串塊 | `{"chunks":n,"bytes":b}` |

**這一格是 JSON 文字**：`params`、清單文件、結果都是 JSON 序列化成的字串，不是宿主框裡的巢狀值。宿主的框有巢狀層數與大小上限，
MCP 的酬載不受它們限，所以過橋時一律是文字，拼回之後由對話行程自己解。

- `method` 只收 `tools/call`、`resources/list`、`resources/templates/list`、`resources/read`。`open` 要指到同一條連線上已經送出
  `ready` 的綁定；綁定跟著連線走，別的連線指不到。
- 切塊在 UTF-8 字元的邊界上，一塊最多 32 KiB，一步最多四塊：一塊編成框最壞是 6 倍（控制字元寫成 `\u00XX`），仍小於一框；
  一步四塊仍小於宿主一步的上限。推了塊又回 `Pending` 的呼叫，宿主下一輪就再 poll（連線暫停時等它恢復）。
- 拼回時核對：塊的序號從 0 連續（宿主框的 `seq`），塊數與 UTF-8 位元組數對上 `ready`／收尾的值。缺一塊或順序錯了都拼不回。
- 一份文字最多 16 MiB，跟 server 一則回應的上限相同（〈一代連線〉）；超過的以服務的錯收尾，不送任何塊。
- 工具定義與結果裡物件的鍵照 server 送的順序過橋：`serde_json` 開了 `preserve_order`。池的鍵不受影響，`json::encode` 自己照碼位排。
- 呼叫端取消或斷線時，還在跑的 `call` 對 server 送 `notifications/cancelled`（理由 `cancelled`），不等它回；新協定下通知沒上線，見〈跟 TS 的差距〉。
- 連線池一個插件實體一座：宿主不在執行中改插件設定，所以等於整個宿主一座。宿主結束時不卸載插件，連線不送 `DELETE`，隨行程結束。
- 橋的日誌（監督者的進度與放棄）寫 stderr，前綴 `nexus-host: mcp`。

## 橋

`bridge.rs`：連線池、監督者與每一次請求跑在自己的執行緒（tokio current_thread）。宿主那一側送命令不會卡；結果排進收件匣、
寫一個位元組到自管道（`wake.rs`，兩端 `O_CLOEXEC`、非阻塞，管道滿了不卡）叫醒宿主，宿主把這個 fd 放進 poll。

- 請求送到那一份當下活著的一代；斷線空窗裡回 `server is disconnected`。逾時照 `toolCallTimeoutMs`，逾時不算掉線。
- 單次請求失敗（server 回非 2xx、回應太大、連不上）只是這一次失敗，連線不斷，同 TS 只認 transport 關了才算掉線。
- 一則 JSON 回應超過 16 MiB 時回 `<label>: response exceeded the size limit of 16 MiB — this call failed; the connection stays up`。
- 一則 SSE 事件超過 16 MiB，跟 server 中途斷掉這一則的串流，宿主分不出來，都只讓這一則失敗，回 `<label>: response stream closed before its final response`。
  rmcp 對這兩種都回 `TransportClosed`，超限的原因只寫進它自己的 tracing 日誌；transport 本身還開著（`Peer::is_transport_closed` 是假），所以不判掉線。
- 已知缺口：rmcp 3.9.0 的 HTTP transport 握手之後，server 怎麼回都不會關（只有宿主自己收掉才關），所以 HTTP 的一代實際上不會因為 server 而判掉線。
  舊協定的 server 重啟、忘掉 session 之後，每次呼叫都回 `Session expired (HTTP 404)`，不會重連（[#2690](https://github.com/DemianLi/nexus-agent/issues/2690)）。
- 錯誤訊息換掉這一列的秘密（`Shared::scrub`）。成功結果還沒遮蔽（TODO #2570）；位置是結果序列化成文字的那一步（`outgoing`），遮蔽要在序列化之前做。

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
- rmcp 把回應解成自己的型別再序列化，認得的形狀會丟掉規格外的欄位：`tools/call` 的結果丟掉內容區塊多出的欄位與不認得的頂層欄位。
  結果裡有不認得的內容區塊型別時，整個結果認不得、原樣交回（`host/tests/mcp.rs` 的 `bridge::規格外的欄位_認得的形狀丟掉_認不得的原樣`）。
  TS 的 SDK 原樣留著。這是 #1827 的 D290 接受的失真。
- 取消：橋不分協定都呼叫 `send_notification` 送 `notifications/cancelled`。實測（`host/tests/mcp_conformance.rs`，對官方 server 2.3.1）：舊協定下 server
  收到通知、那則 POST 也被中止；新協定下 server 只看到那則 POST 被中止、沒收到通知。新協定下通知為什麼沒上線（rmcp 丟掉，還是轉成中止），rmcp
  的原始碼本機沒有，看不到。TS 的 SDK 在新協定上只中止那一則的 POST 串流、不送通知（`@modelcontextprotocol/client` 2.3.1
  `dist/index.mjs:5363-5366`），舊協定才送。
- 一則回應的上限 16 MiB：TS 的 HTTP 兩條路都不設上限。
- SSE 事件超過上限時，錯誤訊息只說這一則的串流斷了，不說是太大（見〈橋〉）。只讓這一則失敗這一點跟 dsh 相同：dsh 的 `lost` 只在 SDK 的 `onclose`
  與工具同步失敗時呼叫（`packages/mcp/mcp-client/src/connection.ts:292-294`、`:304`，`8bd0733`），請求失敗只往外丟（`:380-383`）。
- 新協定的 `server/discover` 10 秒沒回就退回 `initialize`，這 10 秒關不掉（rmcp 的私有常數）。TS 用 `startupTimeoutMs` 當握手期限，逾時就是錯、不退回。
- 監督者的訊息有兩處不逐字：小於 1e-6 或不小於 1e21 的毫秒數，宿主不寫成指數；超過 2^31−1 ms 的延遲，TS 的 `setTimeout` 改成 1 ms，宿主照設定的時間等。
