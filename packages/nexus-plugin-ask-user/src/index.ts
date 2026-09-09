/**
 * `ask_user_question`：模型自己判斷該問人的時候，停下來問一組結構化的問題。
 *
 * 形狀**照抄 dsh**（`references/deepseek-harness/packages/interaction/tool-ask-user/src/index.ts`
 * 與 `packages/interaction/user-questions/src/types.ts`，SHA `d347e70`；那兩個路徑與
 * `origin/master` `5dda764` **逐位元組相同**，整棵樹之間有 5459 個檔案的差異，所以這不是
 * diff 機器沒在動）。逐格對照：
 *
 * - **模型面五個欄位**：`id`、`question`、`header?`、`options?: {label, description?}[]`、
 *   `multi_select?`。dsh 的 `AskUserQuestionItem` **型別上還有 `detail?` 與 `intent?`**，
 *   但它的**工具 schema 沒有這兩個**——那條路只給 `ctx.userQuestions.ask()` 的內部呼叫者
 *   （plan-review）用。模型看得到的那一面就是這五格，所以我們照這五格。
 * - **`multi_select` 是蛇形，內部是 `multiSelect`**。dsh 兩邊也是這樣分的，不是筆誤。
 * - **回程 `{ answers: [{ id, selected: string[], custom? }] }`**，欄位名與巢狀都一樣。
 * - **不加型別、不加必填、不加格式**（[#231](https://github.com/DemianLi/nexus-agent/issues/231)
 *   第 1 項）。dsh 自己有 JSON Schema 機制卻刻意不用在這條路上——那是「標準沒有那個功能」，
 *   不是「我們表達不出來」。**代價明講：日期打成 `2026/13/45` 這一面不會擋。**
 *
 * ## 唯一的偏離：一條通道加一個判別式
 *
 * dsh 用**兩條獨立的事件通道**（`approval/request` 與 `user-questions/request`），從不判別。
 * LangGraph 只給我們一顆 `interrupt()`，兩條通道表達不出來，所以依 AGENTS.md 的偏離條款
 * 退到最接近的實作：**同一顆中斷，酬載明著帶 `kind`**。判別式的另一半在
 * `@nexus/wire` 的 `reduceInputRequested`。
 *
 * ## fail-closed 用的是核准那條路的同一個判準
 *
 * 沒有人可以回答時**回錯誤，不靜默通過**（#231 第 7 項）。判準是
 * {@link ApprovalChannel}——與核准閘門同一個值、同一個推導（`deriveApprovalChannel`），
 * 不是這裡自己再算一次。
 *
 * **它量得到的與量不到的**：`policy-never`（這個 session 沒有人在）與 `no-channel`
 * （沒有 checkpointer，`interrupt()` 會當場拋 `No checkpointer set`）都擋得下來；
 * **「瀏覽器到底有沒有接上來」它量不到**。那是核准閘門今天就有的同一個盲點
 * （`channel.kind === 'human'` 在那邊也不代表有人真的看得到卡片），這一刀把它原樣繼承，
 * 沒有把它擴大，也沒有只為問答這條路補一半。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import type { ApprovalChannel, NexusPlugin } from '@nexus/core';
import { QUESTION_INTERRUPT_KIND } from '@nexus/core';
import { z } from 'zod';

/** 模型看到的工具名。與 dsh 同名。 */
export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';

/**
 * 工具描述。
 *
 * **命令句，不是建議句。** schema 裡的軟提示壓不動模型（實測），而這條路整個的前提是
 * 「模型自己判斷該問」——描述寫成「你可以問」，它就不會問。
 */
export const ASK_USER_QUESTION_DESCRIPTION =
  '需要確認、需要人在幾個選項裡挑一個，或者缺了你補不出來的資料時，用這個工具問人，不要自己猜。' +
  '一次可以送多題，每一題給一個穩定的 id，答案會照那個 id 回來。' +
  '有明確選項的時候把選項列出來；沒有選項時人可以自由作答。';

const optionSchema = z.object({
  label: z.string().describe('選項的短標籤，直接顯示給人看。'),
  description: z.string().optional().describe('一句話說明這個選項的取捨或後果。'),
});

const questionSchema = z.object({
  id: z.string().describe('這一題的穩定 id，答案會照它回來。'),
  question: z.string().describe('要問的那句話，具體一點。'),
  header: z.string().optional().describe('可選的短標題，例如「確認」或「選模式」。'),
  options: z
    .array(optionSchema)
    .optional()
    .describe('可選的選項清單。你有推薦的就放第一個，並在標籤後面加上「（推薦）」。'),
  multi_select: z.boolean().optional().describe('人可不可以複選。預設單選。'),
});

const askSchema = z.object({
  questions: z.array(questionSchema).describe('繼續之前要問人的那幾題。'),
});

/** 一題問答的答案。空的 `selected` 且沒有 `custom` ＝ 那一題被跳過。 */
export interface AskUserAnswerItem {
  readonly id: string;
  readonly selected: readonly string[];
  readonly custom?: string;
}

/** 人回來的東西。`cancelled` 那一格是「放棄整組」，不是一份答案。 */
export interface AskUserAnswer {
  readonly answers?: readonly AskUserAnswerItem[];
  readonly cancelled?: boolean;
}

/**
 * 人放棄整組問題時回給模型的話。
 *
 * **與「每一題都跳過」是兩件事**：全跳過仍然回傳一份答案（每題空陣列），模型可以據此
 * 繼續；放棄則是這一則錯誤，模型該知道人不打算走這條路了。dsh 的對應是 `ASK_CANCELLED`
 * （`ui-user-questions` 的 `slots.ts:186`）。
 */
export const CANCELLED_MESSAGE = `人放棄了這一組問題，沒有任何一題被回答。不要重問同一組——先講清楚你卡在哪，或換一條不需要這些資料的路。`;

export interface AskUserPluginOptions {
  /**
   * 這次組裝有沒有人可以回答。
   *
   * 省略即 `{ kind: 'human' }`——**這個預設只給測試與「我知道我在幹嘛」的組裝點用**。
   * 產品路徑一律由組裝點呼叫 `deriveApprovalChannel()` 明著算一次再傳進來，理由是
   * 兩個消費者（核准閘門與這個工具）必須讀到同一個值。
   */
  readonly channel?: ApprovalChannel;
}

/** 空的問題清單。dsh 在 `ask()` 當場拋 `EMPTY_QUESTIONS`，我們照做。 */
export const EMPTY_QUESTIONS_MESSAGE = `${ASK_USER_QUESTION_TOOL_NAME} 至少要有一題，收到的是空清單，所以沒有問任何人。`;

export function noAnswererMessage(channel: ApprovalChannel): string {
  return channel.kind === 'policy-never'
    ? `這個 session 沒有人在（關掉了人工核准），${ASK_USER_QUESTION_TOOL_NAME} 問不到任何人，所以沒有問。` +
        `這不是有人拒絕回答——是沒有人被問到。你要嘛用手上已經有的資料繼續，要嘛說清楚缺了什麼。`
    : `這次組裝沒有 checkpointer，問了之後接不回來，${ASK_USER_QUESTION_TOOL_NAME} 所以沒有問。` +
        `這不是有人拒絕回答——是沒有可用的問答管道。`;
}

/**
 * 把 `ask_user_question` 掛上去。
 *
 * @param options - 見 {@link AskUserPluginOptions}。
 * @returns 註冊 `ask_user_question` 的 plugin。
 */
export function createAskUserPlugin(options: AskUserPluginOptions = {}): NexusPlugin {
  const channel: ApprovalChannel = options.channel ?? { kind: 'human' };
  return {
    name: 'ask-user',
    apply(registry) {
      registry.tools.register(
        tool(
          async (args, config) => {
            const { questions } = args as z.infer<typeof askSchema>;
            // **回一則 `status: 'error'` 的 ToolMessage，不是 `throw`。** 兩者在模型那頭
            // 看起來一樣，在執行期不一樣：這個工具的四條錯誤出口有一條發生在 **resume
            // 之後**（人放棄整組），而那一輪的例外會從 LangGraph 的 stream mux 逸出成
            // unhandled rejection——實測整場 run 死掉，而不是模型收到一則錯誤。
            // 核准閘門的 `denial()` 早就是這個形狀，這裡照它。
            const failed = (message: string): ToolMessage =>
              new ToolMessage({
                content: message,
                tool_call_id:
                  (config as { toolCall?: { id?: string } } | undefined)?.toolCall?.id ?? '',
                name: ASK_USER_QUESTION_TOOL_NAME,
                status: 'error',
              });
            // **fail-closed 排在最前面**：沒有人在的時候連中斷都不該發出去，
            // 因為 `no-channel` 底下 `interrupt()` 是當場拋，而那個錯訊說不出原因。
            if (channel.kind !== 'human') return failed(noAnswererMessage(channel));
            if (questions.length === 0) return failed(EMPTY_QUESTIONS_MESSAGE);

            // `interrupt` 用拋例外傳播，**不能包在 try/catch 裡**
            // （`@langchain/langgraph@1.4.12`，`dist/pregel/runnable_types.d.ts:56-57`）。
            const answer = (await interrupt({
              kind: QUESTION_INTERRUPT_KIND,
              questions: questions.map((question) => ({
                id: question.id,
                question: question.question,
                ...(question.header !== undefined && { header: question.header }),
                ...(question.options !== undefined && { options: question.options }),
                ...(question.multi_select !== undefined && { multiSelect: question.multi_select }),
              })),
            })) as AskUserAnswer | undefined;

            if (answer?.cancelled === true) return failed(CANCELLED_MESSAGE);
            const answers = answer?.answers;
            if (!Array.isArray(answers)) {
              return failed(
                `問答回覆看不懂：${JSON.stringify(answer)}。` +
                  `這一格只收 { answers: [{ id, selected: string[], custom?: string }] }。`,
              );
            }
            return JSON.stringify({
              answers: answers.map((item) => ({
                id: item.id,
                selected: [...item.selected],
                ...(item.custom !== undefined && { custom: item.custom }),
              })),
            });
          },
          {
            name: ASK_USER_QUESTION_TOOL_NAME,
            description: ASK_USER_QUESTION_DESCRIPTION,
            schema: askSchema,
          },
        ),
      );
    },
  };
}
