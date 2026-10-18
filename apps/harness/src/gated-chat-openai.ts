/**
 * 把全機的模型請求並行閘（[#1505](https://github.com/DemianLi/nexus-agent/issues/1505)，`request-gate.ts`）掛在 `ChatOpenAI` 的
 * 三個呼叫方法上的子類，也是 {@link AttachmentChatOpenAI}（附件投影）的基底。
 *
 * ## 為什麼閘在這三個方法上，而不是重試層或 fetch
 *
 * 讀碼查到兩個位置都不能用：
 *
 * 1. **重試層（`retryModelCall`／`streamRetry` middleware）**：管理者把 `maxRetries` 設成 0 時重試 middleware 根本不掛
 *    （`@nexus/core` 的 `fold.ts`），摘要器生摘要的那一次也不一定經它。閘放在那裡，這時就整個失效。
 * 2. **`fetch` 那一疊**：它在 SDK 的 `timeout` 計時器裡面。到第一則事件的逾時是 180 秒，逾時算 `TIMEOUT`、在可重試碼裡，
 *    排隊等太久會被當成逾時、重試、再排一次隊。
 *
 * 模型類別的呼叫方法在 SDK 計時器**外面**、重試迴圈**裡面**：每一次嘗試各自取、各自放，所以 **429 之後的退避那段時間不佔名額**，
 * 重打前重新排隊——一起回來的重試同時在跑的數量也不超過上限。排隊的時間不算 #1427 的重試次數、不寫 `llm/retry`、不吃首事件逾時。
 *
 * ## 三個方法都要，順序是「便宜的檢查 → 取名額 → 投影 → 送」
 *
 * 基座依呼叫方式挑方法：`invoke` 走 `_generate`，有串流 handler 時走 `_streamResponseChunks`，v3 的 `stream()` 走 `_streamChatModelEvents`
 * （同 `attachment-chat-openai.ts` 的說明）。漏一條，那一條路上的請求就不受閘管。基座的 `ChatOpenAI` 把這三個方法轉給**另一個**
 * `completions` 實例，所以 `_generate` 在串流模式下內部呼叫的 `_streamResponseChunks` 是 completions 的、不是這個子類的——不會重入、
 * 不會自己等自己（上限 1 的測試釘著這一點）。
 *
 * 取名額排在附件的額度檢查之後（額度超過會直接拋、不必排隊）、投影之前：排隊的那段時間不抱著剛讀進來的 base64。
 *
 * 釋放只有一個冪等的函式，三個觸發點：那一次呼叫結束的 `finally`（成功、失敗、串流的消費者 `break` 時呼叫 `return()`）、
 * 以及**這一輪的中止訊號舉起來的那一刻**（消費者在中止時不一定會呼叫 `return()`，見 `#enter`）。串流方法的名額到 `yield*` 結束才還。
 * 消費者提早結束時，`stream()` 先舉起那顆訊號（見那個方法）：不然 `return()` 排在還沒到的下一段後面，連線也沒關（#1546）。
 *
 * ## `withConfig` 也要覆寫
 *
 * 基座的 `ChatOpenAI.withConfig` 是 `new ChatOpenAI(this.fields)`（`bindTools` 也走它），會把子類連同閘一起丟掉、換回沒有閘的本尊。
 * 覆寫成重建同一個子類，帶上同一份閘。
 *
 * @module
 */

import { ChatOpenAI } from '@langchain/openai';
import type { ChatOpenAIFields } from '@langchain/openai';
import type { BaseMessage } from '@langchain/core/messages';

import type { RequestGate } from './request-gate.js';

export class GatedChatOpenAI extends ChatOpenAI {
  readonly #gate: RequestGate | undefined;

  constructor(fields: ChatOpenAIFields, gate?: RequestGate) {
    super(fields);
    this.#gate = gate;
  }

  /** 這顆模型的閘（測試與接線斷言用）；沒有閘是 `undefined`。 */
  get requestGate(): RequestGate | undefined {
    return this.#gate;
  }

  /** 取名額之前的便宜檢查：要拋就拋，不必排隊。子類覆寫。 */
  protected precheck(_messages: readonly BaseMessage[]): void {
    // 基底什麼都不檢查。
  }

  /** 取到名額之後、送出之前對訊息做的事（附件投影）。子類覆寫；基底原樣交出。 */
  protected project(messages: readonly BaseMessage[]): Promise<readonly BaseMessage[]> {
    return Promise.resolve(messages);
  }

  async #prepare(messages: readonly BaseMessage[]): Promise<BaseMessage[]> {
    return [...(await this.project(messages))];
  }

  /**
   * 取名額（沒有閘就什麼都不做）。`options.signal` 帶著這一輪的停止訊號：等待中按停止就立刻離開隊伍；**拿到之後按停止，名額也在
   * 訊號舉起來的那一刻還**，不等生成器的 `finally`。
   *
   * 後者是實測出來的洞（2026-10-18）：串流停在 `yield`、消費者（LangChain 的迭代層）在中止時直接拋錯而**不呼叫 `return()`**，
   * 生成器就永遠停在那裡，`finally` 不會跑——按了停止，名額卻永遠不還。`release` 是冪等的，所以「訊號舉起」與「`finally`」
   * 誰先到都不會多放出名額。
   */
  async #enter(signal: AbortSignal | undefined): Promise<() => void> {
    if (this.#gate === undefined) return noop;
    const release = await this.#gate.acquire(signal);
    if (signal === undefined) return release;
    signal.addEventListener('abort', release, { once: true });
    return () => {
      signal.removeEventListener('abort', release);
      release();
    };
  }

  override async _generate(
    ...[messages, options, runManager]: Parameters<ChatOpenAI['_generate']>
  ): ReturnType<ChatOpenAI['_generate']> {
    this.precheck(messages);
    const release = await this.#enter(options.signal);
    try {
      options.signal?.throwIfAborted();
      return await super._generate(await this.#prepare(messages), options, runManager);
    } finally {
      release();
    }
  }

  override async *_streamChatModelEvents(
    ...[messages, options, runManager]: Parameters<ChatOpenAI['_streamChatModelEvents']>
  ): ReturnType<ChatOpenAI['_streamChatModelEvents']> {
    this.precheck(messages);
    const release = await this.#enter(options.signal);
    try {
      options.signal?.throwIfAborted();
      yield* super._streamChatModelEvents(await this.#prepare(messages), options, runManager);
    } finally {
      release();
    }
  }

  override async *_streamResponseChunks(
    ...[messages, options, runManager]: Parameters<ChatOpenAI['_streamResponseChunks']>
  ): ReturnType<ChatOpenAI['_streamResponseChunks']> {
    this.precheck(messages);
    const release = await this.#enter(options.signal);
    try {
      options.signal?.throwIfAborted();
      yield* super._streamResponseChunks(await this.#prepare(messages), options, runManager);
    } finally {
      release();
    }
  }

  /**
   * 消費者提早結束（`break` 觸發 `return()`，或呼叫 `throw()`）時**先中止底下的請求**，名額與連線一起收
   * （[#1546](https://github.com/DemianLi/nexus-agent/issues/1546) 換主版本 Node 24 時出現）。
   *
   * 照 dsh `packages/llm/llm-deepseek/src/adapter.ts:65-89`（`687f282e`）：一顆 `consumer` 訊號跟呼叫端的 `signal` 合併，消費者停下就
   * `abort()`；原本的收尾不等，因為它排在還沒到的那一段後面。
   *
   * **偏離 dsh，理由 1（基座表達不出來）**：dsh 在生成器的 `finally` 裡 abort，消費者的 `return()` 直接打到那顆生成器。這裡中間隔著
   * `@langchain/core` 1.2.9 的 `IterableReadableStream`（`dist/utils/stream.js:38-43`、`:86-96`）：它的 `pull` 會先去要下一段，
   * `return()` 經 `reader.cancel()` 走到 `generator.return()`，排在那次 `next()` 後面——下一段到之前，我們生成器的 `finally` 跑不到。
   * 所以 abort 改掛在 `stream()` 交出去的那顆物件上。實測（假端點握住第二段不放）：沒有這一層時，Node 22.19 的 `break` 2 ms 回來、
   * 連線 8 ms 關；**Node 24.21 的 `break` 一直等到下一段到才回來，連線不關、名額跟著卡住**。有這一層，兩版都是 1–2 ms 回來、連線隨即關掉。
   *
   * 撤除條件：`IterableReadableStream` 的 `return()` 不再排在預先拉的那次 `next()` 後面（拿掉這個方法，24 上
   * `gated-chat-openai.test.ts` 的 break／throw 兩格照樣綠），或基座直接把消費者的 `return()` 打到模型的生成器上。
   *
   * 中止之後，名額由 {@link #enter} 掛在訊號上的監聽當下還；連線由 SDK 收到訊號後關掉。
   *
   * 不包 `cancel()`：還沒讀就取消時 `pull` 沒有卡在下一段，基座自己收得乾淨（24.21 實測，拿掉包裝也綠）；讀過再取消會先撞上
   * 讀取鎖，走不到這裡。
   */
  override async stream(
    ...[input, options]: Parameters<ChatOpenAI['stream']>
  ): ReturnType<ChatOpenAI['stream']> {
    const consumer = new AbortController();
    const signal =
      options?.signal === undefined
        ? consumer.signal
        : AbortSignal.any([consumer.signal, options.signal]);
    const stream = await super.stream(input, { ...options, signal });
    const settle = stream.return.bind(stream);
    /** 中止請求；原本的收尾在背景跑完，它的錯（就是剛才的中止）不往外丟。 */
    const stop = (): void => {
      consumer.abort();
      void settle().catch(() => {});
    };
    stream.return = () => {
      stop();
      return Promise.resolve({ done: true, value: undefined });
    };
    stream.throw = (error: unknown) => {
      stop();
      return Promise.reject(error as Error);
    };
    return stream;
  }

  override withConfig(
    config: Parameters<ChatOpenAI['withConfig']>[0],
  ): ReturnType<ChatOpenAI['withConfig']> {
    const next = new GatedChatOpenAI(this.fields ?? {}, this.#gate);
    next.defaultOptions = { ...this.defaultOptions, ...config };
    return next as never;
  }
}

function noop(): void {
  // 沒有閘：沒有名額可還。
}
