# 壓縮與摘要：nexus 與 dsh 的對照

對照對象：nexus 的 `packages/nexus-core/src/summarization.ts`（base `origin/develop` 4edd74ab），dsh 的 `packages/compaction/compaction-basic`，另外引到 dsh 的 `compaction`、`command-compact`、`llm/llm`、`llm/token-meter` 幾個套件。dsh 的出處都用 `git show 8bd0733:<path>` 讀過，行號以 8bd0733 為準。舊註解引的 SHA（`5badb15`、`5badb150`、`687f282e`、`46a7f68`、`5719020`）與行號跟 8bd0733 不同的，逐條寫成「舊註解指 …，8bd0733 上是 …」。nexus 這邊的做法與理由以 `summarization.ts` 的現行程式碼與註解為準；程式碼讀不出理由的，寫「理由見 #NNN」或「沒查到」。

每個主題先判定「照 dsh」或「偏離」。照 dsh 的只寫一行出處；偏離的附比較表（標準／dsh／nexus）和一句結論。每條 dsh 事實後面標【核了】或【沒核到】。

---

## 1. 門檻用比例 0.8

**照 dsh**：`DEFAULT_THRESHOLD_RATIO = 0.8`，`compaction-basic/src/config.ts:20` @8bd0733【核了】。對應 nexus 的 `WINDOW_THRESHOLD_RATIO`。

## 2. 門檻公式少了 headroom

**偏離**。dsh 的 `resolveCompactSpec` 在 `config.ts:153-217` @8bd0733（舊註解指 `5badb15` 的 `:153-200`，8bd0733 上函式到 217 才結束）。公式在 `:172`、`:181`、`:191-194`：`thresholdTokens = floor(min(contextWindow × thresholdRatio, contextWindow − reservedCompletionTokens − headroomTokens))`【核了】。`headroomTokens` 預設 65,536，在 `config.ts:75`【核了】。摘要呼叫的 `maxTokens` 也預設等於 `headroomTokens`（`:76`）【核了】。函式說明（`:144-146`）和 README 的設定表（`compaction-basic/README.md:69`）都只說 headroom 是「在路由輸出保留之外再扣的壓力餘量」，沒有說理由【核了】。README 對小窗口的指引是：「Small-window deployments must configure headroom that fits their capacity」（`README.md:80`），也可以逐模型設 `modelPolicies[].headroomTokens`（`:90`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 門檻同時低於窗口的八成，也低於「窗口 − 輸出保留 − headroom」。摘要那次呼叫的輸出上限預設也等於 headroom（`:76`、`README.md:74`）。兩者的關係是推論，原始碼沒寫。 | `floor(min(窗口 × 0.8, 窗口 − 輸出上限))`，至少 1（`windowThreshold`）。註解說「請求加回應不超過窗口」由輸出上限那一項守住。 |
| 失敗與恢復 | headroom 扣完還不夠時拋 `TargetPressureConfigError`（`:181-190`），pre-step 那層 warn 一次後跳過（見 §6）。 | 不會拋，至少回 1。 |
| 效能（摘要頻率） | 預設 headroom 在小窗口上門檻很低。131,007 的窗口、保留 16,384 時，門檻是 49,087（算式核過）。dsh 的解法是逐模型調 headroom。 | 註解：49,087「比我們量過安全的 100,000 低一半，無謂地多摘要」。 |
| 維護成本 | 多一個參數，小窗口的模型要逐顆調。 | 少一個參數。 |
| nexus 產品需求 | — | 註解把 dsh 的 65,536 解讀成「為百萬級窗口定的」（這是 nexus 的判斷，dsh 原始碼沒寫）。nexus 最小的模型窗口是 131k。 |
| 基座做不做得到 | — | 做得到，是純計算。 |

結論：nexus 在 131k 級的窗口上不會過早摘要。代價是摘要呼叫自己的輸出空間沒有另外預留。nexus 的摘要輸出上限設多少，這份對照沒有查。

## 3. 配置的絕對門檻當上限，窗口只往下夾

**偏離**（`effectiveTrigger` 的登記）。dsh 的門檻只從窗口導出，沒有絕對值：`config.ts:191-194`，`POLICY_CONFIG_KEYS`（`:26-36`）裡沒有絕對門檻這一格【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 門檻永遠是窗口的函數。 | `min(配置的 100_000, windowThreshold)`。註解：100,000 是量出來的，最小那顆 131,007 塞得進去。 |
| 失敗與恢復 | — | 沒有型錄的模型照樣有絕對門檻兜著（見 §6）。 |
| 效能 | 784k 窗口上門檻約 63 萬。 | 註解：拿掉絕對值，預設模型的摘要時機會從 10 萬跳到約 63 萬，「是另一個行為決定」。 |
| 維護成本 | 不用手維護數字。 | 數字要手維護。註解說配了一條絆索：模型解得出 `maxInputTokens` 的那天會紅。 |
| nexus 產品需求 | — | 預設模型和 131k 級模型的門檻都不變（#165、#723）。 |
| 基座做不做得到 | — | 做得到。 |

結論：nexus 換來的是行為不變、可預期（預設模型的門檻還是 10 萬）。代價是對大窗口很保守：註解寫「每摘一次就往 backend 寫一份原文」。

## 4. 每一步向當步的模型要窗口

**照 dsh**：`compactPressure` 拿最新一筆持久化路由標頭的 `header.config` 當目標，呼叫 `ctx.llm.resolveModelInfo(target.provider, target.model, signal)`，`compaction-basic/src/index.ts:322-327` @8bd0733【核了】。舊註解指 `index.ts:305-318`，8bd0733 上 305-318 是 overflow 分支和 `compactPressure` 的簽名，`resolveModelInfo` 在 `:327`。

## 5. 門檻跟選中的那顆模型，不跟最近一次送出的那顆

**偏離**（註解：「門檻跟選中那顆（偏離 dsh，#1378 登記、PM 接受）」）。dsh 的 pressure 路徑以最近一次持久化的路由標頭為準：`index.ts:297`、`:322`【核了】。換模型時，dsh 會在 `agent/request` 用「擬換上的標頭」先壓一次（`index.ts:183-203`，`:189-190`）；壓不下來就拒絕這次請求，拋 `MODEL_SWITCH_COMPACTION_FAILED`【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 全部 | 量測與門檻都對最近一次已路由的標頭；換模型時對擬換上的標頭先壓，壓不下就拒絕換。 | 門檻跟選中那顆。理由見 #1378，`summarization.ts` 裡沒寫。 |

結論：理由見 #1378，這份對照沒查。

## 6. 目標模型解不出窗口

**偏離**。dsh 解不出容量時拋 `TargetPressureConfigError`（類別定義在 `config.ts:53-61`，拋出點在 `index.ts:330-336`）。pre-step 那層的 catch 對同一個 target 只 warn 一次（`index.ts:166-169`、`:171`），這一步就不壓縮【核了】。舊註解指 `index.ts:163-170`，8bd0733 上 try/catch 是 `:162-172`，warn-once 在 `:166-169`，拋出點在 `:330-336`。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 沒有窗口就不知道門檻，所以不壓縮。 | `limits` 是 `undefined` 時原樣用配置的絕對門檻。 |
| 失敗與恢復 | 沒有窗口的模型永遠不會自動壓縮，只 warn 一次。 | 沒有型錄的模型照樣在 100,000 或 60 則時摘要。 |
| 維護成本 | 要求每顆模型在 adapter 上設 `contextWindow`。 | 不要求型錄。 |
| 產品需求／基座 | — | 理由是「用配置的絕對門檻接住它」，是 §3 的延伸。 |

結論：nexus 對沒有型錄的模型仍然有保護。代價是門檻可能不貼合那顆模型的窗口。

## 7. 保留量：`retainRatio` 0.16、`retainTokens` 互斥、比例公式

**照 dsh**：
- `DEFAULT_RETAIN_RATIO = 0.16`，`config.ts:23` @8bd0733【核了】
- 兩者互斥，`config.ts:292-294`【核了】
- `retainTokens` 是非負整數，`config.ts:291`【核了】
- 比例公式 `floor((contextWindow − reservedCompletionTokens) × retainRatio)`，`config.ts:172`、`:195-197`【核了】

## 8. 保留量封在門檻的兩成

**偏離**（`RETAIN_THRESHOLD_CAP_RATIO`、`retainTokensFor`）。dsh 在 `resolveCompactSpec` 裡檢查 `retainTokens >= thresholdTokens`，成立就拋 `TargetPressureConfigError`（`config.ts:198-204`）【核了】。這個檢查**不是載入期驗證**：`resolveCompactSpec` 在每次 `compactPressure` 都會被呼叫（`index.ts:337-341`），不過時由 pre-step 那層 warn 一次、跳過壓縮（`index.ts:166-171`）【核了】。載入期只驗比例對比例（`validateRatioRetention`，`config.ts:80`、`:91`，見 §9）。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 保留量超過門檻時這個 target 不壓縮（warn 一次）。 | `min(照比例算出的保留量, floor(有效 tokens 門檻 × 0.2))`。註解：100,000 的絕對門檻讓照比例算出的值（預設那顆 109,385）超過門檻。 |
| 失敗與恢復 | 那個 target 不再自動壓縮，直到改配置。 | 一定算得出一個小於門檻的保留量。 |
| 效能 | — | 封頂讓「摘完下一步又過門檻」不會發生（#1374、#2659）。 |
| 維護成本 | — | 多一個常數 0.2。 |
| 產品需求／基座 | — | 是 §3「保留絕對門檻」連帶的需要。 |

結論：nexus 的絕對門檻和 dsh 的保留公式放在一起會衝突，封頂讓兩者共存。代價是大窗口上保留的尾巴比 dsh 少。另外，註解說 dsh 的這個檢查是「載入期驗證……會當場不過」，8bd0733 上不成立：它是執行期檢查，不過就 warn 一次並跳過。

## 9. 比例對比例的驗證：`retainRatio < thresholdRatio`

**照 dsh**：`validateRatioRetention` 的函式在 `config.ts:230-241`，判斷式在 `:235`，載入時在 `:80`、`:91` 呼叫 @8bd0733【核了】。nexus 的 `assertRetain` 在 `summarizationPlugin.apply` 裡驗一次。

## 10. 選尾巴：從最新往前累加，再退到工具呼叫沒被拆開的位置

**照 dsh**：`selectCompactableRange`，`compaction-basic/src/region.ts:117-155` @8bd0733【核了】。往前累加到 `>= retainTokens`、跨過的那則也留，在 `:133-140`；退到工具配對完整的位置，在 `:143-147`；退到底就回 `null`，在 `:141`、`:148`【核了】。舊註解有兩組範圍：`:133-148` 正確；`:133-140` 只涵蓋累加，不含配對退讓，而引用它的那段（「怎麼選尾巴」）兩件事都講了，應改為 `:133-148`。

## 11. 端點真的回超窗：保留量取 0

**照 dsh**：overflow 路徑會先 `pruneSession`，再呼叫 `selectCompactableRange(session, measurement, 0)`，`index.ts:302-308` @8bd0733。說明「overflow bypasses the normal threshold and retained-tail policy」在 `:284-286`【核了】。舊註解指 `index.ts:262`、`:294`；8bd0733 上 `:262` 是 `summarize` 的說明（`ctx.llm.stream()` 那句），`:294` 是 `trigger` 參數，都不是 overflow 的出處。

## 12. 門檻觸發、摘要失敗：記 warn，照原請求送出

**照 dsh**：pre-step listener 在 `index.ts:157-175` @8bd0733，warn 的字串「step compaction failed: …; continuing the turn」在 `:171`【核了】。舊註解指 `:158-175`（差一行）和 `:163-173`；8bd0733 上 try/catch 是 `:162-172`。

## 13. 端點超窗、摘要也失敗

**偏離（未登記）**。註解寫「照 dsh 的 overflow 路徑（`index.ts:205-224`）……保留原本的請求錯誤」。8bd0733 上 overflow handler 是 `index.ts:213-257`（`:205-211` 是「成功回應就重設 overflow 計數」的 listener）【核了】。dsh 的失敗分兩支：
- 摘要失敗，但修剪已經推進了 surface（`replaceGeneration` 變大）：**重試**，不保留原錯（`:235-242`）【核了】
- 沒有推進：記 warn「preserving the original request error」，`return next()`（`:243-249`）【核了】

另外，dsh 一律先做不打模型的修剪（`:303`），重試次數受 `maxOverflowRetries` 限制（預設 1，`config.ts:106`；判斷在 `index.ts:222-223`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 修剪已經讓請求變小時，用修剪過的 surface 重打一次。 | `summarization.ts:2196-2200`：只要摘要失敗就 `throw endpointOverflow`，「不發明修剪」。 |
| 失敗與恢復 | 修剪有進展，就多一次成功的機會。 | 直接失敗。 |
| 基座做不做得到 | — | 沒查到。nexus 的剪刀在最外層（`isUnderCompactionPressure` 的說明），這條分支沒有「修剪已有進展」可以判斷。 |

結論：「保留原錯」只對應 dsh 沒有進展的那一支，整體不能說是「照 dsh」。理由沒查到。

## 14. 摘要完再量一次，還超過就重試（`compactionRetries`）

**偏離**（註解 §「與 dsh 的偏離」第 5 條登記了 nexus 的做法，沒寫 dsh 的做法）。dsh 的 `compactionRetries` 預設 1（`config.ts:105`），可以是任意非負整數（`:296-298`）。重試迴圈在 `index.ts:353-365`：每次都用**同一個** `spec.retainTokens`，在壓過的新 surface 上重選範圍；用完還超過就拋（`:367-370`）【核了】。dsh 沒有「降到保留 0」這一步。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 新 surface 上會出現新的可壓範圍，重選有意義。 | 註解：「重試交下去的永遠是原請求，換的只有保留量」，再試一次切到的是同一段，所以固定用保留 0、只收 0 或 1。 |
| 失敗與恢復 | 用完還超過就拋，由 pre-step 那層 warn、繼續這一輪。 | 註解：保留 0 那一次在 `catch` 裡，外面沒有 `try`，再拋會冒過 `withTokenBudget`、整輪失敗。用完記 warn，照摘要完的那份送出。 |
| 基座做不做得到 | — | 做不到「在新 surface 上重選」：摘要器在一次 `wrapModelCall` 裡只看得到原請求（註解的理由）。 |

結論：基座表達不出 dsh 的重試形狀，nexus 退到「同一請求、保留量降到 0」，這樣至少不會整輪失敗。

## 15. `messages` 門檻

**偏離**（註解登記：「那道是我們自己加的」）。dsh 只比 token：`index.ts:342`、`:350`、`:364` @8bd0733【核了】。舊註解指 `index.ts:319`，8bd0733 上比較在 `:342`、`:350`。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | token 估不準時沒有第二道。 | 註解：「兩道並聯的用意是 token 估算靠不住時還有第二道兜著」。#1374 之後，則數到了也要尾巴蓋不住整串才會摘。 |
| 失敗與恢復 | — | 窗口比門檻還小時，`messages: 60` 那道兜著（`DEFAULT_SUMMARIZATION` 的說明）。 |
| 維護成本 | — | 多一道要跟剪刀閘門、`messagesCompactable` 對齊。 |

結論：nexus 多一道保險，換來的是 §21 的 `messagesCompactable` 和閘門的額外條件。

## 16. shrink 檢查：判準與位置

**照 dsh**：摘要生出來、提交之前，框好的摘要要比被取代的那段小，否則整次不提交。`compaction-basic/src/region.ts:417-422` @8bd0733【核了】。舊註解寫 `:417-420`，判斷與拋錯完整的範圍是 `:417-422`。

## 17. shrink 檢查用哪把量具

**偏離**。dsh 用 `dependencies.meter.estimateMessage(checkpointMessage)` 去比 `shadowedRouteTokenCount`（`region.ts:417-418`）。後者是被選節點逐路由計價的 `tokens` 總和（`:381`；`:376-379` 說明 shrink 讀的是 route-priced tokens）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 兩邊都按當前路由計價（摘要是純文字，heuristic 就是 route price，`:414-416`）。 | 兩邊都用 `estimateMessageTokens`。被取代那段取參數截斷之前的有效串，「只會略高估被取代的量（檢查寬鬆一點，不會多擋）」。 |
| 失敗與恢復 | 不過就拋，整次不提交。 | 不過就拋 `SummaryNotSmallerError`；估不出來就不擋：「檢查不能反過來把摘要殺掉」。 |
| 效能 | — | 累加到超過框好的摘要就放行，不量完整段。 |
| 基座做不做得到 | — | 「我們沒有逐路由的計價」（同 #1383 的 D3），只能退到這把估算。 |

結論：nexus 用同一把估算，至少兩邊一致、不會多擋。代價是對圖片或逐路由定價的差異不敏感。

## 18. 摘要提示詞：`COMPACTION_INSTRUCTION`

**照 dsh，只改一條規則**：`compaction-basic/src/summarizer.ts:32-67` @8bd0733【核了】。dsh 明寫要英文：`:62`「Write concise English engineering prose.」【核了】。拿 `SUMMARY_INSTRUCTION` 逐行比 dsh 的 `:33-66`：八個段落、前四條規則、`(none)` 的寫法都一字不差，只有最後一條（PRIOR checkpoint，`:66`）不同。舊註解指 `5badb15`，沒給行號。

更正兩處註解：
- 「前六條規則……都是 dsh 的原句」：dsh 的 `Rules:` 底下只有 5 條（`:62-66`），原句照搬的是前 4 條。
- 「只動三處」：三處裡只有第 2 處（PRIOR 規則）在指令本文。第 1 處（前面接 `{conversation}`）和第 3 處（分隔線）在 `SUMMARY_PROMPT` 模板，不在 `SUMMARY_INSTRUCTION`。

## 19. 前一次摘要的標籤

**偏離**（註解登記在「與 dsh 的差」）。dsh 用 `<compacted-summary>` 包摘要（`summarizer.ts:22-23`、`frameSummary` 在 `:188-194`），規則認的也是這個標籤（`:66`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 單一標籤。 | 基座 `buildSummaryMessage` 包的有兩種：有 `filePath` 時是前言加 `<summary>…</summary>`；offload 失敗時只有「Here is a summary of the conversation to date:」一句，不包標籤。所以規則兩種都要認。 |
| 基座做不做得到 | — | 外框由基座產生，nexus 改不了。 |

結論：外框由基座決定，規則只能跟著它的兩種形狀寫。

## 20. 摘要呼叫的形狀：重播前綴，還是模板

**偏離**（#2775）。dsh 的預設實作重播（`summarize` 是可覆寫的鉤子，`index.ts:264` 寫明可以換成模板或遠端摘要器）：`buildSummarizationInput`（`region.ts:544-563`）取 surface 開頭的 system、被壓那段的訊息、標頭上的工具；`summarizeWithLlm`（`summarizer.ts:144-162`）在最後接一則 user 指令，連同 `tools`、`toolHistory` 一起送出【核了】。用意是讓這次呼叫成為上一次路由請求的前綴，重用 KV 快取（`summarizer.ts:25-31`、`index.ts:260-264`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 預設實作永遠重播。 | 歷史從日誌推得出來時才重播（`replayedSummaryCall`）；`state`、`shadow` 模式照模板：對話用 `getBufferString` 攤成一個字串放前面，指令放後面。 |
| 效能 | 一律吃得到前綴快取。 | 模板那次的輸入按全價算（註解）。 |
| 基座做不做得到 | — | 摘要器排在洋蔥外層，看不到這次請求最終的 system 與工具，所以拿上一次主請求送出那一刻留在記憶體的原物件（`last-sent-request.ts`）。日誌推出來的串不保證跟 graph state 相同。 |

結論：條件允許時，nexus 拿到跟 dsh 一樣的前綴快取；條件不允許時退回模板，正確但貴。

## 21. 圖片進摘要輸入

**偏離**。dsh 重播的訊息就是 surface 推導出來的那幾則（`region.ts:553-558`），圖片照原樣帶著。README 要求 adapter 自己解析圖片參照，不然就明確拒絕（`compaction-basic/README.md:129`）【核了】。舊註解指 `summarizer.ts:105-152`（`5badb150`）；8bd0733 上那段是 `summarizeWithLlm` 的開頭，沒有任何圖片處理，重播的證據應改指 `region.ts:544-563` 加 `README.md:129`。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 摘要模型看得到圖。 | 圖換成 `summaryImageText` 的文字佔位；留下給主模型的那幾則換回原物。 |
| 基座做不做得到 | — | 「摘要輸入是基座的 `getBufferString` 範本、輸入是一段字串，表達不出『一則帶圖的訊息』」（註解）。 |

結論：基座做不到，nexus 退到文字佔位。代價是摘要裡關於圖的內容只能靠前後文推。

## 22. 檔案在摘要輸入裡換成 handle 那一行

**照 dsh（字面）**：`fileHandleText`，`llm/llm/src/content.ts:152-159` @8bd0733【核了】。nexus `attachment-ref.ts:243-250` 兩個分支的字面跟它逐字相同（dsh 的 `quoted` 就是 `JSON.stringify`，`content.ts:46-48`）。

分支怎麼選不同：dsh 在 `llm/llm/src/index.ts:1103` 用 `this.fileReadPath(ref)` 實際解析路徑【核了】；nexus 的 `assumedFileLine` 不問儲存（它的註解寫「假設讀得到」），永遠走「saved at」那一支。檔案讀不到時，兩邊的摘要輸入會不同。

## 23. 摘要輸出 fail-closed

**照 dsh**：`summarizeWithLlm` 的檢查順序在 `summarizer.ts:164-171`，`finishError` 在 `:196-211`，`summaryText` 在 `:213-221` @8bd0733【核了】。順序是：結束原因 → 圖片 → 有沒有文字【核了】。原因碼：
- `MAX_TOKENS`：`:203-206`
- `UNSUPPORTED_CONTENT`：`:217-218`
- 空摘要只有訊息、沒有碼：`:169-171`

這跟 nexus 的 `SummaryRejectedCode` 一致：前兩個同名，`EMPTY_SUMMARY` 是 nexus 自己取的名字【核了】。dsh 判斷圖片只看 `block.type === 'image'`：`llm/llm/src/content.ts:127-129`（舊註解指 `:126-128`，差一行）【核了】。nexus 另外也認 `image_url`，註解說那是 LangChain 的 OpenAI 形狀、語意相同。舊註解引的 `687f282e`，8bd0733 上行號相同。

## 24. 只在成功時回 usage

**照 dsh**：`summarizer.ts:172-180` @8bd0733，失敗路徑都在 return 之前就拋了【核了】。

## 25. 被拒收的摘要不重打

**一半照 dsh**。拒收是在串流跑完之後才拋（`summarizer.ts:163-165`、`:168`），串流層的重試碰不到它，這一半【核了】。但 dsh 另有一個摘要失敗的復原鉤子：`compaction/summary-error` 這個 waterfall（`region.ts:397-409`、`index.ts:466-471`）。有 listener 記下了持久的輸入變更、要求重試時，dsh 會重新準備、再摘一次；預設回 `false`，不重試【核了】。nexus 沒有這個鉤子。dsh 的 llm 層對每次串流呼叫有一層「retry, replay, routing」waterfall（`llm/llm/src/index.ts:64`），它對 `purpose: 'compaction'` 那次呼叫的實際行為【沒核到】。

## 26. 摘要那次呼叫不上線

**偏離**。dsh 直接呼叫 `ctx.llm.stream(options)`，帶 `purpose: 'compaction'`，自己用 `BlockAssembler` 組 chunk（`summarizer.ts:144`、`:160`、`:163`）。README 說它不走 agent loop 專用的 `agent/request` 擴充點（`README.md:129`）【核了】。舊註解指 `46a7f68`，沒給行號。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 另起一條不經對話串流的呼叫。 | 同一次呼叫，貼一個串流層認得的標記；摘要文字不進對話，只以 `compaction/summary` 那一顆存在。 |
| 基座做不做得到 | — | 「摘要呼叫長在基座的 middleware 裡、跟主模型共用一條 callback 鏈，表達不出『另起一條不上線的呼叫』」（註解）。 |

結論：結果相同（摘要不進對話），手段受基座限制。

## 27. 生摘要用哪一顆模型

**大致照 dsh，有一格沒登記**。dsh 的順序是 `configured ?? latest ?? agentTarget`（`summarizer.ts:127-137`，選擇在 `:137`）【核了】。`configured` 來自配置的 `summarizationProvider`／`summarizationModel`（`config.ts:102-103`；兩個要成對給，`:307-327`）【核了】。註解只引了 `latest ?? agentTarget`。nexus（`model-selection.ts` 的 `summaryModelOf`）用最近一次已送出的路由，讀不到就用這個 agent 換模型之前那顆，對應 `latest ?? agentTarget`。nexus 的設定 schema `summarizationConfigSchema`（`summarization.ts:2342-2371`）只有 `trigger`、`retainRatio`、`retainTokens`、`keep`（已拿掉）、`truncateArgs`、`historyPathPrefix`、`compactionRetries`，沒有模型欄位。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性／產品需求 | 可以把摘要固定交給另一顆（例如便宜的）模型。 | 沒有這一格。理由沒查到。 |

結論：這是註解沒登記的偏離，理由沒查到。

## 28. 壓縮事件：`start`／`summary`／`end` 三顆加一把鎖

**偏離**（#143）。dsh 先寫 `compaction/start`，把它當持久的鎖，之後恰好嘗試一次 `compaction/end`（`region.ts:157-163`；`compaction/src/index.ts:146-147`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 未配對的 start 可以被偵測，也能擋住並行壓縮。 | 只有一顆 `compaction/summary`。 |
| 基座做不做得到 | — | 「摘要器……在一次 `wrapModelCall` 裡生摘要、交下去，沒有『開始壓縮』這個可觀測的時刻，硬記一顆 `start` 只能記在我們的猜測上」（註解）。 |

結論：基座做不到，nexus 退成一顆事件。

## 29. 壓縮的能力 seam

**偏離**（#149、#150）。dsh 把壓縮做成 `ctx.compaction` 這個服務（`compaction/src/index.ts:119-122`），有 `modelPolicies` 和載入期驗證（`config.ts:68-110`；建構時呼叫，`compaction-basic/src/index.ts:138`）【核了】。註解說有「四個動詞」，8bd0733 上的抽象面只有三個：`compactIfNeeded`、`compactNow`、`compactRegion`（`compaction/src/index.ts:136`、`:162`、`:187`）；第四個指的是什麼【沒核到】，若把 `summarize` 這個子類鉤子（`compaction-basic/src/index.ts:270`）算進去才有四個。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 有手動壓縮、指定範圍壓縮、超窗後壓縮再重試。 | 手動與指定範圍表達不出來（#149）；超窗重試（#150）見註解的更正段。 |
| 基座做不做得到 | — | deepagents 給的是「一個寫死的 middleware」。 |

結論：受基座限制，登記在 #149、#150。

## 30. 被壓的範圍怎麼表示

**偏離**。dsh 在 `compaction/summary` 事件裡記 `shadowedRange`／`shadowedSeqs`（`region.ts:491-505`），後面緊接一顆 `user/message`，帶 `surfaceOp: { op: 'replace', startSeq, endSeq }`（`:506-509`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 用 seq 蓋住一段 surface。 | 一顆 `compaction/summary`，範圍用原始訊息串的切點 `cutoffIndex` 表達，推導端據此切。 |
| 基座做不做得到 | — | 「我們沒有 surface 這一軸」（`conversation-replay.ts` 檔頭）。 |

結論：nexus 沒有 surface 軸，退到用切點表達範圍。

## 31. 日誌不記提示詞的版本

**照 dsh**：`compaction/summary` 的欄位（`region.ts:491-505` @8bd0733）裡沒有指令或版本這一格；指令是程式碼常數（`summarizer.ts:32`）【核了】。

## 32. 量測事件與壓力投影（`context/measure`、`messagesCompactable`）

**偏離**（註解第 3、4 條登記）。dsh 的 `ContextPressureProjection` 只有 `pressureTokens`、`projectedTokens`、`contextWindow`：`llm/token-meter/src/projection.ts:32-50` @8bd0733（舊註解指 `5719020` 的 `:30-48`）【核了】。「切不切得出東西」只在壓縮內部問：`selectCompactableRange` 回 `null`，在 `index.ts:306`、`:355-356`、`:423`（舊註解指 `:299`／`:331`／`:394`）；在 `/compact` 的回覆「No compactable history yet.」裡講（`command-compact/src/index.ts:68`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 投影是給人看的參考，不參與判斷（`token-meter/README.md:68`）。 | 一顆事件只帶量測結果，分母是摘要門檻，不是窗口（#528）；多一格 `messagesCompactable`（#1443）。 |
| 基座做不做得到 | — | 「我們的日誌不記 system、工具定義與請求標頭，重建不出這份請求」（註解）。 |

結論：日誌重建不出請求，所以改記一顆量測事件；多出的那一格補的是 `messages` 門檻（§15）的誠實。

另外兩條註解宣稱的 dsh 事實：
- 「dsh 的壓縮與 `contextPressure` 讀同一個 `measure()`，顯示與判準本來就同一個數」：8bd0733 上不成立。README 寫壓縮讀 `measure()`、佔用率不參與任何判斷（`token-meter/README.md:68`）；`contextPressure()` 讀的是投影狀態（`token-meter/src/index.ts:122-123`）【核了】。
- 「壓力從 `request/header` 與 surface 投影」：README 寫 `contextWindow` 取自最新的 `request/context` 紀錄、`pressureTokens` 取自供應商回報的用量（`token-meter/README.md:49`）。投影的實作沒有逐行追【沒核到】。

## 33. 沒到壓力的對話絕不修剪

**照 dsh**：`compaction-basic/README.zh.md:98`「修剪只在压缩触发条件满足后运行——低于压力的对话绝不会被触碰」；程式碼在 `index.ts:342-348`，先比門檻、再 `pruneSession` @8bd0733【核了】。註解引的字面「低于压力的对话绝不被碰」是改寫過的，原句如上。nexus 的對應是 `isUnderCompactionPressure`。

## 34. dsh 的預設是比例形式

**事實核對**：檔頭說「dsh 的預設答案（`thresholdRatio` 0.8／`retainRatio` 0.16）正是比例形式」，`config.ts:20`、`:23`【核了】。nexus 在型別層禁用 `'fraction'`，是基座的缺陷造成的（#142），跟 dsh 無關，不算偏離。

## 35. 載體：`compaction-basic` 是獨立套件

**偏離**（`summarizationPlugin` 的登記）。dsh 的 `compaction-basic` 是獨立套件，`BasicCompactionEngine` 用 `static inject = ['llm', 'tokenMeter', 'sessions']` 掛在服務上（`compaction-basic/src/index.ts:112-113`）【核了】。nexus 表達不出來的是「逐個 agent 各建一份」和「同名取代基座那顆」，理由在註解裡，這裡不另立表。

---

## 沒核到的

- **ctx.compaction 的「四個動詞」**：8bd0733 上的抽象面只有三個（`compaction/src/index.ts:136/162/187`）。第四個是不是指 `summarize` 鉤子，沒能從原始碼確定。
- **dsh 壓力投影的來源是 `request/header` 加 surface**：只讀到 README（`token-meter/README.md:49`，說 `contextWindow` 取自 `request/context`），沒有逐行追 `usage-projection.ts` 的實作。
- **dsh llm 層的重試 waterfall 對 `purpose: 'compaction'` 那次呼叫的行為**：只看到 `llm/llm/src/index.ts:64` 的說明，沒追進 `retry-policy.ts`。
- **`ctx.llm.stream` 確實經過 `adapterStream`、所以摘要呼叫也會被換成檔案 handle**：`llm/llm/src/index.ts:1103` 在 `adapterStream`（`:1068` 起）裡，但從 `stream` 到 `adapterStream` 的呼叫鏈沒逐行追。
- **nexus 這邊的幾項（不是 dsh 事實，但影響比較）**，都沒查：
  - 摘要呼叫的輸出上限（§2）
  - 有沒有對應 dsh 換模型先壓的動作（§5）
  - 選尾巴時是否排除開頭的 system（dsh 在 `region.ts:131` 排除）（§10）
  - `error`／`aborted` 結束原因怎麼處理（dsh 的 `finishError` 拋 `LlmError`，`summarizer.ts:199-202`）（§23）
- **舊 SHA 上的行號**：`5badb15`、`687f282e`、`46a7f68`、`5719020` 這些 commit 在本機 clone 裡都在，但沒逐一驗證舊行號在那些 SHA 上是否成立，只對 8bd0733 核過。
- **註解裡「預設那顆 109,385」**：這是 nexus 用型錄數字算出來的值，不是 dsh 事實。用 784,369 和 16,384 算不出 109,385，型錄的實際數字沒查。
