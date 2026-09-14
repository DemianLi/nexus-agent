/**
 * 瀏覽器那一端的線。
 *
 * 只用 `fetch`，所以它是同構的：`apps/web` 用它連 harness，測試用它連一個
 * 記憶體裡的 handler，兩邊跑的是同一條路徑（對應 dsh 的 `InProcessApiClient`
 * ——「跑完整的協定序列化與校驗路徑而不經過網路」）。
 *
 * **上行只走 HTTP POST，下行只讀不寫。** 下行單向是協定不變量，不是實作細節：
 * dsh 的 `websocket-downlink.ts` 明文「Client messages are a protocol violation:
 * upstream traffic remains on HTTP.」
 */

import { decodeSseStream } from './sse.js';
import type {
  Command,
  CommandResponse,
  ErrorResponse,
  Event,
  FeedbackCommand,
  FeedbackDeleteCommand,
  FeedbackDeleteResult,
  FeedbackPutCommand,
  FeedbackPutResult,
  FeedbackRecordCommand,
  FeedbackRecordResult,
  InputRespondOne,
  RpcMethod,
  RunCancelCommand,
  SlashCommand,
  SlashDescriptor,
  SlashRunResult,
  ThreadHistoryQuery,
  ThreadHistoryResponse,
  ThreadHistoryResult,
  ThreadListResponse,
  ThreadListResult,
  ThreadSummary,
  WireChannel,
} from './protocol.js';
import {
  RUN_CANCEL_METHOD,
  THREADS_PATH,
  WIRE_CHANNELS,
  commandPath,
  historyPath,
  streamPath,
} from './protocol.js';

export interface WireClientOptions {
  /** harness 的來源，例如 `http://localhost:8787`。結尾的斜線會被去掉。 */
  readonly baseUrl: string;
  /** 注入用；預設是全域的 `fetch`。 */
  readonly fetch?: typeof globalThis.fetch;
}

export interface OpenEventsOptions {
  /** 預設訂全部放行的 channel，見 `WIRE_CHANNELS`。 */
  readonly channels?: readonly WireChannel[];
  /**
   * 中止這條下行。
   *
   * **中止的是這條線，不是 agent。** server 端不會因為瀏覽器斷線就停掉 run；
   * 接回來的方式是重開一條（reopen），不是續傳——`since` 這一版明確不支援，
   * server 收到會回 `not_supported` 而不是靜靜忽略。
   */
  readonly signal?: AbortSignal;
}

/**
 * 上行 RPC 的回應。**收件回條，不是命令的執行結果。**
 *
 * 名字從 `CommandResult` 改成這個，是因為
 * [#118](https://github.com/DemianLi/nexus-agent/issues/118) 引進了**人打的斜線命令**，
 * 而 dsh 那一側的結果型別就叫 `CommandResult`。`Command` 在這個檔案裡是
 * **agent-protocol 自己的字**（見 `commandPath` 的說明），那個不動；但這個別名是我們
 * 自己取的，讓路給同名而語意不同的那一個。
 */
export type UplinkResult = CommandResponse | ErrorResponse;

/**
 * `slash.list` 的結果。
 *
 * **`rejected` 與命令自己的失敗是兩件事**，所以它們在型別上分得開：`rejected` 是
 * 這條線拒絕發派（`message`），命令自己失敗是 {@link SlashRunOutcome} 的
 * `kind: 'error'`（`text`）。鍵名不同不是巧合——混起來的那一刻，「這條 thread 正在跑」
 * 就會被顯示成「這個命令壞了」。
 */
export type SlashListOutcome =
  | { readonly kind: 'ok'; readonly commands: readonly SlashDescriptor[] }
  | { readonly kind: 'rejected'; readonly message: string };

/** `slash.run` 的結果：三個命令自己的值，加上這條線拒絕發派的那一個。 */
export type SlashRunOutcome =
  SlashRunResult | { readonly kind: 'rejected'; readonly message: string };

/**
 * 回饋三個 method 的結果。**`rejected` 與業務失敗是兩件事**，理由同 {@link SlashListOutcome}：
 * `rejected` 是這條線收不了（這個組裝沒掛回饋、封包壞了），業務失敗在 `result` 裡
 * （`{ ok: false, error: { code } }`）。
 */
export type FeedbackOutcome<T> =
  | { readonly kind: 'ok'; readonly result: T }
  | { readonly kind: 'rejected'; readonly message: string };

/**
 * `GET /threads` 的結果。`rejected` 是這台 server 列不了（例如沒開 `--session-log`），**不是空清單**，
 * 理由見 {@link ThreadListResponse}。
 */
export type ThreadListOutcome =
  | { readonly kind: 'ok'; readonly result: ThreadListResult }
  | { readonly kind: 'rejected'; readonly message: string };

export interface WireClient {
  /**
   * 開一條長期下行。它跨 run 存活：核准前後是同一條線。
   *
   * **promise 兌現代表線已經開好**（server 端的訂閱已註冊），之後才發生的 frame
   * 一顆都不會掉在中間。所以正確的順序是：先 `await openEvents`，再 `runStart`。
   */
  openEvents(
    threadId: string,
    options?: OpenEventsOptions,
  ): Promise<AsyncGenerator<Event, void, undefined>>;
  /** 送一句話進去。回應只是收件回條，不等這一輪跑完。 */
  runStart(threadId: string, text: string): Promise<UplinkResult>;
  /**
   * 回答**一顆**核准請求。
   *
   * 同一顆中斷的多筆決定要一次送（見開發計劃 Phase 5 的全有全無那條），但**界線就在
   * 中斷上**：同一輪的其他中斷各答各的，`interrupt_id` 是那道界線，伺服器據它逐 task
   * 派送（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
   */
  inputRespond(
    threadId: string,
    params: Pick<InputRespondOne, 'namespace' | 'interrupt_id' | 'response'>,
  ): Promise<UplinkResult>;
  /**
   * 中止這一輪（`run.cancel`，[#276](https://github.com/DemianLi/nexus-agent/issues/276)）。
   *
   * **回的是受理回條，不等停穩**——停下來的事實走下行（root 那顆收尾的 `lifecycle` 帶
   * `aborted: true`）。沒有 run 在跑、也沒有等核准時，server 照樣受理、什麼都不做。
   */
  runCancel(threadId: string): Promise<UplinkResult>;
  /** 評一輪（`feedback.put`，[#278](https://github.com/DemianLi/nexus-agent/issues/278)）。 */
  feedbackPut(
    threadId: string,
    params: FeedbackPutCommand['params'],
  ): Promise<FeedbackOutcome<FeedbackPutResult>>;
  /** 收回一輪的評分（`feedback.delete`）。 */
  feedbackDelete(
    threadId: string,
    params: FeedbackDeleteCommand['params'],
  ): Promise<FeedbackOutcome<FeedbackDeleteResult>>;
  /** 記一則對整個會話的評語（`feedback.record`）——回饋對話框只打 `/feedback` 時送這個。 */
  feedbackRecord(
    threadId: string,
    params: FeedbackRecordCommand['params'],
  ): Promise<FeedbackOutcome<FeedbackRecordResult>>;
  /**
   * 這條 thread 上打得出哪些斜線命令。**拿來顯示，不做選單**——
   * dsh 那一套 `CommandDirectory`（epoch guard、single-flight、`ensureReady`）是另一張卡。
   */
  slashList(threadId: string): Promise<SlashListOutcome>;
  /**
   * 打一行斜線命令。**回的是命令的執行結果，不是收件回條**——命令不進模型，
   * 所以它沒有「之後走下行」的那一半。
   *
   * @param line - 完整的候選行，**原文原樣**。
   */
  slashRun(threadId: string, line: string): Promise<SlashRunOutcome>;
  /**
   * 這台 server 以前的 thread（[#302](https://github.com/DemianLi/nexus-agent/issues/302)）。**不綁 thread**，
   * 也不替任何一條 thread 建 agent——server 那側照 dsh 的 `session/list` 是冷讀。
   */
  listThreads(): Promise<ThreadListOutcome>;
  /**
   * 這條 thread 的一頁歷史（#306）。省略參數就是最後一頁；往前翻帶上一頁的 `firstSeq` 與第一頁的 `throughSeq`。
   *
   * **排在 {@link openEvents} 兌現之後**，照 dsh 的「先訂閱、再拿 snapshot」：反過來的話，兩者之間發生的事
   * 兩邊都沒有。這條 thread 會為它建起來（同開下行），跟列表的冷讀不同。
   */
  threadHistory(threadId: string, query?: ThreadHistoryQuery): Promise<ThreadHistoryOutcome>;
}

/** `GET /threads/:id/history` 的結果。`rejected` 是這條 thread 起不來、或參數不對。 */
export type ThreadHistoryOutcome =
  | { readonly kind: 'ok'; readonly result: ThreadHistoryResult }
  | { readonly kind: 'rejected'; readonly message: string };

/** 線上回來的歷史得先驗過，理由同 {@link readDescriptors}。frame 本身交給折疊器，它本來就收別人的位元組。 */
function readHistory(result: unknown): ThreadHistoryResult {
  const { events, firstSeq, throughSeq, hasMore, legacy } = result as Record<string, unknown>;
  if (
    !Array.isArray(events) ||
    typeof firstSeq !== 'number' ||
    typeof throughSeq !== 'number' ||
    typeof hasMore !== 'boolean' ||
    typeof legacy !== 'boolean'
  ) {
    throw new Error('GET /threads/:id/history 回了不認得的結果');
  }
  return { events: events as Event[], firstSeq, throughSeq, hasMore, legacy };
}

/** 線上回來的列表得先驗過，理由同 {@link readDescriptors}。 */
function readThreadList(result: unknown): ThreadListResult {
  const { items, unreadable } = result as { items?: unknown; unreadable?: unknown };
  if (!Array.isArray(items) || typeof unreadable !== 'number') {
    throw new Error('GET /threads 的結果裡沒有 items 陣列或 unreadable 數');
  }
  return {
    unreadable,
    items: items.map((entry: unknown): ThreadSummary => {
      const row = entry as Record<string, unknown> | null;
      if (
        typeof row?.threadId !== 'string' ||
        typeof row.updatedAt !== 'number' ||
        typeof row.running !== 'boolean' ||
        typeof row.blank !== 'boolean' ||
        (row.title !== undefined && typeof row.title !== 'string')
      ) {
        throw new Error('GET /threads 回了不認得的一列');
      }
      return Object.freeze({
        threadId: row.threadId,
        updatedAt: row.updatedAt,
        running: row.running,
        blank: row.blank,
        ...(typeof row.title === 'string' ? { title: row.title } : {}),
      });
    }),
  };
}

/** 線上回來的清單得先驗過。**這是別人的位元組**，不是我們剛剛建的物件。 */
function readDescriptors(result: unknown): readonly SlashDescriptor[] {
  const { commands } = result as { commands?: unknown };
  if (!Array.isArray(commands)) {
    throw new Error('slash.list 的結果裡沒有 commands 陣列');
  }
  return commands.map((entry: unknown) => {
    const descriptor = entry as { name?: unknown; description?: unknown; input?: unknown };
    if (typeof descriptor?.name !== 'string' || typeof descriptor.description !== 'string') {
      throw new Error('slash.list 回了不認得的 descriptor');
    }
    const hint = (descriptor.input as { hint?: unknown } | undefined)?.hint;
    return Object.freeze({
      name: descriptor.name,
      description: descriptor.description,
      ...(typeof hint === 'string' ? { input: Object.freeze({ hint }) } : {}),
    });
  });
}

/** 同上。`unknown` 是三值之一，不是「驗不出來」。 */
function readRunResult(result: unknown): SlashRunResult {
  const { kind, command_id: commandId, text } = result as Record<string, unknown>;
  if (kind === 'unknown') {
    return { kind: 'unknown' };
  }
  if (kind === 'success') {
    if (typeof commandId !== 'string') {
      throw new Error('slash.run 成功時要帶 command_id');
    }
    return {
      kind: 'success',
      command_id: commandId,
      ...(typeof text === 'string' ? { text } : {}),
    };
  }
  if (kind === 'error' && typeof text === 'string') {
    // `command_id` 在拋錯路徑上是缺的，見 `SlashRunResult`。
    return {
      kind: 'error',
      text,
      ...(typeof commandId === 'string' ? { command_id: commandId } : {}),
    };
  }
  throw new Error(`slash.run 回了不認得的 kind "${String(kind)}"`);
}

export function createWireClient(options: WireClientOptions): WireClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  let nextCommandId = 1;

  async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return doFetch(`${base}${path}`, {
      method: 'POST',
      // 這個 header 不是裝飾：server 端只收 application/json，為的是逼出一個它從不
      // 回答的 CORS preflight，擋掉瀏覽器不發 preflight 的那種「simple POST」。
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  }

  async function sendCommand(
    threadId: string,
    method: RpcMethod,
    command: Command | SlashCommand | RunCancelCommand | FeedbackCommand,
  ): Promise<UplinkResult> {
    // 路徑與封包各講一次 method，server 端不合就拒——照 dsh 的端點慣例
    // （`packages/api/gateway/src/index.ts:134`，`<namespace>/<method>`）。
    const response = await postJson(commandPath(threadId, method), command);
    if (!response.ok) {
      throw new Error(`上行被載體層擋下：${response.status} ${await response.text()}`);
    }
    return (await response.json()) as UplinkResult;
  }

  /**
   * 送一個回饋命令，把回應拆成「這條線收不了」與「命令自己的結果」。
   *
   * 結果**只檢 `ok` 是不是布林**：值的其餘形狀是 server 那側的型別保證的（同一份 `@nexus/wire`），
   * 這裡要擋的只有「回來的根本不是回饋結果」——那種時候當成收不了，不硬讀。
   */
  async function sendFeedback<T>(
    threadId: string,
    command: FeedbackCommand,
  ): Promise<FeedbackOutcome<T>> {
    const response = await sendCommand(threadId, command.method, command);
    if (response.type === 'error') return { kind: 'rejected', message: response.message };
    const result: unknown = response.result;
    if (typeof (result as { ok?: unknown } | null)?.ok !== 'boolean') {
      return { kind: 'rejected', message: `回饋的回應看不懂：${JSON.stringify(result)}` };
    }
    return { kind: 'ok', result: result as T };
  }

  return {
    async openEvents(threadId, streamOptions = {}) {
      const response = await postJson(
        streamPath(threadId),
        { channels: streamOptions.channels ?? [...WIRE_CHANNELS] },
        streamOptions.signal,
      );
      if (!response.ok) {
        throw new Error(`下行開不起來：${response.status} ${await response.text()}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        // 協定層的錯是 200 ＋ error 封包（照 dsh 的分層），所以這裡拿得到原因。
        throw new Error(`下行被拒：${await response.text()}`);
      }
      if (response.body === null) {
        throw new Error('下行沒有 body');
      }
      return decodeSseStream(response.body);
    },

    async runStart(threadId, text) {
      return sendCommand(threadId, 'run.start', {
        id: nextCommandId++,
        method: 'run.start',
        params: {
          // 協定的 `assistant_id` 指的是部署上的某個 graph；我們一個 thread 就一個
          // agent，所以這一格是形式上的，server 只檢查它是字串。
          assistant_id: 'nexus',
          input: { messages: [{ role: 'human', content: text }] },
        },
      });
    },

    async inputRespond(threadId, params) {
      return sendCommand(threadId, 'input.respond', {
        id: nextCommandId++,
        method: 'input.respond',
        params,
      });
    },

    async runCancel(threadId) {
      return sendCommand(threadId, RUN_CANCEL_METHOD, {
        id: nextCommandId++,
        method: RUN_CANCEL_METHOD,
      });
    },

    async feedbackPut(threadId, params) {
      return sendFeedback<FeedbackPutResult>(threadId, {
        id: nextCommandId++,
        method: 'feedback.put',
        params,
      });
    },

    async feedbackDelete(threadId, params) {
      return sendFeedback<FeedbackDeleteResult>(threadId, {
        id: nextCommandId++,
        method: 'feedback.delete',
        params,
      });
    },

    async feedbackRecord(threadId, params) {
      return sendFeedback<FeedbackRecordResult>(threadId, {
        id: nextCommandId++,
        method: 'feedback.record',
        params,
      });
    },

    async slashList(threadId) {
      const response = await sendCommand(threadId, 'slash.list', {
        id: nextCommandId++,
        method: 'slash.list',
      });
      return response.type === 'error'
        ? { kind: 'rejected', message: response.message }
        : { kind: 'ok', commands: readDescriptors(response.result) };
    },

    async slashRun(threadId, line) {
      const response = await sendCommand(threadId, 'slash.run', {
        id: nextCommandId++,
        method: 'slash.run',
        params: { line },
      });
      return response.type === 'error'
        ? { kind: 'rejected', message: response.message }
        : readRunResult(response.result);
    },

    async listThreads() {
      const response = await doFetch(`${base}${THREADS_PATH}`, {
        method: 'GET',
        // 同上行那一條：沒有它就是一個不發 preflight 的跨來源 simple request，見 `THREADS_PATH`。
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`列表被載體層擋下：${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as ThreadListResponse;
      return body.type === 'error'
        ? { kind: 'rejected', message: body.message }
        : { kind: 'ok', result: readThreadList(body.result) };
    },

    async threadHistory(threadId, query = {}) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      const encoded = params.toString();
      const search = encoded === '' ? '' : `?${encoded}`;
      const response = await doFetch(`${base}${historyPath(threadId)}${search}`, {
        method: 'GET',
        // 同 `listThreads`，見 `THREADS_PATH`。
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`歷史被載體層擋下：${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as ThreadHistoryResponse;
      return body.type === 'error'
        ? { kind: 'rejected', message: body.message }
        : { kind: 'ok', result: readHistory(body.result) };
    },
  };
}
