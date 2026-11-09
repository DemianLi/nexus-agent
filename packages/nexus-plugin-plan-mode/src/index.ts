/**
 * `@nexus/plugin-plan-mode`——計劃模式：先探索與設計，把完成的計劃交出去等人批准。
 *
 * 這個套件的來歷不太一樣：它不是從我們的計劃書長出來的，是**從 dsh 長出來的**。
 * [#16](https://github.com/DemianLi/nexus-agent/issues/16) 原本列的兩個強化方向
 * （每步多一次 LLM 呼叫的自我批判、顯式意圖分類）在 dsh 全樹**都不存在**——
 * `reflection` 的命中全是 TypeScript 型別反射，`intent classif` 零命中。它對「先想
 * 再做」的答案是**計劃模式**（`packages/plan/plan-mode/`），配上 todo 與 goal：
 * 讓模型自己承擔規劃、把狀態外顯，人可以介入。三件裡我們一件都沒有，所以先補的是這
 * 一件。細節見 [#116](https://github.com/DemianLi/nexus-agent/issues/116)。
 *
 * **這裡原本寫的是「`TodoListMiddleware` 已經蓋掉 todo 那塊」，那句話是假的。**
 * 基座的預設 middleware stack 不帶 todo（`apps/harness/src/baseline.test.ts` 第一條的
 * 全集斷言裡沒有 `write_todos`），`todoListMiddleware` 得自己掛。那句話是承重的——它在
 * 論證「所以補的是計劃模式這塊」——但前提錯了不影響結論：三件當時都缺。goal 由
 * [#126](https://github.com/DemianLi/nexus-agent/issues/126) 補上，todo 由
 * [#132](https://github.com/DemianLi/nexus-agent/issues/132) 補上（`@nexus/plugin-todo`，
 * 照 dsh 走會話事件而不是掛基座的 middleware）。
 *
 * 對讀日期 2026-09-12，dsh `d347e703908d0406b7a7ef80e3a0e594d86b2215`。
 *
 * ## 三個零件，照 dsh 的分工
 *
 * | 零件 | dsh | 這裡 |
 * | --- | --- | --- |
 * | 指引 | `plan:policy` 提示詞段落，順序 500，未激活不貢獻文本 | 同名的段（{@link PLAN_POLICY_SECTION_NAME}，經 `thread.section` 登記），順序 500，未啟用時這一次不接；接在 `plugins.prepended` 的區尾，不是 dsh 的位置 |
 * | 退出工具 | `exit_plan_mode` 漸進揭露（對讀 `ce7073d5`）：從第一個啟用計劃模式的步驟起才進工具清單，之後整個會話都留著；模式外執行會失敗 | {@link EXIT_PLAN_MODE_TOOL_NAME}，一律註冊、模式外拒絕（只在本體裡；沒有排在核准閘門之前的另一層，#1276） |
 * | 模式狀態 | `plan/mode` 會話事件 ＋ `planProjectionDefinition` 這個帶版本的會話投影 | `plan/mode` 會話事件 ＋ 這個 plugin 在 root 那份日誌上的折疊；送上線給畫面的那一份是 pump 另外合成的 `custom` 事件，只有 `active`，見 `@nexus/wire` 的 `plan-mode.ts`（[#895](https://github.com/DemianLi/nexus-agent/issues/895)） |
 *
 * ## 樹上的一列
 *
 * **`plan-mode`**（這個入口）是樹上的函式插件：逐條 thread 接上 root 日誌、聽 `agent/pre-step` 交出待關、登記指引段
 * （{@link mountPlanModeThread}），行程級登記 `exit_plan_mode` 與 `/plan`（{@link mountPlanMode}）。每份 root 日誌上的模式與排著的待關
 * 以那份日誌為鍵，放在一次掛載一份的狀態表（`./plan-mode-state.ts`）。`exit_plan_mode` 被 core 拿掉的 `name`，送模型之前由 core 補回
 * （`@nexus/core` 的 `tool-name-restore.ts`），不歸這裡。
 *
 * ## 交出計劃走提問通道——曾經走核准，已照 dsh 改回（[#652](https://github.com/DemianLi/nexus-agent/issues/652)）
 *
 * **這一格曾經走核准**：plan-mode 註冊一位 `approvals.gate`，對 `exit_plan_mode` 回 `ask`，理由寫的是
 * 「人批准計劃與人批准這次工具呼叫是同一件事，所以不另建評審通道」。**那正是 dsh 明文否決的那條路**
 * （`.agents/notes/archived/feature/2026-07-07-plan-mode.md` 的 Alternatives，`477b4f4`）：核准的結果
 * 詞彙刻意封閉（允許／拒絕），拒絕帶不回意見，同意也長不出選項。而我們當時沒有照 AGENTS.md 把它登記成
 * 偏離。後果是計劃變成核准卡裡的工具參數，拒絕帶不回意見。
 *
 * 現在照 dsh（`packages/plan/plan-mode/src/index.ts:278-350`）：**工具本體自己問一題**，走提問通道，
 * 核准閘門不再管它。
 *
 * - 題目 {@link PLAN_REVIEW_QUESTION}，`detail` 帶計劃全文，兩個選項 {@link PLAN_APPROVE_LABEL} 與
 *   {@link PLAN_KEEP_PLANNING_LABEL}，`intent` 是 `plan-review`（純呈現用，答法同一般提問）。
 * - 選同意、沒有自由作答 → 回成功，**模式在下一個模型步驟之前才關**（見下一節）。
 * - 其他（選繼續規劃、或有自由作答）→ 拒絕，意見帶回給模型，模式留著。
 * - 人關掉這一題（`cancelled`）→ **成功結果** {@link PLAN_REVIEW_DISMISSED_MESSAGE}，模式留著，**這一批工具跑完之後這一輪就收**
 *   （正常收尾：`turn/end` 不帶 `reason`；不是失敗、不是中止），不再多叫一次模型（[#1607](https://github.com/DemianLi/nexus-agent/issues/1607)，
 *   照 dsh `:331-341` 的 `concludeTurn()`）。工具本體在這個結局呼叫 `exec.concludeTurn()`（正向標記），收尾走基座的 `returnDirect`
 *   （{@link EXIT_PLAN_MODE_CONCLUDES_TURN}）：**只有標了才收**，其餘結局（拒絕、參數錯、核准閘門擋下、拋錯）照常回頭叫模型；
 *   **`next-step` 還有插話就不收**、接著叫模型（step-inbox 的 `afterAgent`，dsh `agent.ts:361-365`）。
 *   不是 `ask_user_question` 那句放棄訊息：那句叫模型別重問同一組，說的是它沒呼叫過的工具。
 * - 停止這一輪 → 由 `apps/harness` 的 `ThreadPump` 收回掛著的呼叫，工具本體不會再跑，中止保留它自己那句。
 * - **沒有人可以回答**（`approvalChannel` 服務的 `current()` 說 `policy-never` 或 `no-channel`，或宿主沒有指定答題者）→ 拒絕，請使用者自己切模式，
 *   同 dsh「沒有提問通道就拋錯」。CLI 與 eval 走這條。
 *
 * **怎麼問**：dsh 呼叫共用的 `userQuestions.ask()`，我們沒有那一層，這裡直接 `exec.interrupt()`（宿主那一側是 LangGraph 的 `interrupt()`），酬載帶
 * `QUESTION_INTERRUPT_KIND`。那是 `@nexus/plugin-ask-user` 登記過的偏離（LangGraph 只有一顆中斷，
 * 所以一條通道加一個判別式）的延伸，不是新的一條；題目與回覆的形狀放在 `@nexus/core`，兩個生產者讀同一份。
 *
 * ### 模式在下一個模型步驟之前才關
 *
 * 照 dsh：同意之後不當場寫 `plan/mode`，排一格待關，到下一個 `agent/pre-step`（請求組起來之前）才寫。
 * 所以同一批工具裡其他呼叫照樣看到計劃模式開著，日誌上那顆 `plan/mode { active: false }` 落在
 * `exit_plan_mode` 的 `tool/result` 之後。這一列經 `thread.on('agent/pre-step')` 自己聽那一步（`@nexus/tools` 2.11.0），
 * 不多一格圖節點。**只認 root 那份日誌**：監聽者自己用 `threadId` 對 root 日誌的 id，子代理那一步交不出 root 的待關，
 * 不靠宿主只在 root 派。`afterAgent` 插話跳回模型的那一次，native 不派 pre-step，待關等到下一步。
 *
 * 待關只活在記憶體裡，同 dsh 的 `pendingIntents`：同意之後這一輪被停掉，它等到下一輪第一步才交出去；
 * 行程在那之前重開，它就沒了，模式留在開著。
 *
 * ## 模式狀態走事件日誌——原本的偏離，收回了
 *
 * **這一格曾經是一條登記過的偏離**：模式狀態住在 middleware 的 `stateSchema` 裡，由
 * checkpointer 持久化。登記的理由換過兩次，兩次都被後來的東西消耗掉：
 *
 * - 第一版是「plugin 拿不到 `SessionLog`」。錯的——`invariants` 那條路交出的一直是一份
 *   可寫的日誌，[#127](https://github.com/DemianLi/nexus-agent/issues/127) 才把它收窄；
 *   而 [#126](https://github.com/DemianLi/nexus-agent/issues/126) 加的 `sessions` 通道，
 *   名字就說它交出可寫的日誌，goal 走的正是它。
 * - 第二版是「日誌耐久了，但沒有讀方」——[#173](https://github.com/DemianLi/nexus-agent/pull/173)
 *   讓日誌活過行程，[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的
 *   `--resume` 讀得回它。
 *
 * 最後那一件讓這條偏離有了看得見的代價：只開門 A 的話，重開之後沙箱模式回來、計劃模式
 * 悄悄回到關著——人選的兩個「比較嚴」的模式，一個留得住一個留不住。所以 #251 的第二刀
 * 把它搬回 dsh 的形狀：
 *
 * - **`plan/mode { active }`**，整份值不是切換，最後一顆就是答案。寫者兩個：`/plan`（人）
 *   與 `exit_plan_mode`（模型，計劃獲准之後）。**都只寫 root 那一份。**
 * - **折疊由這一列經 `thread.join` 接上 root 那份日誌**，同 `@nexus/plugin-goal`。
 *   接上的時候觀察面會先重播既有事件，所以續接回來的日誌折得出上一次最後的模式。
 * - **它不在 `session/end-seed` 歸零。** 那顆標記之前的開頭屬於上一個生命週期，讀「當前
 *   這一段」的人要在那裡重設；模式相反——跨重啟留得住正是它搬進日誌的理由。
 *
 * 退法丟掉過的東西也跟著回來了：`eval/runner.ts` 沒有 checkpointer、CLI 與 `serve.ts` 的
 * `MemorySaver` 重啟就沒，這些以前都讓模式留不住；模式住在日誌上之後，它們都碰不到它。
 * 壓縮那一條的測試照舊留著（`apps/harness/src/plan-mode.test.ts`）——它釘的是一句宣稱，
 * 不是一個機制。
 *
 * **與 dsh 仍然不一樣的地方**：dsh 的投影是 core 那一層帶版本的快取（`sessionProjections`），
 * 我們沒有那一層，折疊就寫在這個 plugin 裡——形狀差異，不是偏離，同 goal。
 *
 * ## 沒有日誌的組裝
 *
 * 模式住在日誌上，所以**沒接會話日誌的組裝寫不動它**：`/plan` 回
 * {@link PLAN_NOT_ATTACHED_MESSAGE}，`exit_plan_mode` 回 {@link PLAN_NOT_ATTACHED_TOOL_MESSAGE}，
 * 模式就停在 {@link PlanModePluginOptions.startActive} 那一格。CLI 與 `serve.ts` 都接線；
 * eval 不掛這個 plugin。
 *
 * ## 開啟路徑：`/plan`
 *
 * 上一版沒有開啟路徑，唯一的開關是 {@link PlanModePluginOptions.startActive}。
 * [#120](https://github.com/DemianLi/nexus-agent/issues/120) 補上了 dsh 的那一個：
 * `/plan` 進、`/plan off` 出，走 [#118](https://github.com/DemianLi/nexus-agent/issues/118)
 * 落地的命令通道（今天是 `commands` 服務）。
 *
 * **handler 當場就把選擇寫進日誌**（`log.append('plan/mode', { active })`），同 dsh。以前的
 * 形狀是「plugin 持一格 pending intent，下一次 `beforeAgent` 把它交成 state update」——那是
 * 模式住在 graph state 時的退法（LangGraph 沒有「在 invoke 之外寫 state」這件事），它誠實的
 * 殘餘是「人看到開了，而下一輪永遠不來的話它沒落地過」。模式搬進日誌之後那一格沒有存在的
 * 理由，跟著收掉了。
 *
 * **當場寫的前提是命令跑在兩輪之間。** dsh 在輪還開著時把選擇排著、到下一個
 * `agent/pre-step` 才提交，免得模式在一輪中間翻面。命令那側我們不需要那一格：REPL 一行一輪；
 * `serve.ts` 那條線的發派面在 run 飛在半空、停在核准點、或另一個命令在跑時一律拒收
 * （`apps/harness/src/wire-handler.ts` 的 `handleSlash`，
 * [#123](https://github.com/DemianLi/nexus-agent/issues/123)），絆索在
 * `apps/harness/src/slash-wire.test.ts`。那道閘哪天放寬成排隊，這裡就要長回 dsh 那一格。
 *
 * ### 兩值，不是 dsh 的四值
 *
 * dsh 的 `set()` 回 `committed` / `queued` / `cancelled` / `noop`。`queued` 與 `cancelled`
 * 都要「輪還開著、選擇排著還沒提交」才成立——`cancelled` 就是把排著的那一個收回來。命令
 * 永遠跑在兩輪之間、選擇當場提交，兩個都沒有指涉物。（上一版留著 `cancelled`：它那時指的是
 * 「pending intent 還沒被 `beforeAgent` 交出去」，那一格已經不在了。）所以 `/plan` 之後緊接著
 * `/plan off` 是兩次 `committed`，日誌上兩顆 `plan/mode`。
 *
 * **兩輪之間唯一可能排著的是 `exit_plan_mode` 的待關**（同意之後那一輪被停掉）。命令先把它丟掉再判：
 * 人在兩輪之間打的那一行比模型上一輪的同意新。所以那時 `/plan` 是「已經在計劃模式」、模式留著；
 * `/plan off` 照常關。
 *
 * ### 沒做的，也是偏離；以及撤掉的
 *
 * - **`/plan <message>` 已經收了**（[#776](https://github.com/DemianLi/nexus-agent/issues/776) 重判）。
 *   原本登記的兩個理由都不成立：
 *   1. 「基座沒有從圖外插一則訊息的表達」——[#710](https://github.com/DemianLi/nexus-agent/issues/710) 之後有了。
 *   2. 「在 `CommandResult` 上加一格 steer 會弄糊 `command/done`，也碰到配套入口的序列性」——載體不是結果，
 *      是 `CommandInvocation.steer`（handler 呼叫，同 dsh 的 `agent.steer()`）；宿主等 `command/done` 寫完才動，
 *      `command/run` → `command/done` 的配對先完整收掉，才有 `turn/start`，序列性規則看不到這一輪。
 *
 *   **一個表達上的退路，登記在這裡：** dsh 的 handler 拿到 agent，閒著時 steer 會喚醒一輪
 *   （`packages/core/agent-loop/tests/agent.spec.ts` 的「steer() while idle becomes a woken prompt turn」）。
 *   我們的命令沒有 agent 把手，而且只跑在兩輪之間（見上），所以 steer 永遠是閒著的那一種，
 *   退成「宿主在命令落定後開一輪」（`serve` 進送出佇列、REPL 逐句跑）。這一輪的訊息是普通的 `user` 來源，
 *   同 dsh 的 `source: { kind: 'user' }`。命令落定成 `error` 時，已經收下的 steer 作廢（dsh 沒有這一條，
 *   它的 steer 一呼叫就送出去了；我們不讓失敗的命令開輪）。
 *
 *   **`off` 以外都是訊息，同 dsh**：`/plan of`（打錯的 `off`）以前回 error，現在是進計劃模式並把 `of` 送給模型。
 * - **切換的旁白**：dsh 在人切換模式、而上一份請求標頭描述的是另一個模式時，往對話裡插一句
 *   「The user switched this session to plan mode.」（`loggedActiveAtLastHeader`）。我們沒有
 *   `request/header` 這一顆；從圖外插訊息的路 #710 之後有了，但只接人插的話、只在 serve 上。模型從下一次請求的
 *   system prompt 看得出來——指引在或不在。**待另一張卡重判**（[#788](https://github.com/DemianLi/nexus-agent/issues/788)）：觸發條件不能只比「模式與上一次 `model/start` 不同」，
 *   dsh 還有 `narrate: false`（`exit_plan_mode` 同意那條路，工具結果已經講過）與「從沒送過請求就不講」兩條；
 *   旁白要一種新的訊息來源，會牽動 goal 的 authority 絆索、各套件的 fold 測試、日誌版號與 web 的畫法。
 * - **附件**（`input.attachments: true`，[#1607](https://github.com/DemianLi/nexus-agent/issues/1607)）：照 dsh
 *   （`packages/plan/plan-mode/src/index.ts:228-275`）。`/plan <字>`＋附件與**只有附件的 `/plan`** 都進計劃模式並送出一輪
 *   （附件隨 steer 那句話走，字可以是空的）；`/plan off`＋附件回 `error`（{@link PLAN_OFF_ATTACHMENTS_MESSAGE}），在 steer 與寫日誌之前判。
 *   以前這一格寫「我們沒有 attachment store」，[#732](https://github.com/DemianLi/nexus-agent/issues/732) 之後已過時。
 */

import { approvalChannelToken, QUESTION_INTERRUPT_KIND } from '@nexus/approval-channel';
import type {
  ApprovalChannel,
  QuestionInterruptPayload,
  QuestionReply,
} from '@nexus/approval-channel';
import { commandsToken } from '@nexus/commands';
import type { AttachmentRef, CommandDefinition, CommandResult } from '@nexus/commands';
import type { Context } from '@nexus/cordis';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { sessionLookupToken } from '@nexus/session';
import type { SessionEvent, SessionLog, SessionLookup, SessionSubject } from '@nexus/session';
import { SECTION_ORDERS } from '@nexus/system-prompt';
import { isHumanInputUnavailable, toolsToken } from '@nexus/tools';
import type {
  JsonValue,
  NexusTool,
  NexusToolResult,
  ToolExec,
  ToolThread,
  ToolThreadSection,
  ToolThreadSource,
} from '@nexus/tools';
import { z } from 'zod';

import {
  parsePlanCommandArgs,
  PLAN_ALREADY_ACTIVE_MESSAGE,
  PLAN_ALREADY_INACTIVE_MESSAGE,
  PLAN_COMMAND_DESCRIPTION,
  PLAN_COMMAND_HINT,
  PLAN_COMMAND_NAME,
  PLAN_ENTERED_MESSAGE,
  PLAN_LEFT_MESSAGE,
  PLAN_NOT_ATTACHED_MESSAGE,
  PLAN_OFF_ATTACHMENTS_MESSAGE,
} from './command.js';
import { createPlanModeState } from './plan-mode-state.js';
import type { PlanModeSession, PlanModeState } from './plan-mode-state.js';

// `/plan` 的詞彙是這個套件的公開介面的一部分（測試與組裝點都讀得到），所以整段轉出去。
export * from './command.js';

/** 註冊出來的工具名。組裝點要把它排進 `toolOrder` 時用得到。 */
export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode';

/** 指引那一段的名字。 */
export const PLAN_POLICY_SECTION_NAME = 'plan:policy';

/**
 * `exit_plan_mode` 給模型看的描述。
 *
 * 照 dsh 的 schema（`docs/tool-catalog.zh.md` 的 `@deepseek-ai/dsh-plan-mode` 條目）：
 * 只在計劃模式下用、送完整的 markdown、以一個為計劃命名的 `#` 標題開頭、被要求繼續
 * 規劃時反饋會從工具結果回來。
 */
export const EXIT_PLAN_MODE_DESCRIPTION =
  '只在計劃模式下使用。提交計劃供人評審，獲准後離開計劃模式。' +
  '送完整的 Markdown 計劃，以一個為計劃命名的 # 標題開頭。' +
  '對方可以批准（從你的下一步起執行），也可以要求你繼續規劃——' +
  '那時反饋會從這個工具的結果回來，改完再提交一次。';

/** 模式外呼叫 `exit_plan_mode` 時回給模型的話。 */
export const NOT_IN_PLAN_MODE_MESSAGE = `現在不在計劃模式，${EXIT_PLAN_MODE_TOOL_NAME} 沒有東西可以離開，所以沒有執行。`;

/**
 * 這一份組裝沒接會話日誌：就算獲准，模式也寫不下來，所以**不送審**。
 *
 * 排在問人之前：問了、人按了同意、模式卻關不掉，是讓人白答一次。也不能回
 * {@link NOT_IN_PLAN_MODE_MESSAGE}——它明明在計劃模式裡。
 */
export const PLAN_NOT_ATTACHED_TOOL_MESSAGE =
  '計劃模式沒有接上會話日誌，就算獲准也關不掉模式，所以沒有送審。這是組裝的問題，不是計劃的問題。';

/** 計劃不是以 `#` 標題開頭。照 dsh，在問人之前擋。 */
export const PLAN_HEADING_REQUIRED_MESSAGE = `${EXIT_PLAN_MODE_TOOL_NAME} 要一份非空的 Markdown 計劃，以一個 # 標題開頭。`;

/** 沒有人可以回答。照 dsh「沒有提問通道就拋錯，請使用者自己切模式」。 */
export const PLAN_NO_REVIEWER_MESSAGE =
  '沒有提問通道可以審這份計劃（這個 session 沒有人在回答問題）。請使用者自己切換模式：/plan off。';

/**
 * 宿主沒有指定答題者（`approvalChannel` 服務的 `current()` 是 `undefined`）。**不當作有人在**：同 `@nexus/plugin-ask-user` 的 `NO_CHANNEL_MESSAGE`
 * （#669），在問人之前拒絕。
 */
export const PLAN_NO_CHANNEL_MESSAGE = `這次組裝沒有指定問答管道，${EXIT_PLAN_MODE_TOOL_NAME} 不知道該問誰，所以沒有送審。這不是有人拒絕了計劃——是沒有被問到。請使用者自己切換模式：/plan off。`;

/** 計劃被同意時回給模型的話。模式在下一個模型步驟之前才關，見檔頭。 */
export const PLAN_APPROVED_MESSAGE = '計劃已獲准，離開計劃模式；從你的下一步起照計劃執行。';

/** 審核那一題的 id。照 dsh 的 `REVIEW_ID`。 */
export const PLAN_REVIEW_QUESTION_ID = 'plan-review';

/** 審核那一題的短標題。 */
export const PLAN_REVIEW_HEADER = '計劃審核';

/** 審核那一題問的話。 */
export const PLAN_REVIEW_QUESTION = '同意這份計劃並離開計劃模式？';

/** 同意的那個選項。**`intent.approve` 就是它**，UI 用名字認同意，不用位置。 */
export const PLAN_APPROVE_LABEL = '同意';

/** 繼續規劃的那個選項。 */
export const PLAN_KEEP_PLANNING_LABEL = '繼續規劃';

/** 選了繼續規劃、沒有寫意見。 */
export const PLAN_KEEP_PLANNING_MESSAGE = '使用者選擇繼續規劃；修改計劃後再提交一次。';

/**
 * 選了繼續規劃（或自由作答）時回給模型的話，帶著使用者的意見。
 *
 * @param feedback - 使用者寫的那句；空的時候是 {@link PLAN_KEEP_PLANNING_MESSAGE}。
 */
export function planFeedbackMessage(feedback: string): string {
  return feedback === ''
    ? PLAN_KEEP_PLANNING_MESSAGE
    : `使用者選擇繼續規劃；使用者的意見：${feedback}`;
}

/**
 * 人關掉了這一題、要用自己的話回覆。**正常收尾這一輪，不是失敗、不是中止**：工具回成功結果，這一批工具跑完之後這一輪就收，
 * 不再叫一次模型（{@link EXIT_PLAN_MODE_CONCLUDES_TURN}）；下一輪模型讀到的是這一句。
 *
 * 照 dsh（`plan-mode/src/index.ts:331-341`，`1517a4db`）：`ASK_CANCELLED` 時 `exec.concludeTurn()` 並回成功的
 * `{ approved: false }`，模型讀到 `:291-296` 那句 "The user dismissed the plan review to reply in their own words; plan mode
 * remains active."。以前（dsh `477b4f4` 那一版）這裡拋一般 `Error`、這一輪不停（#652 拍板 3），alpha.5 改了，前提跟著變（#1607）。
 *
 * **這句同時寫死在 web 的 `PLAN_REVIEW_DISMISSED_TEXT`（`apps/web/src/lib/plan-review.ts`）**，兩邊必須逐字相同；
 * web 的測試用正則讀這個檔，所以**常數名與單引號字面量的寫法都不能變**（`apps/web/src/lib/plan-review.test.ts`）。
 */
export const PLAN_REVIEW_DISMISSED_MESSAGE =
  '使用者關掉了計劃審核，要用自己的話回覆；計劃模式仍開著。';

/** 這個 plugin 的設定。 */
export const planModeConfigSchema = z.strictObject({
  /**
   * 計劃模式生效時夾進 system prompt 的指引。**必填，`trim()` 後不能是空白**，缺席或空白在載入時失敗
   * （[#1607](https://github.com/DemianLi/nexus-agent/issues/1607)，照 dsh `resolveConfig`，`plan-mode/src/index.ts:97-117`）。
   *
   * **它是部署持有的原樣文本**，照 dsh：這個套件不替部署決定要怎麼講話，所以沒有預設值。出貨的那一句寫在
   * `apps/harness/cordis.yml` 的 `plan-mode` 那一列（以前是這裡的 `DEFAULT_PLAN_GUIDANCE`）：
   * 說清楚現在在計劃模式、先探索與設計、完成後經 `exit_plan_mode` 交出去。
   */
  guidance: z.string().refine((value) => value.trim() !== '', {
    message: 'guidance 不能是空白：部署必須給計劃指引，這個套件沒有預設值',
  }),
  /**
   * **日誌上一顆 `plan/mode` 都沒有時**，這個組裝在不在計劃模式裡。省略即**否**。
   *
   * 模式的真相在日誌上，這一格只是折疊的初值：一份新的會話從它起算，一份續接回來、但上一次
   * 從沒切過模式的會話（例如 v3 寫的檔）也從它起算；**一份日誌上有過 `plan/mode` 的會話，
   * 最後那一顆說了算，這一格管不到**。沒接會話日誌的組裝，模式就一直是這一格。
   *
   * **在沒有人可以回答的入口把它打開，模型交不出計劃。** `exit_plan_mode` 要問人，而 CLI 與
   * `eval/runner.ts` 傳的是 `HEADLESS_APPROVALS`（[#113](https://github.com/DemianLi/nexus-agent/issues/113)），
   * 答題管道在那裡是 `policy-never`，工具確定性地拒絕、請使用者自己切模式。唯一出去的路是
   * 人打 `/plan off`（[#120](https://github.com/DemianLi/nexus-agent/issues/120)）。在 web 上
   * 打開則是「提了計劃、有人按同意」那條正路。
   *
   * **這一格今天剩下的用途是測試**：要走真的那條路而不是直接往日誌裡寫。
   */
  startActive: z.boolean().default(false),
});

/** 驗過的設定。 */
export type PlanModeConfig = z.infer<typeof planModeConfigSchema>;

/** 工廠收的東西：schema 的輸入面，每一格都可以省略。 */
export type PlanModePluginOptions = z.input<typeof planModeConfigSchema>;

/**
 * 從一串事件讀出最後一次的模式。
 *
 * 給讀日誌的人用——CLI 的續接披露、測試。**不看 `session/end-seed`**：模式跨得過那顆
 * 標記，理由見檔頭。
 *
 * @param events - 一份日誌的事件。
 * @returns 最後一顆 `plan/mode` 的值；一顆都沒有時是 `undefined`，由呼叫端決定初值。
 */
export function recordedPlanMode(events: readonly SessionEvent[]): boolean | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'plan/mode') return event.data.active;
  }
  return undefined;
}

/**
 * 接上一份 root 日誌，開始折它的模式。
 *
 * @param subject - 會話參與者拿到的那一份（`thread.join`）。
 * @param startActive - 日誌上沒有 `plan/mode` 時的初值。
 * @returns 這一份日誌上的模式。
 */
function trackPlanMode(subject: SessionSubject, startActive: boolean): PlanModeSession {
  let active = startActive;
  subject.observe((event) => {
    // **刻意不看 `session/end-seed`。** 別的配套入口在那裡重設開關；這一格要熬過它。
    if (event.type === 'plan/mode') active = event.data.active;
  });
  return { log: subject.log, active: () => active };
}

/**
 * 跑一次 `/plan`。
 *
 * **`off` 以外的參數都是進入，非空的部分是要送進對話的話**，同 dsh（見 {@link parsePlanCommandArgs}）。
 * 「`/plan` 的方向與模式一致」這條關係由這個套件配套入口看日誌檢（見 `invariant.ts`）。
 *
 * **排著的待關先丟掉再判**（見檔頭「兩值」那節最後一段）。
 *
 * @param state - 這次掛載的狀態表，丟掉排著的待關用。
 * @param session - 執行器交來的那份日誌上的計劃模式；那份日誌沒接計劃模式時是 `undefined`。
 * @param rawInput - 命令名之後的原文。
 * @param attachments - 這次呼叫收下的附件參照（`CommandInvocation.attachments`，#732）。`/plan off` 帶附件回 `error`；進入時
 *   隨 steer 那句話一起送，**只有附件、沒有字也成立**（dsh `plan-mode/src/index.ts:258-266`）。
 * @param steer - 宿主替命令保管的「命令結束後送一句話」（`CommandInvocation.steer`）。
 * @returns 直接印給人看的結果。
 */
function planCommandResult(
  state: PlanModeState,
  session: PlanModeSession | undefined,
  rawInput: string,
  attachments: readonly AttachmentRef[],
  steer: (text: string, attachments?: readonly AttachmentRef[]) => void,
): CommandResult {
  const request = parsePlanCommandArgs(rawInput);
  if (session === undefined) return { kind: 'error', text: PLAN_NOT_ATTACHED_MESSAGE };
  // 在 steer 與任何寫入之前判：失敗的命令什麼都沒改（見下一段）。
  if (request.kind === 'leave' && attachments.length > 0) {
    return { kind: 'error', text: PLAN_OFF_ATTACHMENTS_MESSAGE };
  }
  // **先 steer，再動任何東西**：宿主可以拒收這句話（例如 `@` 的會話引用不能用），拒收會從這裡拋出去，
  // 命令落定成 `error`，待關與模式都還原封不動。dsh 的順序是先 `set` 再 `steer`；這裡的 steer 只是
  // 排進宿主的佇列（`command/done` 之後才開那一輪），對調順序看不出差別，卻讓「失敗的命令什麼都沒改」成立。
  if (request.kind === 'enter' && (request.message !== undefined || attachments.length > 0)) {
    steer(request.message ?? '', attachments);
  }
  state.dropExit(session);
  const entering = request.kind === 'enter';
  if (session.active() === entering) {
    return {
      kind: 'success',
      text: entering ? PLAN_ALREADY_ACTIVE_MESSAGE : PLAN_ALREADY_INACTIVE_MESSAGE,
    };
  }
  session.log.append('plan/mode', { active: entering });
  return { kind: 'success', text: entering ? PLAN_ENTERED_MESSAGE : PLAN_LEFT_MESSAGE };
}

/**
 * 計劃模式的指引這一段：呼叫者在計劃模式裡才接。
 *
 * **同一份掛在 root 與每個子代理上**（fold 把插件的段與 middleware 一起攤過去，[#327](https://github.com/DemianLi/nexus-agent/issues/327)），
 * 所以先問「這一次是誰」：讀的是**呼叫者自己的** session。子代理的 session 從沒進過計劃模式，所以 root 開著
 * 計劃模式時，子代理照樣拿不到指引。
 *
 * 模式沒生效時這一次不接，**一個 token 都不多**。
 *
 * @param guidance - 模式生效時夾的那一段。
 * @param active - 這一次呼叫的呼叫者在不在計劃模式裡；收的是 `sessionLookup.forCall` 要的那份身分。
 */
function planPolicySection(
  guidance: string,
  active: (call: unknown) => boolean,
): ToolThreadSection {
  return {
    name: PLAN_POLICY_SECTION_NAME,
    order: SECTION_ORDERS.PLAN_POLICY,
    separator: '\n',
    text: (context) => (active(context.call) ? guidance : ''),
  };
}

/** 這一次工具呼叫落在哪一份日誌上——認得出來而且是這個 plugin 接著的 root 那一份才有。 */
type PlanModeLookup =
  | { readonly kind: 'ok'; readonly session: PlanModeSession }
  | { readonly kind: 'not-attached' }
  | { readonly kind: 'not-root' };

/**
 * `exit_plan_mode` 的 `concludesTurn`（[#1607](https://github.com/DemianLi/nexus-agent/issues/1607)、#2353）：宣告「這顆工具可能收這一輪」，
 * 照 dsh 的 `exec.concludeTurn()`（`plan-mode/src/index.ts:331-341`，語意鏈 `agent.ts:361-364`）。轉接器把它轉成 LangChain 工具的 `returnDirect`。
 *
 * **收不收由 core 決定、由工具本體正向標記**（`@nexus/core` 的 `turn-conclusion.ts`，該檔有完整推理）：本體只在關掉審核那一行呼叫
 * `exec.concludeTurn()`；圍堵在最外層對 `returnDirect` 工具的結果，沒標記就拿掉 `name`，基座的 tools 路由（`ReactAgent.js:359-365`，
 * `langchain@1.5.10`，只看最後一則 ToolMessage 的 `name` 在不在 returnDirect 名單）因此不收。所以不論哪一層造的錯誤或拒絕
 * （參數驗不過、核准閘門、`toolPreExecute`、圍堵接住的拋錯，root 與子代理一樣）都照常回頭叫模型，與 dsh 一致。
 *
 * ## 為什麼不是 middleware 的 `beforeModel` 跳 `end`
 *
 * `jumpTo: 'end'` 直達 END，**略過所有 `afterAgent`**：step-inbox 的關窗與接插話、workspace-changes 的輪內記錄都不跑，
 * 改動紀錄只能落在 `turn/end` 之後由補記寫入（dsh 的 `agent/turn-stopping` 是在輪內記）；`next-step` 還有插話時也不會繼續。
 * 走 returnDirect 的 exitNode，`afterAgent` 全部照原本的路。（另一個代價是 `beforeModel` 讓每一步模型呼叫多一個 super-step，
 * 但那是成本，不是理由。）
 *
 * ## 登記的偏離（理由 1：基座表達不出來）
 *
 * dsh 是批內**任何一個**工具 `concludeTurn()` 就收；這裡**只有 `exit_plan_mode` 是那一批唯一的工具呼叫時才收**
 * （`turn-conclusion.ts` 與 `apps/harness/src/returndirect-route.test.ts` 釘住：基座混批會擲 `InvalidUpdateError`）。
 */
export const EXIT_PLAN_MODE_CONCLUDES_TURN = true;

/** `exit_plan_mode` 的參數，`input` 模式（同 {@link NexusTool.parameters}）。 */
const exitPlanModeParameters = z.toJSONSchema(
  z.object({
    plan: z.string().describe('完整的計劃，Markdown，以一個為計劃命名的 # 標題開頭。'),
  }),
  { io: 'input' },
) as NexusTool['parameters'];

/**
 * 造 `exit_plan_mode` 工具（`@nexus/tools` 的 `NexusTool`，#2353）。
 *
 * **先擋、再問、最後才排待關**：
 *
 * 1. 沒接會話日誌 → {@link PLAN_NOT_ATTACHED_TOOL_MESSAGE}。
 * 2. 不在計劃模式、或不是 root 那一份 → {@link NOT_IN_PLAN_MODE_MESSAGE}。
 * 3. 計劃不是以 `#` 標題開頭 → {@link PLAN_HEADING_REQUIRED_MESSAGE}。
 * 4. 組裝點沒提供答題管道 → {@link PLAN_NO_CHANNEL_MESSAGE}；有、但沒有人可以回答 → {@link PLAN_NO_REVIEWER_MESSAGE}。
 * 5. 問一題，照答案落定（三種結局見檔頭）。
 *
 * 每一條拒絕都是 `ok: false`，不是 reject：有兩條發生在 **resume 之後**，那時拋出去的例外會從 LangGraph 的 stream mux 逸出
 * （`@nexus/plugin-ask-user` 實測過同一件事）。都不帶碼。
 *
 * **`exec.interrupt()` 在 `langgraph` 下用拋例外傳播**，只接住「這裡沒有人可以回答」（#2358，回 {@link PLAN_NO_REVIEWER_MESSAGE}），其餘原樣往外拋。`langgraph` resume 時整個本體從頭再跑一次、
 * `exec.interrupt()` 直接回人的答案，所以前面那幾條檢查會再判一次，結果不變（它們讀的東西在兩輪之間動不了：
 * 停在提問上時斜線命令一律拒收，見 `apps/harness` 的 `wire-handler.ts`）。
 *
 * **日誌問的是這次呼叫的 `exec`，不是組裝的閉包**（同 `@nexus/plugin-goal` 的工具，理由見
 * `@nexus/core` 的 `sessions.ts`）。在 subagent 裡被呼叫時，`forCall` 認出來的是那個
 * subagent 自己的日誌，而計劃模式不管那一份。產品組裝上那裡的 middleware 會先擋掉（#327），走不到這裡；
 * 這一格留著，是因為工具本體不該靠 middleware 在場才對。**不標 `rootOnly`**：那會換掉
 * subagent 看到的工具目錄，而 dsh 的「工具目錄不隨模式變動」講的正是這一件。
 *
 * @param lookup - 認這次呼叫的日誌。
 * @param channelOf - 這次呼叫有沒有人可以回答，呼叫當下才問；宿主沒有指定答題者時是 `undefined`。
 * @param queueExit - 同意之後排一格待關。
 * @returns 可以交給 `tools.register()` 的工具。
 */
function createExitPlanModeTool(
  lookup: (exec: ToolExec) => PlanModeLookup,
  channelOf: () => ApprovalChannel | undefined,
  queueExit: (session: PlanModeSession) => void,
): NexusTool {
  const refuse = (content: string): NexusToolResult => ({ ok: false, content });
  return {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description: EXIT_PLAN_MODE_DESCRIPTION,
    parameters: exitPlanModeParameters,
    concludesTurn: EXIT_PLAN_MODE_CONCLUDES_TURN,
    async execute(args, exec) {
      const plan = args.plan as string;
      const found = lookup(exec);
      if (found.kind === 'not-attached') return refuse(PLAN_NOT_ATTACHED_TOOL_MESSAGE);
      if (found.kind === 'not-root' || !found.session.active()) {
        return refuse(NOT_IN_PLAN_MODE_MESSAGE);
      }
      if (!/^#\s+\S/u.test(plan.trim())) return refuse(PLAN_HEADING_REQUIRED_MESSAGE);
      const channel = channelOf();
      if (channel === undefined) return refuse(PLAN_NO_CHANNEL_MESSAGE);
      if (channel.kind !== 'human') return refuse(PLAN_NO_REVIEWER_MESSAGE);

      const payload: QuestionInterruptPayload = {
        kind: QUESTION_INTERRUPT_KIND,
        questions: [
          {
            id: PLAN_REVIEW_QUESTION_ID,
            header: PLAN_REVIEW_HEADER,
            question: PLAN_REVIEW_QUESTION,
            detail: plan,
            options: [
              { label: PLAN_APPROVE_LABEL, description: '離開計劃模式；從下一步起照計劃執行。' },
              { label: PLAN_KEEP_PLANNING_LABEL, description: '留在計劃模式；意見會回給模型。' },
            ],
            // 純呈現用：認得的 UI 畫成審核卡，不認得的照一般提問畫，答的都是上面兩個標籤之一。
            intent: { kind: 'plan-review', approve: PLAN_APPROVE_LABEL, callId: exec.callId },
          },
        ],
      };
      let reply: QuestionReply | undefined;
      try {
        reply = (await exec.interrupt(payload as unknown as JsonValue)) as
          QuestionReply | undefined;
      } catch (error) {
        if (isHumanInputUnavailable(error)) return refuse(PLAN_NO_REVIEWER_MESSAGE);
        throw error;
      }

      // 照 dsh `:331-341`：成功結果，並請這一輪在這一批工具之後收（`exec.concludeTurn()`）。**只有走到這一行才標**——
      // 拋錯、被拒絕、參數不對、核准閘門擋下都不會到這裡，那些結局照常回頭叫模型（{@link EXIT_PLAN_MODE_CONCLUDES_TURN}）。
      if (reply?.cancelled === true) {
        exec.concludeTurn();
        return { ok: true, content: PLAN_REVIEW_DISMISSED_MESSAGE };
      }
      // 照 dsh：剛好一筆審核的答案、只選了同意、沒有自由作答，才算同意。其餘一律是繼續規劃，
      // 看不懂的回覆也是——那時沒有意見可帶，回的是沒有意見的那一句。
      const items = (Array.isArray(reply?.answers) ? reply.answers : []).filter(
        (entry) => entry.id === PLAN_REVIEW_QUESTION_ID,
      );
      const item = items.length === 1 ? items[0] : undefined;
      if (
        item?.selected.length !== 1 ||
        item.selected[0] !== PLAN_APPROVE_LABEL ||
        item.custom !== undefined
      ) {
        return refuse(planFeedbackMessage(item?.custom ?? ''));
      }
      queueExit(found.session);
      return { ok: true, content: PLAN_APPROVED_MESSAGE };
    },
  };
}

/**
 * 掛在一條 thread 上：接上 root 那份日誌、折它的 `plan/mode`，再登記指引那一段。
 *
 * - **會話參與者**（`thread.join`）：**只管 root**，同 goal：模式是人對這個會話選的，subagent 沒有人可以選。接上時把這份日誌的模式登記進
 *   這次掛載的狀態表，退出工具、`/plan` 與 pre-step 監聽者都從那裡讀。
 * - **pre-step 監聽者**（`thread.on('agent/pre-step')`）：交出這條 thread 的 root 日誌排著的待關，見檔頭「模式在下一個模型步驟之前才關」。
 * - **段**（`thread.section`）：指引那一段（{@link PLAN_POLICY_SECTION_NAME}），模式生效才接。段在模型呼叫那一刻才判，在 pre-step 交完待關之後
 *   （#2414）；記憶由基座最內層接，所以照樣在指引後面。
 *
 * 段掛在 root 與每個子代理上（#327），所以先問這一次是誰。三格，**不能收成兩格**：
 * - 認得出來、是這條 thread 接著的 root 那份日誌 → 讀它的模式。
 * - 認得出來、是別的日誌（子代理、別條 thread）→ 不在計劃模式。
 * - 認不出來（沒接日誌、沒有 `checkpoint_ns`、挑不出來）→ 這條 thread 剛好接了一份就讀它，否則退回初值。
 *   不接日誌、開著 `startActive` 的組裝靠這一格夾指引；收成「不在」的話指引會靜靜消失，沒有東西會紅。接了不只一份時不猜：
 *   猜一份的話指引會照著別人的模式夾。
 *
 * @param thread - 這條 thread 的組裝。
 * @param forCall - 認這一次呼叫屬於哪份日誌。
 * @param config - 驗過的設定。
 * @param state - 這次掛載的狀態表。
 * @throws 宿主的 `ToolThread` 沒有 `join`，或 `on` 不收 `agent/pre-step`（`@nexus/tools` 2.11.0 起）。
 */
function mountPlanModeThread(
  thread: ToolThread,
  forCall: (invocation: unknown) => SessionLookup,
  config: PlanModeConfig,
  state: PlanModeState,
): void {
  const { guidance, startActive } = config;
  const { join, on } = thread;
  if (join === undefined || on === undefined) {
    throw new Error(
      'plan-mode 要宿主的 ToolThread 有 join 與收 agent/pre-step 的 on（@nexus/tools 2.11.0 起），這個宿主沒有提供',
    );
  }
  const attachedHere = new Set<PlanModeSession>();
  const sessionsHere = new WeakMap<SessionLog, PlanModeSession>();
  join.call(thread, (value) => {
    const subject = value as SessionSubject;
    if (subject.address.kind !== 'root') return undefined;
    const session = trackPlanMode(subject, startActive);
    const detach = state.attach(session);
    attachedHere.add(session);
    sessionsHere.set(subject.log, session);
    return () => {
      detach();
      sessionsHere.delete(subject.log);
      attachedHere.delete(session);
    };
  });
  const onlyAttached = (): PlanModeSession | undefined => {
    const [only, ...rest] = attachedHere;
    return rest.length === 0 ? only : undefined;
  };
  const fallback = (): boolean => onlyAttached()?.active() ?? startActive;
  // root 那份日誌的 id 就是 thread id；子代理的不是，所以子代理那一步交不出 root 的待關。沒帶 thread id 時同指引那一格：剛好接了一份就是它。
  on.call(thread, 'agent/pre-step', ({ threadId }) => {
    const session =
      threadId === undefined
        ? onlyAttached()
        : [...attachedHere].find((each) => each.log.sessionId === threadId);
    if (session !== undefined) state.settleExit(session.log);
  });
  const active = (call: unknown): boolean => {
    const found = forCall(call);
    if (found.kind !== 'ok') return fallback();
    return sessionsHere.get(found.log)?.active() ?? false;
  };
  thread.section(planPolicySection(guidance, active));
}

/** {@link mountPlanMode} 要宿主給的東西。 */
export interface PlanModeMountHost {
  /** 登記 `exit_plan_mode`。 */
  registerTool(tool: NexusTool): void;
  /** 登記 `/plan`。 */
  registerCommand(definition: CommandDefinition): void;
  /** 登記逐條 thread 的來源。 */
  threadSource(source: ToolThreadSource): void;
  /** 這一次呼叫屬於哪份日誌；呼叫當下才問，傳的是整份呼叫身分。 */
  forCall(invocation: unknown): SessionLookup;
  /** 這一次有沒有人可以回答；呼叫當下才問。 */
  channel(): ApprovalChannel | undefined;
}

/**
 * 把計劃模式掛上去。**樹上那一列（{@link apply}）與相容層的測試外殼共用這一份**，兩邊只差宿主那幾格怎麼接。
 *
 * - **逐條 thread**：會話參與者與指引那一段（{@link mountPlanModeThread}）。
 * - **`exit_plan_mode`**：行程級登記（`registerTool`），照工具呈現順序排（不放進相容層 middleware 的 `tools`：那條路不經 `toolOrder`）。**一律註冊，不看模式**：模式沒啟用時它仍留在面向模型的
 *   schema 裡，模式切換不會額外改動工具目錄。代價是模式關著的時候它是活的 schema、死的執行路徑。
 * - **`/plan`**：行程級登記。**命令不進模型**——它是人對工具說的話，結果直接印給打字的人看（`/plan <message>` 的那句話例外：它經
 *   `steer` 成為命令落定後的一輪人話）。要動哪一份日誌由執行器交過來（`CommandInvocation.sessionLog`）。
 *
 * **不註冊核准閘門**（[#652](https://github.com/DemianLi/nexus-agent/issues/652)）：
 * 交出計劃走提問通道，見檔頭。
 *
 * @param host - 登記處、會話查找與答題管道。
 * @param config - 驗過的設定。
 */
export function mountPlanMode(host: PlanModeMountHost, config: PlanModeConfig): void {
  const state = createPlanModeState();
  host.threadSource((thread) => {
    mountPlanModeThread(thread, (invocation) => host.forCall(invocation), config, state);
  });
  host.registerTool(
    createExitPlanModeTool(
      (exec) => {
        const found = host.forCall(exec);
        if (found.kind === 'not-attached') return { kind: 'not-attached' };
        if (found.kind !== 'ok') return { kind: 'not-root' };
        const session = state.sessionOf(found.log);
        return session === undefined ? { kind: 'not-root' } : { kind: 'ok', session };
      },
      () => host.channel(),
      (session) => state.queueExit(session),
    ),
  );
  host.registerCommand({
    name: PLAN_COMMAND_NAME,
    description: PLAN_COMMAND_DESCRIPTION,
    input: { hint: PLAN_COMMAND_HINT, attachments: true },
    handler: ({ rawInput, attachments, steer, sessionLog }) =>
      planCommandResult(state, state.sessionOf(sessionLog), rawInput, attachments, steer),
  });
}

/** 插件在樹上的列用的名字。 */
export const name = 'plan-mode';

/**
 * 要的服務：`tools`（`^2.11.0`，`thread.on` 收 `agent/pre-step`）、`commands`、`sessionLookup` 與 `approvalChannel`。範圍在這裡宣告，經
 * `Service.resolveIntercept` 合併，提供者的 `check` 讀得到。
 */
export const inject = injectOf(
  need(toolsToken, '^2.11.0'),
  need(commandsToken, '^1.0.0'),
  need(sessionLookupToken, '^1.0.0'),
  need(approvalChannelToken, '^1.0.0'),
);

/** 這個插件的設定：見 {@link planModeConfigSchema}。`strictObject`：未知欄位讓載入失敗。 */
export const Config = planModeConfigSchema;

export const manifest = defineManifest({
  id: 'plan-mode',
  version: '0.6.0',
  owner: '平台團隊',
  provides: [],
  consumes: [
    { token: toolsToken.name, range: '^2.11.0' },
    { token: commandsToken.name, range: '^1.0.0' },
    { token: sessionLookupToken.name, range: '^1.0.0' },
    { token: approvalChannelToken.name, range: '^1.0.0' },
  ],
  config: Config,
  // 換程式碼要重啟行程；設定一改，下一條 thread 看到新的指引，開著的不動。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * 行程級的那一次：四個服務抓進閉包（列卸載之後經 `ctx` 取服務會拋，抓住的那份仍可呼叫），交給 {@link mountPlanMode}。
 *
 * @param ctx - 這一列的 context。
 * @param config - 驗過的設定。
 * @throws 宿主的工具接縫沒有 `threadSource`。
 */
export function apply(ctx: Context, config: PlanModeConfig): void {
  const tools = service(ctx, toolsToken);
  const commands = service(ctx, commandsToken);
  const sessions = service(ctx, sessionLookupToken);
  const channel = service(ctx, approvalChannelToken);
  const { threadSource } = tools;
  if (threadSource === undefined) {
    throw new Error('plan-mode 要宿主的 tools.threadSource()，這個宿主沒有提供');
  }
  mountPlanMode(
    {
      registerTool: (tool) => void tools.register(tool),
      registerCommand: (definition) => void commands.register(definition),
      threadSource: (source) => void threadSource.call(tools, source),
      forCall: (invocation) => sessions.forCall(invocation),
      channel: () => channel.current(),
    },
    config,
  );
}

declare module '@nexus/core' {
  interface SessionEventMap {
    /**
     * 計劃模式這一刻開著還是關著——**整份值，不是切換**，最後一顆就是答案
     * （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的第二刀）。
     *
     * 照 dsh 的 `plan/mode`（`packages/plan/plan-mode/src/index.ts`，`d347e70`）：`{ active }`。
     * 寫者兩個，都只寫 **root** 那一份：`/plan` 的 handler（人）與 `exit_plan_mode`（模型，
     * 計劃獲准之後；照 dsh 排到下一步請求組起來之前才寫，[#652](https://github.com/DemianLi/nexus-agent/issues/652)）。
     * 折疊它的是 `@nexus/plugin-plan-mode` 自己。
     *
     * **它是第一顆要熬過 `session/end-seed` 的狀態。** 那顆標記之前的開頭屬於上一個生命週期，
     * 讀「當前這一段」的人要在那裡重設；這一顆相反——跨重啟留得住正是它搬進日誌的理由，所以
     * 折疊它的人**不**在 end-seed 歸零。
     */
    'plan/mode': { readonly active: boolean };
  }
}
