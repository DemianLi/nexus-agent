/**
 * 模型側的那一半：`get_goal`、`create_goal`、`update_goal`。
 *
 * 形狀照 dsh 的 `@deepseek-ai/dsh-tool-goal`
 * （`references/deepseek-harness/packages/goal/tool-goal/src/index.ts`，對讀版本
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`，2026-09-04）。`/goal` 是人的那一半，
 * 這裡是模型的那一半，**兩邊改的是同一份域狀態**。
 *
 * ## 那四件登記為缺的東西，現在三件回來了
 *
 * dsh 在 README 的「已知限制」裡寫著：「**Goal Round 權限需要驅動器**——除非續行驅動器
 * 準入 goal 來源的用戶輪次，否則自主 `complete`／`blocked` 路徑不會啟用；只掛載這個包
 * 不會創建這些輪次。」[#177](https://github.com/DemianLi/nexus-agent/issues/177) 落地時
 * 那個生產者不存在，所以四件全登記為缺。[#180](https://github.com/DemianLi/nexus-agent/issues/180)
 * 把生產者做出來了，這張表因此要重讀一遍——**逐列問「現在有生產者了嗎」**：
 *
 * | dsh 的東西 | 今天 |
 * | --- | --- |
 * | `completionAuthority` 的 `goal-round` 分支 | **在了**，見 `authority.ts` |
 * | `blockedAfterConsecutiveRounds`（預設 3） | **在了**，見 {@link GoalToolPolicy} |
 * | `wrapup.ts` 的 `<goal_complete>`／`<goal_blocked>` | **還缺**，見下 |
 * | `GOAL_TOOL_DRIVER_REQUIRED` 的「開放輪次」檢查 | **仍然結構上恆真**——工具只跑得到已經 append 過 `turn/start` 的那一次 `invoke` 裡。這一列不是「做好了」，是「不需要」 |
 *
 * **`wrapup.ts` 是這張卡刻意沒做的那一件。** 它是一層在 goal 狀態轉換之後、下一次模型
 * 呼叫之前注入 `<goal_complete>`／`<goal_blocked>` 的東西，讓模型知道自己剛剛把目標收
 * 掉了。它與驅動器存不存在無關——缺的是「怎麼把狀態轉換講給模型聽」這條管線，而那是
 * 另一件事。**不是忘了，是拆出去了**；沒有它的後果是：模型在同一輪裡 `complete` 之後，
 * 那一輪剩下的部分不知道目標已經結束。
 *
 * `blockedAfterConsecutiveRounds` 為什麼跟著 `completionAuthority` 一起回來、不能等：
 * 它的門檻**只在 `goal-round` 授權下生效**（dsh 的 `index.ts:299`），所以在這張卡之前
 * 它確實沒有作用面；而這張卡一開那條路，少了它就是**模型第一輪碰壁就可以把自己 block
 * 出迴圈**。它不是一個獨立功能，是那條授權路徑的配套。
 *
 * ## 政策文字住在工具說明裡，不是一個 prompt 章節——這是一筆載體偏離
 *
 * dsh 註冊一個獨立的 `tool:goal` 系統提示詞章節（`ctx.systemPrompt.section`）。我們的
 * `PluginRegistry` **沒有提示詞通道**，唯一的路是像 `@nexus/plugin-plan-mode` 那樣掛一層
 * 改寫 `request.systemPrompt` 的 middleware——為了一段固定文字多一個每輪都跑的鉤子。
 *
 * 所以**載體丟掉、紀律照抄**（同 `containment.ts` 對 `guard/timeout-policy` 那一筆）：
 * 政策文字進三顆工具的 `description`。**順帶解掉 dsh 自己記在 README 開發備注裡的那個
 * 開放問題**——「某個範圍可能隱藏工具，卻保留指引」在這個載體下不可能發生，指引跟著
 * 工具一起出現、一起消失。
 *
 * **當初兩句沒有照抄，現在一句回來一句照樣不抄**：
 *
 * - 「at least N consecutive goal rounds」——**回來了**。機制回來，句子就得回來，不然
 *   模型會撞上一道沒有人告訴過它的門檻。N 由 {@link GoalToolPolicy} 決定，所以這句是
 *   算出來的不是寫死的。
 * - 「After session resume or fork, an active goal is disarmed…」——**照樣不抄**，而且
 *   理由跟驅動器從來無關：那句話要求模型在恢復之後主動 `resume` 重新授權，而我們
 *   **沒有回讀路徑**（[#172](https://github.com/DemianLi/nexus-agent/issues/172) 的
 *   seeded／rehydrate 明著沒做），所以「相位 active 但 activation 是 disarmed」這個狀態
 *   走不到。有回讀那天它才該回來。
 *
 * 這是模型看得到的文字，**一句寫錯的代價比一個沒實作的分支大**。
 *
 * ## 同一條規則也管 schema，不是只管那段政策文字
 *
 * 「輪次」這個詞在**參數與輸出**上也出現，而它們描述的是同一個沒有生產者的機制：
 *
 * - `max_goal_rounds`（`create_goal` 的參數、`edit` 的替換值、輸出的一格）——**現在真的
 *   會到**：排程器每排一輪就燒掉一格，用完記一顆 `round-limit` 的 blocker。當初那句
 *   「it is never reached」是這張卡要改回來的三處之一。
 * - `roundsStarted`——**現在是活的**：被準入的每一輪推進它。當初那句「stays 0」同上。
 * - `activation`——即時觀察值，`GoalService` 從 `disarmed` 開始，而**重放不會重新授權**。
 *   這一格**沒有變**：今天仍然沒有回讀路徑（見上面那句照樣不抄的理由），所以「相位
 *   active 但 activation 是 disarmed」這個狀態仍然走不到。
 *
 * **這三格是 `model-facing-surface-is-more-than-prose` 那條規則的作用面**：丟掉或改寫
 * 一句政策文字時，schema 的 `describe` 與輸出欄位要一起掃過，它們同樣是模型讀得到的。
 *
 * ## 拒絕走「回一句話」，不走拋
 *
 * 同 `todo_write` 的先例（`@nexus/plugin-todo` 的 `TODO_ERROR_PREFIX` 那段）：預期得到的
 * 拒絕（權限不足、CAS 過期、參數配錯 action）回一句話給模型；**壞掉**（折疊失敗那種
 * 裸 `Error`）照樣往外拋，讓 `containment.ts` 分類——兩者在日誌與遙測上是不同的東西。
 *
 * @module
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { goalId } from '@nexus/core';
import type { GoalRef, SessionLog } from '@nexus/core';

import { completionAuthority, hasDirectHumanTurn } from './authority.js';
import type { GoalToolAuthority } from './authority.js';
import { GoalError } from './service.js';
import type { GoalService, GoalView } from './service.js';

/** 讀當前目標。名字照 dsh，**模型面的名字不是我們可以本地化的東西**。 */
export const GOAL_GET_TOOL_NAME = 'get_goal';
/** 建立目標。 */
export const GOAL_CREATE_TOOL_NAME = 'create_goal';
/** 對精確修訂號做一次變更。 */
export const GOAL_UPDATE_TOOL_NAME = 'update_goal';

/** 預期得到的拒絕前綴。逐字同 `@nexus/plugin-todo`。 */
export const GOAL_TOOL_ERROR_PREFIX = 'Error: ';

/** 這次組裝沒接會話日誌時回的話。 */
export const GOAL_TOOL_NOT_ATTACHED_MESSAGE =
  '這次組裝沒有接上會話日誌，goal 域沒有地方住，所以沒有動。';

/** 認不出呼叫者時回的話。 */
export const GOAL_TOOL_UNKNOWN_CALLER_MESSAGE =
  '認不出這次呼叫屬於哪一個會話，找不到要動的目標，所以沒有動。';

/**
 * 找得到日誌、卻沒有 goal 域接在它上面時回的話。
 *
 * **subagent 走的就是這一條**——域只接 root（`index.ts` 裡 `subject.address.kind` 那一
 * 格），所以一份 subagent 日誌查出來本來就沒有服務。這句話對它是**字面上準確的**，不是
 * 借用來的錯誤。產品路徑上到不了這裡：工具是 `rootOnly` 註冊的，subagent 那一份早就被
 * 換成拒絕樁了。
 */
export const GOAL_TOOL_NO_SERVICE_MESSAGE = '這一份會話上沒有接 goal 域，所以沒有動。';

/**
 * 一次組裝綁著多份會話時回的話。
 *
 * @param count - 查出來的份數。
 * @returns 那一句話。
 */
export function goalToolAmbiguousMessage(count: number): string {
  return `這次組裝接了 ${count} 份會話，挑不出該動哪一份，所以沒有動。`;
}

/** 權限不足時回的話。語意照 dsh 的 `requireDirectHuman`。 */
export const GOAL_TOOL_AUTHORITY_MESSAGE =
  '這個操作要一則人類直接發出的訊息，而這一輪追不到，所以沒有動。';

/** `goal_id` 或 `revision` 不成形時回的話。 */
export const GOAL_TOOL_INVALID_REF_MESSAGE =
  'goal_id 要非空、revision 要正整數——先呼叫 get_goal 照抄那兩格。';

/** `objective` 或 `max_goal_rounds` 配在 `edit` 以外的 action 上時回的話。 */
export const GOAL_TOOL_REPLACEMENT_MISPLACED_MESSAGE =
  'objective 與 max_goal_rounds 只能配 action edit。';

/** `blocked_reason` 配在 `blocked` 以外的 action 上時回的話。 */
export const GOAL_TOOL_REASON_MISPLACED_MESSAGE = 'blocked_reason 只能配 action blocked。';

/** `blocked` 沒帶理由時回的話。 */
export const GOAL_TOOL_REASON_REQUIRED_MESSAGE = 'action blocked 一定要帶 blocked_reason。';

/** 模型自己報的 block 用這個 code 落庫。逐字照 dsh。 */
export const GOAL_MODEL_REPORTED_CODE = 'model-reported';

/**
 * 模型在**自己排的輪次裡**至少要撞同一堵牆幾輪才准報阻塞。照抄 dsh 的 3。
 *
 * **它只管 `goal-round` 授權那條路。** 人直接叫停一律立刻生效——dsh 明說「人類直接請求
 * 可以立即停止 goal」，而一個人不需要向自己證明卡了三輪。
 */
export const DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS = 3;

/** 這三顆工具自己的政策，與域的設定分開。 */
export interface GoalToolPolicy {
  /** 見 {@link DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS}。省略即那個值。 */
  readonly blockedAfterConsecutiveRounds?: number;
}

/**
 * 政策**在建 plugin 的時候就驗**，同 `service.ts` 的 `assertGoalServiceOptions`：設定
 * 錯誤要炸在設定的地方，不是拖到某一次工具呼叫。
 *
 * @param policy - 未經檢查的政策。
 * @returns 補完預設的政策。
 * @throws `blockedAfterConsecutiveRounds` 不是正的安全整數。
 */
export function resolveGoalToolPolicy(policy: GoalToolPolicy = {}): Required<GoalToolPolicy> {
  const blockedAfter =
    policy.blockedAfterConsecutiveRounds ?? DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS;
  if (!Number.isSafeInteger(blockedAfter) || blockedAfter < 1) {
    // **`TypeError` 而不是 `GoalError`**，照 dsh 的 `resolveConfig`：`GoalErrorCode` 是
    // **域**對讀與變更的分類，而這是一個組裝設定錯誤，不是誰對一個目標做錯了什麼。
    throw new TypeError('blockedAfterConsecutiveRounds 必須是正的安全整數');
  }
  return { blockedAfterConsecutiveRounds: blockedAfter };
}

/**
 * 模型在自己的輪次裡太早報阻塞時回的話。
 *
 * @param threshold - 政策要求的連續輪數。
 * @param round - 現在是第幾輪。
 * @returns 那一句話。
 */
export function goalToolBlockTooSoonMessage(threshold: number, round: number): string {
  return `在自己排的輪次裡報 blocked 至少要連續 ${threshold} 輪撞到同一件事，現在是第 ${round} 輪，所以沒有動。`;
}

/** `complete`／`blocked` 兩條授權都不成立時回的話。語意照 dsh 的 `completionAuthority`。 */
export const GOAL_TOOL_COMPLETION_AUTHORITY_MESSAGE =
  '這個操作要一則人類直接發出的訊息、或是這個目標當前的續行輪次，兩者這一輪都追不到，所以沒有動。';

/** 三顆工具共用的緊湊輸出。`activation` 是即時觀察值，**永遠不是回放的權限依據**。 */
export type GoalToolValue =
  | { readonly goal: null }
  | {
      readonly goal: {
        readonly id: string;
        readonly revision: number;
        readonly objective: string;
        readonly phase: GoalView['phase'];
        readonly roundsStarted: number;
        readonly maxGoalRounds: number;
        readonly blockedReason?: { readonly code: string; readonly message: string };
      };
      readonly activation: GoalView['activation'];
    };

/**
 * 把一份視圖收斂成模型看得到的那一份。
 *
 * @param goal - 目前的視圖，沒有目標時是 `undefined`。
 * @returns 緊湊輸出。
 */
export function goalToolValue(goal: GoalView | undefined): GoalToolValue {
  if (goal === undefined) return { goal: null };
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined
        ? {}
        : {
            blockedReason: {
              code: goal.blockedReason.code,
              message: goal.blockedReason.message,
            },
          }),
    },
    activation: goal.activation,
  };
}

/** 一次呼叫解出來的東西，或一句說得出原因的拒絕。 */
type Resolution =
  | { readonly kind: 'ok'; readonly service: GoalService; readonly log: SessionLog }
  | { readonly kind: 'refused'; readonly message: string };

/** 工具要問的兩件事：這次呼叫屬於哪一份日誌，那份日誌上有沒有 goal 域。 */
export interface GoalToolWiring {
  /** 照 `registry.sessions.forCall`。 */
  forCall(config: unknown): GoalToolLookup;
  /** 這一次組裝接上的服務，依日誌查。 */
  serviceFor(log: SessionLog): GoalService | undefined;
}

/** {@link GoalToolWiring.forCall} 的四種結果，同 `@nexus/core` 的 `SessionLookup`。 */
export type GoalToolLookup =
  | { readonly kind: 'ok'; readonly log: SessionLog }
  | { readonly kind: 'not-attached' }
  | { readonly kind: 'unknown-caller' }
  | { readonly kind: 'ambiguous'; readonly count: number };

/** 解出這次呼叫要動的服務。 */
function resolve(wiring: GoalToolWiring, config: unknown): Resolution {
  const found = wiring.forCall(config);
  if (found.kind === 'not-attached') {
    return { kind: 'refused', message: GOAL_TOOL_NOT_ATTACHED_MESSAGE };
  }
  if (found.kind === 'unknown-caller') {
    return { kind: 'refused', message: GOAL_TOOL_UNKNOWN_CALLER_MESSAGE };
  }
  if (found.kind === 'ambiguous') {
    return { kind: 'refused', message: goalToolAmbiguousMessage(found.count) };
  }
  const service = wiring.serviceFor(found.log);
  if (service === undefined) {
    return { kind: 'refused', message: GOAL_TOOL_NO_SERVICE_MESSAGE };
  }
  return { kind: 'ok', service, log: found.log };
}

/** 把一句拒絕包成模型收得到的形狀。 */
function refuse(message: string): string {
  return GOAL_TOOL_ERROR_PREFIX + message;
}

/** 域拋出來的可預期拒絕轉成一句話；其他的照原樣往外拋，見檔頭。 */
function runDomain(work: () => GoalToolValue): GoalToolValue | string {
  try {
    return work();
  } catch (error: unknown) {
    if (error instanceof GoalError) return refuse(error.message);
    throw error;
  }
}

/** 輸出永遠是一行緊湊 JSON；拒絕是一句話。 */
function render(value: GoalToolValue | string): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** 嚴格 schema 下的空字串等同沒給，同 dsh 的 `hasText`。 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/** 嚴格 schema 下的 0 等同沒給，同 dsh 的 `hasRoundCap`。 */
function hasRoundCap(value: number | undefined): value is number {
  return value !== undefined && value !== 0;
}

/** 造一顆 CAS 身分；不成形就回 `undefined` 讓呼叫端說話。 */
function toRef(rawId: string, revision: number): GoalRef | undefined {
  if (rawId.length === 0 || rawId !== rawId.trim()) return undefined;
  if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
  return { id: goalId(rawId), revision };
}

const GET_DESCRIPTION =
  'Read the current session goal: its exact id and revision, objective, phase, round cap, ' +
  'rounds started so far, and blocker reason when present. Returns {"goal":null} when there ' +
  'is none. Call this before update_goal and copy its exact goal_id and revision. When ' +
  'automatic continuation is enabled, an active goal is given further rounds in this same ' +
  'session until it is completed, blocked, or reaches maxGoalRounds.';

const CREATE_DESCRIPTION =
  'Create the one long-running completion objective for this session, when the current direct ' +
  'human request is such an objective. You may infer that intent from the request in any ' +
  'language; the user does not have to say "create a goal". Do not create a goal for routine ' +
  'single-turn work. Requires a direct human turn on the top-level agent.';

/**
 * `update_goal` 的說明**是算出來的**，因為 block 門檻是設定值。
 *
 * @param blockedAfter - 政策要求的連續輪數。
 * @returns 那一段說明。
 */
function updateDescription(blockedAfter: number): string {
  return (
    'Update the exact current goal revision. Call get_goal first and copy its goal_id and ' +
    'revision. Mark complete only when the objective is actually achieved. Mark blocked only ' +
    'for a concrete blocking condition you report in blocked_reason; difficulty, uncertainty, ' +
    'or useful remaining work is not blocked. Inside a continuation round, mark blocked only ' +
    `after the same blocking condition has persisted for at least ${blockedAfter} consecutive ` +
    'rounds. Actions complete and blocked accept either a direct human turn or the current ' +
    'continuation round; edit, pause, and resume always require a direct human turn on the ' +
    'top-level agent.'
  );
}

const UPDATE_ACTIONS = ['edit', 'pause', 'resume', 'complete', 'blocked'] as const;

/** `update_goal` 收得下的動作。 */
export type GoalUpdateAction = (typeof UPDATE_ACTIONS)[number];

interface UpdateArgs {
  readonly goal_id: string;
  readonly revision: number;
  readonly action: GoalUpdateAction;
  readonly objective?: string;
  readonly max_goal_rounds?: number;
  readonly blocked_reason?: string;
}

/** 這兩個 action 收得下當前續行輪次；其餘四個只收直接人類。 */
function isCompletionAction(action: GoalUpdateAction): boolean {
  return action === 'complete' || action === 'blocked';
}

/**
 * 這一次 `update_goal` 拿得到什麼授權。
 *
 * **讀目前那份視圖是為了比對輪次身分**，所以它得在授權判斷之前拿到。折疊壞掉時
 * `get()` 會拋，那條路照舊往外走給 `runDomain`／`containment` 分類——一個讀不出目標的
 * 會話沒有辦法回答「這一輪是不是它的續行輪次」。
 *
 * @param action - 這一次要做的事。
 * @param service - 這一份日誌上的域。
 * @param events - 這一份日誌到目前為止的事件。
 * @returns 拿到的授權，兩條都不成立時是 `undefined`。
 */
function authorityFor(
  action: GoalUpdateAction,
  service: GoalService,
  events: SessionLog['events'],
): GoalToolAuthority | undefined {
  if (!isCompletionAction(action)) {
    return hasDirectHumanTurn(events) ? { kind: 'direct-human' } : undefined;
  }
  return completionAuthority(events, service.get());
}

/** 一次 `update_goal` 的參數配得對不對；不對就回那一句話。 */
function misplaced(args: UpdateArgs): string | undefined {
  const hasReplacement = hasText(args.objective) || hasRoundCap(args.max_goal_rounds);
  if (hasReplacement && args.action !== 'edit') return GOAL_TOOL_REPLACEMENT_MISPLACED_MESSAGE;
  if (hasText(args.blocked_reason) && args.action !== 'blocked') {
    return GOAL_TOOL_REASON_MISPLACED_MESSAGE;
  }
  if (args.action === 'blocked' && !hasText(args.blocked_reason)) {
    return GOAL_TOOL_REASON_REQUIRED_MESSAGE;
  }
  return undefined;
}

/**
 * 造這三顆工具。
 *
 * @param wiring - 找日誌與找服務的兩條路，由組裝點的 `apply` 綁上去。
 * @returns 依 `get`／`create`／`update` 順序的三顆工具。
 */
export function createGoalTools(
  wiring: GoalToolWiring,
  policy: GoalToolPolicy = {},
): readonly ReturnType<typeof tool>[] {
  const { blockedAfterConsecutiveRounds } = resolveGoalToolPolicy(policy);
  const get = tool(
    (_args: Record<string, never>, config?: unknown) => {
      const found = resolve(wiring, config);
      if (found.kind === 'refused') return refuse(found.message);
      return render(runDomain(() => goalToolValue(found.service.get())));
    },
    { name: GOAL_GET_TOOL_NAME, description: GET_DESCRIPTION, schema: z.object({}) },
  );

  const create = tool(
    (args: { objective: string; max_goal_rounds?: number }, config?: unknown) => {
      const found = resolve(wiring, config);
      if (found.kind === 'refused') return refuse(found.message);
      if (!hasDirectHumanTurn(found.log.events)) return refuse(GOAL_TOOL_AUTHORITY_MESSAGE);
      return render(
        runDomain(() =>
          goalToolValue(
            found.service.create({
              objective: args.objective,
              ...(hasRoundCap(args.max_goal_rounds) ? { maxGoalRounds: args.max_goal_rounds } : {}),
            }),
          ),
        ),
      );
    },
    {
      name: GOAL_CREATE_TOOL_NAME,
      description: CREATE_DESCRIPTION,
      schema: z.object({
        objective: z
          .string()
          .describe('The concrete completion objective inferred from the human request.'),
        max_goal_rounds: z
          .number()
          .optional()
          .describe(
            'Optional positive integer cap on continuation rounds. Reaching it blocks the ' +
              'goal, so size it to the work rather than leaving it to the default.',
          ),
      }),
    },
  );

  const update = tool(
    (args: UpdateArgs, config?: unknown) => {
      const found = resolve(wiring, config);
      if (found.kind === 'refused') return refuse(found.message);
      const service = found.service;
      // **授權按 action 分兩條**（見 `authority.ts` 的 `completionAuthority`）：只有
      // `complete`／`blocked` 收得下當前續行輪次，其餘四個一律要人。
      //
      // **它排在參數檢查之前**，照 dsh 的順序：一個沒有授權的呼叫不該從錯誤訊息裡讀出
      // 「你的參數哪裡配錯了」——那是在教一個不該動的呼叫方怎麼把呼叫修對。
      const authority = authorityFor(args.action, service, found.log.events);
      if (authority === undefined) {
        return refuse(
          isCompletionAction(args.action)
            ? GOAL_TOOL_COMPLETION_AUTHORITY_MESSAGE
            : GOAL_TOOL_AUTHORITY_MESSAGE,
        );
      }
      const ref = toRef(args.goal_id, args.revision);
      if (ref === undefined) return refuse(GOAL_TOOL_INVALID_REF_MESSAGE);
      const wrong = misplaced(args);
      if (wrong !== undefined) return refuse(wrong);
      // 太早報阻塞。**只在自己排的輪次裡擋**——人叫停一律立刻生效。
      if (
        args.action === 'blocked' &&
        authority.kind === 'goal-round' &&
        authority.goal.roundsStarted < blockedAfterConsecutiveRounds
      ) {
        return refuse(
          goalToolBlockTooSoonMessage(blockedAfterConsecutiveRounds, authority.goal.roundsStarted),
        );
      }
      return render(
        runDomain(() => {
          switch (args.action) {
            case 'edit':
              return goalToolValue(
                service.edit(ref, {
                  ...(hasText(args.objective) ? { objective: args.objective } : {}),
                  ...(hasRoundCap(args.max_goal_rounds)
                    ? { maxGoalRounds: args.max_goal_rounds }
                    : {}),
                }),
              );
            case 'pause':
              return goalToolValue(service.pause(ref));
            case 'resume':
              return goalToolValue(service.resume(ref));
            case 'complete':
              return goalToolValue(service.complete(ref));
            case 'blocked':
              return goalToolValue(
                service.block(ref, {
                  code: GOAL_MODEL_REPORTED_CODE,
                  message: args.blocked_reason as string,
                }),
              );
          }
        }),
      );
    },
    {
      name: GOAL_UPDATE_TOOL_NAME,
      description: updateDescription(blockedAfterConsecutiveRounds),
      schema: z.object({
        goal_id: z.string().describe('Exact id returned by get_goal.'),
        revision: z.number().describe('Exact positive revision returned by get_goal.'),
        action: z.enum(UPDATE_ACTIONS).describe('edit | pause | resume | complete | blocked'),
        objective: z
          .string()
          .optional()
          .describe('Replacement objective; valid only with action edit.'),
        max_goal_rounds: z
          .number()
          .optional()
          .describe(
            'Replacement round cap; valid only with action edit. Raise it to give a goal that ' +
              'ran out of rounds more; see get_goal for roundsStarted.',
          ),
        blocked_reason: z
          .string()
          .optional()
          .describe('Concrete blocking condition; required only with action blocked.'),
      }),
    },
  );

  return [get, create, update] as readonly ReturnType<typeof tool>[];
}
