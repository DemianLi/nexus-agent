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
 * ## 這一張還沒做的
 *
 * 沒有生產者（`task` 當場回編號是卡 5），所以這裡只有 host 與測試，不接進 cli／serve。中止一輪與
 * `TurnEndReason` 的 `parent` 成員（卡 6）、輸出上限的載體、結算通知、並存上限都不在這裡。所以 {@link
 * BackgroundSubagentHost.close} 只等進行中的輪收完，不中止它們。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import { HumanMessage } from '@langchain/core/messages';
import { BACKGROUND_SESSION_CONFIG_KEY } from '@nexus/core';
import type { SessionLog, SessionRegistry } from '@nexus/core';

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
}

interface Job {
  readonly runId: string;
  readonly subagent: string;
  readonly text: string;
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
  readonly #maxActive: number;
  readonly #graphs = new Map<string, BackgroundAgent>();
  /** 已知的背景子代理：編號 → 子代理名。同一個編號不能換名字。 */
  readonly #known = new Map<string, string>();
  readonly #queue: Job[] = [];
  readonly #busy = new Set<string>();
  readonly #inflight = new Set<Promise<void>>();
  #wake: (() => void) | undefined;
  #closed = false;
  readonly #loop: Promise<void>;

  constructor(options: BackgroundSubagentHostOptions) {
    this.#sessions = options.sessions;
    this.#compile = options.compile;
    this.#enter = options.enter ?? ((_log, run) => run());
    this.#warn = options.warn;
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
    return new Promise((settle) => {
      this.#queue.push({ ...input, settle });
      this.#wake?.();
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

  async #run(): Promise<void> {
    for (;;) {
      const job = this.#takeRunnable();
      if (job !== undefined) {
        // 從**迴圈**的環境拉起，不是從呼叫 `submit` 的環境。
        this.#busy.add(job.runId);
        // **先讓出位子、再交下場**：呼叫端等到 `outcome` 的時候，這個子代理已經不算存活（並存上限、
        // 之後的結算通知都靠這個順序）。
        const round: Promise<void> = this.#round(job).then((outcome) => {
          this.#busy.delete(job.runId);
          this.#inflight.delete(round);
          this.#wake?.();
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
    const index = this.#queue.findIndex((job) => !this.#busy.has(job.runId));
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

  async #round(job: Job): Promise<BackgroundRoundOutcome> {
    let outcome: BackgroundRoundOutcome;
    let log: SessionLog | undefined;
    try {
      log = this.#sessions.open({ kind: 'subagent', runId: job.runId });
      log.append('turn/start', { kind: 'message', text: job.text });
      await this.#enter(log, () => this.#drive(log!, job));
      log.append('turn/end', {});
      outcome = { ok: true };
    } catch (error) {
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
    }
    return outcome;
  }

  #warnFailure(job: Job, message: string): void {
    try {
      this.#warn?.(`[背景子代理] ${job.runId} 的一輪拉不起來：${message}`);
    } catch {
      // 講不出來也不影響輪次。
    }
  }

  async #drive(log: SessionLog, job: Job): Promise<void> {
    const run = await this.#agentFor(job.subagent).streamEvents(
      { messages: [new HumanMessage(job.text)] } as never,
      {
        version: 'v3',
        // **只給明確的鍵**：不靠隱式繼承，也不帶 root 的中止訊號（見檔頭）。
        configurable: {
          thread_id: log.sessionId,
          [BACKGROUND_SESSION_CONFIG_KEY]: job.runId,
        },
      },
    );
    // 在第一顆封包之前：投影裡的 promise 一建立就可能被 reject（#346）。
    markProjectionsHandled(run);
    for await (const _event of run) void _event;
  }
}
