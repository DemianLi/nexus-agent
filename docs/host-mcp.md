# 宿主的 MCP 連線（HTTP 與 stdio）

Rust 宿主（`native/sandbox-spawner/host/`）連 MCP server（HTTP 與 stdio）的現有行為（[#2570](https://github.com/DemianLi/nexus-agent/issues/2570) PR-D）。
寫給要改這一層、或要對照 TS 的人。管理者怎麼設一列 MCP，看 [`operations.md`](operations.md)，這裡不重寫。

**現況：`process-model: per-thread` 的對話行程連 MCP 一律走這裡**（#3000）：`packages/nexus-plugin-mcp` 在有宿主時用 `host-pool.ts` 的門面（長得像 SDK `Client`）向 `mcp/client` `open` 一份綁定、用 `call` 送請求，
連線在宿主，整台共用。單行程 serve 與 CLI 沒有宿主，仍由 TS 自己連。
per-thread 的前台與對話行程啟動時的試組都不連線（`mcp-trial-host-bridge.ts`）：只驗設定與組裝，所以起不來的 server 不會讓那一列在試組掉，連得上連不上到 thread 組裝時才知道。
寫入口（`plugin enable`、`plugin config set` 等，`plugin-trial.ts`）是另一個行程，拿不到 serve 的 `--process-model` 旗標，不分行程模型，試掛時一律自己連一次、組完就收。

語意照 TS，下面標了「同 TS」的，訊息的英文也逐字相同（例外見〈跟 TS 的差距〉）。

兩層重連，各管各的：宿主自己對 MCP server 退避重連（空窗裡的呼叫回 `server is disconnected`，綁定不變）；綁定沒了之後，對話行程在宿主連線回來或下一次呼叫進來時重新 `open`（單飛、單一期限 W＝5 秒，到了回 `server is disconnected`，不送出）。**W 只保證蓋住第一次宿主重起**：監督行程對宿主重起有退避（第一次等 1 秒，每次加倍到 30 秒，宿主活過 60 秒才歸回 1 秒），每一代都活不到 60 秒就被殺時，第四次重起起，退避（8 秒）就超過 W。正式值 5 秒（暫定，只量 arm64，結果見 [`mcp-pool-baseline-2570-2026-11-10.md`（封存）](https://github.com/DemianLi/nexus-agent/blob/archive/docs-2026-11/.docs/mcp-pool-baseline-2570-2026-11-10.md)〈後測結果〉）：30 次單次殺（每次殺之前宿主活過 60 秒、退避 1 秒），段 A 最大 1.42 秒、段 B 最大 0.15 秒，兩段相加最大 1.58 秒，公式值 3 秒，低於下限 5 秒。連續殺實測第 4 次重起的退避是 8 秒（段 A 約 8.4 秒），超過 W，與上面一致。
送出去之後宿主連線斷了的呼叫回「結果不明」，不重送。
**宿主放棄重連（`maxAttempts` 到了）時 TS 收不到訊號**：`hiddenAfterGiveUp` 在宿主路徑不觸發，放棄後工具仍在清單、呼叫回斷線（已知差異，補訊號另開 #3008）。

- 程式：`host/src/mcp/`（`config.rs` 設定、`connection.rs` 一代連線、`stdio.rs` stdio 的子行程、`supervisor.rs` 退避重連、`pool.rs` 連線池、`bridge.rs` 跑它們的執行緒、
  `service.rs` 插件與服務）、`host/src/wake.rs`、`host/src/tls.rs`、`host/src/proxy.rs`。
- 測試：`host/tests/mcp.rs`、`mcp_stdio.rs`、`mcp_supervisor.rs`、`tls.rs`、`tls_env.rs`、`proxy.rs`，與 `host.rs` 的 `calls::mcp`（真的宿主行程）；
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

- 請求送到那一份當下活著的一代；斷線空窗裡回 `server is disconnected`。逾時照 `toolCallTimeoutMs`，逾時不算掉線（stdio 另見下面的探活）。
- 單次請求失敗（server 回非 2xx、回應太大、連不上）只是這一次失敗，連線不斷，同 TS 只認 transport 關了才算掉線。
- **stdio 的探活**（[#3073](https://github.com/DemianLi/nexus-agent/issues/3073)，同 TS 的 `probeLiveness`）：stdio 的請求逾時或被取消之後，橋在背景對送出那次請求的那一代送一次 `tools/list`，等 `livenessTimeoutMs`，不擋那次請求回去。
  探活等滿 `livenessTimeoutMs` 還沒回應才判卡死（transport 關了的照掉線走）：記 `<label>: server stopped responding; restarting it`（同 TS），那一代照掉線走，監督者收掉子行程（〈stdio〉的收線梯度）、照退避重連；任何回應都算活著，錯誤回應也是。
  同一代一次只探一個；判卡死時那一代已經換掉的不理。HTTP 不探：沒有子行程可收，重連救不了對端。連線整台共用，所以一條對話的逾時觸發的重起，別的對話在那一代上進行中的呼叫會收到連線關閉。
  **stdin 寫不進時逾時那條路探不到**：server 連 stdin 都不讀、管線積滿（Linux 預設 64 KiB）之後，rmcp 的逾時要先等取消通知寫進 stdin 才回，那次請求自己就回不來，也就走不到探活；被取消的那條路先起探活再送通知，不受影響。見 [#3074](https://github.com/DemianLi/nexus-agent/issues/3074)。
  測試：`host/tests/mcp_stdio.rs` 的 `bridge::卡死的_server_…` 兩支與 `bridge::呼叫逾時但探活有回的_server_不重起`。
- 一則 JSON 回應超過 16 MiB 時回 `<label>: response exceeded the size limit of 16 MiB — this call failed; the connection stays up`。
- 一則 SSE 事件超過 16 MiB，跟 server 中途斷掉這一則的串流，宿主分不出來，都只讓這一則失敗，回 `<label>: response stream closed before its final response`。
  rmcp 對這兩種都回 `TransportClosed`，超限的原因只寫進它自己的 tracing 日誌；transport 本身還開著（`Peer::is_transport_closed` 是假），所以不判掉線。
- **session 過期算掉線**（[#2690](https://github.com/DemianLi/nexus-agent/issues/2690)）：rmcp 3.9.0 的 HTTP transport 握手之後，server 怎麼回都不會關，
  所以舊協定的 server 重啟、忘掉 session 之後，每次呼叫都會回 404。請求帶著 session id、server 回 404 時 rmcp 回 `StreamableHttpError::SessionExpired`
  （`Session expired (HTTP 404)`），包在 `ServiceError::TransportSend` 裡；橋對它下轉型認出來（`bridge::session_expired`，認型別、不認字），讓**這次呼叫送出時那一代**判掉線：
  - 這一次呼叫明確失敗，回 `<label>: session expired (HTTP 404) — this call failed; the connection is being re-established, retry the call`，不帶 session id 與請求內容；
    之後的呼叫在空窗裡回 `server is disconnected`，新一代連上後就成功。
  - 重連走監督者的退避與放棄（一個 server 一直 404，新一代的握手後續步驟也 404，就一次次失敗到 `maxAttempts` 放棄）。rmcp 自己的重新初始化（`reinit_on_expired_session`）維持關著：它在 worker 裡重新握手並重試一次，繞過退避、放棄與日誌。
  - 同一代撞到幾次都只換一次代：通知打的是那一代自己的訊號，不累積；換代之後才回來的舊錯誤打的是舊一代，打不到新一代。
  - 沒帶 session id 的 404（握手、網址錯、server 不發 session id）rmcp 不回 `SessionExpired`，照一般的失敗走，連線不動。新協定沒有 session，不會遇到。
  - 升 rmcp 時重看這條下轉型：`host/tests/mcp.rs` 的 `bridge::忘掉_session_這次失敗_下一次在新一代成功` 會紅。
- 送回對話行程的文字先遮掉這一列的秘密，三條出口：結果與 resources（含 `isError`）走 `outgoing`、工具清單走 `outgoing_tools`，遮 JSON 值裡的字串再序列化；instructions 走 `Shared::redact_text`；錯誤走 `Shared::scrub`（連線診斷在 `connection::connect` 回錯前就 `scrub` 過）。物件的鍵、工具的 `name`、值是字串的 `uri`／`uriTemplate` 不遮。規則見 [`credentials-file.md`](credentials-file.md)〈MCP 憑證值的遮蔽〉。

## 設定

一台 server 一個物件，是 TS `mcpConfigSchema` 的 HTTP 與 stdio 兩支。不認得的欄位整列拒絕；錯誤訊息只講欄位名，不帶值。

| 欄位 | 內容 |
| --- | --- |
| `serverName` | 必填，1 到 32 個 `[A-Za-z0-9_-]`。 |
| `connection` | 必填。HTTP：`{ transport: "http", url, headers?, credentialHeaders? }`，`url` 只收 `http:`／`https:`，帶帳號或密碼的拒絕（訊息不印網址）；`headers` 的值只收 TS 代入之後的字串，憑證引用物件整列拒絕。`credentialHeaders` 是 header 名（不分大小寫）→ prefix（沒有就 `""`），標出 `headers` 裡哪幾個值來自憑證：`headers` 不是空的時候它一定要在（沒有憑證就給 `{}`，漏送會變成起不來，不是憑證靜靜沒被遮）；`headers` 裡的 `authorization`／`proxy-authorization` 一定要列；每個鍵在 `headers` 裡剛好一個（大小寫不同的同名 header 對到兩個就拒）、值以 prefix 開頭、prefix 之後那一段要過 `check_value`（`Header`：非空、至少 8 個 code point、沒有 U+00FF 之後的字元與控制字元，tab 除外）且與它回的值完全相同（頭尾有空白就拒，同 stdio 的 `credentialEnv`）。池的鍵含它，空的與沒給是同一把。stdio：`{ transport: "stdio", command, args?, cwd?, env, credentialEnv }`，見下面〈stdio〉。 |
| `toolCallTimeoutMs` | 正整數（不大於 2^53−1，`60000.0` 也收，同 zod 的 `int`），預設 60000。 |
| `livenessTimeoutMs` | 正整數（同 `toolCallTimeoutMs`，但不大於 2^31−1），預設 15000。stdio 的探活等多久（見〈橋〉）；HTTP 照收、不用。兩種都進池的鍵。 |
| `failOnStartupError` | 預設 `false`。 |
| `maxInstructionBytes` | 正整數（同 `toolCallTimeoutMs`），預設 32768。 |
| `reconnect` | `{ enabled?, initialDelayMs?, maxDelayMs?, maxAttempts? }`，預設 `true`／500／30000／10；`initialDelayMs` 不能大於 `maxDelayMs`。 |
| `elicitation` | 預設 `true`。 |

`approval` 不經宿主，寫了拒絕。

**秘密**（`Server::secrets`）：
- `credentialHeaders` 標的那幾個 header：整個值，與 prefix 之後的憑證本身（server 可能只回顯憑證）。非 ASCII 的值照位元組收，不丟，兩段各收 UTF-8 與逐位元組當 Latin-1 的兩種形式。`Authorization`、`Proxy-Authorization` 另收 scheme 後面那一段（沒寫 prefix 時 scheme 在憑證值裡）。沒標的 header 是字面值，不收。
- 網址的 query（整串、每個值的原樣與解碼後）。

這些出現在送回對話行程的文字裡，一律換成 `[redacted]`。收集的入口只有一個：`Redactor::new`（`host/src/mcp/redact.rs`），`Pool` 把池的秘密（代理帳密）與這一列的合起來交進去；憑證值（stdio 的 `credentialEnv`、HTTP 的 `credentialHeaders`）都走同一個入口。
每個值連同百分號、form 與 JSON 跳脫形式在原文上一次替換。夠長（至少 8 個 code point）的值遮所有輸出；更短的只可能是設定裡的字面值，只遮錯誤與診斷，不遮成功結果。`Server` 與 `Redactor` 的 `Debug` 不印這些。

**query 一律收：** 設定格式裡網址沒有憑證引用，宿主分不出 query 的哪些值是憑證，所以全部的 query 值當秘密收，代價是字面值也會在成功結果裡被遮，不會漏。header 沒有這個近似：TS 要送 `credentialHeaders`，宿主只收它標的。送的人是 harness 的 `hostHttpConnection`（`apps/harness/src/mcp-host-http-row.ts`）：憑證引用列為憑證，直接寫成字串的 `Authorization`／`Proxy-Authorization`（D359）自動列為憑證（prefix `""`，整個值），其他字串 header 是字面值。判斷只在 `@nexus/plugin-mcp` 的 `hostHeaders` 一處，TS 外掛自己連線的 `redactorFor` 也用它；宿主對這兩個名字另有一道防線（在 `headers` 而沒列就整列拒絕）。送宿主之前 harness 先把每個字面值 header 修掉頭尾空白（整個值），憑證引用只修憑證、prefix 原樣。對話行程那一側由 `mcp-host-row-service.ts` 呼叫它（#3000）。

## 一代連線

`connection.rs` 照 TS `connection.ts`，三步都過才算連上一代：握手、`tools/list` 分頁走完、查指引上限。

- HTTP 的 transport 是 rmcp 的 Streamable HTTP，客戶端由呼叫方傳入，要用 `tls::http_client` 建，TLS 與代理才會照下面〈TLS 與代理〉。設定的 header 每個請求都帶。
- rmcp 自己的重試全關（SSE 重連、session 過期重建），重連只交給監督者，同 TS 的 `maxRetries: 0`。
- 協定版本自動協商：先試新協定（`server/discover`），對方是舊協定就退回 `initialize`。握手報的身分同 TS（`@nexus/plugin-mcp`），
  不宣告任何 client 能力；新協定、而且開了 `elicitation` 時，`tools/call` 要在 `_meta` 帶反問能力，值由 `call_meta` 給（同 TS `tool-call.ts` 的 `inBand`）。
- `tools/list` 同一個 cursor 再出現就停，沒有名字的工具略過。指引去掉結尾空白、全空白當沒有，加上 `### MCP server: <name>` 標頭之後超過 `maxInstructionBytes` 就連不上。
- server 一則回應最多 16 MiB（`MAX_RESPONSE_BYTES`），JSON 回應與 SSE 的一個事件一樣；巢狀層數照 serde_json 的預設上限 128。
- 錯誤訊息的英文同 TS（`Failed to connect to streamable HTTP server …`、`Failed to load tools from server …`），網址不帶 query，這一列的秘密換成 `[redacted]`。
- 掉線：transport 關了，或呼叫端判斷線（`Live::lost`）。收一代時 rmcp 對有 session 的 server 送 `DELETE` 刪掉 session。
- stdio：握手、列工具、指引檢查的訊息同 HTTP，只是開頭是 `Failed to connect to stdio server …`；起行程到列完工具最久 30 秒（`STDIO_STARTUP_TIMEOUT`），逾時殺掉子行程、回連線失敗。HTTP 沒有這個上限。
- 池經 `Http`（`pool::Connector`，名字是歷史遺留，兩種連線都管）拿一代，同一個池的每一代共用一個客戶端（HTTP 用）。

## 監督者

`supervisor.rs` 照 TS `supervisor.ts`：

- 退避：第一次等 `initialDelayMs`，每次連續失敗加倍，上限 `maxDelayMs`；同一次中斷最多 `maxAttempts` 次，超過就放棄。
  連上之後撐過 `maxDelayMs` 才掉線，失敗次數歸零。`reconnect.enabled: false` 時第一次失敗或掉線就停。
- 收連上過的一代最多等 5 秒（`GENERATION_CLOSE_TIMEOUT`，同 dsh）；等不到就停止重連，寧可停下也不讓兩代同時活著。
  stdio 的收線梯度（見〈stdio〉）預算 4.5 秒，編譯期斷言小於這 5 秒。預算只算子行程那一段，不含「等 rmcp 服務迴圈結束」；那一段卡住時，5 秒到了錯誤訊息分不出卡在哪一段。
- 關池（`Pool::close`）與停單份（`Shared::dispose`）外面再套 6 秒（`POOL_CLOSE_TIMEOUT`），各份同時收。逾時只是不再等，任務沒被取消、停止訊號已先送出。
  橋還活著時（`acquire` 的 `failOnStartupError` 路徑停單份），監督者照自己的 5 秒收完；關池時逾時放手的，接著 `serve` 回來、執行環境拆掉，被分離的任務跑不完，子行程由 `ChildGuard` 的 drop 直接 SIGKILL（見〈stdio〉）。
- 宿主結束前等橋收完：宿主主迴圈結束、`Client` 丟掉 `Bridge` 時，`Drop` 先送 `Shutdown`，再等橋的執行緒收完（旗標在 runtime 與分離的任務都收掉之後才設），最多 `CLOSE_WAIT` 5.5 秒；沒等到就在 stderr 記一行、照原結束碼結束，不改它。5.5 秒比每一份連線的收線期限 `GENERATION_CLOSE_TIMEOUT`（5 秒）與 SIGTERM→SIGKILL 梯度 `REAP_BUDGET`（4.5 秒）長（編譯期斷言），比監督行程預設的 eof grace（6 秒）短；後者只寫在註解，不斷言。`POOL_CLOSE_TIMEOUT`（6 秒）比 5.5 秒長，所以池收得慢時宿主會先逾時放行，由 `PR_SET_PDEATHSIG` 與監督行程的 session 掃描收。runtime 收掉時會等已經開始的 `spawn_blocking`（例如 HTTP 連線的主機名解析），所以連線其實都收完了，也可能白等滿 5.5 秒、記上面那一行（#2987）。等完之後把收件匣裡還沒送出去的日誌（關池時記的「有幾份沒收完」、監督者的收不乾淨）直接寫到 stderr，因為 `Client` 丟掉之後沒有人讀它。
  `Drop` 會阻塞：宿主迴圈還在跑的時候不要丟 `Bridge`。kernel 有執行期卸載服務的路，今天沒有人呼叫；日後接上，丟掉會讓宿主迴圈停最多 5.5 秒。也不能在橋自己的執行緒裡丟（會自己等自己等滿上限），今天只有 `Client` 持有，在宿主主執行緒丟。
  只有 `Pool::close` 記日誌：沒收完的份記一行錯誤，帶出是哪幾份（同一台 server 有兩份連線時 label 會重複）；`Shared::dispose` 回傳有沒有收完，呼叫端自己決定記不記。
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

## stdio

宿主收的是 TS 算好的成品（`apps/harness/src/mcp-host-stdio-row.ts` 的 `hostStdioConnection`），不重算政策、不疊自己的環境：

| 欄位 | 內容 |
| --- | --- |
| `command` | 必填，絕對路徑、不含 NUL。沙箱包過的話是包裝程式（`--exec`／`--guard`），包法與 `MCP_SYSTEM_READABLE` 留在 TS 一份。宿主只驗形狀。 |
| `args` | 字串陣列，預設空，不含 NUL。 |
| `cwd` | 絕對路徑；省略就繼承宿主的工作目錄。 |
| `env` | 必填，子行程的**整份**環境：TS 清過的父環境在前、設定的在後。宿主 `env_clear` 之後只放這一份。 |
| `credentialEnv` | **必填**（沒有憑證就給 `[]`），`env` 裡值來自憑證的名字，每個都要在 `env` 裡。漏送整列拒絕：不然會變成起不來，而不是憑證靜靜沒被遮；它抓不到「送了 `[]` 但其實有憑證」。**只有這些值進遮蔽器**，並照〈MCP 憑證值的遮蔽〉的檢查（修頭尾空白、不到 8 個字元拒收）；`PATH`、`HOME` 這類字面值不進，成功結果才不會被遮壞。 |

- 起行程：`std::process::Command`，stdin、stdout 轉成 tokio 的非阻塞管線（`tokio::net::unix::pipe`，底下是 `AsyncFd`）交給 rmcp 的 `AsyncRwTransport`；沒有新相依、沒有新 feature。
- **stderr 現在不留**（接 `/dev/null`）。原因：宿主分不出子行程印的字裡有沒有憑證值，繼承會把它原樣寫進宿主的 stderr（監督行程的日誌，多人共用主機上是共用的）；
  留下來要先過遮蔽器，這一版沒做。代價：server 起不來時，維運只看得到「Failed to connect to stdio server …」，看不到它自己印的原因。
  這不是終點，下一步（#2570 (b) 的第四張）：握手失敗或提早退出時，留 stderr 尾端有限位元組、過遮蔽器後帶進錯誤；遮不乾淨就寫明為什麼不做。
- 收線：transport 關了（stdin 跟著關）之後等子行程自己結束 2 秒，沒結束就對整組 SIGTERM，再等領頭最多 2 秒，之後對整組 SIGKILL（領頭已結束也送，收掉剩下的子孫），SIGKILL 之後等 `wait` 最多 0.5 秒（`KILL_WAIT`），合計 4.5 秒（`REAP_BUDGET`）。`Generation::close` 回來時領頭已經收掉、不留殭屍，子孫只收到訊號、不等它們結束；唯一例外是 SIGKILL 之後 0.5 秒內還沒結束（行程卡在不可中斷的睡眠），那時記一行錯誤、不再等，`wait` 由阻塞執行緒自己做完。輪詢間隔 20 ms，最壞約 4.5 秒再加兩個輪詢間隔。
- 被丟下的連線：握手完成前，子行程由連線的 future 裡的 `ChildGuard` 擁有，future 被丟下時 guard 的 drop 直接 SIGKILL 並在另一條執行緒 `wait`。握手完成後，擁有者換成背景 task（等服務迴圈結束、再照上面的梯度收）；這一代沒走 `close` 就被丟下時，`CancelOnDrop` 對服務迴圈喊停，背景 task 照梯度收，這是正常路徑（例如啟動上限在列工具中途到了、橋還活著）。橋關閉時，池裡還連著的那一代照常走 `close`，`Generation::close` 會等到子行程收掉（最多 5 秒）。沒被等的只有三類：監督者的 5 秒到了而被丟下的、沒走 `close` 就被丟下的（上一句的 `CancelOnDrop` 路徑）、`Pool::close` 自己逾時放手的；它們的背景 task 在 `serve` 回來、執行環境拆掉時被丟下，落到 `ChildGuard` 的 drop（SIGKILL，不走梯度），server 沒有機會清理自己的暫存。這是刻意的取捨：關橋不等例外路徑，最壞耗時有上限。三條路各有一條測試。
- 單行超過 16 MiB：rmcp 的行傳輸丟掉那一行（記一筆、連線不斷），server 等不到回應的那一次呼叫會等到逾時。
- **args 與 env 在主機上看得到**：同一台主機上的其他使用者看得到 `/proc/<pid>/cmdline`（args），同 uid 的看得到 `/proc/<pid>/environ`（整份 env，含憑證值）。憑證不要放進 `args`。宿主只遮 `credentialEnv` 的值；父環境裡本來就有的值照舊不遮。
- **多條 thread 共用一個子行程的前提是交出的 server 一模一樣**：stdio 的 env 由對話行程的 `scrubbedParentEnv()` 加設定裡的 env 組成。監督行程起對話行程時不設環境（`supervisor/process.rs` 的 `spawn_with` 沒有 `env`／`env_clear`），所有對話行程繼承同一份；對話行程執行期只有 HTTP 代理安裝會改 `process.env`，也是行程層級、各 thread 相同。所以今天沒有「每條 thread 不同、又過得了清洗」的環境變數，不同 thread 交出同一份設定就落在同一個池鍵。日後若有 per-thread 的環境變數要進 `scrubbedParentEnv()`，這個前提就破了，要在交出之前排除。
- **池不回收**：池的鍵含整份成品（env 含憑證值），每組「憑證 × server」各起一個常駐子行程，活到橋關閉；憑證輪替之後舊行程帶著舊值繼續活。這跟 TS 那條路（子行程跟著對話行程死）不同，宿主是整台主機共用的。處理列在 #2570 (b)：最後一個使用者放掉時收掉 stdio 那一份，或給上限。
- 子孫行程：子行程自成一個行程群組（pgid 是它的 pid），**留在宿主的 session 裡**，不自己開 session。收線的訊號與連線被丟下時的 SIGKILL 送整組，`npx` 底下的 `node` 一起收；查不到領頭狀態時只殺領頭。被 spawner 的 `--exec` 包起來的 server：spawner 是組長但不是 session 長，它的 `setsid` 回 `EPERM`，沒有控制終端時留在這個 session 裡繼續跑；呼叫端的 session 有控制終端就拒絕（結束碼 125，訊息寫明原因），因為留在裡面的 server 與它的子孫讀寫得到那個終端。判斷讀 `/proc/self/stat` 的 `tty_nr`（0 是沒有），讀不到或解不開也拒絕（另一則訊息），不開 `/dev/tty`。經監督行程起的宿主沒有控制終端；從終端機直接起宿主、再包 `--exec` 會被拒絕，要手動起請用 `setsid` 起宿主。
  - 從終端機直接跑 `cargo test` 時，`reap_收掉被_spawner_exec_包起來的整組` 會因為測試行程有控制終端而跳過（印原因）；`CI` 環境變數有設時不跳過、直接紅。要在終端機跑它：`setsid cargo test`。
  - 兩段等待都只看領頭：領頭一結束（例如讀到 EOF 就退出），組裡剩下的子孫立刻 SIGKILL，不給寬限：沒有人能再跟它們溝通，等也沒用。代價是這條路上的子孫沒有收尾的機會。
  - 宿主自己不追子孫自己再 `setsid` 的（換了 session 的收不到，也不用 cgroup：多人共用的主機不保證有權限），這種有測試釘住；只換行程群組、沒換 session 的，宿主正常收線時追不到，但宿主死掉時監督行程掃同 session 的行程會收到。
  - 領頭用 `waitid(WNOWAIT)` 判斷是否結束、不先收屍，pid 與 pgid 在自己 `wait` 之前不會被別的行程拿去用，對整組送訊號不會打到不相干的行程。前提是宿主行程裡沒有收別人子行程的呼叫（`waitpid(-1)`、`waitid(P_ALL)`、忽略 SIGCHLD）。機器守這個前提：`host/clippy.toml` 對 `nexus-host` 整個 package（含測試與 examples）禁 `libc::wait*` 與 `libc::signal`／`sigaction`，例外的呼叫點加 `#[allow]` 並寫理由（今天是 `leader_state` 的 `waitid`、組合行程的 SIGTERM handler、`tests/composition.rs` 對自己子行程的 `waitpid`，以及 `fake_conversation` 整支的 crate 層級例外，它不是宿主）。另有一支測試看測試行程自己的 SIGCHLD 沒被忽略、領頭結束後一直是殭屍。兩者都擋不到：經相依呼叫的收屍（例如 spawner 的 `supervisor::process::reap` 用 `waitid(P_ALL)`）、起宿主的行程把 SIGCHLD 設成忽略後 exec 繼承下來的處置。
  - 宿主死了（崩潰、被殺，或讀到 EOF 後橋 5.5 秒內沒收完、放行結束）時沒有人替它跑上面的收線：監督行程起宿主時讓它自成 session，宿主結束、還沒收屍時掃 `/proc` 找 session 等於宿主 pid 的行程，各送 SIGKILL（用 `pidfd`，送之前再核一次還是這個 session 的；上限 8 輪，到上限記稽核 `event:"sweep"`）。宿主死時領頭由 `PR_SET_PDEATHSIG` 與這次掃描兩邊搶：領頭可能在掃之前就已死，稽核的 `signalled` 不一定有領頭。要走到這條，子行程不能自己開 session，所以宿主起子行程只開組、不 `setsid`。監督行程被殺時沒有人掃，領頭靠 `PR_SET_PDEATHSIG` 隨之死，子孫不一定收得到；自己再 `setsid` 的子孫也收不到。
  - `PR_SET_PDEATHSIG`（SIGKILL）宿主起每個 stdio server 時都設，包不包 spawner 一樣（spawner 的 `--exec`、`--guard` 設的也是 SIGKILL，同一個行程只有一個設定，互不衝突）。設在 exec 之前，設好再核一次父行程還是宿主；包了 spawner 的 server 因此在宿主 exec 到 spawner 自己設之間也沒有空窗。
  - 它綁的是**起行程的那條執行緒**，不是宿主行程：產品碼只有橋的執行緒（`nexus-host-mcp`）起 stdio server，這條執行緒在 `Pool::close` 收完線、送出 `Closed` 之後才結束，所以橋自己收線時不會被它搶先殺；宿主讀到 EOF 正常結束時，`Bridge` 的 drop 會等橋收完（最多 5.5 秒）再讓宿主結束，所以這條路上收線梯度跑得完；等不到（池收得慢、`POOL_CLOSE_TIMEOUT` 6 秒比它長）才由宿主結束後的 `PR_SET_PDEATHSIG` 殺領頭、掃描收子孫。
  - 界線：只殺領頭，子孫靠監督行程掃 session，沒有監督行程（直接起宿主、測試）就留著；領頭是 set-user-ID、set-group-ID 或帶 capability 的執行檔時，exec 會清掉這個設定；自己 daemonize（fork 之後原行程退出）的，留下來的不是宿主的直接子行程，不受保護。
  - `panic = "abort"` 只在 release：出貨的宿主在橋的執行緒上 panic 是整個宿主結束；dev 與測試建置是 unwind，只有那條執行緒結束，領頭同樣被殺。
  - 子行程不在宿主那一組裡：終端機的 Ctrl-C、監督行程對宿主那一組送的訊號都打不到它；橋在宿主結束前跑完 `close`、連線的 guard 被 drop，起它的橋執行緒結束時（`PR_SET_PDEATHSIG` 殺領頭），或宿主結束時監督行程掃同 session 的行程時才會收。
- 池的鍵：整份成品（含 `env` 的值）；換了憑證是另一份，`credentialEnv` 的順序與重複不影響。
- 「哪幾個名字是憑證」由 `mcp-host-row-service.ts` 判斷：`env` 裡寫成 `{ credential }` 的名字進 `credentialEnv`，值是修過頭尾的憑證。

## 跟 TS 的差距

- stdio 的探活在宿主做（〈橋〉），TS 那一側的 `probeLiveness` 在宿主路徑上沒有作用：它探的是門面的 `listTools`，回 open 當下的清單，不送到 server。
- **session 過期**：宿主比 TS 與 dsh 多做一步，見〈橋〉。TS 連上之後收到 404 只是該次呼叫失敗（連線當下的 404／405 也直接失敗，沒有 SSE 可退，`packages/nexus-plugin-mcp/src/connection.ts` 的 `openClient`），
  它的 SDK 不關 transport、不觸發 `onclose`（`@modelcontextprotocol/client` 2.3.1 `dist/index.mjs:5738-5790`），掉線只認 `onclose`（`:434`）；所以舊協定的 server 忘掉 session 之後，TS 每次呼叫都失敗、不重連。
  dsh 的 mcp-client 也只看 `onclose`（`packages/mcp/mcp-client/src/connection.ts:292-294`、`generation.ts:45-48`，`8bd0733`），沒有任何地方認 404 或 session 過期。
- 對話行程那一側的列由 harness 的 `mcp-host-row-service.ts` 產生（`MCP_HOST_ROW_SERVICE`，包 `hostHttpConnection`／`hostStdioConnection`，沒有斜線的 `command` 照 `PATH` 解成絕對路徑）：沒送 `credentialHeaders` 的 HTTP 列，帶任何 header 時在宿主這裡整列拒絕（見〈設定〉）。
- 設定：`approval` 整列拒絕（TS 收下、不放進池的鍵）；`url` 只收 `http:`／`https:`（TS 只要求非空字串）。
- 帶帳號或密碼的網址：宿主解設定時就拒；TS 收下設定，連線時才失敗（Node 的 `fetch` 不收帶帳密的網址）。
- 連線之後的錯誤：TS 的工具呼叫錯誤、`tools/list` 錯誤與重連日誌也遮網址的 query（`withUrlScrubbing`）：query 的整串與每個值（原樣、解碼後）進遮蔽器，同宿主 `secrets()`，只差不到 8 個 code point 的值不收（整串、原樣、解碼後各自算，細節與後果見 `docs/credentials-file.md`〈收集〉）。宿主收 query 值讀碼可見（`config.rs` 的 `secrets()`）；沒量的是宿主每一條錯誤出口是否都過 `scrub`。TS 這邊 resources 的錯誤（`read_mcp_resource`、`list_mcp_resources`）還沒遮。
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
