# 會話事件序號調研 —— 給 #89 的前置決定

[#89](https://github.com/DemianLi/nexus-agent/issues/89) 卡在一個必須先定的決定上：**遙測的事件
從哪來、序號誰發**。這份筆記只服務那一個決定，不談 telemetry 之後的實作。

**調研日期**：2026-08-29。

## 這份筆記的來源與可信度

第一版由子代理產出，**dsh 與 nexus 那兩半是它讀的，外部五個專案它沒做**（它自己在草稿裡寫了
「待驗，暫記為未讀」，但同一份草稿的入選表卻用肯定句寫死了誰有誰沒有事件日誌 —— 那張表沒有
來源，已整張丟掉）。外部那一半是後來重讀第一手原始碼補的。

**子代理宣稱的核對結果**（逐條回去看原始碼）：

| 宣稱 | 結果 |
| --- | --- |
| dsh `seq = log.length`，per-session 單調遞增 | ✅ 成立 |
| nexus 的 CLI 路繞開 ThreadPump、硬編 thread id | ✅ 成立 |
| pump 在 **reconnect** 時被重建、seq 從 0 重來 | ❌ **不成立** —— `pumpFor` 會重用既有的 pump |
| `threads` map「無顯式清理邏輯」 | ⚠️ 不精確 —— `close()` 有 `threads.clear()`，缺的是**單筆逐出** |

**版本**：dsh 讀的是 clone 當下的 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，
而 #89 內文記的對讀版本是 `cd5ef8148158c3a752a658978873241fdf8e2bbc`。**兩版沒有對diff**，
這份筆記的 dsh 引用只對 `b150a551` 成立。

外部專案是 2026-08-29 從各自預設分支的 raw 檔讀的，**引用時沒有釘 SHA**（讀的是移動中的
branch）。當下的 HEAD 記在下面的對照表裡，之後要複查請用那組 SHA。

## dsh 怎麼做的

**序號出自日誌自己的長度，不出自任何傳輸層。**

| 事實 | 位置 |
| --- | --- |
| `seq: this.log.length` —— append 時就地決定 | `packages/core/session/src/index.ts:629` |
| 持久化有 jsonl 與 sqlite 兩套 | `packages/session/session-persistence-{jsonl,sqlite}/` |
| 儲存層的不變量：`next.seq !== previous.seq + 1` 就拒收 | `packages/session/session-persistence-sqlite/src/codec.ts:93` |
| 壓縮後的列還記得來源事件的 seq 集合（`source_event_seqs`） | `.../src/schema.ts:43` |

遙測那一層**鏡像**它：

| 事實 | 位置 |
| --- | --- |
| `channel: 'ledger' \| 'ops'` | `packages/session/session-telemetry/src/index.ts:66` |
| ledger 記錄帶 `session.id`、`event.type`、`event.seq` | `.../src/index.ts:73` |
| **ops 記錄刻意省略 `event.seq` 這類識別**，免得被誤認成 ledger 列 | `.../src/index.ts:61-62` |
| handoff 游標是**拿 seq 比大小**的：`if (event.seq <= cursor) this.track(...)`、`if (throughSeq !== undefined && event.seq > throughSeq) break` | `.../src/coordinator.ts:143-145` |

**最後那一條是這份調研的重點。** 游標是 seq 的**數值比較**，不是集合成員判定。所以一個會
從 0 重來的 seq 不只是「重複」—— 它會讓游標**靜靜地跳過或重放**一整段，而且不會有任何一個
斷言看得出來。

## nexus-agent 現在有什麼

| 事實 | 位置 |
| --- | --- |
| run 自己的 `seq` **每個 run 從 0 重來**，所以 pump 一定要重新編號 | `apps/harness/src/thread-pump.ts:10-11`（檔頭自己寫的） |
| pump 的 `#seq = 0` 是 **per-ThreadPump-instance** 的 | `thread-pump.ts:103`、`:267` |
| `threads` map 撈得到就重用 pump，**reconnect 不會重編** | `apps/harness/src/wire-handler.ts:96-103` |
| 但 map **沒有單筆逐出**，只有 `close()` 時整個 `clear()` | `wire-handler.ts:317` |
| **CLI 路完全不經過 pump**：直接 `agent.stream()`，thread id 硬編成 `'cli'` | `apps/harness/src/cli.ts:191`、`:311-313` |
| checkpointer 是 `MemorySaver` —— 沒有 append-only 序列 | `cli.ts:245` |

## 外部專案：六個，讀的都是原始碼

**選的準則**：有沒有真的把會話事件序列**持久化**。沒有那一層的專案對這個決定沒有輸入。

| 專案 | HEAD（2026-08-29） | 有 append-only 日誌 | 序號哪來 | 持久化 |
| --- | --- | --- | --- | --- |
| **dsh** | `b150a551` | ✅ | `log.length`，append 時決定 | jsonl / sqlite |
| **Codex CLI** | `6478a751` | ✅ JSONL rollout | **顯式 `ordinal` 欄位**，由 `RolloutOrdinalState.advance()` 推進，寫入走背景 tokio task ＋ 有界 mpsc(256) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| **Gemini CLI** | `0bd1d439` | ✅ | **每次寫入都從磁碟重算**：`sessionLogs.length > 0 ? Math.max(...map(e => e.messageId)) + 1 : 0`，並按 `sessionId` 過濾 | 單一 `logs.json` |
| **SWE-agent** | `3ea751c0` | ✅ trajectory | `n_step = len(self.trajectory) + 1` —— **位置推導**，無顯式欄位 | `.traj`，每步整份重寫 |
| **Cline** | `cea134be` | ❌ | **完全沒有序號**，順序只靠陣列位置 | **兩份平行歷史**：`api_conversation_history.json` 與 `ui_messages.json` |
| **opencode** | `dc4449df` | ❌ | 儲存層不產生序號；靠外部產生的可排序 id（`Identifier.ascending`，時間戳前綴） | key-value JSON 檔 |

**OpenHands 沒讀到。** 那個 repo 已經不是記憶裡的 Python 專案 —— `main` 的頂層是
`src/`（routes / components / stores，前端）與 `electron/`，我**沒有在主 repo 裡定位到
agent 側的事件日誌**。這裡寫成「沒讀到」，不是「它沒有」。

### 這張表讀出來的一件事

**每一個有耐久事件序號的專案，序號都出自那份日誌自己**（長度、最大值、或日誌擁有者持有的
計數器），**沒有一個是拿傳輸／UI 層的計數器來當耐久序號的**。

而**唯一一個 UI 與 API 各存一份的（Cline），兩份都沒有序號** —— 它沒有掉進「兩套編號」的坑，
是因為它根本沒編號，不是因為它解決了。

三種能用的做法，成本從低到高：位置推導（SWE-agent、dsh）、日誌擁有者的顯式欄位
（Codex）、每次寫入回讀磁碟重算（Gemini CLI，最貴但對多寫入者最穩）。

## 對 (A)/(B) 的判準

**(A) 接 thread-pump 的 seq** 會在三個地方出事，前兩個是**量到的**：

1. **CLI 那條路沒有號可用。** `cli.ts` 不經過 pump（`cli.ts:311`）。遙測會只看得到瀏覽器
   來的 run，而這不是缺一點資料 —— 是一整個進入點消失。
2. **伺服器重啟後 seq 從 0 重來。** `#seq` 在 instance 上（`thread-pump.ts:103`），
   而 `threads` map 只在 `close()` 清（`wire-handler.ts:317`）—— 進程沒了，號就重來。
   接收端拿 `(session.id, seq)` 去重的話，重啟後的新事件會撞上舊號**被靜靜吃掉**；
   dsh 那個數值比較的游標（`coordinator.ts:143-145`）更會直接跳段。
   （子代理說 reconnect 就會重來，**那是錯的**，reconnect 會重用既有 pump。是重啟，不是重連。）
3. **語意是借來的（推論）。** pump 的號是為了瀏覽器排序與去重而生的，
   一個純顯示用的改動（例如合併連續 chunk 少發幾筆）就會動到遙測的號。這一條**沒有量**，
   是從「同一個計數器服務兩個目的」推出來的。

**(B) 另立 session log** 的最小可行形狀，照上表收斂：

- 一份 per-session 的 append-only 陣列，`seq` 在 append 當下由**日誌長度**決定（dsh
  `index.ts:629`、SWE-agent 同型），不需要一開始就上 sqlite —— 記憶體版就足以撐開發，
  持久化可以後補（dsh 自己也是 jsonl / sqlite 兩套分開的 package）。
- **CLI 與 web 兩條路都寫進同一份日誌**，這是它相對 (A) 的全部價值所在。
- pump 現在那個 `#seq` **留著別動** —— 它是傳輸層的號，本來就該跟耐久序號分開。
  Cline 的兩份平行歷史說明的是「兩個號各管各的」不會自己出事，出事的是**拿其中一個
  去冒充另一個**。

**傾向 (B)**，理由不是「dsh 這樣做」，是上面那張表裡**六個專案沒有一個把傳輸序號當耐久序號
用**，而 (A) 的第 1 條（CLI 路整個消失）在 nexus 這側是已經量到的、不是風險而是現況。

## 沒讀到／沒查證的

- **OpenHands 的 agent 側事件日誌** —— repo 佈局變了，沒定位到。
- **dsh `cd5ef814` 與 `b150a551` 之間在這個主題上有沒有差** —— 沒對 diff。
- **opencode 的 `createIdentifier` 實作** —— 它在 `@opencode-ai/schema/identifier`，
  沒有進去讀，所以「跨進程是否單調」沒有答案。
- **外部引用沒有釘 SHA** —— 讀的是移動中的預設分支，上表的 HEAD 只是讀取當下的值。
- **各專案的遙測掛在哪一層** —— 這一輪只追序號，遙測掛載點沒有查。
