# 會話日誌的持久化保證：dsh 與 nexus 對照（#1158）

**狀態：調研結論，沒有任何程式碼改動，也沒有決議。** 回答 [#1158](https://github.com/DemianLi/nexus-agent/issues/1158)：事件契約草稿（[`event-contract-design-draft-2026-10-08.md`](event-contract-design-draft-2026-10-08.md) §八 第 3 題）採納「以會話日誌為唯一真相」的方向後，S2 之前要先查清日誌的持久化保證。

**對讀版本**：nexus develop `d5dda583`；dsh `5badb15009a`（`references/deepseek-harness`）。
**讀法**：全部是讀原始碼，**沒有跑任何東西**，沒有殺過行程、斷過電。凡是「保證」都是程式碼與註解寫的，不是量到的。

## 一句話結論

**退回條件沒有觸發。** 草稿記載的退回條件是「持久化保證比我們現在弱得多」，實際情況相反：nexus 已經照 dsh 搬了同一個形狀（寫回窗口、耐久檢查點、續接補收尾、跨行程寫租約，見 #172、#599、#251、#721），和 dsh 的差別都在細節上，沒有一項會擋住「日誌為唯一真相」。**持久化不是 D1 的門檻，門檻是日誌裡有沒有模型實際看到的所有東西**（見 §五，那是 #1159 的題目）。

## 一、dsh 的保證

來源：`packages/session/session-persistence-jsonl/src/{storage,index}.ts`、`packages/session/session-checkpoint-policy/src/index.ts`、`packages/session/session-persistence/README.md`、`packages/bundle/base/cordis.patch.yml`。

| 面向 | dsh 的做法 |
| --- | --- |
| 寫回窗口 | 第一顆待處理事件開窗，**最長 200 ms**（`storage.ts:36` `LIVE_WRITE_BATCH_MAX_DELAY_MS`），後續事件加入不重置截止時間 |
| 每批落盤 | 每一批 `appendLines` 都 **write 之後 `handle.sync()`**（`index.ts:1324-1352`）；失敗時截回原大小再拋，避免殘留半批造成重複 seq |
| 建立檔案 | 暫存檔寫入並 fsync，再用 `link()` 發布（檔案已存在就失敗，不會被覆寫），之後 fsync 目錄（`index.ts:1195-1235`） |
| 完整性 | 預設存成帶 checksum 的連續 Zstandard frame（也可配置成原始行）；讀方不會看到撕裂的尾巴 |
| 尾巴修復 | 開寫入把手時，物理上不完整的最後一段被截掉並 fsync（`index.ts:1365`）；語意修復歸 agent 層（`interruptedTurnClosers`） |
| 耐久檢查點 | 獨立插件 `session-checkpoint-policy`，三處排空：**模型請求建起之前**（`llm/stream`）、**頂層工具本體跑之前**（`tools/execute`）、**每步開始前**（`agent/pre-step`）。排空失敗時下游不動手（fail-closed） |
| 出廠 | `base` bundle 掛了這個插件（`cordis.patch.yml:413`）；README 明說只掛後端不掛它「合法但較弱」 |
| 寫入失敗 | 背景寫入被拒：按序保留事件、暫停自動路徑、記 log；下一次顯式 flush 重試並**響亮地拒絕** |
| 單寫者 | 同行程內單一寫入把手；跨行程由租約擋 |

**dsh 自己承認的缺口**（checkpoint-policy README「Known Limitations」）：
- 模型串流進行中沒有檢查點，硬當機會丟掉還沒落成 `assistant/message`／`assistant/attempt` 的暫態片段。
- 已記錄的工具呼叫只是「已派出」的意圖，不保證外部效果有沒有發生；重啟後記成「結果未知」，不自動重試。

## 二、nexus 的保證

來源：`packages/nexus-core/src/{session-persistence,session-checkpoint-policy,interrupted-turn,conversation-replay}.ts`、`apps/harness/src/{jsonl-session-store,session-lease}.ts`。

| 面向 | nexus 的做法 |
| --- | --- |
| 寫回窗口 | **10 ms**（`session-persistence.ts:45` `DEFAULT_PERSISTENCE_WINDOW_MS`），規則同 dsh：第一顆開窗、後續不重置 |
| 每批落盤 | 窗口到期後 `append` 只做 `handle.write`（`jsonl-session-store.ts:258`），**不 sync**。`datasync` 只在兩處：`flush()`（`:267`）與 `close()`（`:278`） |
| 建立檔案 | 先 `writeFile` 寫 header（`wx`），再 `open(..., 'wx')` 開日誌（`:324`、`:327`）；**沒有暫存檔、沒有 fsync、沒有目錄 fsync** |
| 完整性 | 原始 JSONL 行，**沒有 checksum**；撕裂的最後一行由讀方辨認，續接時 `truncate` 掉（`:344`）；中段損毀靠 JSON 解析失敗報 `SessionCorruptionError` |
| 耐久檢查點 | `session-checkpoint-policy.ts`：照 dsh 的三個點，併成兩個掛點（一顆 `wrapModelCall` 涵蓋「請求前」與「每步前」，一顆 `wrapToolCall`）。每次檢查點呼叫 `flush()`，也就是**走到 `datasync`** |
| 出廠 | 註冊表上的條目，可被 disabled；**關掉之後日誌只在窗口到期與收尾時落地**，收尾被打斷時可能丟整輪（`session-checkpoint-policy.ts` 檔頭），且沒有測試會因此變紅 |
| 寫入失敗 | 同 dsh：按序保留、暫停自動路徑、warn；**只有 `flush()` 響亮拒絕**（`session-persistence.ts` 檔頭有完整理由） |
| 收尾 | `dispose()` 會 flush 再 close，且**刻意讓失敗往外拒絕**，不吞 |
| 續接 | 拿跨行程寫租約（kernel `flock`，用 dsh 的原生模組）、截撕裂尾巴、`interruptedTurnClosers` 補收尾後寫回（#721） |

## 三、逐項對照

| 項目 | dsh | nexus | 差距的意義 |
| --- | --- | --- | --- |
| 窗口 | 200 ms | 10 ms | nexus 更緊，行程被殺時窗口內的事件較少 |
| 窗口內事件在行程被殺時 | 丟 | 丟 | 兩邊都在記憶體裡，一樣 |
| 窗口到期之後、行程被殺 | 已 fsync，在 | 已交給核心（`write`），**在**；行程死不影響核心頁快取 | 一樣 |
| 窗口到期之後、**斷電或核心當機** | 已 fsync，在 | 只保證到上一次檢查點的 `datasync`；之後寫的可能丟 | nexus 較弱，但範圍受檢查點限制（見 §四） |
| 新會話第一次建檔、斷電 | 暫存＋fsync＋目錄 fsync，**在或根本不存在** | 無 fsync，**檔案或 header 可能整個不見，或只有 header** | nexus 較弱；影響是「最新一條 thread 不見」，不是壞檔 |
| 位元腐蝕／中段損毀 | checksum 能偵測 | 只能靠 JSON 解析 | nexus 較弱；本機檔案在企業環境屬低機率 |
| 模型請求前的檢查點 | 有 | 有 | 一樣 |
| 摘要那次模型呼叫前 | 有（走 `llm/stream`） | **沒有**（摘要器直接 `invoke`，不經 middleware） | 已登記的偏離（`session-checkpoint-policy.ts` 檔頭 §偏離 2）；緊接的主呼叫會把它一起排空 |
| 失敗語意 | fail-closed、響亮拒絕 | 同 | 一樣 |
| 跨行程寫租約 | 有（含 Windows） | 有（macOS／Linux），**Windows 沒有**，拿不到就照常寫並講一聲 | 內網伺服器環境若為 Linux 無差；Windows 部署才有 |
| 串流中的暫態 | 丟，且 dsh 承認 | 同 | 一樣 |

## 四、行程被殺與斷電時，最多丟什麼

**行程被殺（`kill -9`、OOM、當機）**：
- dsh：丟窗口內（最長 200 ms）還沒寫出去的事件，加上進行中的串流片段。
- nexus：丟窗口內（最長 10 ms）的事件，加上進行中的串流片段。
- 兩邊在檢查點之後的事件都已交給核心。重啟後 `interruptedTurnClosers` 把開著的輪補成「中斷」，已記錄但沒結果的工具呼叫變成「結果未知」。

**斷電或核心當機**：
- dsh：最多丟最後一批 fsync 之後的事件（≤ 200 ms 窗口加一次寫入）。
- nexus：最多丟**上一個檢查點之後**寫入的事件。檢查點在每次模型呼叫前與每次工具呼叫前，所以實務上是「最後一步的尾巴」；**但若一個工具跑很久，期間寫入的事件在下一個檢查點之前都沒有 sync**。這一項是我讀程式推出來的，沒有量。

## 五、對「日誌為唯一真相」的意義

1. **持久化這一側不擋路。** 契約需要的三個性質——事件按序、崩潰後尾巴可被辨認並補收尾、寫入失敗不靜默——nexus 都已具備，且補收尾已經寫回日誌（#721）。
2. **nexus 與 dsh 的差距若要補，是獨立的小卡，不是 D1 的前提。** 候選（都未開票、未排期）：
   - 建立檔案的原子發布與目錄 fsync。
   - 每批 `append` 之後 sync，或至少讓「長工具期間」有週期性 sync。
   - 日誌 checksum。
   這三項都和「歷史由日誌推導」無關，先不排。
3. **真正的門檻是「日誌裡有沒有模型實際看到的所有東西」**，這是 #1159 的題目。補這份調研時有一個順帶發現，對 #1159 很有用：
   - `packages/nexus-core/src/conversation-replay.ts` **已經在續接時從日誌推回模型的對話歷史**，灌回 LangGraph state（#306）。也就是說「日誌→歷史」的推導函式今天已經存在，只是只在續接時用。
   - 它的檔頭已經記了推出來的歷史和 graph state **不是自然對齊**的三處：併發工具結果的順序（日誌依落定先後，state 依 `tool_calls` 順序）、壓縮的切點（對不上就整串不灌）、80,000 字元以上的工具結果（模型看到的是基座換過的預覽，要由呼叫端傳 `toolResultAsSeen`）。
   - 因此 #1159 不必從零開始：可以先拿這個函式的輸出去和實際送出的請求逐位元組比，從它已知的三處差異往外找。

## 六、這份調研沒有回答的

- **沒有任何實測**。`apps/harness/src/session-log-durability.test.ts` 我只看了測試名稱，內容是路徑、撞名、拒絕、不認得的事件種類；對它和 `session-resume.test.ts` 搜 `kill`、`SIGKILL`、`crash`、`fork(` 都沒有命中，所以**這兩個檔沒有「殺行程後重啟」的測試**；別處有沒有，沒查。
- **nexus 檢查點是否真的在每個該排空的點都有掛到**，我讀了檔頭與掛點名稱，沒有逐路徑（子代理、核准暫停、目標續行）驗證。
- **dsh 的 SQLite 後端**沒讀；dsh 預設與出廠用的是 JSONL。
- **nexus 程式碼註解引用的 dsh SHA 是舊的**（`c291e79`、`477b4f4`、`d347e703`），這份對照用的是 `5badb15009a`。我沒有逐條核對這些 SHA 之間 dsh 的持久化是否改過，只知道目前 HEAD 的樣子。
- **Windows 部署**沒評估。
