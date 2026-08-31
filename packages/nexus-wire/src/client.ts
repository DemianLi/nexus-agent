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
  InputRespondOne,
  RpcMethod,
  SlashCommand,
  SlashDescriptor,
  SlashRunResult,
  WireChannel,
} from './protocol.js';
import { WIRE_CHANNELS, commandPath, streamPath } from './protocol.js';

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
  /** 回答一個核准請求。同一個中斷的多筆決定要一次送，見開發計劃 Phase 5 的全有全無那條。 */
  inputRespond(
    threadId: string,
    params: Pick<InputRespondOne, 'namespace' | 'interrupt_id' | 'response'>,
  ): Promise<UplinkResult>;
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
    command: Command | SlashCommand,
  ): Promise<UplinkResult> {
    // 路徑與封包各講一次 method，server 端不合就拒——照 dsh 的端點慣例
    // （`packages/api/gateway/src/index.ts:134`，`<namespace>/<method>`）。
    const response = await postJson(commandPath(threadId, method), command);
    if (!response.ok) {
      throw new Error(`上行被載體層擋下：${response.status} ${await response.text()}`);
    }
    return (await response.json()) as UplinkResult;
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
  };
}
