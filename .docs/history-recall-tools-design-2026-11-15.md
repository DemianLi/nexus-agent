# 從會話日誌讀回被摘掉的原文：設計草案（#2777 的 A 半）

狀態：2026-11-15 核可，A1、A2 已實作。A2 做了下面「去留」一節的一部分（`offloadToBackend` 與暫存提交都留著，給查不到日誌的呼叫用）：查得到日誌、讀回工具在的呼叫不寫歷史檔，前言只指向工具，`compaction/summary.filePath` 是 `null`；查不到日誌的呼叫照舊寫檔（暫存提交那一層留給它）。B 半（各注入源的分項預算）另一份、另一張 PR。

**實作跟下面草案不同的四處**（其餘照草案）：

1. **工具放在 harness 的 `PluginEntry`**（`apps/harness/src/history-recall-tools.ts`，同 `copy-file-tool.ts` 的做法），不在 `host-tools.ts`：它要的只有 `registry.sessions.forCall`，掛成條目就拿得到，不必改 `host-tools.ts` 的簽名。
2. **每頁 16,000 字元**，不是 24,000：這兩個工具不經外溢層，頁的大小就是唯一的上限；中文接近一字元一 token，取小一點。這個數字沒有量過。
3. **A1 純加法，歷史檔照寫**（A2 之後已不寫）：草案寫「有日誌時不再寫檔」，實際做下去暫存提交那一整套會變成死碼、三十幾個歷史檔的測試要跟著改，那是 A2 的範圍。A1 只在前言的歷史檔那一句後面多一句指向工具；歷史檔寫不成時前言只指向工具。
4. **`summarization` 沒關就掛這兩個工具**，不看有沒有接日誌：工具清單不隨組裝點變。前言那一句則要「工具在、而且這次呼叫查得到日誌」才加。

草案「沒查清楚的」三項：同一個條目序號出現兩顆事件時，後面那顆取代前面那顆、起點沿用，用手排的日誌測過（`history-recall.test.ts`），產品上同一步重摘是否真的落兩顆沒有另外驗證；CLI 的日誌夾具裡工具清單帶得到這兩個工具，embed 的唯讀白名單已加；分叉的日誌沒有另外處理也沒有測，照事件順序推。

## 要解決的事

摘要訊息現在告訴模型「原文存在 `/conversation_history/<sid>.md`」。那個檔在 graph state 裡、不在磁碟上，續接（`--resume`、serve 重開）之後讀不到，摘要卻還寫著那條路徑（`apps/harness/src/agent-factory.ts:690-694`）。會話日誌本來就有全部原文，而且續接後還在。

## dsh 怎麼做（SHA `8bd0733`）

dsh **沒有實作**讀回工具。只有一份 proposed 的提案 `.agents/notes/proposed/feature/2026-07-06-recallable-compaction.md`：

- `history_read(checkpoint, offset?)`（`:46`）：讀任一 checkpoint 遮掉的那一段，渲染成 `User:`／`Assistant:`／`Tool result:` 逐字稿，依預算分頁、帶續讀游標。
- `history_search(query, checkpoint?, limit?)`（`:47`）：不分大小寫的字面掃描，回片段加 checkpoint id 與 `scanned`／`matched`／`truncated`；零命中時提示「這是字面掃描」。
- 定址用 `compaction/summary` 事件的 seq，指標由程式組（`:25`）。
- 讀回是一般的工具結果、落在尾端，不動前綴快取（`:49`、`:53`）；不另設儲存或索引（`:49`）。
- 它拒絕的：向量／FTS sidecar（`:89`）、讀回路徑裡用副模型（`:90`，破壞無金鑰重放）、交原始事件而不交逐字稿（`:91`）。
- 它自己列的風險：未訓練的模型少用讀回工具（`:105-110`）。

它解決「摘掉的細節找不回來」，代價是兩個常駐工具的 schema 佔 context、以及讀回行為要靠提示詞引導。沒有實際使用驗證過，所以不能用「照 dsh」帶過。

## 別的做法

| | 做法 | 續接後可讀 | 維護 | 問題 |
|---|---|---|---|---|
| 甲 | 現狀：state 裡的檔 + `read_file`／`grep` | 否 | 已存在 | 就是這張卡要修的 |
| 乙 | 把那個檔改寫到磁碟 | 是 | 多一份落盤格式、要跟日誌保持一致、多人共用主機上多一處要管權限與清理 | 同一份資料存兩次 |
| 丙 | 兩個工具直接讀日誌（dsh 提案的方向） | 是 | 兩個純函式 + 兩個工具 | 工具 schema 佔 context；被外溢過的工具結果日誌裡只有預覽 |

選丙。相對乙：不多一份儲存，稽核只有日誌一個來源。

## 選定的做法，以及跟 dsh 提案不同的地方

**兩個工具**：`history_read`、`history_search`（名字照 dsh 提案）。

1. **定址用索引條目的序號 `#n`，不是事件 seq。** 模型在摘要訊息的 `<index>` 裡看到的就是 `[#n messages a-b]`（#2776），直接拿這個號碼來讀最短。`history_read({ entry: n, offset? })`。
   程式怎麼從 `#n` 找到那一段：掃日誌的 `compaction/summary`，取「摘要本文的索引恰好有 n 筆」的最後一顆事件（同一步重摘會留兩顆，後面那顆才生效）。**範圍不看指標上印的數字**，從事件算：迄點是該事件的 `cutoffIndex`，起點是同一個生命週期裡上一顆生效事件的 `cutoffIndex`、沒有就是 0。原因：座標在 `session/end-seed` 會重設（`conversation-replay.ts:483-488`），續接後的 `[#5 messages 0-30]` 跟續接前的 `[#1 messages 0-41]` 不是同一套座標，光看數字會讀錯段。
2. **沒有條目的段落**（#2851 以前的摘要沒有索引）：`history_search` 照樣掃得到，結果裡用 `segment: <事件 seq>` 標它；`history_read` 也收 `segment`。也就是 `entry` 與 `segment` 二選一，`segment` 只會從搜尋結果來。
3. **讀到的是日誌裡的原文**：不套剪除、不套參數截斷（這兩樣只影響送出去的樣子）。用 `ReplayFold` 逐顆餵事件，餵到目標事件之前取 `raw` 加上還在等結果的那一批，切出範圍。空的助手訊息略過；段首若是上一則摘要訊息，標成 `[prior summary]` 一行、不展開。
   **已知缺口**：被外溢層換過的工具結果，日誌裡只有預覽加路徑（`spill-policy.ts:13`）。讀回時原樣交出那個預覽，不去追 stash。寫進文件。
4. **分頁**：`offset` 是字元位移，每頁上限用常數（建議 24,000 字元，落在外溢預算 12,500 token 之內），結尾一行寫下一頁的 `offset` 或「到底了」。兩個工具加進外溢的豁免名單（同 `read_file` 的理由：讀出來的東西再外溢，模型永遠讀不完）。剪刀不豁免：被剪了可以再讀一次。
5. **搜尋**：不分大小寫的字面比對，逐則訊息掃；每個命中回 `entry`（或 `segment`）、該則在那一段裡的字元位移（可直接當 `history_read` 的 `offset`）、前後各一小段文字。`limit` 預設 20，回 `scanned`／`matched`／`truncated`。零命中時一句「這是字面比對」。不做 regex（照 dsh `:77`）。
6. **誰的日誌**：`sessions.forCall(exec)` 解到的那一份。子代理讀自己的日誌，正是它看到的那則摘要所指的那一份（摘要事件本來就寫進呼叫者自己的日誌，`summarization.ts:1829-1836`）。
7. **沒有日誌的組裝**（裸的 `createNexusAgent`、一般 eval runner）：工具回 `ok: false` 加一句「這個會話沒有日誌，讀不回原文」，不拋（同 todo 的做法）。日誌推不出來（`compaction-misaligned`）也是 `ok: false` 加一句。
8. **放哪一層**：純函式放 `packages/nexus-core/src/history-recall.ts`（輸入事件陣列，輸出文字與命中，不碰 I/O、不叫模型）；工具的宣告放 harness 的 `host-tools.ts`（那裡本來就產 `NexusTool`，可以 import core；插件依 lint 不能）。`NexusTool` 不帶 LangChain，兩條 loop 共用，#2336 之後不用再搬。
9. **核准**：唯讀，不掛核准；加進 embed 的唯讀白名單（`embed-profile.ts:68`）。
10. **前言**：有日誌時，摘要的前言改成指向這兩個工具與 `<index>` 的序號。`<summary>` 的包法不動（`summaryBodyOf` 靠它）。

## `/conversation_history/<sid>.md` 的去留

**建議拿掉摘要寫的這個檔**，分成第二張 PR：

- 留著的話同一份原文有兩個來源，而且其中一個續接後是壞的。
- 連帶要改：`offloadToBackend`、暫存提交（`summary-history-staging.ts`）、`compaction/summary.filePath`（型別留著給舊日誌，新事件一律 `null`）、wire 的 `saved`（改成「有日誌可讀回」）。
- `/conversation_history/` 這條路由**要留**：langgraph 那條還會把超大的使用者訊息搬到那裡（`agent-factory.ts:648-651`）。
- web 的「原文未另存」字樣在 `apps/web`，不是我的目錄；wire 的 `saved` 維持 `true` 就不必動它。

第一張 PR 先不拿：有日誌時前言指向工具、**不再寫檔**；沒有日誌時維持現狀（寫檔、舊前言），因為那種組裝只活一個行程，檔是讀得到的。第二張再把沒有日誌那條也收掉，或決定留著。

## 拆 PR

1. A1：兩個純函式、兩個工具、前言、外溢豁免、embed 白名單、文件（`docs/tool-catalog.md`）、測試（含「續接後讀到續接前被摘掉的原文」的端到端測試、子代理、沒有日誌）。
2. A2：拿掉摘要的歷史檔。
3. B：分項預算（另一份設計）。

## 驗收怎麼量

卡上要求「#2774 的評估在早期細節題上高於基準」。`summary-fidelity` 的 runner 自己建了 `SessionLog`（`runner.ts:132`），接得上工具。要打真端點，請求數會比 #2776 那一輪（150）多，因為回答那一步可能多出工具呼叫的來回；跑之前另外報數字等核可。

## 沒查清楚的

- 同一步重摘會留下兩顆 `compaction/summary`：`summary-history-staging.test.ts` 的 S1、S6 與 `overflow-after-summary.test.ts` 量到了（切點 `[1,2]`、`[1,2,3]`），讀回時後面那顆取代前面那顆。
- CLI／serve（非 embed）有沒有會攔新工具的預設閘門：沒找到，實作時確認。
- 分叉出來的日誌，讀回要不要跨過繼承來的那一段：建議可以讀（那是這個會話的模型看過的摘要所指的原文），實作時確認座標。
