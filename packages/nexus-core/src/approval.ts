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
import type { InvalidArgumentsCarrier } from './invalid-tool-args.js';
import { formatOrigin, type NexusPlugin } from './plugin.js';
import { toolRefusal } from './tool-events.js';

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
/**
 * 中斷酬載上的判別式：**這一顆是核准請求**。
 *
 * 線上每一顆中斷都出自這個檔案的那一行 `interrupt()`（`interruptOn` 在生產程式碼裡已無
 * 活的用法），所以加得了這個欄位。
 *
 * **缺席即核准**，那是給既有測試的向後相容（`@nexus/wire` 的 `reduceInputRequested`
 * 那側寫著理由）；但**認不得的值不是核准**，那一支要明著壞掉。
 */
export const APPROVAL_INTERRUPT_KIND = 'approval';

/**
 * 中斷酬載上的判別式：**這一顆是問人一組問題**。
 *
 * 生產者是 `@nexus/plugin-ask-user`。常數放在 core 是因為判別式的兩端（發的人與折的人）
 * 分屬三個 package，字串各寫一次就會有一天對不上。
 */
export const QUESTION_INTERRUPT_KIND = 'question';

/**
 * 提問中斷的**生產者有兩個**：`@nexus/plugin-ask-user`（模型自己問）與 `@nexus/plugin-plan-mode`
 * 的 `exit_plan_mode`（計劃審核，[#652](https://github.com/DemianLi/nexus-agent/issues/652)）。
 * 所以一題的形狀、回覆的形狀、判「有沒有人可以回答」的服務名都放在這裡，兩邊讀同一份。
 *
 * dsh 的對應是 `userQuestions` 這個共用服務（`packages/interaction/user-questions/src/types.ts`，
 * `477b4f4`），兩個生產者都呼叫它的 `ask()`。我們沒有那一層：LangGraph 只給一顆 `interrupt()`，
 * 生產者各自呼叫它、酬載帶 {@link QUESTION_INTERRUPT_KIND}——那是 ask-user 登記過的偏離
 * （一條通道加一個判別式）的延伸，不是新的一條。
 */
export interface QuestionInterruptItem {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  /** 跟著這一題一起畫、但不進選項標籤的補充內容。計劃審核把計劃全文放在這裡。 */
  readonly detail?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
  /** 純呈現用：認得的 UI 照它畫，不認得的照一般提問畫。答法兩邊一樣。 */
  readonly intent?: PlanReviewIntent;
}

/**
 * 這一題**就是**一次計劃審核。照 dsh 的 `AskUserQuestionIntent`。
 *
 * `approve` 是同意那個選項的**標籤**，其餘選項都是不同意——用名字不用位置，所以沒有 UI
 * 需要從選項順序猜哪個是同意。
 */
export interface PlanReviewIntent {
  readonly kind: 'plan-review';
  readonly approve: string;
  /** 參數裡裝著這份計劃的那顆工具呼叫，日誌 `tool/call` 的 `callId`。 */
  readonly callId?: string;
}

/** 提問中斷的酬載。 */
export interface QuestionInterruptPayload {
  readonly kind: typeof QUESTION_INTERRUPT_KIND;
  readonly questions: readonly QuestionInterruptItem[];
}

/** 一題的答案。空的 `selected` 且沒有 `custom` ＝ 那一題被跳過。 */
export interface QuestionAnswerItem {
  readonly id: string;
  readonly selected: readonly string[];
  readonly custom?: string;
}

/** 人回來的東西。`cancelled` 那一格是「放棄整組」，不是一份答案。 */
export interface QuestionReply {
  readonly answers?: readonly QuestionAnswerItem[];
  readonly cancelled?: boolean;
}

/**
 * 「這次組裝有沒有人可以回答」這個服務的名字，型別見 `NexusServices.channel`。
 *
 * 由**組裝點**提供（`apps/harness` 的 `createHostServicesPlugin`）：產品路徑一律呼叫
 * {@link deriveApprovalChannel} 明著算一次再提供出來，理由是消費者（核准閘門、`ask_user_question`、
 * `exit_plan_mode`）必須讀到同一個值。以前住在 `@nexus/plugin-ask-user`，第二個提問的生產者
 * 出現之後搬來這裡——它與 {@link ApprovalChannel} 是同一個擁有者。
 */
export const CHANNEL_SERVICE = 'channel';

export type ApprovalChannel =
  /** 有人在，`ask` 真的會停下來問。 */
  | { readonly kind: 'human' }
  /** 政策：這個 session 關掉了核准（`approvals.enabled === false`），每次 ask 確定性地拒絕。 */
  | { readonly kind: 'policy-never' }
  /** 能力：沒有 checkpointer，中斷接不回來，所以連問都不能問。 */
  | { readonly kind: 'no-channel' };

/**
 * 從組裝的兩格算出這次的核准管道。
 *
 * **抽出來是因為它有第二個消費者了**：`@nexus/plugin-ask-user` 的 `ask_user_question`
 * 用同一個判準決定要不要 fail-closed（[#231](https://github.com/DemianLi/nexus-agent/issues/231)
 * 第 7 項）。兩邊各算一次遲早會分岔，而分岔的樣子是「核准擋得下來、問答還在那裡掛著」
 * ——沒有任何測試會紅。
 *
 * **`enabled === false` 為什麼也管到問答**：那個旗標的意思不是「這個 session 不做核准」，
 * 是**「這個 session 沒有人在」**（見 `ApprovalPolicy.enabled` 的 JSDoc，例子是批次跑的
 * CLI）。沒有人在的時候問人，是掛著等一個不會來的答案。**這一格與 dsh 不同**：dsh 的
 * 核准與問答是兩條各自獨立的通道，各有各的政策；我們只有一個旗標，而它問的是人在不在。
 *
 * @param assembly - `approvals.enabled` 與「有沒有 checkpointer」。
 * @returns 這次組裝的核准管道。
 */
export function deriveApprovalChannel(assembly: {
  readonly approvalsEnabled?: boolean;
  readonly hasCheckpointer: boolean;
}): ApprovalChannel {
  if (assembly.approvalsEnabled === false) return { kind: 'policy-never' };
  if (!assembly.hasCheckpointer) return { kind: 'no-channel' };
  return { kind: 'human' };
}

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

/**
 * 一則說得出原因的拒絕，政策擋的與人按拒絕的都走這裡。dsh 兩種都是 `Error: <原因>`
 * （`packages/core/tools/src/index.ts:1479-1487`）。**`status` 不是模型分辨它的依據**：Chat
 * Completions 的轉換器不送它（見 `tool-events.ts` 的 `toolRefusal`），模型靠的是前綴與原因。
 */
function denial(exec: ToolExecution, reason: string): ToolMessage {
  return toolRefusal(reason, { callId: exec.callId ?? '', name: exec.name });
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
 * **參數解不開的那顆照樣先問人**（dsh 核准在驗參數之前），拒絕在內側那顆
 * （`invalid-tool-args.ts`）。listener 拿到的是歷史裡的 `{}`；**只有中斷酬載的 `args` 換成
 * 模型吐的原字串**——人要看的是模型想做什麼，不是改寫後的空物件。這是登記過的偏離：dsh 的核准
 * 請求只帶 `callId`，連到已顯示的工具卡。
 *
 * @param listeners - 依註冊順序的 listener。
 * @param channel - 這次組裝有沒有人可以按核准。
 * @param invalidArguments - 解不開的參數的載體；給了，中斷酬載才讀得到原字串。
 * @returns 可以交給 `registry.middleware.use()` 或塞進 subagent 的 middleware。
 */
export function createApprovalGateMiddleware(
  listeners: readonly NamedEntry<PreToolListener>[],
  channel: ApprovalChannel,
  invalidArguments?: InvalidArgumentsCarrier,
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
      const raw = exec.callId === undefined ? undefined : invalidArguments?.rawOf(exec.callId);
      const answer = (await interrupt({
        kind: APPROVAL_INTERRUPT_KIND,
        actionRequests: [{ name: exec.name, args: raw ?? exec.args, description: because }],
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

/**
 * 這個條目的 plugin 名。
 *
 * **它跟另外五顆 core 條目的鍵不同型**：那幾顆的名字是拿去問
 * {@link ./registry.ts | DisabledEntryView} 的（「這一顆被關掉了嗎」），這一顆**沒有人
 * 會去問**——它關不掉，載入器在條目驗證那一刻就擋下來了
 * （`apps/harness/src/plugin-config.ts` 的保護名單）。這個常數的用途只有一個：讓
 * `cordis.yml` 那一列的 `name` 與這個模組對得上。
 */
export const APPROVAL_GATE_PLUGIN_NAME = 'approval-gate';

/**
 * 核准閘門的**設定條目**（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。
 *
 * **它一顆服務都不註冊、`apply` 是空的，而且它是這幾顆裡唯一關不掉的。** 這一列在場有
 * 兩個各自獨立的理由，兩個都不是「掛上一個功能」：
 *
 * 1. **讓 `disabled: true` 變成失敗，而不是一句讀起來像成功的話。** 這一列不存在的時候，
 *    一條 `- id: approval-gate` ＋ `disabled: true` 的 patch 走的是
 *    {@link ../../../apps/harness/src/plugin-config.ts | applyEntryPatches} 的「找不到 id」
 *    那條——**警告一行、然後跳過**。量過（2026-09-22）：`exit 0`、stderr 剛好一行、
 *    `--dump-config` 的輸出跟完全沒帶那份 patch **逐字相同**。核准其實照樣開著（
 *    {@link ./fold.ts | foldApprovalGate} 無條件建閘門），失敗的方向是安全的那一邊，
 *    但**讀起來像成功關掉了**。這個部署是完全內網、多人共用主機
 *    （[#387](https://github.com/DemianLi/nexus-agent/issues/387)），那個誤會的代價由別人付。
 *    id 存在之後，同一條 patch 會在載入期當場拋。
 * 2. **讓核准在 `--dump-config` 裡看得見。** 同一次量測的另一半：那份 dump 從頭到尾
 *    沒有任何一列跟核准有關，所以一個想確認「這台機器上核准是開的嗎」的維運者，
 *    在 dump 裡分不出來。`cordis.yml` 的檔頭正是叫人用 `--dump-config` 看「這台機器上
 *    實際長什麼樣」。
 *
 * **關不掉是結論不是傾向。** 今天樹上沒有任何一條路能把閘門從 stack 裡拿掉：CLI 與
 * serve 沒有對應的旗標，`approvals` 只在組裝點傳，而
 * {@link ./fold.ts | foldApprovalGate} 是無條件建的；
 * {@link ./fold.ts | ApprovalPolicy.enabled} 的 `false` 也不是拿掉它，是讓需要核准的
 * 工具確定性地回一則 `status: 'error'` 的 ToolMessage（fail-closed）。所以替這一列留一個
 * 「真的要關就這樣寫」的後門，會是**新增一個今天不存在的能力**，不是保留現況。
 *
 * **因此這一列不可以帶 `config`**：沒有 Config schema 卻給了 config 是當場拋
 * （見 {@link ./plugin.ts | parseEntryConfig}）。
 */
export const approvalGatePlugin: NexusPlugin = {
  name: APPROVAL_GATE_PLUGIN_NAME,
  apply() {
    // 空的，而且是承重的空：見上面的檔頭。這一顆唯一的作用是「在場、而且關不掉」。
  },
};

export default approvalGatePlugin;
