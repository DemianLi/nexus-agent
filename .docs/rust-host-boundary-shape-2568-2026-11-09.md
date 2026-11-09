# 過界形狀與葉子行程死掉之後（#2568 第三輪：第 6 題）

#2568 第 6 題。D262 定了這題先答，不等 #2336：只寫設計文件，不改產品碼；第 3 題照舊排在 #2336 之後（#1827 D262，demian 2026-11-09 在 PM session 回「依照建議，選 a」）。

讀碼基準：nexus `origin/develop` `13afeb32`；dsh `git show 8bd0733:`（D246）。rutis 只用 #1948 issuecomment-6533525395 裡已經附的行號（`921892d9`），本輪沒有重讀它的原始碼。沒有編譯、沒有執行、沒有量測。

## 結論

D249 之後，過界的地方有兩條，答案分開寫：

| 邊界 | 推薦 | 動不動拍板 |
| --- | --- | --- |
| 宿主 ↔ 對話行程（#2569 第 4 步的橋） | **只傳資料**：請求→回應、取消框、串流框；綁定跟著連線走，連線一斷就全部放掉，重連後重新登記 | Q21 不變 |
| 組合行程 ↔ 葉子行程（D249 才有的邊界，#2583） | **只傳資料**，但協定要雙向、多路、可巢狀：一方的請求還沒回，另一方可以反過來發請求。引用只活到那一次呼叫（callId），不做跨行程的引用計數 | 新的邊界，Q21 沒涵蓋，寫成是非題 H |

理由一句話：把今天會變成過界呼叫的每一類都盤過（§二），沒有一類非傳回呼或活物件不可；真正卡住過界的是「同步」與「隱含的 async context」，live reference 兩個都救不回來（§三）。

另外有兩件跟過界形狀連在一起，要改拍板：

- **版本登記留在前台，不搬進宿主**（是非題 G）。今天它已經不靠宿主：前台跟著監督行程的 `up`／`down` 向各對話行程問綁定，放掉的時機跟著行程生死走（§四）。dev-infra 問的兩個分岔，這樣都不用選。
- **搜尋索引、釘選封存先從宿主的清單拿掉**（是非題 I）。第一輪 §八 把它們放進宿主，理由是「宿主是 log 的寫入者」；D249 D 之後寫入者是每條對話的組合行程，這個理由不成立了（§五）。

照 G、I 都答是，宿主的服務只剩 MCP 連線池（MCP stdio 伺服器由宿主用 spawner 的單次模式起，D268）。#2569 第 4 步的橋照 §一 的框做，第一個真的消費者是 #2570。

葉子行程死掉之後：**「監督行程重起葉子行程、組合行程把那一步收尾成結果不明、那一輪繼續」是終點，要 #2571 與 #2573 都做完才成立**。之前的每一段都寫在 §六。

## 一、宿主 ↔ 對話行程：橋的框

### dsh 怎麼做（`8bd0733`）

dsh 讀到的三條行程邊界都只傳資料：

- **desktop host ↔ Electron main**：Node IPC，帶 `type` 的資料物件，`isDesktopHostEvent` 逐欄驗，驗不過就 SIGTERM；控制請求帶 `requestId` 配回答（`apps/desktop/src/host-process.ts:64-111`、`:223`、`:242-243`、`:330-332`）。協定版本是常數 `4`，兩邊一起出貨（`apps/desktop/src/host-protocol.ts:4`）。
- **工具子行程**：私有的 runner 協定，請求是 JSON 形狀，錯誤序列化成欄位（`packages/subprocess/subprocess-local/src/runner-protocol.ts:17-52`）。
- **MCP**：JSON-RPC，stdio 或 Streamable HTTP（`packages/mcp/mcp-client/src/transport.ts:31-45`）。

取消在這三條上分別變成：明確的取消訊息（`host-process.ts:320-325` 的 `file-drag-cancel{requestId}`）、訊號梯度（SIGTERM，過 `graceMs` 再 SIGKILL，`packages/subprocess/subprocess-local/src/spawn.ts:352-380`），或把 `AbortSignal` 交給 MCP SDK 的 `callTool`（`packages/mcp/mcp-client/src/tools.ts:154-157`）。

dsh 這樣做的理由：邊界兩邊一起出貨，資料加判別式最好驗。代價是每條邊界各寫一套。它沒有「Rust 服務化成 TS 服務」這種需求，因為 dsh 整棵樹都在同一個 Node 行程。

### 別的做法：live reference（rutis）

照 #1948 10-31 的留言：函式、物件、Promise 以 `Reference{kind}` 過界，對方拿代理，每次呼叫一次 RPC；Rust 端 drop 時送 `Frame::Release`，JS 端靠 `FinalizationRegistry` 釋放；取消有專用的 `Signal` 值。那則留言最後問的是：主機級的服務有沒有「請求→回應、取消、串流」表達不了的場景。

### 用 D249 之後的服務清單重答

| 服務 | 方向 | 今天的形狀 | 非回呼不可？ |
| --- | --- | --- | --- |
| MCP 工具呼叫與資源操作 | 對話行程 → 宿主 | 工具呼叫是 `ToolCall(args, exec)` 回 `NexusToolResult`（`packages/nexus-plugin-mcp/src/tool-call.ts:39-43`）；資源操作是 `McpSource.request(req, signal)`，資料進資料出（`hub.ts:36-54`）；連線池 `acquire` 回活的連線（`pool.ts:52-66`、`:131-135`），但它留在宿主裡，不過界 | 否 |
| MCP 執行到一半要問人（elicitation） | 伺服器 → client | 走 `input_required` 輪次，不是伺服器發給 client 的請求：一輪回 `input_required`，client 經 `exec.interrupt` 問人，帶 `inputResponses` 再送下一輪（`packages/nexus-plugin-mcp/src/tool-call.ts:70-80`、`:189-221`）。只收 `elicitation/create`，sampling、roots 都拒（`:224-228`） | 否。宿主每次只跑一輪，`input_required` 當資料回給對話行程，問人與下一輪由對話行程發起 |
| MCP 起伺服器要的沙箱包裝、守護包裝、憑證 | 今天：harness 交給 MCP 插件 | 三個都是 harness 在組裝時 provide 給插件的服務（`apps/harness/src/assembly-root.ts:1282`、`:1287`、`:1289`）：`mcpSandbox`／`mcpGuard` 是 `(req) => Promise<{command, args}>`（`packages/nexus-plugin-mcp/src/index.ts:76-89`），`mcp:credentials` 是同步的 `resolve(name)`（`packages/nexus-plugin-mcp/src/credentials.ts:21-23`） | 否，但連線池搬進宿主時，這三個**不能變成宿主反過來叫對話行程**。推薦：沙箱與守護由宿主自己做（D248 B），用 Rust 寫：宣告了 `sandbox` 的起 spawner 的單次模式 `--exec`，沒宣告的起 `--guard`，都不經常駐 spawner，因為常駐 spawner 的子行程繼承 seccomp、連不到網路（D268；`.docs/rust-host-design-2568-2026-11-08.md` §六）；憑證由宿主自己讀同一份來源，值不經 host.sock。對話行程送給宿主的只有 MCP 列的設定與憑證名字（`credentials.ts:4-6` 今天就只讓名字進設定與池鍵）。憑證來源在宿主行程裡怎麼讀，#2570 動工時定 |
| 插件版本登記 | 對話行程 → 前台 | 過界的只有 `{id, signature}`（`apps/harness/src/plugin-live-versions.ts:51-54`）；`bind` 回一個放掉的函式（`:113`） | 否。放掉改成「連線斷了就放」（§四） |
| 搜尋、釘選封存 | 前台 → 服務 | 介面帶閉包反過來叫對話行程：封存的 `known`、`activity`、`stop`（`apps/harness/src/thread-organization.ts:97-107`），搜尋的 `liveThreads()`（`thread-search.ts:349-370`） | 否，改成服務發請求給對話行程；但這兩項先不進宿主（§五） |

結論：Q21 的「過橋的只有資料」不用改。

### 推薦的框（給 #2569 第 4 步）

這是推薦，細節由 dev-infra 在 PR 裡定。今天的 `host_protocol.rs` 只有 `Hello` 和 `Rejected`（`native/sandbox-spawner/src/host_protocol.rs:19-29`），P2 的 `Service` 只是一個帶 `NAME` 的 `Any`（`native/sandbox-spawner/src/kernel/service.rs:13-15`、`:36-44`）。

```text
ClientMessage
  Hello   { version, token }                      # 已有
  Call    { id, service, method, payload: Json }  # 新
  Cancel  { id }                                  # 新：取消那一次呼叫
HostMessage
  Hello / Rejected                                # 已有
  Chunk   { id, seq, payload: Json }              # 新：串流的一塊
  Result  { id, ok: Json | err: { code, message } }  # 新：一次呼叫的終點，串流也以它收
  Event   { service, topic, payload: Json }       # 新：宿主主動推的資料（例如 MCP 工具清單變了）
```

- **Rust 插件契約要多的**：服務除了 `NAME`，要能宣告它接哪些 `method`、每個是不是串流，並給一個「Json 進、Json 或串流出」的分派。值本身照舊放在樹上，不過界（偏離 #8a 的「服務值只存資料」照舊）。
- **生命週期跟著連線**：對話行程在一條連線上登記的東西（MCP 綁定等），連線一斷宿主就全部放掉；重連後對話行程重新登記，這是 P3c 已經做的重連（`packages/nexus-host-bridge/src/client.ts:37-38`、`:159-163`）。不需要 `Release` 框，也不需要引用計數。
- **錯誤碼要分得出「宿主不在」**：橋把它翻成 survival 文件 §三 的「停」或「降級」（MCP 呼叫等宿主重連，有上限；正在跑的那一次回「結果不明」）。
- **巢狀請求這條先不做**：宿主今天沒有要反過來叫對話行程的服務，前提是上表 MCP 的沙箱、守護、憑證由宿主自己做；MCP 的 elicitation 照上表，由對話行程一輪一輪發。框格式留一個方向位就好，等真的有服務需要再加。

## 二、組合行程 ↔ 葉子行程：今天會變成過界呼叫的每一類

終點：組合行程是 loop、事件 log、政策；葉子行程是 TS 插件與工具（#2583）。下表列的是今天在同一個 Node 行程裡、將來會跨過這條邊界的呼叫。

| 類別 | 方向（終點） | 今天的形狀 | 回呼 | 出處 |
| --- | --- | --- | --- | --- |
| 工具呼叫 | 組合 → 葉子 | `NexusTool.execute(args, exec)` 回 `Promise<NexusToolResult>`；`exec` 帶 `signal`、`interrupt(payload)`、`deferContext`、`concludeTurn` | 有：工具執行中反過來叫 loop | `packages/nexus-tools/src/index.ts:126-205` |
| 工具節點 | 組合 → 葉子 | `tool.invoke(toolCall, config)` 回 LangChain 的 `ToolMessage`／`Command`，外面包 `wrapToolCall(req, handler)` 洋蔥 | 有 | `packages/nexus-core/src/native-loop/tool-node.ts:43-127` |
| 政策 hook | 組合 → 葉子 | 插件交函式註冊；`gate(listener)` 是 waterfall，決定 `allow／deny／ask` 是資料；`on('tools/execute', (exec, next))` | 有，含 `next` | `nexus-tools/src/index.ts:458`、`:272-285` |
| 每一步的同步查詢 | 組合 → 葉子 | `ToolAdmission.admits(name)`、`section.text(ctx)`，都是同步 | 有（同步） | `nexus-tools/src/index.ts:332-373` |
| 事件 | 組合 → 葉子 | 8 個事件：6 個 waterfall，回傳值有人用；1 個依序 await，回傳值不看；1 個 emit。只有 waterfall 帶 `next`；payload 是凍結的資料 | 有 | `packages/nexus-core/src/native-loop/events.ts:40-69`、`packages/nexus-core/src/tool-pipeline.ts:251-296` |
| 會話日誌 | 葉子 → 組合 | `join` 交出活的 `SessionLog`；`append` 同步回事件；`subscribe` 同步推 | 有，活物件 | `packages/nexus-session/src/index.ts:140`、`packages/nexus-core/src/session-log.ts:2520`、`:2542` |
| 投影 | 插件 → fold | `ProjectionUnit{init, apply, view}` 是插件交進來的程式碼 | 有 | `packages/nexus-core/src/projections.ts:42` |
| 插件之間互相 inject | 留在葉子內 | `commands.register(handler)` 等 | 有 | 不過界 |

查法：codebase-memory 的圖對這些檔大多報 missing／not_tracked（索引是 10-24 的），所以全部直接讀檔加 grep。

### 最接近「非延續不可」的四個，都有純資料的替代

1. **waterfall 的 `next`**（`gate`、`tools/execute`、`pre-execute`）：插件在前段做事，再交給內層。`ToolExecuteOutcome` 對插件不透明，插件改不了結果。所以拆成「前段請求 → 組合行程跑內層 → 後段回應」兩則訊息，用 callId 串起來就夠。
2. **工具執行途中反過來叫 loop**（`exec.interrupt` 等）：是「工具那次呼叫還沒回，葉子先發一個請求給組合行程」，就是巢狀請求，不需要活的引用。
3. **sandbox-policy 包住 `task` 的 `next()`**：委派那一刻同步拍下一格模式，子代理在 AsyncLocalStorage 的 context 裡讀它（`packages/nexus-plugin-sandbox-policy/src/index.ts:365-373`、`sandbox-mode.ts:164`、`:229`）。子代理的 loop 搬進 Rust 之後，ALS 就接不上了。替代：把那一格快照當資料，跟著子代理的 runId 一起帶過去。這是唯一一個依賴「內層執行期間的環境」的，live reference 也接不起 ALS。
4. **投影**：插件程式碼，fold 搬到 Rust 之後有三條路（每筆事件叫一次 TS、葉子訂閱事件串流自己 fold、投影用 Rust 重寫）。這題歸 #2571，本篇不定；三條路都不需要 live reference。

### 兩案比較

| 標準 | 只傳資料（雙向、多路、巢狀） | live reference |
| --- | --- | --- |
| 正確性 | 每則訊息都能驗；引用只活到 callId 結束 | 能把 `next`、`exec` 原樣傳過去；但每個呼叫點都要處理「對方已經卸載或死了」 |
| 同步語意 | `admits`、`section.text`、`append` 回 seq、`subscribe` 同步推，都要改成 async、每步預先算好，或在本地留鏡像 | **一樣要改**：跨行程呼叫不可能同步 |
| 失敗與恢復 | 葉子死了，組合行程手上只有「哪些 callId 還沒回」，逐一收尾成結果不明（§六） | 組合行程手上握著一堆指向死行程的引用，要另外清；JS 端靠 GC 釋放，釋放時機不定 |
| 效能 | 每次呼叫一次 IPC；waterfall 一個插件兩則 | 一樣多，還多 Release 訊息 |
| 維護成本 | 一套框加 callId 分派 | 一套分散式引用計數；rutis 的 `session/rpc.rs` 約 118 KB |
| nexus 的需求（稽核、多人共用主機） | 過界的都是資料，可以列舉、可以記 | 引用不透明，稽核要另外設計 |
| 基座做不做得到 | 能 | 能，rutis 做出來了；但 rutis 不當依賴（D235 R3），等於自己再寫一套 |

**推薦只傳資料**。live reference 換得到的只有「插件寫法完全不用改」，但同步呼叫那幾類不管怎樣都得改，這一項其實換不到。跟 dsh 的關係：dsh 沒有這條邊界；做法跟 dsh 每條行程邊界的做法一致（資料加判別式，取消變成訊息）。

## 三、為什麼 live reference 救不回來

今天的回呼與活物件裡，卡住過界的是兩件事：

- **同步**：`admits(name)` 每次模型請求前同步問，`append` 同步回 seq。跨行程後只能 async，兩案都一樣。
- **隱含的 async context**：sandbox-policy 靠 ALS 把快照帶進子代理。ALS 是 Node 行程內的東西，引用過界也帶不過去。

live reference 解決的是「函式能不能過界」，這兩件都不是這個問題。

## 四、版本登記與對照快照（dev-infra 的分岔 1、2）

dev-infra 的輸入經 PM 轉來，我自己核過：

- `LiveVersionTable` 只在行程記憶體裡，存「列 id → 宣告簽章 → root thread id」（`apps/harness/src/plugin-live-versions.ts:105-170`）。
- 對話行程組裝與續接都成功之後才綁，不擋組裝（`apps/harness/src/serve.ts:1972-1977`）。
- 快照由前台寫，前台向對話行程問綁著哪幾列（`serve.ts:1610` 的註解、`apps/harness/src/front-plugins.ts:3-8`）；簽章在前台用 `config-hash-key.json` 的鍵做 HMAC（`serve.ts:1219-1229`、`:1263-1265`）。

**今天的形狀已經解了「宿主要不要在」的問題**：前台跟著監督行程的 `up`／`down` 與每次轉送去問（`front-plugins.ts:64-88`），`down` 就放掉（`:90-97`）。前台自己重起時，表從頭再問一次就回來了。放掉的時機跟著行程生死走，這就是 §一「綁定跟著連線走」的同一個做法，不需要宿主。

所以：

- **分岔 1（快照誰寫）**：照今天，前台寫。dev-infra 列的 (a)(b)(c) 都是因為「版本登記要搬進宿主」才出現的；不搬，就不用選。
- **分岔 2（宿主在不在新 thread 的組裝路上）**：以程式碼為準，不在。survival 文件 §三 那一列「空窗期要新開的 thread 等宿主回來」是錯的，要改成「不經宿主，不受影響」。這列的改法在 §八。
- **簽章明文**：不搬就不經 host.sock，dev-infra 第 4 點的顧慮跟著消失。

這要改的是 Q21（主機級的樹含「TS 插件的版本登記」）、D249 D（宿主放「插件版本登記」）和 #2569 第 5 步，所以寫成是非題 G。

**#2583 之後綁定怎麼到前台**：TS 插件在葉子裡，綁定由葉子組裝時算出（`liveBindingsOf`，`plugin-live-versions.ts:69-98`）。§七 推薦前台連組合行程，所以葉子在跟組合行程的 `hello` 之後把綁定交給組合行程，前台照今天的路由（`/internal/threads/:id/plugins`）向組合行程問。過界的照舊只有 `{id, signature}`。

**版本登記跟過界形狀有沒有關係**：沒有。不管搬不搬，過界的都只有 `{id, signature}`，是純資料。

## 五、搜尋、釘選封存：第一輪 §八 的理由不成立了

第一輪 §八 把會話搜尋、`@` 引用候選、釘選封存、`listThreads` 等放進宿主，理由是「宿主是 log 的寫入者」。D249 D 把寫入者改成每條對話的組合行程，這個理由就沒了。而且 P3c 定了前台不連宿主（#2569 issuecomment-6733295249），這幾項的請求今天都從前台進來。

這幾項的介面還帶閉包，要反過來叫對話行程（§一 的表）。它們該放哪，要看 #2571 定下來的寫入者怎麼讓別人讀還沒落盤的那一句，這不是第 6 題能答的。

**推薦**：先從宿主的清單拿掉，照今天留在前台；#2571 動工時重答。這也要改 D249 D 的清單，寫成是非題 I。

## 六、葉子行程死掉之後，分四段

先記一件今天就有的事：**綁了 thread 的對話行程死掉，監督行程不會自己重起它**。它寫一行生死稽核、回前台 `down(thread, cause)`，等前台下一次為這條 thread 送 `ensure` 才起新的（`native/sandbox-spawner/src/supervisor/mod.rs:13-18`、`:1605-1623`）。重起沒有退避也沒有上限；退避與上限只有宿主有（`mod.rs:62-65`）。網頁那端重連是 0.5 秒起加倍、封頂 10 秒、不放棄（`apps/web/src/lib/reconnect.ts:5-16`）。所以一條「一續接就當掉」的 thread，會一直被重起。dsh 的 MCP 重連有每次故障共用的次數預算，`initialDelayMs` 500、`maxDelayMs` 30 000、`maxAttempts` 10，連線撐過 `maxDelayMs` 才把預算歸零，用完就註銷工具、放棄（`packages/mcp/mcp-client/src/connection.ts:7-13`、`:40`、`:49-51@8bd0733`）。這件不屬於第 6 題，記在 §九 給 PM。

| 段 | 葉子行程死了 | 那一輪 | 用尺 |
| --- | --- | --- | --- |
| **今天**（葉子＝今天的對話行程） | 監督行程記稽核、回 `down`；不重起，等下一個 `ensure` | 斷。這條 thread 的下行斷線，沒有終止 frame（`apps/harness/src/front-forward.ts:173-177`）；全域下行撤回還掛著的題、列表轉成閒著（`apps/harness/src/front-feed.ts:11`、`:81-87`）。下次組裝時才修補：撕裂的尾巴截掉（`apps/harness/src/jsonl-session-store.ts:953-956`），沒配到結果的呼叫補 `TOOL_OUTCOME_UNKNOWN` 或 `TOOL_NOT_STARTED`，補 `turn/end{interrupted}`（`packages/nexus-core/src/interrupted-turn.ts:12-26`，措辭照 dsh `repair.ts:30-35@8bd0733`） | 斷，只斷這一條 |
| **#2583 做完，#2571 還沒** | 組合行程照活，但 log 還在葉子裡寫，loop 也還在葉子 | 跟今天一樣。組合行程沒有東西可以收尾；它向監督行程回報葉子死了，這條對話照今天的規則處理 | 斷，只斷這一條 |
| **#2571 做完，#2573 還沒** | 組合行程是 log 的寫入者，但 loop 還在葉子 | 組合行程**當場**把沒配到結果的呼叫收成結果不明、補 `turn/end{interrupted}`，不用等下次組裝；網頁馬上看到「中斷」，不是只看到斷線與轉成閒著。loop 跟葉子一起死了，那一輪不能繼續 | 斷，但收尾提前、網頁看得到 |
| **#2573 之後（終點）** | 監督行程重起葉子行程；組合行程把那一步收尾成結果不明 | **那一輪繼續**：模型收到那支工具的結果不明，自己決定要不要重試。葉子回來之前的下一個工具呼叫等它（有上限），超過就回工具錯 | 停→降級 |

終點這一段的細節：

- **誰重起**：監督行程。所有行程都由它起，它是 subreaper（設計第一輪 §一）。組合行程只負責發現與回報。重起照宿主那一套：退避加倍、穩定窗歸零、連續失敗有上限（`mod.rs:62-65`），數字跟 #2523 一起定。
- **上限用完**：這條對話的組合行程把那一輪收成 `interrupted`，對話照「組合行程崩潰」的規則處理。只斷這一條，不違反 D248。
- **政策要 fail-closed**：TS 插件的政策 hook 在葉子裡。葉子不在時，不能當作沒有 hook 就放工具過去，所以下一個工具呼叫一定是「等，超過上限就回錯」。
- **葉子重起之後**：TS 插件重新組裝、重新登記 hook 與事件，同宿主重連後重新登記 MCP 綁定那一套。插件放在記憶體裡的狀態會遺失，要撐過重起的狀態要寫進事件 log。這是對插件作者的新規則，#2572 要寫進插件契約。
- **正在跑的工具子行程**：spawner 跟葉子同一個行程群組，葉子結束時監督行程對整個群組送 SIGKILL，工具接著被 PDEATHSIG 帶走（`native/sandbox-spawner/src/child.rs:58-64`、`mod.rs:50`）。所以「結果不明」是真的不明，有副作用的工具可能做到一半。

## 七、#2583 交給第 6 題的四件事

| #2583 | 推薦 |
| --- | --- |
| 第 1 條：起動順序 | 監督行程同時起兩個。組合行程先跟葉子行程交換帶版本的 `hello`，收到葉子回報它登記了哪些工具與 hook，才算 ready；監督行程等組合行程 ready 才回前台 `up`。理由：少了葉子的 hook，政策是 fail-closed，組合行程什麼工具都不能跑 |
| 第 2 條：橋的形狀 | §二：只傳資料，雙向、多路、可巢狀，callId 串 waterfall 的前後段，引用只活到那一次呼叫 |
| 第 3 條：葉子死了 | §六的四段表 |
| 第 5 條：前台連哪個 | **連組合行程**，從 #2583 起就連它；#2573 之前由組合行程轉給葉子。理由：終點的串流從組合行程出（loop 與 log 都在那），從一開始就連它，後面幾張卡搬東西時資料路徑不用再換。代價是 #2573 之前多一跳，#2583 驗收本來就要量這一跳；量出來不能接受，退路是 #2573 之前先連葉子 |

## 八、要改的卡與文件（PM 審過再動）

- **survival 文件 §三** 最後一張表「插件版本登記」那列：改成「不經宿主，不受影響（第三輪 §四）」。G 答否時，改成以程式碼為準：組裝成功之後才綁、不擋組裝，宿主不在時綁定延後。
- **第一輪 §八 的表**（`.docs/rust-host-design-2568-2026-11-08.md`）：G 答是時，「plugin 對照快照」那列終點改成「前台」；I 答是時，會話搜尋、`@` 引用候選、釘選與封存、`listThreads` 等那幾列的終點改成「照今天，#2571 動工時重答」。
- **#2569**：第 4 步的橋照 §一 的框做；第 5 步 G 答是時改成不做，答否時照 §四 的分岔重開。
- **#2583**：第 1、2、3、5 條照 §七 寫進正文；前置的「第 6 題」改成已答。
- **#2572**：插件契約加一條「插件放在記憶體裡的狀態，葉子重起之後會遺失」（§六）。
- **#2571**：投影的三條路（§二 第 4 點）與搜尋、釘選封存的落點（§五）寫進要做的事。

## 九、要 demian 決定的三題

| # | 問題 | 推薦 | 理由 |
| --- | --- | --- | --- |
| G | Q21 的主機級的樹拿掉「TS 插件的版本登記」，D249 D 的宿主清單拿掉「插件版本登記」：版本登記與 plugin 對照快照照今天留在前台，#2569 第 5 步不做？ | **是** | §四：今天前台跟著監督行程的 `up`／`down` 去問對話行程，已經不靠宿主；搬進宿主要推翻「前台不連宿主」（P3c），或讓宿主重做設定讀取，換不到東西 |
| H | 組合行程跟葉子行程之間也照「只傳資料」：雙向、多路、可巢狀的請求→回應，加取消框與串流框；引用只活到那一次呼叫，不做跨行程的引用計數？ | **是** | §二、§三：沒有一類非傳回呼或活物件不可；同步與 ALS 兩件事 live reference 也救不回來；葉子死了時只需要收「哪些 callId 還沒回」 |
| I | D249 D 的宿主清單先拿掉「搜尋索引、釘選封存」，照今天留在前台，等 #2571 定下寫入者之後重答？ | **是** | §五：第一輪 §八 放進宿主的理由是「宿主是 log 的寫入者」，D249 D 之後不成立；前台不連宿主（P3c） |

宿主 ↔ 對話行程的橋維持只傳資料，Q21 不變，不用問。

另外給 PM 一件（不屬於第 6 題，不是要 demian 現在決定的）：綁了 thread 的對話行程死掉後沒有退避與上限（§六開頭）。推薦補一道每條 thread 的熔斷，次數預算照 dsh MCP 的形狀。要不要開卡，由 PM 定。

## 十、沒讀、沒量、沒核的

- **沒量**：每次過界一次 IPC 的成本、waterfall 拆兩則訊息多出來的延遲。這是第 3 題，排在 #2336 之後。
- **rutis**：沿用 #1948 issuecomment-6533525395 的行號，本輪沒有重讀原始碼。
- **MCP SDK**：dsh 把 `AbortSignal` 交給 `callTool` 之後，SDK 會不會送 `notifications/cancelled`，沒讀 SDK。
- **dsh desktop host 死了之後誰叫 `start()`**：只讀到 `backend-controller.ts:138-146` 發 `error`、`:60-64` 要重新 `start()`，誰去呼叫沒查。
- **codebase-memory 的圖**：§二 用到的檔大多報 missing 或 not_tracked（索引是 10-24 的），全部改讀檔加 grep；MCP 這一項，我在 `packages/nexus-plugin-mcp/src` 下 grep `setRequestHandler|sampling|elicitation|roots`，再讀 `tool-call.ts` 的 elicitation 輪次核過：沒有 `setRequestHandler`，elicitation 是工具結果的輪次。
- **§二 的盤點與 §六 的今天那一段**，是兩個子代理讀的；文中引用的出處我抽查了 `host_protocol.rs:19-29`、`service.rs:36-44`、`sandbox-policy/src/index.ts:365-373`、`sandbox-mode.ts:164`、`nexus-tools/src/index.ts` 的 `interrupt`／`admits`／`gate`、`thread-organization.ts:97-107`、`mod.rs:13-18`／`:62-65`／`:1605-1623`、`interrupted-turn.ts:12-26`，dsh 的 `connection.ts:7-13`／`:40`／`:49-51`／`:282-296`、`tools.ts:150-165`、`repair.ts:30-35`、`host-protocol.ts:4`。其餘行號由 comment-audit（report 模式，子代理）逐條對 HEAD 與 `8bd0733` 核過，它指出的七處更正我重核後已改。
