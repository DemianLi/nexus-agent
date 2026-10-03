# R6：web 側欄盤點——「觀測對話與決策」與「任務成本」

- 基準：`develop` `501e153`（2026-10-04 04:41）。dsh clone `references/deepseek-harness` 停在 `5badb15`（2026-10-03），引用前要再對 SHA。
- 方法：只讀原始碼。沒有跑測試、沒有實機、沒有截圖。標「推論」的是我從程式碼推出來的設計；標「待驗」的是沒跑過、只靠讀碼的事實宣稱。
- 路徑一律相對於 repo 根目錄。

---

## 0. 結論速覽

1. **右側欄的分頁是寫死的封閉聯集，不是註冊表**，插件加不進來（證據見 §2.4）。要新增分頁，得改 `lib/right-sidebar.ts` 的 `SidebarTab`、`parseTab`、`tabKey`，以及 `components/right-sidebar.tsx` 的 `TabBody`、`TabChip` 圖示、`useTabTitle`。資料面同樣封閉：`custom` frame 是名字→酬載的封閉表，折疊器做窮舉；圖自己寫的 `custom` frame 會被 pump 丟掉。
2. **時間戳在線上有，但折疊器丟掉了**。每顆 `Event` 都帶 `params.timestamp`：歷史那條取日誌的 `time`，即時那條由 pump 轉發或自己蓋。可是 `ConversationEntry` 的十種裡沒有任何時間欄位。要做「一輪的時間線」，卡在這一點。
3. **今天就有、可以直接拿來用的觀測材料**：人話、推理（持久）、回覆、工具卡（四態加錯誤碼、`meta`）、決定紀錄（**只存本地**）、提問答案、計劃卡結果（持久）、壓縮列、結算通知、子代理來信、撞輸出上限、已停止、失敗。
4. **日誌裡有、但從不上線的事件**：模型呼叫起訖 `model/start`/`model/end`、模型重試 `llm/retry`/`llm/retry-started`、外掛注入的 `user/message`（重複呼叫提醒、goal 指示）、`interrupt/raised`、`command/*`、`sandbox/mode`。所以「重複呼叫提醒」與「重試／限流」在 web 上**完全看不到**。
5. **成本的現況**：只有 root 的累計總帳，包括 `tokenUsage`（輸入含快取讀取、輸出）與 `sessionStats`（輪、模型呼叫次數、模型耗時、工具耗時），畫在頂列的 `SessionUsage` popover。沒有逐輪用量、沒有工具次數，總帳也不含子代理。背景子代理的總帳理論上會隨它自己那頁歷史一起送來，但沒有畫面使用它（推論，待驗）。
6. **建議切法（推論）**：先開一張 web 卡，只用現有資料。內容是把右側欄改成能放單例分頁，加上「成本」分頁，再加一版不帶時間的「觀測」分頁。harness 補的卡依序是：entry 帶時間、逐輪用量、把缺的事件上線、決定紀錄（後者牽涉政策）。web 再分兩階段接上。

---

## 1. 版面與面板盤點

App 殼：`App.tsx:196-211`（`SidebarProvider`）→ `ConversationView`（`App.tsx:215`）。換 thread 時整個重新掛載（`key={choice.threadId}`，`App.tsx:197`）。版面從左到右依序是：`AppSidebar`、`SidebarInset`（會話區，基準寬 480，`App.tsx:384`）、`RightSidebarPanel`（`App.tsx:624`）。

### 1.1 左側欄

| 元件 | 顯示什麼 | 資料從哪來 |
| --- | --- | --- |
| `app-sidebar.tsx` | 「新對話」與會話清單。1024 以上是桌面側欄，以下收成抽屜。清單只在看得到時掛載（`app-sidebar.tsx:9-13`） | `useThreadDirectory`（掛在 `App`，不在側欄） |
| `thread-list.tsx` | 依今天／昨天／7 天內／更早分組；標題搜尋，加上伺服器端內容搜尋（#760）；每列一個狀態點（等人回答＞在跑＞跑完沒看）（`thread-list.tsx:30-50`） | `GET /threads`（`THREADS_PATH`，`protocol.ts:514`）、`POST /threads/search`（`:588`）、全域下行 `GET /threads/feed`（`:652`，frame 有 `status`、`input-requested`、`input-withdrawn` 三種，`:655-680`）。hook 在 `hooks/use-thread-directory.ts:7-17` |

### 1.2 會話區頂列與狀態

| 元件 | 顯示什麼 | 資料從哪來 |
| --- | --- | --- |
| 標頭（在 `App.tsx:385-400`） | 側欄鈕、標題、`SessionUsage`、主題鈕、右側欄開關鈕。375 寬時有三顆 44px 圓鈕加一顆用量 pill | `state.title`（`title` frame） |
| `session-usage.tsx` | 收著時顯示總量；點開是 popover，分「累計」「時間」兩段（`session-usage.tsx:20-27`，規則在 `lib/session-usage-view.ts:1-17,50-70`） | `state.tokenUsage`、`state.sessionStats`（`custom` frame 的 `tokenUsage`／`sessionStats`，`session-totals.ts:41-64`） |
| `status-line.tsx` | 全站唯一的 `role="status"`：執行中、待決、失敗、斷線重連（`status-line.tsx:1-12`） | `ConversationState` 整份，加上 hook 的連線狀態 |
| `context-meter.tsx` | 輸入框底列的小環：離自動摘要還有多遠，點開看明細（`context-meter.tsx:11-20`） | `state.contextPressure`（`model/usage`、`context/measure` 兩種 frame，`context-pressure.ts:33-69`） |

### 1.3 輸入框上方（在換手區外，`App.tsx:471-490`）

| 元件 | 顯示什麼 | 資料從哪來 |
| --- | --- | --- |
| `plan-chip.tsx` | 計劃模式開著時顯示一顆標籤，只負責退出（`plan-chip.tsx:7-15`） | `state.planMode`（`plan` frame）；退出走 `/plan off` |
| `goal-bar.tsx` | 目標與階段，**blocked 時直接顯示理由**，只讀（`goal-bar.tsx:6-14`） | `state.goal`（`goal` frame，`conversation.ts:930-967`）。歷史**只在最新一頁送目前的值**（`conversation-history.ts:1184-1191`），所以看不到過去的階段變化 |
| `todo-panel.tsx` | 待辦清單，「2/5 完成 · 進行中那一項」（`todo-panel.tsx:8-22`） | `state.todos`（`todos` frame） |
| `queue-dock.tsx` | 送出佇列：改、刪、插話（`queue-dock.tsx:13-15`） | `state.inbox`（`inbox` frame） |
| `pending-swap.tsx` | 換手層：核准、提問、計劃審核的面板換掉輸入框（`pending-swap.tsx:1-13`） | `state.pendings`（`input.requested`） |
| `approval-card.tsx`／`question-panel.tsx`／`plan-review.tsx` 的 `PlanReviewPanel` | 三種待決面板 | 同上 |

### 1.4 對話列表裡的卡片與列（`transcript.tsx`）

分派在 `Entry`（`transcript.tsx:154-300`）。改動卡與交付卡收攏到該輪尾端（`transcriptItems`，`lib/deliverables-view.ts`）。

| 元件 | 顯示什麼 | 資料從哪來 |
| --- | --- | --- |
| 人的泡泡 | 人話，`@` 引用畫成可點的區塊 | `HumanEntry`。即時來自 `inbox` 的 `claimed`，歷史來自 `message-start role:human`（`conversation.ts:1279-1287`） |
| AI 泡泡 | markdown 回覆；也會顯示「已停止」、輸出上限提示、紅字錯誤、讚踩（`transcript.tsx:238-300`） | `AiEntry`（`messages` channel） |
| `reasoning-row.tsx` | 「思考中／思考過程」一行，預設收合，展開是 markdown（`reasoning-row.tsx:7-16`） | `AiEntry.reasoning`，見 §3 |
| `tool-card.tsx`＋`tool-result.tsx` | 工具卡：狀態、標題、摘要、歸屬；展開看參數、結果、diff、讀檔／搜尋專屬卡（`tool-card.tsx:1-23`、`tool-result.tsx:1-18`） | `ToolEntry`（`tools` channel：`tool-started`／`suspended`／`finished`／`error`，`conversation.ts:1457-1557`），`meta` 給專屬卡用 |
| 決定 chip（`Marker`） | 置中 chip：「已核准：X」「已拒絕：X（沒有執行）」（`transcript.tsx:139-151,184-191`） | `DecisionEntry`，**只存本地**（`conversation.ts:245-268`） |
| `compaction-row.tsx` | 「對話已壓縮：前 N 則換成了摘要」，可展開摘要（`compaction-row.tsx:13-22`） | `CompactionEntry`（`compaction` frame） |
| 結算通知、子代理來信 | 「背景子代理完成了」「某某子代理說：…」（`transcript.tsx:203-217`） | `NoticeEntry`、`AgentMessageEntry` |
| `changes-card.tsx` | 這一輪改了哪些檔、各改幾行；點擊在右側欄開審查頁（`changes-card.tsx:1-11`） | `WorkspaceChangesEntry` 只帶 `seq`，摘要另外去 `changes/summary` 讀 |
| `changes-review.tsx` | 右側欄的改動比對頁，有選檔器、單欄或對照（`changes-review.tsx:1-18`） | `ChangesStores`（`lib/changes-diff.ts`） |
| `deliverables-card.tsx` | 交付卡：檔名、說明、預覽、下載、複製路徑（`deliverables-card.tsx:1-16`） | `DeliverablesEntry`（`deliverables/presented` frame） |
| `deliverable-preview.tsx`／`deliverable-download-button.tsx` | 右側欄的交付預覽（往下接續讀）與下載 | `DeliverableFileStore`、`DeliverableDownloader` |
| `plan-review.tsx` 的 `PlanToolCard`＋`plan-preview-tab.tsx` | 對話裡的計劃卡，附結果 chip；全文開在右側欄 | `exit_plan_mode` 的 `ToolEntry` 加上對話裡的計劃（`usePlanLibrary`，`App.tsx:365`） |
| `subagent-control.tsx` | 背景子代理委派卡展開後：輸入框、停止鈕，以及**子代理自己那份對話**（只有歷史）（`subagent-control.tsx:1-19`） | `subagentSend`／`subagentInterrupt`、`subagentHistory`（`protocol.ts:754`）、`state.subagentStatus` |
| `earlier-pager.tsx` | 往前翻頁：按鈕加自動載入（`earlier-pager.tsx:1-14`） | `threadHistory` 帶 `beforeSeq`／`throughSeq` |

### 1.5 右側欄（`components/right-sidebar.tsx`，#640）

- **分頁有三種**：`changes`（座標 `seq`＋`index`）、`deliverable`（`LocatedFile`）、`plan`（工具呼叫 id）（`lib/right-sidebar.ts:23-36`）。去重的鍵是 `tabKey`（`:48-52`）。
- **只能從卡片打開**：`RightSidebarApi` 只有 `openChanges`、`openDeliverable`、`openPlan`、`autoOpenPlan` 四個方法（`right-sidebar.tsx:87-100`）。空狀態那一句寫著「從對話裡的卡片打開」（`:68`）。
- **懶掛載**：分頁第一次被選中才掛上，之後切走只是藏起來，不卸載（`right-sidebar.tsx:349-351,383-398`）。
- **版面存在哪**：`localStorage`。每條會話一個鍵 `nexus.right-sidebar.v1.<threadId>`，只留最近 50 條；寬度另存一個鍵（`lib/right-sidebar.ts:119-123,192-234`）。**人動過之後才寫**（`right-sidebar.tsx:144-151`）。**一個分頁形狀不對，整份版面都作廢**（`lib/right-sidebar.ts:160-179`）。
- **RWD**：1024 以上停靠，可以拖寬，面板至少 320、會話區至少 480；1024 以下是全寬 `Sheet`，**載入時一律收起**（`right-sidebar.tsx:4-12,137-142,231-267`；規格 §9 `.docs/web-ui-spec.md:265-272`）。
- **內容來源**：`RightSidebarSources = { changes, deliverableFiles, deliverableDownload, plans }`（`right-sidebar.tsx:78-84`），由 `App.tsx:367-370` 用 `useMemo` 組好傳進來。

---

## 2. 資料流

### 2.1 下行與折疊

- **channel 白名單**是 `messages`、`tools`、`lifecycle`、`input`、`custom`（`protocol.ts:65`）。檔頭寫明「這是安全邊界，不是效能調校」（`:50-64`）：`tasks`、`values`、`checkpoints` 都不放行。
- **折疊器在 `@nexus/wire`**，不在 web：`reduceConversation`（`conversation.ts:736-763`）。放在 wire 是為了讓 harness 能拿真的 agent 跑出來的 frame 去驗（`conversation.ts:4-8`）。
- **`custom` frame** 是名字→酬載的表（`custom-frame.ts:1-51`）。每個領域檔用宣告合併加一格，折疊器對 `CustomFrameName` 窮舉（`conversation.ts:804-826`）。表上目前有十五個名字：`deliverables/presented`、`workspace/changes`、`model/usage`、`context/measure`、`todos`、`plan`、`compaction`、`goal`、`tokenUsage`、`sessionStats`、`inbox`、`subagent/settle-notice`、`subagent/agent-message`、`title`、`subagent/status`。
- **web 的 hook**：`hooks/use-conversation.ts:361-451`。順序是先 `openEvents`，再 `threadHistory` 取第一頁，用 `reduceAll(emptyConversation(), frames)` **從空的狀態重新折**，然後 `slashList`，再逐顆 `reduceConversation`。重連時同樣從空的狀態重折（`:388-392`），所以只存本地的東西（例如決定紀錄）在重連後會消失。
- **發布節流**：`lib/frame-publisher.ts:1-30`。逐字片段每跨三次 paint 才交給 React 一次，其餘 frame 當場發布。

### 2.2 歷史與回放

- **第一頁**：`GET /threads/:id/history`（`protocol.ts:728`）。server 端把**日誌事件翻成線上的 `Event`**，與即時走同一個折疊器（`protocol.ts:712-724`；翻譯表在 `apps/harness/src/conversation-history.ts:10-53`，迴圈在 `:801-1003`）。歷史 frame **不帶 `seq`**，**`timestamp` 是日誌的 `time`**（`conversation-history.ts:233-238`）。
- **往前翻**：`loadEarlier` 先 `reduceAll` 那一頁，再用 `prependEntries` 接到最前面（`use-conversation.ts:648-674`）。只接條目，「現在」的欄位（總帳、目標等）不動（`conversation.ts:1212-` 起的說明）。
- **「現在」的值只在最新一頁送**：佇列、標題、計劃模式、目標（`conversation-history.ts:1169-1191`）。總帳則是**每頁都送一顆「從日誌開頭折到這一頁結尾」的值**（`:1164-1168`）。
- **背景子代理**：`GET /threads/:id/subagents/:runId/history` 對**它自己那份日誌**套用同一個 `historyPage`（`wire-handler.ts:1461-1510`、`protocol.ts:732-756`）。只有歷史，沒有即時。
- 測試面：`history-ui.test.tsx:194-529` 涵蓋重播、往前翻、自動載入、失敗、報讀。

### 2.3 時間戳

- **線上有**。歷史那條是 `frame(method, time, data)`，`timestamp: time`（`conversation-history.ts:237`）。即時那條，pump 有時轉發基座的 `raw.params.timestamp`（`thread-pump.ts:2180,2215,2236,2260`），有時自己蓋 `Date.now()`（`thread-pump.ts:1629,2426,2446,2467,2539`）。
- **折疊器丟掉了**。`reduceFrame` 只讀 `event.seq`、`event.params.namespace`、`event.params.data`（`conversation.ts:740-763`）。十種 entry 介面（`conversation.ts:67-358`）沒有任何時間欄位。
- **待驗**：即時與歷史兩邊的時間語意是否一致。例如工具卡，即時的 `tool-started` 取的是基座發出事件的時刻，歷史取的是日誌記下 `tool/call` 的時刻（落在核准閘門之前，`session-log.ts:720-723`）。兩者應該接近，但沒有量過。

### 2.4 右側欄有沒有註冊表：**沒有**（證據）

1. `SidebarTab` 是三支的封閉聯集（`lib/right-sidebar.ts:23-36`）；`parseTab` 認不得的 `kind` 回 `undefined`，整份版面隨之作廢（`:137-179`）。
2. `TabBody` 用 if 鏈分派三種（`right-sidebar.tsx:404-433`）；分頁圖示用三元式寫死（`:559`）；標題由 `useTabTitle` 逐支判斷（`:524-540`）。
3. `RightSidebarApi` 只有四個固定方法，沒有通用的 `openTab(kind, …)` 或 `register(…)`（`right-sidebar.tsx:87-100`）。
4. 檔頭自己寫了「以後多一種內容只是 `SidebarTab` 多一支（#654 的計劃就是這樣加的）」（`lib/right-sidebar.ts:5-6`）。也就是說，**擴充的方式是改原始碼，不是註冊**。
5. 資料面同樣封閉：`custom` frame 只走 pump 從日誌合成的那幾種，「圖自己發的 `custom` frame（`config.writer`）一律不上線」（`protocol.ts:61-63`）。所以 plugin 就算想送東西給 web 也送不到。
6. 否定的搜尋，見 §9 第 1 條。

---

## 3. 「思考過程」的現況

- **來源**：`messages` channel 的 `content-block-delta`，`delta.type === 'reasoning-delta'`，累加進 `AiEntry.reasoning`（`conversation.ts:1298-1311`）。畫面邏輯在 `lib/reasoning-view.ts:10-29`：全是空白就不畫；正文還沒開始時算「還在想」；收合時那一行在串流中顯示最新一行，講完顯示第一行。
- **持久**：是。日誌的 `assistant/message` 存著整則訊息（含推理，`session-log.ts:513-543`）；歷史端用 `reasoningOf(event.data.message)` 投成同一種 delta（`conversation-history.ts:889-913`），所以**重新整理之後還在**（`conversation.ts:130-141` 寫的也是這件事）。
- **例外**：
  - **前景子代理（`task`）的推理，重新整理後就沒了**。歷史只讀 root 那份日誌，子代理的訊息不在裡面（`conversation.ts:24-27`）。
  - **背景子代理**的推理要在委派卡展開後，從它自己那份歷史讀（`subagent-control.tsx:12-14`、`protocol.ts:742-745`）。
  - **格式 9 以前的舊日誌**沒有保存回覆（`ThreadHistoryResult.legacy`，`protocol.ts:857-862`），畫面上會講明（`App.tsx:427-429`）。
- **攤平**：一則回覆裡的多個推理區塊被攤成一串，丟掉了區塊順序（偏離 dsh，2026-09-23 拍板，`conversation.ts:134-138`）。
- **沒有的**：推理的 token 數、首字延遲、推理花了多少時間。`sessionStats` 也明說首字延遲與解碼那一組整個不做（`packages/nexus-core/src/session-stats.ts:26-28`）。

---

## 4. 現成的「決策」呈現

| 決策 | 對話裡長什麼樣 | 資料來自 | 重新整理後 |
| --- | --- | --- | --- |
| 核准（待決） | 換手層的核准面板，只有允許／不允許（`approval-card.tsx:1-23`），名稱如「等待核准：edit_file（1／2）」 | `input.requested` → `PendingApproval`（`conversation.ts:447-462`） | 伺服器在下行接上時補送還掛著的中斷（`use-conversation.ts:391-392`） |
| 核准（已決） | 置中 chip「已核准：X」「已拒絕：X（沒有執行）」（`transcript.tsx:184-191`）。被拒的那一顆另有失敗的工具卡 | **只存本地**：`appendDecision`，下行不回送決定（`conversation.ts:245-268,622-634`）；dsh 的 `approval/asked`／`approval/decided` 已認帳不做（#220） | **消失**。只剩失敗卡，而失敗卡分不出是人拒絕、規則擋下，還是沒有核准管道（`conversation.ts:248-252`） |
| 提問 | 提問面板；答完後在 `ask_user_question` 工具卡上列「問題 → 回答」（`tool-card.tsx:9-13`） | `PendingQuestion`；答案讀 `ToolEntry.text`，退路是本地的 `AnswerEntry` | 在。讀的是工具結果 |
| 計劃審核 | 審核面板＋原位的計劃卡，帶結果 chip（已同意／要求修改／停止），全文開在右側欄（spec §4.3 計劃審核，`.docs/web-ui-spec.md:110-121`） | `intent.kind: plan-review` 的提問中斷；結果讀工具卡的結果 | 在（`.docs/web-ui-spec.md:120`：即時與重播是同一串） |
| 重複呼叫提醒 | **沒有呈現** | 日誌 `user/message` `source.kind:'plugin'`（`session-log.ts:544-559`），由 `repeat-reminder.ts` 的 `beforeModel` 寫入 | 歷史明寫「外掛塞的不畫」（`conversation-history.ts:48,872`）。即時：pump 不轉送（推論，見 §9 第 3 條） |
| goal 阻擋 | `GoalBar` 顯示 `blocked` 與理由（`goal-bar.tsx:10-12`） | `goal` frame（`blockedReason`，`conversation.ts:930-959`） | 只有**目前的值**，不會留下「何時被阻擋」的軌跡 |
| goal 收尾指示 | **沒有呈現** | 日誌 `user/message` plugin（goal 工具），同上 | 不畫 |
| 摘要壓縮 | `CompactionRow`，可展開摘要（`compaction-row.tsx:13-22`） | `compaction` frame（`conversation.ts:899-922`） | 在，逐顆轉送 |
| 模型重試／限流 | **沒有呈現**。`status-line.tsx:28` 的「正在重試…」是**下行重連**，不是模型重試 | 日誌 `llm/retry`／`llm/retry-started`（`session-log.ts:485-512`，寫入者是 `packages/nexus-core/src/llm-retry.ts:109,124`） | 不上線。重試等待的牆鐘時間落在 `model/start`／`model/end` 之間（`session-log.ts:490`），所以只會被吸收進 `sessionStats.llmMs`（推論） |
| 停止、輸出上限、失敗 | 「（已停止）」、輸出上限提示、紅字錯誤（`transcript.tsx:289-295`）；沒有結果的工具卡收成失敗（`conversation.ts:1600-1617`） | 收尾 `lifecycle` 上的 `aborted`／`maxTokens`／`error` | 在（`conversation-history.ts:975-994`） |
| 子代理結算、來信 | 通知列、「某某說」卡 | `inbox` 的 `claimed`；歷史是 `subagent/settle-notice`、`subagent/agent-message` | 在 |

---

## 5. 日誌裡有、線上沒有的東西（觀測與成本的缺口）

依據：`SessionEventType` 共 31 種（`packages/nexus-core/src/session-log.ts:153-184`），對照歷史翻譯表（`conversation-history.ts:10-53,804-1001`）與 `custom` 表（§2.1）。

| 日誌事件 | 有沒有上線 | 對觀測與成本的意義 |
| --- | --- | --- |
| `model/start`／`model/end` | 只折進 `sessionStats`，不逐顆上線 | 時間線上的「模型呼叫」段落、每一步的耗時 |
| `model/usage` | `model/usage` frame **只帶 `inputTokens`**（`context-pressure.ts:39-42`）；總帳另外折 | 每次呼叫的輸出 token、逐輪用量 |
| `llm/retry`、`llm/retry-started` | 不上線 | 重試次數、原因碼（`RATE_LIMIT`／`SERVER`／`TIMEOUT`／`TRANSPORT`，`session-log.ts:211-223`）、實際等待的毫秒數 |
| `user/message`（`plugin`） | 不上線 | 重複呼叫提醒、goal 指示 |
| `user/message`（`session-reference`） | 不畫，只拿來標記引用 | 引用快照 |
| `interrupt/raised` | 歷史只用來判斷懸置（`conversation-history.ts:972-974`） | 什麼時候停下來等人 |
| `command/run`／`command/done` | 不上線（斜線命令的結果走 RPC 回應） | 斜線命令也算一種決策紀錄 |
| `sandbox/mode`、`subagent/model-selection-policy` | 不上線 | 當時生效的政策 |
| `goal/change` | 只送目前的值 | 目標階段的變化軌跡 |
| `compaction/summary` 生摘要那次的用量 | 不在任何一份總帳裡（`packages/nexus-core/src/token-usage.ts:24-27`） | 成本漏算 |
| 失敗或中止的模型呼叫的用量 | 不進帳（`token-usage.ts:15-18`） | 成本少算 |
| 前景子代理那份日誌 | 沒有路由 | 子代理分列的成本、內部工具卡、推理 |

dsh 的對照（**只當資料面與元件多樣性的參考**，SHA `5badb15`）：

- `packages/client/ui-trajectory` 是一個 Trajectory 分頁，註冊進對話視圖環，提供依輪組織的事件記錄表、時間概覽與檢查器。它是**原始 session event 視窗的純投影**（`references/deepseek-harness/packages/client/ui-trajectory/README.zh.md:5-7,50-55`），所以拿得到每一顆日誌事件與它的時刻。我們的 web 沒有原始事件，只有翻譯過的 frame。這是兩邊最根本的差距。
- 逐輪用量：`packages/llm/token-meter/src/turn-usage.ts` 是讀日誌的純折疊，畫面在 `ui-chat/src/client/chat/TurnUsagePanel.tsx`。`session-log.ts:454-455` 也提到「照 dsh 的 `deriveTurnTokenUsage`，輪級的數字是一道讀日誌的純折疊」。
- 這兩項在 inventory 是第 17 列（逐輪用量，沒做）與第 37 列（輪次側軌，wire 沒有輪次索引）（`.docs/agent-ui-element-inventory.md:123,136`）。

---

## 6. 提案 A：「對話與決策觀測」（推論）

### 6.1 放哪裡

- **右側欄的新分頁，單例**。`kind: 'trace'`，`tabKey` 寫成 `trace`，沒有座標。理由有三：右側欄本來就是「從對話打開的旁看面」；1024 以下已經有全螢幕 Sheet 的版型；分頁懶掛載的機制可以直接沿用。
- **要另外設計入口**。今天的分頁只能從卡片打開（§1.5）。入口最小可以有兩個：
  1. 右側欄空狀態的那一句改成兩顆鈕「觀測」「成本」（`RIGHT_SIDEBAR_EMPTY_TEXT`，`right-sidebar.tsx:68` 要改）。
  2. 每輪收尾那則回覆的讚踩列旁，放一顆「這一輪的過程」（`turnTail`）。
- **不要在 375 的標頭再加鈕**：那裡已經有三顆 44px 圓鈕加一顆用量 pill，標題只剩 `flex-1 truncate`（`App.tsx:385-400`）。
- **不是左側欄**：左側欄是跨會話的清單，`AppSidebar` 收起時會卸載（`app-sidebar.tsx:12-13`）。

### 6.2 最小形狀

- **只用現有資料的第 0 版**：
  - 一輪一組，**沒有時間，只有順序**。列依序是：輸入（`HumanEntry`／`NoticeEntry`／`AgentMessageEntry`）、思考（`AiEntry.reasoning` 的摘要行，沿用 `reasoningSummary`）、回覆（`AiEntry.text` 的第一行）、工具（名稱、狀態、`errorCode`，沿用 `tool-view` 的 `toolSummary`）、決策（`DecisionEntry`、提問答案、計劃結果 chip、`CompactionEntry`），收尾是停止／輸出上限／失敗。
  - 點一列：在分頁裡用 `Collapsible` 展開細節，重用 `ReasoningRow`、`ToolCard` 與 `CompactionRow` 的內容元件。另有一顆「在對話裡定位」。
- **第 1 版（等 harness 補時間與事件，見 §8）**：每列帶開始時刻與耗時；插入「模型呼叫 #n」段落（起訖、輸入／輸出 token）、「重試 k/N（原因碼、等了幾 ms）」、「提醒：重複呼叫」「goal 指示」「停下來等人 → 決定」。

### 6.3 會踩到的點

1. **切輪**：entries 沒有輪 id。現有慣例是「由 human 那一格切輪」（`conversation.ts:307-308,348-349`）。但**目標排的輪次沒有人話**（`conversation-history.ts:50-53`），這種輪會黏到前一輪上；`turnTail` 只標在有文字的收尾那則（`conversation.ts:160-169`）。要嘛接受這個限制並寫明，要嘛等 harness 送輪的邊界。
2. **分頁載入**：時間線只看得到已經載入的那幾頁。找不到目標時，沿用 `PLAN_TAB_MISSING_TEXT` 的說法（`right-sidebar.tsx:71-72`）：「往上捲載入更早的對話」。
3. **決定紀錄只存本地**：重新整理後，第 0 版的時間線會少掉「人按了什麼」，只剩失敗卡。這一點必須在畫面上講明，不能假裝完整。
4. **餵資料的方式是效能風險**：把 `ConversationState` 塞進 `RightSidebarSources` 的話，`sources` 是 control context 的依賴（`right-sidebar.tsx:184-198`），每顆 frame 都會讓所有 `TabChip` 跟著重畫。分頁被切走後只是藏起來、沒有卸載（`:383-398`），所以藏著也照樣每顆 frame 重畫。建議改傳一個可訂閱的 store（同 `changes.summary` 用 `useSyncExternalStore` 的做法，`right-sidebar.tsx:526-533`），或者由觀測分頁自己訂閱 `FramePublisher`。
5. **1024 以下**：Sheet 是全寬（`right-sidebar.tsx:233-250`）。按「在對話裡定位」要先收掉 Sheet，再捲到那一則；焦點要交回，交回的寫法照 spec §8「焦點搬動的判斷寫在換手那一層」。
6. **UI 依據**：shadcn 加 Tailwind，模仿 Libraries.dev。dsh `ui-trajectory` 的表格、概覽、檢查器只參考元件多樣性（AGENTS.md「技術實現標準」最後一段；`.docs/web-ui-spec.md:48-53`）。**不要寫「照 dsh 畫時間線」**。

### 6.4 wire 要加什麼（對照現有）

| 要的 | 現有 | 建議（推論，屬 dev-harness） |
| --- | --- | --- |
| entry 的時刻 | 線上的 `params.timestamp` 已經有，折疊器丟掉（§2.3） | 在 `packages/nexus-wire/src/conversation.ts` 讓 `AiEntry`／`ToolEntry`／`HumanEntry`／`CompactionEntry`… 加選填欄位 `startedAt?`、`settledAt?`，由 `reduceMessage`／`reduceTool`／`reduceLifecycle` 從 `event.params.timestamp` 填入。**這是加欄位，拆得開**（AGENTS.md「先確認拆不開」那一節：加欄位的那一刀在舊的樹上照樣是綠的）。web 自己另抄一份折疊來記時間也做得到，但會跟 wire 的折疊器漂移，違反 `conversation.ts:4-8` 的初衷 |
| 模型呼叫的段落 | 沒有 | 新的 `custom` frame（例如 `model/call`：開始時刻、結束時刻、輸入／輸出 token、有沒有失敗），從 `model/start`／`model/end`／`model/usage` 合成；歷史逐顆轉送 |
| 重試 | 沒有 | `custom` frame `llm/retry`（`retry`、`maxRetries`、`failure.code`、`waitedMs`） |
| 外掛注入 | 沒有 | `custom` frame（例如 `context/injected`：`plugin` 名稱＋文字摘要）。**要先查 dsh 的畫面是否顯示注入**（dsh 有 `ContextInjectionRow`，inventory 第 18 列），這決定資料面要不要上線 |
| 決定紀錄持久 | 只存本地 | 補 `approval/asked`／`approval/decided` 日誌事件，再加 frame。**這會推翻 #220 的「認帳不做」，屬政策題，見 §8.1** |
| 輪邊界 | 沒有輪 id | 在收尾 `lifecycle` 帶 `turn/start` 的 `seq`，或另送 `turn` frame |

另一條路（推論）：照 dsh 開一條「原始事件」唯讀路由，給觀測分頁自己投影。好處是最接近 dsh，壞處是碰到 `WIRE_CHANNELS` 的安全邊界（`protocol.ts:50-57`：「要放行…得是一個明白的決定」），而且日誌原文含工具參數、檔案內容。這是政策題（§8.1）。

---

## 7. 提案 B：「任務成本」（推論）

### 7.1 放哪裡

- **右側欄單例分頁** `kind: 'cost'`。入口是頂列 `SessionUsage` popover 底部加一顆「在側欄看明細」。這樣不用在 375 的標頭加鈕。右側欄空狀態那兩顆鈕也是入口（§6.1）。
- 版型沿用 `session-usage.tsx:7-18` 的 `Rows`（`dl` 兩欄、`tabular-nums`）。**第 0 版不畫圖表**：`components/ui` 目前沒有 chart、table、tabs、scroll-area（`ls apps/web/src/components/ui`）。要加 shadcn chart 就得帶進 recharts 這類相依，而全 repo 的相依歸 dev-harness，要先知會對方（記憶「分工」那一條）。

### 7.2 最小形狀

- **第 0 版（只用現有資料，純 web）**：
  - 本會話累計：輸入 token（含快取讀取）、輸出、合計（`tokenUsage`）；輪數、模型呼叫次數、模型耗時、工具耗時（`sessionStats`）。都是 root 日誌的總帳。
  - 目前 context 大小與離自動摘要多遠（`contextPressure`，與 `ContextMeter` 同源）。
  - 壓縮次數：從**已載入**的 `CompactionEntry` 數，要註明「只算已載入的」。
  - **背景子代理分列**：每個 runId 一列，數字取自 `subagentHistory` 那頁的 `tokenUsage`／`sessionStats`。理由是 `historyPage` 對傳入的那份日誌做 `SessionTotals.seed`（`conversation-history.ts:1165-1168`），而子代理那條路由傳的就是它自己的日誌（`wire-handler.ts:1497`）。**推論，待驗**：要用真的背景子代理跑一次，確認那一頁真的帶這兩顆。今天 `subagent-control.tsx` 折出的狀態沒有拿來畫成本（`rg "tokenUsage|sessionStats"` 只有 App 與 session-usage 命中，§9 第 5 條）。
  - **口徑一定要寫在分頁上**：不含子代理（root 那份總帳）、不含生摘要的那次、不含失敗或中止的呼叫（`token-usage.ts:15-27`）。輸入含快取讀取（`session-totals.ts:25-26`）。
- **第 0 版刻意不做的**：
  - 「本輪」：即時的 `model/usage` frame 只有 `inputTokens`，算不出逐輪輸出。從總帳的差值去推，在重新整理後就斷了。
  - 「工具次數」：`sessionStats` 沒有這一格（`session-totals.ts:55-64`）。從畫面上數 `ToolEntry` 會受分頁影響而數錯，`session-totals.ts:6-7` 正是為了這個理由才不從畫面加總。
- **第 1 版（等 harness）**：
  - 逐輪：這一輪的 token（輸入、輸出）、模型呼叫次數、工具次數、耗時、重試次數；一輪一列，點擊跳到觀測分頁的那一輪。
  - 子代理分列：連前景的 `task` 也算。

### 7.3 wire 要加什麼

| 要的 | 現有 | 建議（推論，dev-harness） |
| --- | --- | --- |
| 逐輪用量 | 沒有 | 照 dsh `token-meter/src/turn-usage.ts` 寫一個讀日誌的純折疊，送 `turnUsage` frame（輪的鍵用該輪 `turn/start` 的 `seq`）。即時：值變了才送；歷史：每頁帶那頁裡每一輪的值 |
| 工具次數、重試次數 | 沒有 | 擴充 `WireSessionStats`，或放進逐輪的 frame。dsh 的 `sessionStats` 有沒有工具次數要先查（待驗） |
| 前景子代理的總帳 | 子代理的日誌有寫 `model/usage`（`token-usage.ts:22-24`），但沒有路由 | 把子代理的總帳回報到 root（例如在委派卡的結果 `meta` 裡帶回），或開一條唯讀路由 |
| 每次呼叫的輸出 token | `model/usage` frame 只帶輸入 | 擴充 `ModelUsagePayload`。**注意這張表是封閉的**：加欄位時，`reduceModelUsage` 目前只收 `inputTokens`（`conversation.ts:843-848`），要一起改 |

---

## 8. 分工、先後、寬度、絆索

### 8.1 政策題（交給 demian，我不拍板）

1. **#220 要不要翻案**：要讓決定紀錄持久化（重新整理後還看得到人按了什麼），就得補 `approval/asked`／`approval/decided` 日誌事件。
2. **要不要開「原始日誌事件」唯讀路由**（照 dsh trajectory 的資料面），還是逐種補 `custom` frame。前者碰到 `WIRE_CHANNELS` 的安全邊界（`protocol.ts:50-57`）。
3. **記憶「觀測與評估地圖 #263：照 dsh 補事件、dsh 沒有的只做在產品路徑外」怎麼套用**：dsh **有** trajectory 與逐輪用量，所以這兩項看起來在產品路徑上的範圍內。但「外掛注入要不要上線」得先確認 dsh 的畫面怎麼處理。
4. **外掛注入的文字給不給使用者看**：重複呼叫提醒是英文、寫給模型看的，與 `NoticeEntry`「不帶文字、字由畫面自己配」的前例（`conversation.ts:87`）同一類問題。

### 8.2 分工與順序（推論）

| 順序 | 卡 | 擁有者 | 依賴 |
| --- | --- | --- | --- |
| 1 | 右側欄支援單例分頁（`trace`、`cost`）、空狀態改兩顆入口鈕、`SessionUsage` 加入口、可訂閱的資料來源 | dev-ui（`apps/web`） | 無 |
| 2 | 成本分頁第 0 版（root 總帳、context、背景子代理分列）。先實跑驗證子代理那頁真的帶總帳 | dev-ui | 1 |
| 3 | 觀測分頁第 0 版（只有順序、沒有時間、限制寫明） | dev-ui | 1 |
| 4 | wire entry 加選填的時刻欄位（`packages/nexus-wire`） | dev-harness | 無（加欄位，拆得開） |
| 5 | 逐輪用量折疊與 frame（照 dsh turn-usage）、工具與重試次數 | dev-harness | 無 |
| 6 | 模型呼叫、重試、外掛注入、輪邊界的 frame | dev-harness | 政策題 2、3、4 |
| 7 | 決定紀錄持久化 | dev-harness | 政策題 1 |
| 8 | 觀測第 1 版（時刻、段落）、成本第 1 版（逐輪、前景子代理） | dev-ui | 4、5、6（7 可選） |

- `custom` 表每多一格，`@nexus/wire` 的折疊器就得補上分支，否則當場編不過（`custom-frame.ts:5-7`）。所以 harness 那張卡要自己補 `conversation.ts` 的分支。web 只畫，不碰折疊。
- 4、5、6 都是**加東西**，不是收緊，照 AGENTS.md 的預設**分開發 PR**，不適用「跨套件原子落地」那條例外。
- 若加了新的**日誌事件**（7 會加，6 可能不必），注意記憶「加日誌事件種類的絆索散在各套件」：goal 的 `fold.test` 窮舉 `SessionEventType`，還要升 `SESSION_LOG_FORMAT_VERSION`。

### 8.3 375／768／1280 與 1024 抽屜規則

- **375、768**：都小於 1024，右側欄是全寬 Sheet，載入時收起，不會自動開（`right-sidebar.tsx:4-7,139-142,176-178`）。時間線與成本列要做成單欄，細節**在列下面展開**，不要並排；觸控目標 44px（列的寫法照 `reasoning-row.tsx` 的 `min-h-11`）。數字欄用 `tabular-nums`，`compact` 格式沿用 `lib/context-meter-view.ts`。
- **1280**：停靠。面板最窄 320、會話區至少 480；左側欄展開時面板先縮（`right-sidebar.tsx:259-261`、`lib/right-sidebar.ts:101-114`）。**分頁內的排版看容器寬度，不看視窗寬度**（規格 §9 `.docs/web-ui-spec.md:272`，交付卡就是用 `@container`）。320 寬時一列只放得下時刻、圖示與一行摘要。
- 分頁標題像瀏覽器分頁那樣先縮，最窄 112（`right-sidebar.tsx:488-489,564`），所以「觀測」「成本」的名字要短。
- 動效只用封閉清單裡的模式（spec §7）：列展開走 collapsible 的 250／150；**串流中新增的列不做進場動效**（spec §7「不動的：串流逐字」；載入歷史也不動）。

### 8.4 絆索測試（推論）

**web（dev-ui）**

1. `lib/right-sidebar.test.ts`：
   - `parseLayout` 收得下新的兩種 `kind`。
   - 單例的 `openTab` 重複打開時只是選中，不會多一個分頁。
   - 認不得的 `kind` 仍然讓整份版面作廢。這是既有行為，要釘住，免得新增種類時被順手放寬。
2. `components/right-sidebar.test.tsx`：
   - 新分頁沒被選中前不掛載。
   - `Delete` 能關掉分頁。
   - 空狀態的兩顆鈕能打開對應分頁。
   - axe 不報 `aria-required-children`：新的入口鈕不能放進 `tablist`。
3. **資料口徑**：成本分頁的數字來自 `tokenUsage`／`sessionStats`，不是從 entries 加總。測法是 entries 為空（或只載入一頁）時，數字照樣等於 frame 的值。
4. **效能**：觀測分頁藏起來時，逐字片段不會讓它重新算（例如計 render 次數）。另外驗 `TabChip` 不會因為對話狀態而每顆 frame 都重畫。
5. **重新整理**：決定紀錄在第 0 版的時間線上會消失，畫面要寫明這件事。這一條要釘，免得之後被當成 bug 默默「修掉」。
6. spec §11 第 1 條（同一個 className 同時有 `border` 與 `shadow-` 就報錯）與第 6 條（axe 掃描）要涵蓋新分頁：至少掃「觀測分頁 375 暗」「成本分頁 1280 亮」兩個畫面。
7. jsdom 的已知陷阱（記憶）：
   - Node 25 的 `localStorage` 會讓本機綠、CI 紅，要用 node@20 重現。
   - Radix 的點外面行為要注意。
   - `useIsMobile` 要 stub，兩種寬度各跑一次。
8. **截圖**（記憶「測 web 操作一律附截圖」）：
   - 375／768／1280 各截一組，修正前後各一組。
   - 窗格藏著的話，改用 headless Chrome＋CDP。
   - 開 PR 之前先實跑，不要拿「內文標沒截圖」交代。

**wire 與 harness（dev-harness）**

9. `conversation.test.ts`：歷史與即時兩條路都把時刻填進 entry；同一顆 `tool-started` 第二次到（resume）時的時刻規則要寫明；`prependEntries` 保留時刻。
10. `apps/harness` 的 `conversation-wire.test.ts`：用真的 agent 跑過真的線，再對照 entry 的時刻與日誌的 `time`，**量出兩條路的時間語意差多少**（§2.3 待驗）。
11. 新增的 `custom` frame：歷史與即時長出同一種東西（照既有 `subagent/settle-notice` 的寫法）；初值不送的規則與 `session-totals.ts:18-21` 一致。

---

## 9. 否定宣稱的搜尋紀錄

shell 是 zsh，經過 rtk。關鍵的搜尋都改用 `rtk proxy rg` 拿未過濾的輸出。範圍都排除了 `*.test.*`，除非另有註明。

1. **web 沒有分頁註冊機制**：
   - 指令：`rtk proxy rg -n "register|Registry|plugin" -i --glob '!*.test.*' apps/web/src | rg -v "tokengen|registry 檔|registry 版|shadcn|@shadcn|radix"`。
   - **注意後面接了 `rg -v` 過濾**：濾掉的是 shadcn registry 與 tokengen 那類字眼。剩下的命中只有工具名註解、markdown math 與 registry 改法的說明，沒有任何註冊 API。
   - 另外 `rg "SidebarTab\b|kind: '(changes|deliverable|plan)'"` 只命中 `lib/right-sidebar.ts`、`components/right-sidebar.tsx`、`lib/deliverables-view.ts`。
2. **模型重試在 web 與 wire 沒有呈現**：
   - `rtk proxy rg -n -i "retry|重試|限流|rate.?limit|429|backoff" apps/web/src packages/nexus-wire/src --glob '!*.test.*' -l`：命中的都是下行重連（`reconnect.ts`、`status-line.tsx:28`、`use-conversation.ts`）、交付檔與改動比對的讀取重試，以及 `page-limit`、`max-tokens-view`、`question-view`。
   - 另外對兩處分別讀了命中行：`status-line.tsx:28` 是連線斷了的字；`max-tokens-view` 無關。
   - `rtk proxy rg -n "llm/retry|retry" apps/harness/src/thread-pump.ts`：0 筆。
   - `rtk proxy rg -n "llm/retry" apps packages --glob '!*.test.*'`：只有 core 的寫入者（`llm-retry.ts`）、`session-log.ts`、`session-store.ts`、`token-usage.ts` 的註解，以及 `apps/harness/src/eval/session-scan.ts:120-121`（離線掃描）。
3. **重複呼叫提醒沒有上線**：
   - `rtk proxy rg -n "repeat" packages/nexus-wire/src apps/web/src apps/harness/src/thread-pump.ts`（**含測試檔**）：只命中 `String.prototype.repeat` 的用法。
   - 加上歷史翻譯表明寫「外掛塞的不畫」（`conversation-history.ts:48,872`）。
   - 即時那條「pump 不轉送 plugin `user/message`」**只靠這次 grep 與讀碼推得，待驗**：沒有逐行讀過 pump 的 `user/message` 處理。
4. **entry 沒有時間欄**：
   - `rtk proxy rg -n "timestamp" apps/web/src packages/nexus-wire/src --glob '!*.test.*'`：只命中 `apps/web/src/test/downlink.ts:93`，那是測試替身，但 glob 沒排除到它，因為檔名不含 `.test.`。
   - 另外讀了 `conversation.ts:61-370` 全部的 entry 介面，確認沒有時間欄位。
5. **成本數字的消費者**：`rtk proxy rg -n "tokenUsage|sessionStats" apps/web/src --glob '!*.test.*'`：只命中 `App.tsx:394-395`、`components/session-usage.tsx`、`lib/session-usage-view.ts`。`subagent-control.tsx` 沒有命中。

---

## 10. 待驗清單

1. 即時與歷史的 `timestamp` 語意是否一致，差多少（§2.3）。
2. 背景子代理那頁歷史是否真的帶 `tokenUsage`／`sessionStats`（§7.2）。
3. pump 是否完全不轉送 plugin 來源的 `user/message`（§9 第 3 條）。
4. dsh `sessionStats` 有沒有工具次數；dsh 畫面怎麼處理外掛注入（`ContextInjectionRow`）（§6.4、§7.3）。引用前先對 dsh 的 SHA，這份 clone 停在 `5badb15`。
5. 重試等待時間是否全部落在 `llmMs` 裡（§4，推論）。
