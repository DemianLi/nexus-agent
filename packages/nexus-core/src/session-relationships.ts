/**
 * 會話日誌**事件之間的關係**：逐顆餵入、不做 I/O、不拋錯的檢查，一份日誌一份狀態（[#1597](https://github.com/DemianLi/nexus-agent/issues/1597)）。
 *
 * 兩個使用者共用這一份規則：執行期的配套入口（`./invariant.ts` 的 `sessionInvariant`，違規交給 `fail`）與 harness 的讀盤
 * （`apps/harness/src/session-log-validation.ts` 的 `assertStoredRelationships`，違規就拒開）。規則只寫在這裡，兩邊才不會判法不同。
 *
 * 違規以回傳值交出，不拋錯：要不要擋由呼叫方決定。讀盤讀到的事件只驗過信封，`data` 的形狀不保證合型別，所以欄位一律經
 * {@link field} 取，形狀不對的那一格當成沒有，不會在這裡拋 `TypeError`。
 *
 * 每一條規則的理由（為什麼在 `session/end-seed` 重設、哪些狀態跨過它留著）寫在 {@link createSessionRelationshipChecker} 裡。
 *
 * @module
 */

import { EMPTY_INBOX, spliceInbox } from './inbox.js';
import type { InboxSplice, InboxState } from './inbox.js';
import type { SessionEvent } from './session-log.js';
import { TOOL_NOT_STARTED } from './tool-events.js';

/** 一條關係規則的名字，放進違規裡給呼叫方分辨。 */
export type SessionRelationshipRule =
  | 'turn-overlap'
  | 'turn-not-open'
  | 'interrupt-outside-turn'
  | 'approval-outside-turn'
  | 'model-end-without-start'
  | 'model-call-unknown'
  | 'tool-result-without-call'
  | 'retry-chain'
  | 'retry-started-unscheduled'
  | 'inbox-splice'
  | 'request-outside-turn'
  | 'request-without-model-start'
  | 'attempt-outside-turn'
  | 'attempt-before-failed-end';

/** 一筆違規。`message` 指認那一顆（型別與 `seq`），說哪一條關係錯了。 */
export interface SessionRelationshipViolation {
  readonly seq: number;
  readonly rule: SessionRelationshipRule;
  readonly message: string;
}

/** 從頭到尾依 `seq` 餵事件，每餵一顆回這一顆造成的違規（沒有就是空陣列）。不拋錯：`data` 形狀不對的欄位當成沒有。 */
export interface SessionRelationshipChecker {
  accept(event: SessionEvent): readonly SessionRelationshipViolation[];
}

/**
 * 建一份從空日誌開始的檢查狀態。
 *
 * - **turn 配對**：`turn/start` 來的時候上一輪不能還開著，`turn/end`／`turn/failed` 要關一個開著的輪，`interrupt/raised` 要落在輪內。
 *   兩個生產者（`apps/harness/src/thread-pump.ts` 的 `#runOnce`、`apps/harness/src/cli.ts` 的 `runTurn`）都是
 *   `turn/start` →（`interrupt/raised`）* → `turn/end` 或 `turn/failed`，而且 pump 的輪排隊跑、不交錯。
 * - **刻意不檢「日誌結尾還有一輪開著」**：那跟「跑到一半」或行程中途死掉長得一模一樣，不是違規。
 * - **同一個理由，turn 的狀態在 `session/end-seed` 重設**（[#251](https://github.com/DemianLi/nexus-agent/issues/251)）：seed 結尾
 *   那一輪開著是上一個行程跑到一半，不重設的話，續接之後第一顆 `turn/start` 必然報「上一輪還開著」。
 * - **例外（[#721](https://github.com/DemianLi/nexus-agent/issues/721)）：end-seed 落下時輪還開著，輪與待結狀態帶過去，不清。** 帶過去的那一輪由補結的
 *   `turn/end`（或 `turn/failed`）收掉，或由下一顆 `turn/start` 接手——那是新行程自己的一輪，待結狀態在那時清掉。見 `carried`。
 * - **核准稽核**（`approval/asked`、`approval/decided`）要落在開著的輪內，只在出現過 `turn/start` 的日誌上判，見 `hasTurns`。
 * - **模型呼叫**：`model/end` 前面要有開著的 `model/start`；事件上的 `modelCall` 要是前面某顆 `model/start` 的 `seq`
 *   （[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)）。
 * - **工具**：`tool/result` 要配到一顆還沒配到的 `tool/call`，「還沒開始」的合成結果（`TOOL_NOT_STARTED`）沒有 `tool/call`，明文放行。
 * - **重試**：同一個 `retryId` 的 `llm/retry` 從 1 連號；`llm/retry-started` 要配到前面一顆同 `retryId`、同 `retry` 的 `llm/retry`，
 *   同一對只能開跑一次。
 * - **送出佇列**（`inbox/spliced`，[#637](https://github.com/DemianLi/nexus-agent/issues/637)）**不重設**：佇列本來就跨行程活著，
 *   一顆合規與否要對著從檔頭折起的清單判，檢的是範圍超出與 id 重複。
 * - **請求快照**（`request/system`、`request/header`，格式 55，[#2416](https://github.com/DemianLi/nexus-agent/issues/2416)）：帶 `modelCall`
 *   的是 54 以前的形狀，只檢它指得到 `model/start`。不帶的是 55 的形狀，歸屬看位置，所以兩條：要落在開著的輪內；落在任何開著的
 *   呼叫之外的，這一輪收工之前要等到一顆 `model/start`，等不到就是寫丟了它那次呼叫。**被 `interrupted` 收掉的輪不檢第二條**：
 *   行程死在快照落盤之後、`model/start` 落盤之前（兩顆同一批排空，批寫到一半就斷），續接補結的就是那一輪（`interrupted-turn.ts`）。輪內那條同核准稽核，只在出現過
 *   `turn/start` 的日誌上判：子代理的日誌沒有 `turn/*`，第二條在那裡也就沒有收工點可檢。
 * - **作廢的嘗試**（`assistant/attempt`）要落在開著的輪內；帶 `modelCall` 的，那次呼叫要已經以 `error` 或 `aborted` 收尾。跟下一次嘗試的
 *   `model/start` 誰先誰後不檢：pump 在圖外收通知，下一次嘗試在圖裡照跑。
 *
 * 不認得的事件種類不解讀，歸它們自己的擁有者。
 *
 * @returns 新的檢查狀態，一份日誌一份。
 */
export function createSessionRelationshipChecker(): SessionRelationshipChecker {
  /** 有一輪開著。`turn/end` 與 `turn/failed` 都是收工，共用這一格：兩者的差別是結果，不是結構。 */
  let open = false;
  /**
   * 開著的那一輪是**從上一個行程帶過來的**（`session/end-seed` 落下時輪還開著）。
   *
   * 新檔的補結在 end-seed 之前（#721），輪早已收；但 #934（格式 29）之前的寫入器續接過的檔，「開著的輪＋end-seed」的形狀照舊讀得到
   * （續接會把 header 的版本蓋成最新，不能拿版本號分辨）。續接它時補結接在 end-seed **後面**（`interrupted-turn.ts` 的掃描遇到 end-seed
   * 不重設）。補結要對得上那一輪，所以輪、待結的呼叫、開著的模型呼叫都得跨過這顆 end-seed 留著；旗標只管一件事——後面緊接著的
   * `turn/start` 是新行程自己的一輪，不是違規。
   */
  let carried = false;
  /**
   * 這份日誌出現過 `turn/start`（[#2026](https://github.com/DemianLi/nexus-agent/issues/2026)）。**跨 `session/end-seed` 不重設**：續接時舊事件
   * 會重播、讀盤掃整份，都看得到上一個行程的輪。
   *
   * 前景子代理叫的工具走政策路徑時，稽核寫進子代理自己那份日誌（`registry.sessions.forCall` 挑的是呼叫者的日誌），而那份日誌從來沒有
   * `turn/*`，所以不判；前景子代理只在 parent 某顆工具執行期間跑，parent 那一輪一定開著。代價是一份全新的日誌在第一顆 `turn/start`
   * 之前寫的稽核抓不到。
   */
  let hasTurns = false;
  /**
   * 記過 `tool/call`、還沒配到結果的 `callId`。**同一個 `callId` 記兩次不是違規**：被中斷的呼叫 resume 後會再記一顆（見 `session-log.ts`
   * 的 `tool/call`），集合吃得下重複。沒有 `step/*` 事件可以當清空的邊界，而一顆沒配到的呼叫就是被中斷或跑到一半的那次，留著不會讓
   * 後面的檢查誤判，所以只在輪已收的 end-seed 與接手帶過來那一輪的 `turn/start` 清。
   */
  const pendingCalls = new Set<string>();
  /**
   * 開著的模型呼叫有幾個（[#266](https://github.com/DemianLi/nexus-agent/issues/266)）。**只檢結尾那一側**：`model/end` 前面沒有開著的
   * `model/start` 一定是寫錯了；反過來，`model/start` 沒配到結尾只有一種成因——行程在呼叫中途死了——一律報的話每個崩過的會話都會紅
   * （讀盤時就是打不開）。用計數不用布林，哪天有了並行的模型呼叫也不會誤報。
   */
  let openModelCalls = 0;
  /**
   * 記過的 `model/start` 的 `seq`。**跨 `session/end-seed` 不清**：上一個行程的呼叫仍可能被它之後補寫的事件指到
   * （量測、被切斷的半段回覆都在呼叫結束之後才寫）。
   */
  const startSeqs = new Set<number>();
  /** 每個 `retryId` 排到第幾次。跨 `session/end-seed` 不清：同一份檔裡 `retryId` 不重用。 */
  const retryChains = new Map<unknown, unknown>();
  /** 排定過、還沒開跑的重試，鍵是 `[retryId, retry]`。跨 `session/end-seed` 不清，理由同上。 */
  const scheduledRetries = new Set<string>();
  /** 從檔頭折起的送出佇列。**跨 `session/end-seed` 不重設**。 */
  let inbox: InboxState = EMPTY_INBOX;
  /** 以 `error` 或 `aborted` 收尾的呼叫（`model/end` 帶的 `modelCall`）。跨 `session/end-seed` 不清，理由同 `startSeqs`。 */
  const failedCalls = new Set<number>();
  /**
   * 這一輪裡第一顆還沒等到 `model/start` 的 55 形狀快照的 `seq`。跟著輪走：帶過去的輪照帶，接手那一顆 `turn/start` 清。
   */
  let danglingSnapshot: number | undefined;

  const accept = (event: SessionEvent): readonly SessionRelationshipViolation[] => {
    const { seq } = event;
    const violations: SessionRelationshipViolation[] = [];
    const report = (rule: SessionRelationshipRule, message: string): void => {
      violations.push({ seq, rule, message });
    };
    const checkModelCall = (): void => {
      const modelCall = field(event, 'modelCall');
      if (modelCall === undefined) return;
      if (typeof modelCall !== 'number' || !startSeqs.has(modelCall)) {
        report(
          'model-call-unknown',
          `${event.type}（seq ${seq}）的 modelCall ${String(modelCall)} 不是前面任何一顆 model/start 的 seq`,
        );
      }
    };

    switch (event.type) {
      case 'inbox/spliced': {
        try {
          inbox = spliceInbox(inbox, event.data as InboxSplice);
        } catch (error: unknown) {
          report(
            'inbox-splice',
            `inbox/spliced（seq ${seq}）不合規：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'model/start': {
        openModelCalls += 1;
        startSeqs.add(seq);
        danglingSnapshot = undefined;
        break;
      }
      case 'request/system':
      case 'request/header': {
        if (field(event, 'modelCall') !== undefined) {
          checkModelCall();
          break;
        }
        if (hasTurns && !open) {
          report('request-outside-turn', `${event.type}（seq ${seq}）落在任何開著的輪之外`);
        }
        if (openModelCalls === 0 && danglingSnapshot === undefined) danglingSnapshot = seq;
        break;
      }
      case 'assistant/attempt': {
        checkModelCall();
        if (!open) {
          report('attempt-outside-turn', `assistant/attempt（seq ${seq}）落在任何開著的輪之外`);
        }
        const modelCall = field(event, 'modelCall');
        if (
          typeof modelCall === 'number' &&
          startSeqs.has(modelCall) &&
          !failedCalls.has(modelCall)
        ) {
          report(
            'attempt-before-failed-end',
            `assistant/attempt（seq ${seq}）指的那次呼叫（model/start seq ${modelCall}）還沒以 error 或 aborted 收尾`,
          );
        }
        break;
      }
      case 'model/usage':
      case 'assistant/message':
      case 'context/measure': {
        checkModelCall();
        break;
      }
      case 'llm/retry': {
        checkModelCall();
        const retryId = field(event, 'retryId');
        const retry = field(event, 'retry');
        const prior = retryChains.get(retryId) ?? 0;
        if (typeof prior !== 'number' || retry !== prior + 1) {
          report(
            'retry-chain',
            `llm/retry（seq ${seq}）的 retry ${String(retry)} 沒有接在同一個 retryId 的第 ${String(prior)} 次之後`,
          );
        }
        retryChains.set(retryId, retry);
        scheduledRetries.add(retryKey(event));
        break;
      }
      case 'llm/retry-started': {
        checkModelCall();
        if (!scheduledRetries.delete(retryKey(event))) {
          report(
            'retry-started-unscheduled',
            `llm/retry-started（seq ${seq}）前面沒有同 retryId、同 retry 還沒開跑的 llm/retry`,
          );
        }
        break;
      }
      case 'model/end': {
        checkModelCall();
        const ended = field(event, 'modelCall');
        const outcome = field(event, 'outcome');
        if (typeof ended === 'number' && (outcome === 'error' || outcome === 'aborted')) {
          failedCalls.add(ended);
        }
        if (openModelCalls === 0) {
          report('model-end-without-start', `model/end（seq ${seq}）前面沒有開著的 model/start`);
        } else {
          openModelCalls -= 1;
        }
        break;
      }
      case 'tool/call': {
        const callId = field(event, 'callId');
        if (typeof callId === 'string') pendingCalls.add(callId);
        break;
      }
      case 'tool/result': {
        const callId = field(event, 'callId');
        // 「還沒開始」的合成結果沒有前面的 `tool/call`，明文放行。
        const error = field(event, 'error');
        const synthetic =
          field(event, 'isError') === true && isRecord(error) && error['code'] === TOOL_NOT_STARTED;
        const paired = typeof callId === 'string' && pendingCalls.delete(callId);
        if (!paired && !synthetic) {
          report(
            'tool-result-without-call',
            `tool/result（seq ${seq}）的 callId "${String(callId)}" 前面沒有還沒配到的 tool/call`,
          );
        }
        break;
      }
      case 'turn/start': {
        if (open && !carried)
          report('turn-overlap', `turn/start（seq ${seq}）來的時候上一輪還開著`);
        if (carried) {
          // 上一個行程的那一輪帶來的待結狀態，不屬於這一輪。
          carried = false;
          pendingCalls.clear();
          openModelCalls = 0;
          danglingSnapshot = undefined;
        }
        open = true;
        hasTurns = true;
        break;
      }
      case 'turn/end':
      case 'turn/failed': {
        if (!open) report('turn-not-open', `${event.type}（seq ${seq}）關了一個沒有開著的輪`);
        const reason = field(event, 'reason');
        const interrupted = isRecord(reason) && reason['kind'] === 'interrupted';
        if (danglingSnapshot !== undefined && !(event.type === 'turn/end' && interrupted)) {
          report(
            'request-without-model-start',
            `請求快照（seq ${danglingSnapshot}）之後到 ${event.type}（seq ${seq}）都沒有 model/start`,
          );
        }
        danglingSnapshot = undefined;
        open = false;
        carried = false;
        break;
      }
      case 'session/end-seed': {
        // 輪還開著就整份帶過去（#721），下一顆 `turn/start` 來時由 `carried` 放行並清掉。
        if (open) {
          carried = true;
          break;
        }
        // 輪已收：沒配到的呼叫屬於上一個行程，再也配不到。同一個行程裡被中斷的那次，resume 後 LangGraph 會重放那個沒跑完的 task、以同一個 callId 再記一顆
        // （`apps/harness/src/tool-events.test.ts` 的中斷那一組量過）。**跨重啟沒有這條路**——續接重建的是日誌推出來的
        // 對話，不是 checkpointer（`MemorySaver` 住在行程內，讀碼推得，沒另外實測）。
        pendingCalls.clear();
        // 上一個行程中途死掉的那次模型呼叫永遠等不到結尾。
        openModelCalls = 0;
        break;
      }
      case 'interrupt/raised': {
        if (!open) {
          report('interrupt-outside-turn', `interrupt/raised（seq ${seq}）落在任何開著的輪之外`);
        }
        break;
      }
      case 'approval/asked':
      case 'approval/decided': {
        // 人那條的 asked 與 decided 分在兩輪（提問那一輪、續接或收回那一輪的 `turn/start` 之後），各自都在輪內。
        if (hasTurns && !open) {
          report('approval-outside-turn', `${event.type}（seq ${seq}）落在任何開著的輪之外`);
        }
        break;
      }
      default:
        // 後來加的事件種類歸它們自己的擁有者。刻意不寫 exhaustive 的 assertNever：不認得的事件不該讓這條檢查變成阻礙
        // （協調器的 `severityOf` 同一條理由）。
        break;
    }
    return violations;
  };
  return { accept };
}

/** `event.data[key]`；`data` 不是物件就是 `undefined`。 */
function field(event: SessionEvent, key: string): unknown {
  const data: unknown = event.data;
  return isRecord(data) ? data[key] : undefined;
}

function retryKey(event: SessionEvent): string {
  return JSON.stringify([field(event, 'retryId'), field(event, 'retry')]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
