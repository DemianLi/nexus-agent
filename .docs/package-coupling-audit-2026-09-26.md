# packages 介面耦合盤點（2026-09-26）

- **基準**：我們是 develop `70357bb`，dsh 是 `477b4f4`。行號以這兩個 commit 為準。
- **範圍**：`packages/*`，以及它們跟 `apps/harness`、`apps/web` 之間的接縫。切成 8 個叢集：
  - nexus-core 拆成 4 個：plugin 系統、會話、工具側 middleware、模型側 middleware。
  - plugin 分成 2 個：互動類（goal、plan-mode、ask-user、送出佇列）與能力類（present、workspace-changes、sandbox、memory、skills、telemetry、validation）。
  - 另外 2 個是 wire 接縫，以及 harness 的組裝根。
- **詞彙**照 codebase-design：
  - 模組、介面、深度、接縫、adapter、刪除測試。**介面**不只是型別，還包括呼叫者必須知道的不變量、順序、錯誤模式、設定與效能。**深度**看的是槓桿，不看行數。
  - 一個 adapter 的接縫是假想接縫，兩個才是真接縫。
- **技術標準**：每條發現都對照 dsh 在同一處的形狀。建議照 dsh；偏離時寫明 deepagents 或 LangChain 表達不出什麼。
- **追蹤欄**：盤點合併後，同一天（2026-09-26）替中級與低級發現都開了專卡：中級的卡號補在追蹤欄與各條的「既有追蹤」，低級的補在各條的「追蹤」。發現本文仍以基準 `70357bb` 為準。卡是對之後的 develop 重核過再寫的，有幾張的主軸或建議跟本文不同，例如中級的 #664、#667、#668、#670，低級的 #686、#687、#694、#699、#700、#701，動工時以卡為準。
- 這份是七層盤點（[`seven-layer-inventory-2026-09-26.md`](seven-layer-inventory-2026-09-26.md)）的姊妹篇。前一次相關的盤點是 [`srp-audit-2026-09-19.md`](srp-audit-2026-09-19.md)，它量的是單一職責；這次量的是模組之間的介面。

## 結論

**44 條發現**，經過對抗式驗證後：
- 保留 37 條，其中中級 10 條、低級 27 條，**沒有高級**。原判高級的 5 條都被降級：
  - core-session-F1 降為中，已被 #507 追蹤。
  - core-session-F4、wire-seam-r2-04、plugins-interaction-r2-01、r2-04 降為低。理由是 dsh 同形，或今天等價、而且會被測試抓到。
- 已被既有的卡追蹤 4 條。
- 併入別條 3 條。

**五種形狀**：

1. **同一份知識寫了兩次以上**，這是最常見的一種。每一處都靠註解或人記得對齊，漏改其中一處時沒有測試會紅。
   - root 與子代理的 middleware 堆疊手寫兩份（N2，中）。
   - 兩個入口的會話接線（hcr-r2-01，中）與排程觸發點（plugins-interaction-r2-03，中）各寫一份。
   - SessionStore 的檔名與 header 解析有三份（F5，中）；邏輯輪有 7 份實作（F6）。
   - 工具名抄了五處（capability-r2-04）；虛擬路徑規則有三份（capability-r2-05）。
   - GET 路由兩端各寫一份（wire-r2-04）；custom 事件名沒有清單（wire-r2-05）。

   dsh 的解法通常是單一來源。子代理用 `composeFrom` 繼承父代理的同一版組合；列會話走 `SessionPersistence.list`。
2. **只寫在散文裡的前提已經過期**。介面上看不到這些前提，檔頭或註解又說錯了：
   - F5：SessionStore 說「沒有 list」，但 serve 早已在產品路徑上列會話。
   - capability-r2-09：telemetry 的「偏離三」。
   - core-mw-07：invalid-tool-args 把安全歸功給 MemorySaver。
   - core-mw-model-03：「60 則」門檻的換算，三處散文互相矛盾。
   - capability-r2-10：present 的模型面文字停在 ddefc45。
   - F2：封閉詞彙的理由，三份檔頭互相矛盾。
3. **錯誤訊號過接縫時被降成字串或預設值**：
   - wire-r2-02（中）：日誌裡有錯誤碼，上線投影時丟掉了，web 只好比對錯誤文字的結尾。
   - plugins-interaction-r2-04：ask-user 缺 channel 時退成「有人在」，跟 dsh 的 `NO_PROVIDER` 方向相反。
   - N1：`trackUndo` 漏包 `useWithBackend`，回滾後留下孤兒，訊息卻說已全數撤銷。
4. **組裝根不是唯一來源**：
   - hcr-r2-03（中）：五顆協作者由程式碼掛，出貨清單上看不到，dump 看不到，patch 也動不了。
   - hcr-r2-05（中）：模型接縫只開在 HTTP 層，要腳本化回合的 8 個測試檔只好手抄組裝根。實測刪掉 `serve.ts` 裡 deliverableLimits 那一行，整套測試照樣綠。
   - wire-r2-01（中）：web 測試以相對路徑讀 core、plugin、harness 的原始碼。
   - hcr-r2-04：serve 反向相依 CLI 入口。
5. **會影響行為的三條，都跟 goal 續行有關**（中）：
   - plugins-interaction-r2-02：中止或失敗之後，續行授權沒有收回，人再說一句話，排程器就接回續行。dsh 看到 aborted 會 disarm。
   - plugins-interaction-r2-03：serve 上打 `/goal` 或 `/goal resume` 之後，一輪都不排。驗證者另外發現，續接回來的 CLI 會話也排不出第 1 輪；而 `docs/operations.md:78` 正好教人續接後打 `/goal resume`。
   - core-mw-model-01：goal 續行輪會把重複提醒的計數清零，dsh 只在 `source.kind` 是 `user` 時才清零。結果在續行時打轉，模型永遠拿不到提醒。

   goal driver 今天在 CLI 與 serve 都預設關，所以零設定路徑還碰不到這三條。但 **#445（serve 預設開，已拍板）一落地，三條都會進產品路徑**。建議在 #445 或 #638 動工前一起處理，或寫進它們的驗收。已開卡：#660、#661、#662，三張都設成擋住 #445。

**沒有專卡的中級發現**有 9 條：N2、F5、wire-r2-02、plugins-interaction-r2-02、r2-03、hcr-r2-01、hcr-r2-03、hcr-r2-05、core-mw-model-01。
- hcr-r2-03 的母題是 #46。
- plugins-interaction-r2-02、r2-03 與 core-mw-model-01 跟 #445、#638 相鄰，但兩張卡的內文都沒寫到這三件事。
- wire-r2-01 只有工具名那一塊可以接 #442。

**之後已全部開卡**，連同只有部分追蹤的 wire-r2-01：
- 續行三條：plugins-interaction-r2-02 → #660、r2-03 → #661、core-mw-model-01 → #662，都設成擋住 #445。
- N2 → #664、F5 → #665、wire-r2-01 → #666、wire-r2-02 → #667。
- hcr-r2-01 → #668、hcr-r2-03 → #669、hcr-r2-05 → #670。
- 開 #666 時另外查到 web 的工具表漏了基座的 `delete`，單獨開成 #672。

**低級 27 條之後也全部開卡**：#677–#703，照本文順序一條一張，卡號寫在各條的「追蹤」。plugins-interaction-r2-04 的 ask-user 那一半併進 #669，其餘幾點在 #687。

### 中級一覽

| ID | 發現 | 形狀 | 歸屬 | 追蹤 |
| --- | --- | --- | --- | --- |
| core-plugin-system-r2-N2 | root 與子代理的 middleware 堆疊在 fold.ts 手寫兩份，子代理漏一格不會有測試紅 | 缺接縫（兩種變體寫死） | dev-harness | #664 |
| core-session-F5 | SessionStore 的「沒有 list」前提已過期：serve 的列表繞過介面自己讀檔 | 隱性耦合（無相依邊） | dev-harness | #665（#631–#633 會擴大讀方） |
| wire-seam-r2-01 | web 測試以相對路徑讀 core／plugin／harness 原始碼，補 wire 沒承載的詞彙 | 隱性耦合（無相依邊） | 兩邊 | #666（工具名那一塊接 #442）；另開 #672 |
| wire-seam-r2-02 | 停止的提問卡靠錯誤文字結尾判斷，日誌裡的錯誤碼在上線投影時被丟掉 | 介面外的事實（順序／狀態／設定／錯誤模式） | 兩邊 | #667 |
| plugins-interaction-r2-02 | 中止或失敗之後續行授權沒有收回，人再說一句話後排程器會自動接回續行 | 介面外的事實（順序／狀態／設定／錯誤模式） | dev-harness | #660（擋住 #445） |
| plugins-interaction-r2-03 | 排程器的觸發點由兩個入口各自寫死，serve 上 /goal 建立或 resume 之後一輪都不排 | 缺接縫（兩種變體寫死） | dev-harness | #661（擋住 #445） |
| hcr-r2-01 | 會話接線的四步與收線順序由兩個入口各寫一次，型別還把必接的那一步標成選配 | 介面外的事實（順序／狀態／設定／錯誤模式） | dev-harness | #668 |
| hcr-r2-03 | 五顆由程式碼掛的協作者不在出貨清單：清單不是唯一來源，dump 看不到，patch 動不了 | 缺接縫（兩種變體寫死） | dev-harness | #669（母題 #46） |
| hcr-r2-05 | 組裝根的模型接縫只開在 HTTP 層，要腳本化回合的測試改為手抄組裝根 | 測試越過介面 | dev-harness | #670 |
| core-mw-model-01 | 提醒器的清零判準是 core 裡一張寫死的記號白名單，而且在 goal 續行輪上跟 dsh 相反 | 缺接縫（兩種變體寫死） | dev-harness | #662（擋住 #445） |

已被追蹤的兩條中級：core-session-F1（#507）、plugins-capability-r2-08（#440，本條補上了 #440 驗收二要的量測結果）。

## 發現

### 嚴重度：中（10）

#### core-plugin-system-r2-N2　root 與子代理的 middleware 堆疊在 fold.ts 手寫兩份，子代理漏一格不會有測試紅

- **類型**：缺接縫（兩種變體寫死）｜**歸屬**：dev-harness｜**驗證**：保留（原判 中 → 中）｜合併了 core-mw-01
- **呼叫者必須知道、介面沒表達的事**：每加一顆 core middleware，要同時改四處：foldRegistry 建實例、foldMiddleware 的 16 個位置參數、foldSubAgents 的 20 欄 context、兩個陣列字面值。子代理那份跟 root 對齊，只靠每格的「同 root」註解。
- **說明**：同一份堆疊有兩個手寫變體： - root 那份是 foldMiddleware（fold.ts:778），16 個位置參數。 - 子代理那份是 foldSubAgents 的陣列字面值（:1388 起）。 兩者的差異散在陣列裡：子代理用另一顆 policy-never 核准閘門，多一顆委派聲明和 spec.middleware，摘要器與觀測策略逐個建（:1291 的型別是工廠，root 那邊是實例）。對齊只靠每格的「同 root」註解（例如 :1403）。plugin 分區已經用「切法只寫一次」解掉同類漂移（:841），core 自己那幾格沒有跟進。 失敗情境：有人替 root 加一顆新的 core middleware。root 的全名單測試（fold.test.ts:161）紅了，他就改期望值；子代理的全名單測試（:241）是另一份手寫期望值，照樣綠。檔內自己寫明漏注子代理是靜默的：漏掉核准閘門「默默地讓 subagent 失去核准」（:1235），漏掉用量記錄器「沒有人會紅」（:1385）。「每一疊都有」的跨疊斷言只替幾顆個別寫過（例如 :1347 的摘要器），沒有通用的一條。
- **dsh 的形狀**：dsh 的子代理不另組一份：child-agent.ts:205 以 composeFrom(childCtx, parent.ctx) 併入父代理保留的同一版組合（agent-preset-registry：Join a child to the exact revision retained by its parent），註冊視圖也沿 scope 鏈往下繼承。子代理的差異是在同一份組合上用 scope 覆寫，不是另寫一份清單。　`dsh:packages/subagent/subagent/src/child-agent.ts:205`、`dsh:packages/preset/agent-preset-registry/src/index.ts:268`、`dsh:packages/preset/agent-preset-registry/src/index.ts:273`
- **建議**：在 fold 內用一張有序的槽位表當唯一來源。每一列寫明： - 名字； - root 取什麼（實例或工廠）； - 子代理取什麼（同一顆、另一顆、逐個建、不給）。 表上另外標出子代理專屬的插入點（委派聲明、spec.middleware）。root 與子代理的陣列都從這張表導出。 測試也跟著改：對表斷言「子代理＝root 依表投影」，再對每個槽位跑一條通用的「每一疊都有（除非表上寫不給）」，取代兩份各自手寫的全名單期望值。
- **偏離說明**：dsh 靠 composeFrom 讓子代理直接繼承父代理的組合。deepagents 表達不出這件事：SubAgentBase.middleware 只接在子代理自己的預設 stack 之後，root 的 middleware 參數一個都不繼承（fold.ts:1233 引 deepagents@1.13.1 的 d.ts）。所以每一顆都得逐個注。最接近的做法是在 fold 內從同一張表導出兩份陣列，而不是手寫兩份。
- **既有追蹤**：專卡 #664（盤點後開）。盤點當時：沒有追蹤卡。#327（已關）把 plugin middleware 攤進子代理時，對 plugin 分區做了「只切一次」，core 的槽位沒有跟進。
- **證據**：`packages/nexus-core/src/fold.ts:778`、`packages/nexus-core/src/fold.ts:1291`、`packages/nexus-core/src/fold.ts:1398`、`packages/nexus-core/src/fold.ts:1403`、`packages/nexus-core/src/fold.ts:1385`
- **否定搜尋**：git grep -n 'foldMiddleware(' -- packages apps：只有 fold.ts:454 的呼叫與 :778 的定義，沒有第二條導出路徑；在 fold.test.ts 搜「params.middleware … subagent」與「toEqual(params.middleware」：0 筆，沒有斷言子代理堆疊由 root 導出；跨疊比對只有 :1347、:2013 為個別 middleware 寫的 stacks 輔助
- **驗證意見**：判 confirmed，保留這一條。它與 coupling-core-middleware-tools 的 core-mw-01 是同一件事，建議 core-mw-01 判 duplicate-of core-plugin-system-r2-N2。 一、耦合是真的。 - root 那份是 foldMiddleware，16 個位置參數（fold.ts:778）；子代理那份是 foldSubAgents，20 欄 context 加一份手寫陣列（:1291、:1388 起）。我逐格比對過，今天兩份順序是對齊的。 - fold.test.ts:161 的 root 全名單與 :241 的子代理全名單是兩份各自手寫的期望值。新增一格只補 root 時，root 測試紅、改期望值即可；子代理測試因為實作與期望都沒動，照樣綠。 - 檔內自己承認漏注是靜默的（:1385「沒有人會紅」、:1235「默默地讓 subagent 失去核准」）。 - 有一個細節要修正標題：「子代理漏一格不會有測試紅」只對**新增**的槽位成立。拿掉既有的一格，:241 會紅；

#### core-session-F5　SessionStore 的「沒有 list」前提已過期：serve 的列表繞過介面自己讀檔

- **類型**：隱性耦合（無相依邊）｜**歸屬**：dev-harness｜**驗證**：保留（原判 中 → 中）
- **呼叫者必須知道、介面沒表達的事**：JSONL 的檔名規則（<base>.header.json 配 <base>.jsonl）與 header 的解析方式在介面外被複製了三份；改 adapter 的檔名或 header 形狀，列表與掃描要一起改，而介面上看不出這件事。
- **說明**：session-store.ts 的檔頭寫「沒有 stat／list，讀回只有一個 resume」「要列的那天再加」，理由是列的只有產品路徑外的離線掃描。這個前提在 #302 已經不成立：serve.ts 以 listStoredThreads(sessionStore.directory, …) 在產品路徑上列會話，靠的是 JsonlSessionStore 在介面外多開的 directory；session-list.ts 自己宣告 HEADER_SUFFIX／LOG_SUFFIX、自己寬鬆解析 header，eval/session-scan.ts 又宣告一份，adapter 本身則用字面量拼檔名。09-19 盤點把「會話續接／列表／租約」記為「有」，沒有注意到它繞過了介面。#631（按內容搜尋）、#632（清單即時狀態）、#633（釘選、封存、改名存伺服器端）都會再加讀方。檔名分岔會被 session-list.test（走真 adapter）與 serve-session-list.test 抓到，所以是中。
- **dsh 的形狀**：dsh 的 SessionPersistence 有 abstract stat 與 abstract list；session-query 經由 persistence.list 列，session-controller 的列表 API 走 sessionQuery.listSessions，不自己讀檔。　`dsh:packages/session/session-persistence/src/index.ts:201`、`dsh:packages/session/session-persistence/src/index.ts:194`、`dsh:packages/session-query/session-query/src/corpus.ts:262`
- **建議**：讓 SessionStore 長出 list（與 stat），回傳 header 摘要；檔名與 header 解析收回 jsonl-session-store 裡；session-list 改成在 list 的結果上加標題與 cwd 過濾，session-scan 也走同一個 list。版本比這一版新的條目怎麼處理（列表計入 unreadable、掃描照讀）可以用 list 的選項表達。sandbox-mode.test.ts 的 KNOWN = ['create','resume'] 會照設計紅，那時要一起更新 session-store.ts 的檔頭。
- **既有追蹤**：專卡 #665（盤點後開）。盤點當時：無直接追蹤；#631、#632、#633（皆 OPEN）會擴大讀方。
- **證據**：`packages/nexus-core/src/session-store.ts:20`、`packages/nexus-core/src/session-store.ts:24`、`packages/nexus-core/src/session-store.ts:25`、`apps/harness/src/session-list.ts:2`、`apps/harness/src/serve.ts:360`
- **否定搜尋**：git grep -n -E "implements SessionStore([^A-Za-z_]|$)|: SessionStore = |as SessionStore|SessionStore \{" -- packages apps；git grep -n -F ".header.json" -- packages apps ':!*.test.ts'；git grep -n -F "sessionStore.directory" -- apps packages
- **驗證意見**：成立。SessionStore 檔頭的前提是「沒有 stat／list，要列的那天再加；離線掃描在產品路徑外」，這個觸發條件在 #302 已經發生：serve.ts 以 listStoredThreads(sessionStore.directory, …) 在產品路徑上列會話，靠的是 JsonlSessionStore 在介面外多開的 directory。檔名規則有三份：session-list 與 session-scan 各宣告一次 HEADER_SUFFIX，adapter 本身用字面量。#302 的卡片只決定照 session-scan 的做法唯讀走目錄，沒有決定「不擴介面」，所以沒有對應的決議。`gh issue list --search "SessionStore list"` 找不到追蹤卡；#631、#632、#633 的內文也沒提 SessionStore。基準之後的 2b8d886（#649）讓 session-list 再多讀 session/title，繞過介面的讀方又多一種。

#### wire-seam-r2-01　web 測試以相對路徑讀 core／plugin／harness 原始碼，補 wire 沒承載的詞彙

- **類型**：隱性耦合（無相依邊）｜**歸屬**：兩邊｜**驗證**：降級保留（原判 中 → 中）
- **呼叫者必須知道、介面沒表達的事**：web 的 package.json 只相依 @nexus/wire，但它的正確性還依賴：core 的 TOOL_ABORTED_BEFORE_DISPATCH_REASON 字串、core 的 TODO_STATUSES 字面排列、每個 plugin 與 harness 都用 `export const X_TOOL_NAME = '...'` 這種寫法宣告工具名、harness 只 new 三種沒有 shell 的 Backend。這些都不在任何型別或 wire 介面上，只在三支測試用 `../../../../packages/` 相對路徑讀原始碼的正則裡。
- **說明**：三支 web 測試共約六條絆索讀別套件的原始碼：question-view.test 讀 turn-cancel.ts 比理由字串；todo-view.test 讀 plugin-todo 的 TODO_TOOL_NAME 與 core 的 TODO_STATUSES；tool-view.test 掃每個 nexus-plugin-* 與 harness 的 `*TOOL_NAME*`，另外掃 harness 的 `new \w*Backend(` 並斷言 ContainedFilesystemBackend 的原始碼。這些絆索綁的是原始碼的寫法而不是值：工具名改用 `as const`、模板字串或由別的常數組出來，正則就不再命中，tool-view 會少收一個名字而照樣綠（量具自檢那條只斷言四個已知名字還在）。反方向也有：harness 的 tool-error-prefix.test 把 apps/web/src 列在 SOURCE_ROOTS。重複定義：web 的 TodoStatus 與 wire 的 WireTodoItem.status 是同一個聯集，web 已經相依 wire 卻沒拿來用；harness 的 todosData 已在編譯期把 core 的狀態塞進 WireTodoItem（core 多一個狀態就編不過）。
- **dsh 的形狀**：dsh 的 UI 以宣告過的型別子路徑相依拿 domain 詞彙：ui-conversation 的 TodoPanel `import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'`，它的 package.json 宣告了 dsh-tool-todo，tool-todo 匯出 `./client` 子路徑；ui-deliverables 的 changes.ts 從 dsh-workspace-changes 的 `./types` 子路徑拿型別。工具名那一塊，dsh 的 UI（tool-call-model.ts 的 TOOL_VARIANTS）同樣是手寫字面值、沒有覆蓋檢查；dsh 的工具目錄則是開機讀已註冊的 schema 生成，不解析原始碼。　`dsh:packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx:8`、`dsh:packages/client/ui-conversation/package.json:80`、`dsh:packages/todo/tool-todo/package.json:25`
- **建議**：分三刀。(1) 詞彙照 dsh：web 的 TodoStatus 改成 `WireTodoItem['status']`（web 已相依 wire，不用新增邊），刪掉讀 TODO_STATUSES 的絆索，並把 harness 的 todosData 那條改成兩個方向都釘。工具名、理由碼這類「值」，照 dsh 的話是讓 core／plugin 開一個瀏覽器可用的 `./client` 或 `./types` 子路徑，web 在 package.json 宣告相依後 import；這跟 harness-composition-root-05 替 @nexus/core 加 exports 是同一個方向，不衝突——dsh 的子路徑本來就是給 UI 的窄入口，不是把整個 src 攤開。(2) 工具名的覆蓋檢查改讀 #442 要產的工具目錄（開機生成），不再用正則掃原始碼。(3) execute／backend 那兩條絆索搬到 apps/harness，web 那側只留「execute 還沒有終端卡」這件 web 自己的事；
- **偏離說明**：若選擇沿用樹上既有慣例（wire 重新宣告 core 的值、鏡像斷言放 harness），而不照 dsh 的型別子路徑相依，這是我們的選擇，不是 deepagents／LangChain JS／LangGraph JS 表達不出來：pnpm workspace＋package.json exports 子路徑＋`import type` 完全表達得出 dsh 的形狀。要在決議或 PR 內文標明偏離與理由（例如 core 的值常數沒有瀏覽器安全的入口）。
- **既有追蹤**：專卡 #666（盤點後開；delete 那一列另開 #672）。盤點當時：工具名那一塊可接 #442（OPEN，gh 讀回：照 dsh 產工具 schema 目錄＋新鮮度 gate，驗收寫明經真正的註冊路徑載入、不手寫 schema）。其餘三件（理由字串、todo 狀態、backend 絆索）沒找到現成的卡。
- **證據**：`apps/web/package.json:19`、`apps/web/src/lib/question-view.test.ts:45`、`apps/web/src/lib/todo-view.test.ts:11`、`apps/web/src/lib/todo-view.test.ts:21`、`apps/web/src/lib/tool-view.test.ts:15`
- **否定搜尋**：git grep -n "\.\./\.\./\.\./" -- apps/web/src apps/web/tests apps/web/*.ts（只有三支 lib/*-view.test.ts 讀別套件）；git grep -n -l "readFileSync\|readdirSync\|node:fs\|from 'fs'" -- apps/web；git grep -n "?raw\|import.meta.glob\|import(\s*['`]\.\./" -- apps/web/src（零命中：沒有別的形狀讀原始碼）；git grep -n "from '@nexus/\(core\|harness\|plugin\)" -- apps/web（零命中：沒有相依邊）（另有 3 條）
- **驗證意見**：耦合屬實，代價也付過了：web 測試用相對路徑讀 core／plugin／harness 原始碼，而 #644（harness 的修補）就是為了 tool-view.test.ts:138 那一行，動用 AGENTS.md 的跨套件例外去改 apps/web（gh pr view 644 內文自述）；快照後 #648 又由 dev-ui 補了姊妹絆索。「會被抓到但增加改動成本」成立，維持中。判 weakened 有四個理由。(1) 值耦合在 dsh 同樣存在：dsh 產品 UI 的工具名（TOOL_VARIANTS）與錯誤碼（'ASK_ABORTED'）都是手寫字面值，沒有任何覆蓋檢查；我方多了會紅的絆索，只有工具名那條會漏。(2) 兩處過頭。第一，node 探針實測 `= 'foo' as const` 仍會命中正則；會漏的是型別註記 `: string =`、雙引號、模板字串，以及不叫 *TOOL_NAME* 的常數。

#### wire-seam-r2-02　停止的提問卡靠錯誤文字結尾判斷，日誌裡的錯誤碼在上線投影時被丟掉

- **類型**：介面外的事實（順序／狀態／設定／錯誤模式）｜**歸屬**：兩邊｜**驗證**：保留（原判 中 → 中）
- **呼叫者必須知道、介面沒表達的事**：web 要知道「這張提問卡是被停止收回的」，唯一的辦法是 ToolEntry.error 字串以 core 的 TOOL_ABORTED_BEFORE_DISPATCH_REASON 結尾。「錯誤文字的尾巴就是狀態」這個約定不在任何型別上，而同一件事在日誌裡本來就有型別化的碼。
- **說明**：pump 的 #withdraw 把 `code: TOOL_ABORTED | TOOL_ABORTED_BEFORE_DISPATCH` 寫進日誌，但上線的 #closeCard 只帶 `{ failed, text }`：ToolVerdict 只有 failed／text／meta，wire 的 tool-finished 折疊只把 data.message 放進 ToolEntry.error，conversation.ts 沒有任何 code 欄位。web 於是用 `entry.error?.endsWith(WITHDRAWN_TOOL_REASON)` 判 stopped，再靠 F1 那條讀 turn-cancel.ts 的絆索維持字串一致。歷史投影又在日誌缺 text 時把 code 當成錯誤文字的退路塞進同一格（`text ?? error?.code`），那時格子裡是 'ABORTED_BEFORE_DISPATCH'，endsWith 比的卻是理由句——同一格有時是人讀的句子、有時是機器碼。改理由的措辭（例如為了讓模型讀得懂而調整 turn-cancel 的句子）會讓 web 的停止判斷失效，只有剛好跑到那條原始碼絆索才會紅。
- **dsh 的形狀**：dsh 的 agent-loop 收回未派發的工具時寫 `info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH }`。UI 看碼不看字：tool-call-model.ts 以 `block.error?.code === 'interrupted'` 判 stopped；ask-question-row.tsx 讀 `block.error?.code`，把 'ASK_ABORTED' 判成 stopped。UI 那側的碼是手寫字面值，沒有對 domain 常數的鏡像檢查。　`dsh:packages/core/agent-loop/src/tool-calls.ts:257`、`dsh:packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:289`、`dsh:packages/client/ui-tool/src/client/tool/toolviews/ask-question-row.tsx:148`
- **建議**：照 dsh 讓碼跨過線。(1) ToolVerdict 加 `code?`，#withdraw 與其他失敗出口把日誌的 code 一併放上 tool-finished frame（照 aborted 的先例放在 lifecycle data）。(2) wire 的 ToolEntry 加 `errorCode?: string`，折疊器照抄；歷史投影讓 code 與 text 各放各的格，不再把 code 當 text 的退路。(3) wire 重新宣告 web 要比的碼，harness 以完全相等檢查鏡像 core 的常數（樹上慣例）。(4) web 的 isStoppedQuestion 改比碼，刪掉讀 turn-cancel.ts 的絆索。這是新增選填欄位，拆得開：先合 harness＋wire，再合 web。
- **既有追蹤**：專卡 #667（盤點後開）。盤點當時：沒找到現成的卡。#434（OPEN，gh 讀回）講的是模型失敗在日誌帶分類碼，不是工具結果的碼跨線。
- **證據**：`packages/nexus-core/src/tool-events.ts:75`、`apps/harness/src/thread-pump.ts:1124`、`apps/harness/src/thread-pump.ts:1144`、`apps/harness/src/thread-pump.ts:442`、`apps/harness/src/conversation-history.ts:591`
- **否定搜尋**：rtk proxy grep -n "\bcode\b" packages/nexus-wire/src/conversation.ts（零命中：折疊器與 ToolEntry 都沒有碼）；dsh: git grep -n "info?.code\|info\.code\|error?.info" -- packages/client（空：dsh 的 UI 讀的是轉換後的 block.error.code，不直接讀 info）
- **驗證意見**：獨立重推成立：日誌有 TOOL_ABORTED_BEFORE_DISPATCH，上線的 ToolVerdict 只帶 failed／text／meta，web 只好以 endsWith 比理由句。question-view.ts 自己寫明是因為沒有碼才比字，PR #428 內文也列為已知限制，沒有卡追蹤（gh issue list 搜 errorCode、isStoppedQuestion、錯誤碼 wire 都沒有對應的卡；#434 是模型失敗碼）。question-view.test 只釘 core 的常數，不釘 pump 實際送什麼：pump 若改送別的理由，web 會靜默退成一般失敗卡，所以中成立。dsh 那側核過：事件的 data.error（含 code）原樣進 client 的工具節點（ui-chat conversation-nodes/tool.ts:76）；提問中斷由領域端產出 ASK_ABORTED，UI 比碼。另外，dsh 的 'interrupted' 是 client 替沒結果的卡合成的，對應我方折疊器的 UNFINISHED_TOOL_TEXT。有三處更正。

#### plugins-interaction-r2-02　中止或失敗之後續行授權沒有收回，人再說一句話後排程器會自動接回續行

- **類型**：介面外的事實（順序／狀態／設定／錯誤模式）｜**歸屬**：dev-harness｜**驗證**：保留（原判 中 → 中）
- **呼叫者必須知道、介面沒表達的事**：decideGoalRound 的 'turn-aborted' 與 'turn-failed' 只代表「這一次不排」，不代表收回授權；GoalService 的 activation 只在 goal/change、撞到輸出上限、flush 失敗時變成 disarmed。所以人按停止（或一輪拋錯）之後再送任何一句話，那一輪收工時排程器照樣排下一個續行輪次。GoalDriverPort.disarm 只有兩個呼叫點，呼叫者從介面上看不出來。
- **說明**：兩個入口每一輪收工後都問排程器：pump 在 settle 裡呼叫 #driveGoalRound，REPL 在每一行之後呼叫 driveGoalRounds。driveGoalRound 只在 turn-max-tokens 時 disarm，turn-aborted／turn-failed 只回 undefined；goal-driver.test.ts 把「被人中止的那一輪不收回——擋住的是 max-tokens 這一種」釘成規格。失敗情境：serve 開 --goal-driver，續行輪次跑到一半人按停止（turn/end 帶 aborted → idle），接著打「等一下，我先看看」；那一輪正常收尾後 #driveGoalRound 再問一次，decideGoalRound 看到最後一輪正常結束、目標 active、授權仍是 armed，就排下一個續行輪次。turn/failed 同理，而且 CLI 與 serve 都走得到（CLI 沒有中止路徑）：goal-driver-cli.test.ts 的「續行輪次拋錯就整串停，再問一次也不排」只釘了緊接著再問一次——停住靠的是日誌最後一輪還是 turn/failed，REPL 收下一句人話、那一輪正常結束之後，同一個排程器會照排。
- **dsh 的形狀**：dsh 的 goal-round-driver 在 agent/error 時 disarm；turn/end 帶 aborted 時，若被中止的正是它自己排的那一輪（attempt 的 phase 為 claimed 或 admitted）就標 cancelled，下一個 agent/status idle 看到 cancelled、而且目標仍是同一修訂的 active＋armed，就 pause 目標（pause 失敗再退回 disarm）；被中止的不是它的那一輪時直接 disarm。兩條路都不會在下一句人話之後自動接回。README 明寫「Cancellation never auto-restarts a round」，而且撞到輸出上限、flush 失敗也都停。　`dsh:packages/goal/goal-round-driver/src/index.ts:246`、`dsh:packages/goal/goal-round-driver/src/index.ts:333`、`dsh:packages/goal/goal-round-driver/src/index.ts:334`
- **建議**：照 dsh：driveGoalRound 看到 turn-aborted 或 turn-failed 時，比照 turn-max-tokens，在授權仍是 armed 時呼叫 port.disarm()。disarm 是行程內的，不動耐久的相位與修訂號（service.ts 的 JSDoc），所以跟 #265 Q8「中止之後不自動續行，目標狀態不動」相容，這一格不必偏離。goal-driver.test.ts 那條「被人中止的那一輪不收回」要翻面成驗收句（中止後人再說一句，續行不接回），'turn-aborted' 註解裡「同 dsh」的說法要改掉。
- **偏離說明**：dsh 在「被中止的是自己排的那一輪」時會暫停目標（改耐久相位）；#265 Q8 拍板「目標狀態不動」，那一格是決議過的偏離，應補登記在 goal-driver.ts。disarm 那一格沒有表達不出來的理由，不該偏離。
- **既有追蹤**：專卡 #660（盤點後開，擋住 #445）。盤點當時：#638（開）的「動工前要查」列了「跟 #265 Q8（中止之後不自動續行、目標狀態不動）怎麼對上」；#265 已關（Q8 決議）。goal-driver 在 CLI 與 serve 都預設關；#445（開，已拍板）讓 serve 預設開，落地後這會變成 serve 的預設行為。
- **證據**：`apps/harness/src/goal-driver.ts:164`、`apps/harness/src/goal-driver.ts:293`、`apps/harness/src/goal-driver.ts:120`、`apps/harness/src/goal-driver.test.ts:311`、`packages/nexus-plugin-goal/src/service.ts:443`
- **否定搜尋**：git grep -n -E "aborted|turn/failed|max-tokens" -- packages/nexus-plugin-goal/src ':!*.test.ts'；git grep -n -E "disarm\(|#activation =|'disarmed'" -- apps packages ':!*.test.ts' ':!*.md'（disarm() 的呼叫點只有 goal-driver.ts:295 與 :315；#activation 的其他賦值都在 goal/change 的 commit）
- **驗證意見**：推翻不了。driveGoalRound 只在 turn-max-tokens 時 disarm；turn-aborted 與 turn-failed 只回 undefined。GoalService 的授權只在 goal/change、max-tokens、flush 失敗時變 disarmed。所以中止或拋錯之後，人只要再送一句話，那一輪正常收工，decideGoalRound 就會看到最後一輪正常結束、目標 active 而且仍是 armed，於是照排。serve 走 pump 的 settle，CLI 走 REPL 每一行之後，兩條路都一樣。goal-driver.test.ts:311 把「中止不收回」釘成規格。goal-driver-cli.test.ts:177 只驗了緊接著再問一次，停住靠的是日誌最後一輪還是 turn/failed。dsh_shape 核過：agent/error 時 disarm；

#### plugins-interaction-r2-03　排程器的觸發點由兩個入口各自寫死，serve 上 /goal 建立或 resume 之後一輪都不排

- **類型**：缺接縫（兩種變體寫死）｜**歸屬**：dev-harness｜**驗證**：保留（原判 中 → 中）
- **呼叫者必須知道、介面沒表達的事**：driveGoalRound 是純的，「什麼時候該問它」全交給呼叫端，而兩個呼叫端的答案不同：CLI 在每一行（含斜線命令）之後問；serve 只在 pump 一件工作收尾時問，斜線命令不經 pump，pump 的日誌觀察也不看 goal/change。再加上 decideGoalRound 在這個行程還沒有任何一輪時回 'no-turn'，剛建立或剛 resume 的目標要等人再送一句話才會開始。
- **說明**：serve 那條路上，#driveGoalRound 唯一的呼叫點是 pump 的 settle；handleSlash 直接叫執行器，不碰 pump；#noteLogEvent 處理 tool/call、tool/result、deliverables、workspace/changes、model/usage、context/measure、todo/write，沒有 goal/change。CLI 那條路有「命令也算一次機會」，但新開的 REPL 第一行就打 /goal 時，decideGoalRound 會因為 currentTurnStart < 0 回 no-turn。失敗情境：web 開 --goal-driver（或 #445 落地後零設定），人打 `/goal 把 CI 修綠`，畫面回目標已建立，然後什麼都不發生，直到人再送一句話、那一輪收工才排第 1 輪；`/goal resume` 同理。第一輪 plugins-interaction-02 把問題放在 plugin-goal 與 goal-driver 之間，那一側三處檔頭寫的是同一套分工；真正寫死兩份的是兩個呼叫端的觸發集合。
- **dsh 的形狀**：dsh 只有一個持有者：goal-round-driver 這顆 plugin 自己訂閱 goal/changed（goal 服務每一次 commit 都發，含 create 與 resume）與 agent/status，在 agent 閒著時 requestDrive；readyToDrive 的條件是 fiber 還活著、沒在停、agent 是同一個且 idle、收件匣沒有競爭的輸入，沒有「這個行程得先跑過一輪」這一條。所以 dsh 的 `/goal <目標>` 或 `/goal resume` 在 agent 閒著時立刻排第 1 輪。　`dsh:packages/goal/goal-round-driver/src/index.ts:282`、`dsh:packages/goal/goal/src/index.ts:625`、`dsh:packages/goal/goal/src/index.ts:608`
- **建議**：把「何時問排程器」收進一個兩條入口共用的地方，觸發集合照 dsh：目標變更之後、以及 agent 閒著時。serve 側至少要在斜線命令執行完、或 root 日誌出現 goal/change 時補問一次（pump 已經在觀察 root 日誌）；'no-turn' 的語意要重看——它是「就緒判準從 turn/start…turn/end 推」的產物，dsh 看的是 agent status。#638 會重做 serve 那條路，這一格應併進 #638 的範圍，#445 的驗收也該多一句「/goal 建立或 resume 之後會開始續行」。
- **偏離說明**：排程器落在 apps/harness 是登記過的載體偏離（#180：PluginRegistry 沒有排得出一輪的通道），那一筆仍然成立；但觸發集合是紀律不是載體，不在那筆偏離的射程內，沒有表達不出來的理由。
- **既有追蹤**：專卡 #661（盤點後開，擋住 #445）。盤點當時：#180（已關，載體偏離）；#638（開，會重做 serve 路徑，內文沒提命令之後的觸發）；#445（開，驗收只寫「一個沒達成的 active goal 會自己再開一輪」）。
- **證據**：`apps/harness/src/thread-pump.ts:1035`、`apps/harness/src/thread-pump.ts:1633`、`apps/harness/src/wire-handler.ts:1024`、`apps/harness/src/cli.ts:1271`、`apps/harness/src/goal-driver.ts:157`
- **否定搜尋**：git grep -n -E "#driveGoalRound\(\)|driveGoalRound\(" -- apps/harness/src/thread-pump.ts apps/harness/src/wire-handler.ts；git grep -n "noteLogEvent" -- apps/harness/src/thread-pump.ts ＋ sed -n 1617,1680p 逐種列出事件分支；git grep -n -E "goal resume|/goal |命令也算一次機會|命令之後|slash|executor" -- apps/harness/src/goal-driver-pump.test.ts（零命中）；git grep -n -E "goal resume|/goal |命令也算一次機會" -- apps/harness/src/goal-driver-cli.test.ts（只命中 :429 patch 拿掉 /goal 那一案）
- **驗證意見**：推翻不了，而且比原文更廣。serve 側唯一問排程器的地方是 thread-pump.ts:1035 的 settle。handleSlash 直接叫執行器，不碰 pump。pump 沒有觀察 goal/change：在 thread-pump.ts、wire-handler.ts、serve.ts 三檔 git grep goal/change，只命中 wire-handler.ts:181 一行註解。所以 web 上打 /goal 或 /goal resume 之後一輪都不排，要等人再說一句。新發現：currentTurnStart 在 session/end-seed 停住（session-log.ts:1002），所以續接回來的會話在這個行程的第一輪之前一律是 no-turn。docs/operations.md:78 教人續接後打 /goal resume，而這時 CLI 的 /goal resume 也排不出第 1 輪。cli.ts:1271「命令也算一次機會」在新開的 REPL 與續接的 REPL 上都不成立，不只 serve 缺。兩條路的測試都沒有走「命令之後續行」。

#### hcr-r2-01　會話接線的四步與收線順序由兩個入口各寫一次，型別還把必接的那一步標成選配

- **類型**：介面外的事實（順序／狀態／設定／錯誤模式）｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 中 → 中）
- **呼叫者必須知道、介面沒表達的事**：拿到 NexusAgentHandle 的呼叫端，必須用自己建的 SessionRegistry 依序呼叫 attachTelemetry → attachInvariants → attachSession，再接落盤；收線時順序反過來：先收參與者，再收不變量、遙測、落盤，最後收 agent。這個順序和「attachSession 不能漏」都不在型別裡。
- **說明**：agent-factory 交出三個接線口，理由是 plugin 碰不到日誌，而 SessionRegistry 是入口建的。結果接線變成呼叫端的義務：cli.ts 的 runCli 和 wire-handler.ts 的 pumpFor 各寫了一份相同的四步與收線順序，順序的理由只靠註解互相指認（「同 cli.ts 那條的理由」）。wire-handler 的 ThreadAgent 把 attachSession 宣告成選配，同一段 docstring 卻說「這條路不能漏。漏了的話 @nexus/core 的測試照樣全綠」，還留著「沒有人註冊參與者時回 undefined」這句舊話，而 agent-factory 那側已經明說那條短路拿掉了。型別、文件、實作三者對這一步說法不一致。刪除測試：三個 attach* 本身有在賺，刪了要在兩處重寫 registry 的讀法；但「把這一份 SessionRegistry 全部接好」這件事沒有任何模組承擔，已經在兩個呼叫者各寫了一份。
- **dsh 的形狀**：dsh 的配套自己訂閱會話。不變量配套先 `for (const session of ctx.sessions.list()) seedSession(session)` 掃既有會話，再 `ctx.on('session/created', …)` 接之後出生的；遙測協調器建構時自己註冊 session/created、session/event 等監聽，並掃 ctx.sessions.list()。組裝根沒有接線義務，所以也不會有兩份順序。　`dsh:packages/core/session/src/invariant.ts:227`、`dsh:packages/core/session/src/invariant.ts:229`、`dsh:packages/session/session-telemetry/src/coordinator.ts:63`
- **建議**：朝 dsh 的方向，把「接好一份會話註冊表」收成一個入口。handle 提供單一的 `attachSessions(sessions, { persistence? })`，內部固定遙測→不變量→參與者→落盤的順序，回傳一個照相反順序收線的 detach；cli.ts 與 wire-handler.ts 都改呼叫它。ThreadAgent 上把它改成必填，手搭的 wire 測試改用一個共用的測試建構器來提供。要做到 dsh 那樣由配套自己訂閱，前提是 SessionRegistry 在組裝前就存在，而 serve 的 pump 目前在組裝後才建它，所以這一步先不做。
- **偏離說明**：不需要偏離登記：單一接線入口在我方基礎建設上表達得出來。日後若要做到「配套自己訂閱、組裝根零義務」卻做不到，要登記，理由是 SessionRegistry 的建立時刻。
- **既有追蹤**：專卡 #668（盤點後開）。盤點當時：和 wire-seam-03（ThreadAgent 的 attach* 順序）是同一個接縫；本條講的是組裝根那一側：兩個入口各自重寫同一套順序。記憶「wire 測試組裝要接 attachSession」記過一次因漏接而假綠。沒有開卡。
- **證據**：`apps/harness/src/cli.ts:1443`、`apps/harness/src/cli.ts:1450`、`apps/harness/src/cli.ts:1446`、`apps/harness/src/cli.ts:1457`、`apps/harness/src/wire-handler.ts:668`
- **否定搜尋**：git grep -n "attachTelemetry\|attachInvariants\|attachSession\b\|attachSession(\|attachSessionPersistence" -- 'apps/**/*.ts' ':!*.test.ts' （產品程式碼的接線點只有 cli.ts 的 runCli、serve.ts 的轉交與 wire-handler.ts 的 pumpFor）
- **驗證意見**：拆成兩半判：順序那一半被推翻，漏轉交那一半比原文講的更重，所以嚴重度留 中。【順序那一半被推翻】原文把「遙測→不變量→參與者→落盤」寫成承重的順序，主要依據是 cli.ts:1447 的註解。但四個消費者接上時都會先處理既有事件：SessionRegistry.observe 對新訂閱者掃過既有日誌（session-registry.ts:175）；不變量 runner 建立時重播 log.events（invariants.ts:282）；live 遙測建構時 captureNow 補送（session-telemetry-coordinator.ts:81）；落盤協調器補寫還沒存的前綴（session-persistence.ts:107）。所以參與者排在不變量前面，安裝期寫的那一筆照樣會在重播時被檢查到，cli.ts:1447 的「反過來會漏檢」不成立。session-participants.test.ts:113 那條 runCli 測試證得了「有接」，證不了順序。

#### hcr-r2-03　五顆由程式碼掛的協作者不在出貨清單：清單不是唯一來源，dump 看不到，patch 動不了

- **類型**：缺接縫（兩種變體寫死）｜**歸屬**：dev-harness｜**驗證**：保留（原判 中 → 中）
- **呼叫者必須知道、介面沒表達的事**：零設定產品路徑的真實組成＝cordis.yml 疊完的列，再加上 createCliAgent 在程式碼裡加的 host-services、ask-user、submit-record、sandbox-policy（有 workspace 時）、workspace-changes（serve＋workspace 時）。這幾顆沒有 id，--dump-config 印不出來，patch 也指不到。
- **說明**：cordis.yml 檔頭說自己是「零設定的 nexus 由什麼組成」的唯一來源，又說 --dump-config「印出啟動真的會掛的那一份」；但 renderDefaultConfigDump 只渲染設定檔那三層，所以這兩句對程式碼掛的五顆不成立。README 寫明 ask_user_question、submit_record「patch 也關不掉」是刻意的，卻沒有對照 dsh 登記偏離。後果有三：(1) 部署方關不掉 ask_user_question，dsh 則可以，因為它是 preset 裡的一列；(2) 核准閘門為了「在 dump 裡看得見」特地給了一列受保護的條目，這五顆沒有同等待遇；(3) 清單型的絆索看不到它們。submit-record-mounts.test.ts 檔頭自己承認「它守不到的那一半」，同一個檔頭還描述著 #459 之前「backend 經工廠參數」的接法，已經過期。ask-user 與 submit-record 在 #459 之後已是有 default export 的模組常數，工廠只是「薄薄一層」；當初擋住它們進清單的理由（要靠閉包拿協作者）已經不在了。sandbox-policy 與 workspace-changes 則是因為「有沒有 workspace、是不是 serve」的條件寫在組裝根，才非得用程式碼掛。
- **dsh 的形狀**：dsh 明文「Every model-facing tool belongs to a preset, `ask_user_question` included」，web 組裝的全域工具層是空的。出廠 profile 裡 tool-ask-user 只出現在 web-app 的 standard、ptc、cordis 三個 preset，minimal 沒有；workspace-changes 是 web-app bundle 裡的一列。條件寫在 plugin 內，不在組裝根：workspace-changes 用 eligible() 判「子代理或沒有 cwd 就不記」，tool-str-replace-editor 用 `ctx.fs.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')`。　`dsh:apps/cli/tests/web-agent-presets.e2e.ts:212`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:132`、`dsh:packages/bundle/web-app/cordis.patch.yml:334`
- **建議**：分三格做。(a) ask-user、submit-record 直接改成 cordis.yml 的列：它們有 default export，也沒有掛載條件；要不要設成受保護列另外決定。(b) sandbox-policy 把「沒有 fence 就不貢獻」搬進 plugin：services.use 改成 services.get，缺 sandboxPolicy 服務時什麼都不做，照 dsh tool-str-replace-editor 的寫法，這樣它也能是一列。(c) workspace-changes 的根改從 host 服務取（同 sandboxPolicy.rootDir）；「只有 serve」則照 dsh 把 web-app 疊在 base 上的形狀，給 serve 一層自己的出貨 overlay。host-services 留在程式碼，它本來就是組裝點交出協作者的那個條目。做完之後，cordis.yml 的「唯一來源」與 dump 那兩句才成立；在那之前，至少先把這兩句改成實情。
- **偏離說明**：(a)(b) 表達得出來，不需要登記。(c) 的「只有 serve」如果不做 serve 專屬 overlay、繼續留在程式碼，就要登記偏離：我方是一份 cordis.yml 給兩個入口，dsh 是 web-app bundle 疊在 base 上。留在程式碼不是因為基礎建設表達不出來（serve 可以多疊一層），要照實寫成刻意選擇。README 的「patch 也關不掉」目前沒有對 dsh 的偏離登記，要嘛照 (a) 做，要嘛補登記。
- **既有追蹤**：專卡 #669（盤點後開）。盤點當時：母題是 #46（開，地圖：照 dsh 建部署設定層；決議 09-19 第 12 題「組合是資料」）。README 把「開箱就有、patch 關不掉」寫成刻意，但沒有偏離登記；沒有專卡。
- **證據**：`apps/harness/src/cli.ts:881`、`apps/harness/src/cli.ts:882`、`apps/harness/src/cli.ts:886`、`apps/harness/src/cli.ts:887`、`packages/nexus-plugin-ask-user/src/index.ts:255`
- **否定搜尋**：/usr/bin/grep -n "ask-user\|submit-record\|sandbox-policy\|workspace-changes\|host-services\|組裝點" apps/harness/cordis.yml （只命中 *-invariant 列與註解，沒有功能列）；（dsh）git grep -n "dsh-tool-ask-user" -- '*.yml' '*.yaml' '*.ts' '*.mts' '*.js' '*.json' | grep -v "package.json\|README\|pnpm-lock" （出廠 profile 只有 web-app 的 standard／ptc／cordis 三個 preset；其餘是測試快照、工具目錄產生器與 tsconfig 路徑）；git grep -n "export default" -- packages/nexus-plugin-ask-user/src/index.ts packages/nexus-plugin-submit-record/src/index.ts packages/nexus-plugin-sandbox-policy/src/index.ts packages/nexus-plugin-workspace-changes/src/i
- **驗證意見**：逐條核實，都成立：cordis.yml:3 與 :17 的兩句宣稱，對程式碼掛的那幾顆不成立，因為 renderDefaultConfigDump 只渲染設定檔那幾層（plugin-config.ts:927）；ask-user 與 submit-record 已有 default export（:255、:281）；README.md:33 把「關不掉」寫成刻意，是 PR #503 加的，PR 內文沒有提到偏離登記；#454 的 triage（issue 內文）寫過「ask-user、submit-record、sandbox-policy 在 #459 之後才能進 YAML」，#459 關了之後沒有人回頭做；submit-record-mounts.test.ts:17 給的掛在程式碼的理由（要拿這次呼叫的 backend）在 #459 之後已不成立。dsh 核過：e2e :212 明文每個模型看得到的工具都屬於某個 preset；

#### hcr-r2-05　組裝根的模型接縫只開在 HTTP 層，要腳本化回合的測試改為手抄組裝根

- **類型**：測試越過介面｜**歸屬**：dev-harness｜**驗證**：保留（原判 中 → 中）
- **呼叫者必須知道、介面沒表達的事**：createCliAgent 在非 live 時固定用 CLI_SCRIPT。要換模型只有一條路：--live 加上把 live-model 列指到一個 OpenAI 相容的 loopback 端點。這個端點要會串流（serve）與非串流（CLI）兩種形狀，要吐得出 tool_calls，每次回應的 id 也要不同。in-process 的 ScriptedChatModel 接不進去。
- **說明**：介面就是測試面。組裝根其實有模型接縫：settings/live-model.test.ts 用 runCli 與 runServe 各打過一次 loopback 假端點。但這條接縫開在 HTTP 層，替身要自己寫一個 OpenAI 相容伺服器（該檔的假端點只會回一句「好」，不發工具呼叫）。樹上現成的 ScriptedChatModel 是 in-process 的，接不進組裝根。結果是：apps/harness/src 有 8 個需要腳本化工具回合的測試檔，自己用 createNexusAgent 加 createHostServicesPlugin 手搭組裝，其中 sandbox-escalation 與 subagent-sandbox 明寫「照 cli.ts 的接法組起來」。其中 4 檔（deliverable-files、sandbox-escalation、sandbox-mode、workspace-changes）同一檔裡也呼叫 createCliAgent，但只用來量結構，例如模型綁到的工具清單；真正跑回合的案例都在手搭組裝上。手搭版可以只掛 submit-record 不掛 ask-user、不給 checkpointer、不走出貨清單，和產品組裝之間沒有任何東西保證同形。哪天 createCliAgent 改了協作者或掛載條件，這些回合測試照樣綠。
- **dsh 的形狀**：dsh 的 e2e「Boot the shipped Web composition, minus the rows that would bind a port」，並明寫「Everything that decides an agent's capabilities is the real thing, including both shipped presets」。測試走真的出廠組裝，只用 patch 關掉有副作用的列，不手抄組裝。　`dsh:apps/cli/tests/web-agent-presets.e2e.ts:58`、`dsh:apps/cli/tests/web-agent-presets.e2e.ts:60`
- **建議**：在組裝根上開一個 in-process 的模型接縫：選填的 model 參數，或把模型當成 host 服務由組裝點提供。這樣 ScriptedChatModel 就能直接交給 createCliAgent（或 hcr-r2-04 的組裝模組），8 個手搭測試改走它，只替換模型與 workspace；需要「不掛某一顆」的測試改用 patch 停用那一列，照 dsh bootWeb 的形狀。HTTP 那條接縫保留給要量真實 ChatOpenAI 轉換的測試，那正是它現在的用途。hcr-r2-03 做完之後收益最大：協作者變成資料列，測試用 patch 就能改組合。
- **偏離說明**：不需要偏離登記。in-process 的模型接縫在我方表達得出來。
- **既有追蹤**：專卡 #670（盤點後開）。盤點當時：記憶「驗收要量交付物不要量相似品」是同一類教訓。沒有卡，SRP 盤點裡也沒有。
- **證據**：`apps/harness/src/cli.ts:708`、`apps/harness/src/sandbox-escalation.test.ts:119`、`apps/harness/src/subagent-sandbox.test.ts:150`、`apps/harness/src/submit-record-sandbox.test.ts:78`、`apps/harness/src/sandbox-escalation.test.ts:153`
- **否定搜尋**：git grep -ln "createHostServicesPlugin" -- 'apps/harness/src/*.test.ts' （8 檔：deliverable-files、present-tool、sandbox-escalation、sandbox-mode、subagent-sandbox、submit-record-sandbox、submit-record-wire、workspace-changes）；for f in <上述 8 檔>; do grep -c 'ScriptedChatModel\|FakeChatModel\|fakeModel\|turns:' $f; grep -c 'createServer' $f; grep -c 'createCliAgent\|runCli(' $f; done （8 檔都用腳本模型、都沒起假端點；deliverable-files、sandbox-escalation、sandbox；for f in $(git grep -l "chat/completions\|createServer\|baseURL\|NEXUS_LIVE\|OPENAI_BASE_URL\|live: true\|--live" -- 'apps/harness/src/*.test.ts' 'apps/harness/src/**/*.test.ts'); do grep -c 'createCliAgent\|runCli(' $f;；git grep -n "照 \`cli.ts\` 的接法" -- 'apps/harness/src/*.test.ts'
- **驗證意見**：獨立重數過：createHostServicesPlugin 出現在 8 個測試檔，全都用 ScriptedChatModel、都沒起假端點。其中 4 檔也呼叫 createCliAgent，但只量結構（例如 workspace-changes.test.ts:463／483 只看掛不掛、是不是同一份）。樹上還有一個原文沒引的現成實例：deliverable-files.test.ts:305-308 寫明，因為 CLI_SCRIPT 換不掉，serve 那條交付接線在產品路徑上觀察不到；實測刪掉 serve.ts 的 deliverableLimits 那一行，全套照樣綠，事後只能補結構性檢查。這就是「改一處會無聲弄壞另一處」的實例，所以 中 站得住。dsh_shape 屬實但不完整。

#### core-mw-model-01　提醒器的清零判準是 core 裡一張寫死的記號白名單，而且在 goal 續行輪上跟 dsh 相反

- **類型**：缺接縫（兩種變體寫死）｜**歸屬**：dev-harness｜**驗證**：保留（原判 中 → 中）
- **呼叫者必須知道、介面沒表達的事**：一則 HumanMessage 進圖後會不會把重複鏈清零，取決於它的 additional_kwargs 裡有沒有 core 認得的兩顆記號之一。插件在輪中注入的訊息得回頭改 core 的 isSynthetic 才不會清零；goal 續行輪的頭是素的 HumanMessage，一律清零。這兩件事型別與插件介面都看不出來。
- **說明**：repeat-reminder.ts 用 isSynthetic 判斷「這是人插了話嗎」，只認 REPEAT_REMINDER_MARKER 與 GOAL_WRAPUP_MARKER 兩顆記號。後者的生產者是 plugin-goal，記號卻住在 core 的提醒器檔裡，檔內明寫新的合成來源要加在這支述詞。plugin-agent-instructions 已經有第三顆記號，不在白名單上，今天無害只因它剛好落在輪頭。 更實際的一格：goal 續行輪的頭在三條路上都是素的 HumanMessage，所以都會清零，檔頭把這寫成「對的」。三條路是 serve 的 thread-pump、CLI 經 toAgentInvocation、續接重建的 conversation-replay。dsh 的做法相反：續行輪訊息帶 source.kind 'goal'，提醒器只在 source.kind 是 'user' 時清零。後果是一個模型在每個續行輪各重複同一個失敗呼叫兩次，在 dsh 會在第 3 次拿到提醒，在我們這邊永遠拿不到，而續行打轉正是提醒器要擋的情境。 離線掃描 session-scan.ts 用另一種形狀重寫了清零判準（看 turn/start 的 kind），今天剛好與圖內一致；session-scan.test.ts 把「續行輪次的頭也清零」釘成規格。 這不是已登記的偏離。
- **dsh 的形狀**：dsh 每則訊息都帶 source，而 MessageSourceMap 是可宣告合併的聯集：每個生產者在自己的模組宣告自己的 kind，agent-instructions、repeat-tool-reminder、goal 各有一種。提醒器在 agent/pre-step 只看這一步新領走的訊息（claimed），其中有 source.kind === 'user' 才刪掉這個 agent 的鏈。goal-round-driver 的續行訊息帶 { kind: 'goal', … }，不清零。讀者端沒有任何白名單，新生產者不必改提醒器。　`dsh:packages/guard/repeat-tool-reminder/src/index.ts:237`、`dsh:packages/goal/goal-round-driver/src/index.ts:178`、`dsh:packages/core/agent-loop/src/agent.ts:277`
- **建議**：照 dsh 把判準翻成「由生產者宣告來源、讀者只認 user」： 1. 圖內的合成 HumanMessage 在 additional_kwargs 帶一格通用來源，形狀對齊日誌 user/message 已有的 source，由生產者自己蓋。isSynthetic 改成「有來源且 kind 不是 user」；GOAL_WRAPUP_MARKER 的讀取拿掉，記號回到 plugin-goal 或併進通用來源。 2. goal 續行輪的頭蓋上 goal 來源，thread-pump、CLI 的 toAgentInvocation 路徑、conversation-replay 三處同批改，否則 resume 之後又分岔。 3. session-scan 改成只在 turn/start{kind:'message'} 清零，並把 session-scan.test.ts「續行輪次的頭也清零」那條絆索翻面。 自然落點是 #638（續行走送出佇列）或 #445 之前。
- **偏離說明**：沒有可引的「表達不出來」。LangChain 的 HumanMessage 沒有 source 欄位，但 additional_kwargs 表達得出來，今天的兩顆記號就放在那裡。所以現狀是未登記的偏離：檔頭主張續行輪清零「是對的」，沒有引 dsh。
- **既有追蹤**：專卡 #662（盤點後開，擋住 #445）。盤點當時：未見追蹤（issue 標題、已合併 PR、.docs 與 docs 否定掃描見 negative_greps）。相關：#445（開著，serve 預設開續行，開了之後分岔進零設定路徑）、#638（開著，續行走送出佇列，修正的自然落點）、#147（已關，提醒器本身）。
- **證據**：`packages/nexus-core/src/repeat-reminder.ts:326`、`packages/nexus-core/src/repeat-reminder.ts:377`、`packages/nexus-core/src/repeat-reminder.ts:111`、`packages/nexus-core/src/repeat-reminder.ts:319`、`packages/nexus-core/src/repeat-reminder.ts:108`
- **否定搜尋**：python3 掃 scratchpad/issues.json 標題：/清零|提醒|source\.kind|GOAL_WRAPUP|isSynthetic|repeat/ → 只有 #147；python3 掃 scratchpad/prs-merged.json：/清零|提醒|source\.kind|GOAL_WRAPUP|isSynthetic|TokenAnchorBook|錨定|repeat/ → 只有 #157、#512、#513（提醒器本身與其設定）與 #589／#568（錨定，無關清零）；grep -rn -E "清零|source\.kind|isSynthetic|GOAL_WRAPUP|repeat-tool-reminder|提醒器" .docs/*.md docs/*.md → 只有功能盤點列，沒有追蹤續行輪清零的條目；git grep -n -E "new HumanMessage\(|HumanMessage\.fromJSON|role: ?'user'|type: ?'human'" -- 'packages/*/src/*.ts' 'apps/harness/src/*.ts' 'apps/harness/src/**/*.ts'（排除 .test.ts）→ 生產者只有 messages.ts、thread-pump.ts、conversat（另有 1 條）
- **驗證意見**：我自己重推一次，結論成立，兩半分開判。 （一）白名單那半。isSynthetic 只認 REPEAT_REMINDER_MARKER 與 GOAL_WRAPUP_MARKER，白名單外的 HumanMessage 一律清零。plugin-agent-instructions 的第三顆記號不在白名單上。我讀了它的注入時刻：beforeAgent，每次 invoke 一次，而且只在有效串裡沒有基線時才注入，所以一定緊接在輪頭之後，今天無害。基座 deepagents@1.13.1 的合成 HumanMessage 也逐一查過：lc_evicted_to 是 beforeAgent 原地換掉最後一則（同 id），摘要訊息 lc_source:summarization 只出現在有效串、不進 state.messages，都不在輪中。未來有插件在輪中注入 HumanMessage 時，鏈會被無聲清零，沒有測試會紅。 finder 的 deviation_note 要更正。

### 嚴重度：低（27）

#### core-plugin-system-r2-N1　trackUndo 漏包 middleware.useWithBackend：回滾後留下孤兒，訊息卻說已全數撤銷

- **類型**：隱性耦合（無相依邊）｜**歸屬**：dev-harness｜**驗證**：保留（原判 中 → 低）
- **呼叫者必須知道、介面沒表達的事**：trackUndo 必須逐一鏡像 registry 上每一個會回傳 undo、給 plugin 用的註冊方法。registry 新增一個這種方法時，型別和測試都不會提醒 load.ts 要跟著包。
- **dsh 的形狀**：dsh 由每個註冊方法自己透過 layers.effect(ctx, action, {label}) 把 undo 掛到註冊者的 context 上（store.ts:220、:233 的 ctx.effect），例如 tools.register 走 layer => layer.tools.insert(...)，並帶 label 'tools.register()'。沒有外部鏡像表，新增註冊方法時，undo 的歸屬自動成立。　`dsh:packages/core/scope/src/store.ts:220`、`dsh:packages/core/scope/src/store.ts:233`
- **建議**：照 dsh「undo 由註冊點自己掛到註冊者」的形狀改：在 createRegistry 內，以 enter(origin) 設定的 current origin 為鍵，讓每個註冊方法（今天都已呼叫 requireOrigin）把回傳的 undo 推進該 origin 的堆疊，並提供內部的 rollback(origin)。loadPlugins 失敗時呼叫它，然後刪掉 trackUndo。 若先止血： - trackUndo 補上 useWithBackend。
- **追蹤**：專卡 #677（盤點後開）。
- **證據**：`packages/nexus-core/src/load.ts:189`、`packages/nexus-core/src/load.ts:141`、`packages/nexus-core/src/load.ts:146`
- **否定搜尋**：git grep -n useWithBackend -- packages/nexus-core/src/load.ts packages/nexus-core/src/load.test.ts：0 筆；git grep -n useWithBackend -- .：只出現在 fold.ts、fold.test.ts、registry.ts、sandbox.ts、nexus-plugin-agent-instructions、nexus-plugin-present 與 plan-mode／present 的測試，沒有任何回滾測試（另有 3 條）
- **驗證意見**：耦合是真的，推翻不了，但嚴重度從「中」降為「低」。 一、耦合是真的。 - trackUndo 對 middleware 只包了 use（load.ts:189），其餘方法由 `...registry.middleware`（:188）原樣展開轉發，所以 useWithBackend 繞過 remember。 - 型別照樣滿足，tsc 抓不到。 - 貪婪回滾測試（load.test.ts:317）只呼叫 use，結構上也抓不到。 二、獨立探針重現。 - 用 vitest 直接呼叫 worktree 的 loadPlugins：plugin 依序呼叫 use、useWithBackend 後拋錯。

#### core-plugin-system-r2-N3　停用視圖以不唯一的 NexusPlugin.name 當開關：一列同名停用列就能關掉開著的那列

- **類型**：介面外的事實（順序／狀態／設定／錯誤模式）｜**歸屬**：dev-harness｜**驗證**：保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：disabledEntries.has(name) 回答的是「有沒有任何一列被關的條目叫這個名字」，fold 卻把它當成「這個功能被關了」。同名的另一列開著也不算數，而 NexusPlugin.name 明文不唯一。
- **dsh 的形狀**：dsh 的停用是逐條目的：Entry.refresh 一開頭就是 if (this.disabled) return（vendor/loader/src/config/entry.ts:111）。disabled 是「這一列或它的父列」的性質（:73），不會波及同一顆 plugin 的另一列。「關掉」的意思是樹上沒有開著的那一列：fs-observation-policy 的檔頭說，沒有這顆 plugin，工具就保留無條件改寫。　`dsh:vendor/loader/src/config/entry.ts:111`、`dsh:vendor/loader/src/config/entry.ts:73`
- **建議**：照 dsh 的逐條目語意，改問「有沒有開著的那一列」：load 同時記下開著的掛載（或由 registry 提供 enabled(name)），fold 的三態／兩態改成「沒有任何開著的同名列，且有被關的列」才視為關掉。 另一個做法是把鍵從字串 name 換成 plugin 物件的身分：core 自己那幾顆是單例常數，可以用參考相等比對，無關的 plugin 撞名就關不掉 core 的功能。 不論選哪個，都順手修掉 plugin.ts:55「唯一用途是錯誤訊息指名」這句已經不成立的說明。
- **追蹤**：專卡 #678（盤點後開）。
- **證據**：`packages/nexus-core/src/registry.ts:813`、`packages/nexus-core/src/registry.ts:1249`、`packages/nexus-core/src/load.ts:69`
- **否定搜尋**：git grep -n disabledEntries -- apps packages（排除測試與註解）：消費點只有 fold.ts:951、:1036、:1071、:1115、:1132、:1155；git grep -n -E 'enabledEntries|enabledNames|mountedNames' -- packages apps：0 筆，沒有「開著的掛載」這種視圖（另有 2 條）
- **驗證意見**：判 confirmed，嚴重度維持「低」，但兩個建議選項只有一個合規。 一、耦合是真的。 - load.ts:69 只記被關的那一半（markDisabled(plugin.name)）。 - 開著的 core 條目 apply 是空的，不留任何痕跡（model-usage.ts:221、observation.ts:347、session-checkpoint-policy.ts:136 都寫「承重的空」）。 - 所以三態、兩態那三格（fold.ts:1071、:1115、:1132）只看得到「有沒有被關的列叫這個名字」。

#### core-session-F2　封閉詞彙把領域型別拉進 core，三份檔頭的理由互相矛盾，也沒登記成偏離

- **類型**：相依方向｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 中 → 低）
- **呼叫者必須知道、介面沒表達的事**：core 的 SessionEventMap 必須知道每個 plugin 的酬載型別，所以每個領域的型別都得搬進 @nexus/core；加一個 plugin 事件就要改 core。
- **dsh 的形狀**：dsh 的 SessionEventType = keyof SessionEventMap。todo、workspace-changes 各自在自己的 types.ts 以 declare module '@deepseek-ai/dsh-session/types' 補事件種類，workspace-changes 的 DTO 也宣告在同一個 types.ts；　`dsh:packages/core/session/src/types.ts:431`、`dsh:packages/todo/tool-todo/src/types.ts:28`
- **建議**：一致原則（同時回應 core-session-04 與 plugins-capability-01）：型別歸生產它、對它語意負責的套件，事件酬載與 DTO 都一樣；core 只提供可合併的擴充點；消費者以 type-only 從生產者的 /types 子路徑拿。照這個原則，(1) SessionEventType 改成 keyof SessionEventMap，各 plugin 用 declare module '@nexus/core' 補自己的事件，做法與 NexusServices 相同；
- **追蹤**：專卡 #679（盤點後開）。卡照驗證的更正改了主軸：三份檔頭講的是同一件事，毛病在它們指向的理由找不到出處，以及 todo.ts 把它定性成「不是偏離」。
- **證據**：`packages/nexus-core/src/session-log.ts:145`、`packages/nexus-core/src/session-log.ts:192`、`packages/nexus-core/src/session-log.ts:44`
- **否定搜尋**：git grep -n "keyof SessionEventMap"；git grep -n -E "declare module ['\"]@nexus/"（另有 2 條）
- **驗證意見**：耦合是真的：core 的 SessionEventMap 引入 todo、goal、deliverables 等領域型別。dsh 形狀也核過：keyof SessionEventMap、todo 在自己的套件以 declare module 補 todo/write、isFeedback 的 switch 走 default: false。NexusServices 的 6 處合併先例屬實（`git grep -n -A3 "declare module '@nexus/core'" -- packages apps` 找到 6 處，全是 NexusServices）。

#### core-session-F3　LoggedMessage 是淺模組：4 個讀方各自伸進 data 重寫取文字、取 id、取 finish_reason

- **類型**：淺模組｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 中 → 低）
- **呼叫者必須知道、介面沒表達的事**：讀方必須知道 data.content 在執行期可能是字串，也可能是 v1 區塊陣列（text、reasoning 等），而 response_metadata 的 finish_reason 形狀隨 provider 而變；這些都不在 LoggedMessage 的型別上。
- **dsh 的形狀**：dsh 的訊息是自己的型別，content 是 readonly ContentBlock[]；讀 content 的 helper（例如 contentHasImage）住在型別擁有者 llm 套件的 content.ts。（⚠ 驗證者判此描述不被 dsh 原始碼完整支持）　`dsh:packages/llm/llm/src/message.ts:142`、`dsh:packages/llm/llm/src/content.ts:126`
- **建議**：讓 logged-message.ts 變深：加 loggedMessageText（字串或 text 塊）、loggedMessageReasoning、loggedMessageFinishReason，並把 loggedMessageId 從 feedback.ts 搬過來；4 個讀方改用這些 helper。LoggedMessage = StoredMessage 這個已登記的偏離保留（換掉訊息型別不在這條的射程內），只把「怎麼讀」收回型別的擁有者旁邊。
- **追蹤**：專卡 #680（盤點後開）。取 id、取 finish_reason 已各有單一 helper，卡收窄成修正 content 的型別，再加一個收窄的讀法。
- **證據**：`packages/nexus-core/src/logged-message.ts:39`、`packages/nexus-core/src/logged-message.ts:18`、`packages/nexus-core/src/feedback.ts:218`
- **否定搜尋**：git grep -n "mapStoredMessagesToChatMessages\|mapChatMessagesToStoredMessages\|StoredMessage\b"；git grep -n -E "\.data\.content" -- packages apps ':!*.test.ts' ':!*.test.tsx'
- **驗證意見**：逐一核對「4 個讀方各自重寫取文字、取 id、取 finish_reason」這句，大半不成立。取 id：loggedMessageId 已經是 core 匯出的單一 helper，plugin-feedback 與 harness 的 conversation-history 都共用它，沒有人重寫（`git grep -n loggedMessageId -- packages apps ':!*.test.ts'`）。

#### core-session-F4　conversation-replay 用 default: break 靜默略過新種類；「哪些種類進模型」只寫在散文裡

- **類型**：隱性耦合（無相依邊）｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 高 → 低）
- **呼叫者必須知道、介面沒表達的事**：新增一種「應該進模型」的事件時，作者必須記得去改 conversation-replay 的 switch；不改的話續接後模型會靜默少掉那些內容，型別與窮舉絆索都不會紅。
- **dsh 的形狀**：dsh 在型別上定義 SurfaceEventType（system／developer／user／assistant 的 message 與 tool/result），SessionEvent 對這些種類在型別層強制帶 surfaceOp；另有由生成器產出的 MESSAGE_PROJECTION_EVENT_TYPES。（⚠ 驗證者判此描述不被 dsh 原始碼完整支持）　`dsh:packages/core/session/src/types.ts:439`、`dsh:packages/core/session/src/types.ts:512`
- **建議**：在 session-log.ts 定義 ModelVisibleEventType（或照 dsh 叫 SurfaceEventType）這個子聯集，把散文表變成型別；replay 對這個子聯集做窮舉（例如 switch 後以 never 斷言），其他種類再落進 default。要順帶對 Record<SessionEventType, …> 的讀方加一條「屬於 ModelVisibleEventType 的一定被 replay 處理」的測試。surfaceOp 那一軸不必一起做。
- **追蹤**：專卡 #681（盤點後開）。
- **證據**：`packages/nexus-core/src/conversation-replay.ts:279`、`packages/nexus-core/src/conversation-replay.ts:9`、`packages/nexus-core/src/session-log.ts:31`
- **否定搜尋**：git grep -n "Record<SessionEventType"；git grep -n "SessionEventType\[\]\|readonly SessionEventType\|Set<SessionEventType\|Map<SessionEventType\|in SessionEventType\|Exhaustive\|extends (typeof KNOWN"（另有 4 條）
- **驗證意見**：我方 replay 的 default: break 會靜默略過未列出的種類，這一點屬實；還原測試是逐情境的（describe('每一種產訊息的事件')），不是窮舉。但 dsh 自己也是同一個形狀：deriveEventMessage 註解明寫「Intentionally non-exhaustive」，default 回 null，還寫了「Merge-extensible union: no assertNever here」。依規則，照標準本來就這樣，判 weakened。dsh_shape 有兩處不準。

#### core-session-F6　邏輯輪（往回找第一顆不是 resume 的 turn/start）沒有擁有者，至少 7 份實作

- **類型**：介面外的事實（順序／狀態／設定／錯誤模式）｜**歸屬**：dev-harness｜**驗證**：保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：一筆事件屬於哪一輪，要讀方自己由 seq 往回找最近一顆 kind 不是 resume 的 turn/start；resume 不開新輪這條規則不在型別上，也沒有共用的函式。
- **dsh 的形狀**：dsh 的 turn/start 酬載直接帶輪號 { turn: number }，agent-loop 另外註冊一個 turnBoundary 投影作為輪邊界的單一擁有者。　`dsh:packages/core/session/src/types.ts:288`、`dsh:packages/core/agent-loop/src/index.ts:364`
- **建議**：短期：在 session-log.ts 的 currentTurnStart 旁邊加一個 logicalTurnStart（或 isLogicalTurnStart 述詞），7 處改用它。長期照 dsh 讓 turn/start 帶輪號，讀方直接讀欄位，不再往回找。
- **追蹤**：專卡 #682（盤點後開）。重數後要收的拷貝是 7 份。
- **證據**：`packages/nexus-core/src/session-log.ts:651`、`packages/nexus-core/src/feedback.ts:263`、`apps/harness/src/conversation-history.ts:148`
- **否定搜尋**：git grep -n -E "kind (!==|===) 'resume'" -- packages apps ':!*.test.ts' ':!*.test.tsx'
- **驗證意見**：成立，嚴重度維持低。`git grep -n -E "kind (!==|===) 'resume'" -- packages apps ':!*.test.ts' ':!*.test.tsx'` 核過 7 處邏輯輪述詞：feedback、conversation-history 兩處、session-stats、session-scan、session-draft、workspace-changes invariant。物理輪有 currentTurnStart 這個單一擁有者，邏輯輪沒有。要修正三點。

#### wire-seam-r2-03　單向鏡像斷言的註解宣稱擋得住「多一格」，實際擋不住

- **類型**：其他｜**歸屬**：dev-harness｜**驗證**：保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：`const _descriptorFitsTheWire: SlashDescriptor = {} as CommandDescriptor;` 只保證 CommandDescriptor 可以指派給 SlashDescriptor。CommandDescriptor 多一個欄位時照樣可以指派（多餘屬性檢查只作用在新鮮的物件字面值上），所以註解說的「多一格那一刻編不過」這個保證並不存在。
- **dsh 的形狀**：dsh 在程式碼層不做鏡像：UI 直接 import type domain 套件的型別（例如 ui-user-questions 的 contract/slots.ts 從 '@deepseek-ai/dsh-user-questions' 拿），沒有第二份需要比對。　`dsh:scripts/verify-type-equiv.ts:2`、`dsh:packages/client/ui-user-questions/src/client/contract/slots.ts:8`
- **建議**：把單向斷言換成完全相等的檢查：對要上線的欄位做雙向可指派，或用 Equals<A, B> 型別（必要時先 Omit 刻意不上線的欄位），像分類那組一樣。若刻意只要求「wire 是 core 的子集」，就把註解改成它實際保證的事，並刪掉與 slash.list 回應建構重複的那條。FeedbackItem 同樣處理。若照 dsh 讓 web 直接型別相依（見 wire-seam-r2-01），這組鏡像可以整個拿掉。
- **追蹤**：專卡 #683（盤點後開）。
- **證據**：`apps/harness/src/wire-handler.ts:114`、`apps/harness/src/wire-handler.ts:110`、`apps/harness/src/wire-handler.ts:991`
- **驗證意見**：tsc 探針實測（work 目錄 probe.ts，--strict）：`const x: Wire = {} as CoreMore` 在來源多一格時不報錯，只有少一格報 TS2741。所以 wire-handler.ts:111 的「那一刻編不過」不成立；client.ts 的 readDescriptors 會逐格重建，多出的欄位靜默丟掉。同一段 :119 的作者自己知道「只釘一邊會安靜地通過」，分類那組是雙向，描述子與 FeedbackItem 沒照做。:991 的 SlashListResult 建構已做同一方向的檢查，:114 那條是重複。

#### wire-seam-r2-04　五條 GET 路由只共享路徑，查詢參數、狀態碼與回應驗證兩端各寫一份

- **類型**：淺模組｜**歸屬**：兩邊｜**驗證**：降級保留（原判 高 → 低）
- **呼叫者必須知道、介面沒表達的事**：changes/{summary,diff} 與 deliverables/{file,download,bytes} 的呼叫者必須知道：查詢參數名與格式（?seq=、?index=…）、每個拒絕理由對到哪個 HTTP 狀態碼（例如 not-text 對 422）、回應 body 的形狀。wire 只匯出路徑函式與 DTO，狀態碼只寫在 deliverables.ts 的散文裡；
- **dsh 的形狀**：changes 路由：ui-deliverables/src/changes.ts 一份模組同時給 server 與 client——含查詢參數的 URL builder（changesSummaryUrl 用 URLSearchParams 帶 sessionId 與 seq）與回應 validator（isChangesSummary）；　`dsh:packages/client/ui-deliverables/src/changes.ts:111`、`dsh:packages/client/ui-deliverables/src/changes.ts:112`
- **建議**：加深 wire 的路由模組，讓它吸收契約而不只是路徑：(1) 每條 GET 一個含查詢參數的 URL builder（照 dsh 的 changes.ts），harness 的解析與 web 的拼接共用同一組參數名；(2) 拒絕理由對狀態碼的 `Record<DeliverableRefusal, number>` 搬進 wire，harness 用它回應、web 用反查表判讀——或照 dsh 在回應 body 帶理由碼，web 比碼不比狀態碼；(3) 回應 validator（isChangesSummary 等）放進 wire，兩端共用；
- **追蹤**：專卡 #684（盤點後開）。交付檔三條的 builder 與 validator 等讀檔載體拍板；把狀態碼表搬進 wire、把 GET 包進 WireClient 超出 dsh，卡裡寫明不做。
- **證據**：`packages/nexus-wire/src/workspace-changes.ts:110`、`packages/nexus-wire/src/deliverables.ts:115`、`apps/harness/src/wire-handler.ts:409`
- **否定搜尋**：git grep -n "createChangesSummaryStore\|createChangesDiffStore\|createDeliverableFileStore\|createDeliverableDownload\|failureOf" -- apps/harness packages（零命中：沒有測試跨接 web 的路由 store 與真 handler）；git grep -n "createWireHandler\|startWireServer\|@nexus/harness" -- apps/web（只有註解）（另有 2 條）
- **驗證意見**：dsh_shape 寫的每一句都有原始碼支撐，所以 dsh_shape_ok 填 true；但它只講了對 finding 有利的那一半。dsh 的 changes.ts 確實共用路徑常數、client 端含查詢參數的 URL builder 與回應 validator；但 dsh 自己的 GET 路由有同一種耦合：server 端 present-open.ts 逐條路由手解 query.get('seq')／'index'（三處，沒有共用 parser）；

#### wire-seam-r2-05　custom 事件名沒有一份清單，pump 送什麼與 reduceCustom 認什麼各寫各的

- **類型**：介面外的事實（順序／狀態／設定／錯誤模式）｜**歸屬**：兩邊｜**驗證**：降級保留（原判 中 → 低）
- **呼叫者必須知道、介面沒表達的事**：下行 custom frame 的 name 是開放字串。reduceCustom 只認 deliverables、workspace changes、model usage、CONTEXT_MEASURE、TODOS、TOKEN_USAGE、SESSION_STATS 這幾個，其他名字靜默略過。生產者（pump 與歷史投影）多送一個名字時，沒有任何型別或清單會提醒消費端要接。
- **dsh 的形狀**：dsh 的 UI 事件逐種註冊（ui-chat 的 register.ts 呼叫 registerInboxConversationNodes(ctx)），另外替沒人認領的事件註冊 fallback：`ctx.uiConversation.events.registerFallback(unknownFallbackDefinition)`，match 條件是 `event.type !== 'assistant/live-chunk'…　`dsh:packages/client/ui-chat/src/client/conversation-nodes/fallback.ts:40`、`dsh:packages/client/ui-chat/src/client/conversation-nodes/fallback.ts:19`
- **建議**：(1) 短期照 #645 Q1：dev-harness 先在 wire 補 inbox 的折疊，web 再照那張卡改泡泡的時機。(2) 通用：在 wire 立一份「custom 名字 → payload 型別」的對照（例如 CustomPayloads），pump 與 conversation-history 的 custom frame 建構子只收這份的鍵，reduceCustom 對它做窮舉檢查，新名字一加，折疊器那裡就編不過。
- **追蹤**：專卡 #685（盤點後開）。短期那一半（wire 折疊 inbox）已由 #646 落地，卡只做「名字→酬載一張表」那一半。
- **證據**：`packages/nexus-wire/src/conversation.ts:618`、`packages/nexus-wire/src/conversation.ts:630`、`apps/harness/src/thread-pump.ts:1243`
- **否定搜尋**：git grep -n -i "inbox\|claimed\|WireQueuedInput\|queueUpdate\|queue_item\|QUEUE_" -- apps/web/src（非測試檔零命中）；git grep -n "INBOX\b\|InboxPayload\|'inbox'" -- apps/web/src packages/nexus-wire/src apps/harness/src/thread-pump.ts（生產者在 pump，wire 只有常數與型別，web 零命中）
- **驗證意見**：分兩半。INBOX 那半在 70357bb 屬實（conversation.ts:630 的 reduceCustom 沒有 INBOX），但它不是意外漏接，而是分階段落地：#637 先落伺服器（PR #639、#641），#645 明寫 web 那側另做。快照後都補上了：#645 已 CLOSED，PR #646（2026-09-25T16:48Z）在 wire 補了 inbox 折疊，PR #648 拿掉 use-conversation 送出當下的 appendHumanTurn；PR #649 加 TITLE 時也同一張 PR 補了 reduceTitle。

#### plugins-interaction-r2-01　送出佇列開跑時把 turn/start.kind 寫死成 message，#638 一加續行來源，goal 授權與輪次計數會無聲失效

- **類型**：介面外的事實（順序／狀態／設定／錯誤模式）｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 高 → 低）
- **呼叫者必須知道、介面沒表達的事**：goal 的直接人類授權（hasDirectHumanTurn）與輪次計數（fold 推進 roundsStarted）都靠入口點寫進 turn/start 的 kind 分辨「人」與「續行」；佇列的件帶著 source，但開跑時 kind 不是由 source 推出來的，而是寫死的 'message'。「source 決定 kind」只寫在 inbox.ts 的註解裡，型別與測試都沒有表達。
- **dsh 的形狀**：dsh 的續行本來就走收件匣：goal-round-driver 建一則 source 為 {kind:'goal', goalId, revision, round} 的 user 訊息，用 agent.followup 排進 next-turn；判別欄跟著訊息本身走。　`dsh:packages/goal/goal-round-driver/src/index.ts:178`、`dsh:packages/goal/goal-round-driver/src/index.ts:192`
- **建議**：#638 動工時，#runQueued 的 turn/start 要由 item.source 推導：寫成對 source.kind 的窮舉 switch 加 never 分支，讓 QueuedInputSource 一加成員就在 #runQueued 當場編不過，而不是只在 wire 投影那裡紅。配一條正面測試：佇列裡一件 goal 來源的件開跑後，日誌上的 turn/start 是 kind 'goal'、hasDirectHumanTurn 為假、roundsStarted 前進一格。
- **追蹤**：專卡 #686（盤點後開）。「無聲失效」被驗證推翻：goal-driver-pump.test.ts 釘著續行輪的 kind 與輪次計數。卡改成不改行為的 refactor。
- **證據**：`apps/harness/src/thread-pump.ts:1229`、`packages/nexus-core/src/inbox.ts:27`、`packages/nexus-core/src/inbox.ts:25`
- **否定搜尋**：git grep -n -E "QueuedInputSource|\.source\.kind|item\.source|source: \{ kind" -- apps packages ':!*.md'；git grep -n -E "#runOnce\(\{ kind:" -- apps/harness/src/thread-pump.ts
- **驗證意見**：耦合的事實屬實：#runQueued 把 kind 寫死成 'message'，沒有讀 item.source。#637 的拍板規格（「開跑時 turn/start 的 kind 由 source 決定，授權的判別不變」）與 inbox.ts 檔頭寫的都是由 source 決定，實作確實沒照做。但發現的核心主張「無聲失效、沒有測試會紅」被推翻，理由有三：(1) 今天 QueuedInputSource 只有 user，續行輪次完全不經佇列，而是 thread-pump.ts:1207 直接 submit({kind:'goal',…})，所以今天等價、沒有錯。

#### plugins-interaction-r2-04　ask-user 在 apply 當下軟讀 channel，缺席時退成「有人在」，與 dsh 的 NO_PROVIDER 方向相反

- **類型**：介面外的事實（順序／狀態／設定／錯誤模式）｜**歸屬**：dev-harness｜**驗證**：降級保留（併入 hcr-r2-02 獨有的四點）（原判 高 → 低）
- **呼叫者必須知道、介面沒表達的事**：ask-user 要正確 fail-closed，必須同時滿足三件型別上看不到的事：組裝點用與核准閘門相同的兩格輸入另算一次 channel；經 host-services 提供；host-services 排在 ask-user 之前（因為它在 apply 當下就讀）。缺任何一件，ask-user 退到 { kind: 'human' }，也就是 fail-open。退路本身寫在 ask-user 的 JSDoc 裡，但改動會發生的地方（cli.ts 的組裝、host-services.ts）看不到它；
- **dsh 的形狀**：dsh 的 tool-ask-user inject ['tools', 'userQuestions']，是硬相依；UserQuestionService.ask() 走 user-questions/request 的 waterfall，沒有提供者接手時預設回 UserQuestionError 'NO_PROVIDER'——沒人可答是拒絕，不是假設有人。　`dsh:packages/interaction/tool-ask-user/src/index.ts:14`、`dsh:packages/interaction/user-questions/src/index.ts:131`
- **建議**：照 dsh 讓缺席成為 fail-closed：ask-user 改成 services.use（硬相依，缺件在載入時當場拋），或 get 不到時退到 { kind: 'no-channel' } 而不是 human；讀取挪進工具 handler（#459 的原設計），順序就不再承重。更根本的是 channel 只算一次：讓核准閘門也讀同一個服務，不要 fold 與 cli.ts 各算一次。
- **追蹤**：ask-user 那一半已併進 #669，當作第 1 步（盤點後開卡時併入）。其餘幾點開成專卡 #687（盤點後開）：submit-record 缺 backend 時響亮失敗，並改正順序與「缺件當場失敗」的散文。
- **證據**：`packages/nexus-plugin-ask-user/src/index.ts:185`、`packages/nexus-plugin-ask-user/src/index.ts:178`、`packages/nexus-plugin-ask-user/src/index.ts:180`
- **併入 hcr-r2-02 獨有的四點**（驗證者建議）：
  - `submit-record` 同樣在 apply 當下軟讀 backend，排錯時會無聲退回基座預設。
  - `registry.ts` 的偏離登記把失敗模式寫成「缺件當場失敗」，但這只對用 `services.use` 的 sandbox-policy 成立；ask-user 與 submit-record 用 `services.get` 加預設值。
  - `cordis.yml` 寫「順序不承載語意」，但沒有東西擋得住清單內出現 apply 當下的服務相依。
  - `cli.ts` 的順序註解只列了 submit-record 與 sandbox-policy，漏了 ask-user。
  - 更正：「把讀取挪進 tool body」不是 dsh 的形狀。dsh 的 tool-bash 也在 apply 當下讀，需要卻缺時會響亮地拋；ask-user 則是 hard inject。照 dsh，最接近的做法是 fail-loud（`services.use`，或 `get` 之後缺了就拋）。惰性讀取是我方 present 自己的形狀。
  - 證據：`packages/nexus-plugin-submit-record/src/index.ts:272`、`packages/nexus-core/src/registry.ts:294`、`packages/nexus-core/src/registry.ts:299`、`packages/nexus-core/src/registry.ts:301`、`apps/harness/src/cli.ts:871`、`apps/harness/cordis.yml:21`
- **否定搜尋**：git grep -n -E "問不到任何人|沒有可用的問答管道|noAnswerer" -- apps packages；git grep -n -E "policy-never|no-checkpointer|noAnswerer|問不到任何人" -- packages/nexus-plugin-ask-user apps/harness/src（apps 的命中全是核准閘門的 policy-never，沒有 ask-user 的拒絕句）（另有 1 條）
- **驗證意見**：本條的主體就是 hcr-r2-02 的 ask-user 那一半：同一行 ask-user index.ts:185 在 apply 當下軟讀、缺件退成 human；同一行 host-services.ts:12 把讀取時刻寫錯；建議同樣是挪進工具本體，或缺件時照 dsh 拒絕。「channel 只算一次、兩處推導」那一半是 core-mw-02 的主題，它還指出兩處的 checkpointer 述詞不同（cli.ts:824 對 fold.ts:723）。

#### plugins-interaction-r2-05　命令 handler 拿不到目標日誌，goal、plan-mode、feedback 各自追 root 日誌並各寫一句「挑不出」

- **類型**：介面外的事實（順序／狀態／設定／錯誤模式）｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 中 → 低）
- **呼叫者必須知道、介面沒表達的事**：命令要作用的那份日誌不在 CommandInvocation 裡。handler 必須自己在 apply 時 registry.sessions.join、過濾 address.kind === 'root'、記成陣列，執行時再判「剛好一份」。少了 root 過濾，從第二次委派起命令就一律回 ambiguous——goal 的檔頭記過這個實際發生過的失敗。
- **dsh 的形狀**：dsh 的 CommandInvocation 帶 readonly agent: Agent（註解：Exact agent whose UI received the command）。command-feedback 直接 recordFeedback(invocation.agent.session, …)，command-goal 用 ctx.goals.get(invocation.agent)；　`dsh:packages/interaction/commands/src/index.ts:44`、`dsh:packages/interaction/commands/src/index.ts:45`
- **建議**：照 dsh 在 CommandInvocation 加上目標那一格。我們的對應物是日誌——commands.ts 自己說指涉對象「不是 agent 而是會話日誌」——而 createCommandExecutor 已經持有 sessionLog，直接交給 handler 即可。之後 feedback 的 rootsHere 可刪；goal 與 plan-mode 的命令改讀 invocation 的日誌（servicesHere／sessionsHere 留給工具與 middleware 用）；
- **追蹤**：專卡 #688（盤點後開）。
- **證據**：`packages/nexus-core/src/commands.ts:13`、`packages/nexus-core/src/commands.ts:23`、`packages/nexus-core/src/commands.ts:64`
- **否定搜尋**：git grep -n -w "attached" -- apps packages ':!*.test.ts' ':!*.md'；git grep -n -E "\.attached\(\)" -- apps packages ':!*.md'
- **驗證意見**：介面缺目標那一格屬實。CommandInvocation 只有 commandId、rawInput、signal；執行器持有 sessionLog 卻不交出去。dsh 的 CommandInvocation 帶 agent，/feedback 直接寫 invocation.agent.session。core commands.ts 的登記理由是閉包對得上，屬形狀偏好，不是 AGENTS.md 要的「表達不出來」；前提「一份 registry 一份日誌」在 #137 之後要改寫成「一份 root 日誌」。

#### plugins-capability-r2-01　workspace-changes 的服務 DTO 住在 @nexus/wire，相依方向與房規和 dsh 都相反

- **類型**：相依方向｜**歸屬**：兩邊｜**驗證**：保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：WorkspaceChanges 服務（summary／diff）的回傳型別由傳輸層 @nexus/wire 定義，所以這個 plugin 是 18 個 plugin 裡唯一不只相依 @nexus/core 的一個；wire 那側為了 web 改 DTO，生產端的 plugin 就得跟著改，而這件事在 plugin 的介面上看不出來。
- **dsh 的形狀**：dsh 的 WorkspaceChangesSummary、WorkspaceFileDiff 與服務定義都在 packages/deliverables/workspace-changes/src/types.ts，連事件都用 declare module 在同一檔擴充；　`dsh:packages/client/ui-deliverables/src/changes.ts:3`、`dsh:packages/deliverables/workspace-changes/src/types.ts:86`
- **建議**：二擇一，而且要寫下來：（甲，照 dsh）把 WorkspaceChangedFile／WorkspaceChangesSummary／WorkspaceDiffHunk／WorkspaceFileDiff 搬進 plugin 的 type-only 子路徑（例如 @nexus/plugin-workspace-changes/types，零執行期相依），wire 或 web 以 import type 取用；wire 保留自己的 WORKSPACE_CHANGES 事件名與 WorkspaceChangesPayload。
- **追蹤**：專卡 #689（盤點後開）。照 dsh 搬家與登記成偏離兩條路都列在卡上，由 demian 拍板。
- **證據**：`.docs/development-plan.md:192`、`packages/nexus-plugin-workspace-changes/package.json:28`、`packages/nexus-plugin-workspace-changes/src/index.ts:65`
- **否定搜尋**：for p in packages/nexus-plugin-*/package.json; do python3 -c "import json;d=json.load(open('$p'));print([k for k in d.get('dependencies',{}) if k.startswith('@nexus')])"; done → 只有 workspace-changes 有 @nexus/wire；rtk proxy git grep -n "@nexus/wire" -- 'packages/*/package.json' 'apps/*/package.json' → 四行：apps/harness/package.json:62、apps/web/package.json:19、packages/nexus-plugin-workspace-changes/package.json:28、packages/nexus-wir
- **驗證意見**：獨立重推：逐一讀 20 個套件的 package.json，18 個 plugin 裡只有 workspace-changes 多相依 @nexus/wire，而且 index.ts、recorder.ts、compare.ts 三處都是 import type；wire 對 core 只有 devDependency。dsh 的方向核實：ui-deliverables 在 devDependencies 相依 dsh-workspace-changes，從它的 ./types 子路徑 type-only 取 DTO。要更正一點：這不是隨手、沒登記的選擇。

#### plugins-capability-r2-02　六個能力名只有提供者、沒有任何消費者

- **類型**：假想接縫（只有一個 adapter）｜**歸屬**：dev-harness｜**驗證**：保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：每個套件都匯出 X_CAPABILITY 並在 apply 裡 provide，註解說「要相依它的 plugin 把這個字串放進自己的 requires」；但全 repo 的非測試程式碼裡，requires 只出現一次（sandbox-policy 要的是服務），capabilities.has 只有 present 查 WORKSPACE_CAPABILITY。這六個名字是只有一個角色的接縫。
- **dsh 的形狀**：dsh 房規：A capability seam comprises Service Definition / Service Provider / Consumer roles，而且 never one role。dsh 的 skills 是服務，skill-badge、skill-filesystem、skill-office、tool-skill 都 inject ['skills']。　`dsh:AGENTS.md:138`、`dsh:packages/skill/skill-badge/src/index.ts:55`
- **建議**：照 dsh 的三角色規則：沒有消費者的能力名先不發（刪掉 provide 與匯出常數、以及只釘它的那條測試），等第一個 requires 出現時再由那一刀一起加。要保留的話，至少把註解從「要相依它的 plugin 把這個字串放進 requires」改成「目前沒有消費者」，免得讀者以為那是一條在用的接縫。
- **追蹤**：專卡 #690（盤點後開）。同形的 echo、agent-instructions、plan-mode 也納入，共八個；validation 那一個歸 #691。
- **證據**：`packages/nexus-plugin-memory/src/index.ts:37`、`packages/nexus-plugin-memory/src/index.ts:36`、`packages/nexus-plugin-skills/src/index.ts:95`
- **否定搜尋**：rtk proxy git grep -n "capabilities.has(" -- packages apps → 非測試只有 load.ts:259、registry.ts:1044、present/index.ts:253（WORKSPACE_CAPABILITY）；rtk proxy git grep -n "requires:" -- 'packages/*/src/*.ts' 'apps/*/src/*.ts' 'apps/*/src/**/*.ts' ':!*.test.ts' → 只有 sandbox-policy/index.ts:167，其餘是 load.ts:239、registry.ts:290 的註解與 plugin.ts:139 的 schema（另有 4 條）
- **驗證意見**：重跑否定 grep：git grep -n "capabilities\.\(has\|providers\)(" -- packages apps ':!*.test.ts' 只命中 load.ts:259、registry.ts:1044-1045 的轉手與 present:253（WORKSPACE_CAPABILITY）。git grep -nE "requires\s*:" 排除測試後，只有 sandbox-policy:167 加上註解與 schema。yml、yaml、json 裡沒有任何 requires。

#### plugins-capability-r2-03　@nexus/plugin-validation 是零消費者的相容殼，卻還佔著出貨清單，並宣告四個沒用到的執行期相依

- **類型**：淺模組｜**歸屬**：dev-harness｜**驗證**：保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：主入口只做兩件事：provide 一個沒人 requires 的 'validation'，以及 re-export 一組已經住在 @nexus/core 的名字（註解要新呼叫端直接從 core 拿）。不變量配套入口是空 installer，卻掛在出貨清單上。package.json 還宣告了 @langchain/core、@langchain/langgraph、langchain、zod 四個執行期相依，原始碼一行都沒 import；原始碼只 import @nexus/core。
- **dsh 的形狀**：dsh 沒有 validation plugin；輸出 schema 校驗在 packages/core/tools 的執行管線裡（validateJsonSchemaValue），是性質不是功能。　`dsh:packages/core/tools/src/index.ts:1834`
- **建議**：開一張 chore 卡把 @nexus/plugin-validation 整包移除：刪套件、cordis.yml 第 415 行那顆 invariant、apps/harness 的 package.json 相依與兩個測試清單裡的那一列。若擔心外部 patch 以名字載入它，先在 README 標 deprecated 一個版本再刪。至少先把四個沒用到的執行期相依（@langchain/core、@langchain/langgraph、langchain、zod）拿掉。
- **追蹤**：專卡 #691（盤點後開）。
- **證據**：`packages/nexus-plugin-validation/src/index.ts:2`、`packages/nexus-plugin-validation/src/index.ts:23`、`packages/nexus-plugin-validation/src/index.ts:39`
- **否定搜尋**：rtk proxy git grep -n "plugin-validation" -- '*.ts' '*.tsx' '*.yml' '*.json' ':!packages/nexus-plugin-validation' ':!pnpm-lock.yaml' → 只有 cordis.yml 的 /invariant、harness package.json、兩個測試清單、core 的歷史註解；rtk proxy git grep -n "import(.*validation" -- packages apps → 零命中（沒有動態 import）（另有 3 條）
- **驗證意見**：重跑否定 grep：git grep -nE "createValidationPlugin|validationPlugin\b|VALIDATION_CAPABILITY|plugin-validation'" 排除自身套件後，非測試呼叫點是零（只剩 harness package.json、兩個測試清單與散文）。git grep -n "import\|from '" -- packages/nexus-plugin-validation/src 顯示原始碼只 import @nexus/core，測試另外 import vitest，所以四個執行期相依確實沒用到。

#### plugins-capability-r2-04　基座的工具名在四個套件各抄一份：委派工具 'task' 五處、檔案工具三個名字在 workspace-changes

- **類型**：隱性耦合（無相依邊）｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 低 → 低）｜合併了 core-mw-03
- **呼叫者必須知道、介面沒表達的事**：sandbox-policy 的委派快照只在 resolveToolName(request) === 'task' 時才拍，workspace-changes 只擷取名字是 write_file／edit_file／delete 的呼叫；兩者都靠字面值對上 deepagents 的工具名，而那份名單唯一的守衛（baseline.test.ts）守的是 harness 的 base-tools.ts，不是這些副本。
- **dsh 的形狀**：dsh 的委派快照不靠工具名：委派邊界本身（subagent 的 in-process driver 與 continuation）在第一個 await 前呼叫 captureDelegatedPolicyOverrides(parent)，由它透過 ctx.get('sandboxPolicy') 向政策服務要當下的覆寫。方向是委派者 → 政策，政策不必認得委派工具。　`dsh:packages/subagent/subagent/src/child-agent.ts:253`、`dsh:packages/subagent/subagent-in-process-driver/src/index.ts:119`
- **建議**：在 @nexus/core 匯出一份基座工具名（把 max-tokens.ts 的 TASK_TOOL 升成公開常數，檔案工具那三個一起），sandbox-policy、workspace-changes、thread-pump、base-tools 都改讀它，baseline.test.ts 的守衛因此一次涵蓋所有讀者；wire 沒有對 core 的執行期相依，保留字面值並靠既有測試。委派快照的方向維持現狀即可——那是被迫的（見偏離註記）。
- **追蹤**：專卡 #692（盤點後開）。web 手列名單漏的 delete 歸 #672。
- **證據**：`packages/nexus-plugin-sandbox-policy/src/index.ts:87`、`packages/nexus-plugin-sandbox-policy/src/index.ts:218`、`packages/nexus-core/src/max-tokens.ts:85`
- **否定搜尋**：rtk proxy git grep -nF "'task'" -- packages apps（排除 .test.）→ base-tools.ts:72、thread-pump.ts:543、max-tokens.ts:85、sandbox-policy/index.ts:87、wire/conversation.ts:923；rtk proxy git grep -nE "export const (TASK_TOOL|DELEGATION_TOOL)" -- packages apps → 零命中（exit=1），沒有匯出的共用常數
- **驗證意見**：副本數核實：git grep -nF "'task'" -- packages apps 排除測試後，命中 base-tools.ts:72、thread-pump.ts:543、max-tokens.ts:85、sandbox-policy:87、wire conversation.ts:923；git grep -nE "export const (TASK_TOOL|DELEGATION_TOOL)" 零命中。node_modules 裡 deepagents 1.13.1 的 index.d.ts 確實沒有匯出工具名常數。

#### plugins-capability-r2-05　虛擬路徑規則有三份：基座 virtualMode、present 的 virtualPathOf、workspace-changes 的 hostPathOf

- **類型**：隱性耦合（無相依邊）｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：workspace-changes 要把模型給的路徑對到磁碟，得知道 ContainedFilesystemBackend 一律 virtualMode: true、'/' 就是工作區根；這件事它沒有相依邊可以問，只能在 paths.ts 自己重寫一份規則。present 為了同一件事匯出了 virtualPathOf 並寫明「複製一份的話就是第二個真相」，workspace-changes 卻是那第二份。
- **dsh 的形狀**：dsh 的檔案工具收的就是主機路徑，所以規則是作業系統本身：workspace-changes 用 node:path 的 resolve(cwd, path)，present 用 ctx.fs.resolve(file.path, { cwd })。沒有一份自訂的虛擬位址規則要複製。　`dsh:packages/deliverables/workspace-changes/src/recorder.ts:163`、`dsh:packages/deliverables/tool-present/src/index.ts:89`
- **建議**：把「工具位址 → 主機路徑」收成一份：放在 @nexus/core 的 sandbox.ts（fence 與控制器的合約已住在那裡，兩個 plugin 都已相依 core），present 的 virtualPathOf 與 workspace-changes 的 hostPathOf 都改用它，contained-backend.ts 的註解指向它。這樣改位址空間的人只要改一處，而且有一個地方可以寫絆索。
- **追蹤**：專卡 #693（盤點後開）。dsh 自己也有兩份「工具路徑→主機路徑」，卡不寫「照 dsh 收成一份」，只收已登記的虛擬位址空間偏離的足跡。
- **證據**：`packages/nexus-plugin-present/src/index.ts:178`、`packages/nexus-plugin-present/src/index.ts:172`、`apps/harness/src/deliverable-files.ts:52`
- **否定搜尋**：rtk proxy git grep -n "hostPathOf\|virtualPathOf\|virtualMode" -- packages apps（排除 .test.）→ 只在 contained-backend.ts、deliverable-files.ts、present/index.ts、sandbox-policy/index.ts（註解）、workspace-changes 的 paths.ts 與 recorde
- **驗證意見**：我方的事實核實，副本還比發現說的多：present:179 與 workspace-changes paths.ts:126 各有一份 normalize；contained-backend.ts 另有三處內聯的「補前導斜線」（297、526、602），因為基座的 resolvePath 是 private；deliverable-files.ts:153 接到根上那一步又自己寫一次。用來找的指令：git grep -nE "posix\.normalize|startsWith\('/'\) \? " -- packages apps 排除測試與 web。

#### plugins-capability-r2-06　present 借一顆沒有鉤子的 middleware 才拿得到 backend

- **類型**：其他｜**歸屬**：dev-harness｜**驗證**：保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：plugin 在 apply 裡看不到折好的 backend；唯一拿得到的地方是 middleware.useWithBackend 的工廠。present 要的是工具本體讀 backend，不是 middleware，所以它註冊一顆名為 PresentBackend、沒有任何鉤子的 middleware，只為了在工廠被叫時把 backend 存進閉包。這顆空 middleware 因此出現在 root 與每個子代理的 stack 裡。
- **dsh 的形狀**：dsh 的 present 宣告 inject = ['tools', 'fs', 'sessionProjections']，直接用 ctx.fs 的 lstat／resolve／stat，工作區判準讀會話 header 的 cwd。　`dsh:packages/deliverables/tool-present/src/index.ts:26`、`dsh:packages/deliverables/tool-present/src/index.ts:81`
- **建議**：在 registry 開一個給工具用的窄口，例如 registry.backend.onFolded(cb) 或一個在 fold 之後才可讀的 getter（語義同 useWithBackend：沒有 backend 就永遠不回），present 改用它、拿掉 PresentBackend。不急；等第二個工具型消費者出現時一起做也可以。
- **追蹤**：專卡 #694（盤點後開）。重核時補了 submit-record 那一半：它拿到的 backend 跟工具實際讀寫的不是同一個（讀碼推得，沒有實測），所以「等第二個工具型消費者出現」不必再等。這也推翻了「看過、判定沒問題的接縫」裡兩條 backend 通道那一條。
- **證據**：`packages/nexus-plugin-present/src/index.ts:73`、`packages/nexus-plugin-present/src/index.ts:218`、`packages/nexus-plugin-present/src/index.ts:230`
- **否定搜尋**：rtk proxy git grep -n "useWithBackend" -- packages apps（排除 .test.）→ 使用者只有 agent-instructions 與 present
- **驗證意見**：核實：present:228-231 註冊一顆只回名字的 middleware。registry.ts:403 的介面本意是建 middleware，:410 說一次組裝只建一份、走遍 root 與每個子代理。git grep useWithBackend 排除測試後，使用者只有 agent-instructions 與 present。present 檔頭的五條偏離沒有一條登記這個取法（第 2 條講的是工作區判準），#441、#388 的內文與留言也沒有討論（gh issue view 核過）。

#### plugins-capability-r2-09　telemetry-otel 的「偏離三」前提已過期，檔頭與工廠註解說的驗證時刻互相矛盾

- **類型**：介面外的事實（順序／狀態／設定／錯誤模式）｜**歸屬**：dev-harness｜**驗證**：保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：設定錯了什麼時候拋：檔頭偏離三與 telemetryOtelPlugin 的註解說「在工廠函式當場驗、建構就會拋」，createTelemetryOtelPlugin 的註解卻說「設定不在這裡驗，驗在載入的時候」。實際上 schema 由載入器驗、值檢查在 OpenTelemetrySessionService 建構子，也就是 apply 當下。
- **dsh 的形狀**：dsh 的 session-telemetry-otel：Config 只驗頂層欄位，值檢查放在建構子裡好讓錯誤訊息指得出欄位。　`dsh:packages/session/session-telemetry-otel/src/index.ts:124`、`dsh:packages/session/session-telemetry-otel/src/index.ts:164`
- **建議**：撤掉偏離三（或改寫成「已與 dsh 同形」），把第 327–329 行的「設定在工廠函式當場驗、建構就會拋」改成「載入時驗：schema 在 loadPlugins、值檢查在 apply 建的服務建構子」，讓兩段 JSDoc 一致。
- **追蹤**：專卡 #695（盤點後開）。
- **證據**：`packages/nexus-plugin-telemetry-otel/src/index.ts:33`、`packages/nexus-plugin-telemetry-otel/src/index.ts:35`、`packages/nexus-plugin-telemetry-otel/src/index.ts:327`
- **驗證意見**：核實：偏離三由 #100 引入（git log -S 找到 db97056），說我們沒有會跑 Config 的 loader。#476（e85806d）把設定搬進 Config，加了「設定不在這裡驗」的工廠註解，卻沒改偏離三與 plugin 的 JSDoc。實際上 schema 在 loadPlugins 驗（load.ts:76），值檢查在 OpenTelemetrySessionService 的建構子（:243 起），由 apply 呼叫。這與 dsh「Config 只驗頂層、值檢查在建構子」同形。

#### plugins-capability-r2-10　present 的模型面文字停在 dsh ddefc45，477b4f4 已改寫描述並加了參數說明

- **類型**：其他｜**歸屬**：dev-harness｜**驗證**：保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：present 的工具描述是模型面的介面，檔頭宣稱逐字照抄 dsh；上游在 ddefc45 之後改了那段描述（從「必須在最後回覆前呼叫」改成「使用者需要獨立檔案時才用、能用最後回覆就別用」），並替 files 參數加了「通常 1 到 2 個、一次最多 4 個」的說明。
- **dsh 的形狀**：dsh 477b4f4 的 tool-present 描述是「Declare existing files as final deliverables for the user. Use it when the user needs a separate file…; prefer your final response when that suffices.」，files 參數說明「Usually the 1-2 most impor…　`dsh:packages/deliverables/tool-present/src/index.ts:40`、`dsh:packages/deliverables/tool-present/src/index.ts:47`
- **建議**：開一張小卡把描述與 files 參數說明對齊 477b4f4，檔頭的出處 SHA 一併更新；web 卡片不受影響（它看工具名與參數形狀）。
- **追蹤**：專卡 #696（盤點後開）。
- **證據**：`packages/nexus-plugin-present/src/index.ts:5`、`packages/nexus-plugin-present/src/index.ts:82`
- **驗證意見**：核實：我們的描述與 dsh ddefc45 逐字相同（git show ddefc45:packages/deliverables/tool-present/src/index.ts 對過）。477b4f4 改成「使用者需要獨立檔案時才用、能用最後回覆就別用」，並替 files 參數加了「通常 1–2 個、一次最多 4 個」的說明。git log ddefc45..477b4f4 顯示 present 只改了這兩處，maxFiles 預設仍是 8。依 AGENTS.md，模型面的文字要照 dsh 的實際做法，現況是標準漂移。這不是耦合問題，嚴重度低。

#### hcr-r2-04　兩個入口共用的組裝根住在 CLI 入口檔，serve 反向相依 CLI 入口

- **類型**：相依方向｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：serve 的每條 thread 組裝、goal port 的 adapter 與五個旗標解析／驗證函式，都得從 cli.ts（一個有 main() 的 CLI 入口）import。createCliAgent 靠「省略哪幾個位置參數」表達自己是 serve 還是 CLI，而且會回傳 serve 用不到的 SessionRegistry 與 sessionLog。
- **dsh 的形狀**：dsh 的兩個入口 apps/cli 與 apps/desktop-host 都相依共用套件 @deepseek-ai/dsh-app-boot（profile-boot.ts 與 desktop-host/src/index.ts 從它 import），入口之間互不相依。組裝內容本身是 bundle 裡的資料，不寫在入口裡。（⚠ 驗證者判此描述不被 dsh 原始碼完整支持）　`dsh:apps/cli/src/profile-boot.ts:34`、`dsh:apps/desktop-host/src/index.ts:5`
- **建議**：把 createCliAgent、goalDriverPort，以及兩個入口共用的解析與驗證 helper，搬進 apps/harness/src 下的一個組裝模組（例如 assembly.ts），cli.ts 與 serve.ts 都從它 import。順手把「入口身分」從位置參數的省略改成具名選項，並把 CLI 專屬的 SessionRegistry 移回 runCli。和 hcr-r2-05 的模型接縫一起做。
- **追蹤**：專卡 #697（盤點後開）。
- **證據**：`apps/harness/src/serve.ts:45`、`apps/harness/src/serve.ts:414`、`apps/harness/src/serve.ts:496`
- **否定搜尋**：git grep -n "from './cli.js'\|from '../cli.js'" -- 'apps/harness/src/**.ts' ':!*.test.ts' （只有 serve.ts）；git grep -l "from './cli.js'\|from '../cli.js'" -- 'apps/harness/src/*.test.ts' 'apps/harness/src/**/*.test.ts' | wc -l （23）
- **驗證意見**：事實屬實：serve.ts:45 從 cli.ts import 8 個符號，createCliAgent 是兩條路共用的組裝根。但 dsh_shape 寫錯了。原文說 dsh「入口之間互不相依」，實際上 dsh 的 apps/desktop-host 直接 import '@deepseek-ai/dsh/profile-boot'（index.ts:6），package.json 也宣告相依 @deepseek-ai/dsh（:15）；

#### core-mw-04　middleware 與它的 backend Proxy 分開公開，配對只存在於 foldRegistry

- **類型**：介面面積過大｜**歸屬**：dev-harness｜**驗證**：保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：createReadContinuationMiddleware 必須跟 recordReadExtent 一起用，createFsToolErrorsMiddleware 必須跟 recordBackendOutcomes 一起用，tool-result-meta 的槽則必須由圍堵來開。兩半之間靠模組層的 AsyncLocalStorage 傳遞，型別看不出這層配對。
- **dsh 的形狀**：跨段狀態都在 ToolRuntime 裡處理：meta 由工具自己的 output.presentationMeta 在 createSuccessResult 產生，不走旁通道。　`dsh:packages/core/tools/src/index.ts:1848`
- **建議**：把每一對收成單一入口，例如 withReadContinuation(backend) 回傳 { backend, middleware }；或者 index 只公開 foldRegistry 用得到的組合，不再單獨公開半邊。最小的一步是從 index 拿掉那些在 core 以外零消費者的半邊。
- **追蹤**：專卡 #698（盤點後開）。
- **證據**：`packages/nexus-core/src/read-continuation.ts:196`、`packages/nexus-core/src/read-continuation.ts:377`、`packages/nexus-core/src/read-continuation.ts:150`
- **否定搜尋**：for s in recordReadExtent recordBackendOutcomes createReadContinuationMiddleware createFsToolErrorsMiddleware recordToolResultMeta runInToolMetaSlot putToolResultMeta; do git grep -l "$s" -- ':!packages/nexus-core/src'; ；git grep -nE "nexus-core/src/(read-continuation|fs-tool-errors|tool-result-meta)" -- ':!packages/nexus-core/src' ':!*.md' → 只有 interception-index.test 與 tool-error-prefix.test 的路徑清單，加上 web 的一行註解，沒有 import
- **驗證意見**：獨立重推成立。index.ts:185-199 公開 createFsToolErrorsMiddleware／recordBackendOutcomes、createReadContinuationMiddleware／recordReadExtent 兩對半邊，tool-result-meta 只公開型別（:200-205），三組做法確實不一致。

#### core-mw-05　續接時讀回的沙箱模式不驗詞彙，未知值會在 fence 落進 workspace-write

- **類型**：介面外的事實（順序／狀態／設定／錯誤模式）｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：recordedSandboxMode 的回傳型別宣稱是 SandboxMode，但值直接來自磁碟上的日誌，沒有經過 isSandboxMode。下游的 fence verdict 與 sandboxPolicySentence 都假設值只會是那三個名字之一。
- **dsh 的形狀**：dsh 的 sandbox-policy 套件自帶 invariant，遇到 sandbox/mode 事件帶著未知模式就當場報違規。它在產品路徑上是否也擋住讀回：dsh 形狀未核（只核到 invariant 的檢查本身）。　`dsh:packages/sandbox/sandbox-policy/src/invariant.ts:18`
- **建議**：照 invariant.ts 自己指出的位置，在 recordedSandboxMode 的讀取邊界加上 isSandboxMode：未知值回 undefined（落回部署預設）或直接拋。同時讓 verdict 的最後一個分支對未知值 fail-closed。
- **追蹤**：專卡 #699（盤點後開）。主刀改成照 dsh 在配套入口檢查日誌裡的沙箱模式詞彙；「verdict 對未知值 fail-closed」跟 dsh 不同形，卡裡不做；在讀取邊界拒收列為動工前要查。
- **證據**：`packages/nexus-plugin-sandbox-policy/src/sandbox-mode.ts:103`、`packages/nexus-plugin-sandbox-policy/src/invariant.ts:16`、`packages/nexus-plugin-sandbox-policy/src/invariant.ts:22`
- **否定搜尋**：git grep -n "isSandboxMode(" -- 'packages/*/src/*.ts' 'apps/harness/src/*.ts' ':!*.test.ts' → 只有 cli.ts:388（啟動旗標）與 sandbox-mode.ts:346（/sandbox 指令參數），讀回路徑沒有
- **驗證意見**：事實屬實：recordedSandboxMode（sandbox-mode.ts:103）原樣交出 event.data.mode；contained-backend 的 verdict（:514-517）只特判 danger-full-access 與 read-only，其餘落進 workspace-write；sandboxPolicySentence 的 switch 沒有 default。

#### core-mw-06　沙箱升級工具無條件發放授權，「人看過」只靠 waterfall 最後一位 gate

- **類型**：隱性耦合（無相依邊）｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 中 → 低）
- **呼叫者必須知道、介面沒表達的事**：升級工具本體一被執行，就 controller.grant({ mode, target, denied: lastDenial })：把最近一次被 fence 擋下的那個操作（操作、canonical 目標、內容摘要都要對得上），綁成可以在要求的模式下認領一次。「有人核准過」這件事，只由另一個註冊點上的 approvals gate 保證，而那位 gate 排在 waterfall 的最後。前面任何一位 listener 只要回 allow 而不呼叫 next()，它就會被跳過；工具本身不知道自己有沒有被核准過。
- **dsh 的形狀**：tool-fs 的 sandbox.ts 在工具路徑裡 `await approveEscalation(...)`；escalation.ts 在沒有核准服務時直接拋錯（fail-closed）。guard 的型別 ToolGuard 只能回拒絕字串，沒有強制放行的回傳值可用。　`dsh:packages/fs/tool-fs/src/sandbox.ts:97`、`dsh:packages/sandbox/sandbox/src/escalation.ts:181`
- **建議**：照 dsh 把升級的核准放進工具路徑：讓工具本體自己 interrupt 要核准（跟 ask_user 的 interrupt 同一個形狀），或在 grant 之前確認這一次呼叫確實經過 ask 決策（把 gate 的判決綁到 callId）。至少要把 approval-gate-order.test 的射程擴到 createCliAgent 的產品組裝，並更新檔頭兩句過期前提，以及失敗指引裡的受害者清單。
- **追蹤**：專卡 #700（盤點後開）。主刀改成照 dsh 在升級工具本體裡問人。
- **證據**：`packages/nexus-plugin-sandbox-policy/src/sandbox-escalation.ts:177`、`packages/nexus-plugin-sandbox-policy/src/sandbox-escalation.ts:213`、`packages/nexus-plugin-sandbox-policy/src/sandbox-escalation.ts:226`
- **否定搜尋**：git grep -n "approvals.gate(" -- 'packages/*/src/*.ts' 'apps/harness/src/*.ts' ':!*.test.ts' → 實際的 gate 是 plan-mode、submit-record、sandbox-escalation 三位，加上 approval.fixture.ts 一位；load.ts 與 registry.ts 是註冊點本身
- **驗證意見**：結構屬實：升級工具本體無條件 controller.grant（sandbox-escalation.ts:177），「人看過」只靠同檔 :212 的 gate；createCliAgent 的順序是 host-services → ...plugins（出貨清單＋patch，cli.ts:880）→ ask-user → submit-record → sandbox-policy（:881-886），升級 gate 結構上永遠最後。

#### core-mw-07　解不開參數的載體：檔頭把安全歸給 MemorySaver，實際擋住的是續接時補上的錯誤結果

- **類型**：隱性耦合（無相依邊）｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：createInvalidToolArgsMiddleware 在載體查不到 callId 時，會照 {} 放行並真的執行。它的安全前提是「停在核准點的那張卡不會跨行程被續答」。這件事實際上是由 conversation-replay 的 closer 把懸著的呼叫補成錯誤結果來保證的，兩者之間沒有相依邊。
- **dsh 的形狀**：agent-loop 的 parseArguments 把解不開的 JSON 原字串留在呼叫資料本身，等執行時才驗，不靠行程內另外存一份。　`dsh:packages/core/agent-loop/src/tool-calls.ts:104`
- **建議**：先把檔頭的前提改寫成真正在擋的東西，也就是 replay closer，再加一條絆索：續接一條停在核准點、參數解不開的日誌，斷言那顆呼叫得到的是補上的錯誤結果，而不是被執行。長期照 dsh，把「參數解不開」的記號放進訊息本身，讓它活得過續接。至於這個記號能不能撐過 v3 串流轉換器與供應商的來回：未核。
- **追蹤**：專卡 #701（盤點後開）。「實際擋住的是 replay closer、重開條件看錯了軸」被驗證推翻；卡只改寫檔頭過期的前提，並讓門 B 的絆索指到這個檔。
- **證據**：`packages/nexus-core/src/invalid-tool-args.ts:69`、`packages/nexus-core/src/invalid-tool-args.ts:70`、`packages/nexus-core/src/invalid-tool-args.ts:248`
- **否定搜尋**：git grep -l "replayConversation\|restoreConversation" -- '*.test.ts' | xargs grep -l "INVALID_ARGS\|rawOf\|invalid-tool-args\|InvalidArguments\|repairInvalidToolCalls" → 無輸出：沒有續接測試涵蓋解不開的參數
- **驗證意見**：前提有一半對：invalid-tool-args.ts:70「行程一死 thread 跟著死」寫於 de6d6ae（#284，2026-09-13），隔天 3dfd92c（#309，2026-09-14）起 CLI 與 serve 以 restoreConversation 跨行程接回對話（cli.ts:1440、serve.ts:427），就「對話」的意義這句已過期。

#### core-mw-model-02　錨定估算的帳本是行程單例，組裝點注入不了，測試得伸手清模組全域

- **類型**：測試越過介面｜**歸屬**：dev-harness｜**驗證**：保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：estimateAnchoredTokens 的準度靠有人在每次呼叫回來時叫 book.record。產品組裝永遠用模組層級的 defaultTokenAnchorBook，而「學」只發生在摘要器外包的預算層。所以同一行程的所有組裝共用一本帳，摘要關掉時沒有人餵它；要隔離只能清模組全域。
- **dsh 的形狀**：dsh 的 TokenMeter 是一個 Service，狀態用 WeakMap<Session, ReplayState> 逐 session 存，並由 session/event 從耐久日誌重播。compaction-basic 以 static inject 宣告相依 tokenMeter，由 ctx 注入，不碰模組全域。　`dsh:packages/llm/token-meter/src/index.ts:101`、`dsh:packages/llm/token-meter/src/index.ts:108`
- **建議**：分兩級： - 最小一步：帳本改由組裝點提供，走 registry 服務或 FoldOptions，對應 dsh 的 ctx.tokenMeter 注入。serve 由進入點建一本給所有 thread 共用（保住跨 thread 借錨），測試各自建一本，setup 就不必清模組全域，clear() 也可以拿掉。 - 若要讓估算脫離摘要器，把 record 移到一顆獨立的、無論摘要開關都掛的 wrapModelCall，比較接近 dsh 的「量測是獨立服務」。 - 完整照 dsh（從日誌重播出帳本）要先有請求標頭的事件，超出本叢集。
- **追蹤**：專卡 #702（盤點後開）。
- **證據**：`packages/nexus-core/src/token-estimate.ts:382`、`packages/nexus-core/src/token-estimate.ts:285`、`packages/nexus-core/src/token-estimate.ts:294`
- **否定搜尋**：git grep -n -E "estimateAnchoredTokens|estimateRequestTokens|TokenAnchorBook|defaultTokenAnchorBook|\.record\(|token-estimate" -- ':!*.md' → 非測試的使用者只有 summarization.ts、index.ts、session-log.ts（註解）與 nexus-wire/context-pres；git grep -l -w createSummarizer -- ':!*.md' → 產品呼叫點只有 fold.ts:1007，而且不傳 book
- **驗證意見**：我自己重推過，結論成立。 TokenAnchorBook 的預設值是模組單例 defaultTokenAnchorBook，createSummarizer 與 isUnderCompactionPressure 兩處都預設落在它上面（summarization.ts:315、722）。產品唯一的呼叫點 fold.ts:1007 不傳 book，FoldOptions 也沒有這一格。clear() 明寫「給測試用」，harness 的 test-home.setup.ts 每條測試前都清一次全域。

#### core-mw-model-03　摘要第二道門檻（60 則）碰不碰得到，靠迴圈上限與每輪節點數；三處散文的換算互相矛盾

- **類型**：介面外的事實（順序／狀態／設定／錯誤模式）｜**歸屬**：dev-harness｜**驗證**：降級保留（原判 低 → 低）
- **呼叫者必須知道、介面沒表達的事**：messages: 60 在一場跑滿的迴圈裡碰得到，前提是「上限 100、每輪三格」。上限是使用者可調的 #settings 條目，每輪幾格由掛了哪些 beforeModel 決定。這個條件沒寫在門檻那一側。
- **dsh 的形狀**：dsh 的 compaction-basic 以窗口比例（thresholdRatio）觸發，沒有訊息數門檻，也就沒有「門檻可不可達」跟迴圈預算的耦合。　`dsh:packages/compaction/compaction-basic/src/config.ts:78`
- **建議**：把 summarization.ts 的換算改成 33 輪（給 --workspace 時 32）。repeat-reminder.ts 的 3×輪數+2 與 recursion-limit.ts 的 floor((上限−1)/3) 對齊成同一條式子，後者有 LoopingChatModel 的實測表撐著。在 messages 門檻的註解寫出可達條件 floor((limit−1)/每輪格數) × 2 + 1 ≥ 60，並指向 recursion-limit 條目，讓調上限的人看得到這個連帶。
- **追蹤**：專卡 #703（盤點後開）。只剩散文過期那一半；在門檻旁寫「可達條件」那一項不採。
- **證據**：`packages/nexus-core/src/summarization.ts:212`、`packages/nexus-core/src/summarization.ts:176`、`packages/nexus-core/src/repeat-reminder.ts:413`
- **否定搜尋**：git grep -n -E "49 輪|32 輪|33 輪" -- ':!*.md' → summarization.ts:176 是唯一還寫 49 輪、當成預設組裝換算的地方
- **驗證意見**：耦合的前提被推翻，剩下的是散文過期。 （一）耦合不存在。messages 門檻比的是這條 thread 的有效訊息總數（summarization.ts:577 的 baseWillCatch 比 view.length）。serve 同一條 thread 每一輪共用同一個 thread_id 與 checkpointer 狀態，state.messages 跨輪累積（提醒器檔頭也寫連續次數跨輪累積）。所以「單次 invoke 跑滿能不能碰到 60 則」只關係到註解裡「一場跑滿的長任務會摘要一次」這句理由，不管門檻的作用： - 上限調低時，那一輪根本湊不到 60 則，不需要這道門檻；

### 已被追蹤（4）

- **core-session-F1　詞彙成長只靠人記得升版；「這一版認得哪些種類」住在離線掃描裡**：耦合是真的，但 #507（OPEN，needs-triage）已經追蹤，前提也沒變。耦合本身：parseJsonlSessionBody 只驗 type 是字串，擋住舊版讀新檔的只有版本號，唯一釘版號的測試只要求 >=9。三處窮舉絆索會逼作者改遙測、掃描、goal 折疊，卻不會逼作者升版。#507 的第 1 題「不認得＋沒標記就拒絕重建」和本條的建議 (2) 是同一件事，而讀路徑要拒絕，本來就需要一份認得的集合，所以建議 (1) 把 KNOWN_EVENT_TYPES 搬到 core，是 #507 落地時的實作細節。今天產品讀方沒有消費者：`git grep -n KNOWN_EVENT_TYPES 70357bb` 只有 session-scan.ts 的 101 與 257 兩行。
- **plugins-capability-r2-07　memory 的來源不去重，而且與預設的 agent-instructions 重疊，AGENTS.md 會在 prompt 出現兩次**：兩半都已有拍板。(1) memory 的重複路徑不擋，是 #28 決議 2「沿用基座語義、memory 全部併入 prompt、nexus 不介入」（gh issue view 28 讀到，resolve 核不到）。開發計劃第 99–100 行在同一張表上列出「skills 重複即拋、memory 純累加」，registry.test.ts:351 與 fold.test.ts:1188 直接釘住「同一路徑兩次不報錯、原樣交給基座」，所以這個不對稱是設計，不是疏漏。(2) 與 agent-instructions 重疊，是 #388 決定 memory 為選配、並在檔頭第 11 行寫明的取捨。
- **plugins-capability-r2-08　skills 在空目錄時仍往 system prompt 附一段、且每輪重掃；#440 的驗收二靠加一個條目做不到**：事實核實：deepagents 1.13.1 的 dist/langsmith-zm0ILQsV.js（resolve 核不到）裡，formatSkillsList 遇空清單回 (No skills available yet…)；createSkillsMiddleware 的 wrapModelCall 無條件 concat skills 段落；beforeAgent 只在 loadedSkills 非空時提早返回。fold.ts:486 有來源就交給基座，skills plugin 又無條件註冊來源。所以「只在 cordis.yml 加一行條目」確實過不了 #440 驗收二。
- **core-mw-02　核准通道在組裝期就算成一個值，而且兩處各推導一次**：兩半分開看。(a)「channel 在組裝期算成值、核准不是來源、擋住具名 preset」：#437（OPEN，needs-triage）內文逐字寫著「改 deriveApprovalChannel 的呼叫方式，從返回靜態 ApprovalChannel 改成傳入一個逐次求值的函數型來源」，sandbox-mode.ts:21-27 也登記了「還沒做不是做不到、傳來源不傳值、排序不是障礙」。前提沒變：#437 引的 apps/harness/src/sandbox-mode.ts 在 #478 後搬到 packages/nexus-plugin-sandbox-policy，內容未變，fold.ts:719-724 仍在折疊當下算值。本條建議就是 #437 的範圍，判 already-tracked #437。

### 併入別條的重複（3）

- hcr-r2-02　組裝點協作者的順序約束：偏離已登記，但失敗模式與讀取時刻都寫錯了 → plugins-interaction-r2-04
- core-mw-01　root 與子代理的 middleware 清單各寫一份，沒有共同來源 → core-plugin-system-r2-N2（#664）
- core-mw-03　基座檔案工具名在 core 四個模組各寫一份，名字的主人在 harness → plugins-capability-r2-04

## 模組深淺與刪除測試

| 叢集 | 模組 | 深淺 | 刪除測試 |
| --- | --- | --- | --- |
| core-plugin-system | packages/nexus-core/src/plugin.ts（NexusPlugin／PluginEntry／resolveEntries） | 深 | 刪掉它，補 id、驗設定、停用條目的語意會散回 harness 的 plugin-config 與每個組裝點，所以它有存在價值。唯一的缺點是 name 的說明（「唯一用途是錯誤訊息指名」）已經不成立，見 N3。 |
| core-plugin-system | packages/nexus-core/src/entries.ts（NamedEntries／CapabilitySet／AnonymousEntries） | 深 | 刪掉它，十幾個註冊點得各自重寫撞名判斷與冪等 undo，複雜度會回到呼叫端。形狀與 dsh 的 scope/store.ts NamedEntries 同名同形。 |
| core-plugin-system | packages/nexus-core/src/load.ts（loadPlugins／trackUndo／disposeAll） | 混合 | loadPlugins 本身是深的（回滾、關機清理、requires 驗證都收在裡面）。trackUndo 是淺的轉發層，逐一鏡像 registry 上每個會發 undo 的方法，而這份知識 registry 已經有了（每次註冊都呼叫 requireOrigin）。 |
| core-plugin-system | packages/nexus-core/src/registry.ts（PluginRegistry／InternalPluginRegistry／createRegistry） | 深 | 刪掉它，各通道的撞名、作用域、冪等 undo 政策會散進每個 plugin 與 fold。它的介面面積大，但通道數有 registry-channel-count 的窮舉絆索。 |
| core-plugin-system | packages/nexus-core/src/fold.ts（foldRegistry 與 foldMiddleware／foldSubAgents／各 disposition） | 混合 | 對外只有一個函式，藏住排序、作用域、停用判讀，整體是深的。內部有兩處淺：root 與子代理兩份手寫堆疊，同一個知識表達兩次，見 N2；停用判讀散在六處、兩種問法，見 N3。 |
| core-plugin-system | packages/nexus-core/src/host-services.ts（createHostServicesPlugin） | 淺 | 刪掉它，cli 與 serve 各得寫一顆只 provide 的 plugin，同樣的程式會在兩個呼叫點重現。它是淺但正當的 adapter。寬索引簽名與 dsh cordis 的 provide(name: string) 一致。 |
| core-plugin-system | packages/nexus-core/src/base-types.ts | 淺 | 刪掉它，每個 core 檔得各自索引基座型別，或直接相依 langchain。留著可以讓基座升版時 tsc 在同一處報錯，是刻意做成的薄層。 |
| core-plugin-system | packages/nexus-core/src/invariant.ts／invariants.ts（包自有不變量） | 深 | 刪掉它，跨筆關係的檢查會散進各 plugin，違規也報不出擁有者。配套清單有 invariant-companions.test.ts 對磁碟窮舉。 |
| core-plugin-system | apps/harness/src/plugin-config.ts（YAML 條目、patch、受保護條目） | 深 | 刪掉它，部署設定層（#454／#455）就不存在了，所以它必要。它與 core 用兩套鍵指認同一顆 plugin：YAML 模組名與 NexusPlugin.name，見 N3。 |
| core-session | packages/nexus-core/src/session-log.ts（SessionLog、SessionEventType／SessionEventMap、currentTurnStart） | 深 | 刪掉它，凍結、快照、重入與圍堵要在每個寫方與讀方各做一次，複雜度散到十幾個呼叫者身上，所以是深模組。但詞彙那一半是手寫封閉聯集，而且從 feedback／goal／todo／deliverables 等領域引入型別（見 F1、F2）；邏輯輪沒有像 currentTurnStart 那樣的擁有者（見 F6）。 |
| core-session | packages/nexus-core/src/session-store.ts（SessionStore、StoredSession、SESSION_LOG_FORMAT_VERSION） | 深 | 刪掉它，session-persistence 會直接相依 JSONL 檔案格式，測試也不能再用手寫的 store 替身（session-persistence.test 用了 5 個），所以這條接縫是真的，替身就是第二個 adapter。 |
| core-session | apps/harness/src/jsonl-session-store.ts（JSONL adapter） | 深 | 刪掉它就沒有產品持久化了。檔名與格式知識本來應該只在這裡，實際上 session-list 與 eval/session-scan 各自又宣告了一次（F5）。 |
| core-session | packages/nexus-core/src/session-persistence.ts（SessionPersistenceCoordinator、sessionPersistencePlugin） | 深 | 刪掉它，批次窗口、落後補寫與失敗重試要由每個入口自己做；介面只有建構與 flush／dispose，槓桿大。 |
| core-session | packages/nexus-core/src/session-registry.ts | 深 | 刪掉它，參與者要各自追蹤會話的開關並自己處理「後來才掛上」的補播，複雜度會回到每個 plugin。 |
| core-session | packages/nexus-core/src/sessions.ts（createSessionRunner、SessionSubject） | 混合 | runner 那一半刪了會讓 5 個參與者各自重寫回滾與圍堵，是深的；SessionSubject 很薄，「管不管這一份」明文交給參與者自己看 address（與 dsh 同形，見 cleared）。 |
| core-session | packages/nexus-core/src/session-address.ts | 深 | 刪掉它，checkpoint_ns 的格式知識會散進 turn-cancel、checkpoint-policy 等呼叫者；否定 grep 證實今天沒有人自己 split('|')。 |
| core-session | packages/nexus-core/src/conversation-replay.ts | 深 | 刪掉它，續接、serve 接回各自要重寫還原規則，槓桿大。但「哪些種類會進模型」只寫在 session-log 的散文裡，新種類會靜默掉進 default（F4）。 |
| core-session | packages/nexus-core/src/session-telemetry-coordinator.ts | 深 | 刪掉它，每個後端要自己訂閱日誌、套脫敏、處理關機，複雜度散到 sink 實作裡。 |
| core-session | packages/nexus-core/src/session-telemetry.ts | 淺 | 大半是型別與一張表，刪了只是把定義搬到協調器旁邊；那張逐種表是詞彙窮舉絆索之一（F1），在開放詞彙下需要改成有預設值的形狀（F2）。 |
| core-session | packages/nexus-core/src/logged-message.ts | 淺 | 介面幾乎等於 LangChain 的 StoredMessage 本身，讀文字、讀 id、讀 finish_reason 的邏輯都不在這裡，4 個讀方各自伸進 data 重寫一份（F3）。刪掉它，複雜度幾乎不會增加，這正是它淺的證明。 |
| core-session | packages/nexus-core/src/feedback.ts | 混合 | 折疊與服務是實在的領域邏輯；但 loggedMessageId 與 hasText 其實是訊息的通用讀法，住錯了家（F3），定輪也是自己再寫一份（F6）。 |
| core-session | packages/nexus-core/src/inbox.ts | 淺 | 兩個小函式加酬載型別，刪了會回到 pump 內部；淺但沒有外洩的事實。 |
| core-session | packages/nexus-core/src/tool-events.ts | 淺 | 介面小、實作也小；價值在於把「Error: 」前綴收成單一生產者，並有絆索守住（見 cleared）。 |
| core-session | packages/nexus-core/src/session-stats.ts | 淺 | 一個折疊函式；定輪規則自己再寫一份（F6）。我們沒有 dsh 的投影註冊表，stateVersion 目前沒有消費者。 |
| core-session | packages/nexus-core/src/session-checkpoint-policy.ts | 淺 | 介面與實作都小，但把一條時刻政策集中在一處；刪了會散進 agent 組裝。 |
| core-session | apps/harness/src/session-list.ts | 混合 | 刪掉它，列表這個產品功能就沒了；但它的檔案格式知識是從 JSONL adapter 複製出來的，屬於應該在 SessionStore 後面的東西（F5）。 |
| wire-seam | packages/nexus-wire/src/protocol.ts | 混合 | 刪掉後方法名、錯誤碼、路徑會在 harness 與 web 各寫一份，複雜度散回呼叫端，所以常數這一半在賺；但「歷史不帶 seq」這類承重約束只寫在散文裡、靠 history.test 撐著，這一半的介面比實際約束窄。 |
| wire-seam | packages/nexus-wire/src/conversation.ts | 深 | 刪掉 web 要自己重寫整套折疊，而且即時與歷史兩條路會各折各的而分岔——複雜度集中在這裡，是深模組。缺口在它的輸入面：ToolEntry 沒有錯誤碼（F2）、custom 名字沒有清單（F5）。 |
| wire-seam | packages/nexus-wire/src/client.ts | 深 | 刪掉 web 與 harness 的契約測試都得自己拼 fetch、解 SSE、驗回應——它吸收了真實複雜度。但它沒有涵蓋 changes 與 deliverables 的五條 GET 路由，那一半已經是「刪掉之後」的樣子（F4）。 |
| wire-seam | packages/nexus-wire/src/sse.ts | 淺 | 介面小、實作也小，但刪掉就是兩端各一份編解碼、各自漂移；淺但在賺，留著。 |
| wire-seam | packages/nexus-wire/src/deliverables.ts、workspace-changes.ts | 淺 | 刪掉路徑函式只會把一行字串拼接搬回兩端；真正的契約（查詢參數、拒絕理由對狀態碼、回應驗證）本來就不在這裡，而是兩端各寫一份（F4）。介面幾乎等於實作，是淺模組。DTO 型別這一半在賺（C_ws）。 |
| wire-seam | packages/nexus-wire/src/todos.ts、inbox.ts、context-pressure、session-totals | 淺 | 刪掉名字與 DTO 會回到兩端各一份，所以名字常數在賺；但沒有一份「有哪些名字」的清單，生產者多一個名字時折疊器不會知道（F5）。 |
| wire-seam | packages/nexus-wire/src/invariant.ts | 淺 | 刪掉不會把任何複雜度散出去；它存在是為了 repo 的結構規則，不是為了吸收複雜度。 |
| wire-seam | apps/harness/src/wire-handler.ts | 深 | 刪掉路由、SSE、thread 的建立與回收會散回 serve.ts 與每支測試——深模組。ThreadAgent 介面面積大，而且 attach 的順序是介面外的事實（併入 harness-composition-root-02）。 |
| wire-seam | apps/harness/src/thread-pump.ts | 深 | 刪掉就沒有東西把 LangGraph 串流翻成瀏覽器看得懂的 frame——複雜度都在這裡。缺口是上線投影丟掉日誌裡的錯誤碼（ToolVerdict 只有 failed／text／meta，F2）。 |
| wire-seam | apps/harness/src/conversation-history.ts | 深 | 刪掉歷史要從別處重建，而且 *Data 投影一分為二，即時與歷史就會分岔；共用這一份正是它的價值（C_proj）。 |
| wire-seam | apps/harness/src/serve.ts | 淺 | 它本身不吸收複雜度，只是接線；刪掉接線回到呼叫端。ThreadAgent 有產品 adapter＋測試組裝兩個實作，這個接縫是真的，不是假想接縫。 |
| wire-seam | apps/web 的四個路由 store（changes-summary、changes-diff、deliverable-file、deliverable download） | 淺 | 刪掉一個只會把同樣的 fetch＋狀態碼判讀搬進元件；它們在重做一份本該由 wire 吸收的契約，而且沒有任何測試拿它們打真的 handler（F4）。 |
| plugins-interaction | @nexus/plugin-goal | 深 | 刪掉之後，折疊、授權、CAS 與續行文字會在 harness 的排程器、每個入口點與伴生裡重新出現——它有在賺。attached() 是例外：產品碼零消費者，刪了不會在任何呼叫者重現。 |
| plugins-interaction | @nexus/plugin-plan-mode | 深 | 刪掉之後模式狀態、指引注入與 exit_plan_mode 的拒絕要在 fold、閘門與 harness 各寫一份——有在賺。 |
| plugins-interaction | @nexus/plugin-todo | 混合 | 工具本體與驗證刪了就沒有重現的地方（有在賺）；但讀這份事件的投影規則已經住在消費者那側，套件本身只負責寫。 |
| plugins-interaction | @nexus/plugin-ask-user | 深 | 刪掉之後問答的中斷、取消與拒絕句要在 harness 或 web 重做——有在賺；但它的正確性有一半押在組裝點（見 plugins-interaction-r2-04）。 |
| plugins-interaction | @nexus/plugin-submit-record | 深 | 刪掉之後「送出一列必經核准」與表頭對齊要改由 write_file 加路徑猜測，射程變大——有在賺。backend 共用有 submit-record-mounts.test.ts 當絆索。 |
| plugins-interaction | @nexus/plugin-feedback | 深 | 規則刪了會在 wire 路由與 web 各重現一份——有在賺；只有 /feedback 為了找 root 日誌而當 sessions 參與者那一段是轉手（見 plugins-interaction-r2-05）。 |
| plugins-interaction | @nexus/plugin-commands | 深 | 刪掉之後 REPL 與 wire-handler 各要自己解析與寫配對事件——有在賺。 |
| plugins-interaction | @nexus/plugin-echo | 淺 | 刪掉之後沒有任何複雜度在別處重現；它自稱的「plugin 不需要 import harness 的唯一證據」今天由全部 plugin 一起證明。它留在出貨清單是產品決定，不是介面理由。 |
| plugins-interaction | @nexus/plugin-agent-instructions | 深 | 刪掉之後指令注入要回到基座 memory middleware（形狀不同、會叫模型寫記憶）或在 harness 重做——有在賺。依賴基座私有鍵 _summarizationEvent，已有上游絆索。 |
| plugins-interaction | apps/harness/src/goal-driver.ts | 混合 | 決策與兩次決定的閘刪了會在 pump 與 REPL 各重現——有在賺；但觸發集合已經在兩個呼叫端各寫一份（見 plugins-interaction-r2-03）。 |
| plugins-capability | @nexus/plugin-mcp | 深 | 刪掉後，連線、列工具、命名正規化、內容投影與關機都得在每個想接 MCP 的呼叫者重寫一次——它在賺。只有 MCP_CAPABILITY 那一行刪了沒人發現（見發現 02）。 |
| plugins-capability | @nexus/plugin-skills | 淺 | 刪掉後組裝點多寫一行 addSource 與一個預設路徑即可，複雜度幾乎不重現；它薄是檔頭明說的選擇。能力名 'skills' 零消費者。 |
| plugins-capability | @nexus/plugin-memory | 淺 | 刪掉後組裝點多一行 addSource，複雜度不重現。能力名 'memory' 零消費者。 |
| plugins-capability | @nexus/plugin-quickjs | 深 | 刪掉後 VM 生命週期、三個資源上限與失敗分類都得在呼叫者重寫——它在賺。能力名 'quickjs' 零消費者。 |
| plugins-capability | @nexus/plugin-sandbox-policy | 深 | 刪掉後政策句、/sandbox、升級、委派快照與 sandbox/mode 事件全部消失，而 fence 還在擋——複雜度會在組裝點與 fence 兩邊重現。它在賺。 |
| plugins-capability | @nexus/plugin-telemetry-otel | 混合 | OTel SDK 的配置與外層關機期限會在呼叫者重現（有在賺）；但 mode 的行為面不在這個模組，刪掉它 mode 語義不會跟著消失。 |
| plugins-capability | @nexus/plugin-validation | 淺 | 刪掉主入口什麼都不會在別處重現：repo 內零個 import 它的主入口、零個 requires 'validation'；圍堵與輸出校驗早已是 fold 打底。它只是轉手（見發現 03）。 |
| plugins-capability | @nexus/plugin-present | 深 | 刪掉後檢查、延後發佈、resume 去重與路徑正規化都得在呼叫者重寫——它在賺。只有那顆空 middleware 是轉手（見發現 06）。 |
| plugins-capability | @nexus/plugin-workspace-changes | 深 | 刪掉後 git 快照、副本、比較、時序補記與服務全部要在組裝點或路由重寫——它在賺。 |
| harness-composition-root | apps/harness/src/agent-factory.ts（createNexusAgent） | 深 | 刪掉它，loadPlugins→foldRegistry→createDeepAgent、fold 前的基座名稱撞擊與 harness profile 宣告檢查、失敗時收資源、遙測／不變量／參與者的接線，會在 createCliAgent、eval/runner.ts、spike-agent.ts 三個直接呼叫者各長一… |
| harness-composition-root | apps/harness/src/cli.ts 的 createCliAgent（CLI 與 serve 共用的組裝根） | 混合 | 刪掉它，host-services 的協作者、backend 與 channel 的共用、條件掛載，都得在 CLI 與 serve 兩處重寫，所以它有在賺。但它的模型接縫只開在 HTTP 那一層，8 個要腳本化工具回合的測試檔寧可照它的接法手抄一份，等於複雜度已經在測試裡重現一次。 |
| harness-composition-root | apps/harness/src/cli.ts 的 runCli／main（CLI 入口） | 混合 | CLI 專屬的部分（REPL、印中斷、exit code）刪了就沒了，別處不會重現。但接線四步與它的順序在 wire-handler 裡也有一份，這一段是重複，不是深度。 |
| harness-composition-root | apps/harness/src/serve.ts（runServe） | 淺 | 多數行為是轉交給 createCliAgent 與 wire-handler。刪掉它，要重寫的是 HTTP 起動、認證與每條 thread 續接的膠水，組裝本身不會重現。它是入口，不是深模組。 |
| harness-composition-root | apps/harness/src/plugin-config.ts（loadDefaultPlugins／renderDefaultConfigDump） | 深 | 刪掉它，兩個入口得各自疊層、驗證、查權限。檔頭記著「各寫一次的下場是只有一邊讀得到 home 那一層」，所以它有在賺。 |
| harness-composition-root | apps/harness/src/goal-driver.ts | 深 | 刪掉它，就緒判準、兩次決定與 flush 失敗時的停用，要在 CLI 的 driveGoalRounds 與 thread-pump 各寫一份，所以它有在賺。port 有一個產品 adapter（cli.ts 的 goalDriverPort，兩個入口共用）加上測試替身，是真接縫。 |
| harness-composition-root | apps/harness/src/deliverable-files.ts | 深 | 刪掉它，定位、符號連結與非一般檔的判斷、NUL 判斷與分頁，會落回 wire-handler 的兩條路由各一份，所以它有在賺。 |
| harness-composition-root | packages/nexus-core/src/host-services.ts（createHostServicesPlugin） | 淺 | 刪掉它，每個組裝點都得自己寫一顆只負責 provide 的 plugin，約十幾行。它賺的是「只有一種機制」的一致性（照 dsh「組裝點也貢獻一個條目」），不是行為量，是有理由的轉手。 |
| harness-composition-root | monorepo 套件相依圖（22 個 package.json 與實際 import） | 混合 | 這裡不適用刪除測試，改用邊檢查：沒有未宣告的 @nexus 裸 import，也沒有宣告了卻沒用到的邊。 |
| core-middleware-tools | packages/nexus-core/src/containment.ts | 深 | 刪掉它，錯誤分類、日誌起訖與 meta 收尾會散到每顆工具與每個 plugin，複雜度在 N 個呼叫者身上重現，所以它有存在價值。唯一不屬於它的是 resolveToolName 這個小工具，住在這裡只是方便。 |
| core-middleware-tools | packages/nexus-core/src/approval.ts | 深 | 刪掉它，每個要人看的 plugin 都得自己寫 interrupt、resume 與決策合併，複雜度會重現，所以它有存在價值。但 channel 以值傳入，把「組裝當下就凍住」這件事漏到介面外（見 core-mw-02）。 |
| core-middleware-tools | packages/nexus-core/src/turn-cancel.ts | 混合 | 兩顆 middleware 有存在價值：刪掉的話，pump 得在每顆工具與每次模型呼叫自己檢查中止。常數這一面很淺，但它是 thread-pump 以 import 取用的公開介面；web 那一側只能比對文字（見 seed-2）。 |
| core-middleware-tools | packages/nexus-core/src/observation.ts | 深 | 刪掉它，先讀後改的規則會回到每顆檔案工具裡，複雜度重現，所以它有存在價值。它帶有逐 agent 的狀態，fold 因此對它逐個建。 |
| core-middleware-tools | packages/nexus-core/src/fs-tool-errors.ts | 混合 | 這個能力有存在價值：拿掉之後，基座檔案工具的失敗看起來就跟成功一樣。但它是成對的兩半，介面比能力寬（見 core-mw-04）。 |
| core-middleware-tools | packages/nexus-core/src/invalid-tool-args.ts | 深 | 刪掉它，解不開的參數不是讓串流整條拋掉，就是被當成 {} 真的執行，複雜度會回到每個消費者，所以它有存在價值。它的安全前提放在另一個模組（見 core-mw-07）。 |
| core-middleware-tools | packages/nexus-core/src/read-continuation.ts | 混合 | 照 dsh 讀檔視窗的能力有存在價值。但只掛 middleware、不包 Proxy 時，limit 仍被拉到 2000，卻沒有 50 KiB 上限；這件事型別看不出來（見 core-mw-04）。 |
| core-middleware-tools | packages/nexus-core/src/tool-result-meta.ts | 混合 | 給 web 卡片的 meta 有存在價值。它的做法是讓三個參與者（圍堵開槽、Proxy 與 read-continuation 寫入）經模組層 ALS 旁通道傳遞，不在任何一個模組的介面上。 |
| core-middleware-tools | packages/nexus-core/src/sandbox.ts | 淺 | 刪掉它，型別會同時複製到 fence（harness）與控制器（plugin）兩邊。它是接縫的定義，本來就不該深，淺是刻意的，有存在價值。 |
| core-middleware-tools | packages/nexus-core/src/code-language.ts | 淺 | 內聯到讀檔 meta 也行，但照抄 dsh 的表放在獨立檔，比較容易逐字對照上游。淺但無害。 |
| core-middleware-tools | packages/nexus-core/src/output-schema.ts | 深 | 刪掉它，ask-user 與 goal 各自得驗輸出。這是有兩個 adapter 的真接縫。 |
| core-middleware-tools | packages/nexus-core/src/subagent-delegation.ts | 淺 | 可以內聯進 foldSubAgents。留成獨立一顆的好處是有名字可排序、可測。淺但無害。 |
| core-middleware-tools | packages/nexus-core/src/fold.ts（本叢集的接縫，本身不在範圍清單內） | 混合 | 組裝點有存在價值。但兩份清單互相重複，沒有共同來源（見 core-mw-01）。 |
| core-middleware-tools | packages/nexus-plugin-sandbox-policy/src/index.ts | 深 | 刪掉它，政策句、委派邊界與模式紀錄會散回 harness，有存在價值。 |
| core-middleware-tools | packages/nexus-plugin-sandbox-policy/src/sandbox-mode.ts | 深 | 單一的權威狀態格，有存在價值。讀取邊界缺驗證（見 core-mw-05）。 |
| core-middleware-tools | packages/nexus-plugin-sandbox-policy/src/sandbox-escalation.ts | 混合 | 工具與 gate 同批註冊，避免只有一半的組裝，這點是對的。但工具的安全全靠另一個註冊點上的排序（見 core-mw-06）。 |
| core-middleware-tools | packages/nexus-plugin-sandbox-policy/src/invariant.ts | 淺 | 刪掉它會失去配套入口的包名歸屬（repo 的結構規則要求有）。本身不藏任何東西，淺是刻意的。 |
| core-middleware-model | packages/nexus-core/src/summarization.ts | 深 | 刪掉後，fold 與每個 agent 都得自己疊四層包裹（剪刀、預算、日誌、靜音）並重寫基座那幾條私有路徑的判準，複雜度在多處重現：它有在賺。 |
| core-middleware-model | packages/nexus-core/src/tool-result-pruner.ts | 深 | 刪掉後，剪法、code point 預算與設定驗證會搬進 summarization.ts，設定條目也得另寫一份驗證：它有在賺。 |
| core-middleware-model | packages/nexus-core/src/repeat-reminder.ts | 混合 | 刪掉後，防打轉只剩 recursionLimit，離線掃描也得自己重寫「同一個呼叫」的判法：主體有在賺。但清零判準那一格是一張寫死的記號白名單，插件要注入訊息就得回頭改它，這一格是淺的。 |
| core-middleware-model | packages/nexus-core/src/model-calls.ts | 深 | 刪掉後，會話統計的步數、續接重建的 AI 訊息、max-tokens 的一輪判準、web 歷史都失去同一個來源，要在多處各自重建：它有在賺。 |
| core-middleware-model | packages/nexus-core/src/model-usage.ts | 混合 | 記錄器刪掉後，用量表與落盤帳目都失去來源：有在賺。設定條目本身是刻意的淺殼（沒有設定，只承載開關），刪掉它等於拿掉「可關」這一格，不是轉手。 |
| core-middleware-model | packages/nexus-core/src/max-tokens.ts | 深 | 刪掉後，判準得在 CLI 與 thread-pump 兩個收尾點各寫一份，子代理截斷的父側呈現也要在 task 周圍重寫：它有在賺。 |
| core-middleware-model | packages/nexus-core/src/token-estimate.ts | 深 | 刪掉後，o200k 分段編碼、錨、內容比例與借錨會回到 summarization.ts 的兩個呼叫點：它有在賺。 |
| core-middleware-model | packages/nexus-core/src/token-usage.ts | 淺 | 刪掉後，conversation-history.ts 內聯十幾行折疊就能取代；deriveTokenUsage 的使用者只有測試。它的價值在對齊 dsh 投影單元的形狀，不在隱藏複雜度。淺，但無害。 |
| core-middleware-model | packages/nexus-core/src/commands.ts | 混合 | 刪掉後，registry.ts 要吸收驗證，每個註冊命令的 plugin 與 plugin-commands 的執行器要改從別處拿型別：驗證那一半有在賺，型別那一半只是共享詞彙。 |
| core-middleware-model | packages/nexus-core/src/goal.ts | 淺 | 刪掉後，這些型別只能搬進 session-log.ts：封閉的 SessionEventMap 要寫得出酬載型別，就不能放到 plugin。這只是把詞彙從 session-log 拆出來的檔案切分，淺是設計而非缺陷。 |
| core-middleware-model | packages/nexus-core/src/todo.ts | 淺 | 同 goal.ts：刪掉後會在 session-log.ts 重現。消費者還有 harness 的 conversation-history 與 thread-pump，放在 core 有實際理由。 |
| core-middleware-model | packages/nexus-core/src/deliverables.ts | 淺 | 同 goal.ts：刪掉後會在 session-log.ts 重現；harness 的 deliverable-files 與 thread-pump 讀它，wire 另有一份鏡像。 |
| core-middleware-model | packages/nexus-core/src/fixtures.ts | 淺 | 刪掉後，core 的六個測試檔各自重寫同樣的替身：它對測試有在賺，不在產品介面上。 |

## 看過、判定沒問題的接縫

- **core-plugin-system**｜plugin 核心三檔（plugin.ts、load.ts、entries.ts）與基座的相依邊界：kernel-boundary.test.ts 用 KERNEL_FILES 釘住這三檔不相依 deepagents（#358）。它們遞移 import 到的 session-address.ts 與 commands.ts 本身沒有任何 import，執行期閉包是乾淨的。
- **core-plugin-system**｜工具的 scope 與 subagent 的對應（第一輪 04、07）：往不存在的 subagent 加工具會在 fold 當場拋，錯誤訊息指名層名與註冊者，也有測試釘著。dsh 沒有「雙向驗證」：477b4f4 的 git ls-files 找不到任何 validate.ts 或 bundler 檔，scopePaths 全 repo 0 筆。dsh 的 ScopeKey 就是 agent 物件，結構上指不到不存在的 agent。
- **core-plugin-system**｜backend 折疊與它的消費者（第一輪 06）：backend 先折，先讀後改策略、檔案工具錯誤標記、plugin middleware 攤平都在它之後，拿的是同一個區域變數，結構上就是同一個實例。
- **core-plugin-system**｜middleware 包裹層次（第一輪 01）：層次是基座的圖語意，排序知識集中在 fold 內部，plugin 端只拿得到 prepend，全名單測試釘著順序。這是深模組把知識藏在內部，不是漏到介面外的事實。
- **core-plugin-system**｜plugin middleware 在 root 與子代理間共用實例，以及摘要器例外（第一輪 02、05）：契約寫在 use 的介面上：逐 agent 的狀態要從呼叫身分查，不放閉包；摘要器例外也寫在同一處。沒有工廠介面是 fold.ts 登記過的偏離，而且跟 dsh 同一個契約：dsh 的共用 plugin 以 WeakMap<Session> 放逐 agent 狀態。「沒有絆索」這一點登記裡自己承認了，今天全樹零顆帶逐 agent 閉包狀態的 plugin middleware。
- **core-plugin-system**｜具名條目集合 entries.ts：跟 dsh scope/store.ts 的 NamedEntries 同名同形：撞名政策由建構時注入，undo 是冪等的。
- **core-plugin-system**｜兩條 backend 通道：backend.mount 與 BACKEND_SERVICE：submit-record 拿的是折前那一個 backend，一致性靠「預設清單裡零個 backend.mount()」這條絆索守住。哪天有人掛路由，測試會紅。**盤點後更正：這一條不成立。** 組裝點在 fold 之前已經用 CompositeBackend 把 `/large_tool_results/` 與 `/conversation_history/` 路由到另一顆 backend，絆索只數 backend.mount()，看不到這一層，所以 submit-record 拿到的跟工具實際讀寫的不是同一個（讀碼推得，沒有實測）。見 #694。
- **core-plugin-system**｜服務注入的清單順序：「缺件當場失敗、清單順序承重」是登記過的偏離（deepagents／LangGraph 沒有 cordis 的反應式 inject）。今天沒有 plugin 對 plugin 的 apply 期服務相依：git grep 'services.get(' -- apps packages（排除測試）顯示，apply 期讀服務的只有 ask-user 的 CHANNEL_SERVICE 與 submit-record 的 BACKEND_S…
- **core-plugin-system**｜HostServices 的寬索引簽名：收任意服務名，跟 dsh cordis 的 provide(name: string, value?) 一致；registry.ts:220-221 也寫明了這一點。已知的服務名仍有具名型別的多載。
- **core-plugin-system**｜PluginRegistry 的通道數：registry-channel-count.test.ts 用 satisfies Record<keyof PluginRegistry, true> 窮舉每個通道，加一個通道就會型別紅。它守的是通道層級，方法層級不在射程內，N1 就是方法層級漏掉的例子。
- **core-plugin-system**｜核准閘門條目關不掉：閘門由 foldApprovalGate 無條件建，條目只是在場標記。harness 以 YAML 模組名擋住把它標成 disabled 的 patch，換 id 插進來的列也擋得到。
- **core-plugin-system**｜包自有不變量的配套入口清單：invariant-companions.test.ts 對磁碟窮舉，每個 packages/* 的 owner 都要在 COMPANIONS 裡，二十個入口都要 import 得到、名字互不相撞。
- **core-plugin-system**｜nexus-core 的 fold 與 SessionEventType（第一輪 03）：nexus-core 的 fold.ts 與 fold.test.ts 裡 SessionEventType 都是 0 筆。窮舉它的是 goal 套件自己的 fold.test，屬於 core-session 叢集（#507 open）。
- **core-session**｜三處事件詞彙窮舉（session-telemetry 的逐種表、eval/session-scan 的 KNOWN_EVENT_TYPES、goal 的 fold.test）與 tsc 覆蓋：各套件 tsconfig 都是 include ["src"]，*.test.ts 在 src 底下，CI 跑 pnpm -r run typecheck；實測 node_modules/.bin/tsc -p <pkg> --listFilesOnly 在 goal、core、harness 三個套件分別列得到 fold.test.ts、session-telemetry.ts、eval/session-scan.ts，而且每個套件的…
- **core-session**｜session-address：checkpoint_ns 的格式：分隔符與解析只在 session-address.ts 一個檔；turn-cancel 等呼叫者透過 toolCallSessionAddress 判斷。否定 grep 證實沒有其他地方 split('|') 或自己解析 checkpoint_ns。小介面藏住格式，是深模組。
- **core-session**｜SessionRegistry 與落盤／遙測協調器的「先取現有再訂閱」（推翻 core-session-05）：registry.observe() 先交出現有條目再加入集合；落盤協調器先推 events.slice(storedCount) 再訂閱；遙測協調器同形。全程同步，沒有漏事件的縫；呼叫者不需要知道這個順序。
- **core-session**｜sessions.join 參與者自己依 address 過濾（推翻 core-session-06）：sessions.ts 明文規定參與者自己決定管不管這一份，address 在 SessionSubject 的型別上；goal、feedback、plan-mode、workspace-changes、sandbox-policy 都照做。dsh 也是消費者自己看 session.header.origin。
- **core-session**｜落盤與遙測兩個協調器的失敗政策（推翻 core-session-07）：兩者的 options 型別不同（收 stored 或收 sink），不能互換。落盤背景失敗保留並重試，flush() 是唯一響亮出口；遙測後端失敗只 warn。各自是深模組藏好的實作。
- **core-session**｜fromLoggedMessage 的深拷貝：fromLoggedMessage 內建 structuredClone 再交給 mapStoredMessagesToChatMessages；否定 grep 證實沒有人繞過它直接呼叫 LangChain 的轉換，凍結事件不會被改到。
- **core-session**｜TOOL_ERROR_PREFIX 的生產者與全部消費者：唯一生產者是 tool-events.ts:146。非測試消費點有 tool-events.ts 的 errorResult、invalid-tool-args.ts 的 INVALID_ARGUMENTS_REFUSAL、turn-cancel.ts 的 TOOL_ABORTED_TEXT（另一處在同檔），以及 core index 的匯出。session-log.ts 不消費它，完整性檢查者那一句說錯了。
- **core-session**｜SESSION_LOG_FORMAT_VERSION 的生產者與全部消費者：生產者是 session-store.ts:188。非測試消費點：core 的 session-persistence（新檔 header）、session-store 的錯誤訊息、index 匯出；harness 的 jsonl-session-store（續接時拒絕較新版本，續寫時把 header 蓋成這一版）、session-list、eval/session-scan、eval/session-draft。
- **core-session**｜session-checkpoint-policy 的掛點：「三個點併成兩個掛點」等偏離已在檔頭登記；只對 root 排空是刻意選擇。
- **core-session**｜SessionLog.append 的順序、重入與圍堵：append 同步回呼觀察者，帶重入防護，listener 清單在推進前凍住並逐一圍堵，順序照 dsh。
- **core-session**｜遙測脫敏與讀日誌的路徑（推翻 session-telemetry-read-path-01）：脫敏是註冊式的 SessionTelemetryRedactRule，作用在送出去的 SessionTelemetryRecord 副本上，鏡像不回頭改寫日誌；conversation-replay 與 session-stats 讀的是日誌本身。草稿說的那張表不存在。
- **wire-seam**｜歷史 frame 不帶 seq：約束寫在 protocol.ts 的 historyPath 說明與 conversation-history.ts 的 frame()，並有 history.test 的對照組（帶了耐久 seq 的話即時回覆整則不見）撐著。
- **wire-seam**｜*Data 投影由即時與歷史共用：deliverablesData 等投影的輸入與輸出都有型別，pump 與歷史投影共用同一份，wire 的 DTO 一改兩條路同時編不過（推翻 wire-seam-hidden-06 的依據）。
- **wire-seam**｜SSE 編解碼：sse.ts 一份，client 解、wire-handler 編，兩端共用。
- **wire-seam**｜WireClient 的 fetch 注入與契約測試：只用 fetch、可注入；harness 的測試 fixture 以 createWireClient 打真 server，WireClient 涵蓋的路由有跨接的契約測試（它沒涵蓋的 GET 路由見 wire-seam-r2-04）。
- **wire-seam**｜通道白名單：WIRE_CHANNELS 在編譯期被釘成 @langchain/protocol Channel 的子集。
- **wire-seam**｜run.cancel 與 queue.update 對 dsh：run.cancel 受理就回、停下來的事實走下行，照 dsh 的 cancel（keepInbox）；queue.update 的找不到項目有專屬錯誤碼，對應 dsh 的 session/queue-item-not-found。附註一處差異：對沒接上的 session，dsh 回 not found，我們不經 threadFor、直接回受理——註解寫了理由（不替沒開過的 thread 建 agent），但沒標成偏離。
- **wire-seam**｜先開下行、再拿歷史的順序：openEvents 的介面寫明「promise 兌現代表線已經開好」，web 照這個順序先 openEvents 再 threadHistory，沒有漏掉兩者之間的 frame。
- **wire-seam**｜HISTORY_PAGE_MAX_BYTES：常數在 wire，harness 的 conversation-history.test 以數值釘住，兩端同一份。
- **wire-seam**｜attach 順序（wire-seam-03 的更正依據）：有功能意義的順序只有「不變量先於 session」；wire-handler 自己註明落盤排最後在功能上沒有差別。同一段順序在 cli.ts 與 wire-handler.ts 各寫一次，接線義務本身歸 harness-composition-root-02。
- **wire-seam**｜workspace-changes 的 DTO：WorkspaceChangesSummary 只有 wire 這一份，plugin 與 web 都 import type 它，沒有第二份會漂移（wire-seam-05 的更正依據；方向問題歸 plugins-capability-01）。
- **plugins-interaction**｜core 對本叢集 plugin 的工具名（第一輪 plugins-interaction-01 的主張）：剝掉註解後掃 packages/nexus-core/src 全部 50 個非測試檔（python 剝註解掃字面值，另以 git grep 過濾註解行交叉核對），ask_user_question、submit_record、todo_write、exit_plan_mode、create_goal／get_goal／update_goal、'echo'、'plan'、'goal'、'feedback'、'todo' 在非註解碼的唯一命…
- **plugins-interaction**｜範圍內九個 plugin 之間的直接相依：逐套件掃 src 與 package.json 的 '@nexus/plugin-*' import、動態 import、相對路徑讀檔，除了自己的測試 import 自己，零命中；跨 plugin 的協作全經 @nexus/core 的 registry（services／sessions／approvals）。
- **plugins-interaction**｜goal 的決策、renderer 與伴生的分工（第一輪 plugins-interaction-02 的前半）：goal-driver.ts、plugin-goal index.ts、invariant.ts 三處檔頭寫的是同一套分工：排程器在 harness（#180 登記的載體偏離），renderer 是續行文字的唯一來源、伴生逐字比對，而且伴生只要有 kind: 'goal' 就武裝、與有沒有掛排程器無關。排程器以型別化的 GoalDriverPort 問域，不 import GoalService。
- **plugins-interaction**｜serve 沒有操作者的續行輪數上限（只有 CLI 有 --max-goal-rounds）：與 dsh 同形：dsh 的 driver 沒有設定，上限屬於目標本身，而 create_goal 讓模型填 max_goal_rounds，服務以 request ?? default 取值。CLI 的 --max-goal-rounds 是 goal-driver.ts 登記過的載體偏離，理由是 HEADLESS_APPROVALS 下旗標後面直接是一支燒 API key 的迴圈；serve 會停在核准點等人，沒有同一個前提。
- **plugins-interaction**｜plan-mode 的 /plan 當場寫日誌，靠發派面保證命令只在兩輪之間執行：已登記、有絆索。dsh 在輪中把選擇排著、到下一個 pre-step 才提交（set 回 committed／queued／cancelled／noop）；我方 plan-mode 檔頭登記了「命令一定跑在兩輪之間所以不需要那一格」，前提由 wire-handler 的 handleSlash 在 running、停在核准點、另一個命令在跑時拒收來保證，slash-wire.test.ts 釘著；
- **plugins-interaction**｜斜線命令的序列性（plugin-commands 執行器與配套入口）：執行器的檔頭寫明序列性是前提、並行會被配套入口報成違規；REPL 由 readline 保證，serve 由 handleSlash 的 slashInFlight 擋。第一輪把這條引成「登記在 goal-driver.ts:72」是錯引，那一行談的是 blockedAfterConsecutiveRounds。
- **plugins-interaction**｜todo 的清單投影寫在消費者那一側：已登記的載體偏離（#575：我們沒有投影註冊表），規則照抄 dsh、由 harness 的 pump 與歷史路由合成 custom frame、@nexus/wire 折疊。那是 wire-seam 叢集的接縫，本叢集只確認 plugin-todo 這一側的介面（一顆工具＋一個必填設定）沒有額外的隱性義務。
- **plugins-capability**｜WORKSPACE_CAPABILITY（sandbox-policy 提供、present 消費）：定義在 @nexus/core 的 sandbox.ts，定義處寫明提供者、判準與「為什麼 backend 答不了」；一個提供者由組裝點只在有 workspaceRoot 時掛，一個消費者，產品路徑測試釘住沒工作區就拒絕。第一輪 02 推翻。
- **plugins-capability**｜sandbox-policy 對 sandboxPolicy 服務的硬相依與載入順序：requires 由 assertRequires 在所有 apply 之後檢查，apply 當下的 services.use() 先拋，兩者都是大聲失敗；服務是組裝點注入控制器的 port，偏離已登記在 SandboxPolicyService；組裝點把協作者排最前並寫明理由。第一輪 03 推翻。
- **plugins-capability**｜present 的延後發佈（等配對 tool/result 成功才寫 deliverables/presented）：時序寫在 core 的 SessionEventMap 與 present 檔頭；單元測試逐條釘住成功、被判錯、別人的結果、resume 同 callId、收掉之後五種情況，harness 另有真圖真圍堵的端到端測試。這是 dsh `ctx.on('tools/result')` 最接近的載體。第一輪 04 推翻。
- **plugins-capability**｜workspace-changes 的 afterAgent 與 sandbox-policy 的 wrapModelCall：兩者做不相干的事，沒有共享狀態或順序約束；各自登記了選掛點的理由並對到 dsh 的 agent/turn-stopping 與每次組 prompt 重算的 text 函式。第一輪 05 推翻。
- **plugins-capability**｜MCP 工具命名 mcp__<serverName>__<raw> 與撞名：serverName 形狀與 dsh 一字不差；撞名在 tools 註冊點同層同名當場拋，mcp 又是 fail-closed 載入，所以不會無聲；有專門的撞名測試，也有「送上線的是 raw name」的測試釘住對 adapter 內部的依賴。第一輪 07 推翻。
- **plugins-capability**｜fence（harness 的 ContainedFilesystemBackend）與 SandboxModeController（plugin）之間的合約：兩邊分屬不同套件，合約（SandboxModeSource／SandboxGrant／SandboxDenial／SandboxGrantLedger）住在兩邊都相依的 @nexus/core，正是 dsh 把詞彙與升級協定放在 dsh-sandbox 基底套件的分法。
- **plugins-capability**｜workspace-changes 事件不帶 turn、靠落點認輪（與 pump 的 turn/end 時序）：偏離已登記（#443 第二則決議），時序要求寫在 core 的 SessionEventMap 與 recorder 檔頭；配套不變量檢查事件落在一輪裡且那一輪跑過工具；harness 的端到端測試驗證事件落在 turn/end 之前。
- **plugins-capability**｜telemetry-otel 的關機歸協調器：plugin 刻意不登記 onDispose，shutdown 由協調器轉發；CLI 與 serve 兩條路都接了 attachTelemetry，所以沒有漏接的產品路徑。
- **plugins-capability**｜quickjs 的失敗協定（拋 CodeRunFailedError，由 core 圍堵收成 isError）：照 dsh 的 CodeRunFailedError 繼承 HarnessError，碼跟著進 tool/result；接住它的是兩邊都有的執行管線，不是 plugin 之間的約定。
- **harness-composition-root**｜harness → web 的相依邊（第一輪 03）：harness 對 @nexus/web 有明確的 workspace 相依，serve.ts 的 require.resolve 解的是有宣告的套件。web 不 import harness；web 測試讀 packages 原始碼那件事歸 wire-seam-02。
- **harness-composition-root**｜nexus-core 的 exports 與 cordis.yml 子路徑（第一輪 05）：cordis.yml 用到的子路徑都在 exports 裡。`./src/*` 萬用字元和 dsh 套件同形，全 repo 沒有任何 @nexus/*/src/ 深層 import。
- **harness-composition-root**｜@nexus/* 宣告的相依與實際 import：22 個套件逐一比對：宣告的 @nexus/* 與實際的裸 import（from、import()、require()、resolve()）完全一致，沒有未宣告的邊，也沒有宣告了沒用的邊。plugin 之間零條邊。wire 對 core 只有 import type，web→wire→core 不會把 agent stack 帶進執行期。
- **harness-composition-root**｜清單的動態 import 錨點與 harness 的 package.json：檔頭已寫明「住在 apps/harness/src 是承重的」。dsh 的 base bundle 也由自己的 package.json 持有清單上全部名字的相依（90 個名字全在 deps 裡），錨點是顯式參數 bareModuleBaseUrl。我方的錨點隱含在檔案位置，但今天只有一個 app，不構成耦合問題。
- **harness-composition-root**｜agent-factory 與 plugin 的相依：通用工廠一顆 plugin 都不 import，plugin 專屬的知識（服務名、工廠）全在 cli.ts。這是組裝根應有的分工。
- **harness-composition-root**｜goal-driver 的 port 與兩個入口：它是純決策加上窄 port，產品 adapter 只有一份、兩個入口共用；載體偏離已在檔頭登記。serve 仍預設關 goal 續行，是已拍板（09-19 第 10 題）但未落地的 #445（開），要改的是旗標預設值，組裝結構不擋。
- **harness-composition-root**｜deliverable-files 的錨：錨由呼叫端交進來，模組本身不認得組裝。兩條偏離（overlay 不在這條路上、不經基座 backend）已在檔頭登記。
- **harness-composition-root**｜eval 與 spike 直接呼叫 createNexusAgent、不接 attach*：它們只掛 echo 或 spike 自己的工具，沒有會話消費者，所以不接 attach* 不會漏掉任何東西。
- **harness-composition-root**｜present 對 WORKSPACE_CAPABILITY 的讀取時刻：它在工具被叫時才讀 registry，所以 sandbox-policy 排在它後面也沒事，順序不承重。這也是 hcr-r2-02 建議的形狀。
- **core-middleware-tools**｜output-schema：以工具實例查 schema 的接縫：有兩個真的 adapter（ask-user、goal），宣告跟著工具註冊，校驗排在每個 plugin middleware 的內側，跟 dsh 在 ToolRuntime 的 createSuccessResult 驗 output schema 同一個時刻。沒有缺陷。
- **core-middleware-tools**｜turn-cancel 的 TURN_CANCEL_CONFIG_KEY 與中止理由常數（core → thread-pump）：thread-pump 以 import 取用 TURN_CANCEL_CONFIG_KEY、TOOL_ABORTED_REASON、TOOL_ABORTED_BEFORE_DISPATCH_REASON，有相依邊，改名時編譯器會抓到。
- **core-middleware-tools**｜seed-2：web 以相對路徑讀 turn-cancel.ts 比字串：從 core 這一側看，常數已由 index 公開，是介面的一部分，core 模組本身沒有缺陷。web 只能比對文字，是因為 wire 的 ToolEntry 不帶 error.code，這屬於 wire／web 叢集。可援用的形狀是 ask-user-wire.test 的逐字比對，或照 dsh 讓 ToolEntry 帶上碼。
- **core-middleware-tools**｜seed-3：有狀態的 middleware 替子代理逐個建：foldSubAgents 的 context 把 observationPolicy 與 summarizer 宣告成工廠，其餘宣告成實例，規則寫在型別上。載體刻意共用，有明文理由。這組裡帶逐 agent 狀態的只有 observation，fold 對它逐個建；dsh 的 fs-observation-policy 也以 agent 為鍵分開狀態。
- **core-middleware-tools**｜noteSandboxDenial（fs-tool-errors ← contained-backend）：fence 以 import 呼叫它，有相依邊，而且只有在給了 backend 時才有 fence。它讓「被沙箱擋下」的失敗在工具結果上帶對碼，沒有隱性耦合。
- **core-middleware-tools**｜sandbox.ts 的 SandboxGrantLedger／SandboxModeSource 合約（fence 在 harness、控制器在 plugin）：照 dsh 的 sandbox 基底套件把合約放在兩方都能相依的 core。兩個實作方（contained-backend 讀，SandboxModeController 實作）各在一邊，是真接縫。只剩讀回不驗詞彙的缺口，已列為 core-mw-05。
- **core-middleware-tools**｜全 repo 結構絆索：tool-error-prefix.test、interception-index.test：這兩條刻意跨套件掃路徑與字串，本來就是結構絆索，不是測試越過介面。
- **core-middleware-tools**｜code-language.ts 與 subagent-delegation.ts 兩個淺模組：前者逐字照抄 dsh 的表，值會進日誌；後者需要一個名字來排序與測試。兩者都淺但無害，刪了也不會讓介面更小。
- **core-middleware-tools**｜packages/nexus-plugin-validation（不在本叢集範圍，只記一筆）：只有 re-export，外加一個 'validation' 能力而零讀者，是淺模組。範圍外，不立發現，交給負責 plugin 的叢集判斷。
- **core-middleware-model**｜token-estimate 的兩個消費者（摘要預算、用量表）：用量表讀的是預算層記進日誌、剛比過的那個數，同源；剪刀那個呼叫點的差異有界且有文件。見 seed-2。
- **core-middleware-model**｜摘要關掉時的同名空殼：已登記偏離（#446），文件四處、測試一條。見 seed-3。
- **core-middleware-model**｜goal／todo／deliverables／commands 詞彙住 core、域住 plugin：共享詞彙、封閉聯集已登記為刻意選擇，消費者跨 harness 與 wire；commands 的前提在 serve 成立。見 seed-1。
- **core-middleware-model**｜max-tokens 的一輪判準讀 model-calls 寫的 assistant/message：兩者之間沒有 import 邊，是經日誌傳遞的隱性耦合。但 model-calls 無條件掛、沒有設定條目可關，兩顆的相對位置由 fold.test.ts 的排序斷言釘住，harness 的 max-tokens.test.ts 走產品路徑驗收。dsh 在 loop 內追蹤 sticky 原因，這一格的載體差在 max-tokens.ts 檔頭寫明。
- **core-middleware-model**｜摘要器對 deepagents 私有實作的依賴（同名字串、getEffectiveMessages 抄本、溢出恢復的 catch、_summarizationEvent 鴨子型別、nostream 標記）：true-external 相依，沒有型別邊，但每一處都有登記與上游絆索：summarization.test.ts 數 stack 名字；context-overflow.test.ts 釘溢出恢復路徑與合成拋錯；agent-instructions.test.ts 釘 _summarizationEvent 的鍵名與切點語意。
- **core-middleware-model**｜usage_metadata 被錨與 model/usage 兩個讀者用不同規則讀：錨只要正的有限數，model/usage 要安全整數且總量不得小於組成。規則不同，但 dsh 同形：TokenMeter 的錨直接用事件上的原始 usage，用量投影另做 normalizeUsage。不是偏離。
- **core-middleware-model**｜剪刀只在摘要開著時有作用：與 dsh 同：pruner 唯一的消費者是壓縮，以 ctx.get 選擇性地取。
- **core-middleware-model**｜fixtures.ts 的歸屬：只給 core 自己的測試用，不從 index.ts 匯出；package.json 雖有 ./src/* 萬用子路徑，全 repo 沒有人經 @nexus/core/src/ 取用（git grep -n -E "@nexus/core/src/" 零筆；fixtures 的匯入者只有 core 的六個測試檔，apps/harness 的 './fixtures.js' 是它自己那一份）。

## 方法與限制

- **跟七層盤點同一套流程**，細節見 [`seven-layer-inventory-2026-09-26.md`](seven-layer-inventory-2026-09-26.md) 的「方法與限制」。
  - 第一輪的子代理被全域設定覆寫成 Haiku，結果只當提示用。
  - 第二輪共 16 位 agent，全部指定 opus：A 段每個叢集一位判定者，B 段每個叢集一位驗證者。
- **每位判定者的任務**：
  - 列出叢集裡的模組，並對每個模組做刪除測試。
  - 找出「呼叫者必須知道、介面卻沒表達」的事實。
  - 對照 dsh 在同一處的形狀。
  - 讀第一輪同叢集的草稿，逐條判定維持、修正或推翻。
- **每位驗證者的任務**是推翻發現，可以判定成立、推翻、降級、重複或已被追蹤。
  - 推翻與改嚴重度都要附主線解析成功的證據。
  - 驗證者也核對「dsh 的形狀」那一段。不被 dsh 原始碼完整支持的，在該條標 ⚠。
- **證據**：證據欄 568 條，全部能在 `70357bb`／`477b4f4` 上解析到行號，行號由主線產生。
  - 散文裡的行號只做過存在與範圍檢查，全數通過；只寫 `:行` 的相對引用沒有機械檢查。
  - 「否定搜尋」列的是 agent 交出的指令，主線沒有重跑。
- **重複的定奪**：
  - core-mw-01 併入 N2。
  - core-mw-03 併入 plugins-capability-r2-04。
  - plugins-interaction-r2-04 與 hcr-r2-02 互判為重複。主線保留前者，因為它在 ask-user 那一格講得更完整；後者獨有的四點併進前者，列在該條的「併入」段：
    - `submit-record` 的軟讀。
    - `registry.ts` 的偏離登記把失敗模式寫錯了。
    - `cordis.yml` 的「順序不承載語意」沒有東西在擋。
    - `cli.ts` 的順序註解漏列 ask-user。
- **沒做的**：
  - 沒有動程式碼，只盤點。
  - 建議只寫方向，沒有估工作量，也沒有開卡。
  - `apps/web` 內部的元件結構不在範圍內，只看它跟 wire 與 packages 的接縫。
  - 歸屬欄照分工記憶：dev-harness 管 `apps/harness` 與 `packages/*`，dev-ui 管 `apps/web`。「兩邊」表示修的時候兩個 session 都要動。
