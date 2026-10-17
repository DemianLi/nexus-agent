# E·T·C·L／O·V·G 七層盤點（2026-10-18，生產級刷新）

- **我們**：develop `cff3f832`（＝`5dbb18ae`＋#1612；#1612 只動 home 底下狀態檔的寫入，各層子代理逐檔核過不影響引用）。
- **dsh 基準**：`687f282e`（上游 master，`git ls-remote` 確認為最新）。
- **追蹤卡**：[#1614](https://github.com/DemianLi/nexus-agent/issues/1614)。判準、情境、兩把尺都是 2026-10-18 demian 在 grill session 逐題拍板的，正文就是那份共識。
- 前一版：[`seven-layer-inventory-2026-09-26.md`](seven-layer-inventory-2026-09-26.md)（基準 develop `70357bb`、dsh `477b4f4`）；再前一版 [`seven-layer-inventory-2026-09-19.md`](seven-layer-inventory-2026-09-19.md)。

## 這次跟前兩次哪裡不同

前兩次只問一件事：**dsh 出廠有、我們沒有**。這把尺看不到 dsh 自己也沒有的洞，例如成本換算、health 端點、告警、跨使用者隔離，09-19 都判成「dsh 也沒有」、不計分；而那些正是上生產最先痛的地方。這一次改成兩把尺分開判：

1. **生產級**：七層的切法照論文，判準是本專案自訂的（論文不提供，見下一節）。每條判準標了來源，★ 是致命項。
2. **dsh 架構對齊**：只看五項架構面（plugin 化、生命週期、熱插拔與只給新對話、服務注入與接縫、profile／preset），計分沿用 09-26。

**部署情境**（判準的嚴格度照這個定）：完全內網、多人共用單一主機的企業內部業務輔助機器人，不是寫程式的 agent。只綁 loopback 不算安全，因為同一台主機上的其他使用者也連得到 loopback。E 層不追 SaaS 級的 MicroVM 隔離，沙箱嚴格度依工具實際碰得到的資源判。身分、角色、稽核三件已在 [#1428](https://github.com/DemianLi/nexus-agent/issues/1428) 拍板、11/21 之後動工，這裡一律標「已拍板未落地」，不重複列成新缺口。

## 分類框架的出處

Li et al., *Agent Harness Engineering: A Survey*, 2026。OpenReview [`eONq7FdiHa`](https://openreview.net/forum?id=eONq7FdiHa)，以[專案頁](https://picrew.github.io/LLM-Harness/)上 2026-07-21 版的 PDF 為準。截至 2026-10-18，這篇沒上 arXiv、沒有 DOI，審稿狀態查不到（OpenReview 頁回驗證挑戰）。

**只當分類框架用，不當權威判準**，理由有兩個：

- 論文 §2.3（p.7）定義七層，把 E／T／C／L 稱為 structural core，O／V／G 稱為 control plane。本專案 09-19 起用的「E·T·C·L／O·V·G」切法跟它一致，但前兩份盤點都沒寫出處，這裡補上。
- **論文本身沒有生產級判準，也沒有成熟度分級。** §10 明說不要把 harness 設計當成 checklist；§13 說 ETCLOVG 是描述性分類，變成規範性框架是作者期待的下一步。論文裡最接近格子的只有兩張：Table 1（工具標準的 Wire／Typed／Runtime discovery／Long-running 四軸）與 Table 4（治理的 Perm／Hooks／Harden／Constit／Audit／Multi-Agent 六項）。本次 T 層、G 層直接套這兩張，其他層的判準由本專案自訂。

二手入口：TrueFoundry 的部落格（[連結](https://www.truefoundry.com/blog/etclovg-agent-harness-reliability-gateway)）是廠商文。它連到的一手來源跟上面相同，本文只採用它轉述論文的部分，不採用它的產品對照。

## 方法

| 證據種類 | 做法 | 範圍 |
| --- | --- | --- |
| 靜態閱讀 | 每層一個子代理讀 `cff3f832` 與 dsh `687f282e`。每條判定附 `檔:行`；否定宣稱（「沒有」「只有 N 個」）的證據標準是配 `check_index_coverage`＋對 worktree 的 `git grep`；致命項的否定宣稱（例如 G7「只有一處呼叫 `tools.gate()`」）由主線另外用 `git grep` 複核。圖譜索引停在 10-03，只拿來定位 | 七層全部＋dsh 架構五項 |
| 夾具探針 | 行程內起 `serve --live`，`live-model.baseUrl` 指向本機劇本閘道（假 key），照劇本回 OpenAI 相容的回應來驅動工具呼叫、錯誤、卡住、截斷 | 11 支：E1、E4、C2、L1、L2、L3（kill -9）、L4、G7、G8、G10，加一支量具自檢 |
| 真模型實跑 | 同一個閘道改成轉接模式，原樣轉給 NVIDIA、獨立記 usage（不讀產品自己的 token 帳，O2 是受測對象）。key 由 serve 從主 checkout 的 `.env` 自己讀，量具不經手 key 的值 | 6 個情境：O2、L2（壞 key、壞模型）、C2 摘要品質、子代理、web 核准面板（截圖）。共用 233,198 tokens，預算 2M |
| 卡片過期檢查 | 82 張開著的卡逐張讀正文與全部留言，A、B 兩批對 develop `5dbb18ae`、C 批對 `cff3f832` 核事實 | 見「卡片過期檢查」一節 |

探針與實跑的原始輸出（會話日誌、閘道帳、截圖）只放在本機 `/var/tmp/nexus-etclovg-2026-10-18/`，不進版控。台帳 `ledger.json` 與接手說明 `RESUME.txt` 也在那裡。

**判定詞**：合格／部分／不合格／已拍板未落地／N/A。實測過的會註明「實測」。只有靜態閱讀的，判定以程式碼為準，可能被實跑翻盤。

**整體評級規則**（#1614 拍板）：任一致命項不合格，判「不合格（需重構基建）」；致命項全合格、但有非致命項不合格，判「有條件合格」；全部合格才是「合格」。「已拍板未落地」不算不合格，但會列進風險摘要。

## 📊 待測 Agent 系統架構初評

nexus-agent 是單一 Node 行程的 agent harness。`serve` 對瀏覽器提供 HTTP＋串流；`cli` 是一次性入口。底座正從 deepagents／LangChain JS 遷往 vendor 進來的 Cordis 插件框架（[#1385](https://github.com/DemianLi/nexus-agent/issues/1385)），今天兩者並存：21 顆函式插件裡有 12 顆已上 Cordis 樹，其餘仍在相容層，agent loop 本身還是 LangChain 的 `createAgent`。

出廠的 `serve` 給模型 21 個工具（實測）：檔案七支（ls、read_file、write_file、edit_file、delete、glob、grep）、子代理與背景子代理、目標、待辦、計劃模式、問答、交付、`submit_record`、沙箱升級。**沒有 shell，也沒有任意程式碼執行工具**；外部系統一律經 MCP 接入，出廠清單上不帶 MCP 列。

**邊界定位**：控制面幾乎全靠「每條 thread 一份 JSONL 會話日誌」撐起來。續接、重試紀錄、核准問答、用量、摘要都折在這份日誌裡，這一半在 09-26 之後補得很紮實（#1585、#1593、#1595、#1611 等）。往行程**外面**的那一半很薄：沒有 span 形式的 trace、沒有 health／metrics、沒有告警、沒有金額。**在使用者之間**的那一半幾乎不存在：一台 serve 一個可寫根、一把登入 token、一個附件庫，所有通過認證的人看到同一個世界。後者有一大部分是 #1428 已拍板、還沒動工的事。

## 🔍 ETCLOVG 七層基建深度審查

逐條判準的依據、檔:行、dsh 做法與相關卡，見文末「逐列明細」。這一節只寫每層的結論。

### Execution (E)

判定：E1★ **不合格**、E2★ 部分、E3 部分、E4★ **不合格**、E5 部分（需專門安全評審）。

- 🟢 **合格之處與原因**
  - 單條 thread 內的**寫入圍堵**是真的。路徑先擋 `..`，再對最深的既存祖先做 realpath，然後判斷是否落在可寫根內。實測三種跳出法：經符號連結寫出去回 `FS_SANDBOX_DENIED`，並提示可以申請升級；`/../` 回「Path traversal not allowed」；絕對路徑被映射進工作區，回 ENOENT。這是確定性的檢查，跟模型怎麼說無關。
  - 我們自己起的子行程（git 快照、MCP stdio）都經同一個清洗函式，照抄 dsh 的 subprocess 做法。git 有逾時，serve 被強制結束時會同步強殺（#1589）；MCP 收尾有 5 秒上限（#1587）。
  - 出廠沒有 shell 或程式碼執行工具，所以「OS 級沙箱」這條硬要求本身不適用。對內部業務助手來說，這是成本很低的縮小攻擊面。
- 🔴 **不合格之處與原因**
  - **E1：thread 之間、使用者之間沒有隔開。** serve 只有一個 `--workspace`。實測 thread B 用 `read_file` 讀得到 thread A 寫的檔。附件庫整台共用，`ls /attachments` 列得出別人上傳的檔；檔頭寫「隔離靠 0700」，但所有 web 使用者都跑在同一個 OS 帳號底下，0700 分不開他們。生產情境：A 部門上傳薪資表，B 部門的人問「工作區裡有什麼」，模型照實列出來。這一條不會因為 #1428 有了身分就自動解決：可寫根和附件庫的形狀本身就是單租戶。
  - **E1：讀取穿得過符號連結。** 實測：工作區裡一條指向外部的連結，`read_file` 讀得到外部檔的內容，內容還進了會話日誌。dsh 相同。模型自己做不出連結（沒有 shell），只有工作區本來就有連結時才會暴露。
  - **E1：出廠權限表含 `danger-full-access`。** 任何連得上的使用者都能在自己的會話打 `/permission danger-full-access`，切成檔案不設限。部署方可以從權限表拿掉這一組，但出廠沒拿。
  - **E4：出廠預設沒有整機層級的資源上限。** 實測出廠設定開 60 條 thread：0 個錯誤，RSS 從 376 MB 線性漲到 542 MB，約每條 2.8 MB，沒有上限、沒有逐出。thread 上限（#1480）與閒置逐出（#1496）的機制都在，但要部署方自己設；背景子代理上限是每個對話各 8 個，不是整台。搜尋輸出沒有上限、磁碟沒有配額。多人共用一台主機時，一個使用者就能把整台拖垮。
  - **E2：搜尋用的子行程整份繼承環境。** 而 serve 啟動時會把 `.env` 的 key 寫進行程環境，所以模型的 key 會出現在這個子行程的環境裡（#1532）。實測：日誌、header、serve 輸出、工作區共 337 個檔掃不到 key，「不落盤」成立，「不進子行程」不成立。
  - **E5：沒有程式碼執行工具，不等於沒有執行面。** 出廠存在一個不經程式碼執行工具的間接執行面，需要專門評審；細節另案處理，不寫在本文。
- 💡 **Harness 最佳實踐對齊**
  - 論文 §3 的對標是 E2B、Daytona、Modal 這類遠端沙箱，以及 gVisor、Firecracker、Kata 這類隔離技術，還有 Anthropic sandbox-runtime。在本產品「沒有程式碼執行工具」的前提下，這些都不是第一優先。
  - **E1 隔離**：照 dsh，以「每條 thread 一個可寫根」為方向，附件庫按 thread 分目錄。dsh 本身是單使用者形狀，沒有跨使用者隔離，所以這條要寫偏離：**理由 2（產品需求超出 dsh：多人共用主機）**。要等 #1428 的身分才能做「按人」，但「按 thread」今天就能做。
  - **E1 權限表**：出廠表拿掉 `danger-full-access`，或只准部署方開。這條偏離 dsh 的出廠表，**理由 2**。
  - **E4**：出廠就設 thread 上限與閒置逐出，機制都已經在（#1480、#1496），只差預設值。dsh 沒有整體保險絲，**理由 2**；P0 級的資源保險絲已在 #1490、#1493 追蹤。
  - **E2**：搜尋子行程改走同一個清洗函式，照 dsh，不算偏離。
  - **E5**：另開安全評審卡，由人決定處置。

### Tooling (T)

判定：T1 合格、T2★ 合格、T3 部分、T4 部分、T5 部分。

- 🟢 **合格之處與原因**
  - **T1**：MCP 的 stdio 與 HTTP 兩種連線、server instructions（上限 32 KiB）、resources 三支工具、斷線重連，都照 dsh 做了。
  - **T2**：參數 JSON 壞掉、不合 schema、叫了不存在的工具，三種都變成帶碼（`INVALID_ARGS`、`UNKNOWN_TOOL`）的錯誤結果，這一輪照常繼續。檔案工具另有 `FS_*` 碼，實測看到 `FS_SANDBOX_DENIED` 進了 `tool/result.error`。
- 🔴 **不合格之處與原因**
  - **T4**：停止鍵的訊號只放在 `configurable`，刻意不交給 LangGraph，所以工具本體和 MCP 的 `callTool` 都收不到。dsh 會把 `signal` 交給 `callTool`。生產情境：使用者按停止，畫面停了，內部系統那支慢查詢照跑到完，副作用照樣發生。
  - **T5**：MCP 的失敗（server 回 isError、斷線、放棄重連）都是一般的 Error，日誌上沒有碼。本產品的外部工具幾乎全走 MCP，營運端因此分不出「內部系統掛了」和「業務上的錯誤」。
  - **T3**：MCP 的 `tools/list_changed` 不處理（已登記偏離）；dsh 會在同一個會話裡重新同步工具。插件設定改動對下一條 thread 生效，不必重啟（#1405）。
  - **T2 的小落差**：MCP 參數不合 schema 時，模型只看到「did not match expected schema」，看不到是哪一格錯；dsh 會列出違規的欄位。
- 💡 **Harness 最佳實踐對齊**
  - 論文 §4.1 的 Table 1 用 Wire、Typed、Runtime discovery、Long-running 四軸比較工具標準，MCP 是 Agent↔Capability 那一列（各格的評等符號在 PDF 抽字時遺失，本文不轉述）。照這四軸看我們：Wire 和 Typed 到位；Runtime discovery 差一個 `list_changed`；Long-running 差取消。
  - **T4**：照 dsh 把停止訊號交給工具本體與 `callTool`，不算偏離。`turn-cancel.ts:60` 那句「dsh 也是這樣」只對「等工具跑完」那一半成立，對「訊號」那一半不成立，要一起改。
  - **T5**：MCP 失敗分類碼 dsh 也沒有，要做就寫**理由 2**（產品的外部工具全走 MCP，營運需要分辨）。
  - **T3**：照 dsh 處理 `list_changed`，不算偏離。

### Context (C)

判定：C1★ 合格、C2★ 合格、C3 合格、C4 N/A、C5 部分。

- 🟢 **合格之處與原因**
  - **C1（實測）**：在一輪串流的中途 kill -9 整個 serve，再用同一個 home 與日誌重起。當掉的那一輪被補寫了 `model/end`（error）與 `turn/end`（interrupted），接著記 `session/resumed`；當掉前寫的檔還在，下一輪正常完成。寫入這一側 09-26 之後補齊了：每批 fsync 失敗就截回（#1585）、首次落盤原子化（#1593）、尾端壞行可復原丟棄（#1595）、header 原子取代（#1611）、同一個 home 只能起一個 serve（#1592）。
  - **C2（實測）**：
    - 夾具：門檻壓低後每輪都觸發 `compaction/summary`，訊息數縮到 2。把摘要請求全部打成 500，摘要呼叫重試到上限後照原請求送出，17 則訊息全部保留，沒有資料遺失。
    - 真模型：觸發 3 次摘要後問「列出所有代號」，5 個代號全對。
  - **C3**：大型工具結果外溢到宿主私有檔，門檻可以設定（`maxInlineTokens: 12500`）。
- 🔴 **不合格之處與原因**
  - **C2 的代價**：摘要請求失敗時，每一輪都會先重試摘要到上限（實測一次多 7 個請求）才送原請求。供應商半掛時，這會把請求量放大好幾倍。
  - **C1 的殘差**：三樣東西只在記憶體、重啟就沒了：沒給 `--workspace` 時模型寫的檔、摘要歷史檔、停在核准點還沒答的卡。
  - **C5**：使用者端有 web 用量環，營運端只有逐 thread 的日誌原料，沒有系統、工具、訊息三格的組成拆分（#1571）。
  - **C4**：跨會話長期記憶判 N/A。理由是身分還沒落地（#1428），共用主機上的一份記憶沒辦法按人隔開；dsh 出廠也沒有記憶。**但這個 N/A 沒有拍板出處**，要 demian 確認。
- 💡 **Harness 最佳實踐對齊**
  - 論文 §5 的對標是 MemGPT、Mem0、A-MEM 這類記憶層。對企業助手來說，在身分落地之前做跨會話記憶，風險大於收益。
  - **C2 放大**：摘要失敗時的重試預算與主請求共用同一份政策，要不要另設一份較小的，屬於重試政策的設計問題，掛在 #1499 的 P1 下判。
  - **C-14 time-context**：dsh `687f282e` 的三個 preset 都掛它（09-26 判成「dsh 也沒有」，是 dsh 那邊後來翻了）。要照 dsh 掛，還是寫新理由判不做，交 demian 決定。

### Lifecycle (L)

判定：L1★ 部分、L2★ 合格、L3★ 合格、L4 合格、L5 合格、L6★ 合格。

- 🟢 **合格之處與原因**
  - **L1（實測）**：模型永遠要再呼叫工具時，遞迴上限 100 會截停，實測在第 24 次模型呼叫停下，帶 `GRAPH_RECURSION_LIMIT` 錯誤收尾。root、前景、背景三條路都有這個上限，而且關不掉。
  - **L2（實測）**：
    - 夾具：429 兩次後成功，共 3 次；401 不重試；500 重試 3 次後放棄；空回覆（`EMPTY_RESPONSE`）重試一次後成功。
    - 真模型：無效 key 時 NVIDIA 回 403，不重試；不存在的模型回 404，不重試。
    - 每次重試都進日誌，帶 `code`、`status`、`delayMs`。可重試碼跟 dsh 的預設五碼逐字相同。
  - **L3（實測）**：見 C1 的 kill -9。背景子代理也會在續接時補寫收尾（#721）。
  - **L4（實測）**：串流中按停止，25 ms 內收尾為 `aborted`（cause user），之後 5 秒內沒有新請求。goal 在兩輪之間的空檔、跑著時暫停，也都補了（#1519、#1524）。
  - **L5**：委派的那一刻拍下沙箱模式，子代理不繼承一次性授權；背景子代理的核准固定回絕；深度固定一層；真模型實測子代理有自己的子日誌。
  - **L6**：訊號收尾上限 5 秒；未處理的例外先寫 stderr、最多等 2 秒收尾再 `exit(1)`，兩條都照 dsh（#1588）。
- 🔴 **不合格之處與原因**
  - **L1：沒有一輪層級的時鐘上限。** 只有單次請求的首事件 180 秒、閒置 90 秒；沒宣告逾時的工具也沒有期限。加上 serve 預設開啟 goal 續行，唯一的硬上限是模型在 `create_goal` 自己填的 `max_goal_rounds`：沒填就是 256，schema 沒有上限，serve 也沒有讓操作者壓低的旗標。生產情境：一個卡在重試與工具之間打轉的目標，可以合法地跑上幾小時，期間持續花錢、占用一條 thread。dsh 在這兩件上同樣沒有。
  - **L4 的殘差**：已經開始的工具會等它跑完，副作用照樣發生（dsh 相同）；工具步之間按停止時，已發出的那個模型請求仍會完成，實測被丟棄並標 `aborted`。
- 💡 **Harness 最佳實踐對齊**
  - 論文 Table 2 的對標是 LangGraph、OpenAI Agents SDK 這類編排器。我們的步數上限直接用 LangGraph 的遞迴上限。
  - **輪級時鐘上限**與**操作者端的 goal 回合上限**，dsh 都沒有，要做就寫**理由 2**（多人共用主機上一條失控的 thread 會吃掉共用資源）。兩條都沒有既有卡，列進新缺口。

### Observability (O)

判定：O1★ **不合格**、O2 部分、O3 **不合格**、O4 **不合格**、O5 部分。

- 🟢 **合格之處與原因**
  - **本機日誌這一半很完整**：`modelCall` 把一次模型呼叫的起訖、請求快照、用量、重試、回覆綁在一起；工具呼叫靠 `callId` 配對；thread id 就是會話 id。延遲拆成三段。`turn/failed` 帶分類碼。
  - **O2（實測）**：產品記的用量跟供應商回的逐筆一致，快取讀取也有分開記帳。例如一次呼叫是未快取 2408 加快取讀 4576，等於供應商回的 6984。四桶（未快取輸入、輸出、快取讀、快取寫）照 dsh（#724），失敗的呼叫也進帳（#1022）。
- 🔴 **不合格之處與原因**
  - **O1：行程外面看不到任何 trace。** 全庫沒有 span，也沒有 GenAI semantic conventions。唯一的 OTel 出口送的是 OTLP **logs**，而且不在出廠清單上，掛了預設也是停用，能送的只剩使用者按回饋時那一筆。`run_id` 只有在 `run.start` 帶了 `request_id` 時才會寫進日誌。生產情境：客訴「昨天下午助手很慢」，營運只能登入主機逐份翻 JSONL，沒辦法在內網的觀測平台上按時間、thread、工具篩選。dsh 一樣只有 logs。
  - **O3**：分類碼、重試、延遲都只在單一會話裡折，執行期沒有彙總。`/health`、`/metrics` 回 404，因為不是 `/threads` 的路徑都交給網頁靜態檔（#1535）。
  - **O4**：遙測的 ops 通道只發 `shutdown` 一種記錄。回合失敗根本不進伺服器日誌（#1536）。沒有主動推送的告警。
  - **O2**：標題模型那一次呼叫不在產品的 token 帳裡（實測 153 tokens 只出現在閘道帳）。全日誌沒有金額或單價（#1019 拍板不畫金額），也沒有跨 thread 的彙總。
  - **O5**：key 有設計上的防護，用帶鍵 HMAC 雜湊，追蹤披露也不印 key。但使用者內容在任何出口都沒有遮罩，出廠零條脫敏規則（dsh 也是零條）。
- 💡 **Harness 最佳實踐對齊**
  - 論文 §7.1 稱 OpenTelemetry 為事實上的儀表化標準，並提到 OTel 社群為生成式 AI 訂的 semantic conventions（span 屬性含模型名、token 數、延遲）；平台端的對標是 Langfuse、Arize Phoenix、OpenLLMetry、OpenInference。內網的做法是：harness 吐 OTLP traces，接部署方自架的收集器，不依賴任何 SaaS。
  - **O1**：最小的一刀是寫一顆插件，把既有的日誌事件（`model/start`、`model/end`、`tool/call`、`tool/result`）轉成 span 送出，不必重建基座；dsh 新增的共用 `otel` 服務可以當接縫（#1551 目前只管 logs）。dsh 沒有 traces，所以寫**理由 2**（內網營運需要可篩選的 trace）。
  - **O3**：照 #1535 的方向補 `/healthz`、`/readyz`。
  - **O2、O4、O5**：金額換算、主動告警、預設脫敏規則都是 dsh 沒有的，各自寫**理由 2**。#1535 的方向是只做被動抓取，可能是刻意不做主動告警，交 demian 判斷。

### Verification (V)

判定：V1 部分、V2 部分、V3 合格、V4 合格、V5★ 合格、V6 部分。

- 🟢 **合格之處與原因**
  - **V5**：`smoke.yml` 每晚排程加上手動觸發，打真的 `runServe --live`，缺 key 就直接失敗、不跳過（#436、#1264）。10-09 到 10-16 共 9 次執行全部成功，每次都是轉出 10／20 個請求、對帳 10 筆、外部檢查成功 3 件、過程違反 0。
  - **V3**：冒煙跑真的組裝，收尾時拿出口計數代理的請求數對會話日誌；本次實跑用的閘道就是同一個做法的延伸。
  - **V4**：評估管線有成功判準、平凡地板、`FailureReason` 分類；冒煙另有「過程違反」量測。
- 🔴 **不合格之處與原因**
  - **V5 的範圍很窄**：只有 3 個行為案例；打的是 NVIDIA 雲端的預設模型，不是客戶內網的那顆；紅了只走 GitHub 預設通知；不在 PR 上跑；不擋 release，因為 main 從 09-24 起沒有 push，冒煙從沒在 main 跑過。
  - **V1**：主題庫 7 題都是通用的工具題，組裝只掛 echo。跟業務最接近的是出處量測（#1344），要真 key、手動跑、不進 CI，所以 MCP 提示段改壞了不會有東西變紅。業務任務題庫沒有卡。
  - **V2**：serve 起動時不探測模型端點通不通、支不支援 tools，也沒有 `/readyz`（#1535）；盤點清單還停在 08-29。
  - **V4 只限評估管線**：產品路徑上沒有 LLM 評審，一輪看起來正常結束，就記成正常結束。
  - **V6**：預設掛 8 個執行期不變量，違規時印出來並記檔，但只觀察、不擋、不告警。dsh 已經整套移除；我們這邊保留，偏離待 11-03 重審。
- 💡 **Harness 最佳實踐對齊**
  - 論文 §8.2–8.6 的五階段（任務落地 → 就緒檢查 → 受控執行與軌跡擷取 → 判斷與失敗歸因 → 持續回歸），我們五段都有，但 V1、V2 很薄。工具面的對標是 promptfoo、DeepEval（§8 本文），以及附錄專案目錄裡的 Inspect Evals。
  - **V1**：建一組業務任務題庫，至少涵蓋「MCP 工具挑選」「引用出處」「需要核准的寫入」。dsh 沒有題庫（`BENCHMARK.md` 只一句話），寫**理由 2**。
  - **V5**：冒煙接上部署方的內網模型端點，作為發版前的閘門。

### Governance (G)

判定：G1★ 合格、G2 合格、G3 **不合格**、G4 合格、G5 已拍板未落地、G6 部分、G7★ **不合格**、G8★ **不合格**、G9 已拍板未落地、G10★ 合格。

- 🟢 **合格之處與原因**
  - **G7 的核准機制在實測的路徑上繞不過**：
    - 夾具：`submit_record` 觸發 `interrupt/raised` 與 `approval/asked`，工具沒執行。待核准時再送一句話，只會排進下一輪，不會放行那一筆。
    - 真模型＋web：畫面出現「等待核准」面板與完整參數，核准前工作區沒有檔；按下核准後才寫出紀錄，畫面標「已核准」。截圖存在本機。
    - 政策只有 ask 與 never 兩格，沒有「不問就放行」；production 程式碼沒有任何地方自己送出核准。
  - **G10（實測）**：不帶認證打 `/`、`/threads`、history、`run.start`、feed，一律回 401；Origin 錯、加偽造 cookie 回 403。只綁 127.0.0.1。
  - **G1**：#1196 照 dsh 出廠三組具名權限（沙箱與核准綁成一組），`/permission` 是唯一的切換入口，web 切到全開前要先確認。
  - **G2**：工具的四個事件（呼叫前、環繞、呼叫後、結果）照 dsh 補齊（#1253），另有 `tools.gate()`。
  - **G4**：身分、persona、檔案政策句都由必掛的列講進系統提示詞，部署方可以把公司政策寫進 persona。仍判合格，因為缺的只是一格對齊差異：dsh 會把目前的核准政策句放進系統提示詞，我們只在被拒時從拒絕文字告訴模型，切到 never 後模型要先撞一次牆。這一格照 dsh 補，列在新缺口候選。
  - **G8 的主路徑（實測）**：每次請求前才取 key；所有探針產出掃不到 key。
- 🔴 **不合格之處與原因**
  - **G7：MCP 工具沒有核准閘門，也沒有設定可以替某支工具加。** 整個 production 程式碼只有 `submit_record` 一處呼叫 `tools.gate()`。產品定位是內部資料全走 MCP，所以有寫入副作用的內部系統操作，今天不會停下來問人。部署方唯一的辦法是自己寫一顆插件去擋。dsh 的 mcp-client 也沒有這種設定。
  - **G8：key 有三個破口。**
    - (a) key 中間夾換行時，錯誤訊息會帶出整把 key，進日誌和網頁（#1541）。
    - (b) 兩處子行程不清洗環境：搜尋子行程（同 E2，#1532）與 `build-version` 起的 git（沒有卡）。
    - (c) 讀檔幾乎不受圍堵，啟動時也不檢查 `.env` 或 harness home 是否落在工作區底下；工作區裡放了 `.env`，模型就讀得到。dsh 也不擋。
  - **G3：工具輸出沒有提示注入的標記或防護。** 只有跨會話 @ 引用照抄了 dsh 的「不可信」警告；MCP 結果與讀檔內容什麼都沒有。dsh 也沒有。
  - **G6：#1544（開著）的路徑繞得過子代理的權限收斂。** 拿到 cookie 的人可以把子代理的會話 id 當成 thread 驅動，用 root 的權限跑它、改它的核准政策。
  - **G5、G9（已拍板未落地，#1428）**：一個 serve 行程一顆 token，拿到 cookie 就看得到 `/threads` 的全部；插件紀錄的操作者是自報的 `SUDO_USER`／`LOGNAME`；沒有雜湊鏈稽核。
- 💡 **Harness 最佳實踐對齊**
  - 論文 §9 的對標是 Progent、CaMeL、AgentSpec 這類權限與政策機制（Table 4 用 Perm／Hooks／Harden／Constit／Audit／Multi-Agent 六項比較它們），以及 Llama Guard 這類分類器；閘道類的 LiteLLM、Portkey 只出現在附錄的專案目錄。
  - **G7**：最小的一刀是讓 MCP 那一列可以宣告哪些工具（或 server）要核准，由一顆 gate 讀這份宣告，機制就是現成的 `tools.gate()`。dsh 沒有，寫**理由 2**（產品的寫入動作全走 MCP）。
  - **G8**：(b) 兩處子行程改走清洗函式，照 dsh，不算偏離；(c) 啟動時拒絕 `.env` 或 home 落在工作區底下，dsh 沒有，寫**理由 2**；(a) 照 #1541。
  - **G3**：在工具結果外層加一致的「不可信內容」標記，照 dsh 已經用在 @ 引用的那一句延伸，算擴大 dsh 既有的做法；要過濾的話寫**理由 2**。
  - **G6**：照 #1544 修。

## ⚖️ 最終評審結論

- **整體合格狀態：不合格（照 #1614 的評級規則）**。致命項 E1、E4、O1、G7、G8 不合格，E2、L1 只有部分。

  要說清楚的是：規則的標籤寫「需重構基建」，但這次查到的缺口**看起來大多是加法，不是重寫**（沒有估工時，以下只是形狀判斷）。O1 是加一顆把既有事件轉成 span 的插件；E4 是把已有機制的預設值打開；G7 是在現成的 `tools.gate()` 前面加一份宣告；G8 有兩處是一行清洗。真正動到形狀的只有 E1 的跨使用者隔離，而它跟 #1428 的身分工作綁在一起。

- **核心風險摘要**
  1. **多人共用主機上沒有租戶邊界**（E1、G9）：一個可寫根、一個附件庫、一把登入 token，所有使用者看到同一個世界；任何人都能切到 `danger-full-access`。
  2. **有副作用的內部系統操作不會停下來問人**（G7）：核准機制在實測的路徑上繞不過，但它只套在 `submit_record` 上，MCP 工具完全不經過它。
  3. **營運是盲的**（O1、O3、O4）：出了事只能登入主機翻 JSONL；沒有 trace、沒有 health、沒有告警。
  4. **一個人能拖垮整台**（E4、L1）：出廠沒有 thread 上限與逐出（實測線性長記憶體），沒有一輪層級的時鐘上限，goal 回合上限由模型自己決定。
  5. **key 有三個破口**（G8）：(a) key 夾換行時錯誤訊息帶出整把 key；(b) 兩處子行程不清洗環境；(c) 讀檔不受圍堵、啟動也不檢查，`.env` 放在工作區底下時模型讀得到 key。三個裡 (c) 最重。
  6. **已拍板未落地**：身分、角色、稽核（#1428，11/21 之後）。

- **下一階段 Harness 工程演進清單（Action Items）**，依「風險×代價」排：
  1. **E4**：出廠預設打開 thread 上限與閒置逐出（機制已在，#1480、#1496），並把資源保險絲排進 #1490、#1493。
  2. **G8 (b)**：搜尋子行程與 `build-version` 的 git 改走清洗函式（#1532 加一張新卡）；(a) 照 #1541。
  3. **G7**：MCP 工具可宣告「需要核准」（新缺口，理由 2）。
  4. **E1**：出廠權限表拿掉 `danger-full-access`，或改成部署方才能開（理由 2）；可寫根與附件庫按 thread 分開（新缺口，理由 2），按人分開併進 #1428。
  5. **O1**：事件轉 span 的 OTel traces 插件，接內網收集器（新缺口，理由 2），#1551 的 `otel` 服務當接縫。
  6. **O3、V2**：`/healthz`、`/readyz`（#1535）。
  7. **L1**：一輪層級的時鐘上限，加上操作者端的 goal 回合上限（新缺口，理由 2）。
  8. **T4**：停止訊號交給工具本體與 MCP `callTool`（照 dsh，新缺口）。
  9. **V1、V5**：業務任務題庫；冒煙接內網模型、當發版閘門。
  10. **E5**：另開不公開細節的安全評審卡。
  11. **G3、O5、T5、O4**：工具輸出不可信標記、預設脫敏、MCP 失敗分類碼、主動告警：都是 dsh 沒有的，排在上面之後。

## dsh 架構對齊（五項）

判定：A① 部分、A② 部分、A③a 部分、A③b 已拍板未落地、A④ 部分、A⑤a 部分、A⑤b 判過不做。7 個子項算出來：0 完成、5 部分、1 已拍板未落地、1 判過不做，完成度 41.7%（照 09-26 的計分，「判過不做」不計）。

- **A①（每項能力都是 Cordis plugin）**：21 顆函式插件裡 12 顆已上樹，另有 9 列宿主內建接縫。仍在相容層的：plan-mode、sandbox-policy、permission-presets、workspace-changes；8 列 `@nexus/core/*`、18 列 `#settings/*`、8 列 invariant；agent loop 本身；以及不在出廠清單上的 mcp、memory、quickjs、telemetry-otel。
- **A②（生命週期）**：樹上的插件走 `ctx.effect`；serve 收尾逐步各自接住、多個錯誤聚合；thread 收尾先等背景 host 收完（#1482）。相容層的插件還走 `registry.lifecycle.onDispose`。
- **A③a（改設定，下一條 thread 生效）**：還有 14 列是啟動時讀一次，改了要重啟。dsh 的 web-app 在有 HMR 時，設定改動都能即時生效。
- **A③b（換程式碼版本，只給新對話）**：版本路由只做到第一刀（#1442），後兩刀等 #1429；`code: coexist` 今天拒收。
- **A④（服務注入與接縫）**：注入機制照 dsh、而且更嚴，偏離都有登記。但接縫只長到已遷的 12 顆需要的程度：插件之間沒有互相 inject，樹上沒有事件匯流排；plan-mode、sandbox-policy 的接縫還沒開，permission-presets 的已拍板未落地（#1491）。
- **A⑤（profile／preset）**：`cordis.yml` 加 `cordis.serve.yml` 兩層，對應 dsh 的 base 加 web-app；「按入口覆寫／停用」那一半判過不做（#46、#104）；「每個會話選 preset」判過不做（#739、#714、#718）。

順帶的更正：

- dsh 的四個 preset 在 `687f282e` 的實際路徑是 `packages/bundle/web-app/presets/*.patch.yml`，只屬於 web-app；09-19 記的 `packages/preset/agent-presets/presets/*` 已不存在。
- 09-26 的 C-14（time-context）、L-18（schedule）兩列判「dsh 也沒有」，在 `687f282e` 不成立（三個 preset 都掛 time-context，web-app 已啟用 schedule）。這次兩份分層盤點的判法不一致：C 層判 C-14 為缺口、架構那份判「判過不做」；L 層判 L-18 不變、架構那份改判「判過不做」。明細照實保留兩邊，由 demian 拍板。
- `decisions-2026-10-11.md:90` 寫 dsh「換包要重啟」，這只在沒有 HMR 時成立；我們要「只給新對話」的那條偏離本身仍成立。

## 新缺口候選（沒有既有卡的，交 demian 決定要不要開卡）

先對過 #1499 的 P0–P2 卡序與 82 張開著的卡，下表只列**找不到既有卡**的，去重後 23 條；有卡的已經寫在各層的 💡 裡。照 #1614 的拍板，這份清單不自己開卡。「為何沒有既有卡」一欄只抄各層盤點實際記下的搜尋；沒記下的就照實寫「未記錄搜尋」，所以「沒有卡」的強度因列而異。標「推定」的偏離理由，是彙整時依 dsh 的 grep 推定的。

| 層／判準 | 缺口 | 為何沒有既有卡（搜過什麼） | 偏離 dsh 時屬哪一種理由 |
|---|---|---|---|
| E／E1 | serve 只有一個工作區、一個附件庫，thread 與使用者之間不隔開；有了身分（#1428）也不會自動分開 | wp1 未記錄搜尋；wp1 只寫身分隔離屬 #1428，形狀問題不在那張卡裡 | 理由 2（多人共用一台主機，dsh 是單人桌面）（WP5 推定） |
| E／E1、G／G1 | 出廠權限表含 `danger-full-access`，任何連得上的使用者都能在自己的會話切過去；部署方可以拿掉，但出廠沒拿 | 主線補列；#1491 管的是 permission-presets 上樹，不管出廠表的內容 | 理由 2（多人共用主機；偏離 dsh 出廠表） |
| E／E5 | 出廠沒有程式碼執行工具，但有間接執行的面，需要專門的安全評審 | wp1 未記錄搜尋；wp1 建議另開一張不公開細節的安全評審卡，由人決定處置 | 待評審後定 |
| E／E2、G／G8(b) | build-version 起 git 子行程沒帶清洗過的 env，key 放 .env 時會被交給 git | wp1-G：#1499 正文 grep「build-version\|git.{0,10}(環境\|env)」0 筆；gh search "build-version" 只中 #1502、#1545 等，都跟 env 無關。WP5 補查：wp1-E-main 把它掛在 #1532 下，但 #1532 正文與留言只談 rg／RIPGREP_CONFIG_PATH，沒提 build-version 或 execFileSync | 不需偏離：照 dsh 讓所有 spawner 走清洗（packages/subprocess/subprocess/src/index.ts:66） |
| T／T4 | 停止訊號沒有傳到工具本體與 MCP callTool；偏離只登記了「等工具落定」那一半 | 卡片搜尋 wp1 未記錄（只寫「無專卡，交主線對 #1499」）；程式碼側：grep turnCancelSignalOf 的消費者沒有任何工具或 MCP 插件 | 照 dsh 做就不用偏離；若維持不交，要補登記並寫明是哪一種（wp1 未定） |
| T／T5 | MCP 錯誤沒有穩定分類碼（#1563 只管檔案工具） | wp1 未記錄搜尋 | 理由 2（dsh 也沒有） |
| L／L1 | 沒有「一輪」層級的時鐘上限，只有單次模型請求的首事件／閒置逾時 | wp1 寫「沒找到既有卡」，未記錄搜了什麼；程式碼側 grep turnTimeout／maxTurnMs／wall.?clock 等 0 筆，dsh 同查只中 subagent-claude-code | 理由 2（dsh 也沒有）（WP5 推定） |
| L／L1 | serve 沒有操作者可設的回合上限 | 同上一列，wp1 未記錄搜了什麼 | wp1 未定 |
| C／C-14 | time-context：dsh 687f282e 三個 preset 都掛，我方沒有；09-26 的「dsh 也沒有」不成立 | wp1-C：gh issue list --state open --limit 200 的標題 grep「時間\|時鐘\|時區\|time」0 筆 | 照 dsh 掛就不用偏離；若重新判過不做，要寫新理由（wp1-dsh-arch 主張依 gap-survey:408 判過不做，兩份不一致） |
| C／C4 | 企業情境要不要模型可寫的長期記憶，沒有拍板（今天出貨會被所有人共讀共寫） | wp1-C：grep .docs/decisions-*.md 與 development-plan.md「長期記憶\|跨會話記憶\|long-term memory\|plugin-memory\|記憶」沒有拍板；gh issue view 1428 body grep「記憶\|memory」0 筆 | 若要做，屬理由 2（dsh 出廠 bundle／preset 不掛 memory，grep 0 筆） |
| O／O1 | 持續的 OTel traces／GenAI semconv 沒有卡在管（#1551 管的是 logs） | wp1-O 記為「沒有任何一張卡在管」，未列搜尋指令；dsh grep sdk-trace／TracerProvider／gen_ai 0 筆 | 理由 2（dsh 也沒有） |
| O／O2 | 金額換算與跨會話用量彙總（#1019 拍板側欄不畫金額，「單價另存」那條路沒實作） | wp1 未記錄卡片搜尋；dsh grep usd／costUsd／currency 等 | 理由 2（WP5 推定，dsh 側 grep 結果 wp1 未寫明） |
| O／O3 | 跨 thread 的重試與延遲分佈彙總（#1535 的 /metrics 只列回合失敗數） | wp1 只對了 #1535 的範圍，未記錄其他搜尋 | 理由 2（dsh grep prometheus／metrics 0 筆）（WP5 推定） |
| O／O4 | 主動推送告警（webhook 等）；以 #1535「全部被動抓取」的方向看可能是刻意不做 | wp1 未記錄搜尋，交 demian 判斷要不要列 | 理由 2（dsh grep prometheus／alertmanager 0 筆） |
| O／O5 | 出貨沒有預設脫敏規則（key 形狀、使用者內容） | wp1-O：grep `telemetry\.redact(` 只中定義本身；grep redact／遮罩／脫敏／scrub 沒有出貨規則；卡片搜尋未記錄 | 理由 2（dsh 也不出貨） |
| V／V1 | 沒有業務任務題庫（MCP 查業務系統、照出處回答、反問），主題庫只有 7 題通用工具題 | wp1-V：open 82 張標題 grep「eval\|題庫\|回歸\|評分\|基線」只中 #1606、#1546、#1535、#1464，都不是題庫 | 理由 2（dsh 也沒有任務題庫） |
| G／G3 | MCP 結果與讀檔內容沒有不可信標記、沒有注入防護 | wp1-G：#1499 正文 grep「注入\|injection\|untrusted」只中已劃掉的 #1570；gh search "untrusted MCP" 0 筆，"提示注入" 只中 #1591、#1570、#1574 等無關卡 | 理由 2（dsh 也沒有） |
| G／G4 | 系統提示詞裡沒有核准政策句（dsh 有 ASK／NEVER_SENTENCE） | wp1-G：#1499 正文 grep「政策句\|policy sentence\|ASK_SENTENCE」0 筆；gh search "核准政策 系統提示詞" 0 筆 | 不需偏離：照 dsh（packages/interaction/user-approval/src/index.ts:72-75、:161-173） |
| G／G7 | MCP 工具沒有閘門，設定也沒有 requireApproval，部署方無法宣告式地替寫入工具加核准 | wp1-G：#1499 正文 grep「requireApproval\|MCP.{0,20}核准\|核准.{0,20}MCP」0 筆；gh search "MCP 核准"、"MCP 工具 審批"、"requireApproval"、"MCP approval" 都 0 筆 | 理由 2（dsh 的 MCP 也沒有核准，grep exit 1） |
| G／G8(c) | 讀取面沒有圍堵：.env 在工作區底下或有指向 home 的 symlink 時，read_file 讀得到 key；啟動不檢查 | wp1-G：#1499 正文 grep「.env 與 workspace／工作區相鄰」0 筆；#1291（已關）只把讀取面限制寫進文件 | 理由 2（dsh 同樣不擋） |
| 架構／A③a | 14 列 startup-read 改了要重啟才生效 | wp1-dsh-arch 寫「無卡」，未記錄搜尋 | wp1 未定（dsh 靠 HMR 即時生效，我方判過不做 HMR） |
| 架構／A② | apply／dispose 收 AbortSignal 與時限（決議 §3-4 第 11 條）沒落地 | wp1-dsh-arch：程式碼 grep timeout／AbortSignal／deadline 0 筆；docs/plugin-contract.md:297、:592 只指向尚未開的版本路由卡 | 理由 2（dsh 也沒有，是我方決議多要的） |
| 架構／A②、A④ | 必掛列上樹後自我停用會被判 off、必掛稽核接不住；plan-mode P1–P4、sandbox-policy S1–S4 的接縫未開 | wp1-dsh-arch：只記在 #1385 Fog，#1477 只用測試釘住現況，「尚無卡」；未記錄其他搜尋 | wp1 未定 |

不放進表、另外交主線的小項：packages/nexus-core/src/approval-policy.ts:31-34 的註解還寫子代理一律 policy-never，#1266 之後已過期；apps/harness/src/plugin-live-versions.ts:22 的註解在 #1484 之後也已過期。兩條都只是註解。

## 卡片過期檢查

82 張開著的卡分三批，逐張讀正文與全部留言核事實：A、B 兩批對 develop `5dbb18ae`，C 批對 `cff3f832`。`cff3f832` 多出的 #1612 只動 7 個檔（6 個實作檔加 1 個測試檔），A、B 兩批引用到這幾個檔的都另外註明。判斷「有人在做」只認開著的 PR 和遠端分支。留言都是 PM 的拍板、卡序或派工，不算有人在做。

| 處置 | 張數 | 說明 |
| --- | --- | --- |
| 可關 | 0 | 沒有一張卡上的每一項都已落地 |
| 留言補正 | 33 | 主要是行號位移（10-17 到 10-18 合併的 P0 卡讓 serve.ts、wire-handler.ts、thread-pump.ts、jsonl-session-store.ts 整段移位），以及前置卡已合、卡序已改派 |
| 只留言（地圖卡、決策卡、有人在做） | 8 | #1428、#1385、#1497（地圖）；#1550、#1554（決策）；#1504（PR #1613）、#1528（遠端分支 `fix/attachment-durable-dirs`）、#1591（PR #1615） |
| 不動 | 40 | 卡上的事實仍成立 |
| 已在基準之後關掉 | 1 | #1527（PR #1612） |

41 則留言都以「（#1614 過期檢查）」開頭，只補正事實，不改正文。發之前用腳本逐條印出每個 `檔:行` 在基準上的內容，並查過每個「已結／仍開」宣稱對應的卡片狀態。留言網址記在本機台帳。

## 方法與限制

- **夾具探針只證明機制**：劇本閘道照劇本回應，證明的是「這條控制路徑存在、照設計走」，不代表真模型在同樣情況下會走到那條路。
- **真模型只有 6 個情境**，打的是 NVIDIA 雲端的預設模型，不是客戶內網的那顆；C2 的「5／5 回想得出來」只是單次觀察，不是統計結論。
- **E4 的記憶體數字是單機單次**：每條約 2.8 MB，量法是 60 條空 thread 的 RSS 差，跟 #1464 的量法（每條常駐 2.1 MB）不同，兩個數字不能直接比。
- **E5 只做了高層判定**，沒有做推演或實證；要由專門的安全評審判斷。
- **靜態判定可能被實跑翻盤**：沒實測的列（例如 T3、T4、T5、O3–O5 的大部分）只讀了程式碼。
- **dsh 的做法以 `687f282e` 為準**；dsh 之後再變動，💡 裡「照 dsh」的那幾條要重核。
- 論文版本以 2026-07-21 的 PDF 為準；它還在審稿，章節與表號以後可能變動。
- **外部引用怎麼核的**：論文的章節、表號、點名的專案，逐條對 2026-07-21 版 PDF 的抽字全文找原句與頁碼。Table 1、Table 4 各格的評等符號在抽字時遺失，所以本文只轉述欄名、不轉述評等；LiteLLM、Portkey、Inspect Evals 只出現在附錄的專案目錄，已照實標明。light-citation 的 `verify_refs.py` 跑過一次，但它只核 DOI，這篇沒有 DOI，核到 0 筆，等於不適用。PDF 取自專案頁；OpenReview 頁回驗證挑戰沒能打開，所以 forum 內容與審稿狀態都沒有核到。
- **過度宣稱怎麼掃的**：light-research-ethics 的機讀閘門（`claim_evidence_bind` 等）要吃論文寫作階段的結構化 claim 檔，本文沒有，所以沒跑。改成照它「命中只是訊號、查不到就寫未核驗」的紀律，人工掃絕對化措辭（一律、全部、沒有任何、繞不過……），把超出實測範圍的句子改窄。這一點偏離了 #1614 拍板的做法，在這裡照實記下。

## 逐列明細

### 讀法

- 受測樹：worktree HEAD `cff3f832`（＝develop `5dbb18ae`＋#1612；#1612 只動 7 個檔：home 狀態檔整份取代的 6 個實作檔加 1 個測試檔）。dsh：`687f282e`。
- 生產級判定只用五個詞：合格／部分／不合格／已拍板未落地／N/A。依據欄標「實測：」的來自 WP2 夾具探針（`wp2-p*`）或 WP3 真模型實跑（`wp3-w*`）；標「靜態」的只讀過程式碼。
- 架構對齊（翻判表與「dsh 架構對齊五項」）沿用 09-26 的計分詞：完成／部分／缺口／判過不做／dsh 也沒有／已拍板未落地／待拍板。
- 證據欄的 `檔:行` 都在 WP5 打開對過；對不上的改正標「(行號已更正)」，找不到的刪掉，兩者都記在文末「核對紀錄」。

### E 執行環境

| 判準 | 生產級判定 | 依據（2–4 句，含實測結果） | 證據（我方 檔:行） | dsh 做法（檔:行） | 相關卡 |
|---|---|---|---|---|---|
| E1★ 檔案邊界；thread／使用者間不互通 | 不合格 | 單條 thread 內的寫入圍堵在：先擋 `..`／`~`，realpath 之後判是否落在可寫根內。讀取穿得過工作區內的符號連結（照 #34，dsh 相同）；模型沒有 shell 做不出連結，只有工作區本來就有連結時才暴露。thread／使用者之間不隔開：serve 只有一個可寫根，附件是整台共用的唯讀路由，「隔離靠 0700」但所有 web 使用者是同一個 OS 帳號；出廠權限表含 danger-full-access，任何連得上的人都能用 /permission 切過去，圍堵沒有受保護路徑清單。實測（p01）：經符號連結寫出 → FS_SANDBOX_DENIED，`/../` → Path traversal not allowed，絕對路徑被映射進工作區；但 read_file／ls 經工作區內的符號連結讀到工作區外的檔（內容進了會話日誌），t2 讀得到 t1 寫的檔。 | apps/harness/src/contained-backend.ts:515-566（寫入圍堵）、:20（讀穿登記）；apps/harness/src/serve.ts:181、apps/harness/src/assembly-root.ts:843（單一可寫根）；apps/harness/src/serve.ts:766、apps/harness/src/agent-factory.ts:802、apps/harness/src/attachment-store.ts:27-28（共用附件、隔離靠 0700）；packages/nexus-plugin-permission-presets/src/presets.ts:50-55（danger-full-access）、packages/nexus-plugin-permission-presets/src/index.ts:277-311（/permission 切換） | 讀穿與 dsh 相同（wp1 未引 dsh 行號） | #1428（身分隔離，已拍板未落地）；「單一工作區、單一附件庫」列新缺口候選 |
| E2★ 子行程以清洗過的環境啟動 | 部分 | git 快照、MCP stdio 都經 `scrubbedParentEnv` 清洗，照 dsh。例外：基座起 rg 時整份繼承環境，而 launch-env 會把 `.env` 的值寫進行程環境，所以模型 key 會出現在 rg 子行程的環境裡；build-version 的 execFileSync 不清洗、不設逾時（只起一次、跑在程式碼目錄）。實測（p09）：掃 337 個探針產出檔（日誌、header、serve.log、home、工作區、閘道帳），假 key 0 命中，「key 不落盤」成立；「key 不進子行程環境」不成立（rg，靜態）。 | packages/nexus-core/src/child-env.ts:48；apps/harness/src/launch-env.ts:8；apps/harness/src/build-version.ts:26 | packages/subprocess/subprocess/src/index.ts:47（SENSITIVE_ENV_PATTERN）、:66（scrubbedParentEnv） | #770、#802（已關）；#1532（OPEN，rg） |
| E3 子行程逾時、serve 結束不留孤兒 | 部分 | 靜態。git 有逾時，行程被強制結束時同步 SIGKILL（#1589）；MCP 連線收尾 5 秒（#1587）。rg 沒登記強殺、停止鍵停不到、literalSearch 退路不設逾時。 | packages/nexus-plugin-workspace-changes/src/git.ts:126-159；packages/nexus-plugin-mcp/src/supervisor.ts:56 | （wp1 未引 dsh 行號） | #1589、#1587（已關）；#1532、#1560（OPEN） |
| E4★ 單一工具／thread 耗不盡主機資源 | 不合格 | 出廠沒有 thread 上限、不做閒置逐出：機制在（#1480／#1496），要部署方自己設。背景子代理上限是每個對話 8 個，不是整台；搜尋輸出不設上限，磁碟沒有配額。dsh 也沒有整體保險絲。實測（p02）：出廠設定開 60 條 thread（各一輪）0 錯、無上限、無逐出，行程 RSS 376→542 MB，約每條 2.8 MB、線性成長。 | apps/harness/cordis.yml:435-441（thread 上限出廠不設）、:534（背景子代理上限是每個主對話） | dsh 也沒有整體保險絲（只有各入口上限；wp1 未引行號） | #1464、#1490、#1493、#1505、#1532（OPEN）；#1480、#1496（已關） |
| E5 出廠有任意程式碼執行就要 OS 級隔離 | 部分 | 出廠沒有 shell／任意程式碼執行工具，quickjs 選配、不出貨，所以「OS 級沙箱」這條硬性要求本身 N/A；實測（p00）：出廠 serve 送給模型 21 個工具，沒有 shell 或程式碼執行工具。但出廠存在一個不經程式碼執行工具的間接執行面，需要專門安全評審；細節另案處理，不寫在本文。 | apps/harness/src/tool-catalog.ts:134（quickjs 不出貨） | （另案） | 建議另開不公開細節的安全評審卡（不自行開） |

dsh 架構對齊翻判（E）

| 列號 | 09-26 判定 → 現在 | 依據 |
|---|---|---|
| （無） | E-01–E-14、G-06 判定不變 | 子代理在 687f282e 重跑 grep；證據更新（/permission 取代 /sandbox #1196、#1172、#770／#1589／#1587、mcp-invariant 拿掉 #975）不改判定 |

### T 工具介面

| 判準 | 生產級判定 | 依據（2–4 句，含實測結果） | 證據（我方 檔:行） | dsh 做法（檔:行） | 相關卡 |
|---|---|---|---|---|---|
| T1 Wire：外部工具走 MCP（stdio／HTTP、resources、instructions） | 合格 | 靜態。@nexus/plugin-mcp 一列對一台 server，stdio 與 Streamable HTTP 兩種 transport 都有；instructions 帶出處標頭進系統提示詞，超過 32,768 位元組算連線失敗；resources 三支共用工具與 dsh 同名；掉線照 dsh 退避重連。出廠不掛任何 MCP 列（同 dsh 的 mcp-client 不在 bundle）。殘餘是登記過的偏離：HTTP 傳輸的 session 失效不觸發重連。 | packages/nexus-plugin-mcp/src/index.ts:55-56、:75-76（兩種 transport）、:347-356（instructionsOf）；packages/nexus-plugin-mcp/src/hub.ts:87-89、:134（resources）；packages/nexus-plugin-mcp/README.md:90-97、:143-144（重連與限制）；apps/harness/cordis.yml:39、:44（出廠只有 echo） | packages/mcp/mcp-client/src/index.ts:37、:127（toolCallTimeoutMs 60_000；我方同值 packages/nexus-plugin-mcp/src/index.ts:52）；packages/mcp/mcp-client/src/connection.ts:257-268 | #1099、#1543、#1098、#430、#431（已關）；#1572（OPEN，N0516 taskSupport） |
| T2★ Typed：schema 驗證、壞參數回結構化錯誤 | 合格 | 靜態。三種壞參數都變成 status:'error' 的 ToolMessage、輪次不中止：JSON 解不開 → INVALID_ARGS 樁；不合 schema → ToolInvocationError 認成 INVALID_ARGS；未知工具 → UNKNOWN_TOOL；工具本體拋錯由第 0 格圍堵接住。非致命落差：JSON schema 工具（即全部 MCP 工具）驗失敗時模型只看到「did not match expected schema」，因為 verboseParsingErrors 預設 false、全 repo 沒人開；dsh 回違規清單。 | packages/nexus-core/src/containment.ts:250-258、:453-475、:120-126；packages/nexus-core/src/invalid-tool-args.ts:142、:145；packages/nexus-core/src/fold.ts:521、:527、:530；node_modules/.pnpm/@langchain+core@1.2.9…/node_modules/@langchain/core/dist/tools/index.js:115-120、:49；packages/nexus-core/src/containment.test.ts:337-352；apps/harness/src/invalid-tool-args.test.ts:356、:387、:627 | packages/core/tools/README.zh.md:34、:126；packages/core/tools/src/schema.ts:466（`invalid arguments: …`） | #615（已關）；#1572（OPEN，N1228 屬 wire） |
| T3 Runtime discovery | 部分 | 靜態。插件層有：serve 每條新對話組裝時重讀清單，停用／啟用／改設定之後新對話就拿到新工具集，屬「只給新對話的插件更新」（偏離理由 2）。MCP 層沒有：工具在載入期定死，tools/list_changed 不處理，重連回來的新工具也不加（登記過的偏離，基座建好後工具集合不可變）。風險：已開著的長壽 thread 看不到新上線的 MCP 工具，下架的工具叫了才得到「no longer offered」，不會擴權或崩潰。 | packages/nexus-plugin-mcp/src/supervisor.ts:23-25；packages/nexus-plugin-mcp/src/index.ts:152-153；packages/nexus-plugin-mcp/README.md:138-141；docs/operations.md:616、:1149-1150；AGENTS.md:68 | packages/mcp/mcp-client/src/connection.ts:263-268、:296-303（list_changed → refreshTools）；packages/mcp/mcp-client/src/tools.ts:113（syncTools）；packages/core/tools/README.zh.md:109（每次請求投影） | #1099、#1405（已關）；#1385（OPEN，MCP 遷上樹後才有機會） |
| T4 Long-running：進度、取消、背景 | 部分 | 靜態（工具取消探針未跑：沒有慢工具夾具）。逾時有（MCP 預設 60 秒，由基座 defaultConfig.timeout 武裝）；背景有（serve 出廠 background-subagents continuable）；進度兩邊都沒有。缺的是取消：停止訊號只放在 configurable、刻意不交給 LangGraph，工具本體（含 MCP callTool）收不到停止訊號，guard 等 handler 落定才換成 ABORTED；dsh 每個工具本體都收 exec.signal、MCP 交給 client.callTool。 | apps/harness/src/thread-pump.ts:2833-2835；packages/nexus-core/src/turn-cancel.ts:307-336、:60；packages/nexus-core/src/containment.ts:41-45、:57-59、:250-253；packages/nexus-plugin-mcp/src/index.ts:52、:553；node_modules/.pnpm/@langchain+mcp-adapters@2.0.0…/dist/tools.js:98-101；apps/harness/cordis.yml:529-542；docs/tool-catalog.md:410-492 | packages/core/tools/README.zh.md:126（exec.signal）；packages/mcp/mcp-client/src/tools.ts:138-141、:280（不支援 task 型執行）；packages/bundle/base/cordis.patch.yml:96-97、:289-290（jobs、tool-jobs） | #148（已關）；#1532、#1530、#1572（OPEN）；「停止訊號傳到工具本體」無專卡（新缺口候選） |
| T5 工具錯誤分類碼進日誌 | 部分 | 靜態。機制照 dsh：圍堵把每次呼叫寫成 tool/call＋tool/result，失敗帶 error:{name,code}，web trace 列顯示 errorCode，一般拋錯不給碼是照抄 dsh 的 errorInfo。判部分是產品情境：外部工具幾乎全是 MCP，而 MCP 的失敗（isError、server is disconnected、已放棄重連、no longer offered）全是一般 Error，日誌上沒碼，運維分不出「內部系統掛了」與「業務錯誤」；MCP 逾時是否落成 TOOL_TIMEOUT 沒有端到端測試。dsh 一樣沒碼，我們沒有更差。 | packages/nexus-core/src/containment.ts:352-362、:250-259；packages/nexus-core/src/tool-events.ts:10-13；packages/nexus-plugin-mcp/src/index.ts:427-435、:513-520；apps/harness/src/eval/session-scan.test.ts:229-252；apps/web/src/components/trace/row.tsx:82-86 | packages/core/tools/src/index.ts:662-668（errorInfo）；packages/mcp/mcp-client/src/connection.ts:369；packages/mcp/mcp-client/src/tools.ts:298 | #1563、#1499（OPEN）；MCP 錯誤分類無專卡（新缺口候選） |

dsh 架構對齊翻判（T）

| 列號 | 09-26 判定 → 現在 | 依據 |
|---|---|---|
| T-04 逐 agent 工具 allow/deny | 缺口 → 完成 | packages/nexus-core/src/fold.ts:510-515；apps/harness/cordis.yml:536-538（toolFilter 出廠不填，同 dsh）；#707、PR #885 |
| T-11 skills 進預設清單 | 已拍板未落地 → 完成 | apps/harness/cordis.yml:66-67、:54-64；#440、PR #1174，之後 PR #1455 上樹 |
| T-20 會話標題（含 LLM 標題） | 部分 → 完成 | apps/harness/cordis.yml:412（thread-title-llm，數字照 dsh）；#650、PR #658 |
| T-23 工具 schema 目錄＋新鮮度 gate | 已拍板未落地 → 完成 | docs/tool-catalog.md:1；apps/harness/src/tool-catalog.test.ts:3、:30-39；apps/harness/package.json:30；#442、PR #1123、#1133（形狀是 vitest 測試當 gate，功能等價） |
| 新列：MCP list_changed 與執行中工具集更新 | （09-26 無此列）→ 部分 | dsh 有（packages/mcp/mcp-client/src/connection.ts:263-268 → syncTools），我們新對話才生效；偏離已登記 |
| 新列：停止訊號傳到工具本體／MCP callTool | （09-26 無此列）→ 缺口 | dsh 有（packages/core/tools/README.zh.md:126、packages/mcp/mcp-client/src/tools.ts:140）；我們只登記了「等工具落定」那一半（packages/nexus-core/src/turn-cancel.ts:14-19、:60），「工具本體收不到訊號」沒有登記、無專卡 |

### C 上下文與記憶

| 判準 | 生產級判定 | 依據（2–4 句，含實測結果） | 證據（我方 檔:行） | dsh 做法（檔:行） | 相關卡 |
|---|---|---|---|---|---|
| C1★ 會話持久化、當機可續接 | 合格 | 09-26 之後持久層連補五刀（每批 fsync 失敗截回、首次落盤原子化、尾端壞行可復原丟棄、續接 header 原子取代、收尾聚合），加上 #721 續接補寫當掉那一輪的收尾、#1503 serve.lock；CLI、serve、背景子代理冷讀三個入口都走 resumeClosingInterruptedTurn。實測（p10）：第二步串流中 kill -9，同 home 重起後當掉那一輪被補 model/end error＋turn/end interrupted、session/resumed，當掉前寫的檔在，下一輪正常完成。殘餘風險：沒給 --workspace 時的虛擬 FS、摘要歷史檔、沒答的核准卡只在 graph state，重啟回不來；沒有 checksum／壓縮。 | apps/harness/src/jsonl-session-store.ts:536-541、:542-550（fsync＋截回）、:616-620（header 暫存＋link）、:1160-1164、:664、:676-687（壞尾）、:656、:379-382、:977（原子取代、穩定快照）；packages/nexus-core/src/interrupted-turn.ts:171-175；apps/harness/src/serve.ts:367、:1027；apps/harness/src/cli.ts:1014；apps/harness/src/background-cold.ts:137；apps/harness/src/conversation-restore.ts:22-27（回不來的三樣）；apps/harness/src/home-lock.ts:47；docs/operations.md:8 | packages/session/session-persistence-jsonl/src/index.ts:1411、:1441、:1282、:1396；packages/session/session-persistence-jsonl/src/generation.ts:262；packages/session/session-persistence-jsonl/src/format.ts:404；packages/core/agent-loop/src/index.ts:891；packages/core/session/src/repair.ts:209；packages/util/atomic-write/src/index.ts:80 | #1506、#1508、#1509、#1510、#1511、#1503、#721（已關）；#1594、#1597、#1598、#1549、#1559、#1529、#1526、#1339（OPEN） |
| C2★ 超窗前壓縮、壓縮失敗不丟資料 | 合格 | tokens 100,000 與 messages 60 兩道門檻並聯，tokens 那道夾在當步模型窗口之下；端點真超窗走緊急摘要（retain 0）；摘要提示詞照 dsh；失敗四層保護（只追加日誌、失敗照原請求送或保留原錯誤、歷史檔先暫存、主請求失敗補回 state）。實測（p06，門檻壓到 1500 tokens／8 則）：每輪觸發 compaction/summary、訊息數 →2；摘要請求一律 500 時摘要呼叫重試 7 次後照原請求送出、17 則全留、無資料遺失，代價是每輪多 7 次請求。實測（w3，真模型、門檻 9000）：5 輪觸發 3 次摘要，訊息數穩在 6，最後問「列出所有代號」5／5 全對。沒有手動 /compact（C-06 判過不做）。 | packages/nexus-core/src/summarization.ts:246-255、:280-290、:519-523、:169、:179、:1729-1738、:973、:1026；apps/harness/cordis.yml:270-282；packages/nexus-core/src/summary-history-staging.ts:1-30 | packages/compaction/compaction-basic/src/index.ts:158-175、:218-225、:294-299；packages/compaction/compaction-basic/src/summarizer.ts:32、:37、:164-171；packages/compaction/compaction-basic/src/region.ts:417-420；packages/compaction/compaction-basic/src/config.ts:75（headroom 65,536） | #432、#1374、#1381、#1389、#1390、#1396、#1539（已關）；#1460、#1339（OPEN） |
| C3 大型工具結果外溢 | 合格 | 靜態。照 dsh 落地：超過 12,500 估算 token 全文存進主機上按會話分的私有目錄（0700／0600），模型只收頭尾預覽與定位，含通知不超過預算，read_file 不外溢，存不下保留原結果；續接後讀得回；grep／glob／ls 超量也自存；保留 30 天、#1610 後清掃只認 `session-<16 hex>`、先 lstat。殘餘（歸 #1553）：@ 引用截斷仍回 storage-not-configured、清掃整目錄 `rm -r` 且擋住啟動、外溢檔沒有總量上限（磁碟耗盡歸 E4）。 | packages/nexus-core/src/spill-policy.ts:7-12、:252；apps/harness/cordis.yml:503-506、:513-516、:523-527；apps/harness/src/agent-factory.ts:805-813；apps/harness/src/serve.ts:970-976、:603；apps/harness/src/tool-result-stash.ts:90、:334-341；apps/harness/src/session-reference.ts:24-25、:397 | packages/bundle/base/cordis.patch.yml:411-416；packages/spill/spill-policy/src/index.ts:34、:113、:127、:135；packages/spill/spill-local/src/cleanup.ts:23、:196-198、:257；packages/spill/spill-local/src/index.ts:61（清掃不延遲啟動） | #719、#734、#735、#736（已關）；#1553、#1531、#1580（OPEN） |
| C4 跨會話長期記憶 | N/A | 靜態；N/A 是本節推論，不是決議，列給 demian 拍板。產品是多人共用主機的企業內部機器人，模型可寫的長期記憶要按人隔離，前提是身分與角色（#1428，已拍板未落地）；今天出貨的話一份記憶會被所有人共讀共寫，還能被提示注入改寫。dsh 出廠也沒有記憶，只給三份預設關閉的 MCP 參考設定；@nexus/plugin-memory 是選配、出貨清單零列。 | packages/nexus-plugin-memory/src/index.ts:2、:4；apps/harness/package.json:66；apps/harness/src/tool-catalog.ts:125；apps/harness/src/session-reference.ts:119（使用者主動的跨會話引用） | docs/user/guide/mcp-memory.zh.md:5、:31 | #1428（OPEN）；#388、#713（已關） |
| C5 上下文用量可見 | 部分 | 靜態。使用者面有，但只在 serve：web 輸入框底列的用量環量「離自動摘要多遠」（分母是摘要門檻，登記的偏離），80% 以上變警示色，點開看供應商實數與逐道門檻。營運面只有逐 thread 的原料（context/measure、token-meter 投影），沒有跨 thread 彙總；缺組成拆分（系統提示／工具定義／對話各吃多少，dsh 有 contextBreakdown）；CLI 沒有畫面。 | packages/nexus-wire/src/context-pressure.ts:19-20、:36、:52-64；apps/web/src/components/context-meter.tsx:17-27；packages/nexus-core/src/summarization.ts:1694-1705；apps/harness/src/conversation-history.ts:406；apps/harness/cordis.yml:189-190；packages/nexus-plugin-token-meter/src/index.ts:1-3 | packages/llm/token-meter/src/index.ts:115-116（contextPressure＋contextBreakdown）；packages/bundle/base/cordis.patch.yml:348 | #1571、#1535、#1591、#1460（OPEN）；#528、#588、#1443、#1454（已關） |

dsh 架構對齊翻判（C）

| 列號 | 09-26 判定 → 現在 | 依據 |
|---|---|---|
| C-03 摘要 prompt 保留原始意圖與使用者糾正 | 缺口 → 完成 | packages/nexus-core/src/summarization.ts:169、:179、:684；dsh packages/compaction/compaction-basic/src/summarizer.ts:32、:37；#432、PR #1113；偏離（用模板不重播）登記在 summarization.ts:77-84 |
| C-05 大輸出外溢（spill） | 部分 → 完成 | packages/nexus-core/src/spill-policy.ts:7-12；apps/harness/cordis.yml:503-506、:513-516；apps/harness/src/tool-result-stash.ts:1-20；dsh packages/bundle/base/cordis.patch.yml:411-416；#719、#734、#735、#736、#1610；殘餘歸 #1553 |
| C-07 圖片省略與附件 | 待拍板 → 完成（形狀不同） | packages/nexus-core/src/fold.ts:655-661、:770-776；packages/nexus-core/src/image-offload.ts:1-6；apps/harness/src/attachment-store.ts:143；apps/harness/src/serve.ts:766；dsh base:146、:434；不是 cordis.yml 的列、部署方關不掉；附件只在 serve |
| C-08 上下文壓力量表（token-meter） | 完成 → 部分（09-26 漏判） | dsh packages/llm/token-meter/src/index.ts:115-116 同時登記 contextBreakdown，477b4f4 同檔 :116 已有（git show 實讀）；我方沒有組成拆分；#1571 |
| C-11 跨會話引用 | 已拍板未落地 → 完成（形狀不同） | apps/harness/src/session-reference.ts:1-8；apps/harness/src/thread-pump.ts:1372；dsh packages/bundle/web-app/cordis.patch.yml:94-95；#713；harness 模組、不是清單列 |
| C-12 @file 引用補全 | 已拍板未落地 → 完成（形狀不同） | apps/harness/src/file-references.ts:1-5；dsh packages/bundle/web-app/cordis.patch.yml:97-98；#651、#653 |
| C-14 時間上下文（time-context） | dsh 也沒有 → **兩份 wp1 檔不一致：wp1-C 判「缺口」、wp1-dsh-arch 判「判過不做」**，待 demian 拍板 | 兩檔都同意 09-26 的「dsh 也沒有」在 687f282e 不成立：dsh packages/bundle/web-app/presets/standard.patch.yml:19、ptc.patch.yml:19、cordis.patch.yml:22 都掛 time-context（README.zh.md:12 寫明 standard、cordis 與 ptc 宣告它），477b4f4 時只在 web-app 且 disabled（git show 實讀）。分歧在我方：wp1-C 認為照 09-26 自訂規矩（.docs/plugin-architecture-gap-survey.md:407 (行號已更正)）它算出廠、我方沒有實作也沒有卡 → 缺口；wp1-dsh-arch 依調研筆記「登記不排」（gap-survey:408）→ 判過不做、重開條件要對一次。另：survey 的另一條理由（瀏覽器時區要先擴 wire）在 .docs/plugin-architecture-gap-survey.md:410 (行號已更正)，仍成立 |
| C-16 系統提示詞的身分與 persona | 部分 → 完成 | apps/harness/cordis.yml:210-215；dsh packages/bundle/base/cordis.patch.yml:504；#720、PR #820；#1477、PR #1495 上樹 |

### L 生命週期與編排

| 判準 | 生產級判定 | 依據（2–4 句，含實測結果） | 證據（我方 檔:行） | dsh 做法（檔:行） | 相關卡 |
|---|---|---|---|---|---|
| L1★ 每輪步數與時間硬上限 | 部分 | 步數上限合格：root、一次性子代理、背景子代理三條圖都帶同一個 recursionLimit（預設 100 super-step，serve 出貨約 24 輪模型呼叫），關不掉，CLI 撞到回退出碼 2。時間上限沒有：全樹沒有輪級時鐘，只有單次請求的首事件／閒置逾時，maxRetries 設定上不設頂，沒宣告 timeout 的工具不設期限；serve 預設開 goal 續行，唯一硬上限是模型自己填的 max_goal_rounds（不填 256、schema 不設頂），也沒有 --max-goal-rounds。實測（p03）：模型永遠要工具時遞迴上限截停（24 次模型呼叫、515ms），收尾帶 GRAPH_RECURSION_LIMIT；輪級時鐘未實測（靜態：沒有）。 | apps/harness/cordis.yml:704-707、:696-698；apps/harness/src/agent-factory.ts:851-853、:892-895、:877-882；apps/harness/src/cli.ts:1301、:1330；apps/harness/src/settings/live-model.ts:333、:37；packages/nexus-core/src/containment.ts:161-162；apps/harness/src/serve.ts:284；apps/harness/src/assembly-root.ts:488；packages/nexus-goal/src/index.ts:85；packages/nexus-plugin-goal/src/tools.ts:691 | dsh 兩種上限都沒有，只有外部後端的 error_max_turns（packages/subagent/subagent-claude-code/src/run.ts:115）；goal 上限 256、只驗正整數（packages/goal/goal/src/index.ts:199-204、:244） | #362、#533、#445（已關）；#1251；輪級時鐘、serve 操作者回合上限無卡（新缺口候選） |
| L2★ 錯誤分可重試／不可重試、重試有預算 | 合格 | 只剩一支分類器 classifyTurnFailure、一層 retryModelCall（SDK 層 maxRetries 恆為 0），首事件前後共用一份預算；可重試碼與 dsh 預設五碼逐字相同，AUTH／QUOTA／INVALID_REQUEST 等不重打；retry-after 超過上限就放棄。實測（p04，maxRetries 3）：429×2 後成功（3 次）、401 不重試（1 次）、500 重試 3 次後放棄（4 次）、空回覆 EMPTY_RESPONSE 重試 1 次後成功，llm/retry 帶 code／status／delayMs。實測（w2a／w2b，真供應商）：無效 key 回 403、不存在的模型回 404，都 0 次重試、一輪以錯誤收尾。殘差：maxRetries 不設頂，與 L1 連動。 | apps/harness/src/live-model.ts:385-392、:1505、:1247；packages/nexus-core/src/stream-retry.ts:184-190、:358-361、:1-12；apps/harness/src/settings/live-model.ts:47-48 | packages/llm/llm/src/retry-policy.ts:18-24（同樣五碼）、:150-158（預設 normal） | #520、#1448（已關）；#1437 |
| L3★ 崩潰後續接、背景子代理收尾 | 合格 | serve 碰到以前寫過的 thread 走 resumeClosingInterruptedTurn，補寫當掉那一輪的收尾，冪等、照 dsh；落盤側自 09-26 起連補多刀，同 home 只能起一台。背景子代理冷復活照 dsh：重啟後不自動拉起、收到 send 才續接並先補收尾；正常關閉時中止進行中的輪。實測（p10）：第二步串流中 kill -9，重起同 home 後補了 model/end error＋turn/end interrupted、session/resumed，下一輪正常完成。殘差：圖 state 靠日誌重播灌回（偏離 #306）；行程死掉時背景子代理的結算通知不送主對話（dsh 也是冷的）。 | apps/harness/src/serve.ts:362-367；packages/nexus-core/src/interrupted-turn.ts:167-182；apps/harness/src/background-cold.ts:7-8、:137；apps/harness/src/background-subagents.ts:1080-1091；packages/nexus-core/src/session-checkpoint-policy.ts:12-14 | packages/core/agent-loop/src/index.ts:891（interruptedTurnClosers） | #721、#722、#737、#1503、#1506、#1508、#1509、#1510（已關） |
| L4 停止鍵即停 | 合格 | 合作式取消照 dsh：還沒開始的工具補 ABORTED_BEFORE_DISPATCH，模型串流用 AbortSignal 當場切斷，退避等待中也會中止；goal 續行兩輪之間的停止會收回授權（#1518）、目標在跑時可暫停（#1516）。殘差：已開始的工具等它落定、副作用照樣發生（見 T4）；root 的停止不連帶背景子代理（照 dsh，web 子代理卡有停止鈕）。實測（p05）：串流中按停止 → 25ms 內 turn/end aborted(cause user)、之後 5 秒 0 個新請求；工具步之間按停止 → 5ms 收尾，但停止前已發出的那個模型請求仍完成（被丟棄、outcome aborted）。 | packages/nexus-core/src/turn-cancel.ts:2-3、:60、:317、:370；packages/nexus-core/src/stream-retry.ts:401-402；apps/harness/src/background-subagents.ts:19-20；apps/web/src/components/tool/subagent-control.tsx:154 | packages/core/agent-loop/src/tool-calls.ts:253-256（aborted before dispatch）；packages/core/tools/src/index.ts:1965-1976 (行號已更正)（已開始的等靜止才換 ABORTED） | #1516、#1518（已關）；#276、#265（舊決議） |
| L5 子代理權限不超過父代理、有生命週期 | 合格 | 委派那一刻拍下 root 的沙箱模式，root 之後放寬不追溯，一次性 grant 不給子代理；前景子代理用同一顆核准閘門，背景子代理換成 policy-never 確定性回絕；深度固定一層（子代理看不到 subagent 工具）；每個主對話最多 8 個背景子代理，thread 收尾先等背景 host 收完。（#1544 的會話劫持路徑見 G6。）實測（w4，真模型）：模型用 subagent 委派讀檔加總，子代理一次性、有自己的子日誌、答案正確；權限收斂本身未實測。 | packages/nexus-plugin-sandbox-policy/src/sandbox-mode.ts:36-37；packages/nexus-core/src/fold.ts:711、:546-547；apps/harness/src/agent-factory.ts:873、:888-889；apps/harness/src/background-delegation.ts:440；apps/harness/src/background-subagents.ts:111、:1060-1061 | packages/subagent/subagent/src/child-agent.ts:248、:224-230；packages/subagent/subagent/src/index.ts:197（maxActiveSubagents 預設 8） | #326、#327、#708、#709、#737、#1045、#1482、#1484（已關） |
| L6★ 收尾有界、未處理例外 fail loud | 合格 | 靜態。serve 的 main() 在 runServe 之前裝兩樣：SIGTERM／SIGINT 走 createProcessShutdown（5 秒上限、收尾中再來一次訊號當場結束）；unhandledRejection／uncaughtException 走 installFailLoud（寫一行帶標籤的 stderr、最多等 2 秒走同一份 dispose、exit(1)），都照 dsh。收尾鏈子項各自有界（MCP 5 秒、強殺 git、聚合錯誤）。殘差：CLI 一次性路徑沒有任何訊號或 fail-loud handler；生產走 serve，不影響判定。 | apps/harness/src/process-shutdown.ts:22、:76-78；apps/harness/src/fail-loud.ts:46 (行號已更正)、:98-99；apps/harness/src/serve.ts:1312-1328、:1337 | apps/cli/src/process-shutdown.ts:4；packages/boot/app-boot/src/index.ts:842、:884 | #1501、#1511、#1542、#1543（已關） |

dsh 架構對齊翻判（L）

| 列號 | 09-26 判定 → 現在 | 依據 |
|---|---|---|
| L-03 模型請求重試 | 部分 → 完成 | packages/nexus-core/src/stream-retry.ts:1-12、:184-190；apps/harness/src/settings/live-model.ts:34-48；#520、PR #1448；留一條偏離：mode: always 拒收（產品需求超出 dsh） |
| L-06 畫面提示撞到輸出上限 | web UI 只列不判 → web 有實作（仍不計分） | apps/web/src/components/tool/card.tsx:24-25、:243；#608；root 輪尾提示沒有逐行驗證 |
| L-07 崩潰孤兒輪補結 | 部分 → 完成 | packages/nexus-core/src/interrupted-turn.ts:12-16、:167-182；apps/harness/src/serve.ts:367；#721 |
| L-08 耐久檢查點 | 部分 → 完成（剩一條登記偏離） | packages/nexus-core/src/session-checkpoint-policy.ts:12-14（#722）；「摘要那次呼叫前不排空」仍在 :35-37，偏離沒標是哪一種理由 |
| L-09 長期目標＋自動續行 | 已拍板未落地 → 完成 | apps/harness/src/serve.ts:281-284（serve 預設開，#445）；生產面的新風險見 L1 |
| L-13 子代理續行／背景、send_message、list_agents | 缺口 → 完成 | apps/harness/src/background-delegation.ts:72-80、:6-11（偏離：新工具 subagent 取代 task 加欄位，基座表達不出來）；apps/harness/src/background-subagents.ts:111；apps/harness/src/background-cold.ts:5-11；#708、#737 |
| L-14 子代理逐個選模型 | 缺口 → 完成 | apps/harness/cordis.yml:549-550；apps/harness/src/background-delegation.ts:63-67；#709 |
| L-23 插話（next-step steer） | 缺口 → 完成（harness 那半） | apps/harness/src/wire-handler.ts:1510、:2147；apps/harness/cordis.yml:697；#710；web 那半沒驗證 |
| L-25 每步平行工具呼叫上限 | 缺口 → 完成 | apps/harness/cordis.yml:716-719；apps/harness/src/agent-factory.ts:851-855；#711；偏離：改值要重啟、上限 1 時用屏障串行 |
| L-26 模型選擇 | 部分 → 完成（serve --live） | apps/harness/src/model-selection-host.ts:65-75；apps/harness/src/serve.ts:1076；apps/harness/cordis.yml:661-662；#723、#729 |
| L-18 排程（schedule） | dsh 也沒有 → **兩份 wp1 檔不一致：wp1-L 列為不變（否定 grep 0 筆）、wp1-dsh-arch 改判「判過不做」**，待 demian 拍板 | wp1-dsh-arch：687f282e 的 web-app:139-140 啟用 schedule、三個 preset 掛 tool-schedule，09-26「dsh 也沒有」的依據（477b4f4 web-app 那列 disabled）不再成立，依 gap-survey:40、:450「需求未出現」比照 L-16／L-17 判過不做。wp1-L 只重跑了我方否定 grep（沒有實作），沒有重核 dsh 側 |

### O 可觀測與維運

| 判準 | 生產級判定 | 依據（2–4 句，含實測結果） | 證據（我方 檔:行） | dsh 做法（檔:行） | 相關卡 |
|---|---|---|---|---|---|
| O1★ 每次 LLM／工具呼叫有 trace、可依 thread／run id 關聯、可匯出 OTel GenAI semconv | 不合格 | 靜態（O1 探針未跑：出廠清單沒有任何 telemetry 列，dump-config 為證）。本機那一半合格：一次模型呼叫有 model/start、request/header、model/usage、llm/retry、model/end，用 modelCall 綁在一起，工具用 callId 配對，thread_id 就是 root 會話 id；run_id 只在 run.start 帶 request_id 時才寫。對外完全沒有 OTel trace：全庫沒有 span／TracerProvider／GenAI semconv，唯一的 OTel 出口送的是 OTLP logs、不在出貨清單、預設 disabled，只剩 feedback-only 一種會送的模式。dsh 同樣只有 logs；補上要標偏離理由 2。 | packages/nexus-plugin-telemetry-otel/src/index.ts:5-7、:84、:89、:121；apps/harness/src/agent-factory.ts:986-988；packages/nexus-core/src/session-telemetry-coordinator.ts:147-155；packages/nexus-core/src/session-log.ts:581-585、:599、:641-645、:670-686、:1122-1127、:384-385；apps/harness/src/tracing.ts:4-8 | packages/bundle/base/cordis.patch.yml:202-231（otel＋session-telemetry-otel，FEEDBACK_ONLY）；packages/telemetry/otel/src/session-log.ts:8（LoggerProvider）；packages/session/session-telemetry/src/coordinator.ts:188-193 | #1536、#1551、#1534（OPEN）；「持續的 OTel traces／GenAI semconv」無卡（新缺口候選） |
| O2 token 含快取讀寫並換算成本 | 部分 | 每次呼叫的 model/usage 分四桶（未快取輸入、輸出、快取讀、快取寫），失敗與中止的呼叫也進帳，token-meter 投影在出貨清單上。全庫沒有單價或金額（#1019 拍板不畫金額，「單價另存」那條路沒實作也沒卡），也沒有跨 thread、跨使用者的彙總。實測（w1，真模型）：產品 model/usage 與供應商 usage 逐筆一致（例：6984 = 未快取 2408 + 快取讀 4576），快取讀進帳；標題模型那次呼叫（153 tokens）不在產品的 token 帳裡（session-title 不經 middleware）；全日誌沒有任何金額／單價欄位。 | packages/nexus-core/src/session-log.ts:567-573；apps/harness/src/live-model.ts:1072-1081；packages/nexus-core/src/token-usage.ts:9-14；apps/harness/cordis.yml:189-190；packages/nexus-wire/src/token-meter.ts:25；apps/web/src/lib/cost-view.ts:61-62 | packages/llm/llm/src/types.ts:171-186（四桶、沒有金額）；packages/llm/token-meter/src/usage-projection.ts:21-25；packages/bundle/base/cordis.patch.yml:348-349、packages/bundle/sdk-minimal/cordis.patch.yml:61-62 | #724、#1022、#1028、#1019（已關）；金額換算／跨會話彙總無卡（新缺口候選） |
| O3 延遲、重試、錯誤分類可聚合；有 health 端點 | 不合格 | 靜態。錯誤分類與重試這半補齊了：turn/failed 帶照 dsh LlmFailure 形狀的 code／status，每次重試寫 llm/retry 與 llm/retry-started，token-meter 把一輪拆成模型、工具、等待與殘差。但都是單一會話的折疊，執行期沒有跨 thread 彙總，離線 session-scan 只數工具錯誤碼；ttft 整組不做。serve 只有 /threads 與網頁靜態檔兩個面，/health、/healthz、/metrics 都回 404，監管程式分不出「卡死但 port 還開著」。dsh 也沒有 health／metrics，補上屬偏離理由 2（#1535 已這樣標）。 | packages/nexus-core/src/session-log.ts:458、:670-680；apps/harness/src/live-model.ts:1505、:1471-1484；apps/harness/src/thread-pump.ts:2091；packages/nexus-plugin-token-meter/src/fold.ts:16-23；packages/nexus-core/src/session-stats.ts:26-28；apps/harness/src/eval/session-scan.ts:316-319；apps/harness/src/serve.ts:340-343；apps/harness/src/web-static.ts:88 | packages/llm/llm/src/types.ts:41-51（LlmFailure）；packages/llm/llm-retry/src/types.ts:9；packages/session/session-stats/src/projection.ts:42（ttftMs，只在 web-app）；health 只有 desktop 的 boot readiness（apps/cli/src/profile-boot.ts:43、apps/web/src/main.ts:23、packages/api/gateway/src/client/index.ts:90） | #1535、#1534、#1536、#1490、#1493（OPEN）；#434、#712、#1437（已關）；跨 thread 的重試／延遲分佈彙總無卡（新缺口候選） |
| O4 告警可接外部 | 不合格 | 靜態。執行期沒有任何主動告警出口：沒有 webhook、沒有可抓的指標，遙測 ops 通道只發 shutdown 一種（on-demand 連那筆都不發），agent-error 照 dsh 刻意不送（#435 wontfix）。能被外部看到的只有 stdout／stderr 純文字：不變量違規走 console.error、fail-loud 的固定英文標籤、`[請求] 處理失敗`；沒有等級、沒有 JSON，回合失敗不進伺服器日誌。所以只抓得到「行程死了」，抓不到「一直在失敗」。dsh 也沒有告警。 | packages/nexus-core/src/session-telemetry-coordinator.ts:205-208、:112-116；apps/harness/src/serve.ts:895-896、:1169；apps/harness/src/fail-loud.ts:6-8；packages/nexus-plugin-telemetry-otel/src/index.ts:97-105 | packages/session/session-telemetry/src/coordinator.ts:220-234（agent-error 只在 live capture）；packages/session/session-telemetry-otel/src/index.ts:219-220（出廠後端 on-demand）；packages/boot/app-boot/src/index.ts:792-933（installFailLoud，687f282e 核過） | #1534、#1535、#1536、#1493（OPEN）；#435、#1501（已關）；主動推送無卡（可能刻意不做，交 demian） |
| O5 trace／日誌敏感資料遮罩 | 部分 | key 這半在設計上有擋：會話 header 的設定雜湊帶鍵、tracing 披露不印 key、請求快照不取憑證；實測（p09）：掃 337 個探針產出檔，假 key 0 命中。使用者內容這半在任何出口都沒有遮罩：唯一的 regex 遮罩只用在離線評測結果檔；打的字、回覆、工具參數、讀到的檔原樣進本機 jsonl（靠 0700／0600）；遙測脫敏有掛點但出貨零條規則；plugin-journal 刻意存明文前後值。dsh 同樣出廠零條脫敏規則；dsh 多一格是 settings 遠端讀一律 redactSecrets。 | packages/nexus-core/src/registry.ts:1634；packages/nexus-core/src/session-telemetry.ts:175-187；packages/nexus-core/src/session-log.ts:1118-1120；docs/operations.md:78-81；apps/harness/src/session-header-metadata.ts:18-20；apps/harness/src/plugin-journal.ts:33；apps/harness/src/tracing.ts:17、:114；apps/harness/src/eval/result-file.ts:196-203；packages/nexus-core/src/request-snapshot.ts:181-223 | packages/extensions/tool-cordis/src/api-catalog.ts:4429（record waterfall「ships NO rules of its own」）；packages/api/settings-controller/src/index.ts:71、:103 | #1541、#1540、#1507、#1551、#1428（OPEN）；出貨預設脫敏規則無卡（新缺口候選） |

dsh 架構對齊翻判（O）

| 列號 | 09-26 判定 → 現在 | 依據 |
|---|---|---|
| O-04 模型失敗分類碼進日誌（含重試進日誌） | 缺口 → 完成 | packages/nexus-core/src/session-log.ts:458、:670-686、:693-701；apps/harness/src/live-model.ts:1505；寫入點 apps/harness/src/thread-pump.ts:2091、:2903、apps/harness/src/background-subagents.ts:1225、apps/harness/src/cli.ts:564；dsh packages/llm/llm/src/types.ts:41-51、packages/llm/llm-retry/src/types.ts:9-11；留下的差距：LlmFailure 少 requestId（dsh types.ts:51）→ #1536；turn/failed 獨立事件已登記偏離（session-log.ts:453-456） |
| O-06 token 用量（含快取讀寫） | 部分 → 完成 | packages/nexus-core/src/session-log.ts:567-573；packages/nexus-core/src/token-usage.ts:9-14；apps/harness/cordis.yml:189-190；dsh packages/llm/llm/src/types.ts:186、packages/bundle/base/cordis.patch.yml:348-349；#724、#1022、#1028／#1433 |
| O-13 日誌格式版本與舊格式（含逐顆 ignorable） | 部分 → 完成（口徑待主線定） | packages/nexus-core/src/session-store.ts:585（格式 48）、:337-339（ignorable，#507）；仍缺 dsh 那種凍結的解碼器鏈，已開 #1529。wp1-O 註明：若「遷移鏈」也算在這列，維持「部分」並以 #1529 追蹤 |
| O-17 組裝設定可查 | 待拍板 → 完成 | commit cd6c1cf9（--dump-default-config，#819）、d21bf6de（--dump-config-schema，#818）；#716、#740、#741；apps/harness/src/config-schema-dump.ts、apps/harness/src/dump-default-config.test.ts |
| O-18 plugin 自帶日誌事件種類 | 判過不做 → 完成 | packages/nexus-core/src/session-log.ts:338（SessionEventMap 可宣告合併，非測試碼 8 個檔宣告）；dsh packages/core/session/src/types.ts:282（687f282e；09-26 引的是 477b4f4 的 :276）；#679、PR #1063 |

### V 驗證與評估

| 判準 | 生產級判定 | 依據（2–4 句，含實測結果） | 證據（我方 檔:行） | dsh 做法（檔:行） | 相關卡 |
|---|---|---|---|---|---|
| V1 離線題庫 | 部分 | 靜態。題庫比 09-26 硬：有「這題成功」判準、平凡地板、題目單位的區間、結果落檔帶版本，CI 用腳本模型跑。但主題庫只有 7 題，全是 echo＋檔案讀寫／grep 這類通用工具題，組裝只掛 echo，跟企業內部業務任務（MCP 查業務系統、照出處回答、反問）對不上；業務那一塊只有出處量測，要真 key、手動跑、不進 CI。風險：改了 MCP 提示段或 persona 讓模型開始編出處，題庫與 CI 都不會紅。 | apps/harness/src/eval/dataset.ts:76、:78-166（7 題）；apps/harness/src/eval/assembly.ts:16-17；apps/harness/src/eval/floor.ts:2；apps/harness/src/eval/citation/citation-cli.ts:16；apps/harness/package.json:14 | dsh 也沒有任務題庫：BENCHMARK.md:3 只一句「照 Python SDK 指南跑」；benchmarks/ 是效能路徑 | #1000、#1329、#1319、#1345（已關）；業務任務題庫無卡（新缺口候選） |
| V2 就緒檢查 | 部分 | 靜態。CI 側補齊：smoke.yml 照 dsh 加「缺 NVIDIA_API_KEY 就 exit 1」的預檢；產品側 serve --live 在組裝當下檢查 key 在不在。缺部署側的模型就緒：serve 起動不探測端點通不通、模型支不支援 tools，也沒有 /readyz；模型盤點清單停在 2026-08-29，還列著已下架的 gpt-oss-120b。風險：端點掛了 serve 照常起來，第一位使用者要等首事件逾時 180 秒加重試才看到失敗。 | .github/workflows/smoke.yml:47-55；apps/harness/src/live-model.ts:1213、:1216、:135；apps/harness/src/eval/survey.ts:86、:109、:52 | .github/workflows/e2e.yml:88-104（Preflight，缺 key 就 exit 1）；產品路徑沒有模型就緒探測 | #436、#165（已關）；#1535（OPEN） |
| V3 受控執行與軌跡擷取 | 合格 | 靜態。兩條受控執行都在：eval 同一個 runner 換 model 參數跑同一份題庫，軌跡從 result.messages 讀、不接會話日誌（登記過、有絆索測試）；冒煙跑的是產品組裝（真 runServe --live），軌跡就是落盤的會話日誌，出口另有計數代理對帳，對不上就紅。保留：eval runner 走 createNexusAgent＋只掛 echo，不是出貨組裝。 | apps/harness/src/eval/runner.ts:3-6、:13-16；apps/harness/src/eval/session-absence.test.ts:24；apps/harness/src/smoke/serve-smoke.smoke.ts:249-306、:81-95；apps/harness/src/eval/citation/citation-cli.ts:10-14；apps/harness/vitest.smoke.config.ts:6、:13 | package.json:64（test:e2e）；docs/testing.md:35（斷言要外部重跑或重讀檔案）；.e2e.ts 320 個 | #436、#174（已關） |
| V4 判斷與失敗歸因 | 合格 | 靜態；限評估管線，產品路徑上沒有自動結果檢查，列殘餘風險。逐題 success 判準要可判的欄全 1 且多叫次數不超過宣告值，平凡地板擋寬鬆判準，失敗原因分 rejected／throttled／timeout 且不算零分；冒煙用外部重讀檔案判成功，另跑事先寫好的過程違反清單。產品路徑的失敗歸因落在 turn/failed 帶的 LlmFailure（屬 L2／O3）；模型答錯但流程乾淨時，只有使用者按踩才留得下訊號。 | apps/harness/src/eval/scorers.ts:142-160、:144-151；apps/harness/src/eval/compare.ts:38-39、:39-60；apps/harness/src/smoke/violations.ts:4、:7；packages/nexus-core/src/session-log.ts:458；.github/workflows/ci.yml:286-295、:33-34 | docs/testing.md:35；dsh 也沒有 LLM 評審（grep 只中 WebUpgradeRoute 子字串：packages/api/gateway/src/index.ts:17、packages/host/webserver/src/index.ts:56） | #1001（已關）；#1606（OPEN） |
| V5★ 持續回歸（CI 每晚真模型） | 合格 | 靜態＋CI 執行紀錄。smoke.yml 每晚 18:17 UTC 排程＋手動＋push main，缺 key 硬失敗，最多 20 個請求、30 分鐘上限，跑真 runServe --live、外部重讀檔案判成功。紀錄：gh run list 共 9 筆（10-09 手動 1 筆＋10-09 到 10-16 每晚 8 筆）全 success，步驟摘要皆「轉出 10/20、對帳 10 筆、外部檢查成功 3 件、過程違反 0 件」。條件：只有 3 個行為案例；打的是 NVIDIA 雲端預設模型 nemotron-3-super，不是客戶內網那顆；失敗通知只到一人、沒接告警；不在 PR 上跑（dsh 寫好的收斂退法），也從沒在 main 上跑過。 | .github/workflows/smoke.yml:17-23、:16、:6-8；apps/harness/src/smoke/serve-smoke.smoke.ts:68-69；apps/harness/src/live-model.ts:107 | .github/workflows/e2e.yml:30-37（含 pull_request、每晚）、:92-104、:127；.agents/notes/implemented/testing/2026-06-19-real-api-e2e-ci.md:74（拿掉 pull_request 的收斂退法） | #436（已關）；#1546、#1535（OPEN） |
| V6 執行期不變量自檢 | 部分 | 靜態。出貨清單預設掛 8 個真的在檢查的不變量配套入口，CLI 與 serve 都跑；違規走 console.error（serve 就是伺服器日誌），另記一份 invariant-log.jsonl。但它只觀察、不擋、不告警，落盤關掉時連計數檔都不寫，檢的是事件結構關係不是回覆對不對；要不要留（第二刀）未拍板，提議 2026-11-03 重審。dsh 已把整套執行期不變量拿掉（invariant.ts 477b4f4：38 → 687f282e：0）。 | apps/harness/cordis.yml:786-801、:755-759；packages/nexus-core/src/invariants.ts:245-248、:50；apps/harness/src/serve.ts:649-650、:659；docs/operations.md:203；.docs/invariant-companions-decision-2026-10-03.md:3、:144、:12 | dsh f028f25667d「remove runtime invariant plugins」；讀盤驗證歸 session 那側（packages/core/session/src/surface.ts:154-220，經 #1549 引）；AGENTS.md:175 指的是 CI gate | #976、#974（已關）；#1597、#1549、#1535（OPEN） |

dsh 架構對齊翻判（V）

| 列號 | 09-26 判定 → 現在 | 依據 |
|---|---|---|
| V-02 就緒檢查 | 部分 → 完成（就 dsh 對齊而言） | dsh 的就緒檢查只有 CI 預檢（.github/workflows/e2e.yml:88-104），我們已有同形狀的預檢（.github/workflows/smoke.yml:45-56）；#1264。過期盤點清單（apps/harness/src/eval/survey.ts:86、:109）是我們多出來的，不計入對齊分 |
| V-06 持續回歸：真模型、定期 | 缺口 → 完成 | #1264（52db389d）；.github/workflows/smoke.yml:17-23；少了 pull_request 觸發屬 dsh 文件寫好的退法（.agents/notes/implemented/testing/2026-06-19-real-api-e2e-ci.md:74），理由是額度（smoke.yml:6-8），建議照原話登記、不另歸類；9 筆全綠 |
| 新列：執行期不變量自檢 | （09-26 V 層無此列，原在 O-09）→ 部分（偏離待拍板） | 我們保留 8 個、預設掛在 CLI 與 serve（apps/harness/cordis.yml:786-801）；dsh 由「只在 sdk-minimal 出廠」變成整套移除（f028f25667d）；偏離理由兩種都還沒登記，決策紀錄 .docs/invariant-companions-decision-2026-10-03.md:3、:144 |

### G 治理與安全

| 判準 | 生產級判定 | 依據（2–4 句，含實測結果） | 證據（我方 檔:行） | dsh 做法（檔:行） | 相關卡 |
|---|---|---|---|---|---|
| G1★ 具名權限預設 | 合格 | 靜態。出廠 read-only／workspace-write（配 ask）、danger-full-access（配 never），名字與值逐字照 dsh；/permission 是唯一切換入口，web 權限座選「全開」要先確認。沒給 --workspace 時整顆不掛（虛擬檔案系統，子情境 N/A，偏離 4 已登記）。殘餘風險歸 G9：拿到 cookie 的人都能切到 danger-full-access。 | packages/nexus-plugin-permission-presets/src/presets.ts:37-56；packages/nexus-plugin-permission-presets/src/index.ts:26-28；apps/harness/cordis.yml:748；apps/web/src/components/permission-seat.tsx:29；docs/operations.md:68-71 | packages/bundle/base/cordis.patch.yml:259-276 | #437（已關）、#1428（OPEN） |
| G2 工具呼叫前後可攔截 | 合格 | 靜態。#1253 在 core 補上 dsh 的工具四事件（pre-execute／execute／post-execute／result），樹上另有 tools.gate() 與結果觀察者，部署方用 patch 或插件就能擋、改寫、記錄。差 dsh 一格：沒有 tools.guard() 單調守衛，先登記的 gate listener 不呼叫 next() 就能短路後面的閘門；#198 判過「不做那一層、做絆索」。今天出貨的 listener 只有 submit_record 一位，所以是潛在風險。 | packages/nexus-core/src/tool-pipeline.ts:137、:162、:36-53；packages/nexus-tools/src/index.ts:166；apps/harness/src/plugin-config.ts:897；apps/harness/cordis.yml:34-35 | packages/core/tools/src/index.ts:154、:165、:177、:199（四事件）、:1134-1148（guard）；hooks 套件只是 apps/cli/package.json:115-116 的相依，沒掛進 bundle | #1248（已關）、#198（已關） |
| G3 工具輸出的提示注入防護 | 不合格 | 靜態；非致命，dsh 也沒有。只有跨會話 @ 引用一個面有防護，快照逐字照 dsh 包成 untrusted、read-only 並附警告；網頁工具出廠不掛，所以 dsh 的網頁前綴是 N/A。MCP 結果與讀檔內容不加任何不可信標記，也沒有過濾或偵測；產品定位是內部資料全走 MCP，被植入指令的文件可驅使模型呼叫有寫入副作用的 MCP 工具（不經核准，見 G7）或讀 .env。擋得住的只有 submit_record 與沙箱升級兩道核准。 | apps/harness/src/session-reference.ts:48-56；packages/nexus-plugin-mcp/src/project-content.ts:24-31 | packages/context/session-reference/src/index.ts:59；packages/web/tool-web/src/trust.ts:7；MCP 與 fs 不加標記（packages/mcp/mcp-client/src/tools.ts:316 只是開發者註解） | #949、#1291（已關）；MCP／檔案內容注入防護無卡（新缺口候選） |
| G4 政策層的系統提示 | 合格 | 靜態；有一格對齊差異（見最後一句）。身分與 persona 由必掛的 system-prompt 列講，部署方可把公司政策寫進 personaPrefix／personaSuffix、嚴格插值；檔案政策句永遠由 sandbox-policy 列講，沒有 --workspace 也講（#1172）；計劃模式規則、MCP hub 段「只講結果裡有的事實」都在。差異：dsh 把目前的核准政策句（ASK／NEVER_SENTENCE）放進系統提示詞，我方只在被拒時從拒絕文字告訴模型，切到 never 後模型要先撞一次牆。 | apps/harness/cordis.yml:210-215、:723；packages/nexus-plugin-sandbox-policy/src/sandbox-escalation.ts:174-198（政策只出現在拒絕文字） | packages/bundle/base/cordis.patch.yml:504、:243、:332；packages/interaction/user-approval/src/index.ts:72-75、:161-173 | #720、#1477（已關）；核准政策句無卡（新缺口候選） |
| G5 稽核 | 已拍板未落地 | 靜態。決議 §七定了稽核範圍（寫入動作、管理員讀對話、登入登出，加事件鏈與對話鏈雜湊、每日錨點），排在 2026-11-21 之後動工。程式碼現況是資料層一半：plugin-journal 記插拔與改設定、操作者是自報的 SUDO_USER／LOGNAME；會話日誌有 approval/asked／decided／policy；沒有雜湊鏈、沒有可信身分。這是確認，不是新缺口。 | .docs/decisions-2026-10-14-enterprise.md:53-62；apps/harness/src/plugin-change.ts:144-152；packages/nexus-core/src/session-log.ts:495、:512 | dsh 沒有登入、角色或稽核；核准事件見 packages/interaction/user-approval/src/index.ts:232 | #1428（OPEN）、#1029、#220（已關） |
| G6 子代理權限收斂 | 部分 | 靜態。委派時的收斂合格：沙箱模式在委派當下拍下 root 那一格、不給一次性 grant，子代理請升級回 delegated 拒絕；背景子代理換 policy-never 閘門確定性回絕，前景子代理跟 root 的政策把核准交給人（#1266，產品需求、已登記）；子代理不能再派子代理。破口在 #1544：拿子代理會話 id 當 thread_id 送 run.start，serve 會用 root 的組裝驅動它，委派時釘下的權限就此失效（卡上寫探針證實，本次只靜態查了路由層沒有拒絕）。另有過期註解：approval-policy.ts 仍寫子代理一律 policy-never。 | apps/harness/src/agent-factory.ts:873、:888-889；packages/nexus-plugin-sandbox-policy/src/sandbox-escalation.ts:193；apps/harness/src/wire-handler.ts:377；packages/nexus-core/src/approval-policy.ts:31-34 | packages/subagent/subagent/src/child-agent.ts:249-253、:273-277 | #328、#707（已關）、#324；#1544（OPEN） |
| G7★ 高風險工具要人核准且繞不過 | 不合格 | 實測：p07 submit_record 觸發 interrupt/raised＋approval/asked、工具沒執行，待核准時再送一句話只進 inbox、不放行；w5 真模型在 web 出現「等待核准」面板，核准前工作區沒有檔，按核准後才寫出 /records.csv。閘門機制本身繞不過（政策只有 ask／never、never 確定性回絕、只有 approve 才執行）。判不合格是因為判準明列 MCP 工具：MCP 工具沒有閘門，設定也沒有 requireApproval，部署方只能自己寫 gate listener；只接唯讀 MCP 工具的部署才退回「部分」。核准掛著時 serve 重啟會怎樣沒有實跑。 | packages/nexus-core/src/approval-policy.ts:41；packages/nexus-plugin-submit-record/src/index.ts:272-275；packages/nexus-plugin-mcp/src/index.ts:185、:220-233；packages/nexus-core/src/approval.ts:424、:452 | packages/interaction/user-approval/src/index.ts:270-275；dsh 的 MCP 也沒有核准（grep exit 1）；packages/subagent/subagent/src/child-agent.ts:253 | #111、#517、#1183、#1266、#1241、#654（已關）、#1428（OPEN）；MCP 工具可設定需核准無卡（新缺口候選） |
| G8★ key 不進上下文、日誌、子行程環境 | 不合格 | 實測：p09 掃 337 個探針產出檔（日誌、header、serve.log、home、工作區、閘道帳），假 key 0 命中，主路徑合格。p09 沒有測下面三個破口：(a) key 夾換行時 openai SDK 的 TypeError 帶出整把 key 進日誌與網頁（#1541）；(b) build-version.ts 起 git 沒帶 env，key 放 .env 時會被 launch-env 寫進 process.env、再交給 git 子行程（靜態查實，實際風險低，但字面違反★判準）；(c) 讀取面幾乎沒有圍堵，.env 在工作區底下或有指向 home 的 symlink 時 read_file 讀得到 key（dsh 同樣不擋）。 | apps/harness/src/live-model.ts:1228-1229；packages/nexus-core/src/child-env.ts:35；packages/nexus-plugin-mcp/src/index.ts:547；apps/harness/src/build-version.ts:26-29、:65；apps/harness/src/launch-env.ts:8、:202、:213；apps/harness/src/serve.ts:472、:790；apps/harness/src/session-header-metadata.ts:165；apps/harness/src/cli.ts:1152；docs/operations.md:52-58、:338-344 | packages/subprocess/subprocess/src/index.ts:47、:66（所有 spawner 都走這裡）；packages/mcp/mcp-client/src/transport.ts:22；packages/bundle/base/cordis.patch.yml:125 | #1541、#1540、#1507、#1604（OPEN）；#730、#726、#746、#1291（已關）；(b)(c) 無卡（新缺口候選） |
| G9 身分與角色 | 已拍板未落地 | 靜態。決議 §三～§六已拍板（自管帳號、三種角色、scrypt、5 次失敗鎖 15 分鐘、閒置 30 分鐘登出、登入最長 12 小時、thread 按人隔離），2026-11-21 之後動工。今天仍是一個 serve 一顆 token、換到的 cookie 是同一個匿名身分：拿到 cookie 的人看得到全部 thread、能切 danger-full-access、能按任何核准，cookie 有效 30 天。偏離屬理由 2（產品需求超出 dsh 射程）。 | apps/harness/src/wire-handler.ts:2668、:3238；.docs/decisions-2026-10-14-enterprise.md:47、:23 | dsh 沒有身分與角色，只有每個安裝一個匿名 id | #1428（OPEN）、#1429（已關） |
| G10★ 多人共用主機下瀏覽器會話要有認證 | 合格 | 實測：p08 不帶認證 GET / → 401；/threads、history、POST run.start、feed 都 401；錯 Origin＋假 cookie → 403；只綁 127.0.0.1。靜態：圍欄（403）與簽章 cookie（401）都在任何路徑判斷之前；靜態資源只有 index 要認證，其餘公開，照 dsh；token 32 bytes、不落盤、不在 argv，cookie HttpOnly＋SameSite=Strict。殘餘風險：token 只印在 serve 的 stdout，讀得到那份日誌的人就能登入；所有人共用一個身分（歸 G9）。 | apps/harness/src/wire-handler.ts:3327-3336；apps/harness/src/serve.ts:341、:1165-1170；apps/harness/src/web-static.ts:69-83；apps/harness/src/wire-server.ts:133、:188、:204；apps/harness/src/browser-auth.ts:114 | packages/client/connection/src/rpc-host.ts:123、:193；packages/client/connection/src/browser-auth.ts:263；packages/client/connection/src/index.ts:115；packages/bundle/web-app/cordis.patch.yml:234 | #424、#387、#529（已關）；#1428（OPEN） |

dsh 架構對齊翻判（G）

| 列號 | 09-26 判定 → 現在 | 依據 |
|---|---|---|
| G-02 外部內容標成「資料不是指令」 | 判過不做 → 部分 | 跨會話 @ 引用在 #782（532af629）落地，警告逐字照 dsh（apps/harness/src/session-reference.ts:48-56 對 dsh packages/context/session-reference/src/index.ts:59）；網頁那半仍不掛，dsh packages/web/tool-web/src/trust.ts:7 沒有對應物 |
| G-05 具名權限預設 | 缺口 → 完成 | #1196（cb1aa059）、#1183（4be6043b）、#1186；三組值逐字照 dsh base cordis.patch.yml:264-276（packages/nexus-plugin-permission-presets/src/presets.ts:37-56）；偏離 1–5 登記在 packages/nexus-plugin-permission-presets/src/index.ts:19-29 |
| G-09 憑證儲存 | 待拍板 → 部分 | #730 已關（#790 兩層 .env、#791 受管檔每次請求前解析，apps/harness/src/live-model.ts:1228）；差在優先序：我方啟動環境優先（apps/harness/src/credentials.ts:2），dsh 687f282e 已改成受管檔優先（packages/credentials/credentials-local/src/index.ts:2-9），對應 #1540 |
| G-10 子行程環境清洗 | 部分 → 完成（限 09-26 的射程：MCP stdio 與 git 快照） | #726／#770（packages/nexus-plugin-mcp/src/index.ts:547、packages/nexus-core/src/child-env.ts:35-64）；#746／#802 代理層照 dsh packages/subprocess/subprocess/src/index.ts:66、:71-78。射程外新發現 build-version 沒清洗，見 G8(b) |
| G-13 核准審計事件 | 判過不做 → 完成 | #1081（d1a0bb82，Closes #1029）翻了 #220；packages/nexus-core/src/session-log.ts:495、:512、packages/nexus-core/src/approval.ts:304 |
| G-15 人工監督 | 部分 → 完成 | #654 已關：計劃評審改走提問通道（packages/nexus-plugin-plan-mode/src/index.ts:40-52），對應 dsh ui-plan（packages/bundle/web-app/cordis.patch.yml:451）；#1277 拿掉閘門前的模式外拒絕 |
| G-17 互動式憑證取得 | 待拍板 → 判過不做（暫緩） | #717 最後一則拍板留言：這次不掛、之後併進 #1428 的帳號制；MCP elicitation url 模式一律回絕（apps/harness/src/mcp-elicitation.ts:27-28） |
| 新列：工具四事件與單調守衛 | （09-26 無此列）→ 完成（四事件）＋判過不做（guard） | #1253（packages/nexus-core/src/tool-pipeline.ts:137、:162，偏離登記 :36-53）；dsh guard 在 packages/core/tools/src/index.ts:1134-1148，#198 判過不做 |

G-04 仍是「完成」，但語意有變：前景子代理改成交給人（#1266，理由 2，packages/nexus-plugin-permission-presets/src/index.ts:16-17），而且新登記一格對齊差異（沒有核准政策句，見 G4）。

### dsh 架構對齊五項

計分詞沿用 09-26。③、⑤ 拆成 a／b 子項分別判；主線若要把 ③、⑤ 各算一列，請自行合併。本尺 7 子項：完成 0、部分 5、已拍板未落地 1、判過不做 1，得分 (0.5×5)÷6＝41.7%。

| 項 | 判定 | 依據 | 證據（我方 檔:行） | dsh 做法（檔:行） | 相關卡 |
|---|---|---|---|---|---|
| A① 每項能力是 Cordis plugin，出廠清單對齊 dsh base／preset | 部分 | Cordis 已是根，但樹上的函式插件只有 12 顆（21 顆 nexus-plugin-* 中的 12 顆），另有 9 列宿主內建接縫列。其餘仍在相容層：出貨清單 49 列裡有 3 顆 NexusPlugin（plan-mode、sandbox-policy、permission-presets）、8 列 @nexus/core/*、18 列 #settings/*、8 列 invariant；serve 層的 workspace-changes 也在相容層。agent loop 本身是 LangChain createAgent，不是樹上的一列。組裝點另外寫死 host-services、file-reference、model-selection 三顆，不在清單上。 | apps/harness/src/migrated-plugin-gate.test.ts:35-49；apps/harness/src/cordis-root.ts:12、:22-23、:39-41；packages/nexus-core/src/agent-assembly.ts:58、:255；apps/harness/src/assembly-root.ts:882、:909-910；apps/harness/cordis.yml:82-83、:735-736、:750-751、:244-354、:786-800；apps/harness/cordis.serve.yml:17-18；apps/harness/src/plugin-config.ts:765-767 | packages/bundle/base/cordis.patch.yml:15-528（一個 insert 約 95 列，例：:34 llm、:499 tools、:504 system-prompt、:511 agent-loop），沒有相容層 | #1385、#1491、#1494、#1339（OPEN）；已結遷移卡 #1416–#1486 |
| A② 生命週期：apply、dispose、收尾順序 | 部分 | 樹上這一半照 dsh：副作用全走 ctx.effect；相容層組出的 agent 綁一筆 ctx.effect，根卸載時收掉；serve 收尾每步各自接住，單一錯誤原樣拋、多個 AggregateError；thread 收尾先等背景 host 收完才撤登記（#1482）。相容層的插件仍走 registry.lifecycle.onDispose，不是 fiber。決議 §3-4 第 11 條要的「apply／dispose 收 AbortSignal 與時限」沒有落地，dsh 也沒有，所以不扣 dsh 尺的分，但記為我方已拍板未落地。 | apps/harness/src/cordis-root.ts:150、:29-32、:227-247；packages/nexus-tools/src/provider.ts:76、:99、:112；apps/harness/src/serve.ts:1238-1260、:484、:495-503；apps/harness/src/agent-factory.ts:1127；packages/nexus-plugin-workspace-changes/src/index.ts:293；packages/nexus-plugin-mcp/src/index.ts:304、:308；.docs/decisions-2026-10-11.md:55 | packages/core/agent-loop/src/index.ts:603-622；apps/cli/src/profile-boot.ts:282-289；packages/boot/app-boot/src/index.ts:1207-1240 | #1482、#1511、#1501、#1484、#1424（已關）；#1385（OPEN）；時限無卡 |
| A③a 停用／啟用／改設定，下一條 thread 生效 | 部分 | serve 每條 thread 組裝時重讀清單（#1405），清單由 append-only 變更紀錄導出（#1412），樹上列組 thread 時取快照，所以 next-thread 類的列改了不必重啟、開著的 thread 不變。這比 dsh 嚴（dsh 重組時就地重掛），偏離已登記為理由 2。但 14 列 startup-read（瀏覽器會話、會話落盤、live-model、背景子代理、thread 上限等）改了要重啟；dsh web-app 有 HMR，設定改動一律即時生效，要重啟的只有程式碼層的原因。 | apps/harness/src/thread-plugin-list.ts:2、:6-11；apps/harness/src/plugin-row-classes.ts:11-13、:69-84；apps/harness/src/plugin-tree.ts:28-30；docs/plugin-contract.md:398-399；.docs/decisions-2026-10-11.md:65、:92 | packages/bundle/base/cordis.patch.yml:26-31（hmr，依 profileContext）；apps/cli/src/profile-boot.ts:325；headless／acp-app／sdk-app 停 hmr（packages/bundle/headless/cordis.patch.yml:32-33）；packages/boot/hmr/README.zh.md:12、:27；docs/subsystems/boot.zh.md:35-45、:49-57 | #1405、#1406、#1412、#1414、#1423、#1424、#1426、#1442（已關）；14 列要重啟無卡 |
| A③b 換程式碼版本不重啟、舊對話留舊版 | 已拍板未落地 | 決議 §3-2 第 6 條拍板「每一版新 entry id＋isolate realm、版本路由插件、引用計數排水」；第一刀 #1442 只做到快照列出活著的設定版本與 thread。第二刀（版本路由插件）與第三刀（workspace-changes 上樹）等 #1429 的安裝流程，沒有卡。今天換程式碼要重啟，manifest `code: 'coexist'` 載入時拒收；「不 vendor HMR」等於判過不做 dsh 的就地換碼。計「已拍板未落地」，因為判準字面含「只給新對話」，而 dsh web-app 的 agent-preset-registry 有對等的代際引用計數。 | apps/harness/src/thread-plugin-list.ts:7；docs/plugin-contract.md:90、:297；.docs/decisions-2026-10-11.md:44、:34；apps/harness/src/plugin-live-versions.ts:27-39；vendor/sync.mjs:77-78 | packages/boot/hmr/README.zh.md:49、:67-69（有 HMR 時就地換碼）；packages/boot/plugin-manager/README.zh.md:141；packages/preset/agent-preset-registry/src/index.ts:31-36、:93-95、:148-151（代際引用計數，只在 web-app） | #1385（OPEN）；#1431、#1442、#1136、#1429（已關） |
| A④ 服務注入與接縫 | 部分 | 注入機制照 dsh 而且更嚴：帶型別 token＋inject 宣告，沒宣告就讀 Cordis 會拋錯（兩邊 vendor 同一句），選配走 optionalService，契約以 semver check 檢查；9 個宿主內建接縫加 3 個「插件提供、宿主消費」的服務，偏離全登記在 plugin-contract.md 偏離表。給部分是因為接縫只長到已遷 12 顆需要的：沒有插件消費另一顆插件的服務（dsh 的 tool-fs 要 fs、systemPrompt、workingDirectory）；樹上沒有事件匯流排；plan-mode、sandbox-policy、permission-presets 需要的接縫未開；llm、agents、sessions 等核心服務沒有樹上的提供者。 | packages/nexus-sdk/src/token.ts:60-65、:70；vendor/cordis/src/reflect.ts:76；apps/harness/src/plugin-tree.ts:8-17、:125-140；apps/harness/cordis.yml:30-31；docs/plugin-contract.md:471-523（:475、:476、:496、:499、:501、:502、:506-510）；packages/nexus-plugin-goal/src/index.ts:267-271；packages/nexus-plugin-present/src/index.ts:440-444 | vendor/cordis/src/reflect.ts:144；packages/AGENTS.md:6；packages/fs/tool-fs/src/index.ts:23；packages/deliverables/tool-present/src/index.ts:27；packages/context/agent-instructions/src/index.ts:36；packages/core/tools/src/index.ts:154 | #1385、#1491、#1339（OPEN）；已結 #1416–#1486 |
| A⑤a 按入口分的出貨組合（base＋模式 bundle） | 部分 | 缺的那半已判過不做，所以維持部分。兩層出貨檔：cordis.yml 是 CLI 與 serve 共用的底（對 base），cordis.serve.yml 只有 serve 載、疊在其後（對 web-app），再疊 home 變更紀錄與 --patch，層序與 dsh 同形。差別是 serve 層只能追加列；CLI 沒有自己的一層；disabled 不收 `!!js`，做不到 dsh 依 profileContext 開關一列。這三件都已登記判過不做（#46 Out of scope、#104）。acp-app、sdk-app、sdk-minimal 三個模式 09-26 已判 T-14 判過不做。 | apps/harness/cordis.serve.yml:3、:5-6；apps/harness/cordis.yml:4-8、:18-19；docs/plugin-contract.md:582-584 | packages/bundle/base/cordis.patch.yml:15、:22、:30；packages/bundle/web-app/cordis.patch.yml:17-32、:44、:477-579、:585；packages/bundle/headless/cordis.patch.yml:9-17、:32-43；packages/bundle/sdk-minimal/cordis.patch.yml:1-2 | #46、#454、#455、#669（已關）；#104 |
| A⑤b 每個會話選 agent preset | 判過不做 | 09-26 T-29 已判；2026-10-10 demian 決定 #714（Creator）、#718（PTC）、#739（逐會話選組合）都不做，理由是產品定位（#949）。只剩 standard，就不需要逐會話選組合，出貨清單對應 standard 那一份。重開條件照 09-26：決策 3 重開、產品定位改變、或實測來回模型成本是瓶頸（只影響 PTC）。 | .docs/seven-layer-inventory-2026-09-26.md:140-148、:328 | packages/bundle/web-app/cordis.patch.yml:586-587；packages/bundle/web-app/presets/standard.patch.yml:5；packages/preset/agent-preset-registry/README.zh.md:56；headless 不組它（packages/bundle/headless/src/index.ts:196） | #739、#714、#718、#949（已關） |

附帶更正（交主線）：決議 §五第 2 列（.docs/decisions-2026-10-11.md:90）寫 dsh「出貨不做模組熱換，換已有的包要重啟」。這句在 687f282e 只在沒有 HMR 時成立：base 在有 profileContext 時開 HMR（packages/bundle/base/cordis.patch.yml:28-30），HMR 會就地換碼（packages/boot/hmr/README.zh.md:49）。偏離本身仍成立，只是對 dsh 的描述要改成「dsh 就地換、不保舊對話」。另，apps/harness/src/plugin-live-versions.ts:22「今天只有 serve 關機才拆」在 #1484 之後已過期（apps/harness/src/thread-plugin-list.ts:199 起有逐條放掉的路），只是註解。

出廠差集（精簡版，25 列）：dsh 687f282e 出廠列對 nexus cff3f832。判定欄是本次各層翻判之後的現況；ui-* 只列不判，不放進來。完整版見 wp1-dsh-arch.txt。

| dsh 列（profile:行） | nexus 載體 | 現況判定 |
|---|---|---|
| agent、agent-loop（base:82、:511） | 相容：nexus-compat（apps/harness/src/cordis-root.ts:12）＋LangChain createAgent（packages/nexus-core/src/agent-assembly.ts:255） | L-01 完成；載體未上樹（#1385 終點第 4 條，loop 第二段在 #1339） |
| llm、llm-retry、agent-default-model（base:34、:99、:90） | 相容：#settings/live-model、#settings/agent-default-model（apps/harness/cordis.yml:576、:661） | L-03 完成、L-26 完成（本次翻判）；載體未上樹 |
| session、session-persistence-jsonl、session-projection（base:40、:138、:172） | 相容：@nexus/core/session-persistence（apps/harness/cordis.yml:353-354）；投影登記處在樹上 | 完成；會話本身未上樹 |
| session-title、session-title-llm（base:60、:67） | 相容：apps/harness/cordis.yml:396、:412 | T-20 完成（本次翻判） |
| sandbox-policy、fs-sandbox（base:243、:518） | 相容：@nexus/plugin-sandbox-policy（apps/harness/cordis.yml:735）＋寫死的 ContainedFilesystemBackend（apps/harness/src/assembly-root.ts:76） | E-01～E-04 完成；未上樹（宿主 import） |
| approval、permission（base:259、:264） | 相容：apps/harness/cordis.yml:330、:750（必掛） | G-04 完成、G-05 完成（本次翻判）；permission-presets 上樹是 #1491 |
| credentials、authorization（base:125、:117） | 寫死：apps/harness/src/credentials.ts（兩層 .env＋受管檔） | G-09 部分（優先序 #1540）、G-17 判過不做（暫緩，併 #1428）（本次翻判） |
| subprocess、sandbox、bash／pwsh、shell-env、tool-bash（base:234、:240、:249-255、:278、:281-285） | 無 | 判過不做（E-07，決策 3） |
| skill、skill-filesystem、tool-skill（base:308-314） | 樹：skills（apps/harness/cordis.yml:66） | T-11 完成（本次翻判，#1446 上樹） |
| goal 一族（base:323-329、:444） | 樹：goal（apps/harness/cordis.yml:97） | L-09 完成（本次翻判，#1486 上樹） |
| plan-mode（base:332） | 相容：@nexus/plugin-plan-mode（apps/harness/cordis.yml:82） | C-10 完成；未上樹（缺 P1–P4 接縫） |
| token-meter（base:348） | 樹（apps/harness/cordis.yml:189） | C-08 部分（本次翻判：缺 contextBreakdown 組成拆分，#1571） |
| compaction-basic、command-compact（base:351、:356） | 相容：@nexus/core/summarization（apps/harness/cordis.yml:270） | C-02 完成、C-03 完成（本次翻判）；/compact 判過不做 |
| tool-subagent-control、tool-subagent-list-agents（base:374-377） | 相容：#settings/background-subagents（apps/harness/cordis.yml:539） | L-13 完成（本次翻判） |
| subagent-model-selection-settings（web-app:66） | 相容：apps/harness/cordis.yml:549 | L-14 完成（本次翻判） |
| spill-local、spill-policy（base:411-414） | 相容：#settings/spill-policy（apps/harness/cordis.yml:513） | C-05 完成（本次翻判） |
| session-checkpoint-policy（base:420） | 相容：apps/harness/cordis.yml:314 | L-08 完成（本次翻判，剩一條登記偏離沒標理由） |
| image-offload（base:434） | 寫死：packages/nexus-core/src/image-offload.ts＋fold | C-07 完成（形狀不同，本次翻判） |
| system-prompt、persona（base:504；presets） | 樹：system-prompt（apps/harness/cordis.yml:210，必掛） | C-16 完成（本次翻判，#1477 上樹） |
| time-context（standard:19、ptc:19、cordis preset:22） | 無 | C-14：09-26「dsh 也沒有」不成立（三個 preset 都掛）；改判缺口或判過不做，兩份 wp1 不一致，待拍板 |
| schedule、tool-schedule（web-app:139；standard:35、ptc:35、cordis preset:38） | 無 | L-18：09-26 的依據（477b4f4 web-app:125 disabled）在 687f282e 不成立；是否改判判過不做，兩份 wp1 不一致，待拍板 |
| session-reference、file-reference-local（web-app:94、:97） | 寫死：apps/harness/src/session-reference.ts；createFileReferencePlugin（apps/harness/src/assembly-root.ts:909） | C-11、C-12 完成（形狀不同，本次翻判） |
| plugin-manager、hmr（base:20、:28） | 寫死：plugin-cli＋變更紀錄（#1412）；HMR 無 | 已登記偏離（.docs/decisions-2026-10-11.md:92，理由 2）；HMR 判過不做（:34） |
| plugin-inventory（web-app:117） | plugin-snapshot.json（#1406）＋--dump-config（apps/harness/cordis.yml:21-23） | O-17 完成（本次翻判） |
| agent-preset-registry＋四個 preset（web-app:586） | 無 | 判過不做（T-29，A⑤b） |

nexus 出貨有、dsh 出廠沒有的列（echo、submit-record、recursion-limit、thread-capacity、browser-session、8 列 invariant 配套等）沿用 wp1-dsh-arch 的 B 表，判定都是「dsh 也沒有」或產品專屬，不計分。其中 invariant 配套的狀態有變：dsh 已整套移除（見 V6 與 V 翻判新列）。

### 核對紀錄

統計：從八份 wp1 檔抽出 1,111 條 `路徑:行` 引用（E-main 21、T 103、C 154、L 92、O 104、V 112、G 143、dsh-arch 382），另手動補核 6 條抽取器漏抓的逗號續號（O 3、V 3），共核 1,117 條。這個數字含跨檔重複，以及抽取器誤掛到別的檔的條目（已逐條手動改指正確的檔再核，不算改正）。結果：改正 4 條，刪除 1 條。PR／卡號不在核對範圍。歷史行號（我方 70357bb、dsh 477b4f4 與 f028f25667d）都用 git show 讀該版本核過。

改正（4 條，正文都已標「(行號已更正)」）：

1. C／C-14：gap-survey「:409 的另一條理由（瀏覽器時區沒有來源，要先擴 wire）」→ .docs/plugin-architecture-gap-survey.md:410。:409 只起頭第 3 條，wire 那句在 :410。
2. C／C-14：gap-survey「:401-403（要查完六個 bundle 加四個 preset 的規矩）」→ .docs/plugin-architecture-gap-survey.md:407。:401-403 是準則第二條與 memory 那段。
3. L／L6：apps/harness/src/fail-loud.ts「:49 FAIL_LOUD_RELEASE_TIMEOUT_MS = 2_000」→ :46。:49 是 installFailLoud 的說明註解。
4. L／L4（dsh 做法）：packages/core/tools/src/index.ts「:1518-1520（已開始的工具等到靜止才換成 ABORTED）」→ 687f282e 上是 :1965-1976（toolAbortedResult）。:1518-1520 是我方 turn-cancel.ts 檔頭對 dsh c291e79 寫的行號，687f282e 上已不在那裡。

刪除（1 條）：

1. dsh-arch／A④（我方證據）：vendor/cordis/src/reflect.ts「:76、:144」裡的 :144。我方那份檔只在 :76 有這句，找不到可以對應的第二處（我方第 144 行是空行；:144 是 dsh vendor 那份的行號）。正文只留 :76；dsh 側的 vendor/cordis/src/reflect.ts:144 成立，照留。

補全路徑（不算改正）：E 的 `index.ts:277-311` 補成 packages/nexus-plugin-permission-presets/src/index.ts。

已知的抽取器缺陷（不影響結論）：逗號接續的行號（例如「:89、:599」）抓不到，已另外 grep 出來手動核；全形冒號會產生假陽性，已人工排除。
