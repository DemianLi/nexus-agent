# agent loop 脫離 LangChain：S2 與 loop 第二段的設計與拆卡（#2336）

卡 [#2336](https://github.com/DemianLi/nexus-agent/issues/2336)，地圖 [#1339](https://github.com/DemianLi/nexus-agent/issues/1339)（S2）與 [#1385](https://github.com/DemianLi/nexus-agent/issues/1385)（loop 第二段）。決策出處 D167：demian 2026-11-03 在 PM session 說「優先讓工程師處理等 agent loop 不再依賴 LangChain（Q29 那張），然後再告訴 dev-rs 第一條障礙消失了，對話那棵樹能不能換成 Rust 可以重新評估」。

**這份只有設計與子卡草稿，沒有改任何產品程式碼。** §十 的 14 題 demian 2026-11-03 在 PM session 全部照推薦拍板（#1827 D168），子卡 K0–K13 由 PM 在這份合併後開。

**最終目標**（D169，demian 同一則）：「最終目標依然是完全擺脫 langchain 和 cordis ，這樣才能真正的變成具有萬物皆可插件的架構設計搭配企業級智能體產品的應用模式」。**這一串只做 LangChain 那一半**；Cordis 怎麼拿掉不在這一串，這份不設計。

基準：
- nexus `origin/develop` `cc305eb6`；
- dsh `deepseek-ai/deepseek-harness` `ce7073d51254c26cd63b22a60835b8f948deb447`（`git rev-parse HEAD` 與 `git ls-remote … HEAD` 一致）。

下文的 dsh 行號都對這個 SHA。#1339 卡上引用的 `d7432673886` 行號（`agent.ts:593`、`:688`）已經漂了，本文不沿用。

套件版本：deepagents 1.13.1、langchain 1.5.10、@langchain/langgraph 1.4.19、@langchain/core 1.2.9。

## 結論

1. **分四段，每段都是 two-way door。** 會話日誌格式只在第三段升一次版，這是唯一的 one-way（§五）。
   - **L0 前置**：不改行為。
   - **L1 S2**：還在 LangGraph 裡，就讓每次模型請求的歷史改由日誌推導。先跑影子模式比對，再切換。
   - **L2 自寫 loop**：用開關 `--agent-loop=langgraph|native` 並存。
   - **L3 拿掉 LangChain／LangGraph／deepagents**。
   - 開關做得成的前提：兩個 loop 寫出來的日誌，彼此都讀得懂。所以 L2 的 native loop **沿用今天落盤的訊息形狀**，不換成 dsh 的 `Message`（§三、Q2）。
2. **dsh 的三事件不照卡上的字面落地。** dsh 在 `ce7073d5` 已把 `agent/request` 標成 `@deprecated`（`packages/core/agent/src/runtime-types.ts:362-365`）。換模型、換推理強度改走 `agent.model.select()`，它只寫一顆 `model/selection` 事件（`packages/core/agent/src/model-selection.ts:112-115`）；nexus 已經有這顆事件。落地的是 `llm/stream` 與 `agent/request-error` 兩個，外加 dsh 的工具管線事件（§三-3、Q3）。
3. **續接今天靠存檔點，S2 之後改成每一輪都從日誌推導。** 這會撞到 D162 的每輪 CPU 上限。所以 L0 先做 dsh 那種增量推導，並且先量（§三-2、K1）。
4. **第 6 點的答案是「縮小了，沒有消失」。** 照 dsh 改完之後，會變成資料的是：
   - 工具 schema；
   - 工具結果；
   - 呼叫身分（今天藏在 LangGraph 的 `configurable`）；
   - `preStep` 看到的訊息。

   仍是 JS 函式的有六類：工具 `execute`、`gate`／`onResult`／`preStep` 的 listener、投影單元、命令 handler、`goals.onActivationChanged`、`sessionLookup.join`。

   這跟 dsh 一樣：dsh 沒有「服務值必須可序列化」的整體約束（§八）。要再往下走成純資料＋RPC，D168 定為不在這一串（Q9）。
5. **和 #1947 會撞的是 `thread-pump.ts`、`wire-handler.ts`、`assembly-root.ts`、`serve.ts`。** 建議的順序：
   - L0、L1 與 #1947 的 C0–C2b 並行；
   - L2 起等 C1（#2338）合併後再動 pump；
   - L3 拿掉存檔點，排在 C3（#2341）之後（§九、Q12）。

## 一、dsh 怎麼做、為什麼

### 1-1 一輪的骨架

虛擬碼取自 `packages/core/agent-loop/src/agent.ts:268-433`、`:435-610`：

```
turn():
  log turn/start
  loop:
    claimed = inbox.claim(target)                      // inbox.ts:108-113
    toolSet = tools.resolve(); prompt = systemPrompt.assemble()
    d = waterfall('agent/pre-step')                    // agent.ts:296；回 reject 或 enter{messages}
    if reject → turnEnds = blocked
    log step/start
    end = step(d)
    finally log step/end
    if 結束了且 next-step 收件匣是空的 → serial('agent/turn-stopping')   // agent.ts:396
    if 仍是空的 → break
  finally log turn/end{reason}                         // agent.ts:422

step():
  while true:
    cfg = waterfall('agent/request')                   // 已棄用，agent.ts:630
    prepared = llm.prepareCall(cfg)                    // agent.ts:644
    第一次嘗試時寫 system/message、user/message（agent.ts:459-477）
    req = deepFreeze({...header, messages: session.deriveMessages(), signal})   // agent.ts:727-742
    for chunk of prepared.stream(req) → 畫面          // 經 llm/stream waterfall，llm/llm/src/index.ts:1170-1183
    if finish 是 error 或 aborted:
      log assistant/attempt                            // agent.ts:544-547
      a = waterfall('agent/request-error')             // agent.ts:548
      if a.kind == retry → continue
      throw
    log assistant/message
    沒有工具呼叫 → 收
    r = tools.execute(calls)                           // agent.ts:590
    r.additionalContexts → next-step 收件匣
```

為什麼這樣做：
- 檔頭寫明「Every request is derived from the session log」（`agent.ts:1-3`）。模型看得到的內容一律先 append 進日誌，再由 `deriveMessages()` 推出來。
- 請求會被 deepFreeze，所以 `llm/stream` 的監聽者只能讀、不能改（`llm/llm/src/index.ts:66-73`）。
- 代價是每次模型呼叫都要推一次歷史。dsh 用增量快取付掉這筆（1-2）。

### 1-2 `deriveMessages()`

- 實作在 `packages/core/session/src/index.ts:999-1020`：沿著 `surface.nodes` 把事件投影成訊息，結果快取起來，`contentGeneration` 一變就整份重建。
- 會產生訊息的只有五種事件：`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`（`session/src/surface.ts:51-57`）。
- 壓縮用 `surfaceOp {op:'replace', startSeq, endSeq}` 換掉一段 node（`session/src/types.ts:458-472`）：
  - `compaction-basic` 換一段；
  - `compaction-tool-result-pruner` 換一顆（`index.ts:169`）。
- 圖片省略是訊息投影（`compaction-image-offload/src/projection.ts:17-26`）。它不改 node 成員，只把 `contentGeneration` 加一（`surface.ts:572-576`）。
- `Session.append` 會先做一份 JSON 快照，不能序列化就丟錯（`session/src/index.ts:816-823`）。

### 1-3 模型設定、重試

- `LlmCallConfig` 的欄位是 `provider`、`model`、`reasoningEffort?`、`temperature?`、`maxTokens?`、`stop?`（`llm/llm/src/call-config.ts:16-34`）。
- `agent/request` 已棄用，JSDoc 寫的替代是：
  - `agent.model.select()` 換模型與推理強度；
  - `AgentOptions.maxTokens` 管輸出上限；
  - 「Other per-request control overrides have no replacement API」（`runtime-types.ts:362-365`）。
  - 還留著的監聽者只剩 `compaction-basic`（`compaction-basic/src/index.ts:183`）。
- 重試全在 `agent/request-error` 的監聽者：
  - `llm-retry`（`llm-retry/src/index.ts:240`）；
  - 溢出時先壓縮再重打（`compaction-basic/src/index.ts:213`）；
  - 搬圖（`compaction-image-offload/src/index.ts:27`）。
- SDK 層不重試。

### 1-4 工具

- `ToolDefinition`（`packages/core/tools/src/contracts.ts:26-102`）：`name`、`description`、`parameters`（JSON Schema）、`output`、`execute(args, exec)`。
- 參數 schema 是 dsh 自家的 spec 編成 JSON Schema，再用 `validateJsonSchemaValue` 驗（`tools/src/schema.ts:555-605`），不是 zod。
- `exec`（`ToolRunContext`，`contracts.ts:174-261`）帶：
  - `callId`、`rootCallId`、`name`、凍結的 `arguments`；
  - `signal`、`agent?`；
  - `deferContext()`、`concludeTurn()`。
- 結果是成功／失敗兩種的 union（`contracts.ts:322-346`）：
  - `value`、`meta` 都是 JSON；
  - 錯誤是結果上的資料欄；
  - 寫進日誌的 `tool/result` 不帶 `value`（`tools/src/batch.ts:256-265`）。
- 管線（`tools/src/pipeline.ts`）依序：
  1. `tool/call`（記日誌，`batch.ts:157`）；
  2. `tools/pre-execute`（waterfall，回 allow／deny／cancel／ask，`:199`）；
  3. `ask` 轉交核准服務（`:449`）；
  4. `tools/execute`（waterfall，包住本體，`:299`）；
  5. `tools/post-execute`（`:354`）；
  6. `tools/result`（emit，`:408`）；
  7. `tool/result`（記日誌）。

### 1-5 中斷、續接、子代理

- **核准**：在同一行程內 await `approval.request`。`approval/asked` 與 `approval/decided` 都寫在還開著的那一輪裡（`user-approval/src/index.ts:242-261`）。**沒有掛起後 resume 回原呼叫點的機制。**
- **重啟**：完全靠日誌。`interruptedTurnClosers`（`agent-loop/src/index.ts:795-803`、`session/src/repair.ts:53-97`）補三樣：
  - 錯誤型的 `tool/result`；
  - `step/end`；
  - `turn/end{interrupted}`。
- **存檔點**：只有 flush（`session-checkpoint-policy/src/index.ts:64-83`），不存執行中的狀態。
- **ask_user**：有兩版。
  - 阻塞版：工具本體 await（`tool-ask-user/src/index.ts:99-100`）。
  - 計時版：逾時就回 `{pending:true}`，答案之後以 `steer()` 送進來（`user-questions/src/index.ts:191-274`）。
- **子代理**：跟 root 用同一份 `ReactLoopAgent`（`agent-loop/src/index.ts:573`），子代理有自己的日誌。
  - 背景子代理結算時，看父代理當下的狀態把結果送回去：閒著就排隊並喚醒；正在跑就 steer；正在收尾就 inject（`subagent/src/manager.ts:1206-1218`）。
  - **原生 loop 沒有輪數上限**（`agent.ts:344` 是 `while (true)`）。
- **插話**：收件匣分兩條佇列，`next-turn` 與 `next-step`，每次變動都記成 `agent/inbox/spliced`（`inbox.ts:20-64`）。

## 二、nexus 今天的形狀

| 面 | 今天 |
| --- | --- |
| loop 本體 | langchain `createAgent` 編的 ReactAgent，三個組裝點：root `agent-assembly.ts:304`、背景子代理 `subagent-graph.ts:160`、一次性 `task`（基座 `createSubAgentMiddleware`，`agent-assembly.ts:288`）。**沒有「loop 插件」**：`@nexus/agent-loop` 只定義 `preStep` 接縫，宿主把每個 listener 包成一顆 `beforeAgent`（`pre-step-middleware.ts:88`） |
| middleware 洋蔥 | `fold.ts:712-882` 大約 30 格，另有基座的 skills、Filesystem、task、摘要鏈、patchToolCalls、memory。與 10-11 盤點相比：modelSelection 與 imageOffload 搬到最外層（#1378，F1 已修）；新增 emptyResponse（`:821`）、approvalPolicyPrompt（`:831`）、sharedReadMark（`:844`）、searchDescriptions（`:857`） |
| 模型歷史 | 常駐時靠存檔點：root 每輪只送新的那一句（`thread-pump.ts:3076-3080`），歷史放在 `PrunedMemorySaver`（`assembly-root.ts:1101`，只留最新一份、不落盤）。重啟或冷復活時才用 `replayConversation` 從日誌推，再 `updateState` 灌回去 |
| 存檔點 | 關不掉：`interrupt()` 沒有它就拋錯，背景子代理也要它（`agent-factory.ts:767-769`） |
| `interrupt()` | 五處：核准 `approval.ts:440`、ask_user `nexus-plugin-ask-user/src/index.ts:244`、plan-mode `nexus-plugin-plan-mode/src/index.ts:625`、sandbox 升級 `sandbox-escalation.ts:390`、MCP elicitation（adapter 內部，`@langchain/mcp-adapters` `elicitation.js:115`）。resume 用 `Command({resume:{[id]:answer}})`（`thread-pump.ts:3072`） |
| `Command` 改 state | goal（`tools.ts:604`）、submit-record（`index.ts:227`，含 `files` channel）、`summary-catch-up.ts:147` |
| 串流 | thread-pump 讀 `streamEvents` v3（`:3156`）；CLI 讀 `stream` 的 `updates`／`values`（`cli.ts:553-557`）。擦掉重試殘影只靠 `getConfig().writer` 送 `STREAM_RETRY_SIGNAL`（`stream-retry.ts:296`） |
| 模型事件 | `model/start`、`assistant/message`、`model/end` 在 modelCalls 那一格寫（`model-calls.ts`，`fold.ts:819`）；`request/system`、`request/header` 在 callback 裡寫，可略過，而且落在 `model/start` 之後（`request-snapshot.ts:415`、`:430`）；重試由 `retryModelCall`（`stream-retry.ts:355`）在起訖外面做，SDK 的 `maxRetries` 恆為 0（#1427） |
| 工具 | 插件交 LangChain 的 `StructuredToolInterface`（`packages/nexus-tools/src/index.ts:152`）；參數 schema 是 zod；呼叫身分讀 LangGraph 的 `configurable.thread_id`／`checkpoint_ns`（`session-address.ts:107-194`）；錯誤碼放在以 `ToolMessage` 物件為鍵的 WeakMap（`tool-events.ts`）；結果本身就是 `ToolMessage` |
| 落盤的訊息 | `LoggedMessage {type, data}`，是 LangChain `StoredMessage` 的形狀，但本身是純 JSON（`packages/nexus-core/src/logged-message.ts:73-81`） |
| 依賴面 | 非測試檔 import `@langchain/*`、`langchain`、`deepagents`：`packages/nexus-core/src` 60 個、`apps/harness/src` 49 個（正式 37 個）；插件 10 個用 `@langchain/core/tools`，另有 agent-instructions、time-context、workspace-changes、`@nexus/agent-loop`、`@nexus/tools`、`@nexus/wire`（`@langchain/protocol`） |

依賴面的計數方法（子代理跑的，我沒有重跑）：

```
grep -rlE "^(import|export|\}).* from '(@langchain/|langchain|deepagents)" <目錄> --include='*.ts' --exclude='*.test.ts' | wc -l
```

## 三、怎麼切段（第 1 點）

### 3-1 選項

| | (a) 四段：前置 → S2 → 開關並存的自寫 loop → 拿掉 | (b) 兩段：直接寫 native loop，S2 隨它一起到 | (c) 不自寫：留 LangGraph `StateGraph`，只是不用 `createAgent`，自己畫節點 |
| --- | --- | --- | --- |
| 正確性 | S2 先在已出貨的 loop 上用影子模式證明「推出來的＝送出去的」，再換 loop。兩件事的錯分得開 | 歷史來源與 loop 同時換，紅了不知道是哪一邊 | 存檔點、`interrupt`、superstep 的語意照舊。決議 §二 列的 12–15 條「要重寫 loop 才根治」一條都解不掉 |
| 失敗與恢復 | 每段都有開關、預設不動 | 只有一個開關，切回去等於整個 loop 退回 | 同今天 |
| 效能 | L1 先量增量推導每輪的成本，再決定切不切 | 量到退步時，原因混在 loop 改寫裡 | 同今天 |
| 維護成本 | L1 期間有一層影子比對，L2 期間兩個 loop 並存（L3 收掉） | 並存期較短 | 仍依賴 LangGraph，D167 的目標沒達到 |
| nexus 的需求 | 稽核要的「模型看到的都有記」在 L1 就成立，不必等 loop | 要等整個 loop 換完 | — |
| 基座做不做得到 | L1 要一顆最外層 middleware 拿推出來的歷史換掉 `request.messages`。#1341 的 G2 量過這種取代：外層取代會讓模型看到日誌上沒有的東西，所以 L1 只換「歷史」、不取代回應，判準改成比對第二句請求的歷史（G2 的建議） | — | — |

**選 (a)**（D168 Q1）。
- (b) 省的只是一段並存期，丟掉的是「錯分得開」。
- (c) 不符 D167。

開關的做法照 #1947 的 `--process-model`：
- 設定列與旗標都有；
- 驗收全過之前預設不動；
- 舊路徑至少保留一個版本。

### 3-2 L1 的增量推導：一定要先量

今天常駐時每一輪不推歷史，S2 之後每一次模型呼叫都要推。`replayConversation`（`packages/nexus-core/src/conversation-replay.ts`，430 行）是整份重算。在 #2117、#2241 那種大日誌上每一輪都整份重算，會直接打到 D162（第 6–15／16–25／26–45 輪的每輪 CPU 上限，量法綁 `r7-driver.mts`）。

| | (i) 照 dsh：快取推出來的訊息陣列，新事件只往後接，壓縮或省略事件讓整份失效 | (ii) 每次整份重推 | (iii) 繼續把 LangGraph state 當快取，只在不一致時用日誌蓋 |
| --- | --- | --- | --- |
| 正確性 | 快取與重算要逐位元組相同。用影子比對加夾具守 | 天生正確 | 真相還是兩份，S2 等於沒做 |
| 效能 | 一般一輪只付新事件的成本；壓縮那一輪付整份 | 每輪付整份，大日誌會退步（沒量） | 同今天 |
| 維護 | 多一層失效規則 | 最少 | 兩份真相 |

**選 (i)**（D168 Q13 的前提）。數字由 K1 先量：
- 在 #2117 那份大日誌與 r7-driver 的 45 輪上，量 (i) 與 (ii) 每輪的 CPU；
- 量到的數字跟今天的存檔點路徑比。

退步上限是 Q13。

### 3-3 L2 自寫 loop 的形狀

照 dsh 的 turn／step 骨架（§1-1），事件用 vendor 的 Cordis（`vendor/cordis/src/events.ts:14` 有 `waterfall`／`serial`／`emit`）：

| dsh | nexus L2 | 取代今天的 |
| --- | --- | --- |
| `agent/pre-step`（waterfall，每一步） | 同名。`@nexus/agent-loop` 的 `preStep` 從「每次 invoke 一次」改成「每一步一次」 | `beforeAgent`／`beforeModel` 節點：pre-step 宿主、stepInbox、repeatReminder、agent-instructions 的基線、plan-mode 的 P1 |
| `agent/request`（已棄用） | **不落地**。換模型走既有的 `model/selection`；輸出上限放 loop 選項 | modelSelection（`fold.ts:727`） |
| `llm/stream`（waterfall，串流包裝） | 同名，在模型轉接器外面 | `guarded-chat-openai.ts`、`gated-chat-openai.ts` 的子類接縫；`requestSnapshot` 的 callback |
| `agent/request-error`（waterfall） | 同名。監聽者：重試（`retryModelCall` 拆成監聽者）、溢出時先摘要、搬圖 | streamRetry（`:818`）、imageOffloadRecovery（`:870`）、摘要器的溢出處理 |
| `agent/turn-stopping`（serial） | 同名 | workspace-changes 的 `afterAgent`、stepInbox 的 `afterAgent` |
| `tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result` | 同名，取代 `@nexus/tools` 今天的 `gate`／`onResult` 與 core 的 tool-pipeline | 二十來顆 `wrapToolCall`（containment、approvalGate、spill、searchOverflow、outputSchema、fsToolErrors、readContinuation…） |
| `systemPrompt.assemble()` | 已有（#1477），補上 S1 那種函式型 `text`。K7a（#2414）把每一顆的文字改成段，由留在原格的薄轉接渲染；在洋蔥外一次接完跟摘要器一起留到 K7c（#1827 D198） | 改 `systemMessage` 的十幾顆：observation、mcp-prompt、file-references、approvalPolicyPrompt、sandbox-policy、plan-mode… |
| `tools.resolve()` | `@nexus/tools` 加 `resolve()` | 改工具清單的：subagent-tool-filter、mcp hideTools、background-delegation、read-continuation 改 schema、searchDescriptions |

這張表是讀碼對應出來的。25 顆 `wrapModelCall` 與二十來顆 `wrapToolCall`，每一顆的歸宿都要在 K7 逐顆核；表上是大類，不是逐顆的結論。

## 四、W1–W10 每項怎麼處理（第 2 點）

今天的狀態是子代理對 `cc305eb6` 讀碼的結果。我抽查了 `fold.ts:755`、`thread-pump.ts:3072`、`assembly-root.ts:1101`、`interrupted-turn.ts:257`，其餘未逐條核。

| # | 項目 | 今天 | 處理 | 卡 |
| --- | --- | --- | --- | --- |
| W1 | 子代理撞到 `maxTurns` 時寫的上限訊息 | 未變：仍是 langchain `modelCallLimitMiddleware`（`fold.ts:755-764`），寫一則有內容的 AIMessage，日誌上沒有 | dsh 沒有輪數上限，nexus 留著（產品要）。改由 native loop 自己數，撞到時以 `turn/end{reason:'max-turns'}` 收，不合成助手訊息（Q5） | K9 |
| W2 | `image/offload` 推導端不套用 | 未變：replay 只蓋來源 seq（`conversation-replay.ts:471`）；`applyImageOffload` 只處理 Human（`image-offload.ts:168`），`select` 不分種類 | 推導端照 dsh 當成訊息投影套用；選圖與套用的範圍要一致；決定寫在 `model/start` 之前 | K4 |
| W3 | 基座 Filesystem 把超過 200k 字元的人話搬走、80k 工具結果換預覽 | 未變 | 搬走：拿掉這條（native loop 不掛基座 Filesystem），長度改由入口拒收（Q8）。80k 預覽：搬進 nexus 自己的 spill（已有 `spill-policy.ts`），日誌記全文、推導用 `toolResultAsSeen` 重算；補一個逐字比對的夾具 | K7 |
| W4 | `patchToolCalls` 跟 replay 是兩套規則 | 未變（已緩解）：句子不同（`patch-tool-calls.ts:91` 對 replay `:120-124`），孤兒結果 replay 照 push | L1 起推導端是唯一的一套；`patchToolCalls` 在 L1 拿掉，孤兒規則照 dsh `repair.ts` 定一種 | K4 |
| W5 | `withEmptyAssistantContent` 與 `isEmptyAssistant` 是兩份函式 | 部分：夾具改用出貨的請求本文，函式仍是兩份 | 併成一份，推導與 HTTP 層共用 | K4 |
| W6 | 讀 `state.messages` 的讀者 | 清單有變：rawArgumentsOf（`invalid-tool-args.ts:190`，被 containment、approval 用）、`tool-barrier.ts:125`、`turn-conclusion.ts:54`、`repeat-reminder.ts:438`、`pre-step-middleware.ts:92`、`patch-tool-calls.ts:112`、摘要器八處、`summary-catch-up.ts:132`／`:141`、`thread-pump.ts:2300`／`:2973` | L1：先加一條 AST 護欄只許白名單讀 state，清單變成數得出來的；每一處改讀「推出來的那一串」或 `tool/call.arguments`。L2 起不再有 state | K5、K7 |
| W7 | 寫日誌失敗就吞掉、改寫照做 | 大半已解（#1709、#1725、#1726）。仍吞的：`pre-step-middleware.ts:25`、`repeat-reminder.ts:467`（認不出 thread 就不記、照送）、`thread-pump.ts:3335`（`assistant/attempt`，登記過的偏離）、`thread-pump.ts:3424`（`updateState` 失敗）、`summarization.ts:1998`（`context/measure`，不進模型） | 前兩處在 L1 改成 fail-closed：推導是唯一來源之後，「沒記就沒送」自然成立。`:3424` 在 L3 隨 `updateState` 一起消失。`assistant/attempt` 照 dsh 改成非可略過（Q4 一起） | K5、K10 |
| W8 | 子代理的 state 與子日誌座標對不上 | 未變：合成的空回覆仍在（`turn-cancel.ts:174`、`:192`） | native loop 沒有 state，空回覆不合成（照 dsh：沒內容就寫 `assistant/attempt`，`agent.ts:521-524`）。補「背景子代理撞 `maxTurns` 或被中止後再 `subagent.send`」的夾具 | K9 |
| W9 | `messages` 以外的 state | 部分：`_summarizationEvent` 已能從日誌補回（#1391）。`skillsMetadata`、`files`、呼叫計數、`_summarizationSessionId` 未變 | `skillsMetadata`：在組 thread 時算，放在宿主側。`files`（submit-record 的 StateBackend）：改寫到 fs 後端，或記成事件（Q11）。呼叫計數：native loop 自己數。摘要器的私有鍵：在 L2 改寫摘要器時一起拿掉 | K7、K10 |
| W10 | 系統提示與工具清單只有快照 | 未變：`request/*` 可略過，而且落在 `model/start` 之後 | 照 dsh 把它們變成推導的輸入：在 `model/start` 之前、不可略過（dsh 把 system/developer 寫成會產生訊息的事件，`agent.ts:459-477`、`:677-722`）。這是格式 one-way（§五 F2） | K7 |

## 五、會話日誌格式：要不要升、哪幾段是 one-way（第 3 點）

**原則：整串只升一次版，放在 L2 的 K7。** L0、L1 都不改寫入方，讀方的改動要讓凍結的 52 份夾具照樣讀得過。D168 Q4 定為整串只在 K7 升這一次。

| # | 改動 | 段 | 升版？ | one-way？ | 凍結的 52 份夾具 | #1597 關係檢查器 | web 讀端 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | 落盤的訊息形狀（`LoggedMessage {type, data}`）**不變**，native loop 用 nexus 自己的型別讀寫同一個形狀（Q2） | L0 K2 | 否 | 否 | 讀方換了實作，要逐位元組讀得一樣 | 不動 | 不動 |
| F2 | `request/system`、`request/header` 從可略過的事後快照，改成推導的輸入：寫在 `model/start` 之前、不可略過 | L2 K7 | **是** | **是**：新 runtime 寫的日誌，舊 runtime 讀到會拒開 | 舊格式的這兩顆照舊不讀（讀方要分支，登記 `readerBranch`） | 加一條：同一次模型呼叫內，這兩顆要落在 `model/start` 之前 | **讀**：trace 視圖讀這兩顆（`apps/web/src/components/trace/call.tsx` 的 `SnapshotDetails`、`apps/web/src/lib/trace-view.ts` 的 `SnapshotReason`），改位置之前先知會 dev-ui（K7c 前） |
| F3 | `assistant/attempt` 從可略過改成必寫（W7、dsh `agent.ts:544-547`） | L2 K7，與 F2 同一次升版 | 併入 F2 | 併入 F2 | 不影響（舊日誌照舊可略過） | 加：attempt 只能落在一對起訖裡 | 已經在畫（重試殘影），未核 |
| F4 | `turn/end` 的 reason 多一個 `max-turns`（W1） | L2 K9，**提前併進 F2 那一次** | 併入 F2 | 併入 F2 | 不影響 | 不動 | 要能顯示，先知會 dev-ui |
| F5 | `image/offload` 改寫在 `model/start` 之前，推導端套用（W2） | L0 K4 | 否：只動讀方與寫入時機，事件形狀不變 | 否 | 舊日誌的這顆落在 `model/start` 之後，讀方要兩種都認 | 不動 | 不動 |
| F6 | 核准改成行程內 await（§六）；`interrupt/raised` 還寫不寫 | L2 K8 | 若停寫：否（舊的照讀） | 否 | 不影響 | 不動 | 核准卡的顯示要改用 `approval/asked`，先知會 dev-ui（未核 web 今天讀哪一顆） |
| F7 | 拿掉 deepagents Filesystem 之後，不再有被搬走的人話（W3） | L2 K7 | 否 | 行為上 one-way：拒收過長的訊息是新行為 | 不影響 | 不動 | 要顯示拒收原因 |
| F8 | dsh 的 `step/start`／`step/end`、`agent/inbox/spliced`：**不引進**。nexus 已有 `model/start`／`model/end` 與 `inbox/spliced` 劃出同樣的邊界 | — | 否 | 否 | — | — | — |

F8 偏離 dsh。理由：
- dsh 用 step 邊界做兩件事：補結（closer）與收件匣領取。nexus 的補結已經用 `model/*` 與 `tool/*` 配對來做（`interrupted-turn.ts:257`），收件匣也有 `inbox/spliced`。
- 加 step 事件要再升一次版，換到的只是「事件名跟 dsh 一樣」。

撤除條件：出現只靠 `model/*` 劃不出來的邊界（例如一步裡有多次模型呼叫）。

## 六、interrupt、resume、背景子代理、存檔點拿掉之後（第 4 點，S2／S3 邊界）

**S2／S3 的邊界：**
- S2 收在「模型歷史只從日誌來」，也就是 L1 加 L2 的 K7；
- S3 是「存檔點整個拿掉」，也就是 K10。

W9 列的其他 state channel 歸 S3。K10 開工前，那幾個 channel 要已經有新家（§四 W9）。

| 情境 | 今天 | native loop（照 dsh） | 行為差異 |
| --- | --- | --- | --- |
| 核准 | `interrupt()` 掛起，存檔點存著，resume 用 `Command` | 同一行程內 await 核准服務，那一輪一直開著 | 常駐時看不出差異。重啟時：今天 pump 的 `#pending` 只在記憶體（`thread-pump.ts:1244`），wire 對舊 id 回 `no_such_interrupt`（`wire-handler.ts:2733-2738`），本來就跨不過重啟。**這是讀碼，沒有實跑**，所以改成 await 不算退步 |
| 停在核准點時行程死掉 | replay 認得 `interrupt/raised`，替沒答的呼叫補錯誤結果 | 續接補結：補錯誤型 `tool/result`，用 dsh 的「結果未知、別盲目重試」措辭（`repair.ts:31-33`） | 措辭可能不同，夾具要釘住 |
| ask_user | `interrupt()` 掛起 | 阻塞版：工具本體 await（同今天）。或計時版：逾時回 pending、之後 steer（Q7） | 計時版會改變使用者看到的行為 |
| plan-mode、sandbox 升級 | `interrupt()` | 同 ask_user 的阻塞版 | 無 |
| MCP elicitation | `@langchain/mcp-adapters` 內部 `interrupt()`；它也用 `getCurrentTaskInput` | 換掉 adapter，直接用 `@modelcontextprotocol/sdk`（已是 mcp 插件的直接相依，lockfile 有 1.32.0）。elicitation 改走核准服務的 await | adapter 換掉，工具描述的位元組可能變，要過 live A/B |
| 中止 | `turnCancel` 那一層與 pump 補半段 | 照 dsh：有內容就寫 `assistant/message{interrupted}`，沒內容就寫 `assistant/attempt`；沒開始的呼叫補 skip 結果 | 合成的空回覆不再出現（W8） |
| 服務重啟後續聊 | `resumeClosingInterruptedTurn` → `restoreConversation` → `updateState` 灌回 | 只剩 `resumeClosingInterruptedTurn`，之後直接從日誌推 | 少一條路徑 |
| 背景子代理續行／冷復活（#1271） | 存檔點，或 `cold.restore` | 子代理用同一份 native loop，從子日誌推 | 無 |
| `recursionLimit` | `withConfig({recursionLimit})`（`agent-factory.ts:966-974`），撞到拋 `GRAPH_RECURSION_LIMIT`（`cli.ts:1422`） | dsh 沒有。native loop 需要一個「一輪最多幾步」的保險絲，換算成步數：今天的值除以每步的節點數（推論，未核） | 數字與錯誤碼都會變（Q14） |

## 七、工具定義的新形狀（第 5 點）

**新形狀**：`@nexus/tools` 2.0（major，契約今天是 1.4.0）。

```ts
interface NexusTool {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema            // 純資料
  readonly rootOnly?: ToolRootOnlyRefusal
  execute(args: JsonValue, exec: ToolExec): Promise<NexusToolResult>
}
interface ToolExec {
  readonly callId: string
  readonly threadId: string                  // 取代 configurable.thread_id
  readonly agent: { readonly kind: 'root' | 'subagent'; readonly id: string }   // 取代 checkpoint_ns
  readonly signal: AbortSignal
  concludeTurn(): void
  deferContext(text: string): void           // 取代 Command 注入 HumanMessage（goal 的 update_goal）
}
type NexusToolResult =
  | { readonly ok: true; readonly content: MessageContent; readonly meta?: JsonValue }
  | { readonly ok: false; readonly content: MessageContent; readonly error: ToolErrorInfo }
```

| 決定 | 選項 | 選定與理由 |
| --- | --- | --- |
| 參數 schema | (a) 照 dsh 用 JSON Schema（純資料）；(b) 契約收 zod，邊界上轉 | **(a)**。插件可以繼續用 zod 寫，再用 zod 4 內建的 `z.toJSONSchema()` 轉，不必新下載（`zod@4.6.7` 已是直接相依）。MCP 的工具本來就是 JSON Schema。(b) 會讓服務值裡留著 zod 物件，§八 又多一項 |
| 呼叫身分 | (a) `exec` 上的資料欄；(b) 照舊從呼叫設定裡挖 | **(a)**，照 dsh `ToolRunContext`。今天 `forCall(invocation)`（`@nexus/session`、`@nexus/fs`）收的 invocation 在 L2 改成 `ToolExec` |
| 錯誤碼 | (a) 結果上的資料欄；(b) 照舊放 WeakMap | **(a)**。`tool/result` 事件本來就有 `error?: ToolErrorInfo`（`session-log.ts:1325`），格式不用動 |
| 改 state 的工具 | goal 的 `update_goal`、submit-record 回 `Command` | goal 改 `exec.deferContext()`（照 dsh，`contracts.ts:174-261`）；submit-record 的 `files` 看 Q11 |

**遷移順序**：
1. **K3a** 先做 2.0 契約，加一個雙向轉接器：`NexusTool` 轉成 LangChain `tool()`，讓 L0 到 L1 還在 LangGraph 上照跑。轉接器只住在宿主，插件不碰。
2. **K3b**、**K3c** 分批遷插件：

| 批 | 插件 | 登記路徑 | 難點 |
| --- | --- | --- | --- |
| K3b | echo、todo、present、ask-user、goal、submit-record | 樹 | ask-user 的 `interrupt` 等 K8；goal 的 `Command` 改 `deferContext`；submit-record 的 `files` 等 Q11 |
| K3c | quickjs、plan-mode、sandbox-policy、mcp | 相容層 | plan-mode、sandbox-policy 還帶 `createMiddleware`，要先有 §3-3 的接縫（#1385 Fog 的 P1–P4、S1–S3）；mcp 要換掉 adapter |

插件改了之後，`registry.tools.register` 的舊簽名留到 L3 才拿掉。

## 八、改完之後，服務值裡哪些是資料、哪些仍是 JS（第 6 點）

對著全 Rust 研究 `.docs/nexus-cordis-full-rust-2026-11-02.md` §4-2 逐項列。

記號：
- D：純資料，可序列化；
- F：JS 函式或 closure；
- O：其他不可序列化的物件；
- L：LangChain／LangGraph 物件。

「今天」是子代理對 `cc305eb6` 讀碼的結果，我抽查了 `callThreadId`（`session-address.ts:188-194`）。所有服務值本身都是 `ContractService` 子類的實例（O）。

| 服務（token） | 方法 | 今天 | 照本設計改完（K3、K7 之後） |
| --- | --- | --- | --- |
| `tools` | `register(tool)` | L（`StructuredToolInterface`） | `name`／`description`／`parameters` 變 D；**`execute` 仍是 F** |
| | `list()` | L | D（schema 的投影）＋F（`execute`） |
| | `gate(listener)` → `tools/pre-execute` | F；listener 收 D、回 D | **仍是 F**（監聽者）；payload 與回傳是 D |
| | `onResult(listener)` → `tools/result` | F | **仍是 F**；payload 是 D |
| | `concludeTurn(name)` | D | D |
| `agentLoop` | `preStep(name, listener)` → `agent/pre-step` | F；收 `BaseMessage[]`（L）與 `configurable`（L）、`AbortSignal`（O） | **仍是 F**；`visible` 變 D（落盤的形狀，F1）；身分變 D；`signal` 仍是 O |
| `sessionLookup` | `forCall(invocation)` | 參數 L、回 `SessionLog`（O） | 參數變 D（`ToolExec` 的身分欄），**回傳仍是 O** |
| | `join(installer)` | F | **仍是 F** |
| `sessionDurability` | `checkpoint(log)` | O | O |
| `fs` | `forCall` | 參數 L、回 `FsService`（O），`backend()` 回 deepagents 的 `AnyBackendProtocol` | 參數變 D；`backend()` 換成 nexus 自己的協定型別（Q11），**仍是 O** |
| `approvalChannel` | `current()` | D | D |
| `projections` | `register(unit)` | unit 的 `init`／`apply`／`view`／`detail` 是 F | **仍是 F**（dsh 同） |
| `skillSources` | `addSource`、`sources` | D | D |
| `commands` | `register(def)` | `handler` 是 F，收 `AbortSignal`、`SessionLog`（O） | **仍是 F** |
| `goals` | `serviceFor(log)` | 收 O、回 O（方法是 D） | 同左 |
| | `onActivationChanged(log, listener)` | F | **仍是 F** |
| `messageFeedback` | `put`／`delete`／`list`／`record(log, req)` | 收 O | 同左 |
| `permissionPresets` | `start`、`narrowDelegated` | D | D |
| `systemPrompt` | `section`、`variable`、`assemble` | D（`section` 回 disposer，F） | 同左。中段（`text` 可以是函式，多一個 F）不在這個契約裡：形狀與值在 `@nexus/core` 的 `prompt-sections.ts`，插件經 `registry.prompt` 登記，由宿主接在洋蔥的原格（K7a #2414；core 的 runtime 不經掛著 `@nexus/sdk` 的契約套件） |
| 宿主的 `assembly` | `create(invocation)` | 回整張 LangGraph 圖（L） | 回 native loop 的實例（O） |
| 相容層 `PluginRegistry` | `tools`／`middleware`／`subagents`／`backend` | L、L/deepagents | L3 拆掉 |

**給 dev-rs 的一句話**：
- L 會全部消失，§4-2 點名的兩處（`ToolRegistry.register`、`AgentLoop.preStep`）不再收 LangChain 物件。
- 但服務值裡仍有六類 JS 函式，要跨 Rust 邊界就得處理：工具 `execute`、四種事件監聽者（pre-execute、result、pre-step、projection）、命令 handler、`join`／`onActivationChanged` 這類安裝者。
- 另外還有幾種不可序列化的物件：`SessionLog`、`FsService`、`AbortSignal`、`GoalService`。

這跟 dsh 一樣（§1-4，dsh 的 `ToolDefinition.execute` 與所有監聽者都是函式）。所以 §4-2 的 (ii)「服務值收斂成資料＋RPC」，**照 dsh 走到底也只走到一半**。要走完，得把監聽者改成按名字呼叫的 RPC，D168 Q9 定為不在這一串。

## 九、跟 #1947 的先後與撞檔（第 7 點）

#1947 的設計見 `.docs/supervisor-1947-design-2026-11-03.md`（PR #2335，已合 `45fa00b1`）§九；子卡已開，C1 是 #2338、C3 是 #2341。

| 檔 | 本串哪幾張碰 | #1947 哪幾張碰 | 誰的 |
| --- | --- | --- | --- |
| `apps/harness/src/thread-pump.ts`（4078 行） | K5（影子比對讀推導）、K6（換 loop 的串流）、K8（resume）、K10（`getState`／`updateState`） | C1（對話行程入口）可能動到收尾路徑（未核） | 本串 dev-h3；C1 dev-h2 |
| `apps/harness/src/wire-handler.ts` | K8（`no_such_interrupt` 那段） | C1（在 socket 上跑） | 同上 |
| `apps/harness/src/assembly-root.ts` | K6（建 native loop）、K10（拿掉 `PrunedMemorySaver`） | C1（建根、載插件、預熱） | 同上 |
| `apps/harness/src/serve.ts` | K10（restore 路徑） | C3（前台與啟動器） | 同上 |
| `packages/nexus-core/src/fold.ts`、`agent-assembly.ts` 與各 middleware | K4、K5、K7 | 無 | dev-h3 |
| `packages/nexus-tools`、10 個插件 | K3 | 無 | dev-h3 |

**建議的順序（Q12）**：
1. **K0–K5**（不動 loop、只少量動 pump）與 #1947 的 C0、C2a、C2b 並行。
2. **K6 起**等 C1（#2338）合進 develop。C1 會重整入口與組裝，K6 在它上面接 native loop，比反過來衝突少。
3. **K10**（拿掉存檔點、改 restore）排在 C3（#2341）之後。
4. **K12**（native loop 改預設）排在 #1947 改預設之後，並且用 `per-thread` 形狀重量 D162。#1947 C7 量的是存檔點路徑，換 loop 之後基準就變了，兩個改預設的 PR 不能共用同一份量測。

## 十、已拍板（#1827 D168）

demian 2026-11-03 在 PM session：14 題全部照推薦（Q5 選 (b)、Q7 選 (a)、Q9 不在這一串）。

| # | 題 | 拍板 | 理由 |
| --- | --- | --- | --- |
| Q1 | 照 §三 分四段（L0 前置、L1 S2、L2 開關並存的 native loop、L3 拿掉），開關 `--agent-loop=langgraph\|native` 比照 `--process-model`？ | **是** | 每段都是 two-way，錯分得開（§3-1） |
| Q2 | 落盤的訊息形狀（`LoggedMessage {type, data}`）不換成 dsh 的 `Message`，native loop 用 nexus 自己的型別讀寫同一個形狀？ | **是** | 換形狀要升版而且是 one-way，52 份凍結夾具全要重做；開關要兩個 loop 互相讀得懂才做得成（§五 F1） |
| Q3 | `agent/request` 不落地，換模型走既有的 `model/selection`、輸出上限走 loop 選項？（偏離 #1339 卡上「三事件」的寫法） | **是** | dsh 自己在 `ce7073d5` 已棄用它（§1-3） |
| Q4 | 整串只在 K7 升一次格式版本，F2、F3、F4 併在那一次？ | **是** | one-way 只付一次 |
| Q5 | 子代理撞到 `maxTurns`：(a) 照舊合成一則助手訊息並記成事件；(b) 用 `turn/end{reason:'max-turns'}` 收，不合成訊息 | **(b)** | 日誌與模型看到的天生一致，不用再造一種「沒有模型呼叫的助手訊息」；dsh 沒有這個上限，偏離理由是產品需求。子代理之後再被 `send` 時，看不到那一句上限說明（行為差異） |
| Q6 | 核准、plan-mode、sandbox 升級、MCP elicitation 改成行程內 await（照 dsh），不再有跨重啟的掛起？ | **是** | 今天本來就跨不過重啟（讀碼，未實跑，§六） |
| Q7 | ask_user：(a) 阻塞版（同今天）；(b) dsh 的計時版（逾時回 pending、之後插話） | **(a)** 先上；(b) 等有需求再開卡 | (b) 會改變使用者看到的行為，不該跟換 loop 綁在一起 |
| Q8 | 拿掉基座「超過 200k 字元的人話搬到檔案」，改成入口拒收過長的訊息？ | **是**，上限在 K7 量完再定 | 那條搬走沒有事件、推導不套；我沒找到 wire 或 pump 對單則人話有更小的上限（只做了有限的 grep，未核） |
| Q9 | 服務值要不要再往下做成純資料＋RPC（監聽者改成按名字呼叫）？ | **不在這串**。照 dsh 做完，把 §八 的清單交給 dev-rs 重評 | dsh 也沒這樣做；做了等於提前做 Rust 化的一半，範圍會翻倍 |
| Q10 | `@langchain/openai` 換成直接用 `openai` SDK，算這串的範圍？ | **是**（K11） | 模型轉接器收的是 `BaseMessage`，不換就拿不掉 `@langchain/core`。`openai@7.5.0` 已在 lockfile（間接相依），改成直接相依要 PM 確認，預期不需新下載 |
| Q11 | deepagents 也一起拿掉：backend 協定改成 nexus 自己的型別；Filesystem／skills／memory／task／摘要基座換成自己的；submit-record 的 `files` 改寫到 fs 後端？ | **是** | 它們都是 `createMiddleware` 或 LangGraph state，不拿掉 loop 就換不掉；`contained-backend.ts` 等 16 個 core 檔用 `AnyBackendProtocol` |
| Q12 | 跟 #1947 的順序照 §九？ | **是** | 撞檔集中在 pump、wire-handler、assembly-root、serve |
| Q13 | L1 切到「歷史從日誌推」時，每輪 CPU 允許退步多少？ | **≤ 今天存檔點路徑的 ×1.05**（r7-driver 的三段中位數），K1 量完不夠再回來 | D162 的上限是在存檔點路徑上量的 |
| Q14 | native loop 一輪最多幾步：沿用 `recursionLimit` 的設定列換算成步數，錯誤碼改名？ | **是**，換算方式在 K6 寫明並寫升級指南 | dsh 沒有這個保險絲；nexus 主機多人共用要有（#1490 那條線） |

## 十一、子卡草稿

共同規則：
- 每張都掛 #1339。
- PR 標題照 AGENTS.md。
- 對照 dsh 寫在 PR 內文。
- 預設行為除了 K12 都不動。
- 「歸屬」照分工記憶：核心底座 dev-h3、harness 與宿主 dev-h2、web dev-ui。

依賴：

```
K0 ─┬─ K1 ── K5 ───────────┐
    ├─ K2 ─┐               │
    ├─ K3a ┼─ K3b ── K3c ──┼─ K6 ── K7 ── K8 ── K9 ── K10 ── K11 ── K12 ── K13
    └─ K4 ─┘               │   （K6 等 #2338；K10 等 #2341；K12 等 #1947 改預設）
```

### K0 讀取面護欄：讀 state 的地方只許白名單（dev-h3）

- **範圍**：一條 AST 護欄測試，列出今天讀 `state.messages`／`request.state`／`getState` 的每一處（W6）。新增讀者就紅。
- **驗收**：
  - 清單與 §四 W6 對得上，有出入的寫進 PR；
  - 突變：新增一個讀者會紅。
- **依賴**：無。

### K1 增量推導與每輪成本量測（dev-h3）

- **範圍**：core 加 `deriveModelHistory(log)` 的增量快取（§3-2 (i)）。結果要與 `replayConversation` 逐位元組相同。
- **驗收**：
  - 夾具 `log-derived-history` 全部場景、52 份凍結夾具與 v14 系列，增量與整份重算逐位元組相同；
  - 突變：失效規則漏掉壓縮（`compaction/summary`）、剪（`compaction/prune`）、截斷（`compaction/truncate-args`）、`session/end-seed` 座標重設任一種會紅。今天的 `replayConversation` 不套用省略（`image/offload`，§四 W2），所以省略的失效規則與它的突變在 K4 跟套用一起做（PM 2026-11-03 定）；
  - 在 #2117 那份大日誌與 r7-driver 45 輪上量 (i)、(ii) 與今天的存檔點路徑，數字寫回 #1339，拿去回答 Q13。
- **依賴**：K0。

### K2 nexus 自己的訊息型別（dev-h3）

- **範圍**：core 定義與 `LoggedMessage` 同形的訊息型別與轉換，推導端不再 import `@langchain/core/messages`。LangGraph 那一側用轉接器。
- **驗收**：
  - 52 份凍結夾具讀出來逐位元組相同；
  - 推導端的檔案 import `@langchain` 的數目歸零（用 grep 的數字證明）。
- **依賴**：K0。

### K3a `@nexus/tools` 2.0 契約與轉接器（dev-h3）

- **範圍**：§七 的 `NexusTool`、`ToolExec`、`NexusToolResult`；宿主的雙向轉接器；`forCall` 收 `ToolExec`；錯誤碼改成結果上的資料欄。
- **驗收**：
  - 用 echo 當試點，工具描述、參數 schema 送上線的位元組與今天相同（請求本文比對）；
  - 一致性套件加「schema 是 JSON」一格。
- **依賴**：K0。

### K3b 樹上的六個插件遷到 2.0（dev-h3）

- **範圍**：echo、todo、present、ask-user（`interrupt` 先留在轉接器裡）、goal（`deferContext`）、submit-record（`files` 照 Q11 改寫到 fs 後端）。
- **驗收**：
  - 每顆的工具描述位元組不變；
  - 原有測試全綠；
  - 插件的非測試檔不再 import `@langchain/core/tools`。
- **依賴**：K3a。

### K3c 相容層的四個插件遷到 2.0（dev-h3）

- **範圍**：quickjs、plan-mode、sandbox-policy、mcp（換成直接用 `@modelcontextprotocol/sdk`）。plan-mode、sandbox-policy 要先有 §3-3 的接縫。
- **驗收**：
  - mcp 換掉 adapter 之後，工具清單與描述的位元組比對，有差異的列出來，並過 live A/B（#1339 的收尾條件 3）；
  - 相容層少四列。
- **依賴**：K3b。plan-mode 的 P1–P4 要先拍板（#1385 Fog）。

### K4 推導端收成一套規則（dev-h3）

- **範圍**：W2（推導端套用省略，決定寫在 `model/start` 之前，讀方兩種位置都認）、W4（孤兒與懸空呼叫照 dsh `repair.ts` 定一套）、W5（空助手內容併成一份函式）。
- **驗收**：
  - 每一項都有夾具場景；
  - 舊位置的 `image/offload` 從凍結夾具讀得過；
  - 突變各自會紅；
  - K1 的增量推導遇到 `image/offload` 要失效：拿掉這條失效規則會紅（PM 2026-11-03 定）。
- **依賴**：K1。

### K5 S2：影子比對，再切到「歷史從日誌推」（dev-h3）

- **範圍**：
  - 開關 `history-source=state|shadow|log`。
  - `shadow`：最外層 middleware 每次模型呼叫比對推出來的歷史與 `request.messages`，不一致就記一個計數器與 dev log，**不寫進會話日誌**。
  - `log`：拿推出來的歷史換掉 `request.messages`。
  - W6 的讀者改讀推導；W7 的兩處改成 fail-closed。
  - 預設 `state`。
- **驗收**：
  - `shadow` 下夾具全場景與 wire e2e 零差異；
  - `log` 下同一套全綠；
  - 每輪 CPU 符合 Q13；
  - 第二句請求帶出去的助手歷史，每一則日誌上都有（#1341 G2 的判準）。
- **依賴**：K1、K4。

### K6 native loop 骨架（dev-h3）

- **範圍**：
  - `--agent-loop=langgraph|native`，預設 `langgraph`。
  - §1-1 的 turn／step、`agent/pre-step`、`llm/stream`、`agent/request-error`（重試監聽者）、工具管線事件、`agent/turn-stopping`、收件匣與插話、中止補結、一輪的步數保險絲（Q14）。
  - 只有 root，不含子代理。
  - 模型轉接器暫時包 `@langchain/openai`（K11 才換）。
- **驗收**：
  - `native` 下 wire e2e、web e2e（#1602）與夾具全綠；
  - 同一份腳本兩個 loop 寫出的日誌逐事件對照，差異逐條登記；
  - `langgraph` 下一條測試都不動。
- **依賴**：K2、K3a、K5；#1947 C1（#2338）已合。

### K7 middleware 遷成事件與服務（dev-h3；跟 harness 宿主有關的幾顆和 dev-h2 協調）

- **範圍**：
  - 25 顆 `wrapModelCall`、二十來顆 `wrapToolCall`、`beforeAgent`／`beforeModel` 逐顆搬到 §3-3 的歸宿；
  - 基座的摘要、Filesystem、skills、memory、task 換成 nexus 自己的；
  - W3、W9、W10；
  - 格式升版（F2、F3、F4，Q4）與 `readerBranch` 登記。
- **驗收**：
  - 逐顆對照表寫進 PR，每顆都有歸宿；
  - `native` 下請求本文與 `langgraph` 下逐位元組比對（夾具全場景），差異逐條登記；
  - 舊格式夾具讀得過；
  - 關係檢查器加 F2、F3 的規則；
  - 先知會 dev-ui。
- **依賴**：K6。工作量大，開卡時再拆成模型側、工具側、系統提示側三張。

### K8 中斷改成行程內 await（dev-h3）

- **範圍**：核准、ask-user（阻塞版，Q7）、plan-mode、sandbox 升級、MCP elicitation；wire 的 resume 改接核准服務；`no_such_interrupt` 的語意寫明。
- **驗收**：
  - 核准、拒絕、中止、停在核准點重啟四種情境，`native` 下有夾具與 web e2e；
  - 重啟後的補結措辭釘住。
- **依賴**：K7。

### K9 子代理上 native loop（dev-h3）

- **範圍**：一次性 `task`、背景子代理、冷復活、`subagent.send`；`maxTurns` 照 Q5；不合成空回覆（W8）。
- **驗收**：
  - 背景子代理撞 `maxTurns` 或被中止後再 `send` 的夾具；
  - #328 的實機情境在 `native` 下重跑。
- **依賴**：K8。

### K10 拿掉存檔點（S3）（dev-h3，restore 路徑跟 dev-h2 協調）

- **範圍**：
  - `native` 下不建 `PrunedMemorySaver`；
  - 續接只走 `resumeClosingInterruptedTurn` 加推導；
  - 刪掉 `getState`／`updateState` 的路徑（W7 `:3424` 跟著消失）。
- **驗收**：
  - 重啟續聊、冷復活、閒置逐出後回來，三種情境 `native` 下全綠；
  - 記憶體量一次，跟今天比。
- **依賴**：K9；#1947 C3（#2341）已合。

### K11 模型轉接器換成 `openai` SDK（dev-h3）

- **範圍**：`live-model.ts` 的 fetch 疊保留，`ChatOpenAI` 換成直接呼叫 `openai`；附件投影、串流內錯誤、閒置逾時照舊。
- **驗收**：
  - 請求本文逐位元組比對（夾具與重放快照 #1556）；
  - 錯誤分類測試全綠；
  - live A/B 跑一次（要打真端點，跑之前先問 PM）。
- **依賴**：K10；Q10。

### K12 native loop 改成預設（dev-h3；web 顯示 dev-ui）

- **範圍**：
  - Linux 與 macOS 預設都改 `native`；
  - 升級指南寫明步數保險絲、ask_user、拒收長訊息、錯誤碼的變化；
  - 用 #1947 的 `per-thread` 形狀重量 D162。
- **驗收**：
  - D162 三段與整段的數字；
  - #1339 收尾條件三條：沒有第二份歷史、推導與請求逐位元組相同（含 Fog 列的場景）、模型面行為過 live A/B。
- **依賴**：K11；#1947 改預設已合。

### K13 拿掉 LangChain／LangGraph／deepagents 與開關（dev-h3）

- **範圍**：
  - 刪掉 `langgraph` 那條路徑、轉接器、相容層的 LangChain 接縫；
  - 從 `package.json` 拿掉相依；
  - `@nexus/wire` 的 `@langchain/protocol` 換成自己的型別（這個 wire 的事件協議 web 也在讀，要先跟 dev-ui 確認）。
- **驗收**：
  - 非測試檔 import `@langchain`／`langchain`／`deepagents` 的數目歸零，用 grep 證明；
  - packed-install 與 node-compat 全綠；
  - PM 依 D167 把 §八 的清單轉給 dev-rs。
- **依賴**：K12 至少發過一個版本（舊路徑保留一版）。

## 十二、沒量、沒核的

- **所有數字都是讀碼，沒有實測。**
  - 每輪成本是 K1 的事。
  - 「核准跨不過重啟」只讀了碼。
  - W3 搬走人話在實務上碰不碰得到不確定。
- 三份研究子代理的報告（dsh loop、nexus 工具與服務值、nexus loop 與 LangGraph 狀態）是 Opus 讀碼。我抽查過的行號只有：
  - dsh：`runtime-types.ts:360-365`、`session/src/index.ts:999`、`tools/src/contracts.ts:26`、`agent.ts:344`、`agent.ts:620-660`、`model-selection.ts:112-115`、`compaction-basic/src/index.ts:183`；
  - nexus：`session-address.ts:188-194`、`thread-pump.ts:3070-3072`、`assembly-root.ts:1097-1101`、`fold.ts:755`、`interrupted-turn.ts:257`、`session-log.ts:1322-1326`、`logged-message.ts:73-81`。

  其餘標「讀碼、未核」。
- **沒核的**：
  - `withAttribution`、`withStreamCompletionCheck` 接在 fetch 疊的哪一格；
  - `include` 列提供的服務；
  - `registry.services` 裡插件私有的字串鍵；
  - plugins.rest 在出貨清單裡的實際先後；
  - deepagents 內部用到的 LangGraph 功能；
  - web 讀不讀 `interrupt/raised`。（`request/system`、`request/header` 已核：trace 視圖讀，見 §五 F2。）
- **§3-3 對應表**是大類，不是逐顆的結論，要在 K7 逐顆核。
