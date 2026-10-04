/**
 * 背景子代理的**拉起載體**（[#829](https://github.com/DemianLi/nexus-agent/issues/829)，地圖 [#737](https://github.com/DemianLi/nexus-agent/issues/737) 的第 4 張）。
 *
 * 子代理活在 `task` 那一次呼叫**以外**：每收到一句話就在它自己的對話編號上多跑一輪。這一輪由誰拉起，
 * 決定了它繼承什麼——[#738](https://github.com/DemianLi/nexus-agent/issues/738) 實測過兩種寫法：
 *
 * - **在工具本體裡直接排 `graph.invoke`**：LangGraph 用 AsyncLocalStorage 把呼叫端的 config 隱式繼承進去，
 *   root 的中止訊號、兩段的 `checkpoint_ns` 都跟進來。後果是 root 按停止時背景那一輪被靜靜截掉（promise 照樣成功），
 *   而同一個背景子代理的兩輪由不同工具呼叫拉起，存檔點對不上。
 * - **由在任何圖的環境之外建好的長壽迴圈取件**：`configurable` 乾淨，第二輪看得到第一輪。這是 dsh 收件匣的形狀。
 *
 * 這個 host 就是第二種。**它必須在任何圖的環境之外建**（組裝點，不是工具本體裡）：迴圈的環境是建它那一刻的環境，
 * 之後不論誰呼叫 {@link BackgroundSubagentHost.submit}，被拉起的那一輪都不帶呼叫端的環境。
 *
 * ## 每一輪做的事
 *
 * 1. 在這個子代理**自己的日誌**（同一張會話註冊表，`{kind:'subagent', runId}`，#823）寫 `turn/start`。
 * 2. `configurable` **只給明確的鍵**：`thread_id`（日誌 id，`<root>/<runId>`，全域唯一）、
 *    {@link BACKGROUND_SESSION_CONFIG_KEY}，與這一輪的插話收件匣（`STEP_INBOX_CONFIG_KEY`，#858，見下）。**不帶 root 的中止訊號**——dsh 的 root 停止不連帶停掉已派出去的
 *    背景子代理（`docs/subsystems/subagent.zh.md:152`，`477b4f4`），要個別停（卡 6 的 `interrupt_agent`）。
 * 3. 整輪包在注入的 `enter` 裡跑。產品接線時傳 `SandboxModeController.delegateFromLog`（#827）：沙箱那一格從子代理
 *    自己的日誌讀回，不是叫醒那刻 root 的現況。
 * 4. 走 v3 串流，並把投影裡沒人讀的 promise 標成已處理（`markProjectionsHandled`，#346）——裸走的話，工具本體拋錯會讓
 *    行程以未處理的 rejection 結束（探針的子行程對照組）。
 * 5. 收尾寫 `turn/end`；拋錯寫 `turn/failed`，錯誤在這裡收掉，不往外漏。
 *
 * 每個子代理**各自串行**（一次一輪，後到的排隊）、彼此並行。
 *
 * ## 插話（#858）
 *
 * 一輪正在跑的時候 {@link BackgroundSubagentHost.send} 不另開一輪：話排進這一輪的收件匣，圖裡的 step-inbox middleware
 * （`createStepInboxMiddleware('background')`，由 `compileSubagentGraph` 掛）在**下一次叫模型之前**領走，落這個子代理自己
 * 日誌的 `user/message`；模型說完了、圖要收尾時再問最後一次，沒有才關窗。窗關了、這一輪被中止了，就排成下一輪。
 * 沒領走的（被中止、出錯）退回成排著的輪次，不丟。形狀同 pump 為 root 那一輪交的 `StepInbox`。
 *
 * ## 結算通知（#840）
 *
 * 一個子代理沒有輪次在跑、排著的也空了，就是**結算**：對主對話送一則通知（{@link BackgroundSubagentHostOptions.onSettled}，
 * 內容見 {@link BackgroundSettlement}），時機在讓出所有權（交出 `outcome`）之前。被 `interrupt` 而暫停、還排著輪次的不算結算。
 * 怎麼叫醒主對話是 pump 的事（`ThreadPump.notifySettled`）。
 *
 * ## 輸出上限
 *
 * 撞到輸出上限時，中介層在背景圖上照樣丟工具呼叫（它在子代理的那一疊裡，同 dsh），但**不在 `MaxTokensCarrier` 記一筆**
 * （[#858](https://github.com/DemianLi/nexus-agent/issues/858)）：載體是一次性的 `task` 由父圖那一側取走的，背景位址沒有人取。
 * 結算摘要的 `max-tokens` 不靠它，讀的是子代理自己日誌上回覆的 `finish_reason`。
 *
 * @module
 */

import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { HumanMessage } from '@langchain/core/messages';
import {
  BACKGROUND_SESSION_CONFIG_KEY,
  STEP_INBOX_CONFIG_KEY,
  TURN_CANCEL_CONFIG_KEY,
  appendSubagentCatalog,
  fromLoggedMessage,
  toLoggedMessage,
  turnReachedMaxTokens,
} from '@nexus/core';
import type {
  SessionEventMap,
  SessionLog,
  SessionRegistry,
  StepInbox,
  SubagentSettleReason,
} from '@nexus/core';

import { BACKGROUND_RUN_PREFIX, agentMessageText } from './background-run-id.js';
import { markProjectionsHandled } from './thread-pump.js';
import type { RunProjections } from './thread-pump.js';

/** host 對背景圖的全部要求：給我一個可抽的 v3 run。`AgentHandle.compileSubagent` 編出來的圖照 pump 的做法轉型過來。 */
export interface BackgroundAgent {
  streamEvents(
    input: never,
    config: {
      readonly version: 'v3';
      readonly configurable: Readonly<Record<string, unknown>>;
    },
  ): Promise<AsyncIterable<unknown> & RunProjections>;
}

/** 一輪的下場。**永遠是回傳值，不會 reject**——拋錯已記成 `turn/failed`。 */
export type BackgroundRoundOutcome =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

/** 每個主對話同時存活的背景子代理上限的預設值（dsh `SubagentRuntime.Config.maxActiveSubagents`，`477b4f4`）。 */
export const DEFAULT_MAX_ACTIVE_BACKGROUND_SUBAGENTS = 8;

/** 一個背景子代理的一段（epoch）怎麼結束的，決定通知的第一行。 */
export type BackgroundStopReason = SubagentSettleReason;

/**
 * 一個背景子代理結算了（[#840](https://github.com/DemianLi/nexus-agent/issues/840)）：沒有輪次在跑、排著的也空了。
 * 給主對話的通知，內容照 dsh 的 `createSettlementMessage`（`subagent/src/continuation-messages.ts`，`477b4f4`）。
 */
export interface BackgroundSettlement {
  /** 背景子代理的編號（模型手上的那個）。 */
  readonly runId: string;
  /** 它的會話 id（日誌上的寄件人）。 */
  readonly sessionId: string;
  /** 一行摘要，說它怎麼收的。 */
  readonly summary: string;
  /** 怎麼收的（[#884](https://github.com/DemianLi/nexus-agent/issues/884)）：`summary` 的來源，畫面認這個、不解析英文句。 */
  readonly reason: BackgroundStopReason;
  /** 送進主對話模型的整段字：摘要，加上它最後一則回覆的非空文字，沒有就是 `It left no closing message.`。 */
  readonly text: string;
}

/**
 * 在背景子代理的第一句任務後面接上回報指引（[#849](https://github.com/DemianLi/nexus-agent/issues/849)），逐字照 dsh 的
 * `withContinuableReturnGuidance`（`subagent/src/continuation-messages.ts`，`477b4f4`）。
 *
 * 偏離登記：dsh 把指引當獨立的一個 text block 接在任務 blocks 後面；我們的任務是單一字串，用空行接在後面。
 * parent id 照 dsh 用 `JSON.stringify` 帶引號。
 *
 * @param prompt - 第一輪的人話。
 * @param parentId - 直接 parent（主對話）的會話 id。
 */
export function withReturnGuidance(prompt: string, parentId: string): string {
  const encoded = JSON.stringify(parentId);
  return (
    `${prompt}\n\n` +
    `Your parent agent id is ${encoded}. Before you finish, send your result to that agent with ` +
    `send_message({ agent_id: ${encoded}, message: "<self-contained result>" }). The parent shares ` +
    'your workspace but does not automatically receive your transcript, tool output, or reasoning. Send ' +
    'earlier messages as well when a finding changes what the parent should do next; sending a message ' +
    'does not end your turn.'
  );
}

/** 背景子代理用 `send_message` 寫給主對話的一則話（[#849](https://github.com/DemianLi/nexus-agent/issues/849)）。 */
export interface BackgroundAgentMessage {
  /** 寄件的背景子代理的編號。 */
  readonly runId: string;
  /** 它的會話 id（日誌上的寄件人）。 */
  readonly sessionId: string;
  /** 送進主對話模型的整段字，含 dsh 的前綴 `Agent <寄件人> sent a message: `。 */
  readonly text: string;
}

/**
 * 背景子代理往主對話這個方向的出口。**兩個都沒給就沒有人被通知**（cli 的 REPL 一行一輪，沒有可以叫醒的一輪）。
 * serve 傳 pump 的 `notifySettled` 與 `receiveAgentMessage`。
 */
export interface BackgroundParentPort {
  /** 背景子代理結算了（#840）。 */
  readonly onSettled?: (settlement: BackgroundSettlement) => void;
  /** 背景子代理寫來一則話（#849）。 */
  readonly onMessage?: (message: BackgroundAgentMessage) => void;
  /** 背景子代理的現況變了（#867）：整份，不是差量。 */
  readonly onStatus?: (items: readonly BackgroundSubagentStatus[]) => void;
}

/** 一個背景子代理此刻的狀態（#867），見 {@link BackgroundSubagentHost.statuses}。 */
export interface BackgroundSubagentStatus {
  readonly runId: string;
  readonly status: 'running' | 'idle';
}

/**
 * 一行摘要，逐字照 dsh 的 `settlementSummary`。dsh 還有一支 `refusal`（`declined the task`，pre-step 的 hook 拒絕丟掉
 * 已領走的輸入）：我們沒有那條路，所以沒有這一格。
 */
export function settlementSummary(runId: string, reason: BackgroundStopReason): string {
  const subject = `Background subagent ${runId}`;
  switch (reason) {
    case 'completed':
      return `${subject} finished and will do no further work unless you send it more.`;
    case 'aborted':
      return `${subject} was stopped before it finished.`;
    case 'max-tokens':
      return `${subject} ran out of room before it finished.`;
    case 'error':
      return `${subject} failed before it finished.`;
  }
}

/**
 * 結算通知的整段字。dsh 是幾個 text 區塊（摘要、`Its closing message:`、子代理的文字區塊）；我們的 `turn/start.text` 與
 * `HumanMessage` 是一個字串，區塊之間空一行。
 */
export function settlementText(summary: string, closing: string): string {
  return closing === ''
    ? `${summary}\n\nIt left no closing message.`
    : `${summary}\n\nIts closing message:\n${closing}`;
}

/** 這一輪最後一則回覆的非空文字；一則回覆都沒有、或沒有文字就是空字串。只看這一輪（最近一顆 `turn/start` 之後）。 */
function closingTextOf(log: SessionLog): string {
  const events = log.events;
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at]!;
    if (event.type === 'turn/start') return '';
    if (event.type !== 'assistant/message') continue;
    return fromLoggedMessage(event.data.message).text.trim();
  }
  return '';
}

/** {@link BackgroundSubagentHost.list} 的一列。 */
export interface BackgroundSubagentListing {
  readonly runId: string;
  /** 子代理的種類名（規格名）。 */
  readonly label: string;
  readonly status: 'running' | 'inactive';
}

export interface BackgroundSubagentHostOptions {
  /** 背景子代理的日誌開在哪：**root 的那張註冊表**，不另開第二張（第二張會讓 `forCall` 回 `ambiguous`，事件兩邊都沒有）。 */
  readonly sessions: SessionRegistry;
  /**
   * 按子代理名編圖（帶存檔點，見 `AgentHandle.compileSubagent`）。**每個 `(名字, 模型, 推理等級)` 只編一次**。`choice` 是
   * 型錄 id 加選填的推理等級（[#876](https://github.com/DemianLi/nexus-agent/issues/876)、
   * [#877](https://github.com/DemianLi/nexus-agent/issues/877)）：省略就是沿用 root 的；給了就用依它建出的實例。
   */
  readonly compile: (subagent: string, choice?: ModelChoice) => BackgroundAgent;
  /**
   * 這一輪整個包進去跑。預設原樣跑。產品接線傳 `(log, run) => controller.delegateFromLog(log, run)`。
   * 它拋錯（例如日誌上沒有記委派那一格）就是這一輪失敗，走 `turn/failed`。
   */
  readonly enter?: <T>(log: SessionLog, run: () => T) => T;
  /** 拿不到日誌所以沒地方記的失敗，講一聲。不影響輪次。 */
  readonly warn?: (message: string) => void;
  /**
   * 同時存活的背景子代理上限，預設 {@link DEFAULT_MAX_ACTIVE_BACKGROUND_SUBAGENTS}，要求是 ≥ 1 的整數。
   *
   * **一個 host 就是一個主對話**（在 root 的註冊表上建），所以這個數就是「每個主對話各自的」，不是整台主機的；
   * 主對話自己與一次性子代理不經過 host，不算在內。**存活**＝有輪次排著或正在跑；跑完了而且沒有排著的
   * 就是已結算，讓出名額。已結算的再收到一句話（`submit`）要重新佔一格，滿了就被拒絕。
   */
  readonly maxActive?: number;
  /**
   * 背景子代理結算時通知主對話（#840）：**同步呼叫、在該子代理讓出所有權之前**（呼叫端等到的 `outcome` 在這之後才 resolve），
   * 對每一個拿到過編號的子代理無條件送一則（dsh 明寫）。沒給就沒有人被通知（cli 的 REPL 一行一輪，沒有可以叫醒的一輪）。
   * 它拋錯只講一聲（`warn`），不影響輪次。
   */
  readonly onSettled?: (settlement: BackgroundSettlement) => void;
  /**
   * 背景子代理寫話給主對話的出口（#849）。**沒給就寄不出去**：`sendToParent` 拋（dsh：沒有持久的 parent 信箱，
   * 找不到活著的 parent 就拒絕，不收下做不到的事）。同步呼叫；它拋錯就是這一則沒送到，原樣往上拋給呼叫的工具。
   */
  readonly onMessage?: (message: BackgroundAgentMessage) => void;
  /**
   * 現況變了的出口（[#867](https://github.com/DemianLi/nexus-agent/issues/867)）：**整份**（每個認得的編號各一項），
   * 接上的當下先叫一次（可以是空的），之後內容真的變了才叫（連續兩次相同不重送）。從輪次的邊界叫，不是從呼叫端的環境，所以同 `onSettled` 綁在建構那一刻的環境。
   * 它拋錯只講一聲（`warn`），不影響輪次。
   */
  readonly onStatus?: (items: readonly BackgroundSubagentStatus[]) => void;
}

/** {@link BackgroundSubagentError} 的分類：wire 層照它回不同的錯誤碼，不靠比對訊息。 */
export type BackgroundSubagentErrorCode = 'closed' | 'not-found' | 'at-capacity';

/**
 * 往背景子代理送話或查它時被拒的原因，帶**型別化的碼**。訊息是給模型／人看的那句話，原樣不變；碼是給程式分流的
 * （wire 的 `subagent.send` 把它譯成三個錯誤碼，不去比對中文訊息）。
 */
export class BackgroundSubagentError extends Error {
  readonly code: BackgroundSubagentErrorCode;

  constructor(code: BackgroundSubagentErrorCode, message: string) {
    super(message);
    this.name = 'BackgroundSubagentError';
    this.code = code;
  }
}

/**
 * 主對話**以外**的人（wire 上的人）對單一背景子代理的控制面（[#865](https://github.com/DemianLi/nexus-agent/issues/865)）。
 * 同一個 host 的兩個動作，不另外存狀態。
 */
export interface BackgroundSubagentControl {
  /** {@link BackgroundSubagentHost.sendFromUser}。同步接受或拋 {@link BackgroundSubagentError}，不等那一輪跑完。 */
  readonly sendFromUser: (runId: string, text: string) => void;
  /** {@link BackgroundSubagentHost.interrupt}。 */
  readonly interrupt: (runId: string) => boolean;
}

/**
 * `attachSession` 回的收線函式。**上面掛著 `background`**：這份組裝有背景派出（且接上了 host）時，wire 對單一背景子代理
 * 傳話、單獨停的控制面（[#865](https://github.com/DemianLi/nexus-agent/issues/865)）；沒有就缺席，wire 回
 * `subagent_not_found`。掛在收線函式上是為了不動 cli 與其他呼叫端的簽名——它們只當作 `() => void` 用。
 */
export type SessionDetach = (() => void) & { readonly background?: BackgroundSubagentControl };

interface Job {
  readonly runId: string;
  readonly subagent: string;
  /** 這個背景子代理用哪一顆模型與推理等級；省略＝沿用 root 的。一個編號從派出到收線都是同一份。 */
  readonly choice?: ModelChoice;
  /** 送進模型的那串字。 */
  readonly text: string;
  /** 這一輪開頭寫進日誌的 `turn/start`；`text` 與它裡面的 `text` 是同一個值。 */
  readonly turn: SessionEventMap['turn/start'];
  readonly settle: (outcome: BackgroundRoundOutcome) => void;
  /** 這一輪的下場（{@link settle} 交出去的那個）：插進跑著的這一輪的話，`send` 回的也是它。 */
  readonly outcome: Promise<BackgroundRoundOutcome>;
}

/** 插進跑著的一輪、還沒被下一步領走的一句話（#858）。 */
interface Steer {
  /** 成為 `HumanMessage` 的 id：日誌、checkpoint、推回模型的是同一則。 */
  readonly id: string;
  /** 送進模型的整段字：agent 寫的含 `Agent <寄件人> sent a message: ` 前綴，人說的是原文。 */
  readonly text: string;
  /** agent 寫的才有（寄件人的會話 id）；**沒有就是人說的**（`sendFromUser`），日誌來源是 `user`、不加前綴。 */
  readonly senderSessionId?: string;
}

/**
 * 正在跑的一輪（每個子代理至多一個）。中止控制器之外，多了這一輪的插話收件匣：`steers` 是排著的，
 * `closed` 是圖收尾時問過最後一次、窗關了（之後到的話改排下一輪）。
 */
interface RunningRound {
  readonly controller: AbortController;
  readonly outcome: Promise<BackgroundRoundOutcome>;
  readonly steers: Steer[];
  closed: boolean;
}

/** 一句話在子代理日誌裡開一輪時的 `turn/start`：人說的是 `message`，agent 寫的是 `agent-message`（記寄件人）。 */
function turnOf(body: {
  readonly text: string;
  readonly senderSessionId?: string;
}): SessionEventMap['turn/start'] {
  return body.senderSessionId === undefined
    ? { kind: 'message', text: body.text }
    : { kind: 'agent-message', text: body.text, senderSessionId: body.senderSessionId };
}

/**
 * 一個背景子代理被指定的模型（[#876](https://github.com/DemianLi/nexus-agent/issues/876)、
 * [#877](https://github.com/DemianLi/nexus-agent/issues/877)）：型錄 id，加選填的推理等級。dsh 的 continuable descriptor 也是
 * 把解析後的 provider、model、effort 一起記下來；我們沒有 provider 這一層。
 */
export interface ModelChoice {
  /** 型錄 id。 */
  readonly model: string;
  /** 推理等級（型錄條目宣告過的名字）；省略＝這顆模型的預設。 */
  readonly effort?: string;
}

/** 兩份選擇是不是同一份：圖快取鍵與「不能換」都比它。 */
function choiceKey(choice: ModelChoice | undefined): string {
  return choice === undefined ? '' : `${choice.model}\0${choice.effort ?? ''}`;
}

/** 錯誤訊息裡怎麼稱呼一份選擇：沒指定就是沿用 root 的。 */
function describeChoice(choice: ModelChoice | undefined): string {
  if (choice === undefined) return '沿用主對話的';
  return choice.effort === undefined
    ? `"${choice.model}"`
    : `"${choice.model}"（推理 ${choice.effort}）`;
}

/**
 * 背景子代理的拉起載體。**在任何圖的環境之外建**，理由見檔頭。
 */
export class BackgroundSubagentHost {
  readonly #sessions: SessionRegistry;
  readonly #compile: (subagent: string, choice?: ModelChoice) => BackgroundAgent;
  readonly #enter: NonNullable<BackgroundSubagentHostOptions['enter']>;
  readonly #warn: ((message: string) => void) | undefined;
  readonly #onSettled: BackgroundSubagentHostOptions['onSettled'];
  readonly #onMessage: BackgroundSubagentHostOptions['onMessage'];
  readonly #onStatus: BackgroundSubagentHostOptions['onStatus'];
  /** 上一次送出去的現況（序列化），沒變就不重送。起頭是 `undefined`：建構完那一刻一定送一份（可以是空的）。 */
  #lastStatus: string | undefined;
  readonly #maxActive: number;
  readonly #graphs = new Map<string, BackgroundAgent>();
  /** 已知的背景子代理：編號 → 子代理名。同一個編號不能換名字。 */
  readonly #known = new Map<string, string>();
  /** 編號 → 它被指定的模型與推理等級（#876、#877）；沒指定的不在裡面。同一個編號不能換，之後每一輪都沿用。 */
  readonly #choices = new Map<string, ModelChoice>();
  readonly #queue: Job[] = [];
  readonly #busy = new Set<string>();
  /** 正在跑的那一輪（每輪一個，跑完就丟）：中止控制器（`interrupt` 只舉這一個）與這一輪的插話收件匣（#858）。 */
  readonly #running = new Map<string, RunningRound>();
  /**
   * 被中斷之後暫停的：它排著的輪次不丟、也不開跑，等下一次 `submit` 才恢復（dsh：被中斷的 driver 進入 idle 後，
   * 一次喚醒發送會恢復被暫停的 FIFO 佇列，`docs/subsystems/subagent.zh.md:152` 附近）。
   */
  readonly #paused = new Set<string>();
  readonly #inflight = new Set<Promise<void>>();
  #wake: (() => void) | undefined;
  #closed = false;
  readonly #loop: Promise<void>;

  constructor(options: BackgroundSubagentHostOptions) {
    this.#sessions = options.sessions;
    this.#compile = options.compile;
    this.#enter = options.enter ?? ((_log, run) => run());
    this.#warn = options.warn;
    // **出口綁在建構這一刻的非同步環境**：`onMessage` 是從子代理的工具呼叫裡被叫的，而出口會排程主對話的一輪——
    // 不綁的話那一輪繼承子代理的 LangGraph／日誌路由環境，主對話的回覆就記到子代理的日誌名下（#849 的 live 實跑抓到）。
    // `onSettled` 本來就從迴圈的環境叫，一起綁只是讓兩個出口的規矩一致。
    this.#onSettled =
      options.onSettled === undefined ? undefined : AsyncResource.bind(options.onSettled);
    this.#onMessage =
      options.onMessage === undefined ? undefined : AsyncResource.bind(options.onMessage);
    this.#onStatus =
      options.onStatus === undefined ? undefined : AsyncResource.bind(options.onStatus);
    const maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE_BACKGROUND_SUBAGENTS;
    if (!Number.isInteger(maxActive) || maxActive < 1) {
      throw new Error(`背景子代理的並存上限要是 ≥ 1 的整數，收到 ${String(maxActive)}`);
    }
    this.#maxActive = maxActive;
    // 迴圈在**這裡**起：它的環境就是建構這一刻的環境。
    this.#loop = this.#run();
    // 接上的當下就送一份現況，**即使是空的**：沒收過＝不知道，收過而沒有這個編號＝收線，web 靠這個分開兩者（#867）。
    this.#publishStatus();
  }

  /**
   * 給一個背景子代理多一句話（第一句就是它的誕生）。
   *
   * @param input.runId - 背景子代理的編號（穩定的，#823）。
   * @param input.subagent - 它是哪一種子代理（規格名）。同一個編號必須一直是同一種。
   * @param input.text - 這一輪的人話。
   * @returns 這一輪的下場。**不會 reject**；host 已關閉時是 `{ ok: false }`。
   */
  submit(input: {
    readonly runId: string;
    readonly subagent: string;
    readonly text: string;
    readonly choice?: ModelChoice;
  }): Promise<BackgroundRoundOutcome> {
    if (this.#closed) return Promise.resolve({ ok: false, error: '背景子代理的載體已經關閉' });
    const full = this.#capacityRefusal(input.runId);
    if (full !== undefined) return Promise.resolve({ ok: false, error: full });
    const known = this.#known.get(input.runId);
    if (known !== undefined && known !== input.subagent) {
      return Promise.resolve({
        ok: false,
        error: `背景子代理 ${input.runId} 是 "${known}"，不能當成 "${input.subagent}"`,
      });
    }
    if (
      known !== undefined &&
      choiceKey(this.#choices.get(input.runId)) !== choiceKey(input.choice)
    ) {
      return Promise.resolve({
        ok: false,
        error: `背景子代理 ${input.runId} 的模型是 ${describeChoice(this.#choices.get(input.runId))}，不能換成 ${describeChoice(input.choice)}`,
      });
    }
    this.#known.set(input.runId, input.subagent);
    if (input.choice !== undefined) this.#choices.set(input.runId, input.choice);
    // 一次新的送話喚醒被中斷後暫停的佇列（排在前面的照舊先跑）。
    this.#paused.delete(input.runId);
    return this.#enqueue({
      runId: input.runId,
      subagent: input.subagent,
      ...(input.choice !== undefined && { choice: input.choice }),
      text: input.text,
      turn: { kind: 'message', text: input.text },
    });
  }

  #newJob(job: Omit<Job, 'settle' | 'outcome'>): Job {
    let settle!: (outcome: BackgroundRoundOutcome) => void;
    const outcome = new Promise<BackgroundRoundOutcome>((resolve) => {
      settle = resolve;
    });
    return { ...job, settle, outcome };
  }

  #enqueue(job: Omit<Job, 'settle' | 'outcome'>): Promise<BackgroundRoundOutcome> {
    const queued = this.#newJob(job);
    this.#queue.push(queued);
    this.#publishStatus();
    this.#wake?.();
    return queued.outcome;
  }

  /**
   * 父代理給一個背景子代理追加指示（[#839](https://github.com/DemianLi/nexus-agent/issues/839)，dsh
   * `SubagentRuntime.sendMessage`，`477b4f4`）。**同步接受或拒絕**，接受之後那一輪獨立跑。
   *
   * - 只有這個主對話派出去的編號（host 就是這個主對話的）；不認得的編號拋，訊息說明原因。
   * - 模型看到的文字加 dsh 的前綴 `Agent <寄件人> sent a message: `；日誌那一輪的 `turn/start` 是
   *   `agent-message`（記寄件人，**不授予權限、也不是人話**），不是 `message`。
   * - 對方閒著：開新的一輪。對方正在跑：**插進當下那一輪，下一步領走**（[#858](https://github.com/DemianLi/nexus-agent/issues/858)，
   *   同 dsh 的 “a working agent receives it at its next step”），回的是那一輪的下場。**那一輪被中止了、或圖收尾時窗已經關了**
   *   就排成它的下一輪（同 pump 的 `#acceptsSteer`）。
   * - 對方是被中斷後暫停的：這一則喚醒它，排在前面的輪次照舊先跑（#838）。
   * - 對方已結算而名額滿了：拒絕（同 `submit`，#836）。
   *
   * @returns 接受之後那一輪的下場（不會 reject）。
   * @throws host 已關閉；沒有這個編號；名額滿了。
   */
  send(input: {
    readonly runId: string;
    readonly message: string;
  }): Promise<BackgroundRoundOutcome> {
    // 寄件人＝這個主對話的 root：host 是它的，而這顆工具只給 root（`rootOnly`），所以不必由呼叫端聲明。
    const sender = this.#sessions.root.sessionId;
    return this.#deliver(input.runId, {
      text: agentMessageText(sender, input.message),
      senderSessionId: sender,
    });
  }

  /**
   * 人（wire 上的 `subagent.send`）對單一背景子代理說一句話（[#865](https://github.com/DemianLi/nexus-agent/issues/865)，
   * dsh `prompt` 對 continuable 子代理的那一支，`477b4f4`）。**投遞規矩同 {@link send}**（跑著且窗開著：下一步領走；
   * 否則排成下一輪；已結算而名額滿了拒絕），差別在**身分**：
   *
   * - 模型看到的是**原文**，沒有 `Agent … sent a message: ` 前綴——那是人說的，不是 agent 轉的；
   * - 日誌那一輪的 `turn/start` 是 `message`、插進跑著的那一輪的 `user/message` 來源是 `user`。
   *
   * 授權不在這裡：host 只認得自己 root 派出去的編號（直接 parent 的鄰接是結構保證），誰能呼叫由 wire 那層的會話認證（#424）管。
   *
   * @returns 接受之後那一輪的下場（不會 reject）。
   * @throws {BackgroundSubagentError} host 已關閉；沒有這個編號；名額滿了。
   */
  sendFromUser(input: {
    readonly runId: string;
    readonly text: string;
  }): Promise<BackgroundRoundOutcome> {
    return this.#deliver(input.runId, { text: input.text });
  }

  /** 控制面（給 wire 用）：兩個動作都不回那一輪的下場，也不 reject。 */
  get control(): BackgroundSubagentControl {
    return {
      sendFromUser: (runId, text) => void this.sendFromUser({ runId, text }),
      interrupt: (runId) => this.interrupt(runId),
    };
  }

  #deliver(
    runId: string,
    body: { readonly text: string; readonly senderSessionId?: string },
  ): Promise<BackgroundRoundOutcome> {
    if (this.#closed) throw new BackgroundSubagentError('closed', '背景子代理的載體已經關閉');
    const subagent = this.#known.get(runId);
    if (subagent === undefined) {
      throw new BackgroundSubagentError(
        'not-found',
        `沒有編號 ${runId} 的背景子代理（用 list_agents 看有哪些；只能傳給自己派出去的）`,
      );
    }
    const full = this.#capacityRefusal(runId);
    if (full !== undefined) throw new BackgroundSubagentError('at-capacity', full);
    const round = this.#running.get(runId);
    if (round !== undefined && !round.closed && !round.controller.signal.aborted) {
      round.steers.push({ id: `steer-${randomUUID()}`, ...body });
      return round.outcome;
    }
    this.#paused.delete(runId);
    const choice = this.#choices.get(runId);
    return this.#enqueue({
      runId,
      subagent,
      ...(choice !== undefined && { choice }),
      text: body.text,
      turn: turnOf(body),
    });
  }

  /** 這個 host 的主對話（root）的會話 id：背景子代理的 parent，回報指引裡告訴它的那個 id。 */
  get rootSessionId(): string {
    return this.#sessions.root.sessionId;
  }

  /**
   * 背景子代理給自己的直接 parent 寫一則話（[#849](https://github.com/DemianLi/nexus-agent/issues/849)，dsh
   * `SubagentRuntime.sendMessage` 的 child→parent 那一向，`477b4f4`）。**同步接受或拒絕**。
   *
   * - 寄件人必須是這個 host 認得的背景子代理；收件人只能是它的**直接 parent**，也就是這個 host 的 root。
   *   別的編號（兄弟、自己、不存在的）一律拒絕：dsh「Agent-message authority is exact adjacency」。
   * - 模型看到的文字加 dsh 的前綴 `Agent <寄件人> sent a message: `，寄件人是**子代理自己的會話 id**。
   * - 投遞由 `onMessage` 決定（產品接線是 pump 的 `receiveAgentMessage`：閒著叫醒、忙著插話）。
   *
   * @throws host 已關閉；寄件人不是這裡的背景子代理；收件人不是它的直接 parent；沒有出口（主對話收不到）。
   */
  sendToParent(input: {
    readonly runId: string;
    readonly targetId: string;
    readonly message: string;
  }): void {
    if (this.#closed) throw new BackgroundSubagentError('closed', '背景子代理的載體已經關閉');
    if (!this.#known.has(input.runId)) {
      throw new BackgroundSubagentError(
        'not-found',
        `${input.runId} 不是這個主對話派出去的背景子代理，不能往上傳訊`,
      );
    }
    if (input.targetId !== this.rootSessionId) {
      throw new Error(
        `${input.targetId} 不是你的直接 parent（${this.rootSessionId}）；背景子代理只能傳給它的直接 parent`,
      );
    }
    if (this.#onMessage === undefined) {
      throw new Error('主對話現在收不到訊息（沒有可以叫醒的一輪）');
    }
    const sessionId = this.#sessions.open({ kind: 'subagent', runId: input.runId }).sessionId;
    this.#onMessage({
      runId: input.runId,
      sessionId,
      text: agentMessageText(sessionId, input.message),
    });
  }

  /**
   * 派出一個新的背景子代理（第一句就是它的誕生），**同步**回編號。
   *
   * 同步是為了「收件匣接受那一刻」：呼叫端可以把這一步包在沙箱控制器的 `delegate` 裡，日誌在這一行之內開好、
   * 參與者同步裝上並把 `sandbox/mode {source:'delegation'}` 寫進去，之後每一輪由 `enter` 從那一顆讀回。
   * 編成圖也在這裡做（快取），所以不認得的子代理、profile 不許的組成當場拋，不是變成背景那一輪的 `turn/failed`。
   *
   * @param input.subagent - 子代理名（規格名）。
   * @param input.text - 第一輪的人話。
   * @param input.choice - 這個子代理用哪一顆模型與推理等級，省略＝沿用 root 的；之後每一輪都是它（#876、#877）。
   * @param input.callId - 派它的那一顆 `tool/call`（root 那一份上的）。給了就在 root 記一顆 `subagent/catalog`（#1023），
   *   **在接受第一句話之後**，同 dsh continuable「先准入、再寫目錄、最後回 id」。
   * @returns 編號（`bg-` 加隨機，不是計數器：root 續接之後不能撞上舊日誌）與第一輪的下場。
   * @throws host 已關閉；存活的背景子代理已達並存上限；編不出這個子代理的圖。
   */
  start(input: {
    readonly subagent: string;
    readonly text: string;
    readonly choice?: ModelChoice;
    readonly callId?: string;
  }): {
    readonly runId: string;
    readonly outcome: Promise<BackgroundRoundOutcome>;
  } {
    if (this.#closed) throw new BackgroundSubagentError('closed', '背景子代理的載體已經關閉');
    // 先於編圖與開日誌：滿了就一樣東西都不留（沒有編號、沒有日誌）。
    const full = this.#capacityRefusal(undefined);
    if (full !== undefined) throw new BackgroundSubagentError('at-capacity', full);
    this.#agentFor(input.subagent, input.choice);
    let runId: string;
    do runId = `${BACKGROUND_RUN_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    while (this.#known.has(runId));
    const childId = this.#sessions.open({ kind: 'subagent', runId }).sessionId;
    const { callId, ...first } = input;
    const outcome = this.submit({ runId, ...first });
    if (callId !== undefined) {
      appendSubagentCatalog(this.#sessions.root, { childId, callId, mode: 'continuable' });
    }
    return { runId, outcome };
  }

  /**
   * 只停這個背景子代理**當下那一輪**（[#838](https://github.com/DemianLi/nexus-agent/issues/838)，dsh
   * `SubagentRuntime.interrupt`，`477b4f4`）。同步、不等停穩就回。
   *
   * - 舉的是那一輪自己的控制器，經 `TURN_CANCEL_CONFIG_KEY` 走合作式中止（等落定中的工具、不開新的、模型請求切斷）；
   *   **不是 root 的訊號**，root 按停止照舊不連帶它。
   * - 它**排著還沒領走的輪次不丟**，但暫停到下一次 `submit`。
   * - 不存在的編號、沒在跑的（已結算或只排著）：被接受的 no-op，回 `false`（dsh 明寫，不是錯誤）。
   *
   * @returns 有舉起一輪的中止就是 `true`。
   */
  interrupt(runId: string): boolean {
    const round = this.#running.get(runId);
    if (round === undefined) return false;
    if (round.controller.signal.aborted) return true;
    this.#paused.add(runId);
    round.controller.abort();
    this.#publishStatus();
    return true;
  }

  /**
   * 每個認得的背景子代理此刻的狀態，依派出的先後（[#867](https://github.com/DemianLi/nexus-agent/issues/867)）。
   *
   * `running`＝有一輪正在跑，或排著一輪**且沒被中斷暫停**；其餘是 `idle`。跟 {@link list} 的 `running` 不同：後者照 dsh
   * 只看有沒有輪次，被中斷後暫停的排著的輪次也算；這裡是給「停止這一輪」鈕與輸入框用的，暫停的不算在跑。
   */
  statuses(): readonly BackgroundSubagentStatus[] {
    return [...this.#known.keys()].map((runId) => ({
      runId,
      status:
        this.#busy.has(runId) ||
        (!this.#paused.has(runId) && this.#queue.some((job) => job.runId === runId))
          ? 'running'
          : 'idle',
    }));
  }

  #publishStatus(): void {
    if (this.#onStatus === undefined) return;
    const items = this.statuses();
    const key = JSON.stringify(items);
    if (key === this.#lastStatus) return;
    this.#lastStatus = key;
    try {
      this.#onStatus(items);
    } catch (error) {
      try {
        this.#warn?.(
          `[背景子代理] 現況沒送到主對話：${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // 講不出來也不影響輪次。
      }
    }
  }

  /**
   * 目錄：這個主對話派出去的每一個背景子代理，依派出的先後。給 `list_agents`（#837）。
   *
   * `running`＝有輪次排著或正在跑（dsh 的 `running` 只看有沒有輪次在做事，不透露是否載入）；
   * 其餘是 `inactive`。`label` 是子代理的種類名。
   */
  list(): readonly BackgroundSubagentListing[] {
    const active = this.#activeRunIds();
    return [...this.#known].map(([runId, label]) => ({
      runId,
      label,
      status: active.has(runId) ? 'running' : 'inactive',
    }));
  }

  /** 存活的背景子代理：有輪次排著或正在跑的編號。 */
  #activeRunIds(): Set<string> {
    return new Set([...this.#queue.map((job) => job.runId), ...this.#busy]);
  }

  /**
   * 再收一個（或讓一個已結算的復活）會不會超過上限；會就回要給模型看的那句話。
   *
   * @param runId - 已有編號的（`submit`）；`undefined` 是全新的（`start`）。已存活的再收一句話不佔新的一格。
   */
  #capacityRefusal(runId: string | undefined): string | undefined {
    const active = this.#activeRunIds();
    if (runId !== undefined && active.has(runId)) return undefined;
    if (active.size < this.#maxActive) return undefined;
    return `背景子代理已達並存上限 ${String(this.#maxActive)}（現在有 ${String(active.size)} 個在跑）；等其中一個做完再派。`;
  }

  /** 排隊中與進行中的輪都收完。 */
  async idle(): Promise<void> {
    while (this.#queue.length > 0 || this.#inflight.size > 0) {
      if (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
      // 排著但迴圈還沒撿起來的那一拍。
      else await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /**
   * 不再收新的輪，**中止**進行中的（走合作式中止，同 `interrupt`），排著的不再跑，然後等它們收完、結束迴圈。
   *
   * 中止是[#841](https://github.com/DemianLi/nexus-agent/issues/841)補的：背景續行變成 serve 的出廠預設之後，
   * 關 thread（伺服器停止）不能等一個還在燒模型的子代理自己想完；等它收完的話，一個跑很久的子代理會讓整台 server
   * 停不下來。被中止的那一輪照常寫 `turn/end`（reason aborted）、照常結算通知（主對話已收線時只落進佇列，不喚醒）。
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#queue) this.#paused.add(job.runId);
    for (const [runId, round] of this.#running) {
      this.#paused.add(runId);
      round.controller.abort();
    }
    this.#publishStatus();
    this.#wake?.();
    await this.#loop;
  }

  /** 關閉之後：被中斷而暫停的輪次不會再有人喚醒，當作沒跑成交出去，免得 `close()` 永遠等。 */
  #dropPaused(): void {
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const job = this.#queue[index]!;
      if (!this.#paused.has(job.runId)) continue;
      this.#queue.splice(index, 1);
      job.settle({ ok: false, error: '這個背景子代理被中斷後沒有再收到訊息，這一輪沒有跑' });
    }
  }

  async #run(): Promise<void> {
    for (;;) {
      if (this.#closed) this.#dropPaused();
      const job = this.#takeRunnable();
      if (job !== undefined) {
        // 從**迴圈**的環境拉起，不是從呼叫 `submit` 的環境。
        this.#busy.add(job.runId);
        this.#publishStatus();
        // **先讓出位子、再交下場**：呼叫端等到 `outcome` 的時候，這個子代理已經不算存活（並存上限、
        // 之後的結算通知都靠這個順序）。
        const round: Promise<void> = this.#round(job).then(({ outcome, settlement, leftover }) => {
          this.#busy.delete(job.runId);
          this.#inflight.delete(round);
          this.#requeueSteers(job, leftover);
          this.#publishStatus();
          this.#wake?.();
          // 結算＝這個子代理沒有輪次排著了（被中斷而暫停的排著就不算）。**在交下場之前通知**，同 dsh 在所有權釋放之前。
          if (!this.#queue.some((queued) => queued.runId === job.runId))
            this.#notifySettled(settlement);
          job.settle(outcome);
        });
        this.#inflight.add(round);
        continue;
      }
      if (this.#closed && this.#queue.length === 0 && this.#inflight.size === 0) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  /** 排隊裡第一個「它的子代理現在沒在跑」的。 */
  #takeRunnable(): Job | undefined {
    const index = this.#queue.findIndex(
      (job) => !this.#busy.has(job.runId) && !this.#paused.has(job.runId),
    );
    if (index < 0) return undefined;
    return this.#queue.splice(index, 1)[0];
  }

  #agentFor(subagent: string, choice?: ModelChoice): BackgroundAgent {
    // 鍵含模型與推理等級：同名的子代理、不同的選擇是兩張圖，互不污染（#876、#877）。
    const key = choice === undefined ? subagent : `${subagent}\0${choiceKey(choice)}`;
    const cached = this.#graphs.get(key);
    if (cached !== undefined) return cached;
    const compiled = this.#compile(subagent, choice);
    this.#graphs.set(key, compiled);
    return compiled;
  }

  /**
   * 這一輪結束時還沒被領走的插話（被中止、出錯，或窗關之前最後一步沒走到）退回成排著的輪次，排在這個子代理其他排著的
   * 前面（它們比較早到）。**不丟**：`send_message` 已經回了送達回條，沒領走就是欠著的。被中斷暫停的（`interrupt`、`close` 都會
   * 把跑著的那一輪的子代理記成暫停）照原規矩不開跑；`close` 的迴圈會把它們當作沒跑成交出去。
   */
  #requeueSteers(job: Job, leftover: readonly Steer[]): void {
    if (leftover.length === 0) return;
    const jobs = leftover.map((steer) =>
      this.#newJob({
        runId: job.runId,
        subagent: job.subagent,
        ...(job.choice !== undefined && { choice: job.choice }),
        text: steer.text,
        turn: turnOf(steer),
      }),
    );
    this.#queue.unshift(...jobs);
  }

  async #round(job: Job): Promise<{
    readonly outcome: BackgroundRoundOutcome;
    readonly settlement: BackgroundSettlement | undefined;
    readonly leftover: readonly Steer[];
  }> {
    let outcome: BackgroundRoundOutcome;
    let stop: BackgroundStopReason = 'completed';
    let log: SessionLog | undefined;
    // 這一輪自己的中止控制器：`interrupt` 只舉它。跑完（不論怎麼結束）就丟。
    const controller = new AbortController();
    const running: RunningRound = { controller, outcome: job.outcome, steers: [], closed: false };
    this.#running.set(job.runId, running);
    try {
      log = this.#sessions.open({ kind: 'subagent', runId: job.runId });
      log.append('turn/start', job.turn);
      await this.#enter(log, () => this.#drive(log!, job, running));
      // 被父代理中斷的那一輪收成 aborted/parent；沒被中斷就是正常結束。
      log.append(
        'turn/end',
        controller.signal.aborted ? { reason: { kind: 'aborted', cause: { kind: 'parent' } } } : {},
      );
      // 中止先判，蓋過輸出上限，同 dsh（`agent-loop/src/agent.ts:349-355`）。
      stop = controller.signal.aborted
        ? 'aborted'
        : turnReachedMaxTokens(log.events)
          ? 'max-tokens'
          : 'completed';
      outcome = { ok: true };
    } catch (error) {
      stop = 'error';
      const message = error instanceof Error ? error.message : String(error);
      // 拿不到日誌的失敗（註冊表開不出來）沒地方記，只能講一聲。
      if (log === undefined) this.#warnFailure(job, message);
      else {
        try {
          log.append('turn/failed', { message });
        } catch (appendError) {
          this.#warnFailure(job, `${message}（連 turn/failed 都寫不進去：${String(appendError)}）`);
        }
      }
      outcome = { ok: false, error: message };
    } finally {
      // 從表裡拿掉，窗就跟著沒了：之後到的話是排下一輪，不是掛在一個已經沒人領的收件匣上。
      this.#running.delete(job.runId);
    }
    let settlement: BackgroundSettlement | undefined;
    if (log !== undefined) {
      const summary = settlementSummary(job.runId, stop);
      settlement = {
        runId: job.runId,
        sessionId: log.sessionId,
        summary,
        reason: stop,
        text: settlementText(summary, closingTextOf(log)),
      };
    }
    return { outcome, settlement, leftover: running.steers.splice(0) };
  }

  /** 通知主對話。沒人接（沒給 `onSettled`）、拿不到日誌所以沒通知可送（`settlement` 缺）都是不通知；送不出去只講一聲。 */
  #notifySettled(settlement: BackgroundSettlement | undefined): void {
    if (settlement === undefined || this.#onSettled === undefined) return;
    try {
      this.#onSettled(settlement);
    } catch (error) {
      this.#warnSettle(settlement.runId, error instanceof Error ? error.message : String(error));
    }
  }

  #warnSettle(runId: string, message: string): void {
    try {
      this.#warn?.(`[背景子代理] ${runId} 的結算通知沒送到主對話：${message}`);
    } catch {
      // 講不出來也不影響輪次。
    }
  }

  #warnFailure(job: Job, message: string): void {
    try {
      this.#warn?.(`[背景子代理] ${job.runId} 的一輪拉不起來：${message}`);
    } catch {
      // 講不出來也不影響輪次。
    }
  }

  /**
   * 交進圖裡的插話收件匣（#858），形狀同 pump 為 root 那一輪交的：**領走本身是同步的**（呼叫的那一刻整條拿掉），領走時落這個
   * 子代理**自己日誌**的 `user/message`（來源 `agent-message`，不授予權限、不是人話），回的訊息原封不動併進 state。
   * 中止之後不領——留著的由 {@link BackgroundSubagentHost.#requeueSteers} 退回成排著的輪次。`finish` 沒有東西可領就關窗。
   */
  #stepInboxFor(log: SessionLog, round: RunningRound): StepInbox {
    const take = (): HumanMessage[] => {
      if (round.controller.signal.aborted) return [];
      return round.steers.splice(0).map((steer) => {
        const message = new HumanMessage({ content: steer.text, id: steer.id });
        log.append('user/message', {
          message: toLoggedMessage(message),
          source:
            steer.senderSessionId === undefined
              ? { kind: 'user' }
              : { kind: 'agent-message', form: 'relay', senderSessionId: steer.senderSessionId },
        });
        return message;
      });
    };
    return {
      claim: () => Promise.resolve(take()),
      finish: () => {
        const taken = take();
        if (taken.length === 0) round.closed = true;
        return Promise.resolve(taken);
      },
    };
  }

  async #drive(log: SessionLog, job: Job, round: RunningRound): Promise<void> {
    const cancel = round.controller.signal;
    const run = await this.#agentFor(job.subagent, job.choice).streamEvents(
      { messages: [new HumanMessage(job.text)] } as never,
      {
        version: 'v3',
        // **只給明確的鍵**：不靠隱式繼承，也不帶 root 的中止訊號（見檔頭）。中止訊號是這一輪自己的
        // （`interrupt` 舉的那個），走合作式的 `TURN_CANCEL_CONFIG_KEY`，不交給 LangGraph 的 `signal`
        // （後者會丟下工具，見 `turn-cancel.ts` 檔頭）。
        configurable: {
          thread_id: log.sessionId,
          [BACKGROUND_SESSION_CONFIG_KEY]: job.runId,
          [TURN_CANCEL_CONFIG_KEY]: cancel,
          [STEP_INBOX_CONFIG_KEY]: this.#stepInboxFor(log, round),
        },
      },
    );
    // 在第一顆封包之前：投影裡的 promise 一建立就可能被 reject（#346）。
    markProjectionsHandled(run);
    for await (const _event of run) void _event;
  }
}
