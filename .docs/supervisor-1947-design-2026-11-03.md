# #1947 設計：每條對話一個 Node 行程，由 Rust 監督行程管生死與資源

demian 2026-11-03 在 PM session（#1827 D164）：「1947 直接讓他寫設計並拆卡，給我看過再動手」。本篇是那份設計：照 AGENTS.md〈技術實現標準〉先讀 dsh、列替代做法、比較後再選；子卡在 §九，由 PM 開成 #1947 的子卡；C0 何時開工由 PM 通知。

**#1947「已拍板」沒涵蓋的選擇，demian 2026-11-03 在 PM session 拍板（#1827 D166：「全部照推薦」），結果在 §十。**

**對讀版本**：

| 對象 | 版本 | 怎麼確認 |
| --- | --- | --- |
| nexus | `origin/develop` `cc305eb6` | 2026-11-03 `git fetch` 後 `git log -1 origin/develop` |
| dsh | `master` `ce7073d5` | `references/deepseek-harness` 的 `git rev-parse HEAD` 對 `git ls-remote … HEAD`，一致 |

**依據**：

- #1947 正文的「已拍板」：形狀 B（Q8）、閒置逐出（Q15）、sub-agent 跑在父對話的行程裡（Q22）、橋（Q28）、監督行程用 Rust（R5）、R6 記憶體、R7 邊界延遲與冷啟動、R8 維持形狀 B、R3 先用時限加 renice、跨對話共用的服務留到 #1948、D50 thread 上限在這張重算。
- 第 1 步量測（issuecomment-6591734365）與 D162 上限（issuecomment-6592108353）：對話第 6–15／16–25／26–45 輪每輪窗內 CPU 中位比 ≤ 1.65／1.45／1.25，整段 45 輪連窗外合計 ≤ 1.35，綁 `r7-driver.mts` 的量法。
- D151（#2117 收尾）：開大 thread 時，小 thread 讀歷史最長等約 1.8 秒，剩下的交給本卡。
- 研究文件 [`nexus-cordis-rust-feasibility-2026-10-22.md`](nexus-cordis-rust-feasibility-2026-10-22.md) §三-3、§三-4、§三-6、§八、§十；R6 瘦身子行程量測（#1947 issuecomment-6373481570）；p2t 調校（issuecomment-6370306989）。

## 結論

| 問題 | 建議 |
| --- | --- |
| 行程怎麼分 | 三種行程：**Rust 監督行程**（控制面：生死、資源、容量、稽核）、**一個 Node 前台行程**（HTTP、登入、靜態檔、跨 thread 的功能）、**每條對話一個 Node 對話行程**（今天的 harness，只管一條 thread）。資料不經監督行程（§三） |
| 前台怎麼跟對話行程講話 | **沿用今天的 wire 協定**：對話行程在自己的私有 Unix socket 上跑今天的 `createWireHandler`（只放一條 thread），前台照路徑轉送。不另訂新 RPC（§四） |
| 監督行程怎麼跟兩種 Node 行程講話 | 照 `native/sandbox-spawner` 的格式：stdin／stdout 一筆一框（`u32 LE 長度`＋內容），Rust 與 TS 共用一份協定向量。**不加新 crate**（§五） |
| 失控保護 | heap 上限旗標、監督行程輪詢 RSS、心跳、renice；死因分七類，經前台送到 web，寫進監督行程的稽核紀錄（§六） |
| 容量 | thread 上限改數「同時活著的對話行程」，出廠值照容器記憶體自動算；滿了先逐出最久沒用的閒置行程，沒有可逐出的才回 `thread_at_capacity`（§七） |
| D151 | 開大 thread 只卡住它自己的對話行程，別條不受影響；前台不解析任何會話日誌（§三-3） |
| 怎麼落地 | 加 `--process-model`：Linux 預設仍是 `single`（今天的 serve），驗收全過才改預設；單行程模式至少保留一個版本，當回退與 macOS 開發用（§八） |
| 退步 | 11 項，收在 §七之二 的總表，C7 逐項量 |
| 容量 | 保留記憶體的一半，64 GiB 約 155 條、32 GiB 約 77 條（D166 Q6b，§七-1） |
| 子卡 | 9 張（C0、C1、C2a、C2b、C3–C7），見 §九；D166 拍板的 8 題見 §十 |

## 一、dsh 怎麼做、為什麼

**一句話**：dsh 是「單行程、多對話」，資源失控、行程崩潰明文交給外部 supervisor，而它自己沒有這個 supervisor。所以 nexus 這張是補在 dsh 留下的空缺上（理由 2：需求超出 dsh），不是改寫 dsh 已有的東西。

| 面向 | dsh 的做法（`ce7073d5`） | 為什麼、付什麼代價 |
| --- | --- | --- |
| 對話託管 | 所有對話在同一個 Host 行程，`AgentRegistry` 用一個 `Map<SessionId, AgentEntry>` 管（`packages/core/agent/src/index.ts:252-256`）；Web 按需恢復後**丟掉 dispose handle**（`packages/api/session-controller/src/agent.ts:324-328`），沒有閒置逐出、沒有條數上限（搜 `evict\|idleTimeout\|maxLiveAgents…` 零命中） | 簡單、共用 heap 便宜；代價是活著的對話只增不減，一條對話的失控就是全部的失控 |
| 失控與崩潰 | 未捕獲例外由 `installFailLoud` 寫診斷後 exit 1（`packages/boot/app-boot/README.zh.md:43`），所有對話一起死；Host 沒有 heap 設定（搜 `max-old-space-size\|resourceLimits` 只命中 PTC 子行程與 Desktop 報告 worker）；沒有一輪時限（`AgentCancelCause` 只有 user／parent／hook／disposed，`packages/core/session/src/types.ts:194-198`） | fail-loud 保住狀態一致性；SIGKILL、OOM、native crash 明文「需要外部 supervisor」（`packages/subprocess/subprocess-local/README.zh.md:66`），而「worker supervisor」目前沒有實作（`packages/subprocess/subprocess/README.zh.md:161`） |
| 卡住事件迴圈 | 會擋到別條：dsh 自己記了幾 MB 的工具參數串流會「使行程內所有會話停滯」（`packages/llm/llm-pi-ai/README.zh.md:267`）；只做逐案緩解（打補丁、移到 Worker、列表分片讓出），沒有事件迴圈監控 | 單行程的必然代價；nexus 的 #2117 是同一類問題，逐案修到 1.8 秒就修不下去了（D151） |
| 子行程 | 對話不進子行程，但葉子工作會：bash、PTY、LSP、PTC、ACP 子代理都經 `ctx.subprocess`；拆除照「stdin EOF → grace → SIGTERM → SIGKILL → 整個範圍已空」（`packages/subagent/subagent-acp/src/run.ts:183-212`）；死因只回 `{exitCode, signal}`，分類交給呼叫方（`docs/subsystems/subprocess.zh.md:235-240`） | 拆除梯度與「分類歸呼叫方」都值得照抄 |
| 監管一個 Node 行程 | Desktop 用 Node IPC 起唯一的 Host，停機梯度 10 s 優雅 → SIGTERM 5 s → SIGKILL 5 s（`apps/desktop/src/host-process.ts:353-359`），崩潰後不自動重起、讓使用者選 | 單機桌面版的選擇；伺服器上沒有人在旁邊按按鈕 |
| 單寫者鎖 | 每個 session 一把 `session.lock` 的非阻塞 `flock(2)`，排除其他實例與行程（`packages/session/session-persistence-jsonl/README.zh.md:168`） | 跨行程本來就成立；nexus 的會話寫租約是同一個做法（`apps/harness/src/session-lease.ts`） |
| 邊界協定 | 沒有統一 IPC：server↔client 是 Typert（TS 型別生 schema，一元走 HTTP POST，串流走 WebSocket mux，取消是 `signal: AbortSignal` 末位參數，`packages/api/gateway/README.zh.md:39-41`）；SDK 是換行分幀的 JSON-RPC 2.0；PTC 是 birpc over NDJSON | 每條邊界各用最順手的；nexus 的 wire 協定（`packages/nexus-wire`）就是 server↔client 那一條的對應物 |
| 全行程共用 | 根 context 的服務全行程共用：agents、sessions、MCP 連線（按註冊作用域）、LSP 池、HTTP 連線池；**沒有 LLM 全域並行上限**（`packages/llm/*/src` 搜 `semaphore\|maxConcurrent\|rateLimit` 零命中） | nexus 已經比 dsh 多了全機並行上限（#1618）與 MCP 連線池（#1677），這兩樣在形狀 B 怎麼辦由 #1947 已拍板：留到 #1948 |

## 二、nexus 今天的形狀（拆行程時會斷的地方）

今天一個 serve 行程裡，除了 agent、pump、落盤協調器是每條 thread 一份，其他都是整個行程一份（`apps/harness/src/serve.ts` `startServer`）。拆成每條對話一個行程時，下面這些耦合會斷，每一項都要在 §三、§四 有歸宿：

| 耦合 | 今天在哪 | 形狀 B 的歸宿 |
| --- | --- | --- |
| HTTP、登入、靜態檔、WebSocket 多工 | `serve.ts:1692` `startWireServer`、`serve.ts:997` `BrowserAuth`、`serve.ts:1695` 靜態檔、`/threads/mux`（`apps/harness/src/wire-mux.ts:262` 把每個 open 轉進同一支 `handler.handle`） | 前台 |
| thread 表與上限 | `wire-handler.ts:1548-1584` 幾張 Map；上限只在 `wire-handler.ts:1719` 檢查一次，出廠 500（`settings/thread-capacity.ts:76`） | 監督行程數「活著的對話行程」（§七） |
| 閒置逐出 | `wire-handler.ts:1604-1621` `isIdle`、`:1671` `sweepIdle`，出廠 2 小時（`settings/thread-capacity.ts:79`） | 對話行程自己判斷閒置、回報；監督行程決定收不收（§七） |
| 列表疊上活 thread 的狀態 | `handleList` 讀 `ready.get(...).pump.agentRunning`（`wire-handler.ts:3404`） | 前台從全域下行彙整（§三-2） |
| 搜尋、`@` 引用候選讀別條活 thread 的記憶體 | `serve.ts:1119` → `wire-handler.ts:4103`；`serve.ts:1136` → `wire-handler.ts:4109` | 前台改讀磁碟，宣告落後於落盤（§四-3） |
| 釘選與封存 | 全域集合（`thread-organization.ts:154`），封存閘門 pump 每一步都讀（`wire-handler.ts:1841`、`:1896`） | 前台持有檔案；封存時通知該條對話行程（§四-3） |
| 分叉 | `thread.fork` 讀來源 thread 的記憶體（`wire-handler.ts:3308`） | 轉給來源的對話行程做，新 thread 再起新行程（§四-3） |
| 全域下行 | `GET /threads/feed`，`ThreadFeed`（`thread-feed.ts:42`） | 前台訂閱每個活著的對話行程的 feed、合併（§三-2） |
| 整個行程的單例 | MCP 連線池（`serve.ts:635`）、模型並行閘（`serve.ts:820`）、token 錨點、圖片轉碼限流器（`attachment-store.ts:267`）、會話日誌額度（`serve.ts:842`）、spawner（`tool-launcher.ts:56-61`）、home 鎖（`serve.ts:562`） | 見 §三-4 |
| plugin 對照快照、掉列紀錄器、不變量記錄檔、探針與指標、memory-gauge | `plugin-snapshot.ts:404`、`plugin-failure-recorder.ts:138`、`invariant-log.ts:61`、`ops-endpoints.ts:260`、`memory-gauge.ts:400` | 前台持有檔案與端點，對話行程把紀錄送給前台寫（§四-3） |
| 子代理 | 同行程、同事件迴圈（背景子代理 `background-subagents.ts:550`，對 `child_process\|worker_threads` 零命中） | 照 Q22 留在父對話的行程裡，不動 |

## 三、行程怎麼分

### 3-1 選項

| | A 前台＋監督行程只管控制面（**採用**，D166 Q1） | B 監督行程直接接 HTTP | C dsh 的單行程（今天） |
| --- | --- | --- | --- |
| 形狀 | Rust 監督行程 → 一個 Node 前台＋N 個 Node 對話行程；瀏覽器 → 前台 → 對話行程（Unix socket） | Rust 監督行程接 HTTP／WebSocket、做登入、轉送到對話行程；跨 thread 功能另起一個 Node 索引行程 | 一個 serve |
| 正確性 | 登入、wire 路由、靜態檔、搜尋全是今天的 TS，不重寫 | 登入（`BrowserAuth`、`request-trust`）、wire 路由、mux 要在 Rust 再寫一份，兩份語意要對齊 | 今天的行為 |
| 失敗與恢復 | 前台死了，監督行程重起它；對話行程照跑，web 重連即可。對話行程死了只影響那一條 | 監督行程本身多了 HTTP 解析，攻擊面與崩潰面都變大；它一死全部死 | 一條對話失控，全部死（S3b、S3c 實測） |
| 效能 | 瀏覽器到對話行程多一跳 Unix socket；監督行程不在資料路徑上，p2t 量到的 stats 往返 p99 52–65 ms 不會落到每輪 | 同樣多一跳，但那一跳在 Rust；可以少一個 Node 行程（前台的記憶體） | 沒有多的跳 |
| 維護 | Rust 只寫控制面，跟 spawner 同一套建置、musl、CI | Rust 要追 wire 協定的每次改動；同一個協定兩種語言兩份實作 | — |
| 產品需求（內網、多人共用、稽核） | 監督行程是唯一能殺行程的地方，稽核紀錄寫在這裡 | 同左 | 沒有整體保險絲 |
| 基座做不做得到 | 前台、對話行程都是今天的 harness；Node 22.15 起有 `process.execve`（本 repo `engines` 是 `^22.19.0`） | Rust 端要 HTTP 與 WebSocket 的 crate，是新下載 | — |

**選 A**：B 唯一的好處是省一個前台行程的記憶體，但要在 Rust 重寫一份登入與 wire 路由，而且把 HTTP 解析放進唯一能殺行程的那個行程裡。A 讓監督行程保持小（控制面），也讓 #1948 搬主機級的樹時，不必先處理 HTTP。

研究 §八 的圖只有「監督行程＋對話行程」兩層，沒有前台。前台是本篇加的：#1947「要做的事」第 6 條已經要求把綁 port、網頁、BrowserAuth、搜尋、引用候選、釘選封存等「逐項定歸監督行程還是共用的索引行程」，本篇的答案是全部歸一個前台行程（§十 Q1）。

### 3-2 行程樹與啟動

```
nexus-agent serve（Node 啟動器，檢查完平台與設定就 process.execve）
└─ nexus-supervisor（Rust，控制面）
   ├─ 前台（Node）：HTTP／WebSocket、BrowserAuth、靜態檔、列表、搜尋、引用候選、釘選封存、
   │              探針與指標、plugin 快照、掉列與不變量紀錄、全域下行彙整、home 鎖
   ├─ 對話行程 thread-a（Node）：今天的 harness，只放一條 thread；子代理在裡面
   │   └─ nexus-sandbox-spawner（每個對話行程一支，工具子行程從這裡起）
   ├─ 對話行程 thread-b …
   └─ 預熱池（0–k 個已建好根、還沒綁 thread 的對話行程）
```

- **啟動器用 `process.execve` 換成監督行程**：不多留一個 Node 行程當父親（今天 serve 的入口是 Node，bin 也是 Node）。監督行程是所有 Node 行程的父親，所以前台死了，對話行程不跟著死。
- **前台與對話行程的資料路徑不經監督行程**：監督行程起對話行程時，給它一個私有目錄裡的 Unix socket 路徑（目錄 0700，跟 spawner 的 `--listen socket` 同一個做法，`apps/harness/src/sandbox-spawner-client.ts:114`），再把路徑告訴前台，前台直接連。主機多人共用時，邊界是目錄權限。
- **全域下行**：前台對每個活著的對話行程開一條它自己的 `/threads/feed`，合併後轉給瀏覽器；列表上的「執行中／等待核准」從這裡來，不再讀別人的記憶體。
  - 這條長連不能讓對話行程永遠不閒置。今天 `isIdle` 只數帶 threadId 的請求（`holdThread`，`wire-handler.ts:3952-3962`），`/threads/feed` 的路徑沒有 threadId，所以不算；C1 用一條驗收釘住。

### 3-3 D151：為什麼這樣就解了

#2117 剩下的 1.8 秒卡在同一條事件迴圈上的三段同步工作：解析日誌、還原、投影折疊（`thread-pump.ts:1551-1561`）。dsh 的規定是投影必須同步，#2117 也實測了切片讓出會打亂 GC（D151 不做）。形狀 B 不改這三段，而是讓它們只卡住大 thread 自己的對話行程：

- 小 thread 的讀歷史，路徑是「前台 → 小 thread 的對話行程」，兩個都不碰大日誌。
- **前台不解析任何一條 thread 的會話日誌**。冷 thread 的歷史、軌跡也交給那條 thread 的對話行程讀（起一個行程，§七-3 給它較短的閒置時間），不在前台冷讀。否則同一個阻塞只是從 serve 搬到前台。
- 大 thread 自己冷開仍然要約 5 秒（#2117 量的 4.8–5.6 s），外加對話行程的 ready（R6 量到 0.65–1.7 s）。這段在 PR 宣告，不是本卡要提升的。

驗收：用 #2117 的量具重量「冷開大 thread 期間，小 thread 讀歷史最長等」，目標回到 #2117 原本 PM 定的 ≤ 1 秒（§九 C7）。

### 3-4 跨對話共用的服務：第 2 段怎麼過渡

#1947 已拍板：MCP 連線池與全機並行上限留到 #1948 才搬，這段的退步要宣告。本篇把其他單例也一起列出來：

| 單例 | 第 2 段 | 要宣告的 |
| --- | --- | --- |
| MCP 連線池（#1677） | 每個對話行程一份 | 每條對話多 2 顆 MCP 約 +43.5 MB（#1490，引用）；stdio MCP 子行程數 ×N |
| 模型並行上限（#1618） | 每個對話行程只數自己 | 全機上限失效；每條 thread 本來就一次只跑一輪，實際並行 ≈ 同時在跑的對話數 + 子代理數 |
| 圖片轉碼限流（預設 2） | 每個對話行程一份 | 全機併發上限從 2 變 2N |
| 會話日誌額度（#2115） | 每個對話行程照自己的 heap 自動算 | 額度變成每條各自一份；前台不開會話日誌，不需要額度 |
| token 錨點 | 每個對話行程一份 | 只影響估算的暖機，沒有對外行為 |
| sandbox spawner | 每個對話行程一支 | 每條多一個小 Rust 行程，RSS 沒量（§九 C1 量） |
| home 鎖 | 前台拿；對話行程不拿，各自拿自己的會話寫租約（今天就有，`session-lease.ts`） | macOS 沒有鎖（#2253 起就是），單行程模式不變 |

## 四、前台與對話行程之間（資料面）

### 4-1 選項

| | A 沿用 wire 協定，Unix socket 上的 HTTP（**採用**，D166 Q2） | B 新的 JSON-RPC 2.0（NDJSON） | C Node IPC（`process.send`） |
| --- | --- | --- | --- |
| dsh 有沒有 | server↔client 的 Typert 就是這一型：HTTP 一元＋WebSocket 串流＋取消幀 | SDK 協定與 PTC 的 birpc 是這一型；SDK 沒有取消，放棄一輪只能殺行程（`packages/sdk/protocol/README.zh.md:141`） | Desktop↔Host 用這個（`apps/desktop/src/host-process.ts:229-259`） |
| Q28「請求→回應、取消、串流；schema 描述的資料＋RPC」 | 全部已有：RPC 是 `/threads/:id/commands/:method`（`packages/nexus-wire/src/protocol.ts:634`），串流是 `stream`，取消是 `run.cancel` 加上中止請求；schema 在 `packages/nexus-wire` | 要重新定一份，再把 30 多個 RPC 與十幾條 HTTP 路由逐一對上 | 要重新定；Rust 監督行程不在這條路上，所以沒差 |
| 正確性 | 對話行程跑的就是今天的 `createWireHandler`，前台只轉送；e2e（#1602）可以直接對單一對話行程跑 | 兩套協定並存，wire 每改一次要改兩處 | 同 B |
| 效能 | 每跳多一次 HTTP 解析；R7 宣告的每跳 p99 ≤ 1.5 ms 是 echo 子行程量的，要在真轉送上重量（C0） | 框比 HTTP 輕 | 有序列化成本；R6 的瘦身子行程就是用它，比值落在 D162 上限裡 |
| 維護 | 最低：不加協定 | 最高 | 中 |

**選 A**。第 1 步量 CPU 的 L 臂走的是 Node IPC、把 SSE 位元組原樣切塊轉回（R6 第 1 段），跟 A 的「HTTP over Unix socket」不同；所以 D162 的上限要在 A 上用同一支 `r7-driver.mts` 重量，這是 C7 的驗收，量具的改動要在 PR 寫明。

### 4-2 前台怎麼轉

- `/threads/:id/...` 一律轉給那條 thread 的對話行程；不在記憶體就先請監督行程起（§七）。
- `/threads/mux`：今天 `WireMux` 把每個 open 轉成 `handler.handle(Request)`（`wire-mux.ts:262`），前台把那支 handler 換成「轉送給對應對話行程」的 handler，mux 本身不改。
- **登入只在前台**。對話行程只聽自己的私有 socket，不帶 `BrowserAuth`；前台轉送時不轉瀏覽器的 cookie。企業身分（#1428）要在 11/21 之後才動，到時候身分由前台加到轉送的請求上。
- 取消：瀏覽器中止請求，前台就中止轉送的請求；`run.cancel` 照樣是一個 RPC。

### 4-3 跨 thread 的功能在前台怎麼做

| 功能 | 做法 | 跟今天的差別（要宣告） |
| --- | --- | --- |
| 列表 | 冷讀目錄（今天就是），執行中狀態從合併的 feed 來 | 無 |
| 搜尋、`@` 引用候選 | 只讀磁碟，不讀活 thread 的記憶體 | 還沒落盤的事件搜不到；落後多久看落盤節奏，C3 量出來宣告 |
| 釘選與封存 | 前台持有檔案；封存時呼叫該條對話行程的內部指令把閘門關上，對話行程不在就只寫檔（下次開時讀檔） | 無 |
| 分叉 | `thread.fork` 轉給來源 thread 的對話行程，它寫好新 thread 的檔；前台再為新 thread 起行程 | 無 |
| 子代理會話的歷史、`isSubagentSession` | 前台冷讀 header（今天就是冷讀） | 無 |
| plugin 對照快照 | 前台啟動時寫；每個對話行程綁定時把 live-versions 回報前台，前台更新 | 寫檔的行程換了，格式不變 |
| 掉列紀錄器、不變量記錄檔 | 對話行程把紀錄送給前台，由前台寫同一個檔 | 路徑與格式不變；前台不在時暫存，C3 定上限 |
| 探針與指標 | 前台提供 `/livez`、`/readyz`、`/metrics`；thread 數、各行程 RSS 由監督行程提供 | `/metrics` 多幾個指標，不少 |
| memory-gauge | 每個行程各自量自己；監督行程另外看全部的 RSS 合計 | 行為變成每個行程各一份 |

## 五、監督行程與 Node 行程之間（控制面）

### 5-1 選項

| | A 照 spawner 的框格式，std＋libc，不加 crate（**採用**） | B 照 p2t：tokio current_thread＋serde_json |
| --- | --- | --- |
| dsh 有沒有 | 沒有監督行程，無從比照（研究 §六 #4a） | 同左 |
| 正確性 | 框格式、協定向量、Rust 與 TS 兩邊對同一份 `protocol-vectors.json` 測，spawner 已經這樣做（`native/sandbox-spawner/src/protocol.rs:1-8`） | JSON 比較好讀；欄位錯了要靠 schema 驗 |
| 效能 | 控制面一輪只有幾筆（開始、結束、閒置），量不到差別 | p2t 調校後量過：CPU／千輪 9 ms，不輸 c0p（R5 的條件） |
| 維護 | 跟 spawner 同一套 toolchain、musl、CI、授權清單（`native/sandbox-spawner/licenses/`） | 多一棵 tokio 相依樹，要新下載、要審授權 |
| 新下載 | 無（spawner 的 `Cargo.lock` 只有 landlock、libc） | 要問 demian |

**選 A**。R5 的 CPU 條件是用 p2t 的資料面負載量的（所有回應都經監督行程轉送）；A 讓資料不經監督行程，CPU 條件只會更寬鬆。R5 的兩條驗收（T6 在真 harness 子行程上重驗、30 分鐘長跑比洩漏斜率）照做，在 C7。

**監督行程不能併進 spawner**：spawner 啟動時裝一次 seccomp，之後 fork 的子行程都繼承，擋 `AF_INET`、`AF_INET6`、`AF_UNIX`（`native/sandbox-spawner/README.md` 第 5 行）。監督行程要是 spawner，它起的前台與對話行程都會繼承這份過濾器：前台綁不了 HTTP port，對話行程開不了 Unix socket，也連不到模型端點。兩支各自的執行檔，共用框格式的程式碼。

### 5-2 訊息

位元格式在 `native/sandbox-spawner/src/supervisor_protocol.rs`（C2a，#2339），向量檔 `native/sandbox-spawner/supervisor-vectors.json`，TS 那一側是 `apps/harness/src/supervisor-protocol.ts`。

| 方向 | 訊息 | 用途 |
| --- | --- | --- |
| 監督 → 對話 | `bind(threadId)` | 綁定一條 thread：預熱池裡的行程，與一開始就為某條 thread 起的行程都走這一則 |
| 對話 → 監督 | `ready`、`bound(threadId)`、`turn(begin\|end)`、`idle(idleMs)`、`busy`、`heartbeat` | 生命週期；`idle` 用今天的 `isIdle` 判斷，帶送出時已經閒置的毫秒數，不帶絕對時間（兩個行程的時鐘不同源） |
| 監督 → 對話 | `drain`（準備收）、stdin EOF（收） | 逐出與停機 |
| 對話 → 監督 | `drained`、`busy` | `drain` 的回答：確認仍閒置、不再接新的請求才回 `drained`，否則回 `busy`（§7-2） |
| 前台 → 監督 | `ensure(threadId, run\|read-only)`、`release(threadId)` | 要一條 thread 的對話行程（打開方式見 §7-3）、讀完歷史後可以先收 |
| 監督 → 前台 | `up(threadId, socket)`、`down(threadId, cause)` | 前台轉送與死因回報（七類，§6-2） |
| 監督 → 前台 | `capacity(threadId, current, limit)` | `ensure` 滿了、沒有可逐出的：前台回 `thread_at_capacity`（§7-1）；`current` 含預熱池與起動中的行程 |
| 監督 → 前台 | `stats(live, warm, rssKib, deaths)` | 給 `/metrics`（§4-3、C6） |

## 六、失控保護與死因

### 6-1 保護

| 失控 | 誰擋 | 怎麼擋 | 研究量到的 |
| --- | --- | --- | --- |
| heap 慢慢長（S3） | V8 | 對話行程帶 `--max-old-space-size`，出廠值在 C4 定 | c0p／p2 58 ms 判死 |
| 一次大配置（S3b） | 監督行程 | 輪詢 `/proc/<pid>/status` 的 RSS，超過上限就 SIGKILL | c0p 839 ms、p2 1,434 ms |
| heap 外（S3c） | 監督行程 | 同上；被 cgroup OOM killer 殺的，從結束訊號與 `memory.events` 分辨 | c0p 103 ms、p2 129 ms |
| 一輪跑太久 | 對話行程自己 | 今天的一輪時鐘（30 分鐘，`settings/turn-timeout.ts:49`），照停止鍵的路中止 | — |
| 事件迴圈卡死（S4） | 監督行程 | 對話行程收到 `bind` 起就定時送 `heartbeat`，一直送到收掉，不分在不在一輪裡（D238）。監督行程只看心跳斷了多久：超過 `--stall-ms`（N）就照拆除梯度殺，死因 `stalled`。卡死時對話行程自己的計時器不會觸發（研究 §三-4 c0s「時限計時器也不觸發」），所以這道一定在外面。`turn(begin\|end)` 不參與判斷，只給 §7-3 用；一輪跑太久交給上一列的一輪時鐘。`ready` 之前不判。**N 要高於已知的合法同步阻塞**：冷開大 thread 時解析、還原、投影折疊三段同步連著跑，#2117 量到 4.8–5.6 s（D151 不切片），所以 N 出廠不能低於這個量級；出廠值與量到的最大沉默寫在 C2b 的 PR | 失控的都在 N 內被殺，其他對話零錯誤 |
| 吃滿 CPU | 監督行程 | 輪詢 RSS 時一併取樣 `/proc/<pid>/stat` 的 utime＋stime，連續吃滿一顆超過 `--cpu-busy-ms` 就把整個行程群組 renice 到 19，只做一次、不調回（R3：先不上 cgroup） | 其他對話 p95 +11–20% |

**拆除梯度照 dsh**（`packages/subagent/subagent-acp/src/run.ts:183-212`）：`drain` → stdin EOF → 寬限 → SIGTERM → 寬限 → SIGKILL → 確認行程群組已空。被殺的對話行程留下的「輪還開著」的日誌，下次開時走今天的續接收尾（`resumeClosingInterruptedTurn`，`serve.ts:479`），不另寫一套。

### 6-2 死因

dsh 只回 `{exitCode, signal}`，分類交給呼叫方。nexus 的呼叫方是監督行程，分成七類：

| 類 | 判斷 |
| --- | --- |
| `heap` | V8 的 heap 上限：SIGABRT，stderr 有 `Reached heap limit` |
| `memory` | 監督行程因 RSS 超過上限殺的 |
| `host-oom` | 不是監督行程殺的 SIGKILL，且 cgroup 的 `oom_kill` 計數增加 |
| `stalled` | 監督行程因心跳斷了超過 N 殺的 |
| `crash` | 其他非零結束或訊號，含沒起成 |
| `evicted` | 閒置逐出（正常收尾） |
| `shutdown` | 整台停機 |

- **送到 web**：監督行程 → 前台 `down(threadId, cause)` → 前台對那條 thread 的訂閱者送一個 wire 事件，web 顯示「這條對話被中止：記憶體超過上限」之類（C6）。
- **稽核**：監督行程寫一份 append-only 的 JSONL（時間、threadId、pid、死因、RSS、輪數），路徑與輪替寫進 `docs/operations.md`。
- **要不要寫進那條 thread 的會話日誌**：寫的話，下次打開還看得到為什麼斷；但要升會話日誌的格式（one-way）。第一版不寫（D166 Q3）。

## 七、容量、逐出、預熱

### 7-1 thread 上限的新語意（D50）

- 今天的 500 數的是「行程裡的 thread 數」，死點是 heap（`docs/operations.md`〈500 怎麼來的〉）。形狀 B 下每條對話峰值約 +209 MB（R6），先撞的是容器記憶體。
- **改成數「同時活著的對話行程」（含預熱池）**，出廠值自動算：⌊（記憶體上限 − 保留 − 監督行程 − 前台）÷ 209 MB⌋。記憶體上限讀 cgroup 的 `memory.max`；沒有上限（裸機、`max`）時讀 `/proc/meminfo` 的 `MemTotal`。
- **保留量是記憶體的一半**（D166 Q6b 選 (b)）：沿用 `docs/operations.md`〈500 怎麼來的〉的假設，留一半給主機上的其他人；部署形態是多人共用主機（#1678）。

  | 主機 | 不掛 MCP（每條 209 MB） | 掛 2 顆 MCP（每條 252.5 MB） |
  | --- | --- | --- |
  | 64 GiB | 約 155 條 | 約 129 條 |
  | 32 GiB | 約 77 條 | 約 64 條 |
  | 8 GiB | 約 18 條 | 約 15 條 |

  - 都是推論：監督行程取 p2t 的 19 MB，前台先用 150 MB 估（沒量，C0 量）。
  - 比較過的另一案是固定保留 4 GiB（R6 容量表的算法，64 GiB 約 293 條），它假設整台機器只給 nexus，沒有採用。#1947 正文的容量已由 PM 改成約 155 條。
  - 管理者可以寫死一個數字覆寫，跟今天的設定列同一格（`settings/thread-capacity.ts`），語意改了要寫升級指南。
- **滿了怎麼辦**：先逐出最久沒用的閒置對話行程，沒有可逐出的才拒收，回今天的 `thread_at_capacity`（`wire-handler.ts:2056-2057`）。今天是直接拒收，這是行為改變，要宣告。

### 7-2 閒置逐出（#1484）

- 閒置的定義不變：今天的 `isIdle`（輪沒在跑、沒有掛著的中斷、沒有訂閱者、背景子代理靜止、目標沒在跑…），在對話行程裡判斷，變成閒置時回報 `idle(idleMs)`（§5-2）。
- 監督行程照設定的閒置時間（出廠 2 小時，沿用）送 `drain`；對話行程確認仍閒置才收，避免「回報閒置」與「新請求進來」打架。
- 逐出等於結束行程，記憶體整份還給系統。今天逐出 thread 後 heap 不一定還得回來（R6 量到 10 輪那一點 60 秒內不回收），這是形狀 B 多出來的好處。

### 7-3 只讀的開啟

讀冷 thread 的歷史（側欄一路點舊對話）也會起對話行程（§三-3）。今天文件也寫了「讀歷史也佔名額」。為了不讓一個人點一排舊對話就把名額佔滿：

- 這種行程標成「只讀開啟」，閒置時間用短的（出廠 5 分鐘，可設定），而且滿了的時候最先被逐出。
- 在這個行程上一旦有 `run.start` 等會跑 agent 的指令，就轉成一般行程：監督行程收到它的 `turn(begin)` 就照一般行程算。

### 7-4 預熱池

- 池裡是「建好根、載完插件、還沒綁 thread」的對話行程（R6 的 L2，每個約 138 MB）。新對話或逐出後回來的第一句話，省掉 ready 的 0.65–1.7 s（R6）。
- 出廠 k=1（D166 Q4），可設定成 0；池裡的行程算進容量。理由與代價見 §十 Q4。

## 七之二、本段宣告的退步（總表）

Q32：沒宣告的退步擋合併。前面各節散見的，收在這裡；C7 照表逐項量，數字填進改預設那張 PR。

| # | 退步 | 出處 | 宣告的數字從哪來 |
| --- | --- | --- | --- |
| 1 | 每條對話的記憶體 +147–156 MB、峰值 +209 MB | R6（已拍板） | C7 在真對話行程上重量 |
| 2 | 前台、監督行程、每條對話一支 spawner 的記憶體 | §三-2、§三-4 | C0（前台）、C7 |
| 3 | 每輪 CPU：對話行程照 D162；前台轉送與監督行程那一份另外宣告、不設上限 | D162、D166 Q5 | C0、C7 |
| 4 | 每跳延遲 p99 ≤ 1.5 ms、新對話與逐出後第一輪 wall 多 ≤ 400 ms、ready ≤ 3 s、啟動 CPU ≤ 4 s | R7（已拍板） | C7，預熱池開與不開各一次 |
| 5 | **冷 thread 讀歷史多一次 ready**：今天是同行程組裝，形狀 B 要起一個對話行程（0.65–1.7 s，R6） | §七-3 | C7 |
| 6 | 大 thread 冷開多一次 ready（本身的 4.8–5.6 s 不變） | §三-3 | C7 |
| 7 | MCP 連線池每條對話一份（每條 +43.5 MB／2 顆，stdio 子行程 ×N）；全機並行上限只數自己 | #1947 已拍板（留到 #1948） | C7 |
| 8 | 圖片轉碼全機併發 2 → 2N | §三-4 | 寫明即可，不量 |
| 9 | 搜尋、`@` 引用候選看不到還沒落盤的事件 | §四-3 | C3 量落後時間 |
| 10 | 容量滿時，從「直接拒收」改成「先逐出閒置的、再拒收」 | §七-1 | 行為改變，寫進升級指南 |
| 11 | thread 上限的語意與出廠值（500 → 自動算，64 GiB 約 155 條） | §七-1、D166 Q6a、Q6b | C4，寫進升級指南 |

## 八、落地與回退

- **`--process-model=single|per-thread`**（設定列與旗標都有）。`single` 就是今天的 serve，一行不改；`per-thread` 是本篇的形狀。
- **預設**：C1–C6 合進去之後仍是 `single`；C7 的驗收全過，另開一張只改預設的 PR（Linux 改 `per-thread`）。macOS 一律 `single`（沒有 `/proc`、沒有 flock 鎖，#2253 起就是）。
- **單行程模式至少保留一個版本**，當回退路徑；收掉它是 #1949 的事。
- 這樣每張子卡都是 two-way door：合進去不改任何人的預設行為。真正的 one-way 只有「改預設」那一張（死因不寫進會話日誌，D166 Q3）。
- 改預設那張 PR 要帶升級指南（`docs/upgrade-guide/v<最近的 Release tag>/…`）：thread 上限語意、記憶體宣告、`/metrics` 的變化、MCP 與並行上限的過渡退步。

## 九、子卡（PM 開成 #1947 的子卡）

**共同規則**：每張都掛 #1947 當 parent；PR 標題照 AGENTS.md；除了 C0、C7，都不改預設行為（`--process-model` 預設 `single`）。依賴：

```
C0 ─┐
C2a ┼─> C1 ─┐
    └─> C2b ┼─> C3 ─> C4 ─> C5、C6 ─> C7 ─> （改預設的 PR）
```

### C0 先量：轉送一跳與前台的成本（dev-rs）

- **做什麼**：在量測映像裡，用今天的 serve 當「對話行程」、寫一支最小的轉送前台（HTTP over Unix socket），量每跳延遲、每輪多出的 CPU（前台那一份）、前台的記憶體。不改產品碼，量具放證據目錄。
- **驗收**：數字寫回 #1947；若每跳 p99 > 1.5 ms（R7）或前台每輪 CPU 大到讓 Q5 站不住，帶數字回 PM，**§四 的選擇（Q2）要重議**。
- **為什麼先做**：A 選項（§四）唯一沒量過的是 HTTP 轉送的成本。這張不依賴任何子卡。

### C1 對話行程入口（dev-h2）

- **做什麼**：harness 加一個入口，一個行程只放一條 thread：建根、載插件、可以先停在預熱狀態等 `bind`；在私有 Unix socket 上跑今天的 `createWireHandler`（不帶 `BrowserAuth`、不綁 port、不起探針與搜尋）；接控制面（§五-2）；收到 stdin EOF 照今天的收尾路徑結束。
- **驗收**：
  - 用 C2a 的協定向量，TS 端的編解碼全過。
  - 今天的 wire e2e（#1602）改成對單一對話行程跑，全綠。
  - `isIdle` 的每一個條件各有一條測試，回報 `idle` 的時機對得上。
  - 前台一直掛著 `/threads/feed` 時，對話行程照樣回報閒置、照樣被逐出。
  - `--process-model=single` 的測試一條都不動、全綠。

### C2a 控制面協定與向量（dev-h3）

- **做什麼**：§五-2 的位元格式，照 spawner 的 `protocol.rs` 與 `protocol-vectors.json`；Rust 與 TS 各一份編解碼、共用向量。只有協定，沒有行為。
- **驗收**：兩邊對向量全過；欄位增刪要改向量才過得了（突變測試）。

### C2b Rust 監督行程 v1（dev-h3）

- **做什麼**：`native/` 下新的執行檔。起與收對話行程（拆除梯度照 dsh）、預熱池、RSS 輪詢、心跳、renice、死因七類、稽核 JSONL、容量計算與 LRU 逐出（§七）。不加 crate（§五-1）；建置、musl、授權清單照 spawner。
- **驗收**：
  - 研究的 S3、S3b、S3c、S4 在**真的對話行程**（C1）上及格：失控那條被殺、其他對話零中斷、宿主存活、其他對話 p95 上升 ≤ 20%。
  - 每一類死因都有一條會紅的測試（造出那種死法、斷言分類）。
  - 冷開 #2117 那份大日誌不會被判成 `stalled`（心跳門檻 N 高於合法的同步阻塞，§六-1）。
  - 監督行程被 SIGKILL 時，對話行程不留孤兒（`PR_SET_PDEATHSIG`，跟 spawner 一樣）。

### C3 前台行程與啟動器（dev-h2）

- **做什麼**：§三-2 的啟動器（`process.execve`）；前台：HTTP、登入、靜態檔、mux、轉送、全域下行彙整、§四-3 的跨 thread 功能、home 鎖；`--process-model` 旗標與設定列。
- **驗收**：
  - `--process-model=per-thread` 下，今天的 wire e2e 與 web e2e（#1602）全綠。
  - 前台被殺，監督行程重起它，活著的對話行程不中斷，web 重連後繼續。
  - 搜尋、引用候選的落後時間量出來寫進 PR（§四-3）。
  - `single` 模式全綠、行為不變。

### C4 容量與逐出的出廠值、文件、升級指南（dev-h2）

- **做什麼**：§七 的出廠值（容量自動算、只讀開啟的短閒置、預熱池 k、對話行程的 heap 與 RSS 上限）；`docs/operations.md`〈500 怎麼來的〉改寫；升級指南。
- **驗收**：
  - 容量公式在 2、4、8 GiB 的容器上各跑一次：開到上限時是逐出閒置的，不是 OOM。
  - 側欄連點 50 條舊對話，不會把正在跑的對話擠掉（只讀開啟先被逐出）。
  - 升級指南通過 gate 的格式檢查。

### C5 web：死因、容量、冷啟動的顯示（dev-ui）

- **做什麼**：§六-2 的 wire 事件在對話畫面顯示死因；`thread_at_capacity` 的新語意（已逐出閒置仍滿）；冷啟動等待時的狀態字。視覺照 `apps/web/AGENTS.md`。
- **驗收**：每一類死因各一張截圖（淺色與深色）；容量已滿、冷啟動各一張；web 測試全綠。

### C6 稽核紀錄與指標（dev-h2）

- **做什麼**：監督行程的稽核 JSONL 的輪替與路徑、`/metrics` 的新指標（活著的對話行程數、各類死因計數、預熱池大小、RSS 合計）；寫進 `docs/operations.md`。
- **驗收**：每個新指標都有一條測試；文件裡的路徑與實際一致。

### C7 驗收量測與宣告（dev-rs）

- **做什麼**：#1947「驗收（Q32）」的全部項目，在同一台機器上前後對照（`single` 對 `per-thread`）。
- **驗收**（任一項沒過、或有沒宣告的退步，都擋改預設）：
  - §七之二 的總表逐項有數字。
  - S1–S6 與 `bench.mjs`；S3、S3b、S3c、S4 及格（同 C2b，這次是整套）。
  - 每輪 CPU 照 D162（`r7-driver.mts`，量具改成走前台；改法寫明）：第 6–15／16–25／26–45 輪 ≤ 1.65／1.45／1.25，整段 ≤ 1.35；前台與監督行程那一份另外量出來宣告、不設上限（D166 Q5）。
  - 記憶體：每條對話照 R6 宣告，另外宣告前台、監督行程、每條的 spawner、帶 MCP 的每條成本。
  - 邊界延遲與冷啟動照 R7；預熱池開與不開各量一次。
  - D151：冷開大 thread 期間，小 thread 讀歷史最長等 ≤ 1 秒。
  - R5 兩條：T6 在真對話行程上重驗；30 分鐘長跑，量監督行程的 RSS 斜率（Node 監督行程 c0p 不再是產品形狀，只當參考）。

## 十、已拍板（#1827 D166，demian 2026-11-03 在 PM session：「全部照推薦」）

| # | 題 | 拍板 | 理由 |
| --- | --- | --- | --- |
| Q1 | 加一個 Node 前台行程，`要做的事` 第 6 條那些功能全歸它；監督行程只管控制面、不接 HTTP？ | **是** | §三-1：不必在 Rust 重寫登入與 wire 路由；監督行程保持小；前台死了對話不死 |
| Q2 | 前台與對話行程之間沿用今天的 wire 協定（Unix socket 上的 HTTP），不另訂新 RPC？ | **是**（C0 量完不過就重議） | §四-1：Q28 要的三樣 wire 都有；不會有兩套協定要同步改 |
| Q3 | 死因第一版只進監督行程的稽核紀錄與 wire 事件，**不寫進會話日誌**？ | **是** | 寫進會話日誌要升格式，是 one-way；先看 web 上有沒有人需要「事後打開還看得到」再決定 |
| Q4 | 預熱池出廠 k=1？ | **是** | 多付一個 L2 行程（約 138 MB），換新對話與逐出後回來的第一句少等 0.65–1.7 s；k=0 時 R7 宣告的冷啟動照樣成立，所以這題可以反悔 |
| Q5 | D162 的上限只綁對話行程；前台轉送與監督行程每輪的 CPU 另外量出來宣告、不設上限？ | **是** | D162 綁的是第 1 步的量法，那時沒有前台；把新的一份硬塞進 1.35 等於改 D162 的定義。C0 先量，數字太大再回來 |
| Q6a | thread 上限改數「同時活著的對話行程」，出廠值照記憶體上限自動算，滿了先逐出閒置的？ | **是** | D50 要在這張重算；固定一個數字在不同主機上不是太大（OOM）就是太小 |
| Q6b | 自動算時的保留量：(a) 固定 4 GiB（64 GiB 約 293 條），或 (b) 記憶體的一半（64 GiB 約 155 條）？ | **(b)** | 部署形態是多人共用主機（#1678），「一半」是 500 那段已經用過的假設；(a) 假設整台機器只給 nexus。#1947 正文已由 PM 改成約 155 條 |
| Q7 | 加 `--process-model`，驗收全過之前預設仍是 `single`，`single` 至少保留一個版本？ | **是** | 每張子卡都變成 two-way door；macOS 開發與回退都有路 |

## 十一、範圍外與已知限制

- **#1948 的事不在這裡**：MCP 連線池、全機並行上限搬進監督行程；主機級的樹。
- **單條對話的 CPU 上限**：R3 先否，只有 renice。
- **平台**：只在 aarch64 的 Docker Desktop VM 量過（第 1 步、R6、R7 都是），x86_64 與正式主機沒量；C7 要在部署形狀的機器上至少跑一次。
- **macOS**：只有 `single`。
- **容量公式裡的 209 MB** 是 20 輪內量到的峰值；更長的對話沒量（R6「沒跑的」）。
- **子代理很多的對話**：子代理在父對話的行程裡（Q22），所以一條對話帶很多背景子代理時，吃的是那一條的 heap 與 RSS 上限。上限要不要按子代理數放寬，C4 量了再說。
- **前台本身的事件迴圈**：前台不解析會話日誌，但列表、搜尋仍在前台跑。搜尋讀大日誌的成本今天就有（`thread-search.ts`），形狀 B 沒有讓它變好或變壞；要不要另外處理，看 C3 量到的數字。

## 證據位置

- dsh 與 nexus 的現況盤點：兩個研究子代理的回報，引用的行號我逐條抽查過（dsh：`agent/src/index.ts:252-256`、`subprocess-local/README.zh.md:66`、`app-boot/README.zh.md:43`、`host-process.ts:353-359`、`session-controller/src/agent.ts:324-328`、`gateway/README.zh.md:39-41`、`subagent-acp/src/run.ts:183-212`、`subprocess.zh.md:235-240`、`subprocess/README.zh.md:161`、`session-persistence-jsonl/README.zh.md:168`；nexus：`wire-handler.ts:1604-1621`、`:1719`、`thread-capacity.ts:76`、`:79`、`serve.ts:562`、`:635`、`:820`、`wire-mux.ts:262`、`turn-timeout.ts:49`）。
- 量測：#1947 的 issuecomment-6370306989（p2t）、-6373481570（R6、R7）、-6591734365（第 1 步）、-6592108353（D162）；#2117 收尾留言。
