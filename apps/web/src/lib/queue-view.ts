import { isSettleReason } from '@nexus/wire';
import type {
  ConversationStatus,
  SlashDescriptor,
  TurnStopCause,
  WireQueuedInput,
  WireSettleReason,
} from '@nexus/wire';

import { stoppedByTurnClock } from '@/lib/stop-cause';

/**
 * 送出佇列在畫面上的幾個判斷（[#645](https://github.com/DemianLi/nexus-agent/issues/645)）。資料是 harness 的投影
 * `ConversationState.inbox`（#637）：人送出、還沒開跑的那幾句。
 *
 * @module
 */

/** 一列的預覽最多幾個字，照 dsh `QUEUE_PREVIEW_CHARS`。 */
export const QUEUE_PREVIEW_CHARS = 200;

/** 新進來的一件要撐過多久才畫（Q5）：閒著時送出，伺服器緊接著就領走，不壓的話佇列會閃一列。 */
export const QUEUE_SETTLE_MS = 200;

/** 消失時淡出多久（Q8）。 */
export const QUEUE_LEAVE_MS = 150;

/** 停住時表頭多講的那一句（Q6）。 */
export const QUEUE_PARKED_TEXT = '停止後這些不會自己跑，送出下一句時會先照順序跑它們';

/** 改、刪沒收下而那一件已經不在隊裡（Q7）。 */
export const QUEUE_GONE_TEXT = '這一則可能已經開始跑了';

/**
 * 背景子代理結算通知在畫面上的那一句（#851、#884）。伺服器排進來的文字是給模型的英文，不是人說的話，畫面不照抄、
 * 也不去解析它：配字靠線上帶的結算原因（`reason`；`aborted` 另看 `cause`，時鐘到點講 {@link SETTLED_NOTICE_TIMED_OUT_TEXT}），哪個子代理留在日誌。五種原因各一句，措辭跟同一件事在別處的說法
 * 一致：被停止同「（已停止）」、超出上限同 `max-tokens-view.ts` 的「已達輸出上限」。
 * 鍵用 `satisfies Record<WireSettleReason, …>`：wire 多一種原因，這裡編不過。
 */
export const SETTLED_NOTICE_TEXT = {
  completed: '背景子代理已完成',
  aborted: '背景子代理已被停止',
  'max-tokens': '背景子代理已達輸出上限，沒寫完',
  error: '背景子代理失敗了',
  refusal: '背景子代理沒有開工（會話已封存）',
} as const satisfies Record<WireSettleReason, string>;

/**
 * 沒有原因時那一句（格式 26 以前的舊日誌，或讀到不認得的值）：只說「結束了」，**不假裝成「已完成」**——舊日誌裡被停止、
 * 失敗的結算也長這樣，說不出是哪一種。
 */
export const SETTLED_NOTICE_UNKNOWN_TEXT = '背景子代理已結束';

/** 背景子代理的那一輪時鐘到點（#1847）。其餘停法（人按的、父代理中斷、別的 hook、沒帶原因）都是 {@link SETTLED_NOTICE_TEXT} 的 `aborted`。 */
export const SETTLED_NOTICE_TIMED_OUT_TEXT = '背景子代理超過時間上限，已停止';

/**
 * 結算通知那一句：認得的原因照原因講，沒有或不認得就是中性的那一句。
 *
 * @param cause - `reason` 是 `aborted` 時為什麼停（#1847）；舊日誌沒有。
 */
export function settledNoticeText(reason: unknown, cause?: TurnStopCause): string {
  if (reason === 'aborted' && stoppedByTurnClock(cause)) return SETTLED_NOTICE_TIMED_OUT_TEXT;
  return isSettleReason(reason) ? SETTLED_NOTICE_TEXT[reason] : SETTLED_NOTICE_UNKNOWN_TEXT;
}

/**
 * 背景子代理寄來的話在佇列裡那一句（#861）。排進來的文字是給模型的（帶英文前綴），佇列裡也沒有寄件人，所以不照抄：
 * 只說「有一則來信」；寄件人與內容等它被領走、折疊器長出 `AgentMessageEntry` 才畫在對話裡。
 */
export const AGENT_MESSAGE_QUEUED_TEXT = '背景子代理來信';

/**
 * 這一件是不是背景子代理結算的通知，而不是人排的（#851）。
 */
export function isSettledNotice(item: Pick<WireQueuedInput, 'source'>): boolean {
  return item.source.kind === 'subagent-settled';
}

/** 這一件是不是背景子代理寫來的話（#861）。 */
export function isAgentMessage(item: Pick<WireQueuedInput, 'source'>): boolean {
  return item.source.kind === 'agent-message';
}

/**
 * 不是人排的那一類：背景子代理結算的通知、背景子代理寫來的話。**只認這兩種，其餘照人處理**：新增的來源要各自決定
 * 怎麼畫，不在這裡預設。
 */
export function isQueuedByAgent(item: Pick<WireQueuedInput, 'source'>): boolean {
  return isSettledNotice(item) || isAgentMessage(item);
}

/** 目標續行的預約在佇列列上的名字（#638）：它不是人說的話，文字是給模型的續行提示詞，畫面不照抄。 */
export const GOAL_CONTINUATION_TEXT = '目標續行';

/**
 * 動這一件的後果，**講在那一列上**（#638）：harness 把刪掉它當成「不要再續行了」，所以暫停目標；改它的文字等同刪掉
 * （預約的文字必須逐字等於目前目標的續行提示詞）。不是「跳過這一輪」，人要先知道。
 */
export const GOAL_CONTINUATION_WARNING = '刪除或編輯會暫停目標';

/** 這一件是不是目標續行的預約（#638）：排程器放的，不是人排的。 */
export function isGoalContinuation(item: Pick<WireQueuedInput, 'source'>): boolean {
  return item.source.kind === 'goal';
}

/** 不認得的來源種類在佇列列上的名字（新版 harness 加的種類，wire 收成 `unrecognized`）：不是人說的，不知道是什麼，不照抄文字。 */
export const UNRECOGNIZED_SOURCE_TEXT = '系統排入的訊息';

/** 這一件的來源 wire 不認得（#1247）：照 dsh 當非人的件收下，web 用通用標籤畫、不出插話鈕。 */
export function isUnrecognizedSource(item: Pick<WireQueuedInput, 'source'>): boolean {
  return item.source.kind === 'unrecognized';
}

/** 不認得的來源，原本寫的是什麼種類（給提示文字用）；認得的來源回 `undefined`。 */
export function unrecognizedSourceKind(item: Pick<WireQueuedInput, 'source'>): string | undefined {
  return item.source.kind === 'unrecognized' ? item.source.original : undefined;
}

/** 能改成插話的件：目標續行的預約不能（伺服器回 `steer_unavailable`）、不認得來源的件不知道能不能，整批插話與「有沒有東西可插」都先濾掉它們。 */
export function steerableItems(items: readonly WireQueuedInput[]): readonly WireQueuedInput[] {
  return items.filter((item) => !isGoalContinuation(item) && !isUnrecognizedSource(item));
}

/** 不是人排的那一件在佇列列上寫什麼；人排的沒有。 */
export function queuedAgentText(item: Pick<WireQueuedInput, 'source'>): string | undefined {
  if (item.source.kind === 'subagent-settled')
    return settledNoticeText(item.source.reason, item.source.cause);
  if (isAgentMessage(item)) return AGENT_MESSAGE_QUEUED_TEXT;
  return undefined;
}

/** 表頭：件數。 */
export function queueHeading(count: number): string {
  return `${count} 則排著的訊息`;
}

/** 一列的預覽：攤成一行，超過 {@link QUEUE_PREVIEW_CHARS} 個字截掉加「…」。照 dsh `queuePreview`。 */
export function queuePreview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = [...line];
  return chars.length > QUEUE_PREVIEW_CHARS
    ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join('')}…`
    : line;
}

/**
 * 排著的是不是**停住**了（Q6）：按了停止之後排著的不會自己跑，等下一句送出才照順序跑（#637 Q2）。伺服器沒有推
 * 這個旗標，但看得出來——清單不空，而一輪既不在跑、也不在等人，排著的就沒有人會去領。
 *
 * - `running`：等這一輪跑完。`awaiting-input`：停在核准點後面，答完才跑（#629）。這兩種不算。
 * - `stopped`：停住。重新整理後從歷史回來的停住是 `idle` 或 `stopped`，同樣算。
 * - `failed`：伺服器不因失敗停住，下一件會接著跑，所以只會短暫出現——畫面上新項目本來就要撐過
 *   {@link QUEUE_SETTLE_MS} 才畫，這一格照規則算停住也碰不太到。
 */
export function isQueueParked(status: ConversationStatus, count: number): boolean {
  return count > 0 && status !== 'running' && status !== 'awaiting-input';
}

/**
 * 輸入框送得出一句話嗎（Q2）。**純文字跑著也放行**：伺服器收下就排進佇列。停在核准點時輸入框被面板換掉（Q3、
 * §4.3），這裡照樣擋，免得別的路徑繞過去。
 *
 * **文字或附件至少一個就能送**（dsh `session-controller/src/types.ts:338`：「at least one non-whitespace text part or
 * attachment」）：`hasAttachments` 為真時，空白文字也放行。斜線命令不帶附件，不走這一條。
 */
export function canSendText(
  connected: boolean,
  status: ConversationStatus,
  line: string,
  hasAttachments = false,
): boolean {
  return connected && (line.trim() !== '' || hasAttachments) && status !== 'awaiting-input';
}

/** 跟 `parseCommand` 同一條：名字後面緊接非空白（`/plan.md`）就不是命令。 */
const COMMAND_TOKEN = /^\/([a-z][a-z0-9_-]*)(?=$|\s)/u;

/** 這一行開頭像不像一個命令（`/名字`，名字照 `parseCommand`）；不管清單上有沒有。不像就回 `undefined`。 */
export function commandToken(line: string): string | undefined {
  return COMMAND_TOKEN.exec(line.trim())?.[1];
}

/**
 * 開頭那個字是不是命令清單上的名字（[#1929](https://github.com/DemianLi/nexus-agent/issues/1929)，#1574 Q2 (a)）：是才走
 * `slash.run`，其餘一律是一句話、走 `run.start`——技能的 `/deploy 今天`、打錯的 `/plna` 都送給模型。照 dsh：命令在客戶端
 * 先認，認不得的整行變成 prompt（`ui-commands/src/client/service.ts` 的 `matchEnter`）。
 */
export function namesCommand(commands: readonly SlashDescriptor[], line: string): boolean {
  return commandArm(commands, line) !== undefined;
}

/**
 * 這一行是命令的話走哪一路（[#1971](https://github.com/DemianLi/nexus-agent/issues/1971)），照 dsh `matchEnter`
 * （`ui-commands/src/client/service.ts:325-365`，`687f282e`）：
 *
 * - `claim`：宣告了 `input` 的命令，後面帶不帶字都算。送出後在途、收下才清（#1941）。
 * - `detached`：沒宣告 `input`、整行只有 `/名字`。當場拿掉、背景執行，不鎖輸入框（dsh `consumeVia`＋`runDetached`）。
 * - `undefined`：不是命令。不在清單上，或沒宣告 `input` 卻帶了字——後者 dsh 整行當一句話送（`if (!bare) return undefined`）。
 */
export function commandArm(
  commands: readonly SlashDescriptor[],
  line: string,
): 'claim' | 'detached' | undefined {
  const name = commandToken(line);
  if (name === undefined) return undefined;
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) return undefined;
  if (command.input !== undefined) return 'claim';
  return line.trim() === `/${name}` ? 'detached' : undefined;
}

/**
 * 這一行在一輪跑著、或停在核准點時能不能執行（[#1517](https://github.com/DemianLi/nexus-agent/issues/1517)）：照 `slash.list`
 * 帶下來的 `runWhileBusy` 宣告（#1516），**不在前端另寫一份各命令的文法**。
 *
 * 判斷跟 server 的閘門同一套（`@nexus/plugin-commands` 的 `runsWhileBusy`）：命令名照 `parseCommand` 的規則解出來，名字後面
 * 那段輸入去掉頭尾空白後，要**逐字**等於宣告的某一格（`/goal pause` 放行，`/goal PAUSE`、`/goal pause 1` 不放行）。
 * 清單還沒到、名字不認得、沒宣告，一律不放行——跟 server 一樣預設擋。`queue-view.test.ts` 拿真的 `runsWhileBusy`
 * 對照同一批輸入，兩邊分岔就紅。
 */
export function slashRunsWhileBusy(commands: readonly SlashDescriptor[], line: string): boolean {
  const match = COMMAND_TOKEN.exec(line);
  if (match === null) return false;
  const declared = commands.find((command) => command.name === match[1])?.runWhileBusy;
  return declared !== undefined && declared.includes(line.slice(match[0].length).trim());
}

/**
 * 斜線命令送得出去嗎。**一輪沒收尾時照舊擋**：伺服器那側也擋（跑著、停在核准點都是）。例外兩種：
 *
 * - 只打 `/feedback`：它不起一輪，只開回饋對話框（#267 的 Q10）。
 * - 命令宣告了「忙的時候也放行」的那幾行（{@link slashRunsWhileBusy}，例如 `/goal pause`，#1517）。
 */
export function canRunSlash(
  connected: boolean,
  status: ConversationStatus,
  line: string,
  feedbackLine: string,
  commands: readonly SlashDescriptor[],
): boolean {
  const busy = status === 'running' || status === 'awaiting-input';
  return (
    connected &&
    line.trim() !== '' &&
    (!busy || line.trim() === feedbackLine || slashRunsWhileBusy(commands, line.trim()))
  );
}
