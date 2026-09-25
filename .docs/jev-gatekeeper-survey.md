# Jev 守門員調研（2026-09-25）

**提案**：主模型寫完草稿後先不交給使用者，平行送 Jev 做三個檢查（偏題 `choice`、合規 `noul`、格式 `score`），再由閘門放行、退回重寫，或改送罐頭回應。

**對照版本**：nexus-agent develop `7e5260e`、dsh `477b4f4`（2026-09-24，等於上游 HEAD）、NeMo Guardrails `71487ba`。

**寫法**：每條宣稱都附來源；標「推論」的是推論。沒有打 Jev 或任何模型 API。

---

## 摘要

1. **「先不交給使用者」在串流下做不到，dsh 和 NeMo 預設也都不這樣做。** 草稿是逐字串給畫面的，閘門跑的時候使用者已經看完了。要真的扣住，就得關掉逐字串流，首個可見輸出會從「第一個字」退到「整篇寫完＋Jev」，差的是整段生成時間（數秒到數分鐘），不是幾百 ms。
2. **dsh 有「回覆收尾前評估、不合格就再跑一步」的掛點**：`agent/turn-stopping` 加 `agent.steer()`。它是事後補救，文字已經送出去了。dsh 出廠沒有任何東西拿它做內容審查，只有選配的 hooks 橋接（Claude Code 的 `Stop` hook）用它，而且那個橋接沒有連續阻擋上限。
3. **我們這邊 `turn-stopping` 只佔了一半**：`steer()` 沒有等價物，輪迴圈歸入口點所有（攔截索引第 3 格）。同一輪內「再跑一步」最接近的是 LangChain `afterModel` 的 `jumpTo: 'model'`，產品程式碼沒用過。
4. **Jev 的題型事實**：`noul` 回一個 0–1 的機率純量，沒有 `confidence` 欄。所以提案寫的「True 且信心 > 0.8」要改寫成「`noul` ≥ 0.8」。`choice` 與 `score` 有 `confidence` 和 `probabilities`；`score` 的級別是 2–10 個，不固定 0–5。
5. **和既有拍板的主要衝突**：內網部署下產品路徑到不了 Jev（§一）；拍板是純觀測，這個提案要承重（Q14=C、§四 C 的重開條件還沒成立）；合規檢查本身要把草稿和合規手冊送到美西的外部供應商。
6. **三個檢查裡最實際的是格式**，但它大半是確定性的，用程式碼判就好（字數、開頭稱謂），用不到 Jev。

## 需要 demian 拍板的題目

1. **目標是「擋住」還是「事後補救」？** 擋住就要關掉逐字串流，體驗退很多；事後補救就是 dsh `turn-stopping` 的形狀：文字已顯示，再追一步修正或加註。
2. **射程是 dev 還是產品？** 產品路徑到不了 Jev（§一），想進產品就得換一顆內網能跑的判斷模型，那已經不是 Jev 的題目。只放 dev 的話，誰是使用者、要擋什麼？
3. **合規檢查要不要外送？** 草稿加合規手冊送到 TypeSafe（美西），本身可能就違反合規。
4. **要重開 §四 C 嗎？** 承重需要證據：正例來自沒被設計過的情境，而且跨一顆以上的模型。偏題與合規目前連標註資料都沒有。

---

## 一、Jev API 事實

來源：<https://docs.typesafe.ai/api.md>（2026-09-25 讀取）

| 題型 | 請求 | 回應 |
|---|---|---|
| `noul` | `instructions`（必填），`criteria.true`／`criteria.false`（選填） | `noul`：0–1 的數（0＝否、1＝是）；**沒有 `confidence`** |
| `choice` | `instructions`，`criteria`：選項→說明（必填，最多 255 個） | `choice`（最高機率的選項）、`probabilities`（和為 1）、`confidence`（0–1，由分佈導出） |
| `score` | `instructions`，`criteria`：2–10 個級別（必填） | `score`（按機率加權，可以落在級別之間）、`legend`、`probabilities`、`confidence` |

- **「平行」是一次請求就做到的**：決議檔 §一寫著一份 `state` 送一次，所有 `questions` 平行判。所以三個檢查是一次請求帶三題，延遲是一次來回，不是三次取最大值。
- **上限**：每請求 64k，其中 state 加最長那一題 32k（決議檔 §一）。合規檢查要把公司合規手冊塞進去，手冊大小可能直接撞上限。
- **API 文件沒寫**資料保留、隱私、區域、延遲、輸入上限。以下數字來自 `.docs/decisions-2026-09-22.md` §一：64k tokens/請求、$0.042/M 輸入、70–500ms。我們在 §七自己量到中位 310–380ms、p90 約 410ms，其中網路來回約 270ms。
- 「只有美西端點、沒有 on-prem」同樣出自決議檔 §一。
- `.docs/decisions-2026-09-22.md` §六 引 TypeSafe 自己的說法：**信心不是 P(正確)**，門檻要在自己的資料上測。

## 二、dsh 有沒有這種東西

### 2.1 有的：收尾前的掛點 `agent/turn-stopping`

- **定義**：`packages/core/agent/src/runtime-types.ts:363-381`（`477b4f4`）。
  - 觸發時機是「這一輪要收了：模型不欠回應（沒有進行中的工具呼叫、沒有新的 steering）」，在邊界提交之前會等它跑完。
  - 聽者如果有意見，就呼叫 `agent.steer(...)`，機器重讀 inbox；有新的 steering 就再跑一步。
  - 模式是 `serial`。
- **派發處**：`packages/core/agent-loop/src/agent.ts:342-346`，每一步結束、確定要收、而且 inbox 是空的時候。
- **使用者**：
  - `deliverables/workspace-changes/src/index.ts:153`：收尾時記錄工作區變更，不 steer。
  - `hooks/hooks-claude-code/src/index.ts:276` 與 `hooks/hooks-codex/src/index.ts:266`：把 Claude Code／Codex 的 `Stop` hook 橋過來，阻擋就等於「強迫再跑一步」（`hooks-claude-code/README.md:62`、`:87`）。
    - 限制（`README.md:180`）：payload **不帶 `last_assistant_message`**，也**沒有連續阻擋上限**，無條件阻擋的 hook 會每一步都強迫續行，除非自己設限。
- **出廠狀態**：整個 `packages/` 裡，除了 `packages/hooks/` 自己，沒有任何 `package.json` 相依這兩個橋接。這個範圍涵蓋 `bundle/`（base、sdk-minimal、headless、sdk-app、web-app、acp-app）、`preset/`、`interaction/permission-presets`、`client/ui-*preset*`。所以它們是選配。`packages.md:242-243` 的「yes」指的是有設定檔，不代表出廠啟用。

### 2.2 有的：模型串流的 waterfall `llm/stream`

- 定義在 `packages/llm/llm/src/index.ts:63-75`：包住每一次串流模型呼叫，可以 `next()`，也可以自己 yield chunk 來短路。
- 但 agent loop 送出的請求是 deep-frozen 的，**只能讀、不能改**。
- 產品程式碼只有兩個 invariant 用它：`llm/src/invariant.ts:88`、`agent-loop/src/invariant.ts:21`。其餘都是測試替身與 replay。
- 推論：理論上可以在這裡扣住 chunk，等判完再放，但 dsh 沒有任何東西這樣用。

### 2.3 沒有的

- 出廠路徑上沒有任何「內容審查／護欄」外掛。
- `auto-review` 是 `tools/pre-execute` 的**工具授權**，不看最終文字，而且不在任何 bundle 或 preset 裡（決議檔 §四 D）。
- 沒有「扣住草稿、判完才顯示」的機制：`agent/assistant-stream` 是 `emit`，chunk 直接發布出去（`runtime-types.ts:354-363`）。

**所以依規則分類**：「生成後評估、再跑一步」這個形狀，**dsh 有機制**（`turn-stopping`＋`steer`）。「用判斷模型審內容」是**標準不做**。這兩點不是「表達不出來」。「扣住不顯示」則是 **dsh 和 NeMo 的預設都不做**（見六）。

## 三、我們的架構：草稿在哪、閘門能掛哪

- **web**：v3 streamEvents 的 `content-block-delta` 由 pump 即時轉發（`apps/harness/src/thread-pump.ts` 的 `#translate`）。逐字片段不經過 token 回呼，模型層的 middleware 收不到半段（記憶：v3-stream-deltas-skip-token-callbacks）。
  - **推論**：任何 middleware 判完的時候，畫面上已經有整篇了。
- **CLI**：走非串流 `_generate`，拿到整則回覆後才印。這條路「先判再印」在結構上做得到。
- **可用的掛點**：
  - `wrapModelCall`：可以在拿到完整回應後改寫或重叫。先例是 `packages/nexus-core/src/max-tokens.ts`，拿到回應後清掉工具呼叫。
  - `afterModel`／`afterAgent` 帶 `canJumpTo: ['model']`：可以注入回饋再跑一步。兩個鉤子型別上都有 `canJumpTo`（`langchain@1.5.10` `dist/agents/middleware/types.d.ts:202`、`:220`）。LangChain `JUMP_TO_TARGETS = ["model","tools","end"]`（`langchain@1.5.10` `dist/agents/constants.d.ts`）。產品程式碼只量過 `'end'`（`apps/harness/src/interception-index.test.ts:79-81`，#192），**`'model'` 沒用過**。
- **我們的 `turn-stopping`**：攔截索引第 3 格（`interception-index.test.ts:169-177`）記著「**只佔了一半**：`agent.steer()` 沒有等價物，輪迴圈歸入口點所有」。唯一的佔用者是 `goal-driver.ts`，它在**兩輪之間**排下一輪，不在同一輪內。
- **「草稿」的定義**：沒有 tool_calls 的 root AI 訊息。以下幾種都要另外決定算不算：
  - 帶工具呼叫的中間訊息。
  - 子代理的回覆：它經 `task` 回到父代理，不直接給使用者。
  - 被截斷的回覆（#433 剛落地，`turn/end` 是 `max-tokens`）。
- **重寫迴圈的上限**：dsh 的 hooks 橋接明寫沒有連續阻擋上限（2.1）。我們要做的話得自己設，否則誤報會變成無限續行。

## 四、三個檢查各自的可行性

- **偏題（`choice` A/B/C）**：
  - 要有標註題組，而且沒有現成的。
  - 9/22 的量測是 looping／completion 四題，不是偏題。
  - B「部分對齊、漏了限制」和 A 的邊界靠 `criteria` 的措辭；`probabilities` 能不能把它們分開，沒量過。
- **合規（`noul`）**：
  - 門檻寫成 `noul ≥ 0.8`。
  - 硬阻斷的誤報落在昂貴的那一邊：正常回答被換成罐頭回應。決議檔 7.5 的建議正好相反：「誤觸發只能換到一句提醒，不能打斷一輪」。
  - 9/25 量到最嚴的門檻（0.9）也會在正常的輪上觸發（信心 0.93，5 輪裡 1 輪，決議檔 §七 7.2）。那是另一題（單輪打轉），但同一個教訓：高信心不等於不誤報。那一題用的是哪種題型，這份報告沒有核；如果是 `noul`，0.93 就是和 `noul ≥ 0.8` 同一個量。
  - 手冊大小受每請求 64k 的上限約束（見一）。
  - 外送面見五。
- **格式（`score`）**：
  - 提案舉的例子大多是確定性的：字數、開頭稱謂、有沒有 try/catch。程式碼判就好，零誤報、零外送、零延遲。
  - 只有「結構完整度」這種模糊判準才輪得到 Jev，而且要先定義分數怎麼對到放行、退回或阻斷。

## 五、和既有拍板的衝突（出處都在 `.docs/decisions-2026-09-22.md`）

| 拍板 | 內容 | 提案 | 衝突 |
|---|---|---|---|
| §一 | 內網、Jev 只有美西端點、出貨版本不含 | 閘門放在回覆路徑上 | 產品路徑上跑不起來 |
| Q1 | 加速器，拔掉不會紅 | 閘門承重 | 拔掉就少一道把關，不再是「不會紅」 |
| Q14=C／Q16=A | 純觀測，`decideGoalRound` 行為零變化 | 攔截、退回、罐頭回應 | 要改行為 |
| §四 C | 承重要等正例來自沒被設計過的情境，而且跨一顆以上的模型 | 直接上閘門 | 條件沒成立，偏題與合規連資料都沒有 |
| §六 | 外送面：dev 下多了 NVIDIA＋TypeSafe 兩個接收方 | 送草稿＋合規手冊 | 合規檢查本身在外送 |
| §六 | 供應商：一週大、閉源、單一供應商、早期存取 | 硬阻斷依賴它 | 停服時閘門要 fail open 還是 fail closed？ |
| §七 7.5（建議） | 不擋在首可見前面；誤報要落在便宜的那一邊 | 擋在首可見前面；硬阻斷 | 兩條都反 |

Q5「repo 外 plugin」本身不衝突，載體照樣可以用。

## 六、業界一手參考

- **NVIDIA NeMo Guardrails**（`nemoguardrails/rails/llm/config.py:374-390`，`71487ba`）：
  - 串流下的 output rails 以 chunk 為單位檢查：`chunk_size` 預設 200 token，`context_size` 預設 50，前一塊帶過來當上下文。
  - `stream_first` **預設 True**，原文是 "token chunks are streamed immediately before output rails are applied"，也就是**先送出去、再檢查**。
  - 會改寫回應的 rail 不允許和 `stream_first: True` 一起設（`config.py:1131-1171`）。
  - output rail 本身也常用 LLM 自我檢查（`library/self_check/output_check/`）或 Llama Guard（`library/llama_guard/`）。
- **Llama Guard**（<https://arxiv.org/abs/2312.06674>）：分類模型，吃「提示＋回覆」、吐安全類別，能用在生成前或生成後；本身不改寫回覆。

推論：業界預設的形狀和 dsh 一樣是「串流照送，檢查追在後面」。想先擋再送，就得付出關掉串流的代價，而 NeMo 把這個選項留給使用者自己設。

## 七、若要推進，要先量什麼

1. **先拍板上面四題**。答案不同，要量的東西完全不同。
2. **標註題組**：偏題與合規各要有正例和反例，正例不能是自己設計出來的（§四 C），而且要跨模型。
3. **門檻校準**：`noul`、`choice`、`score` 在自己的資料上算誤報和漏報，判準要分「行為」和「延遲」兩欄（記憶：jev-landing-needs-approval）。
4. **掛點實測**：`afterModel` 的 `jumpTo: 'model'` 在我們的組裝上走不走得通，子代理蓋不蓋得到（決議檔 §五提過 general-purpose 不經 fold）。
5. **延遲**：若選「擋住」，要量關掉串流之後首可見輸出的中位與 p90。**能不能從現有日誌推算要先確認**：預設落盤是 #607 才落地的（`487bffa`，#613 又讓部署設定關得掉），9/25 之前的日誌多半沒有；而且 `assistant/message` 是整則寫完才 append，日誌裡不一定有首字的時間。9/23～25 的首可見數字是量測裝置量的，不是從產品日誌讀出來的。

每一步都有外送或 repo 足跡，**動手前都要 demian 核可**。

---

## 附：對代理原稿的更正

以下是原稿有、這份拿掉或改掉的：

- 「dsh 沒有生成後評估的迴圈」：錯。有 `agent/turn-stopping`＋`steer()`。
- 「關掉串流會多 400ms」：錯。多的是整段生成時間，400ms 是 Jev 自己的延遲。
- 「`wrapModelCall` 在模型呼叫前攔截」：錯。它包住整次呼叫，拿得到回應。
- 「NeMo 的規則用 DSL、不經 LLM 判」：錯。self-check output 就是用 LLM 判；而且串流預設是先送後判。
- 「`content-block-delta` 是 dsh 的事件」：錯。那是 LangChain v3 的。
- 「0.8 門檻可能有 20%+ 誤報」「題組至少 50 輪」：原稿自己編的數字，已刪。
- 「Q12 的 500ms 閘門」被拿來套這個提案：那是加速題的閘門，這個提案的目標是品質，不適用。
- 「要改 dsh 上游」「Q5 plugin 有足跡」：不成立，已刪。
