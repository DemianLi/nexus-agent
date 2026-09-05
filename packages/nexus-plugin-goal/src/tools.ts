/**
 * 模型側的那一半：`get_goal`、`create_goal`、`update_goal`。
 *
 * 形狀照 dsh 的 `@deepseek-ai/dsh-tool-goal`
 * （`references/deepseek-harness/packages/goal/tool-goal/src/index.ts`，對讀版本
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`，2026-09-04）。`/goal` 是人的那一半，
 * 這裡是模型的那一半，**兩邊改的是同一份域狀態**。
 *
 * ## 四件登記為缺，不是移植成惰性程式碼
 *
 * dsh 自己在 README 的「已知限制」裡寫著：「**Goal Round 權限需要驅動器**——除非續行
 * 驅動器準入 goal 來源的用戶輪次，否則自主 `complete`／`blocked` 路徑不會啟用；只掛載
 * 這個包不會創建這些輪次。」[#152](https://github.com/DemianLi/nexus-agent/issues/152)
 * 決議先不做驅動器，所以下面四件在我們的範圍內**一個生產者都沒有**。措辭照 `service.ts`
 * 檔頭寫 `GOAL_AGENT_NOT_LIVE` 那一段的先例：**是缺，不是省略**——驅動器那張卡落地時，
 * 四件跟著它一起回來。
 *
 * | dsh 的東西 | 為什麼沒有生產者 |
 * | --- | --- |
 * | `completionAuthority` 的 `goal-round` 分支 | 沒有 goal 來源的輪次可以比對 |
 * | `blockedAfterConsecutiveRounds`（預設 3） | 沒有連續自主輪次可以數 → **不收這個配置欄** |
 * | `wrapup.ts` 的 `<goal_complete>`／`<goal_blocked>` | 只在**自主**變更後延後注入 |
 * | `GOAL_TOOL_DRIVER_REQUIRED` 的「開放輪次」檢查 | 結構上恆真——工具只跑得到已經 append 過 `turn/start` 的那一次 `invoke` 裡 |
 *
 * `complete` 與 `blocked` 本身**留著**：dsh 明說「人類直接請求可以立即停止 goal」，那條
 * 路只要直接人類授權就走得通。
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
 * **兩句沒有照抄，因為它們描述我們沒有的機制**：
 *
 * - 「at least 3 consecutive goal rounds」——沒有輪次可數（見上表第 2 列）。
 * - 「After session resume or fork, an active goal is disarmed…」——我們的 disarm 邊界
 *   不是 dsh 的那一個，照抄會叫模型去做一件對不上的事。
 *
 * 這是模型看得到的文字，**一句寫錯的代價比一個沒實作的分支大**。
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

import { hasDirectHumanTurn } from './authority.js';
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
  'Read the current session goal: its exact id and revision, objective, phase, round limit, ' +
  'blocker reason when present, and whether continuation is armed. Returns {"goal":null} when ' +
  'there is none. Call this before update_goal and copy its exact goal_id and revision.';

const CREATE_DESCRIPTION =
  'Create the one long-running completion objective for this session, when the current direct ' +
  'human request is such an objective. You may infer that intent from the request in any ' +
  'language; the user does not have to say "create a goal". Do not create a goal for routine ' +
  'single-turn work. Requires a direct human turn on the top-level agent.';

const UPDATE_DESCRIPTION =
  'Update the exact current goal revision. Call get_goal first and copy its goal_id and ' +
  'revision. Mark complete only when the objective is actually achieved. Mark blocked only for ' +
  'a concrete blocking condition you report in blocked_reason; difficulty, uncertainty, or ' +
  'useful remaining work is not blocked. Every action requires a direct human turn on the ' +
  'top-level agent.';

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
export function createGoalTools(wiring: GoalToolWiring): readonly ReturnType<typeof tool>[] {
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
          .describe('Optional positive integer cap on continuation rounds.'),
      }),
    },
  );

  const update = tool(
    (args: UpdateArgs, config?: unknown) => {
      const found = resolve(wiring, config);
      if (found.kind === 'refused') return refuse(found.message);
      if (!hasDirectHumanTurn(found.log.events)) return refuse(GOAL_TOOL_AUTHORITY_MESSAGE);
      const ref = toRef(args.goal_id, args.revision);
      if (ref === undefined) return refuse(GOAL_TOOL_INVALID_REF_MESSAGE);
      const wrong = misplaced(args);
      if (wrong !== undefined) return refuse(wrong);
      const service = found.service;
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
      description: UPDATE_DESCRIPTION,
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
          .describe('Replacement round cap; valid only with action edit.'),
        blocked_reason: z
          .string()
          .optional()
          .describe('Concrete blocking condition; required only with action blocked.'),
      }),
    },
  );

  return [get, create, update] as readonly ReturnType<typeof tool>[];
}
