# Todo 的形狀 —— 給 #132 的前置決定

[#132](https://github.com/DemianLi/nexus-agent/issues/132) 列了三個要拍板的東西：掛基座的 `todoListMiddleware` 還是照 dsh 自己做、狀態放會話事件還是 middleware 的 `stateSchema`、要不要有 `/todo` 命令。

**這份筆記的結論是：那不是三個獨立的決定。** 它們是同一件事的三面，而且被同一條水管卡住 —— 而那條水管的缺口，`@nexus/plugin-goal` 的檔頭一年前就標過了。

**調研日期**：2026-09-01。

## 來源與可信度

| 區塊 | 誰做的 | 核對狀況 |
| --- | --- | --- |
| dsh `packages/todo/tool-todo/` 的原始碼與 README | 子代理讀 | ✅ 主代理回核了四條關鍵宣稱（見下） |
| deepagents / langchain 的 `todoListMiddleware` | 子代理讀 | ✅ 回核，**更正一條** |
| 我們樹裡兩條狀態路徑的形狀與代價 | 主代理讀 | 第一手 |
| 工具執行期認不認得出 session | 主代理 grep | 第一手 |

**主代理回核的四條**（子代理的宣稱全部成立）：

1. `packages/todo/` 底下**只有 `tool-todo/` 一個子套件**（`ls -R` 確認），沒有 `command-todo`。
2. `tool-todo/src/types.ts:28-32` 確實對 `@deepseek-ai/dsh-session/types` 做宣告合併，加上 `'todo/write': { todos: TodoItem[] }`。
3. `tool-todo/src/index.ts:205-210` 是 `if (!exec.agent) throw ...` 然後 `exec.agent.session.append('todo/write', { todos })`。
4. langchain 1.5.10 的主進入點**匯得出** `todoListMiddleware`（`grep -c` 命中 2）。

**更正一條**：子代理說 deepagents 內部「給 langsmith backend 掛」`todoListMiddleware`。那是誤讀 —— 那段程式碼住在一個叫 `langsmith-*.js` 的 bundle 分塊裡，但它註冊的對象是 **Codex 的 harness profile**：

```js
const CODEX_MODEL_SPECS = ['openai:gpt-5.1-codex', 'openai:gpt-5.2-codex', 'openai:gpt-5.3-codex'];
function createExtraMiddleware() { return [todoListMiddleware()]; }
// …
for (const spec of CODEX_MODEL_SPECS) registerHarnessProfileImpl(spec, profile);
```

跟 backend 無關，跟**模型**有關。這條的實務意義寫在最後一節。

## 一、dsh 怎麼做

**狀態在會話日誌。** README.zh.md 的設計理念第一條就是「整表替換、日誌承載狀態」：模型重新發送整個列表，`todo/write` 快照存在事件溯源的會話日誌上，「持久性、回放與恢復重建都來自日誌而非服務」。

**形狀刻意最小**：`TodoItem` 只有 `content` 與三態 `status`，**沒有 id、沒有優先級**。理由寫在 `types.ts` 的註解裡 —— 每次寫入整表替換（last-write-wins），所以條目不需要穩定身分。這一刀把 CAS／併發那一整組問題砍掉了，跟 goal 的 revision 機制是相反的取捨。

**只有工具，沒有命令。** 寫入介面只有模型呼叫的 `todo_write`；讀取走 `todos` 投影。人打的命令一個都沒有。

**有不變量配套入口**（`src/invariant.ts`），而它檢的東西值得記：條目畸形、content 空或重複、未知狀態，以及 **`todo/write` 只能在 turn open 期間 append**。它**刻意不檢** `in_progress` 的數量 —— 那是部署策略（`allowParallelInProgress`，必填無預設），不是持久資料規則，所以一種策略下寫的日誌換另一種策略仍然回放得了。

**投影的生命週期**：`turn/start` 清空、`todo/write` 換成最新列表、`turn/end` 保留剛完成的清單。

## 二、基座提供什麼

`todoListMiddleware` **不在 deepagents 的 public export 裡**，但 **langchain 1.5.10 的主進入點匯得出來**（`langchain/dist/agents/middleware/todoListMiddleware.d.ts`）。所以「基座沒有」是錯的說法，正確的是「deepagents 沒有，langchain 有，而且要自己掛」。

它的形狀：state schema 是 `{ todos: TodoItem[] | undefined }`，middleware 內部註冊一個 `write_todos` 工具，**狀態活在 graph state**。`TodoItem` 的形狀跟 dsh 一致（`content` ＋ 三態 `status`）—— 這不是巧合，兩邊抄的是同一個公認形狀。

差別只在狀態放哪：dsh 在日誌，langchain 在 graph state。

## 三、我們樹裡的兩條路，以及一個過期的判準

`@nexus/plugin-goal` 走會話事件（`registry.sessions` ＋ `goal/change`），`@nexus/plugin-plan-mode` 走 middleware 的 `stateSchema` ＋ checkpointer。#132 把「狀態放哪」寫成在這兩條之間選。

**先劃掉一個不成立的判準：耐久性。** plan-mode 檔頭當時的論證是「`SessionLog` 全樹零個 hydrate／persist 路徑」，暗示走事件不比走 state 耐久。今天兩邊都查了：

- `SessionLog` 只有兩個建構點（`apps/harness/src/thread-pump.ts:129`、`apps/harness/src/cli.ts:386`），都是 `new SessionLog(threadId)` 從空的開始，**零個 hydrate／persist 路徑**（那句話仍然成立）。
- checkpointer 是 `new MemorySaver()`（`apps/harness/src/cli.ts:381`）—— **也在記憶體裡**。

**兩條路一樣不跨 process 活著。** 拿耐久性當理由，是拿一個還沒發生的差別做決定。

**真正的差別有兩個。**

第一個是**人打得動的代價**。查 `/plan` 怎麼改得動 `stateSchema` 的狀態時，發現 plan-mode 維護的是兩份：真相在 graph state，命令那一側有一面鏡子（`packages/nexus-plugin-plan-mode/src/index.ts:274` 的 cell），而它得處理「人選了但還沒落地」的中間態 —— `pending` 與 `committed` 兩個欄位，`active()` 是 `pending ?? committed`，`pending` 要等觀察到 state 真的等於它才清（照 dsh 的 “Delete only after append succeeds”）。goal 那條沒有這個問題：service 綁在日誌上，`/goal` 直接讀，append 是定案的。

**但 todo 沒有命令**（dsh 那側如此，見第一節），所以這個代價在這裡是零。**第一個差別對 todo 不適用。**

第二個是**誰看得見**。走 `stateSchema` 的狀態不在日誌裡，所以不變量配套入口看不到、遙測協調器也鏡像不到 —— 這不是推測，`packages/nexus-plugin-plan-mode/src/invariant.ts` 的第一節就叫「檢不到的那一條」，明說模式狀態活在 graph state 裡所以它檢不到，並把那算成那條偏離的第二筆代價。

**而 dsh 的 todo 有一條真的在檢的規則**：`todo/write` 只能在 turn open 期間 append。那條規則**只有走事件路才檢得到**。

|  | 事件路（goal 那條） | `stateSchema` 路（plan-mode 那條） |
| --- | --- | --- |
| 耐久性 | 不持久 | 不持久（判準失效） |
| 人打命令改 | 直接讀 service | 要維護 cell 鏡子（**todo 用不到**） |
| 模型改 | 要工具 ＋ 認得出 session（見下） | 天然在 state 裡 |
| 不變量看得到 | ✅ | ❌ |
| 遙測看得到 | ✅ | ❌ |
| 動核心詞彙 | 要加 `SessionEventType` | 不動 |

## 四、卡住的地方：工具執行期不知道是誰在叫

dsh 的寫入路徑是 `tool-todo/src/index.ts:205-210`：

```ts
if (!exec.agent) {
  // The list is per-agent-session state; a non-agent caller (no owning
  // session) has nowhere to write it. Reject rather than silently no-op.
  throw new Error('todo_write requires an owning agent session')
}
exec.agent.session.append('todo/write', { todos })
```

**它的工具執行上下文帶著 `agent`，而 agent 帶著 `session`。我們沒有這個。**

這就是 `@nexus/plugin-goal` 檔頭標過的那條水管：「我們全樹**零處**讀 `RunnableConfig` / `configurable` —— 工具執行期不知道是誰在叫它。」主代理重驗了，那句話今天仍然成立：`configurable` 全樹只出現在**呼叫端**（`thread-pump.ts:263`、`cli.ts:493`，以及測試），沒有任何工具 handler 讀它。

**但 todo 的需求比 goal 低，而且低得有意義。** `tool-goal` 走不了是因為它的權限規則要求「當前輪次有一則已接受的 `{ kind: 'user' }` 訊息」，而且**要分得出 root 與 subagent 的血緣**。todo 只要回答一個是非題：**有沒有一個 owning session**。血緣那半不需要。

而水管的兩端其實都已經在，**兩個進入點都查過**：

- **傳進去的那端**：`apps/harness/src/thread-pump.ts:263` 與 `apps/harness/src/cli.ts:493` **都**在傳 `configurable: { thread_id: … }`。（特地查兩個進入點，是因為 CLI 走的是自己 `new SessionLog(THREAD_ID)` 的那條路 —— 只驗 pump 那側會漏掉它。）
- **收得到的那端**：我們的工具走 LangChain 的 `tool()` helper（例如 `packages/nexus-plugin-echo/src/index.ts:47`）。它的 callback 第二個參數確實收得到 config —— `@langchain/core/dist/tools/index.d.ts:112` 與 `:144` 的簽章是 `(TArg, configArg?: TConfig)`，`TConfig` 是 `ToolRunnableConfig`。**我們現有的工具只是沒有一個宣告第二個參數。**

**缺的是中間那張 `thread_id` → `SessionLog` 的表。** 兩個進入點都是一 thread 一份日誌，所以那張表有地方住。

## 五、三個決定，以及它們其實是什麼

**決定 3（要不要 `/todo`）：不要。** dsh 不給，而理由不是省事 —— todo 是**模型的規劃工具**，人寫的是 goal（`/goal`）與計劃（`/plan`）。三者各自一條狀態軌道，寫入者不同。這一條沒有懸念，而且它一定案，決定 2 的天秤就變了（cell 鏡子的代價歸零）。

**決定 2（狀態放哪）：事件路**，如果決定 1 走照 dsh 那條。理由不是耐久性（失效了），是那條 turn-open 的不變量規則 —— 走 `stateSchema` 就檢不到它，而那是 dsh 唯一真的在檢的 todo 規則。

**決定 1 才是真正要拍板的，而它現在長這樣**：

- **(a) 先補水管，再照 dsh 做。** 補的東西是一張 `thread_id` → `SessionLog` 的表加上工具讀 config 那一步 —— 比 goal 需要的少一半（不必判血緣）。補完之後 `tool-todo` 照 dsh 抄得動；`tool-goal` **不會跟著解鎖**，但它會從缺兩件變成只缺血緣判斷那一件（那是 `@nexus/plugin-goal` 明文標為「被擋住的，不是取捨」的那一件）。代價兩筆：多一張前置卡；`SessionEventType` 多一種 `todo/write`，而那會讓 `packages/nexus-plugin-goal/src/fold.test.ts:382` 的絆索當場紅 —— **那是設計好的關卡不是意外**，#128 埋它就是為了逼加事件種類的人回答一句「這一種推得動輪次嗎」（`todo/write` 的答案是不推）。
- **(b) 掛 langchain 的 `todoListMiddleware`。** 便宜，一行掛上去。代價要標成偏離：狀態在 graph state、不進日誌、不變量與遙測都看不到、turn-open 那條規則檢不了。而按 AGENTS.md 的偏離規則，這條**標註不了** —— 偏離條款要求「現有基礎建設表達不出來」，但事件路我們表達得出來（goal 就是走這條），走不了的是水管而不是表達力。**這一條要當成明知的取捨寫下來，不是當成偏離。**
- **(c) 不做。** todo 不是任何東西的相依，goal 與 plan mode 都不依賴它。

**建議 (a)**，但它的價值有一半在水管本身而不在 todo：「工具執行期認得出 session」這件事，任何一個要寫日誌的模型工具都會再撞一次，而 `tool-goal` 已經在那面牆前面站了一張卡的時間。

## 六、順帶：一條今天不成立、但會自己回來的風險

deepagents 對 **Codex 模型**（`openai:gpt-5.1-codex` / `5.2` / `5.3`）的 harness profile 會自動掛上 `todoListMiddleware`，也就是自動多一個 `write_todos` 工具。

今天不影響我們：live model 是 `openai/gpt-oss-120b`（`apps/harness/src/live-model.ts:39`），eval 的階梯也都不是 Codex。

但 `apps/harness/src/base-tools.ts` 的 `BASE_TOOL_NAMES` 是**手抄的**基座工具名字宇宙，裡面沒有 `write_todos`。哪天真的切到 Codex 模型，基座會自己多掛一個不在我們宇宙裡的工具 —— 而 `baseline.test.ts` 那條全集斷言跑的是 `StateBackend` ＋ `ScriptedChatModel`，**它不會替我們紅**。

這是記憶裡「基座預設會被自己踩掉」的反面：預設不只會被我們踩掉，**它本身還會隨模型而變**。

## 沒做的事

- **deepagents 的原始碼**：只讀 `dist/`，沒進 `src/`。
- **langchain `todoListMiddleware` 的跨 session 行為**：型別說 state 是 graph 級的，但沒跑測試實證。
- **dsh 的三個 Agent Note**（`todo-write-tool`、`todo-parallel-in-progress`、`todo-plan-clears-on-next-turn`）：README 引用了它們，沒讀。要動手實作前應該讀，砍掉的欄位與備選方案都在那裡。
- **dsh 的 `docs/subsystems/todo.zh.md`**：沒讀。
- **`exec.agent` 在 dsh 那側是怎麼被填上的**：只看到工具端怎麼用它，沒追它從哪來。要走 (a) 的話，那條路徑是最該先讀的東西。
- **`configurable.thread_id` 實際上到不到得了工具 handler**：型別上收得到、兩個呼叫端都有傳，但**沒有實際跑一次**驗證它中途沒被 LangGraph 吃掉。要走 (a) 的話，那是第一個該寫的測試。
