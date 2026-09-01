# subagent 的會話日誌 —— 給 #137 的前置調研

[#137](https://github.com/DemianLi/nexus-agent/issues/137) 要的是 dsh 的單一所有者規則：subagent 與其他 agent 各自維護自己的列表。這份筆記回答它自己標的「要先答的」，而答案是**那個問題問錯了**，另外附帶一個被證偽的捷徑與一把真的可用的鑰匙。

三個結論，先講：

1. **「第二份日誌要不要接上那三個消費者」在標準那側不是一個問題。** dsh 的消費者訂的是 session 註冊表，不是一份 session；每一份新 session 自動被涵蓋。三個各有各的答案是我們的接線形狀造出來的問題，不是它的。
2. **per-run 粒度做得到，而且併發也分得開。** 鑰匙是 `checkpoint_ns` 去掉最後一段。實測驗過四種情形。
3. **有一個看起來更漂亮的捷徑，是假的。** 基座真的每次 spawn 都鑄一顆 id（`_summarizationSessionId`），但工具那一端讀到的是 `undefined`。

## 來源與可信度

| 來源 | 版本／SHA | 怎麼查的 |
| --- | --- | --- |
| deepseek-harness | `0a53fb55bea101816fa226bb964ae2bed71c343b` | 讀 `references/` 底下的原始碼 |
| deepagents | 1.13.1 | 讀 `apps/harness/node_modules/deepagents/dist/` 的實際產出 |
| `@langchain/langgraph` | 1.4.12 | 讀 `dist/index.d.ts` 的匯出面 |
| 執行期行為 | 2026-09-01 | 拋棄式探針，三個情境，程式碼見附錄 |

探針**沒有進版控**，結論寫在這裡。

## 一、「要先答的」是錯的框

#137 把它寫成三題各有各的答案：參與者接不接、不變量接不接、遙測接不接。**dsh 那側沒有這三題**，因為它的消費者從來不是接到「一份日誌」上的。

三個都是同一個形狀 —— 掃一遍現有的，然後訂閱 `session/created`：

```ts
// packages/core/session/src/invariant.ts:218-220
for (const session of ctx.sessions.list()) seedSession(session)
ctx.on('session/created', (session) => { seedSession(session) }, { global: true })
```

`packages/core/tools/src/invariant.ts:76-77`、`packages/llm/llm-retry/src/invariant.ts:158-159`、`packages/context/time-context/src/invariant.ts:174-175`、`packages/schedule/schedule/src/invariant.ts:32-35` 全部逐字同型。

遙測是同一件事的另一個講法 —— `packages/session/session-telemetry/src/coordinator.ts` 的檔頭：live capture「subscribes to the session firehose」，而且「sweeps already-live sessions」。它的 per-session 狀態（handoff cursor）掛在一個以 `Session` 為鍵的 `WeakMap` 上，**隨 session 一起死**。

投影也是：`ctx.sessionProjections.register(turnBoundaryProjectionDefinition)` 註冊**一次**（`packages/core/agent-loop/src/index.ts:409`），讀的時候才 per session 求值（`agent.ts:101` 的 `stateOf(session, 'turnBoundary')`）。

而 subagent 的 session 就是一般的 session：`subagent-spawn-in-process` 的檔頭寫著它「runs each child as a fresh child Agent **on the same cordis context**（its own session…）」。同一個 context ＝ 同一批訂閱者，所以子 session 一被建出來就進了三個消費者的射程。**沒有人需要記得替它重接。**

**所以標準對這三題的答案是同一個「接」，而且它是結構性的、不是逐次決定的。** 我們今天的形狀（`attachTelemetry` / `attachInvariants` / `attachSession` 各收一份 `SessionLog`，由組裝點逐份呼叫）把一個結構問題翻譯成了三個政策問題。#137 說的「生命週期沒有主人」與「三個消費者不會自動接上去」不是兩個難處，**是同一個缺件的兩個面**：我們沒有 session 註冊表。

## 二、per-run 粒度做得到，鑰匙是 `checkpoint_ns`

#137 的第三個難處寫著「粒度到不了 dsh 的粒度」，理由是組裝期的路只給得出 per-subagent-名字。**那句話對，但結論不對** —— 執行期分得出來，而且分得比想像中乾淨。

探針量到的（`ls_agent_type` 與 `thread_id` 兩欄與 [#134](https://github.com/DemianLi/nexus-agent/issues/134) 當時一致，這裡只列新的那一欄）：

| 情境 | `checkpoint_ns` 去掉最後一段 |
| --- | --- |
| root 呼叫 | **空** |
| 第一次 spawn `worker` | `tools:a21dcf6c-…` |
| 第二次 spawn `worker`（循序） | `tools:7afe088a-…` |
| **併發** spawn `worker` ×2（同一輪兩個 `task` 呼叫） | `tools:eadf414d-…` 與 `tools:180484ef-…` |
| 同一次 spawn 裡叫兩次工具 | **兩次都是** `tools:25c89826-…` |

四件事同時成立：

- **root 分得出來** —— 它沒有前綴。
- **每次 spawn 各一** —— 循序兩次不同。
- **併發也各一** —— 這是 #137 說「最重要的測試」的那一條，而它過得了。
- **同一次 spawn 內穩定** —— 前綴不變，變的是最後一段（那是這次工具呼叫自己的 task id）。

前綴就是父圖裡那一次 `task` 呼叫的 task id，所以它天生 per-spawn。這正是 dsh 的粒度：per-session、每次 spawn 一份。

**代價要講清楚：這是一個執行期鍵，而且是 [#136](https://github.com/DemianLi/nexus-agent/pull/136) 花力氣避開的那一個。** 兩件事讓它在這裡是對的選擇而不是走回頭路：

1. **#136 避得開是因為它的需求無條件。** 「拒絕 subagent」不需要知道是哪一個 subagent、也不需要知道是第幾次 spawn，所以組裝期換一顆樁就夠。**這張卡的需求是身分本身**，而身分按定義是 per-run 的 —— 組裝期能表達的最細粒度是名字，證明在 #137 自己的第三點裡。這是 AGENTS.md 那條「現有基礎建設表達不出來時才退」的正例：不是偏好，是表達不出來。
2. **格式沒有承諾這件事不會消失，只能被釘住。** `a|b` 的巢狀分隔沒有出現在 LangGraph 的公開契約裡。所以它要被包在**一個**地方，而那個地方要有絆索：升版把格式改掉時，紅的是那一條解析測試，不是「兩份狀態靜默合成一份」。

## 三、一個被證偽的捷徑

基座**真的**每次 spawn 都鑄一顆 id，就寫在 `createTaskTool` 裡（`dist/langsmith-zm0ILQsV.js:3520`）：

```js
subagentState._summarizationSessionId = `session_${crypto.randomUUID().substring(0, 8)}`;
```

看起來完美：per-spawn、現成的、不用解析字串。而 `getCurrentTaskInput()` 是 `@langchain/langgraph` 的**公開匯出**（`dist/index.d.ts:49`），工具讀得到 state。

**實測是 `undefined`。** 三個情境（root、sub-1、sub-2）全部一樣：`_summarizationSessionId` 這個鍵**出現在** `Object.keys(state)` 裡，值卻是 `undefined`。基座寫進去的那一顆到不了工具這一端。

它本來也不是給這件事用的 —— 同一份 dist 裡它的唯一消費者是摘要中介層的 `getSessionId(state)`（`:2759`），用途是歷史檔的檔名，而且缺席時它自己有一個模組層級的 fallback。名字裡的 `_` 前綴與 `EXCLUDED_STATE_KEYS`（`:3264`）都在說同一件事：那是摘要的私有欄位。

**記下來的理由是：不查會以為它可以用。** 從原始碼讀起來它每一項條件都符合，只有跑起來才知道不行。

## 四、於是這張卡有兩條路

### 路 A：把「誰擁有 session」補起來

一個 session 註冊表，擁有日誌的建立與生命週期；三個消費者改成向它訂一次；subagent 的日誌按 per-run 身分建，指回 parent（對到 dsh 的 `header.parentSession` 與 `origin: 'subagent'`）。

- **收穫**：#137 的四條驗收自然成立，而「接不接」那三題**消失**而不是被回答 —— 同標準那側。
- **代價**：動到三個消費者的接線、`attachTelemetry` / `attachInvariants` / `attachSession` 三個口的形狀，以及兩個進入點（`thread-pump.ts`、`cli.ts`）。這是這棵樹目前為止較大的一次結構調整。

### 路 B：只補第二份日誌

加一層 per-run 身分解析，工具拿得到自己那一份；三個消費者在建第二份日誌時逐一重接。

- **收穫**：小，改動面窄。
- **代價**：**把 #137 自己指出的靜默失敗留在原地** —— 「記得替第二份日誌重接三個消費者」變成一個沒有人會紅的步驟，而漏掉它的三種下場（沒有不變量檢查、沒有參與者、遙測上消失）都是靜默的。第三份日誌出現時同一個坑再踩一次。

### 建議：路 A

#137 列的三個難處 —— 消費者不自動接、生命週期沒主人、粒度到不了 —— 在 dsh 那側是**同一個東西的三個面**，那個東西是 session 註冊表。路 B 會把它們修成三個各自的補丁，而其中兩個補丁的失敗是靜默的。

粒度那一面（第三個）已經不是阻礙了 —— 第二節的探針把它解掉，剩下的是把鑰匙包在一個地方並配上絆索。真正要付的代價只有結構那一面。

## 沒做的事

- **沒有量過第三層。** subagent 再 spawn subagent 時 `checkpoint_ns` 會有三段，前綴的取法（去掉最後一段）在那裡應該仍然成立，但沒跑過。dsh 有 `delegationDepth` 這個欄位，對得上，但也沒讀它怎麼用。
- **沒有讀 dsh 的 session 註冊表本身**（`packages/core/session/src/index.ts` 約 900 行）。第一節引的是它的消費者那一側與 `announce()` 附近的註解，足以判斷訂閱的形狀，但真要走路 A，那份原始碼要整份讀過。
- **沒有查 LangGraph 有沒有承諾 `checkpoint_ns` 的格式。** 現況是「查不到承諾」，不是「查到了說沒有」。
- **沒有碰 `@nexus/plugin-goal`。** 它的 `tool-goal` 走的是 #136 的拒絕那條路，與這張卡無關。

## 附：探針

三個測試，跑在 `apps/harness`，用 `ScriptedChatModel` 加一顆讀 `getCurrentTaskInput()` 與第二個參數 `config` 的工具，把 `checkpoint_ns` / `ls_agent_type` / `_summarizationSessionId` 印出來：

1. **root 一次、同一個 subagent 循序兩次** —— 出第二節前三列與第三節的 `undefined`。
2. **同一輪兩個 `task` 呼叫** —— 出併發那一列。
3. **同一次 spawn 裡叫兩次工具** —— 出最後一列的前綴穩定性。

關鍵的那一段：

```ts
const state = getCurrentTaskInput() as Record<string, unknown>;
const ns = (config?.configurable?.['checkpoint_ns'] as string) ?? '';
const segments = ns.split('|');
sink.push({
  agentType: config?.configurable?.['ls_agent_type'],
  prefix: segments.slice(0, -1).join('|') || '<none>',   // per-spawn 身分
  last: segments[segments.length - 1],                    // 這次工具呼叫自己的
  summarizationSessionId: String(state['_summarizationSessionId']),
});
```
