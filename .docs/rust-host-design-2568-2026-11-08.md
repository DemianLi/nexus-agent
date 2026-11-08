# Rust 宿主行程的設計（#2568 第一輪：第 1、2、4、5、7、8 題）

#2568 的第一輪。D247 定了這一輪做第 1、2、4、5、7、8 題；第 3 題（新資料路徑多付的成本）與第 6 題（過界形狀）等 #2336 整串做完再補，卡等那時才關。

依據：
- #1827 的 D166（形狀 B）、D235（R1–R3）、D245（Q1a–Q4）、D246（dsh 基準 `8bd0733`）、D247（本輪範圍）。
- `.docs/core-base-rust-reeval-2026-11-08.md`（PR #2562）§三、§六。
- `.docs/supervisor-1947-design-2026-11-03.md`（PR #2335）。
- 卡：#2568–#2574、#2576，以及 #2523、#2524、#2494。

讀的版本：nexus `origin/develop` `b0cf55cd`；dsh 本機 clone，一律 `git show 8bd0733:`。

本篇只讀程式碼：沒有量測，沒有下載，沒有改產品碼。程式碼的事實先由兩個子代理讀出，再由我用 `git show` 逐條核對引用的檔:行；核到哪裡、哪幾條沒核，見 §十一。

## 結論

| 題 | 推薦 | 要不要 demian 拍板 |
| --- | --- | --- |
| 1 宿主由誰起 | 監督行程把它當成第三種子行程來起，跟前台、對話行程同一套 `spawn`；重起要有退避與上限 | 不用，D245 留給本卡定 |
| 2 宿主死了帶走什麼 | 對話行程與前台不跟著死。在跑的 turn 全部中斷，靠租約釋放與 log 修補恢復。終點的爆炸半徑比今天的共用 Node 前台大，要用「宿主裡不跑第三方程式」換 | **要**，見 §九 是非題 A |
| 4 協定 | 傳輸沿用 #2339 的長度前綴框；所有管道先補版本握手；收尾先擋准入。訊息內容的形狀不在本輪 | 不用 |
| 5 沙箱與 spawner | spawner 照舊每個要跑工具的行程各一支；宿主另起一支自己的 spawner 子行程給 MCP stdio 伺服器用 | **要**，見 §九 是非題 B |
| 7 稽核寫入者 | 行程生死的稽核留在監督行程，不併進宿主；會話與政策的事件 log 由宿主寫 | **要**，見 §九 是非題 C |
| 8 瘦身功能歸誰 | HTTP、靜態檔、登入、探針與指標留在前台；搜尋、引用候選、釘選封存、列 thread 搬進宿主；記錄檔各寫各的。記憶體**沒量** | 不用 |

## 一、今天的行程樹（per-thread）

```text
啟動器（Node）── execve ──> 監督行程（Rust，嚴格單執行緒）
                              ├── 前台（Node）── spawner
                              ├── 對話行程（Node，每條 thread 一個）── spawner ── 工具
                              └── 預熱池（Node，出廠 k=1）── spawner
```

- 啟動器檢查完平台之後，用 `process.execve` 換成監督行程（`apps/harness/src/process-launcher.ts:393-424`）。
- 監督行程設 `PR_SET_CHILD_SUBREAPER`，用 signalfd 收訊號，先補預熱池再起前台（`native/sandbox-spawner/src/supervisor/mod.rs:1-12`）。
- 前台與對話行程都由監督行程起：stdin／stdout 是控制管道；`pre_exec` 裡 `setpgid(0,0)`、設 `PR_SET_PDEATHSIG=SIGKILL`，再核一次 ppid（`native/sandbox-spawner/src/supervisor/process.rs:31-56`）。
- 前台死了，監督行程隔 `front_restart`（出廠 1 s）重起它，沒有次數上限（`mod.rs:1093-1101`）。這是 #2523 要修的那一類問題。
- spawner 由每個 Node 行程用 `child_process.spawn` 起，監控與重啟是 TS 的過渡版（`apps/harness/src/sandbox-spawner-client.ts:296`）。工具在 spawner 起它之後自己 `setsid`、設 PDEATHSIG（`native/sandbox-spawner/src/child.rs:58-61`）。
- 控制面框格式：`u32` LE 長度加內容；沒有版本欄位，也沒有握手（`native/sandbox-spawner/src/supervisor_protocol.rs`，grep `version|hello|handshake` 零命中）。
- 會話日誌由對話行程自己寫，各自拿 `session.lock` 寫租約（`apps/harness/src/session-lease.ts`）；前台只冷讀。
- 監督行程另寫一份行程生死的稽核：`<home>/supervisor-audit.jsonl`，只追加、0600、`O_NOFOLLOW`，每個行程結束寫一行（`native/sandbox-spawner/src/supervisor/audit.rs:72-120`）；輪替還沒做。

## 二、dsh 怎麼做（`8bd0733`）

dsh 只有 Desktop 有獨立的 host 行程，而且它就是整個後端：整棵 Cordis 樹（agent loop、sessions、MCP、web server）都在裡面（`apps/desktop-host/src/index.ts:31-36@8bd0733`）。CLI 與 `dsh web` 不分 host，直接在本行程跑（`apps/cli/src/bin.ts:32-42@8bd0733`）。

| 面向 | dsh 的做法 | 出處 |
| --- | --- | --- |
| 誰起 | Electron main 用 `child_process.spawn` 起，`stdio: ['ignore','pipe','pipe','ipc']` | `apps/desktop/src/host-process.ts:212-224@8bd0733` |
| 起不來 | host 經 IPC 送 `fatal`；不自動重起；第一個致命錯誤跳對話框，由人選離開、重起或停用第三方插件後重起 | `apps/desktop/src/backend-controller.ts:138-148`、`apps/desktop/src/fatal-recovery.ts:51-125@8bd0733` |
| 死了帶走什麼 | 同行程的全部東西，加上工具子行程（`exit` 時同步強殺） | `packages/subprocess/subprocess-local/src/index.ts:92-120@8bd0733` |
| 怎麼恢復 | 寫入租約是核心 flock，行程一死就釋放，刻意不設逾期；重開時截掉撕裂的尾巴，替開著的 turn 補合成的 `turn/end`，工具標 `TOOL_OUTCOME_UNKNOWN`／`TOOL_NOT_STARTED` | `packages/session/session-persistence-jsonl/src/lease.ts:1-13`、`packages/core/session/src/repair.ts:14-35@8bd0733` |
| 協定 | Node IPC 傳 JSON，手寫判別式檢查；`DESKTOP_HOST_PROTOCOL_VERSION` 只寫進發版 metadata，要求完全相等，因為兩邊一起出貨 | `apps/desktop/src/host-process.ts:64-111`、`apps/desktop/src/host-protocol.ts:4@8bd0733` |
| 收尾 | 設 `stopping` → 送 `shutdown` → 等 10 s → SIGTERM 等 5 s → SIGKILL 等 5 s | `apps/desktop/src/host-process.ts:347-361@8bd0733` |
| 工具與沙箱 | host 裡的 `subprocess-local` 起工具並監控；MCP stdio 伺服器也由 host 起 | `packages/subprocess/subprocess-local/src/index.ts:1-7`、`packages/mcp/mcp-client/src/transport.ts:3-19@8bd0733` |
| 稽核 | 沒有獨立的稽核日誌；核准以 `approval/asked` 寫進 session log | `packages/sandbox/sandbox/src/escalation.ts:187@8bd0733` |
| 跨 session 功能 | 搜尋（SQLite FTS5）、釘選與封存都是 host 裡的服務 | `packages/session-query/session-query-sqlite/src/index.ts:2`、`packages/api/workspace-controller/src/index.ts:159-171@8bd0733` |

dsh 在解決的問題：桌機上把後端跟 Electron main、renderer 隔開，更新前能乾淨收尾。它付的代價：host 一死，所有對話一起斷；不自動重起，要人按。正確性靠 flock 加 log 修補，不靠行程活著。

「每條對話一個行程，加一個共用的 Rust 宿主」這種形狀，dsh 沒有對應。dsh 是單人桌機，nexus 是多人共用的主機（#1947 偏離 #1 的理由 2）。

## 三、第 1 題：宿主由誰起

**選項**

- (a) **監督行程起**，當成第三種子行程，跟前台一樣：stdin／stdout 控制管道、`setpgid`、PDEATHSIG、死了由監督行程重起。
- (b) **另一個 systemd 單元**，跟監督行程平行，各自由 systemd 管。
- (c) **宿主當最上層**，由宿主起監督行程（或吃掉監督行程的工作）。

| 標準 | (a) 監督行程起 | (b) 另一個單元 | (c) 宿主在上 |
| --- | --- | --- | --- |
| 正確性 | 監督行程已經是 subreaper、已經管生死與稽核，多一種角色 | 兩個單元的起動順序與互相等待要另做 | 宿主死了，監督行程與所有對話行程跟著走（PDEATHSIG） |
| 失敗與恢復 | 宿主死了，對話行程與前台是它的兄弟，照活 | 同 (a) | 最差：跟 dsh 一樣全部一起斷 |
| 維護 | 監督行程多一種角色；它照舊單執行緒，不跑業務 | 多一份部署設定，跟 D103 的「部署細節不進 repo」衝突的機會多 | 監督行程的單執行緒規則（`mod.rs:5`）要改 |
| 現有基座 | `process.rs:31-56` 的 `spawn` 直接能用 | 要另寫 | 要改寫起動順序 |

**推薦 (a)。** 好在它不加新的部署單元，宿主死了不會帶走對話行程，而且監督行程原本的規則不用改：它只管生死、不跑業務。跟 dsh 的差別：dsh 是 shell 起 host、host 包全部，對應 (c) 的爆炸半徑；nexus 是多人共用主機，不能付這個代價。

**重起策略不照抄前台。** 前台今天隔 1 s 重起、沒有上限（`mod.rs:1093-1101`），這正是 #2523 要修的。宿主要有退避與上限：連續失敗超過上限，整台以非 0 退出，讓 systemd 看得到，stderr 寫明原因。上限與退避的數字跟 #2523 一起定，本篇不定。dsh 是不自動重起、交給人（`fatal-recovery.ts:51-125@8bd0733`）；伺服器沒有人在旁邊按，所以 nexus 要自動重起，但要有上限，才不會陷入崩潰迴圈。

**起動順序**：先起宿主，等它回 ready，再補預熱池、起前台。宿主沒 ready，前台不開准入。

## 四、第 2 題：宿主死了帶走什麼

**照 (a)，行程層面**：前台、對話行程、預熱池是宿主的兄弟，照活。宿主自己的子行程（它的 spawner，見 §六）靠 PDEATHSIG 跟著走。

**turn 層面要分兩個階段看**，因為宿主裡放的東西會一段一段變多：

| 階段 | 宿主裡有什麼 | 宿主死時中斷的是 |
| --- | --- | --- |
| #2569–#2570 落地後 | 插件樹內核、MCP 連線池、模型並行上限 | 所有正在用 MCP 工具、正在等並行名額的 turn |
| #2571、#2572 落地後 | 加上事件 log 的寫入、政策 hook | 所有正在跑的 turn（每一步都要寫 log、過政策） |
| 終點（#2573） | 加上 agent loop | 所有正在跑的 turn |

表是按「宿主裡多了什麼」分組，不是排程。#2570、#2571、#2572 的前置都只寫 #2569，彼此沒有先後；#2571 另外等落盤格式升版，#2572 另外等 K7 #2357。D245「event log 與 policy hook 先、loop 最後」說的是組合層的順序，MCP 與並行上限不屬於組合層，所以跟這張表不衝突。

**這跟 #2562 的論證有張力，要照實寫。** #2562 推 Q1a 的理由之一是「共用組合層的爆炸半徑」：共用的 Node 前台裡放組合層，一個插件把行程弄掛，所有對話一起停。到了終點，Rust 宿主一樣是所有 thread 共用的；它一死，所有正在跑的 turn 也一起斷。兩者的差別不在「死了斷多少」，而在「多容易死」與「死了怎麼回來」：

1. **宿主裡不跑第三方程式。** TS 插件照 Q21 留在對話行程的對話級樹；宿主裡只有 Rust 側插件，編進執行檔、用設定開關（#1948 Q18，已帶進 #2569）。前台若放組合層，裡面跑的是 TS 插件，一個插件的未捕捉例外或記憶體失控就會讓它掛掉。這一條是爆炸半徑可以接受的前提；它要守住，否則論證不成立。
2. **死了靠租約與 log 修補回來，不靠行程活著。** 做法照 dsh：寫入租約用核心 flock，行程一死就釋放、刻意不設逾期（`lease.ts:1-13@8bd0733`）；重起時截掉撕裂的尾巴，替開著的 turn 補合成的 `turn/end`，工具標「結果不明」（`repair.ts:14-35@8bd0733`）。nexus 今天每條對話行程已經各拿 `session.lock` 寫租約（`apps/harness/src/session-lease.ts`），搬進宿主時沿用同一個鎖檔，換一個持有者。
3. **前台在宿主不在時回 503，不把請求排進去。** 理由跟收尾一樣：准入在前台擋（#2524 的方向）。

說不圓的地方：第 1 條是一條要一直守的紀律，不是結構保證。如果哪天要讓第三方程式進宿主，爆炸半徑的論證就要重來。另一條路是**宿主分片**（每 N 條 thread 一個宿主），代價是 MCP 連線池與並行上限又變回不是全機的，跟 #1948 偏離 #5、#6 的理由衝突。本篇不推薦分片，寫成 §九 是非題 A 交 demian。

## 五、第 4 題：協定

只定傳輸、框格式、版本與收尾順序。宿主和對話行程之間傳什麼形狀的東西（只傳資料或 live reference）是第 6 題，本輪不碰。

**傳輸與框格式**：宿主與監督行程之間沿用 #2339 的做法：子行程的 stdin／stdout，`u32` LE 長度前綴（`supervisor_protocol.rs:6-7`）。宿主與前台、宿主與對話行程之間的資料路徑走 Unix socket，信任來自 0700 的 socket 目錄，跟今天前台到對話行程一樣（`apps/harness/src/peer-socket-auth.ts:1-40`）。

**版本握手**：今天所有控制管道都沒有版本欄位，框解不開就把對話行程判成 `crash` 收掉。多一類行程之後，四種角色要一起升級，錯配的機會變多。推薦每條管道的第一個框是 `hello`，帶協定版本，對不上就以明確的死因結束，而不是判成 crash。dsh 不做執行期協商，因為 shell 與 runtime 一起出貨（`host-protocol.ts:4@8bd0733`）；nexus 的四種角色也從同一份產物出貨，所以版本規則可以照 dsh 要求完全相等，差別只在 nexus 要在執行期驗、驗不過要給明確的原因。

**收尾順序**：先讓前台停准入，再讓宿主把在跑的 turn 收尾寫進 log，再收對話行程，最後收 spawner。前台先停准入，跟 #2524 B 案的方向一致；#2524 選哪一案由那張卡定，本篇不替它選。每一步的時限可以參考 dsh 的階梯（`host-process.ts:347-361@8bd0733`：10 s、5 s、5 s，總長 20 s）。nexus 今天每個 Node 行程各自的收尾上限是 5 s（`apps/harness/src/process-shutdown.ts:26`），整台多一層宿主之後總長與分配怎麼定，留給 #2569。

## 六、第 5 題：沙箱與 spawner

**限制**：spawner 不能跟要連模型 API 的行程合成一個。spawner 裝的 seccomp filter 會被子行程繼承，擋掉 `AF_INET` 與 `AF_UNIX`（#1946 issuecomment-6369590655 的代價 4；`.docs/supervisor-1947-design-2026-11-03.md` §5-1）。宿主要連模型 API 與 MCP，所以宿主不能是 spawner，也不能把 spawner 的 filter 裝在自己身上。

**選項**

- (a) **照舊每個跑工具的行程各一支 spawner**，宿主另起一支自己的 spawner 子行程，給 MCP stdio 伺服器用。
- (b) **全機一支 spawner**，由監督行程或宿主起，所有工具都經它。
- (c) 照 #1948 Q21 的原文：沙箱在主機級的樹，也就是宿主管所有 spawner 的監控與重啟。

| 標準 | (a) 各自一支，宿主另一支 | (b) 全機一支 | (c) 宿主管全部 |
| --- | --- | --- | --- |
| 爆炸半徑 | 一支 spawner 死了只影響一條對話 | 一支死了全機工具停 | 宿主死了，所有 spawner 的監控一起停 |
| 記憶體上限（#2494） | 可以每條對話一個 cgroup | 要在 spawner 裡分帳 | 同 (a)，但多一層 |
| 現有基座 | 今天的形狀，`sandbox-spawner-client.ts` 已有退避重起 | 要改成多租戶 | 監控搬家 |

**推薦 (a)。** spawner 跟著它服務的行程走，死了只影響那一條。宿主的 MCP stdio 伺服器要套沙箱（#1946 加的宣告欄位；#2570 的驗收），所以宿主起一支自己的 spawner 子行程，跟 dsh 由 host 起 MCP stdio 伺服器同理（`packages/mcp/mcp-client/src/transport.ts:3-19@8bd0733`），差別是 nexus 經 spawner 套沙箱。

這跟 #1948 Q21「主機級的樹在 Rust：MCP、並行上限、沙箱」不同，Q21 已帶進 #2569。要改，就是改拍板，寫成是非題 B。

順帶一項現況：前台不跑工具，但 `serve.ts:2273` 無條件起 spawner。這是現有程式的問題，報給 PM，不在本篇修。

## 七、第 7 題：稽核寫入者

**兩種稽核要分開看**：

1. **行程生死的稽核**：今天由監督行程寫 `supervisor-audit.jsonl`。
2. **會話與政策的事件**：今天由各個對話行程寫進會話日誌。D245 要它有一個不跟著對話行程崩潰的寫入者，終點是宿主（#2571）。

**推薦**：第 2 種由宿主寫（#2571 照原定）；第 1 種**留在監督行程，不併進宿主**。理由：宿主自己死掉的那一筆，不能靠宿主來寫。監督行程是唯一看得到所有行程生死的行程，它本來就寫這一份。dsh 沒有獨立的稽核日誌，核准寫進 session log（`escalation.ts:187@8bd0733`）；nexus 的政策決定也照這樣寫進事件 log，但行程生死這一份 dsh 沒有對應，因為 dsh 沒有監督行程。

**這會推翻今天剛做的處理**：#2344（監督行程稽核的輪替與指標）今天以 not planned 關掉，需求併進 #2571，關卡留言的理由是「替監督行程那份獨立的稽核 JSONL 做輪替，跟 D245『一個不跟著對話行程崩潰的寫入者』可能重複」，而且留言寫明「稽核要不要併進事件 log 由 #2568 第 7 題定」。照本篇的推薦，它不重複，需求應該回到 #2576。寫成是非題 C。

## 八、第 8 題：瘦身功能歸誰

今天在 per-thread 下的位置（`apps/harness/src/serve.ts`，`b0cf55cd`），以及推薦的終點：

| 功能 | 今天在哪 | 終點 | 理由 |
| --- | --- | --- | --- |
| 綁 port、網頁靜態檔、BrowserAuth | 前台（`:616`、`:620`、`:1278`） | 前台 | 對外的邊緣，D166 Q1 定了監督行程不接 HTTP |
| 探針與指標 | 前台出，數字來自監督行程的 `up`／`stats` 與對話行程推的事件（`:1315`、`:1542`） | 前台出，宿主補自己的指標 | 同上 |
| 會話搜尋 | 前台冷讀磁碟（`:1463`） | 宿主 | 宿主是 log 的寫入者，讀得到還沒落盤的那一句（原 #2531 的問題）；dsh 的搜尋也在 host（`session-query-sqlite/src/index.ts:2@8bd0733`） |
| `@` 引用候選 | 前台答清單，對話行程也建一份（`front-wire.ts:11`、`:1475`） | 宿主 | 同上 |
| 釘選與封存 | 前台寫，對話行程 `follow` 只讀（`:1355-1361`） | 宿主 | 跟會話狀態同一個寫入者；dsh 也在 host（`workspace-controller/src/index.ts:159-171@8bd0733`） |
| `listThreads`、`readSubagentSession`、`isSubagentSession` | 兩邊都有（`:1631-1680`） | 宿主 | 同上 |
| plugin 對照快照 | 前台寫，對話行程回報綁了哪幾列（`:1256`、`:1610`） | 宿主 | 版本登記在 #2569 搬進宿主 |
| 掉列紀錄器、不變量記錄檔、memory-gauge | 每個行程各寫一份（`:987`、`:1154-1161`、`:2362`） | 照舊各寫各的 | 記的是自己行程的事 |

記憶體：**沒量**。D247 定了本輪不量，要量時另外問 PM。

## 九、要 demian 決定的三題

| # | 問題 | 推薦 | 理由 |
| --- | --- | --- | --- |
| A | 終點接受「宿主一死，所有正在跑的 turn 一起斷」，條件是宿主裡不跑第三方程式、死了靠租約與 log 修補恢復；不做宿主分片？ | **是** | §四：分片會讓 MCP 連線池與並行上限又變回不是全機的；不分片的前提要一直守 |
| B | #1948 Q21 的「沙箱在主機級的樹」改成「spawner 照舊每個跑工具的行程各一支，宿主另起一支給 MCP stdio 伺服器」？ | **是** | §六：spawner 死了只影響一條對話；宿主死了不會停掉所有 spawner 的監控 |
| C | 監督行程的生死稽核留在監督行程、不併進宿主，原 #2344 的需求從 #2571 搬回 #2576？ | **是** | §七：宿主自己死掉的那一筆，不能靠宿主來寫 |

三題答「否」時，對應的卡照現在的正文做，本篇的推薦作廢。

## 十、卡要怎麼改（PM 審過再動卡）

照 D247，卡先不動，改法列在這裡：

- **#2568**：第 1、2、4、5、7、8 題指到本篇；第 3、6 題留著。
- **#2569**：「要做的事」第 2 條補上「宿主由監督行程起，重起有退避與上限（跟 #2523 一起定），先起宿主再開准入」；加「所有控制管道的第一個框是帶版本的 `hello`」。B 答「是」時，「兩層樹」那一條的沙箱改成 §六 的 (a)。
- **#2570**：「要做的事」加「宿主起一支自己的 spawner 子行程，MCP stdio 伺服器經它起」。
- **#2571**：加「寫入租約沿用 `session.lock`，持有者從對話行程換成宿主；重起時照 dsh `repair.ts` 修補開著的 turn」。C 答「是」時，拿掉〈併進來的需求〉裡原 #2344 那一段。
- **#2576**：C 答「是」時，加回原 #2344 的需求（稽核 JSONL 的輪替與路徑、`/metrics` 的新指標）。

## 十一、沒讀、沒核的

- 第 3、6 題沒做（D247）。
- 記憶體與 CPU 都沒量。
- 核對的做法：dsh 用 `git -C <主 checkout>/references/deepseek-harness show 8bd0733:<path>`，nexus 用 `git show origin/develop:<path>`（`b0cf55cd`），讀出引用範圍確認是那段程式。範圍長的只讀了開頭與結尾幾行。
- dsh 核過：`desktop-host/src/index.ts:31-36`、`cli/src/bin.ts:32-42`、`host-process.ts:64-111`（讀開頭）、`:212-224`、`:347-361`，`host-protocol.ts:4`，`backend-controller.ts:138-148`，`lease.ts:1-13`，`repair.ts:14-35`，`session-persistence-jsonl/src/index.ts:423`，`subprocess-local/src/index.ts:92-120`（讀開頭），`mcp-client/src/transport.ts:3-19`（讀開頭），`session-query-sqlite/src/index.ts:2`，`workspace-controller/src/index.ts:159-171`（讀開頭），`escalation.ts:187`。
- dsh 只核了一半：`fatal-recovery.ts:51-125` 只確認 `DesktopFatalRecovery` 這個類別在那裡；「對話框、由人選離開或重起」是子代理讀的，我沒逐行核。
- nexus 核過：`process-launcher.ts:393-424`、`process.rs:31-56`、`mod.rs:1-12`、`mod.rs:1093-1101`、`supervisor_protocol.rs:6-7`、`audit.rs:72-120`（讀開頭與結尾）、`child.rs:58-61`、`peer-socket-auth.ts:1-40`（讀開頭）、`front-wire.ts:11`、`sandbox-spawner-client.ts:296`、`process-shutdown.ts:26`，以及 §八 表裡 `serve.ts` 的每一個行號。`session-lease.ts` 只核了檔在、用 `session.lock`，沒讀全檔。
- 宿主的 5 s 收尾上限怎麼分配、重起的上限與退避數字，都沒定。
