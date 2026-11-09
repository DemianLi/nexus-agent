# Rust MCP client 選型（#2570 第 1 步）

#2570 第 1 步。D267 派 dev-rs 研究：MCP 連線池搬進 Rust 宿主時，client 用哪個 crate，或不用 crate（#1827 D267，派工見 #2570 issuecomment-6740532780）。只寫研究文件，不改產品碼、不下載 crate。

讀碼基準：nexus `origin/develop` `88010018`；dsh `git show 8bd0733:`（D246）；TS SDK 讀的是主 checkout 已裝的 `@modelcontextprotocol/client`／`core` `2.3.1`。crate 的資料只讀 docs.rs、crates.io、GitHub 的線上頁面，日期 2026-11-09。沒有編譯、沒有執行、沒有量測。

## 結論

**推薦官方的 `rmcp`（3.9.0），跑在宿主裡另開的一條執行緒、一個 tokio 單執行緒 runtime 上，用 channel 加 eventfd 接回宿主的輪詢內核。** 宿主的主迴圈照舊單執行緒、不碰 async；tokio 只活在 MCP 那條執行緒裡。

理由一句話：今天的行為裡最難的兩件，「兩代協定與自動協商」和「新協定的 `input_required` 一輪一輪送」，只有 rmcp 與一個 alpha 版的 crate 完整接得住；自己在輪詢內核上寫，HTTP、TLS、SSE 解析與兩代協定都要自己扛，而協定在 `2026-07-28` 剛大改過一次（§四之零）。

| 要拍板的 | 推薦 | 見 |
| --- | --- | --- |
| K：宿主裡接受 tokio，但只限 MCP 那條執行緒 | **是** | §五、§六 |
| L：拿掉「Streamable HTTP 回 404／405 退回舊式 SSE」，當成宣告的退步 | **是**（照 dsh） | §四之一、§六 |
| J：沒宣告 `sandbox` 的 stdio 伺服器不經常駐 spawner，宿主照今天的做法起單次模式 `--guard`／`--exec`（`--guard` 包不了的照今天直接起） | **是**；這是改 D248 B 的落點 | §三之五、§六 |

跟選型無關、但不管選哪條都要做的：宿主要加完整的 JSON 實作（今天的 `json.rs` 不收小數，§三之三），宿主的執行檔要跟 spawner 分開，不讓 spawner 的相依跟著變多（§三之四）。

## 一、搬家之後誰做什麼

邊界文件已定：宿主與對話行程之間只傳資料，宿主一次只跑一輪 `tools/call`，`input_required` 當資料回給對話行程，問人與下一輪由對話行程發起（`.docs/rust-host-boundary-shape-2568-2026-11-09.md` §一）。所以今天 `packages/nexus-plugin-mcp` 做的事分成三堆，**只有第一堆是 crate 要接住的**。

### 宿主那一半：crate 要接住

| 今天的行為 | 出處 | 搬家後 |
| --- | --- | --- |
| 握手、版本協商 `auto`（先試新協定、再試舊協定）；SSE 走 `legacy` | `packages/nexus-plugin-mcp/src/connection.ts:269`、`:231` | 宿主 |
| 兩代協定：新協定 `2026-07-28`（SDK 叫 `modern`）與舊協定到 `2025-11-25`。TS SDK `2.3.1` 兩代都支援 | `connection.ts:277`、`tool-call.ts:72`；`@modelcontextprotocol/core@2.3.1` 的 `SUPPORTED_PROTOCOL_VERSIONS` 列到 `2025-11-25`，dist 另有 144 處 `2026-07-28`（不含 sourcemap） | 宿主 |
| `tools/list` 分頁走完、同一個 cursor 再出現就停、空名字略過 | `connection.ts:140-160` | 宿主 |
| `tools/call`：帶逾時（預設 60 秒）與取消訊號；取消時 SDK 送 `notifications/cancelled` | `tool-call.ts:96-105`；`index.ts:52-53` | 宿主（取消由橋的 `Cancel` 框觸發） |
| 新協定的反問：`_meta` 宣告 client 能力 `elicitation: {form, url}`、`allowInputRequired`，下一輪帶 `inputResponses` 與 `requestState` | `tool-call.ts:78-80`、`:103`、`:188-217` | 宿主送一輪、把 `input_required` 原樣回；下一輪由對話行程帶 `inputResponses` 再發 |
| `execution.taskSupport: 'required'` 的工具當場拒絕，不送請求 | `connection.ts:55-56`、`:163-170` | 宿主或對話行程都可，放宿主省一趟 |
| 資源：`resources/list`、`resources/templates/list`、`resources/read`；沒帶 cursor 時要走完所有頁 | `index.ts:684-716`；`hub.ts:22-23` | 宿主 |
| 新協定的 server 宣告 `tools.listChanged` 時，開一條常駐的 `subscriptions/listen`；收到的通知不處理 | `connection.ts:276-286` | 宿主（之後可經橋的 `Event` 框往外推） |
| 探活：呼叫逾時或被停止之後，背景送一次 `tools/list`；新協定拿掉了 `ping` | `connection.ts:324-337` | 宿主 |
| Streamable HTTP 回 404／405 就退回 SSE，先試原網址，再試把結尾的 `mcp` 換成 `sse` | `connection.ts:208-258`、`:310-316` | 宿主 |
| server 指引：`initialize` 回的 `instructions`，超過位元組上限就拋 | `connection.ts:63`、`:375-385` | 宿主 |
| `onclose` 判斷一代斷線、交監督者重連 | `connection.ts:421-438` | 宿主 |

今天**沒有用**的：prompts、sampling、roots、progress 通知、資源訂閱（`resources/subscribe`）。client 握手時不宣告任何能力（`connection.ts:269` 只給 `versionNegotiation`），所以舊協定的 server 不會發 `elicitation/create` 過來；新協定的反問也只收 `elicitation/create`，sampling、roots 一律拒（`tool-call.ts:224-228`）。查法：對 `packages/nexus-plugin-mcp/src` 非測試檔 grep `prompts|getPrompt|listPrompts|createMessage|sampling|roots|progress|subscribeResource|setRequestHandler|setNotificationHandler`，只命中 `connection.ts:282` 的 `promptsListChanged: false` 與 `tool-call.ts:225` 的註解。插件以外沒有別的地方 import `@modelcontextprotocol/client`（全 repo 非測試、非 fixture 的 `.ts` 只有 `connection.ts`、`index.ts`、`tool-call.ts`；`hub.ts` 只在註解提到它）。

### 留在對話行程：crate 不必管

| 今天的行為 | 出處 | 為什麼留下 |
| --- | --- | --- |
| 參數照 server 的 JSON Schema 再驗一次（SDK 的驗證器） | `tool-call.ts:81`、`:89-94` | 驗證的結果是給模型看的句子，跟 NexusTool 的定義綁在一起 |
| 反問那一輪 `outputSchema` 的驗證 | `tool-call.ts:74-77`、`:114-120` | 同上 |
| 結果轉成 `NexusToolResult`：投影、`artifact`、外部內容標記 | `tool-call.ts:16-17`；`project-content.ts`、`untrusted-mark.ts` | 跟模型看到的句子綁在一起，由 `mcp-migration.test.ts` 逐字釘住 |
| 問人（`exec.interrupt`）、核可 | `tool-call.ts:188-217`；`approval.ts` | 本來就是對話的事 |
| 資源工具與 server 指引的提示詞 | `hub.ts` | 同上 |

**這是一個設計主張**：JSON Schema 驗證留在 TS，宿主就不必拉 Rust 的 JSON Schema crate，選型的需求跟著縮小。代價是工具描述（含 schema）要經橋傳一次給對話行程；它今天就已經是資料（`Listed.tools`，`connection.ts:408-411`）。

### 宿主自己寫：跟選哪個 crate 無關

下面這些不管選哪條路都要在宿主重寫，不算任何候選的缺口：

- 池：鍵是整份設定加 elicitation 旗標、舊的一份留到行程結束、非建立者最多等 5 秒（`pool.ts:1-35`、`:49`）。
- 監督者：500 ms 起加倍、上限 30 秒、同一次中斷最多 10 次（`supervisor.ts:3-8`）。
- stdio 子行程的環境：清洗過的父環境疊設定的 `env`，憑證引用在建連線那一刻代入（`connection.ts:187-189`；`credentials.ts`）。
- 沙箱與守護包裝（`index.ts:410-440`）：見 §三之五。

## 二、dsh 怎麼做（`8bd0733`）

**dsh 沒有 Rust 的 MCP client。** 查法：`git ls-tree -r --name-only 8bd0733` 找 `.rs` 與 `Cargo.toml`，零命中；`native/` 底下只有 README 與 `native/system`。

它在 host 行程裡用 TS 的官方 SDK，版本釘死：`@modelcontextprotocol/client` `2.2.0`（`packages/mcp/mcp-client/package.json`）。

- **傳輸**：stdio 與 Streamable HTTP 兩種，沒有 SSE 退回；stdio 由 SDK 自己 spawn，環境是清洗過的父環境疊設定的（`packages/mcp/mcp-client/src/transport.ts:21-45`）。
- **client**：`capabilities: {}`、`versionNegotiation: { mode: 'auto' }`；`listChanged.tools` 關掉自動刷新，改成收到通知就自己重新同步工具（`packages/mcp/mcp-client/src/connection.ts:284-286`）。
- **工具呼叫**：`callTool` 帶 `AbortSignal.any([執行的訊號, 這一代的訊號])` 與 `toolCallTimeoutMs`；`taskRequired` 的工具拋同一句（`packages/mcp/mcp-client/src/tools.ts:154-157`、`:303-306`）。
- **資源**：server 沒宣告 `resources` 就直接回空頁，不送請求（`packages/mcp/mcp-client/src/connection.ts:351-375`）。

dsh 這樣做的理由：整棵樹在同一個 Node 行程，官方 SDK 就在手邊，協定的兩代、傳輸、取消都由 SDK 接住；它付的代價是每台 stdio server 由 SDK 直接 spawn，沒有沙箱這一層。

「比不出高下時照 dsh」在這裡最接近的對應，是**用官方 SDK**。

## 三、宿主的限制

### 三之一、沒有 async runtime

宿主是單執行緒、輪詢推進的內核，不用 async runtime（`native/sandbox-spawner/src/kernel/mod.rs:1-10`）。插件要把長工作寫成回 `Pending` 的狀態機（`kernel/deadline.rs` 的 `Step`）。#2569 的設計文件把「要不要 tokio」明寫推給本卡（`.docs/rust-kernel-2569-2026-11-09.md:102`、`:109`）。

### 三之二、stdio 的 fd：照設計文件是兩條 `AF_UNIX` 連線

照設計文件 §六 的 (a)，MCP stdio 伺服器經宿主自己起的常駐 spawner 起（`.docs/rust-host-design-2568-2026-11-08.md` §六）。經常駐 spawner 起的子行程，它的 stdin、stdout 各是一條宿主連進 spawner 監聽 socket 的 `AF_UNIX` 連線：每條連線先寫 8 bytes 標頭（id、fd 編號），之後就是資料；spawner 把收到的那一端設成阻塞、交給子行程當 fd 0／1（`native/sandbox-spawner/src/main.rs:25-27`、`:425-449`）。

所以宿主手上是**兩條已連上的 socket**：一條只寫（子行程的 stdin）、一條只讀（子行程的 stdout）。候選要能吃「外部給的 reader 與 writer」，不能只會自己 spawn。§三之五 會講到這條路有一個問題，另一條路（單次模式）給的是普通的 pipe；兩條路都只要候選吃得了外部的 reader 與 writer。

### 三之三、宿主的 JSON 接不住 MCP 的酬載

宿主的 `json.rs` 只收整數（`i64`），不收小數與指數，巢狀最多 32 層（`native/sandbox-spawner/src/json.rs:1-10`）。MCP 的參數、結果、JSON Schema 都會有小數，schema 的巢狀也常超過 32 層。**不管選哪條路，宿主都要加一個完整的 JSON 實作**（`serde_json` 或等價的）；橋上的 `payload: Json`（邊界文件 §一）也受同一條限制。

### 三之四、相依與出貨

`nexus-host` 與 `nexus-sandbox-spawner` 在同一個 crate（`native/sandbox-spawner/src/bin/nexus-host.rs`），今天的相依只有兩個，版本用 `=` 釘死（`native/sandbox-spawner/Cargo.toml:8-10`）。出貨的 SBOM 與 `licenses/sandbox-spawner/` 都按「連進執行檔的 crate」計（`docs/operations.md:1312`、`:1317`）。

加 MCP client 會把相依從兩個變成幾十個。建議把宿主拆成自己的 workspace member，或至少用 feature 關起來，讓 seccomp 底下的 spawner 執行檔維持最小。這一項跟選哪個候選都有關，只是多寡不同，所以相依數要算進比較表。

### 三之五、#1946 的「要套沙箱」宣告欄位

欄位在 `mcpStdioConnectionSchema` 的 `sandbox`（`packages/nexus-plugin-mcp/src/index.ts:116-128`）：鍵存在就套，`{}` 也算；`readable`、`writable` 另外列；沙箱不可用時不連線。今天的做法是 `wrapStdio`（`index.ts:410-440`）把 command 與 args 換成包過的，再交給 SDK 的 `StdioClientTransport` 起：

- 宣告了 `sandbox` 的，換成 spawner 的**單次模式** `--exec`：上 Landlock 與 seccomp 再 exec（`apps/harness/src/mcp-sandbox.ts:1-3`、`:96`；`native/sandbox-spawner/src/main.rs:746`、`:786`）。
- 沒宣告的，換成單次模式 `--guard`：**不上沙箱、不裝 seccomp**，只設 PDEATHSIG 讓它跟著呼叫端走（`mcp-sandbox.ts:173-183`；`main.rs:808-812`）。只有 Linux、找得到 spawner、command 是 ELF 或 `#!` 三件事都成立才包；任一不成立就原樣交給 SDK 直接起（`mcp-sandbox.ts:171`、`:178-180`；`index.ts:426`）。

**今天的 MCP 不走常駐 spawner。** 這跟設計文件 §六 的 (a) 有一個衝突：常駐 spawner 在啟動時裝一次 seccomp，之後 fork 的子行程全部繼承，`AF_INET` 一律擋掉（`main.rs:18-20`；`protocol.rs:13-17` 的 `FullAccess` 也是「seccomp 照樣繼承（網路照擋）」）。所以**沒宣告 `sandbox` 的 stdio 伺服器經常駐 spawner 起，就連不到網路**。本產品的內部資料全走 MCP（#949），stdio 伺服器去連內網 API 是常態，這是行為退步。寫成 §六 是非題 J。

設定的解析留在 TS（schema 在那裡），對話行程把整列 MCP 設定交給宿主；宿主讀 `sandbox` 鍵決定怎麼起。**這一段完全在 crate 之外**：crate 只拿到一對 reader 與 writer。驗收要的那條測試釘的是宿主的這段路徑，不是 crate。

## 四、候選

### 四之零、協定現況

規格目前的版本是 `2026-07-28`（https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning ）。這一版跟 `2025-11-25` 差很多（https://modelcontextprotocol.io/specification/2026-07-28/changelog ）：

- 拿掉 `initialize` 握手，改成每個請求在 `_meta` 帶協定版本，新增 `server/discover`（SEP-2575）。
- `subscriptions/listen` 取代 HTTP 的 GET 端點與 `resources/subscribe`；拿掉 `ping`（SEP-2575）。
- 多輪請求：server 回 `input_required`，client 帶 `inputResponses` 重送，取代 server 主動發的 `elicitation/create`、`sampling/createMessage`、`roots/list`（SEP-2322）。
- Streamable HTTP 拿掉 session 與 SSE 續傳；舊式 HTTP+SSE 傳輸標為 Deprecated（SEP-2596）。

所以 client 要同時講兩代：新的伺服器講 `2026-07-28`，舊的還在 `initialize`。TS SDK `2.3.1` 兩代都講，nexus 今天靠它的 `auto` 協商（§一）。

### 四之一、完整的 client SDK

| | `rmcp` 3.9.0 | `rust-mcp-sdk` 2.0.0 | `turbomcp` 3.6.0 | `turbomcp` 4.0.0-alpha.5 |
| --- | --- | --- | --- | --- |
| 出處 | 官方（`modelcontextprotocol/rust-sdk`） | rust-mcp-stack | Epistates | Epistates |
| 發版 | 2026-11-05；10 月起發了四版 | 2026-08-27 | 2026-10-01 | 2026-09-14，alpha |
| 授權 | Apache-2.0 | MIT | MIT | MIT |
| 下載（crates.io 總數） | 約 4,680 萬 | 約 34 萬 | 約 4.3 萬 | 同左 |
| 協定版本 | `2024-11-05` 到 `2026-07-28` 五版 | 只有 `2026-07-28`；舊版要用 1.x | 到 `2025-11-25` | `2025-06-18`、`2025-11-25`、`2026-07-28` |
| 兩代自動協商 | 有：`Initialize`／`Discover`／`Auto` | 沒看到 | 不適用 | 有：`Auto`／`Modern`／`Legacy` |
| `subscriptions/listen` | 有 | 有 | 無 | 有 |
| `input_required` 一次一輪 | 有：`call_tool_once` | 有（runtime 自動跑多輪；一次一輪的入口沒查） | 無 | 有 |
| 吃外部的 reader 與 writer | 有：`(R, W)`，tokio 的 `AsyncRead`／`AsyncWrite` | **無**：只會自己 spawn，或用本行程的 stdio | 有：`from_raw` | 有：`LineTransport::new` |
| Streamable HTTP | 有（reqwest，或自己實作 HTTP client 的 trait） | 有 | 有 | 有 |
| 舊式 HTTP+SSE | **沒找到** | 有 | 沒查 | 沒查 |
| 取消、逾時 | 有：逾時自動送 `notifications/cancelled`；`call_tool_once` 的 future 被丟掉就送取消 | 有取消通知；逾時沒查 | 沒查 | 沒查 |
| tokio | 非 optional；service 用 `tokio::spawn` | 非 optional，`full` | 非 optional | 非 optional |

出處（都是線上頁面，GitHub 引用固定在 SHA）：

- `rmcp`：版本與下載 https://crates.io/api/v1/crates/rmcp ；以下 `S` = `modelcontextprotocol/rust-sdk` `f2b0ddf1`（main，2026-11-08），路徑都在 `crates/rmcp/` 底下：
  - tokio 非 optional：`Cargo.toml:54`；`client` feature 只多拉 `tokio-stream`：`:140`；傳輸的 feature：`:176-196`。
  - 協定常數：`src/model.rs:169-176`。
  - 協商模式：`src/service/client.rs:707-722`（`Auto` 先送 `server/discover`，10 秒沒回就退回 `initialize`）。
  - `listen`：`src/service/client.rs:1288`；`call_tool_once`：`:1473-1480`、`:2138-2145`。
  - `(R, W)`：`src/transport/async_rw.rs:24-33`。
  - 傳輸清單只列 stdio 與 Streamable HTTP：`src/transport.rs:7-10`；`client-side-sse` 是解析 Streamable HTTP 回應裡的 SSE，不是舊式 SSE 傳輸：`Cargo.toml:173-174`。
  - `tokio::spawn`／`spawn_local`：`src/service.rs:1344-1345`。
- `rust-mcp-sdk`：https://crates.io/api/v1/crates/rust-mcp-sdk ；只實作 `2026-07-28`：`rust-mcp-stack/rust-mcp-sdk` `605bcca` `README.md:20-44`；stdio 只有自己 spawn 與本行程 stdio：`crates/rust-mcp-transport/src/stdio.rs:61-106`、`:178-240`；tokio `full`：`7975d85` `Cargo.toml:30`。
- `turbomcp`：https://crates.io/api/v1/crates/turbomcp-client ；3.6.0 `1f2e4c9` `crates/turbomcp-stdio/src/transport.rs:223`、`:272`；4.0 alpha `a9cdeab` `crates/turbomcp-client/src/client.rs:95-114`（協商）、`crates/turbomcp-service/src/io.rs:74-169`（`LineTransport`）。

其他還在 crates.io 上的（`mcp-protocol-sdk`、`async-mcp`、`mcpr`、`mcp-client`、`ultrafast-mcp` 等）最後一版都在 2025 年，停在舊規格，不列入比較。

`rust-mcp-sdk` 出局：吃不了外部的 reader 與 writer（§三之二），也講不了舊協定。`turbomcp` 3.6 出局：講不了新協定。`turbomcp` 4.0 能力上跟 rmcp 打平，但它是 alpha，社群小兩個數量級，留作備案。

### 四之二、只用協定型別，自己在輪詢內核上寫 client

| crate | 相依 | 涵蓋的版本 | 新舊兩代同時用 |
| --- | --- | --- | --- |
| `rust-mcp-schema` 2.0.0 | 只有 serde、serde_json | `2024-11-05` 到 `2026-07-28` | **不行**：README 寫 `2026_07_28` 與 `2025_11_25` 兩個 feature 互斥（`rust-mcp-stack/rust-mcp-schema` `5bcf7fb` `README.md:98`；沒編譯驗證） |
| `turbomcp-protocol` 4.0.0-alpha.5 | serde、serde_json、`turbomcp-core`（no_std） | `2025-06-18`、`2025-11-25`、`2026-07-28` | 可以，三個獨立模組（`a9cdeab` `crates/turbomcp-protocol/src/lib.rs:8-61`）；alpha |
| `rmcp::model` | 整個 rmcp 的必拉相依，含 tokio | 五版，一套型別 | 可以；只用型別不必起 runtime，但 tokio 照樣編進去 |

這條路的型別有現成的，**難的不在型別**：JSON-RPC 的請求配對、逾時、取消、兩代協商、`listen` 的常駐串流，加上 HTTP/1.1、chunked、SSE 解析、TLS（內網常見自簽 CA），都要在輪詢內核上用 `Pending` 狀態機寫（§三之一）。stdio 那一半不難；HTTP 那一半是一個小型 HTTP client 的工作量。

## 五、比較與推薦

### 三條路

- **(A) rmcp，跑在另一條執行緒的 tokio 上。** 宿主開一條執行緒，裡面一個 `current_thread` runtime 跑所有 MCP 連線。內核那邊的 MCP 插件把請求丟進 channel、回 `Pending`；MCP 執行緒做完把結果丟回來，寫一下 eventfd 叫醒內核的 poll。stdio 的兩個 fd 包成 tokio 的 `AsyncRead`／`AsyncWrite` 交給 `(R, W)`；新協定一輪用 `call_tool_once`，`input_required` 原樣回給對話行程（邊界文件 §一）；橋的 `Cancel` 框對到丟掉那個 future。
- **(B) 只用型別，在輪詢內核上自己寫。** 見 §四之二。
- **(C) turbomcp 4.0 alpha，形狀同 (A)。** 能力跟 rmcp 打平。

| 標準 | (A) rmcp＋專屬執行緒 | (B) 自己寫 | (C) turbomcp 4 alpha |
| --- | --- | --- | --- |
| 正確性 | 官方 SDK，兩代協定、協商、`listen`、`input_required` 都有；跟 TS 那份同一個組織維護 | 全部自己對規格；協定 7 月才大改，之後還會改 | 能力同 (A)，alpha |
| 失敗與恢復 | release 建置是 `panic = "abort"`，MCP 執行緒 panic 等於宿主死（`kernel/mod.rs:30`；`native/sandbox-spawner/Cargo.toml:12-14`），跟內核插件 panic 一樣；卡住的連線卡在 MCP 執行緒，不卡內核 | 一條連線的狀態機出錯，影響的就是內核本身 | 同 (A) |
| 效能 | 多一條執行緒、一次 channel 來回；MCP 呼叫本來就是毫秒到秒級 | 沒有 runtime | 同 (A) |
| 維護 | 跟著官方升版；`rmcp` 10 月起發了四版，要釘版本、定期升 | 規格每改一次都要自己改；HTTP、TLS 也要自己維護 | 跟著 alpha 的 API 改 |
| 相依 | 多 tokio、reqwest（含 hyper、TLS）等，數量沒量（§八） | 只多 serde、serde_json 與一個 TLS 實作 | 跟 (A) 同一個量級 |
| 產品需求 | 內網、多人共用：沒有新的對外面；TLS 的 CA 怎麼設要跟著 reqwest 的設定走（沒核，§八） | 同左，CA 自己處理 | 同 (A) |
| 現有基座 | 內核不動，多一個「外部事件叫醒內核」的入口 | 內核不動，插件很大 | 同 (A) |

### 選 (A)，好在哪

- **正確性的差距最大。** 兩代協定加自動協商，是今天行為裡的必需品（§一），也是自己寫最容易漏的地方；rmcp 跟 nexus 今天用的 TS SDK 同一個組織出、同一套語意（`Auto` 對 `auto`、`call_tool_once` 對 `allowInputRequired` 的一輪）。這也是「比不出高下時照 dsh」最近的對應：dsh 用官方 SDK（§二）。
- **tokio 被關在一條執行緒裡。** #2569 選單執行緒輪詢，理由是「一支插件出錯不會拖住宿主」（`.docs/rust-kernel-2569-2026-11-09.md:101`）。MCP 執行緒卡住時內核照跑，這個性質留得住；內核也不必改成 async。
- **代價寫清楚**：相依多很多、宿主不再是單一執行緒、MCP 執行緒 panic 一樣帶走宿主。第一項用「宿主跟 spawner 分開出貨」（§三之四）圈住；第二項靠 tokio 只活在 MCP 那條執行緒、內核照舊單執行緒輪詢圈住（上一點）；第三項跟內核插件 panic 是同一條規則。

(B) 只有在「宿主不准有 tokio」是硬限制時才值得，那時的工作量主要在 HTTP 那一半。(C) 留作備案：rmcp 哪天停在舊版或改授權，換它的成本最低，因為形狀一樣。

## 六、要拍板的題目

是非題，接在 #2568 的 A～I 後面。

| # | 題目 | 推薦 | 理由 |
| --- | --- | --- | --- |
| J | 沒宣告 `sandbox` 的 stdio 伺服器，宿主照今天的做法起單次模式 `--guard`（包不了的照今天直接起），宣告了的起 `--exec`；不經宿主的常駐 spawner？ | **是** | 常駐 spawner 的子行程繼承 seccomp，連不到網路（§三之五）；單次模式的 seccomp 是 exec 前才在子行程裝，宿主自己不帶 filter，設計文件 §六「宿主不能當 spawner」的理由不受影響。代價：宿主要 fork/exec，PDEATHSIG 綁的是宿主，宿主一死 MCP 伺服器跟著死，跟 survival 文件 §三（`.docs/rust-host-survival-2568-2026-11-08.md:80`、`:88`）一致。答否的話，常駐 spawner 要多一種不裝 seccomp 的起法，等於拆掉它的前提 |
| K | 宿主裡接受 tokio，限 MCP 那一條執行緒，內核照舊單執行緒輪詢？ | **是** | §五 |
| L | 拿掉「Streamable HTTP 回 404／405 退回舊式 SSE」，寫成宣告的退步？ | **是** | rmcp 沒有舊式 SSE 的 client 傳輸（§四之一）；規格已標 Deprecated；dsh 也只有 stdio 與 Streamable HTTP（§二）。答否的話，要自己實作 rmcp 的 `Transport` trait 補一個 SSE client |

J 改的是 D248 B 在邊界文件 §一 的落點（「沙箱與守護由宿主自己用它那支 spawner 做」）：仍然由宿主自己做、用 Rust 寫，只是用單次模式，不用常駐的那一支。答是的話，設計文件 §六、邊界文件 §一、#2570 正文第 3 步要跟著改，PM 審過再動。

L 要先核一件事：今天有沒有部署方的 MCP 設定靠 SSE 退回。這要看部署端的設定，本篇沒查（§八）。

## 七、驗收怎麼量

- **上線的請求與模型看到的句子**：`apps/harness/src/mcp-migration.test.ts` 對 `mcp-migration.baseline.json` 逐字釘住（#2353，`tool-call.ts:3-4`）。Rust 端要重現同一份 wire，這份基準就是對照。
- 其他項照 #2570 的驗收。

## 八、沒讀、沒量、沒核的

- **相依數沒量。** rmcp 開 `client`、`transport-async-rw`、`transport-streamable-http-client-reqwest` 之後的傳遞相依有幾個、授權有哪些，沒查：lib.rs 回 403，沒跑 `cargo tree`（不准下載）。要定 SBOM 的影響，得照規則先報 PM，由 demian 核可下載。
- **最小 feature 組合是讀 `Cargo.toml` 推出來的**，沒有編譯過。
- **外部 fd 包成 tokio 的 `AsyncRead`／`AsyncWrite`**（`tokio::net::UnixStream::from_std` 或 `tokio::net::unix::pipe`）能不能直接交給 `(R, W)`：照型別推論可以，沒驗證。
- **reqwest 的 TLS 怎麼信任內網自簽 CA**，沒核。
- **rmcp 有沒有舊式 SSE client**：只讀了 `transport.rs` 的傳輸表與 `Cargo.toml` 的 feature，寫「沒找到」，不寫「確定沒有」。
- **`rust-mcp-schema` 兩代 feature 能不能同時開**：只讀 README，沒編譯。
- **`rust-mcp-sdk`、`turbomcp` 的 sampling、roots、ping、逾時、進度**：沒逐項查；兩者已因別的理由出局或列備案，不影響推薦。
- **2026-07-28 與舊版互通的規格段**（`basic/versioning` 的 backward compatibility）沒讀。
- **部署方有沒有靠 SSE 退回的 MCP 設定**：沒查（題 L）。
- 線上資料由子代理讀，推薦那個候選的協定常數、`(R, W)`、tokio 必拉、`Auto` 協商、`call_tool_once`、傳輸清單、`tokio::spawn` 由主 session 親自對 raw 原始碼再核過；其他候選的數字只經子代理。
