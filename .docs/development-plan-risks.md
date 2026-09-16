# 開發計劃：風險與決策點

**這是 [`development-plan.md`](development-plan.md) 切出來的一節**，內容原封不動，沒有改寫。
切檔的理由與量測見 [#364](https://github.com/DemianLi/nexus-agent/issues/364)：主檔 98,379 字元裡
這三塊佔 62%，而每次讀取只需要其中一塊。

**結論速查在主檔**，本檔不重複。回主檔：[`development-plan.md`](development-plan.md)。

---

## 7. 風險與決策點

1. **deepagentsjs 演進速度快，且 minor 會動相依契約**：`deepagents` 從 2025-08-03 的 1.0.0 到 2026-08-21 的 1.13.1，12 個月出了 14 個 minor、53 個穩定版。1.x 的 minor 在 semver 上宣稱相容，但實測**相依契約會在 minor 裡變動** — 1.11.0 一次新增五個 required peer（此前只有 `langsmith` 一項），1.13.0 把 `@langchain/core`、`langchain`、`@langchain/langgraph` 的下限整組抬高。對策：`deepagents` 鎖 `~1.13.1` 只跟 patch、peer 顯式宣告並照抄基座範圍、`strictPeerDependencies: true` 讓範圍不符在 install 就失敗、一組薄 smoke test 斷言擴充點的形狀事實、接觸面集中在 agent 工廠一處。

   smoke test 的邊界（[#32](https://github.com/DemianLi/nexus-agent/issues/32)）：**只斷言「契約明文依賴、而且基座改掉時型別檢查攔不到」的執行期行為**，落點跟著 agent 組裝點走。`createDeepAgent` 的參數名不另外斷言（呼叫本身就是斷言，改名會 compile 失敗）；同名 subagent 行為不斷言（[#28](https://github.com/DemianLi/nexus-agent/issues/28) 已把它擋在載入期，基座怎麼做不再是我們的依賴）。

   **`~` 放行 patch，但基座有一個 experimental 的公開 API。** v3 `streamEvents`（第 5 節 Phase 5 要用的那個）的 JSDoc 明文「experimental and its API may change in future releases」。`~1.13.1` 擋得住 minor，擋不住 patch —— 而一個標成 experimental 的 API 是可以在 patch 裡動的。這不改分層（判準仍是「壞掉時 semver 管不管得到」，而這一條正是 semver 管不到的例子），但它讓升版檢查清單多一項：**碰過 v3 串流之後，`deepagents` 每次升版都要重跑一次事件流那組測試**，而不是只跑那四項人工驗證。

   **升版檢查清單**：`deepagents` 升 minor 或 major 的 PR 上，重跑一次 [#31](https://github.com/DemianLi/nexus-agent/issues/31) 那四項人工真實模型驗證——tool call 參數以合法 JSON 回傳／`streamMode: ['updates','values']` 的事件形狀與假模型一致／Node 22 相容／key 只從環境變數讀且缺少即失敗。這是擋「`ScriptedChatModel` 與基座真實行為悄悄分歧」的機制之一。

   **但「那個分歧在結構上斷言不出來」這句是錯的，Phase 5 動工前的驗證當場撞到反例。** 原文的推論是：CI 不放模型 secret（#31），所以寫得出來的斷言只能斷言假模型與我們對基座的想像一致，而那正是分歧發生時仍然全綠的東西。**漏掉的是第三種斷言：同一份腳本走兩條基座路徑，比對兩邊的結果。** `ScriptedChatModel` 在 v3 串流下對工具呼叫視而不見（見第 5 節 Phase 5），這件事完全不需要任何 key 就斷言得出來 —— 拿同一份腳本分別走 `invoke` 與 v3 `streamEvents`，斷言兩邊都跑到工具，分歧當場紅。**假模型與基座的分歧，只要基座自己有兩條路可以互為對照，就驗得出來**；驗不出來的是「真實供應商會不會這樣回」，那才是要 key 的那一半。
2. **模型供應商決策**（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）—— **已關閉（2026-08-28）：`openai/gpt-oss-120b`**。**2026-09-04 修訂：那個 id 已於 2026-09-03 下架**（410，EOL 帶日期，型錄上也沒有了），重盤重選之後是 **`nvidia/nemotron-3-super-120b-a12b`** —— 這次品質沒有打平（難題 0.98 對 0.92–0.93），它同時拿下延遲與多叫次數，只輸 token。見 [#165](https://github.com/DemianLi/nexus-agent/issues/165)。**決策點 2 不因此重開**：換的是 id 不是供應商，端點與方法都沒變。

   原文：Anthropic 功能最全但成本高；DeepSeek 便宜。原本要在 Phase 0「兩者都跑基本驗證再定」，但 Phase 0 的驗收判定不了品質，也碰不到 middleware —— 那時還沒有任何 middleware。所以拆成三段：**Phase 0 只定預設**（Anthropic）並驗真實接線；**Phase 2 驗 DeepSeek 相容性**，二元判定，不相容就出局；**Phase 5 才比品質與成本**。理由是相容性是二元的、早驗早止血；品質比較是統計性的，小樣本手工跑出來的數字噪音大過訊號。

   **三段裡只有第一段與第三段真的發生，而第三段換掉了問題本身。** Phase 5 沒有比「Anthropic 對 DeepSeek」——那兩條路一條沒建起來（`@langchain/anthropic` 從來不在任何 `package.json` 裡）、一條卡在人工開帳號（[#61](https://github.com/DemianLi/nexus-agent/issues/61)）。實際跑的是**同一個 NVIDIA 端點上五個模型的橫向比較**，前後三輪（四條難題 × 2 次、兩條難題 × 6 次、四條難題 × 6 次）。結果：**品質五階打平**（四條難題上 `0.92`–`0.96`，而判準沒有飽和 —— 全距下探到 `0.33`／`0.50`），所以選型落回成本、延遲、失敗模式，三個軸都指向 `openai/gpt-oss-120b`。**第三輪一度出現一條反面證據，已經更正並撤回**：當時量到選中的那個 id 跑不完四條難題中的三條（`429`），判成失敗模式那一軸指向反面。實際上那是端點的每分鐘 token 配額加上基座對 headerless 429 不重試，把限流接住之後重跑同一階 **42 次零失敗、難題全部滿分** —— 限流是我們的跑法，不是模型的性質。**選型的三個軸都沒有變。**

   **這個決定要看清楚它的邊界，否則會被讀得太寬：**

   - **它是「這把 key 叫得動的模型裡最划算的那個」，不是「這是最好的模型」。** 候選集合綁在帳號上（`GET /models` 列 84 個，這把 key 只叫得動 29 個、真的支援工具的 14 個），換一把 key 要重新盤點。
   - **Anthropic 不是被比下去的，是從來沒進過場。** 要重新排入評估，缺的是一段從沒被記過的接線工作，不是一次比較。
   - **Phase 2 那道「不相容則 DeepSeek 出局」的二元閘門到今天仍然沒跑過。** 「我們這套 stack 換一個供應商跑不跑得通」這個問題沒有被回答，只是沒有人在問了 —— 因為五個候選走的是同一個套件、同一個端點。它錨在 [#61](https://github.com/DemianLi/nexus-agent/issues/61) 上，那張刻意留著當紀錄。
3. **shell sandbox 安全**：`execute` 工具本質是跑任意指令。先只用 QuickJS interpreter，shell sandbox 延後到有明確隔離方案（容器）再做。

   **原本的預測錯了，`feat/sandbox-plugin` 當場驗出來的是更強的一件事。** 原文寫「權限規則對 `execute` 不生效，原因是它的參數是命令字串、沒有路徑可比對」。實際上基座不是讓規則靜靜失效，而是**不讓這兩件事共存**：`createFilesystemMiddleware` 在 `permissions` 非空、`execute` 工具開著、而 backend 又通過 `isSandboxBackend()` 時**直接拋錯**（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:2368`），除非所有規則路徑都收斂在 `CompositeBackend` 的 route 前綴下；`createExecuteTool` 在執行期還有第二道同樣判準的關卡。「不生效」與「構造期硬失敗」是兩件事，而基座選的是後者——理由它自己寫在訊息裡：shell 指令碰得到任何路徑，路徑規則因此形同虛設。

   **這直接決定了 `feat/sandbox-plugin` 的形狀**：QuickJS 做成 sandbox backend 會讓 `permissions` 擴充點與它互斥，現有的權限行為驗收會在組裝期炸掉。所以走 custom tool（基座明文「custom tools from the agent or other middleware are left untouched」），完全不經過那條路。絆索測試在 `apps/harness/src/sandbox-backend-conflict.test.ts`，形狀照 `contained-backend.test.ts` 那組升版絆索——它紅了代表基座改了主意，那正是該回頭看這個決定的時刻。

   `isSandboxBackend()` 是純 duck-type（`execute` 是函式 ＋ 非空的 `id` 字串），所以「這個 backend 算不算會執行指令」不看繼承關係，看形狀。
4. **狀態儲存決策點是三個軸，不是一個**（Phase 3 收斂）：原文把它寫成「`MemorySaver` → 評估 `checkpoint-postgres`」，那只覆蓋 `checkpointer`（thread 內的對話狀態）。實測基座之後拆開：`store`（`BaseStore`，`StoreBackend` 明文「persist across all threads」）才是跨 thread 記憶的載體；`backend` 才是 AGENTS.md、skills 與 `/conversation_history` 實際落在哪。**三軸各自可選、失敗方式不同**——checkpointer 缺席是接不回 interrupt（fold 已經在擋，見 `foldRegistry` 對核准政策的前置檢查），store 缺席是換個 thread 就失憶，backend 選錯是記憶根本寫不回去（memory middleware 唯讀，寫回去只有模型的 `write_file` 一條路）。Phase 3 的三個 PR 要分別對上，不能用一個「狀態儲存選好了」收掉。

   `@langchain/langgraph-checkpoint-postgres@1.0.5` 前兩軸同一個套件收（`.` 出 checkpointer、`./store` 出 `PostgresStore`），peer 是 `@langchain/core ^1.1.44` ＋ `@langchain/langgraph-checkpoint ^1.1.4`，與我們現有範圍相容——但那是**兩個決定**，只是剛好同一個相依。

   **`feat/memory-plugin` 收斂了 backend 這一軸，而且是可執行的證據**（`apps/harness/src/memory.test.ts` 的「記憶的保存軸」）：兩個全新建的 agent、不共用 checkpointer、不共用 state，差別只有 backend——落磁碟的那個讀得到前一個 agent 寫的 `/AGENTS.md`，`StateBackend` 那個拿到 `(No memory loaded)`。**「記憶留不留得住」因此是 backend 的問題，換 checkpointer 改變不了任何事。**

   同一輪也釐清了 `store` 與 `backend` 不是兩條平行的路：memory middleware 完全不碰 `store`，只有 `StoreBackend` 會去 LangGraph 的執行 context 把它取出來。所以 `store` 這一軸對記憶而言是「backend 的一種選法」，不是獨立選項。

   **checkpointer 與 store 兩軸維持在 `MemorySaver` 與「未選」，理由是收下 `@langchain/langgraph-checkpoint-postgres` 會把一個活的 Postgres 拖進測試路徑**，而 CI 上沒有任何服務憑證（[#31](https://github.com/DemianLi/nexus-agent/issues/31)），測試必須是自足的。版本層級也仍然懸在那張 PR 上（見第 3 節鎖死那一列）。這兩軸目前**沒有可執行證據**，只有寫下來的判斷——照實記著，別讓它看起來像已經驗過。

   **補（2026-09-05，[#155](https://github.com/DemianLi/nexus-agent/issues/155)）：這裡少了一軸，而少掉的那一軸才是先落地的那個。** 上面三軸（checkpointer／store／backend）問的都是「LangGraph 的狀態存在哪」；**會話事件日誌不在其中任何一軸上**——它不是 thread 內的對話狀態、不是跨 thread 的 KV、也不是模型看得到的檔案系統。照 dsh 的分法（`session-persistence` 與 `storage` 是兩個獨立 seam，而 LangGraph 那種狀態快照在 dsh **根本沒有對應物**，因為它的日誌就是真相、投影只是帶版本的快取），我們這側真正的三軸是**會話日誌／checkpointer／storage**，而且三者的「何時寫／寫什麼／誰讀回」沒有一格重疊，所以不必也收不到一起去。

   **只有會話日誌那一軸做了**（[#172](https://github.com/DemianLi/nexus-agent/issues/172)，`--session-log <dir>`，JSONL）。另外兩軸今天**零消費者**：~~三個入口都沒有跨重啟的續接~~（`wire-handler.ts` 那個 `resume` 是行程內的 HITL）**2026-09-11 起 CLI 有了（[#251](https://github.com/DemianLi/nexus-agent/issues/251)，`--resume <run 目錄>`），但它讀回的是會話日誌這一軸**——#251 判定只開日誌那扇門、不開 checkpointer 那扇，對話照樣從頭開始，所以這一句的結論不變、理由換了：不是沒有續接，是續接不走這兩軸；`serve` 與 eval 仍然沒有續接。**再補（2026-09-14，[#306](https://github.com/DemianLi/nexus-agent/issues/306)）：上一句有兩處過期了。** `serve` 也有續接（#251 之後碰到以前寫過的 thread 就接回來）；**對話也不再從頭開始**——照 dsh，模型歷史從會話日誌推出來、在第一輪之前灌回 graph state（`apps/harness/src/conversation-restore.ts`），**仍然不走 checkpointer 那一軸**，所以「續接不走這兩軸」的結論照舊成立。eval 仍然沒有續接。**畫面也重播了**（同一張卡的第二刀）：web 切回以前的 thread 時，server 把 root 日誌轉成線上的 `Event`（不帶傳輸 `seq`）交給同一個折疊器，照 dsh 的 `session.follow` 開頭那份 snapshot 與往前翻的 `session.page`（`GET /threads/:id/history`，`apps/harness/src/conversation-history.ts`）。而 eval 的「沒有 checkpointer」是承重的（`eval/runner.ts` 那段註解）。落盤的 checkpointer 裝得起來已驗（`@langchain/langgraph-checkpoint-sqlite@1.0.4` 的 peer 全過，`@langchain/langgraph-checkpoint` 已經是 `apps/harness` 的直接相依），**但它拉原生的 `better-sqlite3`，而我們的 `onlyBuiltDependencies` 只放了 `esbuild`**——JSONL 那條零原生相依，這個不對稱本身就是先做日誌軸的理由。要做 checkpointer 那一軸時，第一件事是 [#170](https://github.com/DemianLi/nexus-agent/issues/170) 的工具結果暫存：它進 graph state、逐 thread，**會進 checkpoint**，落盤之後就變成需要保留策略的磁碟成本。

5. **結果校驗範圍（Phase 4 前）**：需定義「校驗什麼」——schema、不變量、還是業務規則。~~屆時拍板。~~ **已拍板（Phase 4；2026-09-11 回填）：只收 schema。** 決議當時只寫進了 `packages/nexus-plugin-validation/src/index.ts` 的檔頭（逐字：「schema 是工具作者自己說得清楚的東西，不變量不是」），這一格一直沒回頭改，所以看起來像還沒決定。落地的是兩件（見第 5 節 Phase 4 那段）：工具**輸出**對宣告 schema 的校驗——逐工具選加，沒宣告的明文放行，**輸入**那一半基座本來就驗；以及工具失敗一律變成帶更正回饋的 error ToolMessage。**不變量與業務規則當時歸 [#16](https://github.com/DemianLi/nexus-agent/issues/16)**，而 #16 在 2026-09-01 關閉時論證的是「schema 校驗加失敗回饋就是有效的那一種、不是權宜之計」（`.docs/reflection-intent-survey.md`），**沒有接走這兩樣**——2026-09-11 開了 [#252](https://github.com/DemianLi/nexus-agent/issues/252) 接它們，連同下面那件輸出校驗的事。兩件要一起講的事實：`createValidationPlugin()` **不在 `DEFAULT_PLUGINS` 裡**（清單裡只有它的不變量配套入口），它自己的套件之外零個非測試呼叫點，所以產品路徑上輸出校驗今天沒有掛；包自有的運行時不變量（[#102](https://github.com/DemianLi/nexus-agent/pull/102)／[#110](https://github.com/DemianLi/nexus-agent/pull/110)）後來以另一個形狀落地，但它檢的是會話日誌的 turn 配對這類跨筆關係，**不是工具結果**——別把它當成這一格的「不變量」。**2026-09-13 結案（[#252](https://github.com/DemianLi/nexus-agent/issues/252)）**：輸出校驗搬進 `@nexus/core`——schema 隨 `registry.tools.register(tool, { outputSchema })` 帶、fold 打底進 root 與每個 subagent（照 #159 對圍堵的處理），產品路徑上 `get_goal`／`create_goal`／`update_goal`／`ask_user_question` 四顆宣告，其餘工具回的是散文、宣告不了。**不變量與業務規則認帳不做**：dsh 那側也沒有它們的家（訂 `tools/post-execute` 的全是政策與呈現，外加轉接使用者外部鉤子的橋接），業務規則住在工具本體；`submit_record` 那一格由人在核准卡上看。
6. **`apps/web` 與 agent 之間的傳輸**（Phase 5 拍板）：原文從沒把它記成決策點，「現有骨架續用」那句把它藏起來了（見第 5 節 Phase 5）。**決定：上行 HTTP POST，下行單向事件串流；下行載體先做 SSE，WebSocket 覆寫留到需要時再加。形狀不變，但依據換了一半 —— 見下面「動工前一驗」。**

   **依據是 dsh 的實際做法**（AGENTS.md 的技術實現標準；以下都是讀 `references/deepseek-harness` 的原始碼，不是搜尋來的）：

   - 瀏覽器載體的形狀寫在檔案第一行：`packages/client/connection/src/client/web-api-client.ts` —— 「Browser API carrier: HTTP upstream plus one WebSocket per downstream event stream.」下行單向是**明文的協定不變量**，不是實作細節：`websocket-downlink.ts` 的類別註解寫「Client messages are a protocol violation: upstream traffic remains on HTTP.」
   - **同一組 frame 在 host 這側同時有 SSE 路由**：`packages/host/apiproxy/src/fetch/handler.ts` 的 `GET /api/events.mux` 與 `/api/events.host` 回 `text/event-stream`，而 SSE 的 frame 解碼就在共用的 `AbstractApiClient` 裡；`WebApiClient` 是**覆寫**掉那條預設改用 WS。所以 SSE 不是測試用的假縫，是同一份協定的另一個載體 —— 走 SSE 的 `InProcessApiClient` 定位為「同構接點……跑完整的協定序列化與校驗路徑而不經過網路」。**先做 SSE 等於做 dsh 兩層裡的基礎那層；但 dsh 出貨給瀏覽器的是 WS，停在 SSE 就是少了那一層覆寫，這裡明著記著。**（dsh 自己也註明 SSE 那條用的是 streaming fetch 而不是 `EventSource`，見 `packages/host/apiproxy/src/fetch/client.ts`。）
   - **事件不是「每個請求回一條串流」。** dsh 只有兩條長期下行：`mux`（跨全部 session 彙總）與 `host`（session 生命週期）。agent 的實際事件以 `session/event` 搭在 mux 上，核准請求也是（`approval/requested` 是一個可回答的 server-request），回覆走 HTTP 上行。**這一點與基座的 HITL 形狀正好對得上**：`run.interrupts` 在串流這一端、`Command({ resume })` 在下一次呼叫這一端。
   - 重連照 dsh：`since` 在它的 v1 沒實作，明文 `reconnection = reopen the stream + refetch history`。
   - **handler 的形狀也照抄**（`fetch/handler.ts`）：`(Request) => Response`，不綁 port；**路徑指名 method、封包裡也帶 method，兩者不合就是錯誤**；載體層的錯用 HTTP status（415 非 JSON media type、400 body 不是 JSON、404 不認得的 method），協定層的錯用 200 ＋ error 封包。那個 415 是有理由的安全閘：瀏覽器對 `text/plain` 之類的「simple POST」不發 preflight，只收 `application/json` 等於逼出一個這個 server 從不回答的 preflight。

   **動工前一驗（第八次，形狀對、依據不完整）：`@langchain/protocol` 已經把這條線規格化了，而且更具體。** 它是 `@langchain/langgraph` 與 `@langchain/langgraph-sdk` 的直接相依，**早就在我們的 `node_modules` 裡**，只是計劃從沒提過。原文整段從 dsh 推出來，漏掉了「既有基礎建設自己出了規格書」這件事。AGENTS.md 的偏離規則是「**基礎建設表達不出來**才退到最接近的實作」——這裡基礎建設不但表達得出來，還把 route、封包、channel 名、HITL 的兩個 method 都指定死了。**自己發明 frame 才是需要標註的那一邊。** 實測到的內容：

   - **v3 的 run 本身就是 `AsyncIterable<ProtocolEvent>`。** `GraphRunStream implements AsyncIterable<ProtocolEvent>`（`@langchain/langgraph@1.4.12`，`dist/stream/run-stream.d.ts`），`for await (const ev of run)` 直接吐 `{ type:'event', seq, method, params:{ namespace, timestamp, node?, data } }`。實測整場 56 顆 frame **全部 `JSON.parse(JSON.stringify(ev))` 過得去**，method 落在 `lifecycle` / `checkpoints` / `values` / `tasks` / `updates` / `messages` / `tools` 七個名字上，與 protocol 的 `Channel` union 一字不差。→ **pump 是一個 map，不是一層轉譯**；沒有 frame 要發明，也沒有序列化工作要做。`run.messages` / `run.toolCalls` 那些投影是給 in-process 消費者的，不是線上的東西。
   - **protocol 明文規定 SSE 那條線**：`POST /threads/:thread_id/stream`，body 是 `EventStreamRequest`（`channels` / `namespaces` / `depth` / `since`），server 回 `text/event-stream`；`Event.event_id` 的註解寫「maps to SSE `id:`」。整份協定是 thread-centric 的。上行的 `Command` 封包（`{ id, method, params }`）在 WS 那條路上直接送，HTTP 那條路上協定沒指定 route —— 那一格由 dsh 的 `fetch/handler.ts` 補：**路徑指名 method**。
   - **HITL 在協定裡有名字**：下行 `input.requested`、上行 `input.respond`。我們自己不必替核准這件事發明詞彙。
   - **已考慮並排除 `@langchain/langgraph-sdk` 的 client**：它打的是 LangGraph Platform 的 API（`client.runs.stream(threadId, assistantId, …)`），前提是跑一台 LangGraph Server。我們的組裝點是 `createDeepAgent`，不跑那台 server，所以不走它。它與 protocol 共用同一份型別，這是它們形狀相似的原因，不是可以直接接上的理由。

   **基座這側量到的六件事決定了 server 端要做什麼**（`deepagents@1.13.1` ＋ `@langchain/langgraph@1.4.12`，探針跑完即棄）：

   1. **run 不必被抽就會自己前進。** 開了 v3 串流之後什麼都不抽，300 ms 後工具已經跑完；`await run.output` 收完整場之後再抽 `run.messages`，兩輪都還在。**但這只證明了同一個 run 物件在同一個行程內可以重播** —— 跨連線、跨行程的重連沒有驗過，所以重連策略照 dsh 的 reopen ＋ refetch，不要拿這個 buffer 當重連機制。
   2. **一場對話不是一個 run 物件。** 停在核准點時 run 就收掉，`run.messages` 只有中斷前那一段（實測 `['我來記。']`）；`streamEvents(new Command({ resume }), …)` 回的是**另一個** run 物件（實測 `run2 !== run`），而且只帶 resume 之後的訊息（`['記好了。']`），舊的 run 再抽一次仍然只有前半段。→ **持久下行串流必須由 server 端把 N 個 run 物件接起來**，不能把某一個 run 直接交給瀏覽器。這正是 dsh 那條「一條長期下行、上行另走 HTTP」的形狀在我們這邊也成立的理由。
   3. **`seq` 在每個 run 上從 0 重新開始。** 實測 resume 那個 run 的第一顆 frame 是 `seq: 0`。而 protocol 的 `Event.seq` 是「monotonic sequence number for ordering」、`event_id` 是重連用的 key —— 兩者都預設整條下行是單調的。→ **server 端接起 N 個 run 的時候必須重新編號**，照原樣轉出去會讓瀏覽器那側的排序與去重靜靜地壞掉：seq 不會變小到看得出來，它是一段一段重來。
   4. **中斷時 raw iteration 乾淨結束，不拋。** 中斷本身以 `updates` frame 出現（`node: "__interrupt__"`，data 就是 `run.interrupts` 那份 `actionRequests` / `reviewConfigs`）。→ **pump 完全不必碰 `run.output`**，抽完 iteration 就是這一段的結束。第 5 節 Phase 5 記的「不能無條件 `await run.output`」仍然成立，但它是**核准 UI 那一端**的陷阱，不是 pump 的。
   5. **`lifecycle` 的 `{ event: 'completed', graph_name: 'root' }` 在中斷時照樣會發。** → 它不是「對話結束、可以關線」的訊號。拿它當關線條件的話，每按一次核准就會斷線一次。
   6. **失敗會先上線再拋。** 實測 run 失敗時最後一顆 frame 是 `lifecycle { event:'failed', graph_name:'root', error:'…' }`，**然後** iteration 才 throw。→ 瀏覽器從協定 frame 就知道為什麼死的，pump 的 try/catch 是用來收線的，不是用來補一顆錯誤 frame 的。（工具拋錯那一組另外還有一顆 `graph_name:'tools'` 的 failed，而且會多一個 `run.output.catch()` 攔不掉的 unhandled rejection —— 但那是第 5 節 Phase 4 那條「工具拋錯就整場死」的老問題。**[#159](https://github.com/DemianLi/nexus-agent/issues/159) 之後，我們的組裝踩不到它了**：圍堵由 `foldRegistry` 打底進 root 與每個 subagent，裸 `createDeepAgent` 才踩得到（絆索在 `apps/harness/src/baseline.test.ts`）。模型拋錯那一組沒有這個副作用。）

   **channel 白名單是安全邊界，不是效能調校。** 實測 `tasks` 的每一顆 frame 都夾著整份 input message list、`updates` 夾著完整序列化的 `{"lc":1,…}` 訊息、`values` 夾整個 state。全頻道往瀏覽器倒等於每個 task event 重送一次對話狀態，而且 state 裡有什麼就送什麼。protocol 的 `EventStreamRequest.channels` 存在正是為這件事。→ **白名單預設只放 `messages` / `tools` / `lifecycle` ＋ 中斷那條**，`tasks` / `checkpoints` / `values` 要放行得是一個明白的決定。

   **瀏覽器斷線不得中止 run。** `run.abort()` 與 `run.signal` 就在手邊，把 HTTP response 的 abort signal 接上去是最自然的寫法，而它是錯的 —— 下行是**長期的**、與單一 run 無關，斷線之後靠 reopen 接回來。接反了不會有任何錯誤訊息，只會變成「使用者關掉分頁 agent 就停了」。

   **這張 PR 的採納範圍，與明著不做的部分。** 收：封包（`Command` / `CommandResponse` / `ErrorResponse` / `Event`）、channel 名、SSE 的 route 形狀、HITL 的 `input.respond`。**不收，而且明著記著**：`subscription.*`（SSE 那條路上訂閱就是開線本身）、`state.get` / `state.fork` / `state.listCheckpoints`、`agent.getTree`、`input.inject`、`custom:*` 頻道、`namespaces` / `depth` 過濾。**`since` 收到就明確回 `not_supported`，不靜靜忽略** —— 靜靜忽略會生出看不見的斷檔。這麼切本身就是照 dsh：它自己也只有兩條長期下行、`since` 在 v1 沒實作。跨連線的 replay 要能做得先有 frame 的持久化，而狀態儲存目前只收斂了 backend 一軸（見決策 4）。**補（2026-09-14，[#306](https://github.com/DemianLi/nexus-agent/issues/306)）**：dsh 那句的後半「refetch history」有了，**但不是 frame 的持久化**——`GET /threads/:id/history` 從會話日誌轉出線上的 `Event`，不帶傳輸 `seq`。`since` 照舊不收。

   **偏離標記**：無協定層偏離，而且比原本記的更強 —— 這條線用的是**基座自己的協定詞彙**，dsh 提供的是它沒指定的那一格（HTTP 上行的 route 形狀與錯誤分層）。兩處未完成，都不是表達力問題：載體層先出 SSE 不出 WS 覆寫；協定層只實作上面那份採納範圍。
