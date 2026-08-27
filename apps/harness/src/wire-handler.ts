/**
 * 線的 server 端：一個 `(Request) => Response` 的 handler。
 *
 * **不綁 port 是刻意的**，而且照的是 dsh 的 `packages/host/apiproxy/src/fetch/handler.ts`。
 * 好處是這一整條線在測試裡跑得完：零 port、零網路、零憑證——CI 上沒有任何服務憑證
 * （[#31](https://github.com/DemianLi/nexus-agent/issues/31)），測試必須自足。
 *
 * 錯誤分兩層，也照 dsh：
 *
 * - **載體層**用 HTTP status：415（media type 不是 JSON）、400（body 不是 JSON）、
 *   404（路徑不指向任何 method）。
 * - **協定層**用 200 ＋ error 封包：封包形狀不對、method 與路徑不合、要的功能沒實作。
 *
 * 那個 415 是安全閘不是潔癖：瀏覽器對 `text/plain` 之類的「simple POST」不發
 * preflight，只收 `application/json` 等於逼出一個這個 server 從不回答的 preflight。
 */

import type { Command, EventStreamRequest, WireChannel } from '@nexus/wire';
import {
  encodeSseFrame,
  errorResponse,
  isUplinkMethod,
  isWireChannel,
  successResponse,
} from '@nexus/wire';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

/**
 * 一個 thread 的 agent 與它的清理函式。
 *
 * **`dispose` 是必填的**，因為忘記它的代價看不見：`createNexusAgent` 回的正是這個
 * 形狀，而 MCP plugin 底下是 stdio 子行程——只收 pump 不 dispose agent 的話，
 * 每開一個 thread 就漏一組子行程，而且不會有任何錯誤訊息。
 */
export interface ThreadAgent {
  readonly agent: PumpAgent;
  dispose(): Promise<void>;
}

export interface WireHandlerOptions {
  /** 一個 thread 一個 agent。第一次碰到這個 thread 時呼叫。 */
  createAgent(threadId: string): Promise<ThreadAgent>;
}

export interface WireHandler {
  handle(request: Request): Promise<Response>;
  /** 收掉所有 thread 的下行，並把每個 thread 的 agent 清乾淨。 */
  close(): Promise<void>;
}

const JSON_MEDIA_TYPE = 'application/json';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': `${JSON_MEDIA_TYPE}; charset=utf-8` },
  });
}

/** `/threads/:id/stream` 或 `/threads/:id/commands/:method`，都不是就 undefined。 */
function parsePath(
  pathname: string,
):
  | { readonly kind: 'stream'; readonly threadId: string }
  | { readonly kind: 'command'; readonly threadId: string; readonly method: string }
  | undefined {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments[0] !== 'threads' || segments[1] === undefined) {
    return undefined;
  }
  const threadId = decodeURIComponent(segments[1]);
  if (segments.length === 3 && segments[2] === 'stream') {
    return { kind: 'stream', threadId };
  }
  if (segments.length === 4 && segments[2] === 'commands' && segments[3] !== undefined) {
    return { kind: 'command', threadId, method: segments[3] };
  }
  return undefined;
}

function requestedChannels(body: EventStreamRequest): readonly WireChannel[] | undefined {
  const { channels } = body;
  if (!Array.isArray(channels) || channels.length === 0 || !channels.every(isWireChannel)) {
    return undefined;
  }
  return channels;
}

export function createWireHandler(options: WireHandlerOptions): WireHandler {
  const threads = new Map<
    string,
    { readonly pump: ThreadPump; readonly dispose: () => Promise<void> }
  >();

  async function pumpFor(threadId: string): Promise<ThreadPump> {
    const existing = threads.get(threadId);
    if (existing !== undefined) {
      return existing.pump;
    }
    const { agent, dispose } = await options.createAgent(threadId);
    const pump = new ThreadPump(agent, threadId);
    threads.set(threadId, { pump, dispose: () => dispose() });
    return pump;
  }

  function openStream(
    pump: ThreadPump,
    channels: readonly WireChannel[],
    signal: AbortSignal,
  ): Response {
    const encoder = new TextEncoder();
    const events = pump.subscribe(channels, signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // **開線就先吐一行 SSE 註解。** 沒有這一行的話，中間任何一層代理都可能把
        // header 壓著等第一顆 body byte——實測 Vite dev server 的 proxy 正是如此：
        // 直連拿得到 `200 text/event-stream`，經過它就一個位元組都不來，而瀏覽器那端
        // 看起來就是永遠「連線中」。dsh 也是這樣做的，理由寫在
        // `packages/host/apiproxy/src/fetch/handler.ts` 的 `sseResponse()`：
        // 「Send an SSE comment line on open so clients/proxies see a live channel」。
        // 註解不是封包，解碼端本來就會跳過它。
        controller.enqueue(encoder.encode(': connected\n\n'));
      },
      async pull(controller) {
        const next = await events.next();
        if (next.done === true) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(encodeSseFrame(next.value)));
      },
      cancel() {
        void events.return(undefined);
      },
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        // 代理層常見的 SSE 緩衝會把「串流」變成「一次吐完」，這一行是關掉它的慣例。
        'x-accel-buffering': 'no',
      },
    });
  }

  async function handleStream(
    threadId: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    const request = body as EventStreamRequest;
    if (typeof request !== 'object' || request === null) {
      return json(errorResponse(null, 'invalid_argument', 'body 不是 EventStreamRequest'));
    }
    if (request.since !== undefined) {
      // **明確拒絕，不靜靜忽略。** 靜靜忽略會生出看不見的斷檔；重播要能做得先有
      // frame 的持久化。接回來的方式是重開這條線 ＋ 重抓歷史，照 dsh 的 v1。
      return json(
        errorResponse(null, 'not_supported', '這一版不支援 since 重播：重開下行並重抓歷史'),
      );
    }
    if (request.namespaces !== undefined || request.depth !== undefined) {
      return json(errorResponse(null, 'not_supported', '這一版不支援 namespace 過濾'));
    }
    const channels = requestedChannels(request);
    if (channels === undefined) {
      return json(errorResponse(null, 'invalid_argument', 'channels 必須是非空的白名單子集'));
    }
    return openStream(await pumpFor(threadId), channels, signal);
  }

  async function handleCommand(threadId: string, method: string, body: unknown): Promise<Response> {
    if (!isUplinkMethod(method)) {
      return new Response('not found', { status: 404 });
    }
    const command = body as Command;
    if (typeof command !== 'object' || command === null || typeof command.id !== 'number') {
      return json(errorResponse(null, 'invalid_argument', 'body 不是 Command 封包'));
    }
    if (command.method !== method) {
      // dsh 的不變量：路徑指名 method、封包裡也帶 method，兩者不合就是錯誤。
      return json(
        errorResponse(
          command.id,
          'invalid_argument',
          `封包的 method "${command.method}" 與路徑 "${method}" 不合`,
        ),
      );
    }

    const pump = await pumpFor(threadId);
    if (command.method === 'run.start') {
      const params = command.params;
      if (typeof params?.assistant_id !== 'string') {
        return json(errorResponse(command.id, 'invalid_argument', 'run.start 缺 assistant_id'));
      }
      if (pump.pending !== undefined) {
        // **基座這時不會擋，它會靜靜地把中斷丟掉**：新的一輪照跑，那個等著核准的工具
        // 既沒執行也沒被拒絕，而且不會再發第二顆 `input.requested`（實測）。靜靜照做
        // 等於讓一道核准閘門無聲消失，所以這裡明著回錯——同 `since` 那條的理由。
        return json(
          errorResponse(
            command.id,
            'invalid_argument',
            '這條 thread 停在核准點：先用 input.respond 回答它，再說下一句話',
          ),
        );
      }
      const text = firstHumanText(params.input);
      if (text === undefined) {
        return json(
          errorResponse(command.id, 'invalid_argument', 'run.start 的 input 沒有可用的訊息'),
        );
      }
      return json(successResponse(command.id, { run_id: start(pump, { kind: 'message', text }) }));
    }

    const params = command.params;
    if (params !== null && typeof params === 'object' && 'responses' in params) {
      // 協定的批次形（一次回答同一個 checkpoint 上的多個中斷）。基座這側一個中斷本身
      // 就帶一整組 `decisions`，還沒有需要多中斷批次的形狀，所以明著不收。
      return json(
        errorResponse(command.id, 'not_supported', '這一版只收單一 interrupt 的 input.respond'),
      );
    }
    if (typeof params?.interrupt_id !== 'string') {
      return json(errorResponse(command.id, 'invalid_argument', 'input.respond 缺 interrupt_id'));
    }
    const pending = pump.pending;
    if (pending === undefined) {
      return json(
        errorResponse(command.id, 'no_such_interrupt', '這條 thread 上沒有等著回答的中斷'),
      );
    }
    if (pending.interruptId !== params.interrupt_id) {
      // **對不上就是對不上，不要拿它去回答現在那顆。** 基座只認「有沒有中斷掛著」、
      // 不比對 id：實測拿掉這道比對之後，一個**完全不存在**的 interrupt_id 照樣把
      // 現在掛著的那顆核准掉，工具真的跑了。所以一個過期的分頁按下核准會落在另一顆
      // 中斷上——那是替別人的問題按下核准。
      return json(
        errorResponse(
          command.id,
          'no_such_interrupt',
          `interrupt_id "${params.interrupt_id}" 不是目前掛著的那顆`,
        ),
      );
    }
    const decisions = (params.response as { decisions?: unknown } | null)?.decisions;
    if (
      pending.actionCount > 0 &&
      (!Array.isArray(decisions) || decisions.length !== pending.actionCount)
    ) {
      // 基座逐 index 把決定配到被中斷的工具呼叫上，長度不符當場拋——線上就是一顆
      // `lifecycle failed / root`，整條 thread 死在一個客戶端的 bug 上。擋在這裡。
      return json(
        errorResponse(
          command.id,
          'invalid_argument',
          `這顆中斷要 ${pending.actionCount} 筆決定，收到 ${Array.isArray(decisions) ? decisions.length : 0} 筆`,
        ),
      );
    }
    return json(
      successResponse(command.id, {
        run_id: start(pump, { kind: 'resume', response: params.response }),
      }),
    );
  }

  /**
   * 起一輪，然後**立刻**回。上行的回應是收件回條，不是「跑完了」——跑出來的東西
   * 走下行。這一輪炸掉的話原因已經以 `lifecycle failed` 上了線，這裡只負責不讓它
   * 變成 unhandled rejection。
   */
  function start(pump: ThreadPump, input: Parameters<ThreadPump['submit']>[0]): string {
    void pump.submit(input).catch(() => undefined);
    return crypto.randomUUID();
  }

  function firstHumanText(input: unknown): string | undefined {
    const messages = (input as { messages?: unknown })?.messages;
    if (!Array.isArray(messages)) {
      return undefined;
    }
    const first = messages.find(
      (message): message is { content: string } =>
        typeof message === 'object' &&
        message !== null &&
        typeof (message as { content?: unknown }).content === 'string',
    );
    return first?.content;
  }

  return {
    async handle(request) {
      const route = parsePath(new URL(request.url).pathname);
      if (request.method !== 'POST' || route === undefined) {
        return new Response('not found', { status: 404 });
      }
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== JSON_MEDIA_TYPE) {
        return new Response('content type must be application/json', { status: 415 });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }
      return route.kind === 'stream'
        ? handleStream(route.threadId, body, request.signal)
        : handleCommand(route.threadId, route.method, body);
    },
    async close() {
      const opened = [...threads.values()];
      threads.clear();
      for (const thread of opened) {
        thread.pump.close();
      }
      // 一個 thread 清不乾淨不該擋住其他的。
      await Promise.all(opened.map((thread) => thread.dispose().catch(() => undefined)));
    },
  };
}
