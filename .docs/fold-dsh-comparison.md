# fold.ts 的 dsh 對照紀錄

這份收 `packages/nexus-core/src/fold.ts` 移出程式碼的 dsh 對照，出處 #2416（b5c）與 #2431 issuecomment-6712218714。

下面的 dsh 出處（路徑、行號、SHA）照原註解抄錄，**未重新核對**，以 SHA `05b1cae8` 為準的核對還沒做。

## TOOL_ORDER_REST（工具呈現順序的保留項）

- nexus：`TOOL_ORDER_REST` 代表「其餘未列出者」。列到的工具站在它被列的位置，沒列到的在這一格依字典序插入。
- dsh：名字與語義照 `TOOL_ORDER_REST`，出處 `packages/core/system-prompt/src/index.ts`（未重新核對 SHA 05b1cae8）。dsh 的 Agent Note 記過註冊順序造成 CI flake。
- 取捨：deepagents 沒有對應機制。註冊順序是 plugin 載入順序的產物，不拿來當呈現順序。

## ROOT_ONLY_NOTICE（root-only 工具描述末尾的那句）

- nexus：由 fold 補在 root-only 工具描述末尾，不要求註冊者自己寫。理由是模型只看得到描述，不寫在那裡，subagent 每一輪都會再叫一次並每次被拒。
- dsh：`tool-goal` 的描述末尾是 “Execution rejects non-human and subagent authority.”，出處 `references/deepseek-harness/packages/goal/tool-goal/src/index.ts:48`，SHA `0a53fb55bea101816fa226bb964ae2bed71c343b`（未重新核對 SHA 05b1cae8）。dsh 靠工具作者自己寫。
- 取捨：`rootOnly` 是宣告式的布林值。把「要記得在描述裡講」留給註冊者，等於留一個沒有人會紅的漏，所以刻意由 fold 補。

## root-only 樁的拒絕句（RootOnlyRefusal）

- nexus：subagent 叫到 root-only 工具時，樁回一則 `status: 'error'` 的工具結果，不拋。不帶碼，因為 `rootOnly` 只是布林值。決議見 #271。工具要自己的句與碼時，用 `RegisterOptions.rootOnly` 給一個 `RootOnlyRefusal`，問答那顆帶 `DELEGATED_CALLER`（#324）。
- dsh：拋錯，出處 `tool-todo/src/index.ts:205-210`，`throw new Error('todo_write requires an owning agent session')`（未重新核對 SHA 05b1cae8）。dsh 沒有 root-only 旗標，所以沒有碼。
- 取捨：理由「拒絕，不要靜默 no-op」我們照收，所以仍是錯誤。不拋是因為拋給圍堵的話，模型看到的字會變成「工具 X 執行失敗：…」。

## ApprovalPolicy.enabled（批次與 CI 的核准開關）

- nexus：關掉表示這個 session 沒有人在。agent 照樣組得起來也跑得完；需要核准的工具回 `status: 'error'`，理由是「沒有人被問到」。這一格問的是政策，不是能力。
- dsh：`ApprovalPolicy: 'never'`，出處 `docs/subsystems/approval.md:42`，語句為 “never prompt anyone: every ask resolves `'rejected'` deterministically”（未重新核對 SHA 05b1cae8）。
- 取捨：舊版關著卻有 approval-gated 工具時建構期直接拋，讓批次與 CI 模式下 plugin 載不起來。#111 的 (c) 拿掉那道拋，因為 dsh 的 agent 在 headless 下跑得起來，而那道拋嚴在錯的地方。

## toolOrder（工具呈現順序）

- nexus：省略即字典序。省略不代表隨便排，而是另一種確定的排法。
- dsh：原註解寫「照 dsh」，即省略不代表隨便排，而是另一種確定的排法（dsh 出處未在原註解列出，未重新核對 SHA 05b1cae8）。

## FoldOptions.baseToolNames（基座自帶的工具名）

- nexus：宇宙與可見集合分開。宇宙由提供者貢獻，省略即等於可見那些。fold 只拿它驗名字，不把它變成工具。沒有它，`toolOrder: ['write_file', ...]` 會被誤判成沒人註冊。
- dsh：形狀照 `ToolProviderResult.knownNames`，出處 `packages/core/system-prompt/src/index.ts`（未重新核對 SHA 05b1cae8）。
- 取捨：所有權留在 harness，它是唯一呼叫 `createDeepAgent` 的地方。

## summarization: false（關掉摘要）

- nexus：`false` 是真的關掉，摘要、歷史 offload、新工具結果的剪法都沒有。日誌上記過的剪法與參數截斷仍由空殼換上去（#1567）。連帶沒有上下文溢出時基座那條緊急摘要。建摘要器要 default backend；沒給又沒關掉時 fold 當場拋。
- dsh：minimal preset 的形狀，不掛 compaction（未重新核對 SHA 05b1cae8）。dsh 沒掛 compaction 時一樣沒有溢出恢復。

## toolResultPruning（工具結果剪刀）

- nexus：只在摘要開著時有作用，因為唯一消費者是 compaction；摘要不掛就沒人叫它。但給了物件照樣驗，設定寫錯在載入期失敗。
- dsh：pruner 唯一的消費者是 compaction（未重新核對 SHA 05b1cae8）。

## observationPolicy（先讀後改）

- nexus：預設開著，因為「先讀後改」是寫入的安全預設。關掉的意思是「這個組裝接受盲改」。需要折出來的 backend（版本 token 從工具實際讀寫的那一個取），沒有 backend 又沒關掉時 fold 當場拋。監聽者有狀態，root 與每個 subagent 各建一份。
- dsh：預設載入的插件，工具描述寫著 “the **default** fs-observation-policy requires it”（未重新核對 SHA 05b1cae8）。owner 是 `agent.session`，agent id ≡ session id，child agent 各自一份。

## serialToolCalls（工具呼叫串行）

- nexus：每一顆都當獨佔，不看宣告。省略即照宣告重疊。
- dsh：對應 `maxParallelToolCalls: 1`（未重新核對 SHA 05b1cae8）。

## modelSelection（每會話模型選擇）

- nexus：子代理另有一顆跟隨的 middleware：每次叫模型前，換成定義釘住的模型；沒釘就是父代理當下選的那顆。
- dsh：子代理沿用父代理當下路由，即 `requestedAgentOptions`（未重新核對 SHA 05b1cae8）。`compileSubagentGraph` 在模型自己挑的時候把這一顆濾掉，模型自己挑的勝過一切。

## subagentToolFilter（工具過濾的宇宙）

- nexus：宇宙比 `toolOrder` 窄，只收可遮的繼承來的名字。子代理自己那層的名字不收，遮不到的東西列了就是寫錯。
- dsh：`restrictableNames`，只含繼承來的（未重新核對 SHA 05b1cae8）。

## 背景子代理的核准閘門（createBackgroundApprovalGate）

- nexus：管道固定 `policy-never`（#324、#737）。背景子代理被叫醒時主對話沒有在等，沒有人可以按，所以要人看過的操作一律確定性回絕，不發中斷。在編圖時換掉前景那顆。
- dsh：委派時把子代理的核准政策釘成 `never`，出處 `packages/subagent/subagent/src/child-agent.ts:220-247`（未重新核對 SHA 05b1cae8）。

## 前景子代理共用 root 閘門（foldApprovalChannel）

- nexus：前景時主對話停著等，子代理要核准的操作把中斷冒到使用者面前，政策與管道就是 root 當下的（#328 第 1 項，翻了 #324）。沒有人的入口、沒有存檔點、政策 `never` 時一樣確定性回絕，理由說真正的原因。
- dsh：不另列出處（本段未引用 dsh 行號）。

## 閘門的雙時刻（approval gate，wrapToolCall）

- nexus：閘門答的是 `tools/pre-execute`，但承載它的是 `tools/execute` 位置的 `wrapToolCall`。這兩個時刻是兩層權限不同的東西，這裡是同一種機制的兩個陣列位置，位置由 `fold.ts` 決定、不由註冊順序決定。索引見 `apps/harness/src/interception-index.test.ts`。
- dsh：兩個權限時刻，兩層權限不同（未重新核對 SHA 05b1cae8）。

## 槽位表的形狀（buildRootStack）

- nexus：deepagents 的 middleware 是順序有意義的陣列，「插到最前」表達不出來。所以用一張表加一次穩定分割，兩個分區各自維持註冊順序。
- dsh：匿名表只有 `append`，沒有 prepend 的概念（未重新核對 SHA 05b1cae8）。

## 用量記錄器的位置（modelUsage）

- nexus：排在其餘 plugin middleware 之前，位置決定包裹層次。代價是一個自己重試模型的 plugin，重試幾次都只會被記一筆。今天樹裡沒有那種 plugin，所以先照全樹一致的順序放。哪天有了，把它移到最內層就對，但那會反轉 `foldSubAgents` 的「同名時 subagent 自己帶的贏」政策，兩件事要一起想。
- dsh：每一次 attempt 各算一筆再加總，出處 `packages/llm/token-meter/src/turn-usage.ts` 的 `llm/retry-started` 會重開一個 attempt（未重新核對 SHA 05b1cae8）。這是 nexus 目前沒採用的做法。

## 起訖、耐久檢查點與模型呼叫（modelCalls、sessionCheckpoint）

- nexus：起訖排在用量外層、plugin middleware 外層，重試都只算一步。耐久檢查點排在起訖紀錄器內側，排空的是 `model/start` 已記下的請求前綴。
- dsh：`llm/retry` 在一步之內（未重新核對 SHA 05b1cae8）；記好的請求前綴（未重新核對 SHA 05b1cae8）。

## 子代理的 composeFrom 與表達不出來的理由（subagent composition）

- nexus：deepagents 1.13.1 沒有「子代理繼承 root middleware」的通道。`SubAgentBase.middleware` 只附加在子代理預設 stack 後面，root 的 middleware 不在裡面；唯一的例外是基座自己補的 `general-purpose`。所以 fold 一律逐個交，由一張有序的槽位表導出兩份陣列，這是在只能逐個注的前提下最接近 `composeFrom` 的形狀。
- dsh：`applyChildComposition` 第一步就是 `composeFrom(childCtx, parent.ctx)`，併入父代理保留的同一版組合，出處 `packages/subagent/subagent/src/child-agent.ts:190-205`、`packages/preset/agent-preset-registry/src/index.ts:268-273`，SHA `477b4f4`（未重新核對 SHA 05b1cae8）。dsh 不另組一份，所以「子代理沒併入」在呼叫點寫不出來；nexus 做不到這一點。

## 子代理的摘要器（subagentPluginMiddleware）

- nexus：plugin 用同名換掉摘要器的那一顆，只到 root。子代理照舊用 fold 逐個建的那份。原因是那顆的摘要器認不出身分的呼叫，會用實例自己的會話名，攤過去會蓋掉每個子代理各建的那份，root 與子代理的呼叫混進同一個檔。真的要子代理也吃那份設定時，開卡加工廠。
- dsh：子代理拿到同一套壓縮設定，狀態逐 session 分開（未重新核對 SHA 05b1cae8）。nexus 沒有「逐個建」的註冊介面，所以退一步。

## 委派（subagentDelegation）

- nexus：委派子代理由 fold 明著註冊，不會在沒人設定時自動冒出來而繞過閘門。
- dsh：標準 preset 的委派是明著掛的一列 `tool-subagent`（`provider: spawn`），出處 `packages/preset/agent-presets/presets/standard/agent.cordis.yml`，SHA `c291e7961a515f6d7af9304e7fd1d257929aef26`（未重新核對 SHA 05b1cae8）。spawn 出來的是同一個 cordis context 上的一般 child agent，全域的 `tools/pre-execute` 照樣經過它，出處 `packages/core/tools/src/index.ts` 的 `scopeTarget(this, exec.agent)`（未重新核對 SHA 05b1cae8）。

## 子代理共用 plugin middleware（subagentPluginMiddleware，#327）

- nexus：子代理綁到父代理同一份組合，同樣的 plugin 物件、同樣的提示詞段落，沒有「只給 root」的註冊。提示詞段落的文字逐個 agent 依它的會話現算，所以子代理講的是它自己的沙箱模式、看到的是它自己的計劃模式。共用一份的 middleware 要從這一次呼叫的身分分出是誰，不能把逐 agent 的狀態放在閉包裡。這是偏離：目前零顆 plugin middleware 帶閉包狀態，所以先不做工廠介面，但沒有絆索，哪天有一顆帶閉包狀態的掛進來，root 與子代理會靜靜串台。
- dsh：`composeFrom` 綁到父代理同一份組合，出處 `packages/preset/agent-presets/src/index.ts:459-492`，dsh `e459e32`（未重新核對 SHA 05b1cae8）。段落文字逐個 agent 從 `context.agent.session` 現算（未重新核對 SHA 05b1cae8）。

## 工具過濾宇宙的分層（knownToolNames、restrictableToolNames）

- nexus：宇宙有四個來源：全域層、各 subagent 層、subagent 定義自帶的 `tools`、組裝點宣告的 `baseToolNames`。分成宇宙與可見集合兩件事。
- dsh：`ToolProviderResult.knownNames`（未重新核對 SHA 05b1cae8）。

## searchMetaAllowed（搜尋工具的 meta）

- nexus：root 與每個 subagent 都沒有 `permissions` 規則才開。基座搜尋工具的 meta 會由濾之前的結果算，自己重寫比對規則寫錯的代價是外洩，所以組裝期整類關掉（meta 要由濾過的結果算）。今天產品碼沒有人註冊規則，出貨的組裝一律開著。
- dsh：meta 由濾過的結果算，屬於工具自己那一層的保證（未重新核對 SHA 05b1cae8）。

## 中介層的位置（toolPostExecute、outputSchema、invalidToolArgs、toolExecute）

- nexus：`tools/post-execute` 在輸出校驗等貼著工具本體的那幾顆外側，在每一個 plugin middleware 內側。輸出校驗看到的是工具原本的輸出。解不開參數的那顆在 `wrapToolCall` 的核准與 plugin 內側，參數在執行時才驗。`tools/execute` 排在解不開參數那顆的內側、撞到輸出上限那顆的外側；`task` 的錯誤替換在 execute 內側才對得上前景 `task` 本體會拋的那句錯誤。
- dsh：在 `post-execute` 之前驗輸出（未重新核對 SHA 05b1cae8）；執行時才驗參數（未重新核對 SHA 05b1cae8）；前景 `task` 本體裡拋錯（未重新核對 SHA 05b1cae8）。

## 圍堵與 hooks 的先後（toolPreExecute）

- nexus：`tools/pre-execute` 緊貼閘門外側。拒絕在問人之前（hooks／permission／sandbox 先於 approval），所以不會先跳核准卡、再被拒。核准本身沒有搬上去。
- dsh：hooks、permission、sandbox 先於 approval（未重新核對 SHA 05b1cae8）。

## 子代理的次數上限（subagentMaxTurns）

- nexus：子代理一次執行最多叫幾次模型，到了就收尾（#328 第 3 項）。root 的上限是遞迴上限（#858）。
- dsh：沒有這個上限。這是 nexus 自己加的（dsh 沒有，未重新核對 SHA 05b1cae8）。
