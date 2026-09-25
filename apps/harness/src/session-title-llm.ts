/**
 * LLM 標題：模型依第一則合格的人話產生的會話標題（[#650](https://github.com/DemianLi/nexus-agent/issues/650)）。
 *
 * 照 dsh 的三個套件（`477b4f4`）：`session-title` 的排程（`onUserMessage`／`onRequestHeader`／`runProvider`）、
 * `session-title-llm` 的產生策略（`generateSessionTitleWithLlm`）、`session-title-first-prompt-llm` 的節奏（只看第一則）。
 *
 * ## 什麼時候跑
 *
 * 只在**這一則是第一則合格的人話、而且還沒有任何標題**時排一次（dsh `onUserMessage` 的
 * `count === 1 && get(session) === undefined`；我們沒有 fork，所以沒有「有父會話」那一格）。其餘都不排：第二句、
 * 續接回來的舊會話（前面已經有人話）、子代理（只訂 root）。
 *
 * **排了不等於開跑**：要等那一顆 `turn/start` 之後的第一次模型呼叫（`model/start`）出現才開始，所以主回覆的請求
 * 先送出去，標題不拖慢它。這一顆沒等到的話（那一輪在呼叫模型之前就失敗了），留到下一次模型呼叫，同 dsh 的
 * `pending` 留到下一顆 `request/header`。
 *
 * **偏離：觸發點用 `model/start`，不是 `request/header`。** dsh 等主請求的路由記下來才開始，路由就從那一顆讀。
 * 我們沒有 `request/header` 這種事件，路由也不必從日誌讀——一個組裝只有一條連線，建構時就知道。最接近「主請求
 * 已經送出」的一顆是 `model/start`（模型呼叫的 middleware 在呼叫之前寫）。
 *
 * ## 寫什麼
 *
 * 開跑前先確保退回標題已落地（dsh 的 `ensureFallback`），送出前先記一顆 `session/title-llm-request`（真的送出去的系統提示、訊息、輸出上限），成功後追加一顆
 * `session/title {source: {kind:'provider'}}`，由既有的推送與列表讀到（latest-wins）。**兩顆都寫在一輪之外**，
 * 不開一輪、不進模型。失敗只講一聲，退回標題留著，不重試（dsh 的重試要靠顯式 `refresh()`，歸 #633）。
 *
 * **寫入延到微任務**：訂閱者的回呼裡不能再 `append`（`SessionLog` 的重入防護），同 dsh 的 `defer`。
 *
 * ## 在那一輪的 context 之外跑
 *
 * `model/start` 的訂閱者跑在主模型呼叫的呼叫堆疊上，也就在 LangChain 的 AsyncLocalStorage 裡——那裡帶著這一輪的
 * callbacks。直接在那裡叫標題模型的話，它會繼承這一輪的設定：被當成串流呼叫、事件漏進這條 thread 的 `messages`
 * 頻道（畫面上多一則回覆），而且回來的東西照串流解。實測過（serve 的產品路徑，#650）。所以標題呼叫綁在
 * **接上的那一刻**的 context 上跑（`AsyncResource.bind`），那一刻不在任何一輪裡。dsh 沒有這層環境狀態，
 * 它的標題呼叫本來就是獨立的一次請求。
 *
 * ## 用量不計進會話統計
 *
 * 同 dsh：`session-stats` 只折 `step/*`、`assistant/*`、`tool/*`、`turn/end`，標題呼叫一顆都不產生。這一次呼叫不經
 * agent 的 middleware，所以不寫 `model/usage`、`model/start`。
 *
 * @module
 */

import { AsyncResource } from 'node:async_hooks';

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  SessionEvent,
  SessionLog,
  SessionTitleLlmMessage,
  SessionTitleModelIdentity,
} from '@nexus/core';

import { ensureFallbackTitle, fallbackThreadTitle, normalizeThreadTitle } from './session-title.js';
import type { ThreadTitleLimits } from './session-title.js';
import { THREAD_TITLE_LLM_PLUGIN_NAME } from './settings/thread-title-llm.js';
import type { ThreadTitleLlmConfig } from './settings/thread-title-llm.js';

/** 標題模型。只用得到 `invoke`：一次非串流的呼叫，CLI 與 web 走同一條。 */
export type TitleModel = Pick<BaseChatModel, 'invoke'>;

/** 一則合格的人話：`turn/start {kind:'message'}` 的 `seq` 與原文。同 dsh 的 `SessionTitleUserMessage`。 */
export interface TitleSourceMessage {
  readonly seq: number;
  readonly text: string;
}

/** 產生器要的上限：標題列的三個。 */
export interface TitleLlmLimits extends ThreadTitleLimits {
  /** 任何來源的標題最多幾個 UTF-8 位元組，模型產生的照它正規化。 */
  readonly maxTitleBytes: number;
}

/**
 * 系統提示，**逐字照 dsh** 的 `systemPrompt`（`session-title-llm/src/index.ts`）。
 *
 * @param config - 兩個目標值寫進最後一行。
 */
export function titleSystemPrompt(
  config: Pick<ThreadTitleLlmConfig, 'targetWords' | 'targetCjkCharacters'>,
): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${String(config.targetWords)} words in non-CJK languages or ${String(config.targetCjkCharacters)} CJK characters.`,
  ].join('\n');
}

/**
 * 把人話包成 JSON，**逐字照 dsh** 的 `frameMessages`：使用者的字打不破結構上的分隔。
 *
 * @param messages - 要給模型看的那幾則。
 */
export function frameTitleMessages(messages: readonly TitleSourceMessage[]): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`;
}

/** {@link generateThreadTitle} 要的東西。 */
export interface GenerateThreadTitleRequest {
  readonly model: TitleModel;
  readonly route: SessionTitleModelIdentity;
  readonly config: ThreadTitleLlmConfig;
  readonly maxTitleBytes: number;
  /** 選好的那幾則（first-prompt 只有一則）。 */
  readonly messages: readonly TitleSourceMessage[];
  /** 記 `session/title-llm-request` 的那一份，root。 */
  readonly log: SessionLog;
  readonly signal: AbortSignal;
}

/**
 * 跑一次標題模型。照 dsh 的 `generateSessionTitleWithLlm`，順序也照它：
 *
 * 1. 包好訊息，**先查位元組**，超過 `maxInputBytes` 就拋——不截斷，也不記請求。
 * 2. 記 `session/title-llm-request`（真的送出去的那一份），再送。模型後來失敗了，這一顆照樣留著。
 * 3. 整段時限（`timeoutMs`）與呼叫端的中止一起生效；回來之後**再查一次**，時限過了的成功不收。
 * 4. 只收 `finish_reason: stop`、沒有工具呼叫、正規化後非空的文字。
 *
 * **`stop` 那一條是承重的**：關推理的參數一旦失效，推理會以 `length` 收尾、整段出現在正文裡（#650 量到的）。
 * 擋住「We need to…」被寫成標題的只有它。
 *
 * @returns 正規化後的標題與它用到的那幾則的 `seq`。
 * @throws 上面任何一條不成立，或模型呼叫本身失敗、逾時、被中止。
 */
export async function generateThreadTitle(
  request: GenerateThreadTitleRequest,
): Promise<{ readonly title: string; readonly messageSeqs: readonly number[] }> {
  request.signal.throwIfAborted();
  if (request.messages.length === 0) throw new Error('標題模型至少要一則人話');
  const framed = frameTitleMessages(request.messages);
  const inputBytes = Buffer.byteLength(framed, 'utf8');
  if (inputBytes > request.config.maxInputBytes) {
    throw new Error(
      `標題模型的輸入 ${String(inputBytes)} 位元組，超過 maxInputBytes ${String(request.config.maxInputBytes)}`,
    );
  }
  const system = titleSystemPrompt(request.config);
  const messages: SessionTitleLlmMessage[] = [{ role: 'user', content: framed }];
  const messageSeqs = request.messages.map((message) => message.seq);
  const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(request.config.timeoutMs)]);
  request.log.append('session/title-llm-request', {
    titleProvider: THREAD_TITLE_LLM_PLUGIN_NAME,
    messageSeqs,
    route: request.route,
    system,
    messages,
    maxTokens: request.config.maxOutputTokens,
  });
  deadline.throwIfAborted();
  const reply = await request.model.invoke([new SystemMessage(system), new HumanMessage(framed)], {
    signal: deadline,
  });
  deadline.throwIfAborted();
  const finish = (reply.response_metadata as { finish_reason?: unknown } | undefined)
    ?.finish_reason;
  if (finish !== 'stop') {
    throw new Error(`標題模型沒有正常收尾：finish_reason 是 ${String(finish)}`);
  }
  if ((reply.tool_calls?.length ?? 0) > 0) throw new Error('標題模型要求呼叫工具，只收文字');
  // `text` 只串文字區塊、推理區塊不算，同 dsh 的 `BlockAssembler` 只取 `text`。
  const title = normalizeThreadTitle(reply.text, request.maxTitleBytes);
  if (title === '') throw new Error('標題模型沒有產生文字');
  return { title, messageSeqs };
}

/** {@link createSessionTitleLlm} 要的東西：一個組裝一份。 */
export interface SessionTitleLlmOptions {
  readonly model: TitleModel;
  readonly route: SessionTitleModelIdentity;
  readonly config: ThreadTitleLlmConfig;
  readonly limits: TitleLlmLimits;
}

/**
 * 把 LLM 標題接到一份 root 日誌上。
 *
 * @param log - root 那一份。
 * @param warn - 產生失敗時講話的地方。
 * @returns 拆掉：取消還沒開跑的、中止跑到一半的，並等它收尾（同 dsh「卸載完成前等待不響應取消的調用結算」）。
 *   拆掉之後回來的結果寫不進去。
 */
export type AttachSessionTitleLlm = (
  log: SessionLog,
  warn: (message: string) => void,
) => () => Promise<void>;

/**
 * 建一顆 {@link AttachSessionTitleLlm}。行為見檔頭。
 *
 * @param options - 模型、路由、標題列與 LLM 標題列的值。
 */
export function createSessionTitleLlm(options: SessionTitleLlmOptions): AttachSessionTitleLlm {
  return (log, warn) => {
    let closed = false;
    let pending: TitleSourceMessage | undefined;
    const controller = new AbortController();
    let running: Promise<void> | undefined;

    // 合格的人話：`turn/start {kind:'message'}`、清完不是空的。同退回標題那一條（`session-title.ts`）。
    const eligibleText = (event: SessionEvent): string | undefined =>
      event.type === 'turn/start' &&
      event.data.kind === 'message' &&
      fallbackThreadTitle(event.data.text, options.limits) !== ''
        ? event.data.text
        : undefined;

    const run = async (message: TitleSourceMessage): Promise<void> => {
      try {
        // 先確保退回標題已落地，同 dsh `runProvider` 的 `ensureFallback`。平常它在 `turn/start` 那一段已經寫了，這裡是
        // no-op；只有那一次寫失敗時才補。補不進去就跟模型失敗一樣講一聲、不送。
        ensureFallbackTitle(log, options.limits);
        const result = await generateThreadTitle({
          model: options.model,
          route: options.route,
          config: options.config,
          maxTitleBytes: options.limits.maxTitleBytes,
          messages: [message],
          log,
          signal: controller.signal,
        });
        if (closed) return;
        log.append('session/title', {
          title: result.title,
          messageSeqs: result.messageSeqs,
          source: {
            kind: 'provider',
            provider: THREAD_TITLE_LLM_PLUGIN_NAME,
            model: options.route,
          },
        });
      } catch (error: unknown) {
        if (closed) return;
        warn(`模型產生的標題沒寫成，留著退回標題：${String(error)}`);
      }
    };

    // 綁在接上這一刻的 context，見檔頭「在那一輪的 context 之外跑」。
    const runOutsideTurn = AsyncResource.bind((message: TitleSourceMessage) => run(message));

    const unsubscribe = log.subscribe((event) => {
      if (closed) return;
      const text = eligibleText(event);
      if (text !== undefined) {
        // 第一則合格的人話、而且還沒有標題：排一次。同 dsh 的 `count === 1 && get(session) === undefined`。
        const events = log.events;
        const eligible = events.filter((each) => eligibleText(each) !== undefined);
        const titled = events.some((each) => each.type === 'session/title');
        if (eligible.length === 1 && !titled) pending = { seq: event.seq, text };
        return;
      }
      if (event.type === 'model/start' && pending !== undefined) {
        const message = pending;
        pending = undefined;
        // 回呼裡不能 append，延到微任務（同 dsh 的 `defer`）。
        running = Promise.resolve().then(() => (closed ? undefined : runOutsideTurn(message)));
      }
    });

    return async () => {
      closed = true;
      unsubscribe();
      controller.abort();
      await running;
    };
  };
}
