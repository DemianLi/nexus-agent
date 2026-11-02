# Jev 偏題純觀測：拍板（2026-09-25）

**來源**：一次 grilling。起點是「Jev 守門員」提案（草稿送出前平行判偏題、合規、格式，不合格就退回），事實調研見 [`jev-gatekeeper-survey.md`](jev-gatekeeper-survey.md)（PR [#614](https://github.com/DemianLi/nexus-agent/pull/614)）。

**拍板**：demian 2026-09-25 逐題回覆，全部照建議。

**對照版本**：develop `677a828`、dsh `477b4f4`。

**和 9/22 的關係**：這份是 [`decisions-2026-09-22.md`](decisions-2026-09-22.md) 的延伸，不推翻它。
- Q1（加速器）、Q5（repo 外 plugin）、Q14=C（純觀測）、§四 C（承重的重開條件）照舊有效。
- 這裡只是把同一套紀律換到新的一題「偏題」上。
- 9/22 的 `looping` 純觀測還沒動手，這份不處理它。

---

## 一、總表

守門員提案先問了四題：

| # | 題目 | 拍板 |
| --- | --- | --- |
| G1 | 擋住（關掉逐字串流，判完才給人看）還是事後補救 | **事後補救**。串流下扣不住草稿；dsh（`agent/turn-stopping`＋`steer()`）與 NeMo（`stream_first` 預設 True）預設也都是先送後判 |
| G2 | dev 還是產品 | **只放 dev**。產品路徑是內網，連不到 Jev（9/22 §一） |
| G3 | 合規檢查要不要外送 | **合規先不做**。等之後有公司規範再補；到時要重新回答外送這一題 |
| G4 | 要不要重開 §四 C、直接補救 | **不重開，先純觀測**。偏題目前連一筆標註都沒有 |

設計樹接著往下問：

| # | 題目 | 拍板 |
| --- | --- | --- |
| Q1 | 檢查哪幾項 | **只做偏題**。合規同 G3；格式大半是確定性的（字數、稱謂），要做就另開卡用程式碼判，與 Jev 無關 |
| Q2 | 判完要不要補救 | **先純觀測**：判斷只寫紀錄、不改行為。補救的形狀（`turn-stopping` 式追一步，或只在畫面加註）等證據出來再問 |
| Q3 | 判斷寫在哪 | **repo 外私有目錄的側邊檔**（偏離，見第三節） |
| Q4 | 送給 Jev 什麼（投影） | **窄投影**：需求＋最終回覆的文字（定義見第二節） |
| Q5 | 判哪些回覆 | **只判 root** 每一輪最後那則沒有工具呼叫的回覆。子代理不判。截斷的回覆照判，但要標記 |
| Q6 | 題目的選項 | **A／B／C／D 四個**，逐字見第二節。D 是「無法判斷」，吸收窄投影看不到前文的代價，不讓它變成假的 C |
| Q7 | 資料怎麼累積、何時帶回來 | **自然使用累積**，不另外造題。停止條件見第二節 |
| Q8 | 動手 | **三件都做**：repo 外寫 plugin 掛進 demian 的 dev 設定；dev 對話外送 TypeSafe；寫這份決議 |

不另外問、照慣例定的兩條：
- Jev 在一輪收尾之後非同步跑，不擋這一輪。
- Jev 失敗或逾時就記一筆，不重試。

---

## 二、逐字記錄（改了任何一樣都要重新對照正解）

9/22 §3.3 的硬規則照舊有效：**投影函式或措辭改動之後，必須重新對照正解，不能靠信心值監控。**

### 投影

- **需求**：
  - 人的那一輪，用 `turn/start {kind:'message'}` 的 `text`。
  - goal 自主輪，用那個 `goalId` 最新一筆 `goal/change` 的 `objective`；找不到才退回 `turn/start` 的 `text`，並標成 `goal-text`。
  - `resume` 輪沿用上一個需求。
- **回覆**：這一輪最後一則 `assistant/message` 的文字。
  - `content` 是字串就直接用；是陣列就只取 `type: 'text'` 的 block，推理和其他 block 都不送。
  - 工具呼叫、對話歷史都不送。
- **截短**：需求 4,000 字，回覆 20,000 字。截過的要在紀錄裡標出來。依據是每請求 64k、state 加最長那一題 32k。
- **形狀**：`state: { request, reply }`，`model: 'jev-latest'`。

### 題目（`choice`，id `offtopic`）

- **instructions**：「reply」有沒有回應「request」？只根據這兩段文字判斷。
- **A**：回應了需求的核心，也沒有違反需求裡明說的限制
- **B**：方向對，但漏掉或違反了需求裡明說的某個限制
- **C**：沒有回應需求：答非所問、做了別的事、或只講了無關的內容
- **D**：無法判斷：需求要靠前文才看得懂（例如「照上面那樣改」「繼續」）

### 不判的情況（記成 `skip`）

- 中止的輪（`turn/end` 的 reason 是 `aborted`）。
- 停在核准點的輪（有 `interrupt/raised`）。
- 沒有需求、沒有回覆。
- 最後一則還帶著工具呼叫。
- 文字是空的，例如只有推理。
- 沒有 `JEV_API_KEY`。這一格要記下來：`.env` 只在 shell 沒有模型金鑰時才會被載入，缺了就會一筆都判不到，卻沒有任何報錯。

### 標註與停止條件

- **標註**：逐筆和會話日誌對上。demian 手檢所有判成 B、C 的，A 抽一成來看。
- **帶回來重開 §四 C 的條件**：累積到 **5 個手檢確認的 B/C 正例**，而且來自**至少兩顆主模型**。
- **期限**：滿兩週還不到，就照實回報數字，由 demian 決定延長或收掉。
- 正例要來自**沒被設計過**的情境（9/22 §四 C），所以刻意設計的跑法（live 驗證、量測腳本）要能從紀錄裡分出來。

---

## 三、偏離登記

以下三筆對照的都是 dsh `477b4f4`。

### 偏離一：判斷寫側邊檔，不寫會話日誌

- **dsh 怎麼做**：plugin 用 `declare module` 擴充 `SessionEventMap`，自己宣告事件種類。例如 `hook/invoked`、`hook/result`，見 `packages/hooks/hook-protocol/src/types.ts:8`，寫入點在 `src/events.ts:76`。
- **我們這邊**：`SessionEventType` 是 `packages/nexus-core/src/session-log.ts` 寫死的封閉聯集，telemetry 註冊點也只能掛脫敏規則。所以 repo 外的 plugin 沒有地方寫自己的事件。
- **這一筆不是「表達不出來」**。改核心、開一條同 dsh 的擴充點就做得到。**是刻意選擇**，理由有二：
  - Q5 要 repo 零足跡。
  - 目前只有這一個消費者。攔截索引第 3 格說過：「一個消費者不撐起一條通道」。
- **退到什麼**：`$NEXUS_AGENT_HOME/jev-offtopic/verdicts.jsonl`，目錄 0700、檔案 0600，一行一筆。
  - 不存原文，靠 `sessionId`、`logStartTime`、`turnEndSeq` 回會話日誌對。CLI 的 `sessionId` 固定是 `cli`，所以要用 `logStartTime` 對到 `sessions/<啟動時戳>-…` 那個 run 目錄。
  - 代價：web 與重播都看不到這些判斷。
- **重開條件**：要做補救，或者判斷要進畫面時，照 dsh 開擴充點。那時也才會有第二個消費者。

### 偏離二：時刻在 `turn/end` 之後、非同步

- **dsh 怎麼做**：`agent/turn-stopping` 在邊界提交之前派發，而且會被等（`packages/core/agent-loop/src/agent.ts:342-346`，模式 `serial`）。聽者可以 `steer()` 讓這一輪再跑一步。
- **我們這邊**：`turn-stopping` 只佔了一半，`steer()` 沒有等價物（`apps/harness/src/interception-index.test.ts` 第 3 格）。
- **這一筆也是刻意選擇**。純觀測不改結果，所以不需要擋在邊界前面；擋的話，每一輪都要多等一次 Jev。
- **退到什麼**：會話參與者（`registry.sessions.join`）觀察 `turn/end`，之後才非同步呼叫。
- **重開條件**：同偏離一。要補救的時候，要換到邊界之前、而且會被等的掛點。

### 偏離三：純觀測本身

- 同 9/22 §四 D 的偏離二，已登記在 PR [#534](https://github.com/DemianLi/nexus-agent/pull/534)。
- 這裡把它套到新的一題上，理由不變：我們對 Jev 判偏題的品質，一個數字都還沒有。

---

## 四、實作與驗證狀態

- **載體**：repo 外的一個 `.ts` 檔，用 patch `insert` 掛進去（`docs/operations.md`〈plugin 清單〉）。
  - repo 裡零筆 Jev 程式碼。
  - 這個檔執行期不能 import 任何裸 specifier：它在 repo 外，裸 specifier 錨在 importer，找不到 `@nexus/core`。所以型別和判斷都自己寫了一份窄的。
- **已驗證**：CLI 產品路徑，接假 Jev 端點與假模型，共五格。
  - 帶兩次工具呼叫的一輪，只判最後一則。
  - `--resume` 接回既有 run，不重判歷史輪。
  - 端點回 500，只記一筆，這一輪照常結束。
  - 沒有金鑰，記 `skip: no-key`。
  - 端點不回應時，關機最多等 5 秒，並記下錯誤。
- **還沒驗證**：
  - 真模型加真 Jev 的 live。
  - 會派子代理的一輪（子代理那一側零筆）。
  - serve／web 那條路徑。
  - 這三格都要外送，等 demian 執行或授權。
- **還沒決定**：掛進 `~/.nexus-agent/cordis.patch.yml` 之後，**demian 名下每一次 harness 啟動都會載入**，其他 session（dev-ui、dev-harness）的 serve 與 live 驗證也包括在內，它們的對話也會外送。
  - 那些是設計出來的跑法，會污染第二節的正例來源。
  - 紀錄裡有 `origin.cwd`，分得出是哪個 worktree 跑的，但擋不住外送本身。
