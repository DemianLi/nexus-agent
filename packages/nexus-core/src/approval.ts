/**
 * 核准：一條 pre-execute waterfall，加上把決定送到人面前的那一格。
 *
 * **形狀照 dsh 的 `tools/pre-execute`**（`references/deepseek-harness/packages/core/tools/src/index.ts:152`）：
 * listener 拿到**活的那一次呼叫**（工具名、已解析的參數、call id），回
 * {@link PreToolDecision}；`next()` 委派給下一位，鏈底是 allow。
 *
 * **這取代了原本的 `interrupts.require(toolName, ...)`。** 舊機制是「宣告一份工具名
 * 清單、執行時由基座查表」，所以永遠有一份名單要跟真實工具集合對齊——名字打錯的閘門
 * 會靜靜地什麼都不擋（`hitl.js` 查不到就 auto-approve），而我們只能在 fold 加一條後置
 * 檢查去追它。**工具名現在是執行當下就在手上的，那個 bug class 不存在了**，順帶
 * `when` 述詞不再是一個額外的擴充點：listener 本來就看得到參數。決議見
 * [#111](https://github.com/DemianLi/nexus-agent/issues/111)。
 *
 * **偏離標註**：dsh 的 waterfall 由 Cordis 的事件系統承載，listener 掛在 `ctx` 上、
 * 生命週期綁 `ctx.effect`；我們沒有 Cordis，所以退到「registry 收一份 listener 陣列、
 * fold 時折成一個 `wrapToolCall` middleware」。決策詞彙與 `next()` 的語義照抄。
 */

import { ToolMessage } from '@langchain/core/messages';
import { interrupt, isGraphBubbleUp } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import type { NamedEntry } from './entries.js';
import { formatOrigin } from './plugin.js';

/** 核准閘門 middleware 的名字。錯誤訊息與排序斷言用得到。 */
export const APPROVAL_GATE_MIDDLEWARE_NAME = 'nexusApprovalGate';

/**
 * 一次待決的工具呼叫。
 *
 * 照 dsh 的 `ToolExecution` 取三格：名字、已解析的參數、call id。**刻意不帶 `tool`
 * 實例** —— 基座在動態註冊時給的是 `undefined`（`langchain@1.5.10`，
 * `dist/agents/middleware/types.d.ts:75-100`），型別上可選、伸手拿就會炸，跟舊機制
 * 裡 `when` 收到的 `request.tool` 恆為 `undefined` 是同一個坑。不放進來就沒得踩。
 */
export interface ToolExecution {
  /** 工具名。**執行當下拿到的，不是宣告出來的。** */
  readonly name: string;
  /** 已解析的參數。 */
  readonly args: Record<string, unknown>;
  /** 這一次呼叫的 id。基座偶爾不給，所以是可選的。 */
  readonly callId: string | undefined;
}

/**
 * 一次 pre-execute 決定。
 *
 * **三格封閉，照 dsh**（`packages/core/tools/src/index.ts:589`）。沒有 edit／rewrite
 * 那一格，dsh 的型別自己寫了理由：參數已經被記錄也被呈現過了。我們這側還多一層
 * 證據——基座的 `processDecision` 拿到 `{ type: 'edit' }` 而 `allowedDecisions` 裡沒有
 * 它時當場拋（`hitl.js:407`），所以那不是一個靜默降級。
 */
export type PreToolDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason?: string };

/**
 * 一位 pre-execute listener。
 *
 * @param exec - 活的那一次呼叫。
 * @param next - 委派給下一位；鏈底回 `{ kind: 'allow' }`。**不呼叫就是把後面的人整個
 *   短路掉**，那是刻意可以做的事（照 dsh 的 waterfall 語義）。
 */
export type PreToolListener = (
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
) => Promise<PreToolDecision> | PreToolDecision;

/**
 * 這一次組裝有沒有人可以按核准，以及為什麼沒有。
 *
 * **三格分開不是形式**——[#111](https://github.com/DemianLi/nexus-agent/issues/111) 的
 * (b) 拍板「兩個都要」，而 dsh 的兩個來源答的是不同的問題：`ApprovalPolicy: 'never'`
 * 問的是**政策**（管道在，答案恆定是不），`ctx.get('approval') === undefined` 問的是
 * **能力**（根本沒有管道）。**dsh 的三個非授權結果各自帶不同的 deny 理由**，`serviceAsk`
 * 的 JSDoc 明說那是為了讓模型分得出 “a human "no"” 與 “an absent approval channel”，
 * 逐字是 “the three non-grants deny with distinct reasons”
 * （`references/deepseek-harness/packages/core/tools/src/index.ts`，SHA
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`；**引句比行號耐得住**——dsh 那邊搬了程式碼，
 * grep 那句話還找得到）。
 *
 * **三是結果詞彙，不是數字串。** 三 ＝ `ApprovalOutcome` 四值裡的非授權那三個。
 * `serviceAsk` 今天實際會回**五**條不同的 deny 字串，多出來的兩條是 pre-dispatch 的降級
 * （沒有 service、沒有 agent），落在 `ApprovalOutcome` 之外、也就落在那句引文的射程之外。
 * 數字串數到五、引文說三，兩個讀法都成立——**別再把它改回一個兩邊都不是的數**
 * （原本寫的「四」就是這麼來的，見
 * [#223](https://github.com/DemianLi/nexus-agent/issues/223)）。
 *
 * **數量對上不等於成員對得上。** dsh 的三個是 `rejected`／`cancelled`／`unavailable`，
 * 我們的三格是 `human`／`policy-never`／`no-channel`，`cancelled` 在我們這側沒有對應物。
 * 抄過來的是「分得開才有價值」這條紀律，不是一張對照表。收斂成同一句就等於把這一格的
 * 價值丟掉。
 */
export type ApprovalChannel =
  /** 有人在，`ask` 真的會停下來問。 */
  | { readonly kind: 'human' }
  /** 政策：這個 session 關掉了核准（`approvals.enabled === false`），每次 ask 確定性地拒絕。 */
  | { readonly kind: 'policy-never' }
  /** 能力：沒有 checkpointer，中斷接不回來，所以連問都不能問。 */
  | { readonly kind: 'no-channel' };

/**
 * 跑完整條 waterfall。
 *
 * listener 自己拋的錯要指得出是誰——但**中斷與 `Command` 這類控制流是用拋例外走的**，
 * 包起來會把功能吃掉，所以照 `containment.ts` 的同一個判準先讓它們穿出去。
 */
export async function runApprovalGate(
  listeners: readonly NamedEntry<PreToolListener>[],
  exec: ToolExecution,
): Promise<PreToolDecision> {
  const step = async (index: number): Promise<PreToolDecision> => {
    const entry = listeners[index];
    if (entry === undefined) return { kind: 'allow' };
    try {
      return await entry.value(exec, () => step(index + 1));
    } catch (error) {
      if (isGraphBubbleUp(error)) throw error;
      throw new Error(
        `${formatOrigin(entry.origin)} 的核准閘門在判斷 "${exec.name}" 時拋錯：` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };
  return step(0);
}

/** 一則說得出原因的拒絕。`status: 'error'` 是模型分辨它與成功結果的唯一依據。 */
function denial(exec: ToolExecution, reason: string): ToolMessage {
  return new ToolMessage({
    content: reason,
    tool_call_id: exec.callId ?? '',
    name: exec.name,
    status: 'error',
  });
}

/**
 * 把 waterfall 折成一個 `wrapToolCall` middleware。
 *
 * **中斷的酬載刻意長得跟基座一模一樣**：`interrupt({ actionRequests, reviewConfigs })`
 * 送出、`{ decisions: [{ type }] }` 收回（`hitl.js:325-346`、`:469`）。換掉的是「誰產生
 * 它」，不是線上的形狀——`packages/nexus-wire` 與 web 那一側因此一行都不用動。
 *
 * **順帶關掉基座的批次語義。** 基座是在 `afterModel` 整批停下來問，一批裡有人被拒，
 * 被核准的那些會靜靜地不執行、而且從 `tool_calls` 裡被抹掉（`hitl.js:483-496`）。
 * 這裡是逐次呼叫各自判斷，所以 `actionRequests` 恆長度 1，那個抹除不存在。
 * **代價是同一批裡排在前面的工具在人被問到時已經跑完了**——基座是問之前一個都沒跑。
 * 兩種都不是全有全無，差別在副作用落在問之前還是問之後。實測見 #111 的 spike 留言。
 *
 * **核准這件事在日誌上一顆事件都沒有。** dsh 每次 request 追加一對 `approval/asked` ＋
 * `approval/decided`（`references/deepseek-harness/packages/interaction/user-approval/src/types.ts:44-58`，
 * log-only 的審計，帶 id／工具名／結果）。我們這側三件都量過（2026-09-08）：
 *
 * - `deny`／`policy-never`／`no-channel` 三條路**一顆都不記**——那三個出口只回一則
 *   `denial()`，這個檔案裡沒有任何 `append`；
 * - 人那條路只有一顆 `interrupt/raised`，**只帶 `interruptId`**（`session-log.ts` 的酬載型別
 *   就只有那一個欄位），不帶工具名、call id、理由；
 * - **結果從來沒進日誌**——`wire-handler.ts` 收到 `decisions` 之後零個 `append`（全檔零個），
 *   日誌上只剩 `turn/start` 的 resume 那一格，而它分不出核准與拒絕。
 *
 * **這是認帳不做，不是待辦。** 結局與兩條重開條件見
 * [#220](https://github.com/DemianLi/nexus-agent/issues/220)；閱讀面在
 * `apps/harness/src/interception-index.test.ts` 第 4 列的紀錄差，**源碼散文（這裡）才是第一
 * 產物**。
 *
 * @param listeners - 依註冊順序的 listener。
 * @param channel - 這次組裝有沒有人可以按核准。
 * @returns 可以交給 `registry.middleware.use()` 或塞進 subagent 的 middleware。
 */
export function createApprovalGateMiddleware(
  listeners: readonly NamedEntry<PreToolListener>[],
  channel: ApprovalChannel,
): AgentMiddleware {
  return createMiddleware({
    name: APPROVAL_GATE_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      const exec: ToolExecution = {
        name: request.toolCall.name,
        args: (request.toolCall.args ?? {}) as Record<string, unknown>,
        callId: request.toolCall.id,
      };
      const decision = await runApprovalGate(listeners, exec);
      if (decision.kind === 'allow') return handler(request);
      if (decision.kind === 'deny') return denial(exec, decision.reason);

      const because = decision.reason ?? `"${exec.name}" 需要人工核准`;
      if (channel.kind === 'policy-never') {
        return denial(
          exec,
          `${because}，但這個 session 關掉了人工核准，所以沒有執行。` +
            `這不是有人拒絕了它——是沒有人被問到。`,
        );
      }
      if (channel.kind === 'no-channel') {
        return denial(
          exec,
          `${because}，但這次組裝沒有 checkpointer，核准之後接不回來，所以沒有執行。` +
            `這不是有人拒絕了它——是沒有可用的核准管道。`,
        );
      }

      // `interrupt` 是用拋例外傳播的，**不能包在 try/catch 裡**
      // （`@langchain/langgraph@1.4.12`，`dist/pregel/runnable_types.d.ts:56-57`）。
      const answer = (await interrupt({
        actionRequests: [{ name: exec.name, args: exec.args, description: because }],
        reviewConfigs: [{ actionName: exec.name, allowedDecisions: ['approve', 'reject'] }],
      })) as { decisions?: { type?: string; message?: string }[] } | undefined;

      const verdict = answer?.decisions?.[0];
      if (verdict?.type === 'approve') return handler(request);
      if (verdict?.type === 'reject') {
        return denial(exec, verdict.message ?? `有人看過並拒絕了 "${exec.name}"。`);
      }
      throw new Error(
        `核准回覆看不懂：${JSON.stringify(answer)}。` +
          `這一格只收 { decisions: [{ type: "approve" | "reject" }] }，` +
          `形狀與基座的 HITL 相同，所以 web 那一側不必為此改。`,
      );
    },
  });
}
