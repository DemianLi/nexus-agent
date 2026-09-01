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

**但 todo 的需求比 goal 低。** `tool-goal` 走不了有兩個理由：它的權限規則要求「當前輪次有一則已接受的 `{ kind: 'user' }` 訊息」，而且要分得出 root 與 subagent 的血緣。**todo 只欠第二個** —— 它要知道「有沒有一個 owning session」以及「是誰的」（dsh 的單一所有者規則要求 subagent 各自一份清單），但不需要去讀輪次裡有沒有使用者訊息。

而水管的兩端其實都已經在，**兩個進入點都查過**：

- **傳進去的那端**：`apps/harness/src/thread-pump.ts:263` 與 `apps/harness/src/cli.ts:493` **都**在傳 `configurable: { thread_id: … }`。（特地查兩個進入點，是因為 CLI 走的是自己 `new SessionLog(THREAD_ID)` 的那條路 —— 只驗 pump 那側會漏掉它。）
- **收得到的那端**：我們的工具走 LangChain 的 `tool()` helper（例如 `packages/nexus-plugin-echo/src/index.ts:47`）。它的 callback 第二個參數確實收得到 config —— `@langchain/core/dist/tools/index.d.ts:112` 與 `:144` 的簽章是 `(TArg, configArg?: TConfig)`，`TConfig` 是 `ToolRunnableConfig`。**我們現有的工具只是沒有一個宣告第二個參數。**

**缺的是中間那張 `thread_id` → `SessionLog` 的表。** 兩個進入點都是一 thread 一份日誌，所以那張表有地方住。

### 實測：真的到得了，而且帶的東西比預期多

型別說得通不代表 LangGraph 中途不會把它吃掉，所以跑了一次探針：註冊一個工具，它的第二個參數原樣印出來，用 `ScriptedChatModel` 讓 root 叫它一次、再委派給 subagent 叫一次。探針程式碼附在最後一節，可以重跑。

| | root 呼叫 | subagent 呼叫 |
| --- | --- | --- |
| `configurable.thread_id` | `lineage-thread` | **`lineage-thread`（同一個）** |
| `configurable.ls_agent_type` | `root` | `subagent` |
| `configurable.checkpoint_ns` | `tools:<id>` | `tools:<id>\|tools:<id>`（巢狀） |

三件事，每一件都改了上面的結論：

1. **`thread_id` 到得了工具 handler。** 水管的中段確認可行 —— 缺的真的只是那張表。
2. **血緣分得出來。** `ls_agent_type` 直接給 `root` / `subagent`。上一版這份筆記說「`tool-goal` 不會跟著解鎖，因為血緣那半還缺」—— **那句話錯了**，血緣那半也有依據。但要標一個風險：`ls_agent_type` 是 **LangSmith tracing 的元資料**（`ls_` 前綴），不是給業務邏輯用的公開契約，升版沒有保證。`checkpoint_ns` 是 LangGraph 自己的東西，穩定性較高但要自己解析巢狀。
3. **`thread_id` 在 subagent 裡是同一個 —— 這件事對 todo 有直接後果。** dsh 的「單一所有者」規則是「subagent 與其他 agent 各自維護自己的列表」。如果我們只拿 `thread_id` 查表，root 與 subagent 會共用同一份日誌、也就是同一份 todo 清單，**跟 dsh 的規則相反**。要照 dsh 做，查表的鍵得是 `checkpoint_ns` 那一類分得出巢狀的東西，不是 `thread_id`。

## 五、三個決定，以及它們其實是什麼

**決定 3（要不要 `/todo`）：不要。** dsh 不給，而理由不是省事 —— todo 是**模型的規劃工具**，人寫的是 goal（`/goal`）與計劃（`/plan`）。三者各自一條狀態軌道，寫入者不同。這一條沒有懸念，而且它一定案，決定 2 的天秤就變了（cell 鏡子的代價歸零）。

**決定 2（狀態放哪）：事件路**，如果決定 1 走照 dsh 那條。理由不是耐久性（失效了），是那條 turn-open 的不變量規則 —— 走 `stateSchema` 就檢不到它，而那是 dsh 唯一真的在檢的 todo 規則。

**決定 1 才是真正要拍板的，而它現在長這樣**：

- **(a) 先補水管，再照 dsh 做。** 補的東西是一張「誰在叫」→ `SessionLog` 的表，加上工具讀 config 那一步。**查表的鍵不能是 `thread_id`** —— 實測顯示 subagent 跟 root 共用它，而 dsh 的單一所有者規則要求各自一份清單，所以鍵要用 `checkpoint_ns` 那一類分得出巢狀的東西。補完之後 `tool-todo` 照 dsh 抄得動，而且**實測顯示 `tool-goal` 的兩個障礙也都有依據了**（血緣走 `ls_agent_type`，但那是 LangSmith 的元資料，要自己包一層並釘住升版）。代價兩筆：多一張前置卡；`SessionEventType` 多一種 `todo/write`，而那會讓 `packages/nexus-plugin-goal/src/fold.test.ts:382` 的絆索當場紅 —— **那是設計好的關卡不是意外**，#128 埋它就是為了逼加事件種類的人回答一句「這一種推得動輪次嗎」（`todo/write` 的答案是不推）。
- **(b) 掛 langchain 的 `todoListMiddleware`。** 便宜，一行掛上去。代價要標成偏離：狀態在 graph state、不進日誌、不變量與遙測都看不到、turn-open 那條規則檢不了。而按 AGENTS.md 的偏離規則，這條**標註不了** —— 偏離條款要求「現有基礎建設表達不出來」，但事件路我們表達得出來（goal 就是走這條），走不了的是水管而不是表達力。**這一條要當成明知的取捨寫下來，不是當成偏離。**
- **(c) 不做。** todo 不是任何東西的相依，goal 與 plan mode 都不依賴它。

**建議 (a)**，而實測之後它的價值比原本估的高：「工具執行期認得出 session」這件事，任何一個要寫日誌的模型工具都會再撞一次，而 `tool-goal` 已經在那面牆前面站了一張卡的時間 —— 現在看起來那面牆比它當初標的矮。

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
- **`ls_agent_type` 的穩定性**：實測拿得到，但它是 LangSmith tracing 的元資料，沒有查過它算不算公開契約、也沒有查升版紀錄。要靠它判血緣的話，這是第一個該補的功課。
- **`checkpoint_ns` 的格式保證**：實測是 `tools:<id>` 與巢狀的 `a|b`，但沒查 LangGraph 對這個格式有沒有承諾。

## 附：探針程式碼

上面第四節那張表是跑這個跑出來的。它**沒有進版控**（一次性的探針，沒有歸屬的測試檔），要重跑就把它放回 `apps/harness/src/config-probe.test.ts`：

```ts
const probe: NexusPlugin = {
  name: 'probe',
  apply(registry) {
    registry.tools.register(
      tool(
        (_input: unknown, config?: { configurable?: Record<string, unknown> }) => {
          seen.push({
            ls_agent_type: config?.configurable?.ls_agent_type,
            thread_id: config?.configurable?.thread_id,
            checkpoint_ns: config?.configurable?.checkpoint_ns,
          });
          return '好';
        },
        { name: 'probe_tool', description: '探針。', schema: z.object({}) },
      ),
    );
    registry.subagents.register({ name: 'worker', description: '幹活的。' });
  },
};
// ScriptedChatModel 的腳本：root 叫一次 probe_tool → 叫 task 委派 worker →
// subagent 叫一次 probe_tool → 各自收工（共六輪）。
// createNexusAgent({ model, checkpointer: new MemorySaver(), plugins: [probe] })
// 之後 agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'lineage-thread' } })
```

## 後記：(a) 落地了，以及唯一改掉的那一條

**日期 2026-09-01，同一天。** 建議的 (a) 走完了：水管由 [#135](https://github.com/DemianLi/nexus-agent/pull/135)（哪一份日誌）、[#136](https://github.com/DemianLi/nexus-agent/pull/136)（拒絕 subagent）與 [#138](https://github.com/DemianLi/nexus-agent/pull/138)（subagent 各自一份）三張補齊，`@nexus/plugin-todo` 照 dsh 抄下來。

**上面第四節的鍵那一段要更正一句**：那時寫的是「鍵要用 `checkpoint_ns` 那一類分得出巢狀的東西」，而 #138 的調研把它量準了——鍵是 **`checkpoint_ns` 去掉最後一段**（最後一段是這次工具呼叫自己的 task），解析包在 `@nexus/core` 的 `session-address.ts` 一個檔案裡並配了絆索。

**唯一沒有照抄的是不變量的歸屬那一條。** dsh 寫的是「`todo/write` 不在開著的輪裡就報」，無條件；照抄過來的話**每一次 subagent 的 `todo_write` 都會變成違規**——subagent 的日誌上永遠不會有 `turn/start`，因為發 turn 事件的是進入點而 subagent 不經過進入點（#137 釘下來的約定）。

規則因此改寫成看**這份日誌自己有沒有輪**：見過 `turn/start` 的守配對，沒見過的就是沒有輪這個概念。另一條路（讓配套入口拿得到 `SessionAddress`，`kind === 'subagent'` 就跳過）被否掉的理由有兩條，寫在 `packages/nexus-plugin-todo/src/invariant.ts` 的檔頭上，第一條是「這個寫法哪天 subagent 真的長出輪會自己跟上，看身分的那個會繼續靜默跳過」。

**這裡沒有做的事仍然沒有做**：dsh 的三個 Agent Note 與 `docs/subsystems/todo.zh.md` 這次讀了後者，前三個仍然沒讀；`todos` 投影仍然沒有（我們沒有投影註冊表，那是 `@nexus/core` 的 `sessions.ts` 早就標過的同一條偏離）。
