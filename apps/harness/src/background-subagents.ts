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
 * 2. `configurable` **只給明確的鍵**：`thread_id`（日誌 id，`<root>/<runId>`，全域唯一）與
 *    {@link BACKGROUND_SESSION_CONFIG_KEY}。**不帶 root 的中止訊號**——dsh 的 root 停止不連帶停掉已派出去的
 *    背景子代理（`docs/subsystems/subagent.zh.md:152`，`477b4f4`），要個別停（卡 6 的 `interrupt_agent`）。
 * 3. 整輪包在注入的 `enter` 裡跑。產品接線時傳 `SandboxModeController.delegateFromLog`（#827）：沙箱那一格從子代理
 *    自己的日誌讀回，不是叫醒那刻 root 的現況。
 * 4. 走 v3 串流，並把投影裡沒人讀的 promise 標成已處理（`markProjectionsHandled`，#346）——裸走的話，工具本體拋錯會讓
 *    行程以未處理的 rejection 結束（探針的子行程對照組）。
 * 5. 收尾寫 `turn/end`；拋錯寫 `turn/failed`，錯誤在這裡收掉，不往外漏。
 *
 * 每個子代理**各自串行**（一次一輪，後到的排隊）、彼此並行。
 *
 * ## 結算通知（#840）
 *
 * 一個子代理沒有輪次在跑、排著的也空了，就是**結算**：對主對話送一則通知（{@link BackgroundSubagentHostOptions.onSettled}，
 * 內容見 {@link BackgroundSettlement}），時機在讓出所有權（交出 `outcome`）之前。被 `interrupt` 而暫停、還排著輪次的不算結算。
 * 怎麼叫醒主對話是 pump 的事（`ThreadPump.notifySettled`）。
 *
 * ## 沒做的
 *
 * {@link BackgroundSubagentHost.close} 只等進行中的輪收完，不中止它們。撞到輸出上限時，中介層在背景圖上照樣丟工具呼叫
 * （它在子代理的那一疊裡），並在 `MaxTokensCarrier` 記一筆；一次性的 `task` 由父圖那一側取走，背景位址沒有人取，
 * 每個撞過上限的背景子代理在載體裡留一筆（同一個編號會蓋掉，數量以派出的子代理為界）。結算摘要的 `max-tokens` 不靠它，
 * 讀的是子代理自己日誌上回覆的 `finish_reason`。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import { HumanMessage } from '@langchain/core/messages';
import {
  BACKGROUND_SESSION_CONFIG_KEY,
  TURN_CANCEL_CONFIG_KEY,
  fromLoggedMessage,
  turnReachedMaxTokens,
} from '@nexus/core';
import type { SessionEventMap, SessionLog, SessionRegistry } from '@nexus/core';

import { BACKGROUND_RUN_PREFIX } from './background-run-id.js';
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
export type BackgroundStopReason = 'completed' | 'aborted' | 'max-tokens' | 'error';

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
  /** 送進主對話模型的整段字：摘要，加上它最後一則回覆的非空文字，沒有就是 `It left no closing message.`。 */
  readonly text: string;
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
  /** 按子代理名編圖（帶存檔點，見 `AgentHandle.compileSubagent`）。每個名字只編一次。 */
  readonly compile: (subagent: string) => BackgroundAgent;
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
}

interface Job {
  readonly runId: string;
  readonly subagent: string;
  /** 送進模型的那串字。 */
  readonly text: string;
  /** 這一輪開頭寫進日誌的 `turn/start`；`text` 與它裡面的 `text` 是同一個值。 */
  readonly turn: SessionEventMap['turn/start'];
  readonly settle: (outcome: BackgroundRoundOutcome) => void;
}

/**
 * 背景子代理的拉起載體。**在任何圖的環境之外建**，理由見檔頭。
 */
export class BackgroundSubagentHost {
  readonly #sessions: SessionRegistry;
  readonly #compile: (subagent: string) => BackgroundAgent;
  readonly #enter: NonNullable<BackgroundSubagentHostOptions['enter']>;
  readonly #warn: ((message: string) => void) | undefined;
  readonly #onSettled: BackgroundSubagentHostOptions['onSettled'];
  readonly #maxActive: number;
  readonly #graphs = new Map<string, BackgroundAgent>();
  /** 已知的背景子代理：編號 → 子代理名。同一個編號不能換名字。 */
  readonly #known = new Map<string, string>();
  readonly #queue: Job[] = [];
  readonly #busy = new Set<string>();
  /** 正在跑的那一輪的中止控制器（每輪一個，跑完就丟）。`interrupt` 只舉這一個。 */
  readonly #running = new Map<string, AbortController>();
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
    this.#onSettled = options.onSettled;
    const maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE_BACKGROUND_SUBAGENTS;
    if (!Number.isInteger(maxActive) || maxActive < 1) {
      throw new Error(`背景子代理的並存上限要是 ≥ 1 的整數，收到 ${String(maxActive)}`);
    }
    this.#maxActive = maxActive;
    // 迴圈在**這裡**起：它的環境就是建構這一刻的環境。
    this.#loop = this.#run();
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
    this.#known.set(input.runId, input.subagent);
    // 一次新的送話喚醒被中斷後暫停的佇列（排在前面的照舊先跑）。
    this.#paused.delete(input.runId);
    return this.#enqueue({ ...input, turn: { kind: 'message', text: input.text } });
  }

  #enqueue(job: Omit<Job, 'settle'>): Promise<BackgroundRoundOutcome> {
    return new Promise((settle) => {
      this.#queue.push({ ...job, settle });
      this.#wake?.();
    });
  }

  /**
   * 父代理給一個背景子代理追加指示（[#839](https://github.com/DemianLi/nexus-agent/issues/839)，dsh
   * `SubagentRuntime.sendMessage`，`477b4f4`）。**同步接受或拒絕**，接受之後那一輪獨立跑。
   *
   * - 只有這個主對話派出去的編號（host 就是這個主對話的）；不認得的編號拋，訊息說明原因。
   * - 模型看到的文字加 dsh 的前綴 `Agent <寄件人> sent a message: `；日誌那一輪的 `turn/start` 是
   *   `agent-message`（記寄件人，**不授予權限、也不是人話**），不是 `message`。
   * - 對方閒著：開新的一輪。對方正在跑：**排成它的下一輪**（不插進當下那一輪——那是卡 7）。
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
    if (this.#closed) throw new Error('背景子代理的載體已經關閉');
    const subagent = this.#known.get(input.runId);
    if (subagent === undefined) {
      throw new Error(
        `沒有編號 ${input.runId} 的背景子代理（用 list_agents 看有哪些；只能傳給自己派出去的）`,
      );
    }
    const full = this.#capacityRefusal(input.runId);
    if (full !== undefined) throw new Error(full);
    this.#paused.delete(input.runId);
    // 寄件人＝這個主對話的 root：host 是它的，而這顆工具只給 root（`rootOnly`），所以不必由呼叫端聲明。
    const sender = this.#sessions.root.sessionId;
    const text = `Agent ${sender} sent a message: ${input.message}`;
    return this.#enqueue({
      runId: input.runId,
      subagent,
      text,
      turn: { kind: 'agent-message', text, senderSessionId: sender },
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
   * @returns 編號（`bg-` 加隨機，不是計數器：root 續接之後不能撞上舊日誌）與第一輪的下場。
   * @throws host 已關閉；存活的背景子代理已達並存上限；編不出這個子代理的圖。
   */
  start(input: { readonly subagent: string; readonly text: string }): {
    readonly runId: string;
    readonly outcome: Promise<BackgroundRoundOutcome>;
  } {
    if (this.#closed) throw new Error('背景子代理的載體已經關閉');
    // 先於編圖與開日誌：滿了就一樣東西都不留（沒有編號、沒有日誌）。
    const full = this.#capacityRefusal(undefined);
    if (full !== undefined) throw new Error(full);
    this.#agentFor(input.subagent);
    let runId: string;
    do runId = `${BACKGROUND_RUN_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    while (this.#known.has(runId));
    this.#sessions.open({ kind: 'subagent', runId });
    return { runId, outcome: this.submit({ runId, ...input }) };
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
    const controller = this.#running.get(runId);
    if (controller === undefined) return false;
    if (controller.signal.aborted) return true;
    this.#paused.add(runId);
    controller.abort();
    return true;
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

  /** 不再收新的輪，等排著的與進行中的收完（不中止，見檔頭），然後結束迴圈。 */
  async close(): Promise<void> {
    this.#closed = true;
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
        // **先讓出位子、再交下場**：呼叫端等到 `outcome` 的時候，這個子代理已經不算存活（並存上限、
        // 之後的結算通知都靠這個順序）。
        const round: Promise<void> = this.#round(job).then(({ outcome, settlement }) => {
          this.#busy.delete(job.runId);
          this.#inflight.delete(round);
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

  #agentFor(subagent: string): BackgroundAgent {
    const cached = this.#graphs.get(subagent);
    if (cached !== undefined) return cached;
    const compiled = this.#compile(subagent);
    this.#graphs.set(subagent, compiled);
    return compiled;
  }

  async #round(job: Job): Promise<{
    readonly outcome: BackgroundRoundOutcome;
    readonly settlement: BackgroundSettlement | undefined;
  }> {
    let outcome: BackgroundRoundOutcome;
    let stop: BackgroundStopReason = 'completed';
    let log: SessionLog | undefined;
    // 這一輪自己的中止控制器：`interrupt` 只舉它。跑完（不論怎麼結束）就丟。
    const controller = new AbortController();
    this.#running.set(job.runId, controller);
    try {
      log = this.#sessions.open({ kind: 'subagent', runId: job.runId });
      log.append('turn/start', job.turn);
      await this.#enter(log, () => this.#drive(log!, job, controller.signal));
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
      this.#running.delete(job.runId);
    }
    let settlement: BackgroundSettlement | undefined;
    if (log !== undefined) {
      const summary = settlementSummary(job.runId, stop);
      settlement = {
        runId: job.runId,
        sessionId: log.sessionId,
        summary,
        text: settlementText(summary, closingTextOf(log)),
      };
    }
    return { outcome, settlement };
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

  async #drive(log: SessionLog, job: Job, cancel: AbortSignal): Promise<void> {
    const run = await this.#agentFor(job.subagent).streamEvents(
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
        },
      },
    );
    // 在第一顆封包之前：投影裡的 promise 一建立就可能被 reject（#346）。
    markProjectionsHandled(run);
    for await (const _event of run) void _event;
  }
}
