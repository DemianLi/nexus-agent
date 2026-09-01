/**
 * 線的 server 端：一個 `(Request) => Response` 的 handler。
 *
 * **不綁 port 是刻意的。** 這個形狀當初照的是 dsh 的
 * `packages/host/apiproxy/src/fetch/handler.ts`（對讀版本 `cd5ef814`）——
 * **那個套件在 HEAD `0a53fb55` 已經整個不見了**：dsh 的載體換成了
 * `packages/host/webserver` 的 `node:http` route 註冊 ＋ WebSocket upgrade，
 * 沒有 fetch 形狀的 handler 了。所以底下每一條標著「照 dsh」的，指的都是那個版本。
 *
 * **不綁 port 這件事今天站的是自己的理由**，不是那份引用：這一整條線在測試裡跑得完
 * ——零 port、零網路、零憑證，而 CI 上沒有任何服務憑證
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

import type {
  Command,
  EventStreamRequest,
  SlashDescriptor,
  SlashListResult,
  SlashMethod,
  SlashRunResult,
  UplinkMethod,
  WireChannel,
} from '@nexus/wire';
import {
  encodeSseFrame,
  errorResponse,
  isRpcMethod,
  isSlashMethod,
  isWireChannel,
  successResponse,
} from '@nexus/wire';
import type { CommandDescriptor, CommandRegistrationPoint, SessionRegistry } from '@nexus/core';
import type { CommandExecutor } from '@nexus/plugin-commands';
import { createCommandExecutor } from '@nexus/plugin-commands';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

/**
 * `@nexus/core` 的命令視圖必須塞得進線上那一個。
 *
 * 兩份形狀是手抄的（`@nexus/wire` 進得了瀏覽器正是因為它不相依 `@nexus/core`），而
 * **這裡是唯一同時看得到兩邊的地方**。少了這一行，`CommandDescriptor` 多一格就會安靜地
 * 到不了瀏覽器；有了它，那一刻編不過。形狀照 `protocol.ts` 的
 * `_channelsAreProtocolChannels`。
 */
const _descriptorFitsTheWire: SlashDescriptor = {} as CommandDescriptor;
void _descriptorFitsTheWire;

/**
 * 一個 thread 的 agent 與它的清理函式。
 *
 * **`dispose` 是必填的**，因為忘記它的代價看不見：`createNexusAgent` 回的正是這個
 * 形狀，而 MCP plugin 底下是 stdio 子行程——只收 pump 不 dispose agent 的話，
 * 每開一個 thread 就漏一組子行程，而且不會有任何錯誤訊息。
 */
export interface ThreadAgent {
  readonly agent: PumpAgent;
  /**
   * 這個 thread 打得出哪些斜線命令。**必填**，理由同 `dispose`：忘記它的代價看不見。
   *
   * 給 `undefined` 一個預設值的話，組裝點漏傳就是一份空清單——瀏覽器那端看到的是
   * 「這裡沒有命令」，跟「真的沒註冊任何命令」一模一樣，而且沒有任何錯誤訊息
   * （[#123](https://github.com/DemianLi/nexus-agent/issues/123)）。
   *
   * **只讀 `find` 與 `list`**：這條線不註冊任何東西。
   */
  readonly commands: Pick<CommandRegistrationPoint, 'find' | 'list'>;
  dispose(): Promise<void>;
  /**
   * 把這個 thread 的**每一份**會話日誌接上遙測，選配。
   *
   * **接線點必須在這裡**，因為註冊表是 pump 建的（一個 thread 一張），而知道有沒有掛
   * 後端的是組裝點。兩邊只在這一行碰得到面。沒掛後端時 `createNexusAgent` 回
   * `undefined`，這裡什麼都不會發生。
   *
   * @param sessions - 這個 thread 的會話註冊表。
   * @returns 收掉這次接線的函式，或沒掛後端時的 `undefined`。
   */
  attachTelemetry?(sessions: SessionRegistry): (() => Promise<void>) | undefined;
  /**
   * 把這個 thread 的日誌接上不變量配套入口。同 `attachTelemetry` 的理由住在組裝點：
   * 只有那裡同時看得到 registry 與日誌。沒有人註冊配套入口時回 `undefined`。
   *
   * @param sessions - 這個 thread 的會話註冊表。
   * @returns 收掉這次接線的函式，或沒有配套入口時的 `undefined`。
   */
  attachInvariants?(sessions: SessionRegistry): (() => void) | undefined;
  /**
   * 把這個 thread 的日誌接上 `sessions` 通道的參與者，選配。
   *
   * 同上面兩條的理由住在組裝點，但**方向相反**：交出去的日誌寫得動，參與者記得下
   * `goal/change` 這種權威 domain 事件。沒有人註冊參與者時回 `undefined`。
   *
   * **這條路不能漏。** 漏了的話 `@nexus/core` 的測試照樣全綠，而 web 那端每一個 thread
   * 的域狀態都不存在——那是一種只在瀏覽器上看得到的缺席。
   *
   * **它同時是模型工具那條線。** 綁上註冊表之後，plugin 註冊的工具才問得出「我這次呼叫
   * 該寫進哪一份日誌」（`registry.sessions.forCall`）。所以它現在**一定**回一個 detach，
   * 沒有「沒人 join 就 `undefined`」那條短路了。
   *
   * @param sessions - 這個 thread 的會話註冊表。
   * @returns 收掉這次接線的函式。
   */
  attachSession?(sessions: SessionRegistry): () => void;
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

/**
 * 一條 thread 在這台 server 上的全部狀態。
 *
 * 命令執行器**一條 thread 一個**，跟 CLI 的「一個 REPL 一個」是同一條規則——
 * `@nexus/plugin-commands` 的配套入口就是靠那件事在檢查 `command/run` 與
 * `command/done` 的配對。
 */
interface ThreadState {
  readonly pump: ThreadPump;
  readonly commands: Pick<CommandRegistrationPoint, 'find' | 'list'>;
  readonly executor: CommandExecutor;
  /**
   * 有沒有一次 `slash.run` 還沒回來。
   *
   * **HTTP handler 本身沒有序列性**：`handle()` 是一次請求一次呼叫，兩個分頁同時打
   * `slash.run` 會同時走到同一個執行器上，而那正是配套入口會報成違規的交錯
   * （執行器自己的檔頭寫著那不是誤報）。REPL 的序列性是 readline 白送的，這條線沒有，
   * 所以在這裡明著擋。
   */
  slashInFlight: boolean;
  dispose(): Promise<void>;
}

export function createWireHandler(options: WireHandlerOptions): WireHandler {
  /**
   * **存的是 promise 不是狀態**，而且是同步就存進去的。
   *
   * 存已完成的狀態、在 `await createAgent` 之後才寫回去的話，同一條 thread 的兩個並行
   * 請求會各建一個 agent：後寫的那個覆蓋先寫的，先建的那一個**沒有人 dispose** ——
   * 而 MCP plugin 底下是 stdio 子行程。兩個分頁同時打開就到得了，而且不會有任何錯誤
   * 訊息。順帶一提，那也會讓下面那道序列閘失效：兩個請求手上是兩個不同的執行器。
   */
  const threads = new Map<string, Promise<ThreadState>>();

  function threadFor(threadId: string): Promise<ThreadState> {
    const existing = threads.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const created = (async (): Promise<ThreadState> => {
      const threadAgent = await options.createAgent(threadId);
      const pump = new ThreadPump(threadAgent.agent, threadId);
      const detachTelemetry = threadAgent.attachTelemetry?.(pump.sessions);
      const detachInvariants = threadAgent.attachInvariants?.(pump.sessions);
      // **接在不變量之後**，同 `cli.ts` 那條的理由：參與者一裝上去就可能記東西，
      // 那些東西該被已經在看的檢查看到。註冊表通知訂閱者的順序就是這三行的順序，
      // 所以 subagent 後來出生的那些日誌也照這個順序被接上。
      const detachSession = threadAgent.attachSession?.(pump.sessions);
      return {
        pump,
        commands: threadAgent.commands,
        // **建在這裡**：日誌是 pump 建的（一個 thread 一份），而這一行正是它誕生的地方
        // ——跟上面兩條接線同一個位置，理由也同一個。
        executor: createCommandExecutor({
          commands: threadAgent.commands,
          sessionLog: pump.sessionLog,
        }),
        slashInFlight: false,
        dispose: async () => {
          // **參與者先收，比不變量還早**：它是唯一寫得動日誌的那一個，先讓它停手，
          // 檢查才還在看著它最後那幾筆。反過來收的話，關機途中寫進去的東西沒人檢。
          detachSession?.();
          // 不變量再退訂：它只是一個訂閱，退掉不會有東西要排空，而留著它跑在關機途中的
          // 事件上只會多噪音。
          detachInvariants?.();
          // 遙測先收，理由同 `agent-factory.ts`：後端可能是某個 plugin 開的。
          await detachTelemetry?.();
          await threadAgent.dispose();
        },
      };
    })();
    // 建不起來就不要把失敗記在那個 thread 上——下一次請求該重試，不是永遠拿到同一個錯。
    const tracked = created.catch((error: unknown) => {
      threads.delete(threadId);
      throw error;
    });
    threads.set(threadId, tracked);
    return tracked;
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
        // 看起來就是永遠「連線中」。**這一行今天的依據就是那次實測**——dsh 當初的
        // `sseResponse()` 也這樣做（「Send an SSE comment line on open so
        // clients/proxies see a live channel」），但那個套件在 HEAD `0a53fb55` 已經
        // 不在了，見檔頭。註解不是封包，解碼端本來就會跳過它。
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
    return openStream((await threadFor(threadId)).pump, channels, signal);
  }

  async function handleCommand(
    threadId: string,
    method: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    if (!isRpcMethod(method)) {
      return new Response('not found', { status: 404 });
    }
    // **信封先於內容**：協定的 `Command` 與斜線命令那兩支各有各的 params，但
    // `id` 與 `method` 是共通的，而下面那條路徑／封包的比對兩邊都受它管。
    const envelope = body as { id?: unknown; method?: unknown };
    if (typeof envelope !== 'object' || envelope === null || typeof envelope.id !== 'number') {
      return json(errorResponse(null, 'invalid_argument', 'body 不是上行封包'));
    }
    if (envelope.method !== method) {
      // dsh 的不變量：路徑指名 method、封包裡也帶 method，兩者不合就是錯誤。
      return json(
        errorResponse(
          envelope.id,
          'invalid_argument',
          `封包的 method "${String(envelope.method)}" 與路徑 "${method}" 不合`,
        ),
      );
    }

    const thread = await threadFor(threadId);
    if (isSlashMethod(method)) {
      return handleSlash(thread, method, envelope.id, body, signal);
    }

    // **窄到上行那兩支**：路徑已經是 `UPLINK_METHODS` 之一（`isRpcMethod` 減掉斜線那兩支），
    // 而封包的 method 剛剛跟路徑比對過。少了這個窄化，下面的 `input.respond` 分支面對的
    // 是整個 `Command` union——那裡面有八個我們從不收的 method。
    const command = body as Extract<Command, { method: UplinkMethod }>;
    const { pump } = thread;
    if (command.method === 'run.start') {
      const params = command.params;
      if (typeof params?.assistant_id !== 'string') {
        return json(errorResponse(command.id, 'invalid_argument', 'run.start 缺 assistant_id'));
      }
      if (thread.slashInFlight) {
        // **擋的方向是雙向的。** 一次 `slash.run` 還在跑的時候起一輪，`/plan` 那格
        // pending intent 就會跟這一輪的 `beforeAgent` 賽跑——而那正是
        // `@nexus/plugin-plan-mode` 的偏離註記押著的那個前提（「命令一定跑在兩輪之間」）。
        return json(
          errorResponse(
            command.id,
            'invalid_argument',
            '這條 thread 正在跑一個斜線命令：等它回來再說下一句話',
          ),
        );
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
   * 斜線命令的發派面。**「發派面明文保證序列」就是這幾行。**
   *
   * REPL 那條線上的序列性是 readline 白送的（一行一輪，`execute` 回來之前不會有第二
   * 行），而 `@nexus/plugin-plan-mode` 的偏離註記正是押在那件事上：「命令一定跑在兩輪
   * 之間」。**web 不是序列的 REPL**——命令可以在 run 飛在半空時到，也可以在 thread 停
   * 在核准點時到，還可以兩個分頁同時到。所以三道都在這裡明著擋，而不是排隊：排隊會讓
   * `/plan` 的 pending intent 跟飛行中那一輪的 `beforeAgent` 賽跑，等於把一個已經標過
   * 的偏離再擴大一次（[#123](https://github.com/DemianLi/nexus-agent/issues/123)）。
   *
   * `slash.list` 不受這三道管：它只讀，沒有東西可以跟誰賽跑。
   */
  async function handleSlash(
    thread: ThreadState,
    method: SlashMethod,
    id: number,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    if (method === 'slash.list') {
      const result: SlashListResult = { commands: thread.commands.list() };
      return json(successResponse(id, result));
    }

    const params = (body as { params?: { line?: unknown } }).params;
    if (typeof params?.line !== 'string') {
      return json(errorResponse(id, 'invalid_argument', 'slash.run 缺 line'));
    }
    if (thread.pump.pending !== undefined) {
      return json(
        errorResponse(
          id,
          'invalid_argument',
          '這條 thread 停在核准點：先用 input.respond 回答它，再打斜線命令',
        ),
      );
    }
    if (thread.pump.running) {
      return json(
        errorResponse(id, 'invalid_argument', '這條 thread 正在跑：等這一輪跑完再打斜線命令'),
      );
    }
    if (thread.slashInFlight) {
      // 兩個分頁同時打。放行的話兩次執行會在日誌裡交錯，而配套入口會把那件事報成違規
      // ——**那是對的，不是誤報**（見 `createCommandExecutor` 的檔頭）。
      return json(
        errorResponse(id, 'invalid_argument', '這條 thread 上已經有一個斜線命令在跑：等它回來'),
      );
    }

    thread.slashInFlight = true;
    try {
      // **取消訊號就是發派它的那次請求的**：瀏覽器關掉分頁，這次執行也就沒有人要了。
      const execution = await thread.executor.execute(params.line, signal);
      if (execution === undefined) {
        // 語法不符或名字不認得。**日誌裡一個字都沒有**（執行器保證），線上也不是錯誤
        // ——封包是好的，只是那一行不是命令。
        return json(successResponse(id, { kind: 'unknown' } satisfies SlashRunResult));
      }
      const { commandId, result } = execution;
      return json(
        successResponse(
          id,
          result.kind === 'success'
            ? ({
                kind: 'success',
                command_id: commandId,
                ...(result.text === undefined ? {} : { text: result.text }),
              } satisfies SlashRunResult)
            : ({
                kind: 'error',
                command_id: commandId,
                text: result.text,
              } satisfies SlashRunResult),
        ),
      );
    } catch (error) {
      // handler 自己拋的，或執行前後被中止。**日誌那側已經落定成一顆 `kind: 'error'` 的
      // `command/done`**（執行器在往外拋之前就寫完了），所以線上跟前一種形狀一樣——
      // 少的只有 `command_id`，理由見 `SlashRunResult`。
      return json(
        successResponse(id, {
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
        } satisfies SlashRunResult),
      );
    } finally {
      thread.slashInFlight = false;
    }
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
        : handleCommand(route.threadId, route.method, body, request.signal);
    },
    async close() {
      const opened = [...threads.values()];
      threads.clear();
      // 還在建的那些也要等——`createAgent` 已經開了資源，只是還沒交出來。
      const settled = await Promise.all(opened.map((thread) => thread.catch(() => undefined)));
      for (const thread of settled) {
        thread?.pump.close();
      }
      // 一個 thread 清不乾淨不該擋住其他的。
      await Promise.all(settled.map((thread) => thread?.dispose().catch(() => undefined)));
    },
  };
}
