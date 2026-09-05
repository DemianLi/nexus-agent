/**
 * 續行排程器的**決策那一半**：一輪收工之後，要不要再排一輪。
 *
 * 形狀照 dsh 的 `packages/goal/goal-round-driver/`（對讀版本
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`，2026-09-04），
 * [#180](https://github.com/DemianLi/nexus-agent/issues/180)。
 *
 * ## 為什麼它落在 `apps/harness` 而不是一個 plugin——一筆登記過的載體偏離
 *
 * dsh 的 driver 是一個 Cordis plugin，靠 `agent/pre-step` 與 `ctx.agents` 的 idle 判斷把
 * 一輪排進 agent 的 inbox。我們的 `PluginRegistry` 十五條通道（`registry.ts:559-572`）
 * **沒有一條排得出一輪**——輪迴圈歸入口點所有（`thread-pump.ts` 的 `#runOnce`、
 * `cli.ts` 的 `runTurn`）。所以載體丟掉、紀律照抄，同 `containment.ts` 對
 * `guard/timeout-policy` 那一筆。
 *
 * **但檢查沒有跟著搬**：續行文字的 renderer 與驗它的不變量伴生都留在
 * `@nexus/plugin-goal`，判準是「只要 `kind: 'goal'` 這個詞彙存在，伴生就武裝」——與有
 * 沒有掛排程器無關。只在掛了排程器時才擋的檢查，對一顆手寫或寫壞的輪次是零防守。
 *
 * ## 這個模組是純的，`flush()` 不在裡面
 *
 * 決定與執行分開：這裡回一個**意圖**（排一輪／記一顆 blocker／閒著），呼叫端執行。
 * 耐久檢查點是呼叫端的事，而且順序是**決定 → flush → 再決定一次 → 送**——第二次決定
 * 抓的是「flush 期間有人插話進來」，它最容易被省略而且省略了不會有任何徵兆。
 *
 * ## 就緒不是「`turn/end` 到了」
 *
 * `thread-pump.ts` 自己寫著「跑完**與停在核准點**都算收工」，而 dsh 明文「完成、暂停和
 * 阻塞会阻止续行」。三格都要問，見 {@link decideGoalRound}。
 *
 * ## CLI 的那條額外停損：做的是這一條，不是 #180 要的那一條
 *
 * [#180](https://github.com/DemianLi/nexus-agent/issues/180) 第五節要求「旗標開著時 CLI
 * 要另有一條停損：連續 N 輪沒有任何工具成功就停」。**那一條經評估後刻意不做**，理由沒有
 * 變：
 *
 * - 「連續 N 輪沒有工具成功」在會話日誌上**量不到**（十種事件沒有工具事件），只能在
 *   `runTurn` 裡數 stream 上的 `ToolMessage`。而 `HEADLESS_APPROVALS` 是**拒絕**不是
 *   靜默——被拒的工具照樣回一則 `ToolMessage`，所以那個計數抓不到它要抓的那件事。
 * - 「連續 N 輪沒有 `goal/change`」更糟：一個正常工作的模型可以幾十輪不碰 goal 工具，
 *   那是這條路的**正常樣子**，不是停滯。這個判準會在長任務中途把目標 block 掉。
 * - **一條會誤殺健康長任務的停損，比沒有停損更糟。**
 *
 * 做的是另一條，而且問的是完全不同的問題：**操作的人在命令列上講死一個輪數**
 * （`--max-goal-rounds`，見 {@link decideGoalRound} 的 `roundCap`）。它不猜停滯，所以誤殺
 * 不了任何東西——它回答的是「這一次呼叫我准你燒幾輪」。
 *
 * **為什麼非有一條不可**：`maxGoalRounds` 不是操作的人設得動的。`service.ts:269` 是
 * `request.maxGoalRounds ?? this.#defaultMaxGoalRounds`——`??` 而不是 `Math.min`，所以
 * 模型在 `create_goal` 裡自己填的那個數字**贏過**組裝點給的預設。「唯一的硬上限是
 * `maxGoalRounds`」在真 key 上等於「唯一的硬上限由模型自己挑」，那不是一條停損。
 *
 * **這是一筆登記過的載體偏離**：dsh 的 driver 沒有這一格（`goal-round-driver/src/index.ts`
 * 的第 166 行只讀 `goal.maxGoalRounds`）。它不需要——那是一個你要刻意掛載的 Cordis
 * plugin，選擇權在宿主那側；我們的等價物是一個旗標，而旗標後面直接是一支燒 API key 的
 * 迴圈（`cli.ts` 的 `driveGoalRounds`）。
 *
 * 剩下的那一半照舊：`blockedAfterConsecutiveRounds`（預設 3）讓模型從第 3 輪起**可以**把
 * 自己 block 出去——那是准許不是保證，沒有東西逼它用。所以 CLI 開旗標時要把**兩條**上限
 * 都印出來、講明哪一條在管，見 `cli.ts`。
 *
 * @module
 */

import { currentTurnStart, hasUnansweredInterrupt } from '@nexus/core';
import type { GoalBlockReason, GoalId, GoalRef, SessionEvent } from '@nexus/core';
import { renderGoalRoundPrompt } from '@nexus/plugin-goal';
import type { GoalView } from '@nexus/plugin-goal';

/** 上限耗盡時記的那顆 blocker 的穩定代碼。逐字照 dsh。 */
export const ROUND_LIMIT_BLOCK_CODE = 'round-limit';

/**
 * 操作的人在命令列上給的那條上限用完時記的那顆 blocker 的代碼。
 *
 * **跟 {@link ROUND_LIMIT_BLOCK_CODE} 分成兩個名字**，因為成因不同，而且不同在哪正是要
 * 量的東西：一個是目標自己那個數字（模型挑的）用完了，另一個是人喊停。合成一個代碼的
 * 話，「模型自己收斂到上限」與「人設的閘先夾住它」在日誌上長得一模一樣。
 *
 * dsh 沒有這個代碼，見檔頭那筆登記。
 */
export const ROUND_CAP_BLOCK_CODE = 'round-cap';

/** 排得出一輪時，要交給入口點的東西。 */
export interface GoalRoundRequest {
  /** 送進模型的那一串字。**入口點拿同一個值同時寫日誌與構訊息**，見 `thread-pump.ts`。 */
  readonly text: string;
  readonly goalId: GoalId;
  readonly revision: number;
  readonly round: number;
}

/**
 * 為什麼這一刻排不出一輪。**每一種各有一個名字**，因為它們的成因不同——尤其
 * `turn-failed` 與 `turn-open`：合成一句「最後一顆不是 `turn/end`」的話，一次「拋錯之後
 * 照樣續行」的重構會通過每一條測試。
 */
export type GoalDriverIdleReason =
  /** 這份日誌上一輪都還沒開始——人還沒說話。 */
  | 'no-turn'
  /** 上一輪還在跑（沒有結尾）。 */
  | 'turn-open'
  /** 上一輪**拋錯**結束。續行不重試，見 [#180](https://github.com/DemianLi/nexus-agent/issues/180) 的 Out of scope。 */
  | 'turn-failed'
  /** 停在核准點，中斷還掛著。 */
  | 'interrupt-pending'
  /** 沒有目前的目標。 */
  | 'no-goal'
  /** 有目標但相位不是 active（完成、暫停、被擋住都算）。 */
  | 'not-active'
  /** 相位是 active 但這個 process 沒有續行授權。 */
  | 'disarmed';

/** 這一刻該做什麼。 */
export type GoalDriverDecision =
  | { readonly kind: 'run'; readonly round: GoalRoundRequest }
  | { readonly kind: 'block'; readonly ref: GoalRef; readonly reason: GoalBlockReason }
  | { readonly kind: 'idle'; readonly reason: GoalDriverIdleReason };

/**
 * 當前這一段物理輪次收工了沒——**拋錯結束與還在跑是兩件事**。
 *
 * **整個就緒判準都靠一件事成立：`turn/start` 在 `try` 之前 append。**
 * 兩個入口點都是這樣寫的（`thread-pump.ts` 的 `#runOnce`、`cli.ts` 的 `runTurn`，兩處都
 * 有註解說為什麼），所以「一輪跑過但日誌上沒有頭」這個狀態不存在，`no-turn` 只可能是
 * 「一輪都還沒開始」。哪天有人把 append 挪進 `try` 裡，這裡讀到的就會是一個假的 idle。
 */
function turnClosed(events: readonly SessionEvent[]): GoalDriverIdleReason | undefined {
  const start = currentTurnStart(events);
  if (start < 0) return 'no-turn';
  for (let at = start + 1; at < events.length; at += 1) {
    const type = events[at]?.type;
    if (type === 'turn/end') return undefined;
    if (type === 'turn/failed') return 'turn-failed';
  }
  return 'turn-open';
}

/**
 * 現在該不該再排一輪。**純函式**：讀日誌與一份視圖，不動任何東西。
 *
 * @param events - 這一份會話日誌到目前為止的全部事件。
 * @param goal - 目前那份視圖；沒有目前目標時給 `undefined`。
 * @param roundCap - 操作的人這一次呼叫給的輪數上限；省略即只有目標自己那一條。
 * @returns 排一輪、記一顆 blocker，或閒著（帶得出理由）。
 */
export function decideGoalRound(
  events: readonly SessionEvent[],
  goal: GoalView | undefined,
  roundCap?: number,
): GoalDriverDecision {
  const notClosed = turnClosed(events);
  if (notClosed !== undefined) return { kind: 'idle', reason: notClosed };
  // **停在核准點也算 `turn/end`**，所以這一句非問不可——少了它，排程器會在一顆等著人按
  // 批准的中斷上面再排一輪，而那一輪會把中斷靜靜吃掉（`thread-pump.ts` 檔頭第 5 點）。
  if (hasUnansweredInterrupt(events)) return { kind: 'idle', reason: 'interrupt-pending' };
  if (goal === undefined) return { kind: 'idle', reason: 'no-goal' };
  if (goal.phase !== 'active') return { kind: 'idle', reason: 'not-active' };
  // **掛載、resume、fork 之後絕不自行復活**：授權從 `disarmed` 開始，要一次有人授權的
  // `create` 或 `resume` 才 armed（`service.ts` 的「永遠不持久」）。
  if (goal.activation !== 'armed') return { kind: 'idle', reason: 'disarmed' };
  if (goal.roundsStarted >= goal.maxGoalRounds) {
    return {
      kind: 'block',
      ref: { id: goal.id, revision: goal.revision },
      reason: {
        code: ROUND_LIMIT_BLOCK_CODE,
        message: `目標用完了設定的 ${goal.maxGoalRounds} 個續行輪次。`,
      },
    };
  }
  // **順序有意義**：目標自己那個數字先問。兩條同時到頂時該說的是 `round-limit`——那一刻
  // 人設的閘沒有夾到任何東西，說成 `round-cap` 會把功勞算錯，而這兩者分不分得開正是開著
  // 旗標跑真模型時要看的那件事。
  if (roundCap !== undefined && goal.roundsStarted >= roundCap) {
    return {
      kind: 'block',
      ref: { id: goal.id, revision: goal.revision },
      reason: {
        code: ROUND_CAP_BLOCK_CODE,
        message: `這一次呼叫用完了 --max-goal-rounds 給的 ${roundCap} 個續行輪次。`,
      },
    };
  }
  const round = goal.roundsStarted + 1;
  return {
    kind: 'run',
    round: {
      // **一次 render，一個值。** 入口點拿它同時寫 `turn/start.text` 與構模型訊息，所以
      // 「日誌上寫的」與「模型讀到的」在結構上是同一串字，不是兩份要互相對齊的東西。
      text: renderGoalRoundPrompt(goal, round),
      goalId: goal.id,
      revision: goal.revision,
      round,
    },
  };
}

/**
 * 排程器要問域的四件事。**窄到剛好夠用**，所以兩條進入點各自組得出來，而這個模組不必
 * 知道 `GoalService` 長什麼樣。
 */
export interface GoalDriverPort {
  /**
   * 目前那份視圖。
   *
   * **查不到域時回 `undefined`**——`--plugins` 換掉預設清單的話就沒有 goal 這個 plugin，
   * 那時排程器要安靜地什麼都不做，不是拋。
   */
  goal(): GoalView | undefined;
  /** 記一顆 blocker。 */
  block(ref: GoalRef, reason: GoalBlockReason): void;
  /** 收回續行授權，**不動耐久的相位**。耐久檢查點失敗時用。 */
  disarm(): void;
  /** 排隊前的耐久檢查點。沒有落盤時是 no-op。 */
  flush(): Promise<void>;
  /** 排程器自己出事時說一聲。 */
  warn(message: string): void;
}

/**
 * 跑完一次排程：決定 → 耐久檢查點 → **再決定一次** → 交出那一輪。
 *
 * ## 為什麼是兩次決定
 *
 * `flush()` 是 await，而 await 期間人可以插話、目標可以被 `/goal pause` 改掉。第二次決定
 * 就是那道閘：它是**最容易省略而且省略了不會有任何徵兆**的一步——省略的後果是一輪排在
 * 一個已經被暫停的目標上，或搶在一個人剛送進來的訊息前面。
 *
 * 兩次的結果要**是同一輪**：號碼變了代表期間有別的東西推進過計數，那一輪要重新來過。
 *
 * ## `flush()` 失敗是停用，不是重試
 *
 * 照 dsh：耐久檢查點過不去就 `disarm()`，之後要續行得走一次有人授權的 `resume`。
 * 重試的話，一份寫不下去的日誌會配上一個照樣往前跑的模型——而日誌正是之後要用來重建
 * 「它到底做了什麼」的那份東西。
 *
 * @param readEvents - 讀當下的事件；**每次呼叫都要重讀**，不是一份快照。
 * @param port - 域那一側的四件事。
 * @param roundCap - 操作的人這一次呼叫給的輪數上限。**兩次決定都帶著它，但今天那是形式
 *   上的一致而不是一條擋得住什麼的閘**：唯一能在 `flush()` 期間新踩到上限的變化是
 *   `roundsStarted` 往前走，而那同時會讓下面那道「號碼變了就重來」先攔下來。寫成只帶
 *   第一次也量不出差別——留著是因為兩次決定該問同一個問題，不是因為它今天擋得到東西。
 * @returns 排得出來的那一輪，或這一刻不排時的 `undefined`。
 */
export async function driveGoalRound(
  readEvents: () => readonly SessionEvent[],
  port: GoalDriverPort,
  roundCap?: number,
): Promise<GoalRoundRequest | undefined> {
  const first = decideGoalRound(readEvents(), port.goal(), roundCap);
  if (first.kind === 'idle') return undefined;
  if (first.kind === 'block') {
    try {
      port.block(first.ref, first.reason);
    } catch (error: unknown) {
      port.warn(`記不下輪次上限的 blocker：${errorText(error)}`);
    }
    return undefined;
  }
  try {
    await port.flush();
  } catch (error: unknown) {
    port.warn(`耐久檢查點失敗，停用續行：${errorText(error)}`);
    try {
      port.disarm();
    } catch (disarmError: unknown) {
      port.warn(`連停用續行都失敗了：${errorText(disarmError)}`);
    }
    return undefined;
  }
  const second = decideGoalRound(readEvents(), port.goal(), roundCap);
  if (second.kind !== 'run' || second.round.round !== first.round.round) return undefined;
  return second.round;
}

/** 拿得到就拿訊息，拿不到就整個轉字串。 */
function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
