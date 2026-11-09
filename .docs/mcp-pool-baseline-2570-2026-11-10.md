# MCP 連線池前測：分析規則（#2570 PR-A）

**這份規則在正式量測之前寫好、先 commit，跑完不改。** 看過數字之後才補的，一律另起一段，標明時間與理由，跟 #1947 的分析計畫同一個做法。

量具在 `apps/harness/src/measure/`：

- 驅動：`mcp-pool-driver.ts`。基底是 #1947 第 1 步的穩態每輪 CPU 驅動，先照原樣搬入（commit `344b3bb7`），再另一個 commit 改成本情境。
- 兩台 fixture：`mcp-pool-stdio-server.ts`、`mcp-pool-http-fixture.ts`。
- 統計工具：`mcp-pool-stats.ts`。#1947 的 `agg.py` 改寫成 TS，拿 #1947 的原始數據比對，輸出逐字相同（`mcp-pool-agg-1947.ts`）。

## 量什麼

### 兩臂

兩臂同時活著，逐輪交錯。第 k 輪兩臂誰先，依 (k + 回合序) 輪轉。

| 臂 | 起法 | MCP 連線池 |
|---|---|---|
| `single` | 一個 `node lib/serve.js` 放所有 thread | 整個行程一份 |
| `per-thread` | `--process-model per-thread`：監督行程起前台、宿主、預熱池，每條 thread 一個對話行程 | 每個 Node 行程一份 |

### 負載

- 每回合兩臂都重新起，home 也是新的。各開 N 條 thread，跑暖機 W=5 輪，再跑量測 T=40 輪。
- 每輪是一道**柵欄**：N 條同時送出，全部收到 root 的 lifecycle 收尾，才進下一輪。CPU 只在柵欄的兩端取樣。
- 每台 serve 掛 M=3 台 MCP server：
  - 兩台 stdio，都是純 `node` 跑型別剝除，不經 tsx；
  - 一台 HTTP，無狀態的舊協議，起在驅動裡，每臂一台。
- 三台都只有一支 `lookup`，`approval.exempt` 都列了它，所以一輪不會停下來等核准。
- 假模型一輪依序叫 `mcp__mcpa__lookup`、`mcp__mcpb__lookup`、`mcp__mcph__lookup`，再回一段約 3000 字的文字，串流 20 段。所以正常一輪是 4 個模型請求。每條 thread 的第 1 輪多一個不帶工具的標題請求，這一輪落在暖機裡。

### 矩陣

| N | single | per-thread |
|---|---|---|
| 4 | ✓ | ✓ |
| 8 | ✓ | ✓ |
| 16 | ✓ | ✓ |
| 64 | 只量 single 當參考（smoke 放得下才跑） | **不量** |

- 同一個 N 的兩臂在同一次執行裡交錯。每組至少 3 回合，每組各自拿一次計時鎖。
- **per-thread 沒有 N=64，原因是監督行程的容量上限。** 容量是產品照記憶體上限算的，超過它去量的不是真實的設定，所以不給 `--capacity` 硬撐。

## CPU 的總和

**每輪 CPU 總和** 定義為：柵欄之間，該臂整棵行程樹所有 thread 的 schedstat 增量加總，再除以這道柵欄完成的輪數 N。

**行程樹**由兩部分組成：

- 根 pid 的所有後代。single 的根是 serve；per-thread 的根是監督行程，它是 `execve` 換過去的，pid 不變。
- cmdline 帶 `--tag <臂>` 的行程。MCP stdio 子行程不論掛在誰底下都算在內，被 reparent 的也撈得到，包含前台自己那 M 台。

**分開列的角色**（照 cmdline 認，D166 Q5）：

- `serve`
- `supervisor`
- `front`
- `conversation`
- `host`
- `spawner`
- `mcp-stdio`
- `other`

前台與監督行程只列它們自己的 Node／Rust 行程。

**每條對話行程的每輪中位數**（D162）：

- 適用範圍：只在 per-thread。
- 每道柵欄取各個對話行程自己的 schedstat 增量。預熱池裡那一個這一輪沒有接 thread，所以取最大的 N 個。
- 跨柵欄取中位數。

**HTTP fixture 的 CPU 不算進來**：它代表部署方的外部服務，跑在驅動行程裡。

**對帳**：每道柵欄同時記 `/proc/<pid>/stat` 的 utime＋stime 增量。這個值含已經結束的 thread，解析度 10 ms。只拿來跟 schedstat 的總和對帳，不進統計量。

## 主要統計量

- **窗**：暖機之後的第 1–10、11–20、21–40 輪，等於 D162 從第 1 輪算起的第 6–15、16–25、26–45 輪。
- **每回合每窗**：該窗內每道柵欄的「每輪 CPU 總和」取中位數。
- **跨回合**：取中位數，附 bootstrap 90% 區間。區間的算法：對回合重抽 10000 次，種子 1947，取第 5% 與第 95% 位，同 #1947。
- **比值**：每回合每窗 per-thread ÷ single，跨回合取中位數與區間。
- **按角色拆**：同樣的窗與中位數，各角色分開算。
- **per-thread 的值是 #2576 的宣告值，標成「代用值」**：它是今天每個行程一份池的量，不是 #2576 最後的形狀。

## 池的指標

每回合每臂各記一份，從 spawn 前一刻起算，包含起動時的握手。

| 指標 | 怎麼量 |
|---|---|
| stdio 子行程數 | 每道柵欄兩端數活著的 `mcp-stdio` 行程 |
| stdio 起了幾次、完成幾次握手 | server 自己寫的日誌（`start`、`initialized`） |
| HTTP 的 initialize 次數 | fixture 記的 JSON-RPC 方法 |
| HTTP 連線數 | fixture 記的現在開著、峰值、累計接過 |
| 各角色的 RSS／PSS 與 thread 數 | 回合結束、關下行之前 |
| 起動 | ready 毫秒數、起動 CPU、起動完的各角色記憶體 |
| 首次呼叫延遲 | 第 1 道柵欄送出那一刻，到每台 server 第一次收到 `tools/call` 的毫秒數。另報第 1 輪每條 thread 的 wall 中位數 |

首次呼叫延遲與第 1 輪的 wall 都落在暖機裡，在 D162 的窗之外，另外報，不跟穩態每輪 CPU 混在一起。

## 有效性、排除與標記

以下任何一條不成立，**整回合標記、主統計量排除它**，另報含它的值：

1. 每一輪的 outcome 都是 `completed`。
2. 同一個 k 上兩臂的 `llmReq` 相同。正常是 4N，第 1 輪是 5N。
3. 量測輪的每道柵欄 `readErrors`＝0。`readErrors` 是認得出、但讀不到 schedstat 或記憶體的被量行程，加上連 `stat` 都讀不到的行程。
4. 量測輪的每道柵欄 `born`＝0、`died`＝0。死掉的行程會丟掉增量，所以 `idleEvictAfterMs` 設 0，不讓 thread 在回合中被逐出。
5. 量測輪的每道柵欄，兩端的 stdio 子行程數相同，而且跨柵欄不變。
6. 收掉 serve 之後沒有留下帶 `--tag` 的行程（`leftovers` 是空的）。

另外兩項只記錄、不排除：

- **容器內的 loadavg**：N 條並行本身就會把它推高，不當排除條件。
- **宿主負載**：每 10 秒取樣一次 uptime。計時鎖已經排除了走鎖的重負載。

## 怎麼跑

- 每組用計時鎖（`~/.nexus-agent-evidence/.bench-lock`）包著跑：先在鎖外等宿主安靜，拿到鎖才起容器。
- 容器一律 `--pull=never --network none`。
- 被量的 serve 以 uid 10001 跑；驅動同一個 uid，用 tsx 跑。
- 原始數據、指令與鎖的紀錄放在本機證據目錄，不進 repo。

## 限制

- **Rust 用的是 gnu 版，不是 musl**：監督行程、宿主、spawner 都是 `rust:1.98.1-slim-bookworm` 離線 `--locked` 編的 release 版。出貨若改用 musl，記憶體配置器與起動成本可能不同。
- **per-thread 的兩個入口是繞過去的（#2657）**：
  - 問題：develop 的 `build:lib` 不會編 `front-process.js`、`conversation-process.js`，照產物起 per-thread 時，前台找不到入口。
  - 為什麼不用 manifest 補入口：在 manifest 加入口，會讓 rolldown 把 serve 的本體搬進共用 chunk，`lib/serve.js` 只剩一行 re-export，`import.meta.main` 永遠是 false，single 會安靜地以 0 結束。
  - 繞法：只在量測容器裡，`build:lib` 之後另跑一次 tsdown，只編這兩支，`--no-config --no-clean -d lib --format esm --platform node --target es2024 --no-dts --no-fixed-extension --deps.never-bundle '/^[^./]/'`。
  - 證明原有產物沒被覆蓋：另編之前、之後各記一次 `lib/` 每個檔的 md5，原有的檔一個都不能變，否則進入點就停下來。`lib/serve.js` 兩次的 md5 寫在結果段。
  - 這樣編出來的前台和對話行程，各自內含一份 serve 等相對模組的拷貝，chunk 配置跟 #2657 修好之後出貨的不同。這只影響起動、載入與 **RSS**；D162 的窗從暖機 5 輪之後才起算，穩態每輪 CPU 不受影響。所以 per-thread 的起動數字與記憶體數字，要註明是在這個繞法之下量的。
  - **#2657 修好之後要重驗**：照修好的產物重跑 per-thread，至少 N=16 一組。
- **假模型**：模型端沒有延遲。量的是 harness 與池這一側的 CPU，不是端到端的回應時間。
- **stdio server 都講舊協議**：smoke 時看到，每次 stdio 連線都起兩個行程，第一個沒有完成握手就結束，第二個才完成 initialize。這跟 `pool.ts` 檔頭寫的「版本協商 `auto` 先試新協定、再試舊協定」一致，但這是推論，還沒逐行核實。池的指標照實記「起了幾次」與「握手幾次」。
- **量測環境**：同一台機器。

## 結果

（正式跑完後補在這一段以下，不改上面的規則。）
