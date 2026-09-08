# 向使用者索取結構化資料：一手證據與十七項定案

2026-09-08。起因是一個問句：「這個 harness 能不能在填表單的時候輔助使用者把資料補齊？」

**結論：四段鏈（問 → 補齊 → 核准 → 寫出去）裡，傳輸兩端今天就通，斷點只有一個——`@nexus/wire` 的投影層。**「寫出去」那一端另有一個獨立的缺口。

**這份只放一手證據與定案依據。** 射程、要動的地方、驗收句由那張卡持有，不在這裡重述。

---

## 一、實跑：一顆不是核准形狀的中斷走真的線

寫了一顆探針：讓工具發 `interrupt({ questions: [...] })`（問題形狀照 dsh 的 `AskUserQuestionItem` 抄，**不是** `actionRequests` / `reviewConfigs`），走真的 agent、真的 `thread-pump`、真的 wire、真的折疊器，再折回來。跑完就刪，沒進版控（前例：`probe-resume-map.test.ts`）。

四行輸出，逐字：

```
【線上原始 payload】 {"namespace":[],"timestamp":1788872274190,"data":{
  "interrupt_id":"07fad1c1fcc899cc94c0235bbaed9e2e",
  "payload":{"questions":[
    {"id":"visitor_name","question":"訪客姓名？"},
    {"id":"purpose","question":"來訪目的？","options":[{"label":"洽公"},{"label":"面試"}]}]}}}

【折疊器折出來的 pending】 {"interruptId":"07fad1c1fcc899cc94c0235bbaed9e2e",
  "namespace":[],"actions":[],"allowedDecisions":[]}

【上行結果】 {"type":"success","id":2,"result":{"run_id":"e1bbb039-e254-413d-8572-1bc73696b861"}}

【工具收到的】 [{"answers":[
  {"id":"visitor_name","selected":[],"custom":"林小美"},
  {"id":"purpose","selected":["洽公"]}]}]
```

逐行的意思：

1. **問題整包無損地到了瀏覽器那一側。** `options`、`id` 全在。下行對形狀真的無關。
2. **折疊器把它丟光了。** `actions: []`、`allowedDecisions: []`——只剩一個 interrupt id。**這就是唯一的斷點。**
3. **上行送任意 JSON 直接成功。** 沒有經過任何形狀校驗，`run_id` 回來了。
4. **工具原封不動收到了結構化答案。** 回程完整。

**這條探針同時證了兩件事，也留下一個尚未量的**：它證了下行與上行對形狀無關、證了 resume 回得去；它**沒有**量 UI——`allowedDecisions: []` 之下畫面會走進 `approval-card.tsx:56-60` 那個明著寫死的死局（見 §2.3），那一格是讀碼得出的，未實測。

---

## 二、我們這側的形狀

以下行號都是我自己開檔核過的，不是轉述。

### 2.1 傳輸層對形狀無關

`apps/harness/src/thread-pump.ts:84-87`：

```ts
/** 基座把中斷發在 `updates` 上的那一顆的 data 形狀。 */
interface InterruptEntry {
  readonly id: string;
  readonly value: unknown;
}
```

過濾器只檢查 `typeof entry.id === 'string'`（`:95-100`），`:390` 原樣把 `entry.value` 放進 `payload` 轉發。

上行那一側，`apps/harness/src/wire-handler.ts:483-487`：

```ts
const decisions = (params.response as { decisions?: unknown } | null)?.decisions;
if (
  pending.actionCount > 0 &&
  (!Array.isArray(decisions) || decisions.length !== pending.actionCount)
) {
```

而 `thread-pump.ts:122-125` 的 `actionCountOf` 讀不到 `actionRequests` 就回 `0`：

```ts
function actionCountOf(value: unknown): number {
  const requests = (value as { actionRequests?: unknown } | null)?.actionRequests;
  return Array.isArray(requests) ? requests.length : 0;
}
```

**`pending.actionCount > 0` 這個前提，就是非核准形狀的中斷能過線的原因。** 校驗整條略過，任意 JSON 原樣進 `new Command({ resume })`。

### 2.2 窄成「核准」的只有三處

`packages/nexus-wire/src/conversation.ts:428-443`，逐字：

```ts
function reduceInputRequested(
  state: ConversationState,
  namespace: readonly string[],
  raw: unknown,
): ConversationState {
  const data = raw as InputRequestedData;
  const actions = data.payload?.actionRequests ?? [];
  return {
    ...state,
    status: 'awaiting-input',
    pending: {
      interruptId: data.interrupt_id,
      namespace,
      actions,
      allowedDecisions: intersectDecisions(data.payload?.reviewConfigs ?? []),
    },
  };
}
```

**`payload` 除了那兩個鍵以外整包丟掉。** 加上 `PendingInput`（`:102-123`）沒有第二種形狀可放、也沒有 `kind` 欄位，以及 `uniformDecisions`（`:185-187`）只生得出 `{ decisions: [{ type }] }`——三處合起來就是全部的窄化。

### 2.3 UI 的死局

`apps/web/src/components/approval-card.tsx:56-60`，逐字：

```tsx
{pending.allowedDecisions.length === 0 && (
  <p className="text-destructive text-xs">
    這顆中斷沒有共同可用的決定，這裡按不了 —— 只能重開一條對話。
  </p>
)}
```

也就是說：今天送一顆問答中斷上去，畫面會**正確地承認自己處理不了**，然後把人卡在那裡。

### 2.4 自由文字的回程已經接好一半

`packages/nexus-core/src/approval.ts:209-218`：

```ts
const answer = (await interrupt({
  actionRequests: [{ name: exec.name, args: exec.args, description: because }],
  reviewConfigs: [{ actionName: exec.name, allowedDecisions: ['approve', 'reject'] }],
})) as { decisions?: { type?: string; message?: string }[] } | undefined;

const verdict = answer?.decisions?.[0];
if (verdict?.type === 'approve') return handler(request);
if (verdict?.type === 'reject') {
  return denial(exec, verdict.message ?? `有人看過並拒絕了 "${exec.name}"。`);
}
```

`message` 這條「人寫的字串會送到模型面前」的路今天**已經在跑**。堵住它的不是線也不是閘門，是「UI 沒有輸入框」與「`uniformDecisions` 不發它」。

另外：`interruptOn` 在生產程式碼裡**已經沒有活的用法**（`fold.ts:726`、`registry.ts:240-243` 是講舊機制的散文，`spike-agent.ts:55` 是字串；真正的用法全在五個測試檔裡）。**所以線上每一顆中斷都出自上面這一行，是我們控制得了的**——這一點決定了 §五第 17 項。

### 2.5 「寫出去」那一端

檔案這條線**已經接到底**：`apps/harness/src/base-tools.ts:29-38` 的 `FILESYSTEM_TOOL_NAMES` 含 `write_file`；`apps/harness/src/cli.ts:589-591`：

```ts
...(invocation.workspace !== undefined && {
  backend: new ContainedFilesystemBackend({ rootDir: resolve(cwd, invocation.workspace) }),
}),
```

給了 `--workspace` 就從 `StateBackend`（寫進 graph state）換成真的寫磁碟。

卡的是格式：`xlsx` / `exceljs` / `sheetjs` 全 workspace **零相依**（掃過全部 `package.json`），也沒有自製編碼器，而 `write_file` 的 schema 是 `content: string`，沒有二進位出口。**所以 `.csv` 今天寫得出來，`.xlsx` 不行。**

HTTP 那條線**沒有出路**：agent 手上沒有任何能發任意對外請求的工具（`run_javascript` 的 VM 裡沒有 `fetch`，有測試逐個釘住；`execute` 因為 `StateBackend` 沒 shell 而不註冊）。唯一可行是 **MCP 當代理**，而 `createMcpPlugin` 在生產路徑**零個呼叫點**（全部命中只有 README、`index.test.ts`、`mcp.test.ts`、`cli-mcp.fixture.ts`）。

### 2.6 核准閘門今天的實況

`packages/nexus-core/src/approval.ts:115-117`：

```ts
const step = async (index: number): Promise<PreToolDecision> => {
  const entry = listeners[index];
  if (entry === undefined) return { kind: 'allow' };
```

**鏈底是 allow：沒人管的工具一律放行。** 而生產程式碼裡唯一的 `approvals.gate()` 註冊者是 `packages/nexus-plugin-plan-mode/src/index.ts:525-529`：

```ts
registry.approvals.gate((exec, next) =>
  exec.name === EXIT_PLAN_MODE_TOOL_NAME
    ? { kind: 'ask', reason: '計劃要有人看過才算獲准' }
    : next(),
);
```

`exit_plan_mode` 是一個純記憶體的模式切換。**`write_file`（含真的寫磁碟那一個）今天裸奔。**

---

## 三、dsh 的形狀

clone 停在 `d347e703908d0406b7a7ef80e3a0e594d86b2215`（2026-09-04），`origin/master` 已到 `c389f96bf3`，而且本地那顆 merge commit 不在 origin 上——**是分岔不只是落後**。以下路徑我沒對過遠端，見 §六。

### 3.1 兩條獨立的通道，不是一條加判別式

`packages/api/remotes/src/remote-events.ts` 裡跨 Host↔Browser 轉送的事件中，只有兩個是 `mode: 'waterfall'`：`approval/request` 與 `user-questions/request`。Web client 那側的 `SessionPendingInteractionMap` 全 repo 只有兩處 augment：`approval: PendingApproval`、`question: PendingQuestion`。**dsh 從頭到尾沒有「判斷這顆是哪一種」這個動作。**

### 3.2 欄位形狀是寫死的，不是 schema

`packages/interaction/user-questions/src/types.ts:32-64`（我開檔核過，逐字）：

```ts
/** One question in a user-questions request. */
export interface AskUserQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
  intent?: AskUserQuestionIntent
}

/** Answer to one question. */
export interface AskUserQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}
```

**沒有型別、沒有必填、沒有格式。** 而 dsh repo 裡確實有一套 JSON Schema 子集機制（用在 tool / MCP / workflow / subagent）——**它就是刻意沒用在這條路上**。

模型面的 schema 比這還窄，`packages/interaction/tool-ask-user/src/index.ts:20-55`：`parameters` 只開了 `id` / `question` / `header` / `options` / `multi_select`，**`detail` 與 `intent` 模型碰不到**。

### 3.3 dsh 明著否決過「讓核准搭這條路」

`.agents/notes/implemented/feature/2026-07-06-approval-seam.md:98`（現行權威，我核過逐字）：

> **The generic user-questions seam (`ctx.userQuestions`)** — rejected as the approval mechanism: … Approval therefore does not ride the shipped `packages/interaction/user-questions` / `ask_user_question` elicitation path — an elicitation form is not a permission prompt, and a free-text answer is not a closed outcome.

**這句話是 §五第 13 項（送出自成一個工具）與第 15 項（兩個元件）的直接依據。**

### 3.4 沒有 MCP 規格的 elicitation

`packages/mcp/mcp-client/src/connection.ts:237-241` 用 `{ capabilities: {} }` 建 client、零 `setRequestHandler`；全 repo `requestedSchema` 零命中；ACP server 與兩個 subagent 後端都是明文拒絕。**所以 dsh 的「結構化索取」是它自己的 in-process seam，不是 MCP 那個。**

---

## 四、AGENTS.md 偏離判定

| | dsh 的實際做法 | 基座表達得出來嗎 |
| --- | --- | --- |
| 索取的形狀 | 寫死的 `question + options[] + multiSelect`，回 `selected[] + custom`（§3.2） | ✅ 純資料形狀，照抄即可 |
| 誰發動 | 模型呼叫 `ask_user_question` 工具（§3.2） | ✅ 我們有工具註冊點 |
| 一次問幾題 | `questions` 是陣列，一次一批（§3.2） | ✅ 一顆中斷帶整批 |
| 取消／跳過 | `ASK_CANCELLED` / `ASK_ABORTED`；空 answer item 當跳過 | ✅ 探針證過任意 JSON 回得去（§一） |
| 沒人可答 | `NO_PROVIDER` 拒絕，不靜默通過 | ✅ 我們的共同軸線也是 fail-closed |
| **通道** | **兩條獨立事件通道，不判別（§3.1）** | ❌ **基座只有一顆 `interrupt()`** |

**五格照抄，一格退。** 退的那一格是通道：LangGraph 只給我們一個 `interrupt()`，兩條獨立通道表達不出來，所以退到「一條通道 + 一個判別式」。**這是 AGENTS.md 偏離條款下唯一的一處偏離，依據是「現有基礎建設表達不出來」。** 退到什麼、怎麼判別見第 17 項。

另外有一格是**標準沒有那個功能**，不是我們表達不出來：schema 驅動的欄位型別。dsh 有 JSON Schema 機制卻刻意不用在這裡（§3.2）。**「標準不做」不等於「我們該做」**，所以第 7 項照抄它的窄形狀，代價明著記在卡上。

---

## 五、十七項定案（2026-09-08）

| # | 題目 | 定案 | 依據 |
| --- | --- | --- | --- |
| 1 | 要解的是哪件事 | agent 幫使用者把資料填進外部目標，缺的欄位回頭問人 | 使用者定義 |
| 2 | 這一輪的產出 | 判定 + 設計卡，且要有真實測試 | 使用者定 |
| 3 | 與核准扇出 (丙) 的排序 | 排在它後面 | §2.2：`PendingInput` 今天是單一插槽，第二種卡片會蓋掉第一種 |
| 4 | 欄位清單從哪來 | 人給（貼清單或空白範本） | 讓「是否能做到」現在就驗得完；schema 推斷是另一個工程 |
| 5 | 送出要不要過核准 | 要，兩種目標都要 | §2.6：今天 `write_file` 裸奔，這是**新增**一個 gate 註冊者 |
| 6 | 預填的來源 | 只從這一輪對話 | 其餘來源是在它之上疊加 |
| 7 | 人填那一面的形狀 | 完全照抄 dsh 的固定形狀 | §四：標準沒有那個功能 ≠ 我們該做。**代價：日期／格式這一面不會擋** |
| 8 | 一次問幾題 | 一顆中斷帶整批，一張卡列完 | §3.2；且逐格問在 (丙) 之下會生出 N 張卡 |
| 9 | 誰發動「問」 | 模型自己呼叫 `ask_user_question` | §3.2；gap-survey 第 23 列已登記這一格「沒有」 |
| 10 | 寫出去走哪條路 | CSV（`--workspace` + `write_file`）當這一版的驗證載體 | §2.5：`.csv` 今天就通。**MCP 是另一張卡** |
| 11 | 填一半跑掉 | 取消 + 單題跳過照抄；草稿暫存不做 | 前兩者是純資料形狀（§一證過）；草稿是 UI store，dsh 自己也標成 transient |
| 12 | 沒人能回答時 | fail-closed，執行期回錯誤 | 組裝期分不開：`serve` 底下人在不在，取決於瀏覽器有沒有接上來 |
| 13 | 送出的閘門怎麼裝 | 送出自成一個工具（如 `submit_record`），gate 只認那個工具名 | §3.3；順帶讓核准卡顯示填好的欄位而不是一坨 CSV |
| 14 | 驗收做到哪一層 | 腳本端到端（進 CI）+ 一條 live 驗收句（要 key，不進 CI） | 腳本模型證不到「模型會不會自己判斷該問」 |
| 15 | 問答卡與核准卡 | 兩個元件 | §3.1：dsh 是兩個 slot |
| 16 | 寫成什麼 | 這份筆記（證據）+ 一張卡（射程與驗收） | 證據的壽命比卡長 |
| 17 | UI 怎麼分辨兩種中斷 | payload 明著帶 `kind`，缺了就當核准 | §2.4：線上每顆中斷都出自 `approval.ts:209`，加得了欄位；預設值讓五個既有測試檔一行不用改。**必須配一條「不認得的 `kind` 要明著壞掉」的絆索** |

---

## 六、沒查清楚的

1. **dsh clone 是分岔的**（`d347e70` vs `origin/master` 的 `c389f96`），§三引的四個路徑沒對過遠端。要照 `dsh-clone-goes-stale` 的紀律同步後 diff 再引。
2. **UI 那一格沒實測。** §一的探針停在折疊器，`allowedDecisions: []` 之下畫面的死局是讀 `approval-card.tsx:56-60` 得出的，沒有跑過瀏覽器。
3. **`{decisions:[{type:'reject',message:'…'}]}` 端到端會不會真的把 `message` 帶到模型面前**（§2.4）：型別上通、`wire-handler` 不擋、`approval.ts:217` 會讀，但沒有測試釘住，我也沒跑。
4. **真正寫磁碟的程式碼在 `node_modules` 裡**（`deepagents@1.13.1` 的 `FilesystemBackend`），§2.5 是靠 `contained-backend.ts` 的 `extends` / `super.write()` 與它檔頭的實測表格推出來的，沒有直接讀到那一行。
5. **`task`（subagent 委派）能不能繞過核准或路徑圍堵**：沒追 subagent 那條路的 backend 繼承。標為不確定。
6. **MCP 的 `http` transport 全 repo 零測試**（型別與翻譯分支都寫完了）。第 10 項把 MCP 推到另一張卡，就是因為這一格。
