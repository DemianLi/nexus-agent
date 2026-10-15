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
 *   （plan-review）用。模型看得到的那一面就是這五格，所以我們照這五格。我們的 plan-review 是
 *   `@nexus/plugin-plan-mode` 的 `exit_plan_mode`，#652 起由它填這兩格；一題的形狀因此搬進
 *   `@nexus/core` 的 `QuestionInterruptItem`，兩個生產者讀同一份。
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
 * ## 子代理不問人（[#324](https://github.com/DemianLi/nexus-agent/issues/324)）
 *
 * 照 dsh，子代理叫這個工具一律被拒，碼是 `DELEGATED_CALLER`（{@link DELEGATED_CALLER_ERROR}）。載體是
 * `rootOnly`：fold 把每個子代理那一份換成拒絕樁，句與碼由這裡帶。所以上面那個判準只管 root。
 *
 * ## 遷上 Cordis 樹（[#1458](https://github.com/DemianLi/nexus-agent/issues/1458)，Part of #1385）
 *
 * 函式插件，具名匯出 `name`／`inject`／`Config`／`manifest`／`apply`，**沒有 default**；`src` 不 import `@nexus/core`
 * （套 #1420 的 lint 設定）。要的兩個服務都由宿主在樹上提供：
 *
 * - `tools`（`@nexus/tools`，契約 `^1.1.0`）：登記工具，**帶 `rootOnly` 與 `outputSchema` 兩個選項**。範圍寫 `^1.1.0`
 *   而不是 `^1.0.0`：1.0.x 的提供者不認得選項，會把它們靜靜丟掉。
 * - `approvalChannel`（`@nexus/approval-channel`，契約 `^1.0.0`）：行程級的預設答題管道。**在 `apply` 當下抓進閉包**，
 *   呼叫當下才問它的 `current()`：列卸載之後經 `ctx` 取服務會拋（`cannot get required service … in inactive context`），
 *   抓住的那份則仍可呼叫，所以「這一列停用之後，開著的 thread 照樣問得到」。
 *
 * **不再查 `channelForThread`**（#1458 Q1 (c)）：管道今天在一個行程裡是常數（入口有沒有人在、有沒有 checkpointer），
 * 逐條 thread 的查詢一定落空。拿掉它不改行為；等出現真的逐條不同的答題者時，提供者與查詢一起加回來
 * （`docs/plugin-contract.md` 的偏離表）。它也沒有放進 `inject`：選配的依賴放進 `inject` 會讓一致性套件的 `export-form` 紅。
 *
 * **舊的 `NexusPlugin` 外殼搬走了**（`apps/harness/src/ask-user.fixture.ts`，同 echo、skills、feedback 的前例）：還在相容層
 * 組裝的測試經它掛這顆工具，它與樹上這一列共用 {@link createAskUserTool}，所以兩邊的工具本體是同一份程式碼。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import {
  approvalChannelToken,
  CHANNEL_SERVICE,
  QUESTION_INTERRUPT_KIND,
} from '@nexus/approval-channel';
import type {
  ApprovalChannel,
  QuestionAnswerItem,
  QuestionInterruptPayload,
  QuestionReply,
} from '@nexus/approval-channel';
import type { Context } from '@nexus/cordis';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { markToolError, toolCallIdOf, toolRefusal } from '@nexus/tool-result';
import type { ToolErrorInfo } from '@nexus/tool-result';
import { toolsToken } from '@nexus/tools';
import type { ToolRegisterOptions } from '@nexus/tools';
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

/**
 * 成功那一條的輸出 schema，註冊時帶（[#252](https://github.com/DemianLi/nexus-agent/issues/252)）。
 * 四條錯誤出口都是 `status: 'error'`，校驗器不驗。
 */
export const ASK_USER_OUTPUT_SCHEMA = z.object({
  answers: z.array(
    z.object({ id: z.string(), selected: z.array(z.string()), custom: z.string().optional() }),
  ),
});

/** 一題問答的答案。形狀住在 `@nexus/core`，因為提問的生產者不只這一個（見 `QuestionInterruptItem`）。 */
export type AskUserAnswerItem = QuestionAnswerItem;

/** 人回來的東西。`cancelled` 那一格是「放棄整組」，不是一份答案。 */
export type AskUserAnswer = QuestionReply;

/**
 * 人放棄整組問題時回給模型的話。
 *
 * **與「每一題都跳過」是兩件事**：全跳過仍然回傳一份答案（每題空陣列），模型可以據此
 * 繼續；放棄則是這一則錯誤，模型該知道人不打算走這條路了。dsh 的對應是 `ASK_CANCELLED`
 * （`ui-user-questions` 的 `slots.ts:186`）。
 */
export const CANCELLED_MESSAGE = `人放棄了這一組問題，沒有任何一題被回答。不要重問同一組——先講清楚你卡在哪，或換一條不需要這些資料的路。`;

/**
 * 人放棄整組時那則錯誤的碼，給會話日誌的 `tool/result` 讀
 * （[#264](https://github.com/DemianLi/nexus-agent/issues/264)）。照 dsh 的
 * `UserQuestionError` 與 `ASK_CANCELLED`（`packages/plan/plan-mode/src/index.ts:325`）。
 *
 * **其餘三個錯誤出口不標**：沒有人可以回答、空清單、看不懂的回覆。dsh 的 `EMPTY_QUESTIONS`
 * 在 `ask()` 那一層、我們這裡是工具本體先擋，不是同一個時刻；另外兩格 dsh 沒有對應的碼。
 */
export const CANCELLED_ERROR: ToolErrorInfo = { name: 'UserQuestionError', code: 'ASK_CANCELLED' };

/**
 * 子代理叫到這個工具時那則錯誤的碼。照 dsh `ctx.userQuestions.ask()` 對不是 runtime root 的呼叫方拋的
 * `UserQuestionError`／`DELEGATED_CALLER`（`packages/interaction/user-questions/src/index.ts:101-106`，
 * `c291e79`；`tool-ask-user.spec.ts:270-299` 釘住拒絕的樣子）。
 */
export const DELEGATED_CALLER_ERROR: ToolErrorInfo = {
  name: 'UserQuestionError',
  code: 'DELEGATED_CALLER',
};

/** 子代理叫到這個工具時模型看到的那一句（前面由 `toolRefusal` 加 `Error: `）。dsh 同一處那句的中文。 */
export const DELEGATED_CALLER_MESSAGE =
  '呼叫的 agent 由另一個執行中的 agent 擁有，這時無法與人互動；' +
  '把沒解決的問題或待定的決定寫進子代理的最終結果。';

/**
 * 「這次組裝有沒有人可以回答」這個服務的名字。**搬到 `@nexus/core` 了**（#652：`exit_plan_mode`
 * 也要讀它），這裡轉出舊名，匯入它的人不必改。
 */
export { CHANNEL_SERVICE };

/** 空的問題清單。dsh 在 `ask()` 當場拋 `EMPTY_QUESTIONS`，我們照做。 */
export const EMPTY_QUESTIONS_MESSAGE = `${ASK_USER_QUESTION_TOOL_NAME} 至少要有一題，收到的是空清單，所以沒有問任何人。`;

/** 這次組裝沒有人提供答題管道（{@link CHANNEL_SERVICE} 沒人 provide）時的拒絕。對應 dsh 的 `NO_PROVIDER`。 */
export const NO_CHANNEL_MESSAGE = `這次組裝沒有指定問答管道，${ASK_USER_QUESTION_TOOL_NAME} 不知道該問誰，所以沒有問。這不是有人拒絕回答——是沒有被問到。你要嘛用手上已經有的資料繼續，要嘛說清楚缺了什麼。`;

export function noAnswererMessage(channel: ApprovalChannel): string {
  return channel.kind === 'policy-never'
    ? `這個 session 沒有人在（關掉了人工核准），${ASK_USER_QUESTION_TOOL_NAME} 問不到任何人，所以沒有問。` +
        `這不是有人拒絕回答——是沒有人被問到。你要嘛用手上已經有的資料繼續，要嘛說清楚缺了什麼。`
    : `這次組裝沒有 checkpointer，問了之後接不回來，${ASK_USER_QUESTION_TOOL_NAME} 所以沒有問。` +
        `這不是有人拒絕回答——是沒有可用的問答管道。`;
}

/**
 * 組出 `ask_user_question` 這顆工具。
 *
 * **工具本體只有這一份**：樹上的列（{@link apply}）與還在相容層組裝的測試（`apps/harness/src/ask-user.fixture.ts`）都從這裡
 * 取。它們之間唯一不同的是「這次呼叫的答題者怎麼來」，所以那一格是參數。
 *
 * **fail-closed 排在最前面**（#669）：沒有人在的時候連中斷都不該發出去，因為 `no-channel` 底下 `interrupt()` 是當場拋，
 * 而那個錯訊說不出原因。
 *
 * @param channelOf - 這次呼叫的答題者；`undefined` 是沒有人提供（回 {@link NO_CHANNEL_MESSAGE}，**不退成「有人在」**）。
 *   **在呼叫當下才呼叫它**，不在建工具的時候。參數是這次呼叫的 config（取得 thread 身分用；樹上的列不用它）。
 * @returns 可以登記的工具。
 */
export function createAskUserTool(
  channelOf: (config: unknown) => ApprovalChannel | undefined,
): StructuredToolInterface {
  return tool(
    async (args, config) => {
      const { questions } = args as z.infer<typeof askSchema>;
      // **回一則 `status: 'error'` 的 ToolMessage，不是 `throw`。** 兩者在模型那頭
      // 看起來一樣，在執行期不一樣：這個工具的四條錯誤出口有一條發生在 **resume
      // 之後**（人放棄整組），而那一輪的例外會從 LangGraph 的 stream mux 逸出成
      // unhandled rejection——實測整場 run 死掉，而不是模型收到一則錯誤。
      // 核准閘門的 `denial()` 早就是這個形狀，這裡照它；前綴也同它，由 `toolRefusal` 加（#318）。
      const failed = (message: string): ToolMessage =>
        toolRefusal(message, {
          callId: toolCallIdOf(config) ?? '',
          name: ASK_USER_QUESTION_TOOL_NAME,
        });
      // **沒人提供就是沒有答題者，不是「有人在」**（#669）：以前缺席時退成 `{ kind: 'human' }`，一份不掛 host-services 的
      // 組裝會拿到一顆以為有人在答的工具，問了就停在一個沒人接的中斷上。照 dsh：`tool-ask-user` 硬注入 `userQuestions`，
      // 沒有任何答題者接下請求時以 `NO_PROVIDER` 拋錯（`packages/interaction/user-questions/src/index.ts:132`）。
      const channel = channelOf(config);
      if (channel === undefined) return failed(NO_CHANNEL_MESSAGE);
      if (channel.kind !== 'human') return failed(noAnswererMessage(channel));
      if (questions.length === 0) return failed(EMPTY_QUESTIONS_MESSAGE);

      // `interrupt` 用拋例外傳播，**不能包在 try/catch 裡**
      // （`@langchain/langgraph@1.4.12`，`dist/pregel/runnable_types.d.ts:56-57`）。
      const payload: QuestionInterruptPayload = {
        kind: QUESTION_INTERRUPT_KIND,
        questions: questions.map((question) => ({
          id: question.id,
          question: question.question,
          ...(question.header !== undefined && { header: question.header }),
          ...(question.options !== undefined && { options: question.options }),
          ...(question.multi_select !== undefined && {
            multiSelect: question.multi_select,
          }),
        })),
      };
      const answer = (await interrupt(payload)) as AskUserAnswer | undefined;

      if (answer?.cancelled === true) {
        return markToolError(failed(CANCELLED_MESSAGE), CANCELLED_ERROR);
      }
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
  );
}

/**
 * 登記時帶的選項（#1458 Q3 (a)）：樹上的列與相容層外殼用同一份。
 *
 * - `outputSchema`：成功那一條的輸出形狀（#252）。
 * - `rootOnly`：**子代理不停下來問人**（#324，照 dsh 的 `DELEGATED_CALLER`）：fold 把每個子代理那一份換成拒絕樁。dsh 是在
 *   `ask()` 裡查呼叫方；我們照 goal 那三顆的對應退到 `rootOnly`（理由見 `@nexus/core` 的 `fold.ts` 的 `ROOT_ONLY_NOTICE`），
 *   句與碼照 dsh 帶。
 */
export const ASK_USER_REGISTER_OPTIONS: ToolRegisterOptions = {
  outputSchema: ASK_USER_OUTPUT_SCHEMA,
  rootOnly: { message: DELEGATED_CALLER_MESSAGE, error: DELEGATED_CALLER_ERROR },
};

/** 插件在樹上的列用的名字（`ctx.fiber.runtime.name`，錯誤訊息、log 與相容層清單用）。 */
export const name = 'ask-user';

/**
 * 要的服務：`tools`（`^1.1.0`，要帶選項）與 `approvalChannel`（`^1.0.0`）。範圍在這裡宣告，落進 Cordis 的
 * `Context.intercept`，提供者的 `check` 讀得到。
 */
export const inject = injectOf(need(toolsToken, '^1.1.0'), need(approvalChannelToken, '^1.0.0'));

/**
 * 這個插件的設定：沒有。`strictObject` 不是隨手選的：manifest 的 `config` 必須是 `strictObject`，未知欄位讓載入失敗是
 * 登記過的偏離，理由見 `@nexus/core` 的 `plugin.ts` 檔頭。
 */
export const Config = z.strictObject({});

export const manifest = defineManifest({
  id: 'ask-user',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [],
  consumes: [
    { token: toolsToken.name, range: '^1.1.0' },
    { token: approvalChannelToken.name, range: '^1.0.0' },
  ],
  config: Config,
  // 換程式碼要重啟行程；沒有設定可改，所以 config 那一格只是照規範填（#1405、決議 §3-2 第 6 條）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * 掛上：把 `ask_user_question` 登記進行程級的工具登記處，帶 `rootOnly` 與 `outputSchema`。
 *
 * **答題管道在這裡抓進閉包**：列卸載之後經 `ctx` 取服務會拋，抓住的那份仍可呼叫（見檔頭）。呼叫當下才問
 * `current()`——它是宿主交給這個行程的值，今天是常數。
 *
 * @param ctx - 這一列的 Cordis context。
 */
export function apply(ctx: Context): void {
  const channel = service(ctx, approvalChannelToken);
  service(ctx, toolsToken).register(
    createAskUserTool(() => channel.current()),
    ASK_USER_REGISTER_OPTIONS,
  );
}
