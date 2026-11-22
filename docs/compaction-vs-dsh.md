# 壓縮與摘要：nexus 與 dsh 的對照

對照對象：nexus 的 `harness/packages/nexus-core/src/summarization.ts`，dsh 的 `packages/compaction/compaction-basic`，另外引到 dsh 的 `compaction`、`command-compact`、`llm/llm`、`llm/token-meter` 幾個套件。dsh 的出處都用 `git show 8bd0733:<path>` 讀過，行號以 8bd0733 為準。nexus 這邊的做法與理由以 `summarization.ts` 現行的程式碼與註解為準，出處寫符號名（函式、常數、註解小節），不寫行號；程式碼讀不出理由的，寫「理由見 #NNN」或「沒查到」。文中的「舊註解（4edd74ab）」指 base 4edd74ab 那一版 `summarization.ts` 的註解，現行碼已改掉或刪掉；它指過的 SHA（`5badb15`、`5badb150`、`687f282e`、`46a7f68`、`5719020`）與行號跟 8bd0733 不同的，逐條寫成「舊註解（4edd74ab）指 …，8bd0733 上是 …」。

每個主題先判定「照 dsh」或「偏離」。照 dsh 的只寫一行出處；偏離的附比較表和一句結論，表的列用 AGENTS.md〈技術實現標準〉那一組標準：正確性、失敗與恢復、效能、維護成本、nexus 的產品需求、現有基座做不做得到，沒有內容的格寫「—」。每條 dsh 事實後面標【核了】或【沒核到】。

---

## 1. 門檻用比例 0.8

**照 dsh**：`DEFAULT_THRESHOLD_RATIO = 0.8`，`compaction-basic/src/config.ts:20` @8bd0733【核了】。對應 nexus 的 `WINDOW_THRESHOLD_RATIO`。

## 2. 門檻公式少了 headroom

**偏離**。dsh 的 `resolveCompactSpec` 在 `config.ts:153-217` @8bd0733（舊註解（4edd74ab）指 `5badb15` 的 `:153-200`，8bd0733 上函式到 217 才結束）。公式在 `:172`、`:181`、`:191-194`：`thresholdTokens = floor(min(contextWindow × thresholdRatio, contextWindow − reservedCompletionTokens − headroomTokens))`【核了】。`headroomTokens` 預設 65,536，在 `config.ts:75`【核了】。摘要呼叫的 `maxTokens` 也預設等於 `headroomTokens`（`:76`）【核了】。函式說明（`:144-146`）和 README 的設定表（`compaction-basic/README.md:69`）都只說 headroom 是「在路由輸出保留之外再扣的壓力餘量」，沒有說理由【核了】。README 對小窗口的指引是：「Small-window deployments must configure headroom that fits their capacity」（`README.md:80`），也可以逐模型設 `modelPolicies[].headroomTokens`（`:90`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 門檻同時低於窗口的八成，也低於「窗口 − 輸出保留 − headroom」。摘要那次呼叫的輸出上限預設也等於 headroom（`:76`、`README.md:74`）。兩者的關係是推論，原始碼沒寫。 | `floor(min(窗口 × 0.8, 窗口 − 輸出上限))`，至少 1（`windowThreshold`）。`effectiveTrigger` 的〈怎麼夾〉寫「請求加回應不超過窗口」由輸出上限那一項守住。 |
| 失敗與恢復 | headroom 扣完還不夠時拋 `TargetPressureConfigError`（`:181-190`）。pressure 路徑上由 pre-step 那層對同一個 target warn 一次後跳過（見 §6）；換模型那條路上同一個錯變成 `MODEL_SWITCH_COMPACTION_FAILED`，直接拒絕換模型（`index.ts:183-203`，見 §5）【核了】。 | 不會拋，至少回 1。 |
| 效能（摘要頻率） | 預設 headroom 在小窗口上門檻很低。131,007 的窗口、保留 16,384 時，門檻是 49,087（算式核過）。dsh 的解法是逐模型調 headroom。 | `effectiveTrigger` 的〈怎麼夾〉：49,087「比我們量過安全的 100,000 低一半，無謂地多摘要」。 |
| 維護成本 | 多一個參數，小窗口的模型要逐顆調。 | 少一個參數。 |
| nexus 產品需求 | — | `effectiveTrigger` 把 65,536 說成「為百萬級窗口定的 headroom」（這是 nexus 的判斷，dsh 原始碼沒寫）。兩件事要分開：#165 量過的模型裡最小的是 131,007（`DEFAULT_SUMMARIZATION` 的〈`trigger`〉表）；出廠型錄裡最小的窗口是 90b（`meta/llama-3.2-90b-vision-instruct`）的 32,768、輸出上限 4,096（`harness/apps/harness/cordis.yml` 的型錄）。90b 上門檻被 `windowThreshold` 夾到 `floor(min(26,214.4, 28,672))` ＝ 26,214。 |
| 基座做不做得到 | — | 做得到，是純計算。 |

結論：nexus 在 131k 級的窗口上不會過早摘要；90b 這種 32k 窗口由 `windowThreshold` 夾到 26,214。代價是摘要呼叫自己的輸出空間沒有另外預留。nexus 的摘要輸出上限設多少，這份對照沒有查。

## 3. 配置的絕對門檻當上限，窗口只往下夾

**偏離**（`effectiveTrigger`）。dsh 的門檻只從窗口導出，沒有絕對值：`config.ts:191-194`，`POLICY_CONFIG_KEYS`（`:26-36`）裡沒有絕對門檻這一格【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 門檻永遠是窗口的函數。 | `min(配置的 100_000, windowThreshold)`。`effectiveTrigger` 的〈怎麼夾〉：100,000 是量出來的，最小那顆 131,007 塞得進去。 |
| 失敗與恢復 | — | 沒有型錄的模型照樣有絕對門檻兜著（見 §6）。 |
| 效能 | 784k 窗口上門檻約 63 萬。 | `effectiveTrigger` 的〈怎麼夾〉：拿掉絕對值，預設模型的摘要時機會從 10 萬跳到約 63 萬，「是另一個行為決定」。 |
| 維護成本 | 不用手維護數字。 | 數字要手維護。檔頭〈基座表達得出、表達不出的〉記了一條絆索：模型解得出 `maxInputTokens` 的那天會紅。 |
| nexus 產品需求 | — | 預設模型和 131k 級模型的門檻都不變（#165、#723）。 |
| 基座做不做得到 | — | 做得到。 |

結論：nexus 換來的是行為不變、可預期（預設模型的門檻還是 10 萬）。代價是對大窗口很保守：`DEFAULT_SUMMARIZATION` 的〈`trigger`〉寫「每摘一次就往 backend 寫一份原文」。

## 4. 每一步向當步的模型要窗口

**照 dsh**：`compactPressure` 拿最新一筆持久化路由標頭的 `header.config` 當目標，呼叫 `ctx.llm.resolveModelInfo(target.provider, target.model, signal)`，`compaction-basic/src/index.ts:322-327` @8bd0733【核了】。舊註解（4edd74ab）指 `index.ts:305-318`，8bd0733 上 305-318 是 overflow 分支和 `compactPressure` 的簽名，`resolveModelInfo` 在 `:327`。

## 5. 門檻跟選中的那顆模型，不跟最近一次送出的那顆

**偏離**（#1378；`withQuietSummaryCall` 的〈生摘要用哪一顆〉寫「門檻跟選中那顆」）。dsh 的 pressure 路徑以最近一次持久化的路由標頭為準：`index.ts:297`、`:322`【核了】。換模型時，dsh 會在 `agent/request` 用「擬換上的標頭」先壓一次（`index.ts:183-203`，`compactPressure` 在 `:190`）；壓不下來就拒絕這次請求，拋 `MODEL_SWITCH_COMPACTION_FAILED`，訊息說保留前一顆模型（`:195-200`）【核了】。

#1378 是已合併的 PR，理由寫在它的內文（`gh issue view 1378` 讀過）。它描述的 dsh 做法（`index.ts:158`、「換模型那一步靠 overflow 失敗接住」）跟 8bd0733 對不上：8bd0733 上換模型是在 `agent/request` 先壓，見上。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 量測與門檻都對最近一次已路由的標頭；換模型時對擬換上的標頭先壓。 | 門檻跟選中那顆（`effectiveTrigger` 每步用 `request.model` 的上限）；生摘要跟最近一次已送出的那顆（#1377，見 §27）。換模型的那一步，洋蔥上換模型在摘要器外面，當場就拿到選中那顆（#1378）。 |
| 失敗與恢復 | 先壓失敗就拒絕換模型，保留前一顆。 | 沒有「拒絕換模型」這一步；摘要失敗走 §12、§13 的路。 |
| 效能 | — | — |
| 維護成本 | — | — |
| nexus 產品需求 | — | #1378：選這個是因為 #723 的驗收是「換模型之後窗口跟著換」。 |
| 基座做不做得到 | — | #1378：不是表達不出來，照 dsh 的時序讀 `ModelSelectionController.state().lastUsed` 即可。 |

結論：nexus 讓門檻在換模型的那一步就跟上選中那顆，滿足 #723 的驗收；dsh「先壓、壓不下就拒絕換」的保護 nexus 沒有。

## 6. 目標模型解不出窗口

**偏離**。dsh 解不出容量時拋 `TargetPressureConfigError`（類別定義在 `config.ts:53-61`，拋出點在 `index.ts:330-336`）。pressure 路徑上，pre-step 那層的 catch 對同一個 target 只 warn 一次（`index.ts:166-169`、`:171`），這一步就不壓縮【核了】；warn 一次只對 `TargetPressureConfigError`，別的錯每次都 warn（`:166`、`:171`）【核了】。換模型那條路上（`index.ts:183-203`）同一個錯被包成 `MODEL_SWITCH_COMPACTION_FAILED`，直接拒絕換模型【核了】。舊註解（4edd74ab）指 `index.ts:163-170`，8bd0733 上 try/catch 是 `:162-172`，warn-once 在 `:166-169`，拋出點在 `:330-336`。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 沒有窗口就不知道門檻，所以不壓縮。 | `limits` 是 `undefined` 時原樣用配置的絕對門檻。 |
| 失敗與恢復 | 沒有窗口的模型永遠不會自動壓縮，只 warn 一次；換到這種模型會被拒絕。 | 沒有型錄的模型照樣在 100,000 或 60 則時摘要。 |
| 效能 | — | — |
| 維護成本 | 要求每顆模型在 adapter 上設 `contextWindow`。 | 不要求型錄。 |
| nexus 產品需求 | — | —（`effectiveTrigger` 只寫「解不出窗口不等於不壓縮，用配置的絕對門檻接住它」，是 §3 的延伸，沒寫產品面的理由） |
| 基座做不做得到 | — | 做得到，是純計算。 |

結論：nexus 對沒有型錄的模型仍然有保護。代價是門檻可能不貼合那顆模型的窗口。

## 7. 保留量：`retainRatio` 0.16、`retainTokens` 互斥、比例公式

**照 dsh**：
- `DEFAULT_RETAIN_RATIO = 0.16`，`config.ts:23` @8bd0733【核了】
- 兩者互斥，`config.ts:292-294`【核了】
- `retainTokens` 是非負整數，`config.ts:291`【核了】
- 比例公式 `floor((contextWindow − reservedCompletionTokens) × retainRatio)`，`config.ts:172`、`:195-197`【核了】

## 8. 保留量封在門檻的兩成

**偏離**（`RETAIN_THRESHOLD_CAP_RATIO`、`retainTokensFor`）。dsh 在 `resolveCompactSpec` 裡檢查 `retainTokens >= thresholdTokens`，成立就拋 `TargetPressureConfigError`（`config.ts:198-204`）【核了】。這個檢查**不是載入期驗證**：`resolveCompactSpec` 在每次 `compactPressure` 都會被呼叫（`index.ts:337-341`）。pressure 路徑上不過時由 pre-step 那層 warn 一次、跳過壓縮（`index.ts:166-171`）；換模型那條路上變成 `MODEL_SWITCH_COMPACTION_FAILED`、拒絕換模型（`index.ts:183-203`）【核了】。載入期只驗比例對比例（`validateRatioRetention`，`config.ts:80`、`:91`，見 §9）。

照比例算出的值超過 100,000：出廠預設那顆（`harness/apps/harness/cordis.yml` 型錄的 784,369／16,384）是 `floor((784,369 − 16,384) × 0.16)` ＝ 122,877（`RETAIN_THRESHOLD_CAP_RATIO` 的說明用的也是這個數）；`summarizer-retention.test.ts` 用的例子 700,045／16,384 算出 109,385。兩個都超過 100,000，結論相同。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 保留量超過門檻時這個 target 不壓縮（pressure 路徑 warn 一次），換模型則被拒絕。 | `min(照比例算出的保留量, floor(有效 tokens 門檻 × 0.2))`。100,000 的絕對門檻下，照比例算出的值（出廠預設那顆 122,877）超過門檻。90b 上封頂是 5,242，高於照比例的 4,587，不生效（`RETAIN_THRESHOLD_CAP_RATIO` 的說明）。 |
| 失敗與恢復 | 那個 target 不再自動壓縮，直到改配置。 | 一定算得出一個小於門檻的保留量。 |
| 效能 | — | 封頂讓「摘完下一步又過門檻」不會發生（#1374、#2659）。 |
| 維護成本 | — | 多一個常數 0.2。 |
| nexus 產品需求 | — | 是 §3「保留絕對門檻」連帶的需要。 |
| 基座做不做得到 | — | 做得到，是純計算。 |

結論：nexus 的絕對門檻和 dsh 的保留公式放在一起會衝突，封頂讓兩者共存。代價是大窗口上保留的尾巴比 dsh 少。dsh 的這個檢查是執行期檢查（`resolveCompactSpec` 每次 pressure 都呼叫，`config.ts:198-204`），不是載入期驗證。

## 9. 比例對比例的驗證：`retainRatio < thresholdRatio`

**照 dsh**：`validateRatioRetention` 的函式在 `config.ts:230-241`，判斷式在 `:235`，載入時在 `:80`、`:91` 呼叫 @8bd0733【核了】。nexus 的 `assertRetain` 在 `summarizationPlugin.apply` 裡驗一次。

## 10. 選尾巴：從最新往前累加，再退到工具呼叫沒被拆開的位置

**選法照 dsh**：`selectCompactableRange`，`compaction-basic/src/region.ts:117-155` @8bd0733【核了】。往前累加到 `>= retainTokens`、跨過的那則也留，在 `:133-140`；退到工具配對完整的位置，在 `:143-147`；退到底就回 `null`，在 `:141`、`:148`【核了】。nexus 的對應是 `retainedTailCount` 與 `pairedCut`。

### 偏離：nexus 在選法外面多了三條規則

三條都在 `retainedMessageCount`（與 `retainMessagesCap`、`retainTokensFor`）裡，dsh 的 `selectCompactableRange` 沒有對應【核了】：

1. **切點前只剩上一顆摘要，就算摘不到東西**（#2086）：`messages.length − retained === 1` 而且 `messages[0]` 是摘要訊息（`isSummarizationMessage`）時，回整串的長度，基座不摘要。dsh 最接近的是排除開頭的 system head（`firstIdx`，`region.ts:131`），切點退到它就回 `null`（`:141`、`:148`）；沒有「只剩上一個 checkpoint」的規則【核了】。
2. **則數封頂**（#2659，`retainMessagesCap`）：最小的 `messages` 門檻 × 0.2，下限 2 則。只在切得到東西、而且尾巴則數大於封頂時生效；封頂後再用 `pairedCut` 退到工具配對完整的位置，所以可能比封頂多留幾則。哪一道門檻觸發都一樣封；沒有 `messages` 門檻就不封。
3. **沒有 token 保留量時退回 20 則**（`RETAIN_FALLBACK_MESSAGES`）：只在 `retainTokensFor` 回 `undefined` 時，也就是沒型錄、也沒有 `tokens` 門檻。有 `tokens` 門檻而沒型錄時，`retainTokensFor` 回的是封頂（門檻 × 0.2），不是 20 則。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 保留量一定有值：載入時就解出比例或 token（`config.ts:79`），窗口解不出就拋（§6），所以沒有退回則數這條路。只有 token 一道門檻（§15），沒有則數封頂的需要。 | 三條規則各補一個 nexus 自己造出的情形：則數門檻（§15）、絕對門檻與沒型錄的模型（§3、§6）。 |
| 失敗與恢復 | 切點前只剩上一個 checkpoint 時沒有專門的規則，會不會再摘一次取決於 shrink 檢查（§16）；這是推論，沒有實測。 | #2086：不摘，免得拿新摘要換舊摘要、卸不掉新內容。 |
| 效能 | — | #2086：少了它，切點被一則自己就撐過保留量的大訊息卡住、`messages` 門檻每一步都成立時，每一步都多打一次摘要模型（`retainedMessageCount` 的說明）。#2659：少了它，摘完下一輪又觸發，之後每輪都摘（`retainMessagesCap` 的說明）。 |
| 維護成本 | — | 多一個下限 2 與一個常數 20；`withRetainedTail`（交給基座的 `keep`）與 `isUnderCompactionPressure`（剪刀的閘門）要讀同一個數（`retainedMessageCount` 的說明）。 |
| nexus 產品需求 | — | — |
| 基座做不做得到 | — | 做得到，是純計算。20 則是基座本來的預設（`RETAIN_FALLBACK_MESSAGES` 的說明）。基座的 `keep` 在建構時就定了，所以每一步的則數由 `withRetainedTail` 換實例。 |

結論：選尾巴的演算法照 dsh；三條額外規則都是 nexus 自己加的門檻（則數門檻、絕對門檻、沒型錄也要摘）連帶需要的，用來擋「每一步都摘」與「拿摘要換摘要」。

## 11. 端點真的回超窗：保留量取 0

**照 dsh**：overflow 路徑會先 `pruneSession`，再呼叫 `selectCompactableRange(session, measurement, 0)`，`index.ts:302-308` @8bd0733。說明「overflow bypasses the normal threshold and retained-tail policy」在 `:284-286`【核了】。舊註解（4edd74ab）指 `index.ts:262`、`:294`；8bd0733 上 `:262` 是 `summarize` 的說明（`ctx.llm.stream()` 那句），`:294` 是 `trigger` 參數，都不是 overflow 的出處。

## 12. 門檻觸發、摘要失敗：記 warn，照原請求送出

**照 dsh**：pre-step listener 在 `index.ts:157-175` @8bd0733，warn 的字串「step compaction failed: …; continuing the turn」在 `:171`【核了】。舊註解（4edd74ab）指 `:158-175`（差一行）和 `:163-173`；8bd0733 上 try/catch 是 `:162-172`。

## 13. 端點超窗、摘要也失敗

**偏離**。舊註解（4edd74ab）寫「照 dsh 的 overflow 路徑（`index.ts:205-224`）……保留原本的請求錯誤」。8bd0733 上 overflow handler 是 `index.ts:213-257`（`:205-211` 是「成功回應就重設 overflow 計數」的 listener）【核了】。dsh 的失敗分兩支：
- 摘要失敗，但修剪已經推進了 surface（`replaceGeneration` 變大）：**重試**，不保留原錯（`:235-242`）【核了】
- 沒有推進：記 warn「preserving the original request error」，`return next()`（`:243-249`）【核了】

另外，dsh 一律先做不打模型的修剪（`:303`），重試次數受 `maxOverflowRetries` 限制（預設 1，`config.ts:106`；判斷在 `index.ts:222-223`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 修剪已經讓請求變小時，用修剪過的 surface 重打一次。 | `withTokenBudget` 的 catch 分支：只要摘要失敗就 `throw endpointOverflow`，記 warn、保留原本的請求錯誤，「不發明修剪」。 |
| 失敗與恢復 | 修剪有進展，就多一次成功的機會。 | 直接失敗。 |
| 效能 | — | — |
| 維護成本 | — | — |
| nexus 產品需求 | — | — |
| 基座做不做得到 | — | 沒查到。nexus 的剪刀在最外層（`isUnderCompactionPressure` 的說明），這條分支沒有「修剪已有進展」可以判斷。 |

結論：「保留原錯」只對應 dsh 沒有進展的那一支，整體不能說是「照 dsh」。理由沒查到。

## 14. 摘要完再量一次，還超過就重試（`compactionRetries`）

**偏離**（`withTokenBudget` 的〈取捨〉第 5 條寫了 nexus 的做法，沒寫 dsh 的做法）。dsh 的 `compactionRetries` 預設 1（`config.ts:105`），可以是任意非負整數（`:296-298`）。重試迴圈在 `index.ts:353-365`：每次都用**同一個** `spec.retainTokens`，在壓過的新 surface 上重選範圍；用完還超過就拋（`:367-370`）【核了】。dsh 沒有「降到保留 0」這一步。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 新 surface 上會出現新的可壓範圍，重選有意義。 | 〈取捨〉第 5 條：「重試交下去的永遠是原請求，換的只有保留量」，再試一次切到的是同一段，所以固定用保留 0、只收 0 或 1。 |
| 失敗與恢復 | 用完還超過就拋。pressure 路徑上由 pre-step 那層 warn、繼續這一輪（§12）；換模型那條路上變成 `MODEL_SWITCH_COMPACTION_FAILED`（`index.ts:183-203`）【核了】。 | 〈取捨〉第 5 條：保留 0 那一次在 `catch` 裡，外面沒有 `try`，再拋會冒過 `withTokenBudget`、整輪失敗。用完記 warn，照摘要完的那份送出。 |
| 效能 | — | 一次呼叫最多多摘一次（只收 0 或 1）。 |
| 維護成本 | — | 多一顆 `RetainLessSignal` 與載入期的 `assertCompactionRetries`。 |
| nexus 產品需求 | — | — |
| 基座做不做得到 | — | 做不到「在新 surface 上重選」：摘要器在一次 `wrapModelCall` 裡只看得到原請求（〈取捨〉第 5 條的理由）。 |

結論：基座表達不出 dsh 的重試形狀，nexus 退到「同一請求、保留量降到 0」，這樣至少不會整輪失敗。

## 15. `messages` 門檻

**偏離**（nexus 自己加的一道）。dsh 只比 token：`index.ts:342`、`:350`、`:364` @8bd0733【核了】。舊註解（4edd74ab）指 `index.ts:319`，8bd0733 上比較在 `:342`、`:350`。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | token 估不準時沒有第二道。 | `SummarizationSettings.trigger` 的說明：「兩道並聯的用意是 token 估算靠不住時還有第二道兜著」。#1374 之後，則數到了也要尾巴蓋不住整串才會摘（`DEFAULT_SUMMARIZATION` 的〈`trigger`〉）。 |
| 失敗與恢復 | — | 窗口比門檻還小時，`messages: 60` 那道兜著（`DEFAULT_SUMMARIZATION` 的〈`trigger`〉）。 |
| 效能 | — | — |
| 維護成本 | — | 多一道要跟剪刀閘門、`messagesCompactable` 對齊，還要 §10 的則數封頂。 |
| nexus 產品需求 | — | — |
| 基座做不做得到 | — | 做得到：基座的 `shouldSummarize` 本來就收 `messages` 門檻。 |

結論：nexus 多一道保險，換來的是 §32 的 `messagesCompactable`、§10 的則數封頂和閘門的額外條件。

## 16. shrink 檢查：判準與位置

**照 dsh**：摘要生出來、提交之前，框好的摘要要比被取代的那段小，否則整次不提交。`compaction-basic/src/region.ts:417-422` @8bd0733【核了】。舊註解（4edd74ab）指 `:417-420`，判斷與拋錯完整的範圍是 `:417-422`。

## 17. shrink 檢查用哪把量具

**偏離**。dsh 用 `dependencies.meter.estimateMessage(checkpointMessage)` 去比 `shadowedRouteTokenCount`（`region.ts:417-418`）。後者是被選節點逐路由計價的 `tokens` 總和（`:381`；`:376-379` 說明 shrink 讀的是 route-priced tokens）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 兩邊都按當前路由計價（摘要是純文字，heuristic 就是 route price，`:414-416`）。 | 兩邊都用 `estimateMessageTokens`。被取代那段取參數截斷之前的有效串，「只會略高估被取代的量（檢查寬鬆一點，不會多擋）」（`assertSummaryShrinks` 前的說明）。 |
| 失敗與恢復 | 不過就拋，整次不提交。 | 不過就拋 `SummaryNotSmallerError`；估不出來就不擋：「檢查不能反過來把摘要殺掉」。 |
| 效能 | — | 累加到超過框好的摘要就放行，不量完整段。 |
| 維護成本 | — | — |
| nexus 產品需求 | — | — |
| 基座做不做得到 | — | 「我們沒有逐路由的計價（同 #1383 的理由）」，只能退到這把估算。 |

結論：nexus 用同一把估算，至少兩邊一致、不會多擋。代價是對圖片或逐路由定價的差異不敏感。

## 18. 摘要提示詞：`COMPACTION_INSTRUCTION`

**照 dsh，只改一條規則**：`compaction-basic/src/summarizer.ts:32-67` @8bd0733【核了】。dsh 明寫要英文：`:62`「Write concise English engineering prose.」【核了】。拿 `SUMMARY_INSTRUCTION` 逐行比 dsh 的 `:33-66`：八個段落、前四條規則、`(none)` 的寫法都一字不差；dsh 的 `Rules:` 底下共 5 條（`:62-66`），只有最後一條（PRIOR checkpoint，`:66`）不同【核了】。舊註解（4edd74ab）指 `5badb15`，沒給行號。

nexus 另外兩處不在指令本文：前面接 `{conversation}` 和分隔線都在 `SUMMARY_PROMPT` 模板，只有模板那條路用得到（見 §20）。

## 19. 前一次摘要的標籤

**偏離**（檔頭〈形狀與標籤〉）。dsh 用 `<compacted-summary>` 包摘要（`summarizer.ts:22-23`、`frameSummary` 在 `:188-194`），規則認的也是這個標籤（`:66`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 單一標籤。 | 基座 `buildSummaryMessage` 包的有兩種：有 `filePath` 時是前言加 `<summary>…</summary>`；offload 失敗時只有「Here is a summary of the conversation to date:」一句，不包標籤。所以規則兩種都要認。 |
| 失敗與恢復 | — | — |
| 效能 | — | — |
| 維護成本 | — | — |
| nexus 產品需求 | — | — |
| 基座做不做得到 | — | 外框由基座產生，nexus 改不了。 |

結論：外框由基座決定，規則只能跟著它的兩種形狀寫。

#2777 之後前言多一種：組裝裡有 `history_read`、而且這次呼叫查得到會話日誌時，摘要器不寫歷史檔，前言只指向讀回工具、照樣包 `<summary>`（`summarizer-engine.ts`：寫不寫檔在 `summarizeMessages`，前言在 `buildSummaryMessage`）。規則認的標籤沒變。

## 20. 摘要呼叫的形狀：重播前綴，還是模板

**偏離**（#2775）。dsh 的預設實作重播（`summarize` 是可覆寫的鉤子，`index.ts:264` 寫明可以換成模板或遠端摘要器）：`buildSummarizationInput`（`region.ts:544-563`）取 surface 開頭的 system、被壓那段的訊息、標頭上的工具；`summarizeWithLlm`（`summarizer.ts:144-162`）在最後接一則 user 指令，連同 `tools`、`toolHistory` 一起送出【核了】。用意是讓這次呼叫成為上一次路由請求的前綴，重用 KV 快取（`summarizer.ts:25-31`、`index.ts:260-264`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 預設實作永遠重播。 | 歷史從日誌推得出來時才重播（`replayedSummaryCall`）；`state`、`shadow` 模式照模板：對話用 `getBufferString` 攤成一個字串放前面，指令放後面。 |
| 失敗與恢復 | — | `replayedSummaryCall` 回 `undefined` 就退回模板：找不到日誌、行程裡沒有可重播的上一次請求（例如重啟後第一次摘要）、日誌推出來的串與有效串對不上、過程中任何一步拋錯。 |
| 效能 | 一律吃得到前綴快取。 | 模板那次的輸入按全價算（檔頭〈形狀與標籤〉）。 |
| 維護成本 | — | — |
| nexus 產品需求 | — | — |
| 基座做不做得到 | — | 摘要器排在洋蔥外層，看不到這次請求最終的 system 與工具，所以拿上一次主請求送出那一刻留在記憶體的原物件（`last-sent-request.ts`）。日誌推出來的串不保證跟 graph state 相同。 |

結論：條件允許時，nexus 拿到跟 dsh 一樣的前綴快取；條件不允許時退回模板，正確但貴。

## 21. 圖片進摘要輸入

dsh 重播的訊息就是 surface 推導出來的那幾則（`region.ts:553-558`），圖片照原樣帶著。README 要求 adapter 自己解析圖片參照，不然就明確拒絕（`compaction-basic/README.md:129`）【核了】。舊註解（4edd74ab）指 `summarizer.ts:105-152`（`5badb150`）；8bd0733 上那段是 `summarizeWithLlm` 的開頭，沒有任何圖片處理，重播的出處是 `region.ts:544-563` 加 `README.md:129`。

nexus 分兩條路（§20），結論不同：

### 21a. 重播那條

**照 dsh**：`README.md:129`「The selected adapter must resolve image references in the replayed messages or explicitly reject them」@8bd0733【核了】。nexus 的 `replayedSummaryCall` 從日誌推原訊息，經同一個 `invoke` 送出（`summarizer-engine.ts` 的 `createSummary`：`model.invoke(call.input, call.options)`），不經 `withAttachmentText` 的投影；附件由送出端依模型能力投影（`withAttachmentText` 的說明；對話那條路的模型是 `harness/apps/harness/src/attachment-chat-openai.ts` 的 `AttachmentChatOpenAI`，檔頭寫它在 `invoke` 平常走的 `_generate` 與兩條串流路上都投影）。摘要那次打到的模型是否一定是這個子類（`summaryModelOf` 挑的那顆）沒逐一追。

### 21b. 模板那條

**偏離**。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 摘要模型看得到圖（或 adapter 明確拒絕）。 | 圖換成 `summaryImageText` 的文字佔位，檔案換成 `assumedFileLine` 那一行；留下給主模型的那幾則換回原物（`withAttachmentText`）。 |
| 失敗與恢復 | adapter 解析不了就拒絕，這次摘要失敗。 | 不會因為圖失敗；摘要模型看不到圖的內容。 |
| 效能 | — | — |
| 維護成本 | — | — |
| nexus 產品需求 | — | — |
| 基座做不做得到 | — | `withAttachmentText` 的〈圖為什麼是文字〉：照模板生摘要時，輸入是基座 `getBufferString` 攤成的一段字串，表達不出「一則帶圖的訊息」。 |

結論：模板那條基座做不到，退到文字佔位，代價是摘要裡關於圖的內容只能靠前後文推；重播那條與 dsh 同形，摘要模型看得到圖（依模型能力投影）。

## 22. 檔案在摘要輸入裡換成 handle 那一行

**照 dsh（字面）**：`fileHandleText`，`llm/llm/src/content.ts:152-159` @8bd0733【核了】。nexus `attachment-ref.ts:243-250` 兩個分支的字面跟它逐字相同（dsh 的 `quoted` 就是 `JSON.stringify`，`content.ts:46-48`）。

分支怎麼選不同：dsh 在 `llm/llm/src/index.ts:1103` 用 `this.fileReadPath(ref)` 實際解析路徑【核了】；nexus 的 `assumedFileLine` 不問儲存（`withAttachmentText` 的〈做法〉寫「假設讀得到」），永遠走「saved at」那一支。檔案讀不到時，兩邊的摘要輸入會不同。這只適用模板那條（§21b）。

## 23. 摘要輸出 fail-closed

**照 dsh**：`summarizeWithLlm` 的檢查順序在 `summarizer.ts:164-171`，`finishError` 在 `:196-211`，`summaryText` 在 `:213-221` @8bd0733【核了】。順序是：結束原因 → 圖片 → 有沒有文字【核了】。原因碼：
- `MAX_TOKENS`：`:203-206`
- `UNSUPPORTED_CONTENT`：`:217-218`
- 空摘要只有訊息、沒有碼：`:169-171`

這跟 nexus 的 `SummaryRejectedCode` 一致：前兩個同名，`EMPTY_SUMMARY` 是 nexus 自己取的名字【核了】。dsh 判斷圖片只看 `block.type === 'image'`：`llm/llm/src/content.ts:127-129`（舊註解（4edd74ab）指 `:126-128`，差一行）【核了】。nexus 另外也認 `image_url`，檔頭〈摘要輸出 fail-closed〉說那是 LangChain 的 OpenAI 形狀、語意相同。舊註解（4edd74ab）指的 `687f282e`，8bd0733 上行號相同。

## 24. 只在成功時回 usage

**照 dsh**：`summarizer.ts:172-180` @8bd0733，失敗路徑都在 return 之前就拋了【核了】。

## 25. 被拒收的摘要不重打

**一半照 dsh**。拒收是在串流跑完之後才拋（`summarizer.ts:163-165`、`:168`），串流層的重試碰不到它，這一半【核了】。但 dsh 另有一個摘要失敗的復原鉤子：`compaction/summary-error` 這個 waterfall（`region.ts:397-409`、`index.ts:466-471`）。有 listener 記下了持久的輸入變更、要求重試時，dsh 會重新準備、再摘一次；預設回 `false`，不重試【核了】。nexus 沒有這個鉤子。dsh 的 llm 層對每次串流呼叫有一層「retry, replay, routing」waterfall（`llm/llm/src/index.ts:64`），它對 `purpose: 'compaction'` 那次呼叫的實際行為【沒核到】。

## 26. 摘要那次呼叫不上線

**偏離**。dsh 直接呼叫 `ctx.llm.stream(options)`，帶 `purpose: 'compaction'`，自己用 `BlockAssembler` 組 chunk（`summarizer.ts:144`、`:160`、`:163`）。README 說它不走 agent loop 專用的 `agent/request` 擴充點（`README.md:129`）【核了】。舊註解（4edd74ab）指 `46a7f68`，沒給行號。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 另起一條不經對話串流的呼叫。 | 同一次呼叫，貼一個串流層認得的標記；摘要文字不進對話，只以 `compaction/summary` 那一顆存在。 |
| 失敗與恢復 | — | — |
| 效能 | — | — |
| 維護成本 | — | — |
| nexus 產品需求 | — | #584：摘要不是誰講的話，不該即時畫成一則 AI 訊息（`createSummarizer` 的〈生摘要的那次模型呼叫不上線〉）。 |
| 基座做不做得到 | — | `withQuietSummaryCall` 的說明：「摘要呼叫長在基座的 middleware 裡、跟主模型共用一條 callback 鏈，表達不出『另起一條不上線的呼叫』」。 |

結論：結果相同（摘要不進對話），手段受基座限制。

## 27. 生摘要用哪一顆模型

**大致照 dsh，有一格沒有對應**。dsh 的順序是 `configured ?? latest ?? agentTarget`（`summarizer.ts:127-137`，選擇在 `:137`）【核了】。`configured` 來自配置的 `summarizationProvider`／`summarizationModel`（`config.ts:102-103`；兩個要成對給，`:307-327`）【核了】。舊註解（4edd74ab）只引了 `latest ?? agentTarget`。nexus（`model-selection.ts` 的 `summaryModelOf`）用最近一次已送出的路由，讀不到就用這個 agent 換模型之前那顆，對應 `latest ?? agentTarget`。nexus 的設定 schema `summarizationConfigSchema` 只有 `trigger`、`retainRatio`、`retainTokens`、`keep`（已拿掉）、`truncateArgs`、`historyPathPrefix`、`compactionRetries`，沒有模型欄位。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 可以把摘要固定交給另一顆模型。 | 沒有這一格，摘要永遠由最近一次已送出的那顆生。 |
| 失敗與恢復 | — | — |
| 效能 | — | — |
| 維護成本 | — | — |
| nexus 產品需求 | 例如交給便宜的模型（推論，dsh 原始碼沒寫用途）。 | 理由沒查到。 |
| 基座做不做得到 | — | — |

結論：nexus 少了「指定摘要模型」這一格，理由沒查到。

## 28. 壓縮事件：`start`／`summary`／`end` 三顆加一把鎖

**偏離**（#143）。dsh 先寫 `compaction/start`，把它當持久的鎖，之後恰好嘗試一次 `compaction/end`（`region.ts:157-163`；`compaction/src/index.ts:146-147`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 未配對的 start 可以被偵測，也能擋住並行壓縮。 | 只有一顆 `compaction/summary`。 |
| 失敗與恢復 | — | — |
| 效能 | — | — |
| 維護成本 | — | — |
| nexus 產品需求 | — | — |
| 基座做不做得到 | — | 檔頭〈基座表達得出、表達不出的〉：「摘要器……在一次 `wrapModelCall` 裡生摘要、交下去，沒有『開始壓縮』這個可觀測的時刻，硬記一顆 `start` 只能記在我們的猜測上」。 |

結論：基座做不到，nexus 退成一顆事件。

## 29. 壓縮的能力 seam

**偏離**（#149、#150）。dsh 把壓縮做成 `ctx.compaction` 這個服務（`compaction/src/index.ts:119-122`），抽象面是 `compactIfNeeded`、`compactNow`、`compactRegion`（`:136`、`:162`、`:187`），有 `modelPolicies` 和載入期驗證（`config.ts:68-110`；建構時呼叫，`compaction-basic/src/index.ts:138`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 有手動壓縮、指定範圍壓縮、超窗後壓縮再重試。 | 手動與指定範圍表達不出來（#149）；超窗重試（#150）見檔頭〈基座表達得出、表達不出的〉最後一項的補充。 |
| 失敗與恢復 | — | — |
| 效能 | — | — |
| 維護成本 | — | — |
| nexus 產品需求 | — | — |
| 基座做不做得到 | — | deepagents 給的是「一個寫死的 middleware」（檔頭〈基座表達得出、表達不出的〉）。 |

結論：受基座限制，登記在 #149、#150。

## 30. 被壓的範圍怎麼表示

**偏離**。dsh 在 `compaction/summary` 事件裡記 `shadowedRange`／`shadowedSeqs`（`region.ts:491-505`），後面緊接一顆 `user/message`，帶 `surfaceOp: { op: 'replace', startSeq, endSeq }`（`:506-509`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 用 seq 蓋住一段 surface。 | 一顆 `compaction/summary`，範圍用原始訊息串的切點 `cutoffIndex` 表達，推導端據此切。 |
| 失敗與恢復 | — | — |
| 效能 | — | — |
| 維護成本 | — | — |
| nexus 產品需求 | — | — |
| 基座做不做得到 | — | 「我們沒有 surface 這一軸」（`conversation-replay.ts` 檔頭；`withCompactionLog` 的〈範圍怎麼表示〉）。 |

結論：nexus 沒有 surface 軸，退到用切點表達範圍。

## 31. 日誌不記提示詞的版本

**照 dsh**：`compaction/summary` 的欄位（`region.ts:491-505` @8bd0733）裡沒有指令或版本這一格；指令是程式碼常數（`summarizer.ts:32`）【核了】。

## 32. 量測事件與壓力投影（`context/measure`、`messagesCompactable`）

**偏離**（`withTokenBudget` 的〈取捨〉第 3、4 條）。dsh 的 `ContextPressureProjection` 只有 `pressureTokens`、`projectedTokens`、`contextWindow`：`llm/token-meter/src/projection.ts:32-50` @8bd0733（舊註解（4edd74ab）指 `5719020` 的 `:30-48`）【核了】。「切不切得出東西」只在壓縮內部問：`selectCompactableRange` 回 `null`，在 `index.ts:306`、`:355-356`、`:423`（舊註解（4edd74ab）指 `:299`／`:331`／`:394`）；在 `/compact` 的回覆「No compactable history yet.」裡講（`command-compact/src/index.ts:68`）【核了】。

| 標準 | dsh | nexus |
| --- | --- | --- |
| 正確性 | 投影是給人看的參考，不參與判斷（`token-meter/README.md:68`）。 | 一顆事件只帶量測結果，分母是摘要門檻，不是窗口（#528）；多一格 `messagesCompactable`（#1443）。 |
| 失敗與恢復 | — | `context/measure` 記不進去講一條 warn，這次呼叫照常回來（#1702，`withTokenBudget` 的〈量與記都不准拋〉）。 |
| 效能 | — | — |
| 維護成本 | — | — |
| nexus 產品需求 | — | web 的用量表讀這顆事件（#528）；`messagesCompactable` 是產品需求（#1443，〈取捨〉第 4 條）。 |
| 基座做不做得到 | — | 〈取捨〉第 3 條：「我們的日誌不記 system、工具定義與請求標頭，重建不出這份請求」。 |

結論：日誌重建不出請求，所以改記一顆量測事件；多出的那一格補的是 `messages` 門檻（§15）的誠實。

舊註解（4edd74ab）另外宣稱過兩條 dsh 事實，8bd0733 上的情形：
- 「dsh 的壓縮與 `contextPressure` 讀同一個 `measure()`，顯示與判準本來就同一個數」：不成立。README 寫壓縮讀 `measure()`、佔用率不參與任何判斷（`token-meter/README.md:68`）；`contextPressure()` 讀的是投影狀態（`token-meter/src/index.ts:122-123`）【核了】。
- 「壓力從 `request/header` 與 surface 投影」：README 寫 `contextWindow` 取自最新的 `request/context` 紀錄、`pressureTokens` 取自供應商回報的用量（`token-meter/README.md:49`）。投影的實作沒有逐行追【沒核到】。

## 33. 沒到壓力的對話絕不修剪

**照 dsh**：`compaction-basic/README.zh.md:98`「修剪只在压缩触发条件满足后运行——低于压力的对话绝不会被触碰」；程式碼在 `index.ts:342-348`，先比門檻、再 `pruneSession` @8bd0733【核了】。舊註解（4edd74ab）引的字面「低于压力的对话绝不被碰」是改寫過的，原句如上。nexus 的對應是 `isUnderCompactionPressure`。

## 34. dsh 的預設是比例形式

**事實核對**：舊註解（4edd74ab）的檔頭有一句「dsh 的預設答案（`thresholdRatio` 0.8／`retainRatio` 0.16）正是比例形式」，`config.ts:20`、`:23`【核了】。nexus 在型別層禁用 `'fraction'`，是基座的缺陷造成的（#142），跟 dsh 無關，不算偏離。

## 35. 載體：`compaction-basic` 是獨立套件

**偏離**（`summarizationPlugin`）。dsh 的 `compaction-basic` 是獨立套件，`BasicCompactionEngine` 用 `static inject = ['llm', 'tokenMeter', 'sessions']` 掛在服務上（`compaction-basic/src/index.ts:112-113`）【核了】。nexus 表達不出來的是「逐個 agent 各建一份」和「同名取代基座那顆」，理由在 `summarizationPlugin` 的說明裡，這裡不另立表。

## 36. 讀回被摘掉的原文：`history_read`、`history_search`

**dsh 沒有實作**，只有一份 proposed 的提案（`.agents/notes/proposed/feature/2026-07-06-recallable-compaction.md`，SHA `8bd0733`）。nexus 做了，定址改用 `<index>` 的條目序號而不是事件 seq。完整的比較與取捨在 [`.docs/history-recall-tools-design-2026-11-15.md`](../.docs/history-recall-tools-design-2026-11-15.md)。

---

## 沒核到的

- **dsh 壓力投影的來源是 `request/header` 加 surface**（舊註解（4edd74ab）的說法）：只讀到 README（`token-meter/README.md:49`，說 `contextWindow` 取自 `request/context`），沒有逐行追 `usage-projection.ts` 的實作。
- **dsh llm 層的重試 waterfall 對 `purpose: 'compaction'` 那次呼叫的行為**：只看到 `llm/llm/src/index.ts:64` 的說明，沒追進 `retry-policy.ts`。
- **`ctx.llm.stream` 確實經過 `adapterStream`、所以摘要呼叫也會被換成檔案 handle**：`llm/llm/src/index.ts:1103` 在 `adapterStream`（`:1068` 起）裡，但從 `stream` 到 `adapterStream` 的呼叫鏈沒逐行追。
- **nexus 這邊的幾項（不是 dsh 事實，但影響比較）**，都沒查：
  - 摘要呼叫的輸出上限（§2）
  - 換模型那一步壓不下來時的實際行為：nexus 沒有「拒絕換模型」，門檻在那一步已跟上選中那顆（#1378），但沒有實測（§5）
  - 選尾巴時是否排除開頭的 system（dsh 在 `region.ts:131` 排除；nexus 的 `retainedTailCount` 沒有對 index 0 特別處理，除了 #2086 的摘要訊息，system 是否在這串訊息裡沒查）（§10）
  - `error`／`aborted` 結束原因怎麼處理（dsh 的 `finishError` 拋 `LlmError`，`summarizer.ts:199-202`）（§23）
- **舊 SHA 上的行號**：`5badb15`、`687f282e`、`46a7f68`、`5719020` 這些 commit 在本機 clone 裡都在，但沒逐一驗證舊行號在那些 SHA 上是否成立，只對 8bd0733 核過。
