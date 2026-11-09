# Rust MCP client 選型（#2570 第 1 步）

#2570 第 1 步。D267 派 dev-rs 研究：MCP 連線池搬進 Rust 宿主時，client 用哪個 crate，或不用 crate（#1827 D267，派工見 #2570 issuecomment-6740532780）。只寫研究文件，不改產品碼、不下載 crate。

讀碼基準：nexus `origin/develop` `88010018`；dsh `git show 8bd0733:`（D246）；TS SDK 讀的是主 checkout 已裝的 `@modelcontextprotocol/client`／`core` `2.3.1`。crate 的資料只讀 docs.rs、crates.io、GitHub 的線上頁面，日期 2026-11-09。沒有編譯、沒有執行、沒有量測。

## 結論

（待補）

## 一、搬家之後誰做什麼

邊界文件已定：宿主與對話行程之間只傳資料，宿主一次只跑一輪 `tools/call`，`input_required` 當資料回給對話行程，問人與下一輪由對話行程發起（`.docs/rust-host-boundary-shape-2568-2026-11-09.md` §一）。所以今天 `packages/nexus-plugin-mcp` 做的事分成三堆，**只有第一堆是 crate 要接住的**。

### 宿主那一半：crate 要接住

| 今天的行為 | 出處 | 搬家後 |
| --- | --- | --- |
| 握手、版本協商 `auto`（先試新協定、再試舊協定）；SSE 走 `legacy` | `packages/nexus-plugin-mcp/src/connection.ts:269`、`:231` | 宿主 |
| 兩代協定：新協定 `2026-07-28`（SDK 叫 `modern`）與舊協定到 `2025-11-25`。TS SDK `2.3.1` 兩代都支援 | `connection.ts:277`、`tool-call.ts:72`；`@modelcontextprotocol/core@2.3.1` 的 `SUPPORTED_PROTOCOL_VERSIONS` 列到 `2025-11-25`，dist 另有 258 處 `2026-07-28` | 宿主 |
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

今天**沒有用**的：prompts、sampling、roots、progress 通知、資源訂閱（`resources/subscribe`）。client 握手時不宣告任何能力（`connection.ts:269` 只給 `versionNegotiation`），所以舊協定的 server 不會發 `elicitation/create` 過來；新協定的反問也只收 `elicitation/create`，sampling、roots 一律拒（`tool-call.ts:224-228`）。查法：對 `packages/nexus-plugin-mcp/src` 非測試檔 grep `prompts|getPrompt|listPrompts|createMessage|sampling|roots|progress|subscribeResource|setRequestHandler|setNotificationHandler`，只命中 `connection.ts:282` 的 `promptsListChanged: false` 與 `tool-call.ts:225` 的註解。插件以外沒有別的地方 import `@modelcontextprotocol/client`（全 repo 非測試、非 fixture 的 `.ts` 只有 `connection.ts`、`hub.ts`、`index.ts`、`tool-call.ts`）。

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
- 沙箱與守護包裝（`index.ts:410-437`）：見 §三之五。

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

### 三之二、stdio 的 fd 是兩條 `AF_UNIX` 連線，不是 pipe

宿主不能自己 spawn（`.docs/rust-host-design-2568-2026-11-08.md` §六）。經 spawner 起的子行程，它的 stdin、stdout 各是一條宿主連進 spawner 監聽 socket 的 `AF_UNIX` 連線：每條連線先寫 8 bytes 標頭（id、fd 編號），之後就是資料；spawner 把收到的那一端設成阻塞、交給子行程當 fd 0／1（`native/sandbox-spawner/src/main.rs:25-27`、`:425-449`）。

所以宿主手上是**兩條已連上的 socket**：一條只寫（子行程的 stdin）、一條只讀（子行程的 stdout）。候選要能吃「外部給的 reader 與 writer」，不能只會自己 spawn。

### 三之三、宿主的 JSON 接不住 MCP 的酬載

宿主的 `json.rs` 只收整數（`i64`），不收小數與指數，巢狀最多 32 層（`native/sandbox-spawner/src/json.rs:1-10`）。MCP 的參數、結果、JSON Schema 都會有小數，schema 的巢狀也常超過 32 層。**不管選哪條路，宿主都要加一個完整的 JSON 實作**（`serde_json` 或等價的）；橋上的 `payload: Json`（邊界文件 §一）也受同一條限制。

### 三之四、相依與出貨

`nexus-host` 與 `nexus-sandbox-spawner` 在同一個 crate（`native/sandbox-spawner/src/bin/nexus-host.rs`），今天的相依只有兩個，版本用 `=` 釘死（`native/sandbox-spawner/Cargo.toml:8-10`）。出貨的 SBOM 與 `licenses/sandbox-spawner/` 都按「連進執行檔的 crate」計（`docs/operations.md:1312`、`:1317`）。

加 MCP client 會把相依從兩個變成幾十個。建議把宿主拆成自己的 workspace member，或至少用 feature 關起來，讓 seccomp 底下的 spawner 執行檔維持最小。這一項跟選哪個候選都有關，只是多寡不同，所以相依數要算進比較表。

### 三之五、#1946 的「要套沙箱」宣告欄位

欄位在 `mcpStdioConnectionSchema` 的 `sandbox`（`packages/nexus-plugin-mcp/src/index.ts:116-128`）：鍵存在就套，`{}` 也算；`readable`、`writable` 另外列；沙箱不可用時不連線。今天的做法是 `wrapStdio`（`index.ts:410-437`）把 command 與 args 交給宿主給的 `mcpSandbox` 換成包過的，沒宣告的交給 `mcpGuard`；換完才交給 SDK 的 `StdioClientTransport` 起。

搬家之後的形狀：設定的解析留在 TS（schema 在那裡），對話行程把整列 MCP 設定交給宿主；宿主讀 `sandbox` 鍵，有就照 `readable`、`writable` 組 spawner 的 `Spawn`（`native/sandbox-spawner/src/protocol.rs:21-35`），沒有就以全權模式起（只套守護）。**這一段完全在 crate 之外**：crate 只拿到 §三之二 的兩條 socket。驗收要的那條測試釘的是宿主的這段路徑，不是 crate。

## 四、候選

（待補）

## 五、比較與推薦

（待補）

## 六、要拍板的題目

（待補）

## 七、驗收怎麼量

- **上線的請求與模型看到的句子**：`apps/harness/src/mcp-migration.test.ts` 對 `mcp-migration.baseline.json` 逐字釘住（#2353，`tool-call.ts:3-4`）。Rust 端要重現同一份 wire，這份基準就是對照。
- 其他項照 #2570 的驗收。

## 八、沒讀、沒量、沒核的

（待補）
