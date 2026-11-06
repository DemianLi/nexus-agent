/**
 * 瀏覽器這一端連 agent 的接點。
 *
 * 這裡**沒有 UI**，也刻意不 import 任何 agent 的東西：協定與 client 都在
 * `@nexus/wire`，它只 `import type` 基座的 `@langchain/protocol`，沒有執行期相依。
 * agent 那一半跑在 Node（backend、MCP 的 stdio 子行程、QuickJS 的組裝都在那側），
 * 中間就是這條線——`deepagents` 的 `./browser` 進入點少掉 16 個 Node 專屬匯出，
 * 而我們的 `ContainedFilesystemBackend` 繼承的正是其中的 `FilesystemBackend`。
 */

import type { MuxSocket, WireClient } from '@nexus/wire';
import { WIRE_MUX_PATH, createMuxFetch, createWireClient } from '@nexus/wire';

import { StreamUnauthorizedError } from '@/lib/embed-unauthorized';
import { clockedFetch } from '@/lib/server-clock';

export interface AgentClientOptions {
  /** agent 的位置，預設是 {@link agentBaseUrl}，開發時用 `VITE_AGENT_BASE_URL` 指到 harness。 */
  readonly baseUrl?: string;
  /** 接在 `baseUrl` 後面的 serve 路徑，例如嵌入版的 `/embed`。 */
  readonly routePrefix?: string;
  /** 注入用；給了就兩條下行也走它，不開 socket。預設是全域的 `fetch` 包一層、順手記下回應的 `Date` 標頭（{@link clockedFetch}，換算時鐘差用），下行走 WebSocket。 */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * client 的請求（上行與兩條下行）回 401 時呼叫。上行的回應照樣交給呼叫端，下行的見最後一句。WebSocket 下行只交出 mux 換過一條 socket、或改走 SSE 之後的結果
   * （`mux.ts` 的 `createMuxFetch`），舊 socket 帶著換票前 cookie 的那個 401 不會叫到這裡；開線之後、回應回來之前呼叫過
   * {@link AgentConnection.renewStreams} 的下行，401 也不叫：呼叫端照斷線重開，重開走新的 socket，那裡再 401 才叫（#2484）。
   * 嵌入版用它通知宿主頁換票（#2370）。給了它，下行的 401 在叫過它之後拋 {@link StreamUnauthorizedError}，不交回應；
   * 換過一代的不叫也不拋，照樣交回回應（#2490）。
   */
  readonly onUnauthorized?: () => void;
}

function watched(
  fetch: typeof globalThis.fetch,
  onUnauthorized: (() => void) | undefined,
): typeof globalThis.fetch {
  if (onUnauthorized === undefined) return fetch;
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 401) onUnauthorized();
    return response;
  };
}

/** 下行的 401：有 `onUnauthorized` 就叫它、收掉本體、拋 {@link StreamUnauthorizedError}；其他回應原樣交回。 */
async function unauthorizedStream(
  response: Response,
  onUnauthorized: (() => void) | undefined,
): Promise<Response> {
  if (response.status !== 401 || onUnauthorized === undefined) return response;
  onUnauthorized();
  await response.body?.cancel();
  throw new StreamUnauthorizedError();
}

/**
 * agent 的位置：設定了 `VITE_AGENT_BASE_URL` 就用它，沒設就是 `from` 所在目錄的路徑，結尾不帶 `/`。
 * 掛在反向代理的子路徑底下時，這個目錄就是前綴（`/nexus/` 算出 `/nexus`），掛在根路徑是空字串（#2426）。
 *
 * @param from - 從哪個網址算。獨立頁面是 `document.baseURI`；嵌入元件跑在宿主頁上，要傳 `embed.js` 自己的網址。
 */
export function agentBaseUrl(from: string = document.baseURI): string {
  const configured: unknown = import.meta.env.VITE_AGENT_BASE_URL;
  if (typeof configured === 'string') return configured;
  return new URL('.', from).pathname.replace(/\/+$/u, '');
}

/** 升級請求的網址：跟 agent 同一個來源，`http` 換成 `ws`。 */
export function agentMuxUrl(baseUrl: string, pageUrl: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/u, '')}${WIRE_MUX_PATH}`, pageUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/**
 * WebSocket 下行：每條串流的 `path` 是 serve 看到的路徑。反向代理只剝得掉升級網址上的前綴，剝不到 socket 裡的訊息，
 * 所以送進 socket 之前先剝掉 `mount` 的路徑；退回 SSE 時是一般請求，前綴接回去（#2426）。`mount` 在根路徑時原樣不包。
 */
export function mountedMuxFetch(
  mount: string,
  baseUrl: string,
  pageUrl: string,
  fetch: typeof globalThis.fetch,
  createSocket: (url: string) => MuxSocket = (url) => new WebSocket(url),
): typeof globalThis.fetch {
  const prefix = new URL(`${mount}/`, pageUrl).pathname.replace(/\/$/u, '');
  const moved = (input: RequestInfo | URL, from: string, to: string): string => {
    const url = new URL(String(input), pageUrl);
    if (url.pathname.startsWith(`${from}/`))
      url.pathname = `${to}${url.pathname.slice(from.length)}`;
    return url.href;
  };
  const mux = createMuxFetch({
    url: agentMuxUrl(baseUrl, pageUrl),
    createSocket,
    fallback: prefix === '' ? fetch : (input, init) => fetch(moved(input, '', prefix), init),
  });
  return prefix === '' ? mux : (input, init) => mux(moved(input, prefix, ''), init);
}

/** 一個 client，加上換掉它下行那條 socket 的開關。 */
export interface AgentConnection {
  readonly client: WireClient;
  /**
   * 換一顆 cookie 之後呼叫（嵌入版兌換登入票，#2370）：socket 的 cookie 定在升級當下，所以之後新開的下行走一條新的 socket。
   *
   * - `closeOpen: true`（換了人）：舊 socket 當場關掉，上面的下行跟斷線一樣由呼叫端重開，重開時就走新的那條。
   * - `closeOpen: false`（同一個人續期，#2484）：舊 socket 上已開的下行照常收，等它們自己結束（斷線、serve 收線、呼叫端收掉）才關舊的 socket；
   *   serve 在升級與每開一條串流時驗 cookie（用升級當下那顆），不因 cookie 過期切掉已開的串流。
   *
   * 已經退回 SSE 的下行不經 socket，兩種都不動它（SSE 每個請求帶當下的 cookie，下次重開就是新的）。注入了 `fetch` 時沒有 socket，什麼都不做。
   */
  renewStreams(options: { readonly closeOpen: boolean }): void;
}

/**
 * 回應本體照讀者的速度一段一段轉出去，讀完、出錯或被取消時叫 `finished`（可能不只一次，呼叫端自己擋）。`highWaterMark: 0` 不預讀：mux 讀者讀走才還額度。
 */
function tracked(
  body: ReadableStream<Uint8Array>,
  finished: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finished();
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          finished();
          controller.error(error);
        }
      },
      async cancel(reason) {
        finished();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** 兩次 `renewStreams` 之間經同一支 mux 開的 socket（mux 自己 401 重開的也算這一代），與經這一代開著、還沒收掉的下行數（退回 SSE 的也算）。 */
class SocketGeneration {
  readonly #sockets = new Set<MuxSocket>();
  readonly #fetch: typeof globalThis.fetch;
  #open = 0;
  #retired = false;

  constructor(open: (into: Set<MuxSocket>) => typeof globalThis.fetch) {
    this.#fetch = open(this.#sockets);
  }

  /**
   * 經這一代開一條下行。開不成、本體讀完、出錯、被取消，或呼叫端中止 `signal`，都算這條收掉了（只算一次）。
   * 拿到回應的人要讀完或 cancel 本體，否則這一代的 socket 關不掉。
   */
  async stream(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.#open += 1;
    let counted = true;
    const closed = () => {
      if (!counted) return;
      counted = false;
      this.#closed();
    };
    let response: Response;
    try {
      response = await this.#fetch(input, init);
    } catch (error) {
      closed();
      throw error;
    }
    // 中止時 mux 只把本體 error 掉（`MuxStream.abort`），沒人在讀的本體不會再被 pull，`tracked` 看不到，所以另外聽 `signal`。
    // 掛在 mux 的之後：mux 先送 cancel，這裡才可能關 socket。
    const signal = init?.signal;
    if (signal?.aborted === true) closed();
    else signal?.addEventListener('abort', closed, { once: true });
    if (response.body === null) {
      closed();
      return response;
    }
    return new Response(tracked(response.body, closed), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /** 呼叫端先換上新的一代再呼叫（`stream` 不擋退役的這一代）。`closeOpen` 或沒有開著的下行就當場關 socket，否則等最後一條收掉才關。 */
  retire(closeOpen: boolean): void {
    this.#retired = true;
    if (closeOpen || this.#open === 0) this.#closeSockets();
  }

  #closed(): void {
    this.#open -= 1;
    if (this.#retired && this.#open === 0) this.#closeSockets();
  }

  #closeSockets(): void {
    for (const socket of this.#sockets) socket.close();
  }
}

/** 沒注入 `fetch` 時兩條下行走 WebSocket，要有 `window`（升級網址從頁面算）；socket 到第一條下行才開。 */
export function createAgentConnection(options: AgentClientOptions = {}): AgentConnection {
  const mount = (options.baseUrl ?? agentBaseUrl()).replace(/\/+$/u, '');
  const baseUrl = `${mount}${options.routePrefix ?? ''}`;
  const fetch = options.fetch ?? clockedFetch();
  const onUnauthorized = options.onUnauthorized;
  if (options.fetch !== undefined) {
    return {
      client: createWireClient({
        baseUrl,
        fetch: watched(fetch, onUnauthorized),
        streamFetch: async (input, init) =>
          unauthorizedStream(await fetch(input, init), onUnauthorized),
      }),
      renewStreams: () => {},
    };
  }
  const generation = () =>
    new SocketGeneration((into) =>
      mountedMuxFetch(mount, baseUrl, window.location.href, fetch, (url) => {
        const socket = new WebSocket(url);
        into.add(socket);
        // 用 addEventListener：`onclose` 是 mux 自己的（`mux.ts` 的 `MuxCarrier`），指派會蓋掉它的收尾。
        socket.addEventListener('close', () => into.delete(socket));
        return socket;
      }),
    );
  let current = generation();
  return {
    client: createWireClient({
      baseUrl,
      fetch: watched(fetch, onUnauthorized),
      // 回來時已經換過一代的 401 不叫：呼叫端照斷線重開，重開走新的一代，那裡還是 401 才叫。
      streamFetch: async (input, init) => {
        const opened = current;
        const response = await opened.stream(input, init);
        return opened === current ? unauthorizedStream(response, onUnauthorized) : response;
      },
    }),
    renewStreams({ closeOpen }) {
      const old = current;
      current = generation();
      old.retire(closeOpen);
    },
  };
}

/** {@link createAgentConnection} 的 client，不換 socket 的地方用。 */
export function createAgentClient(options: AgentClientOptions = {}): WireClient {
  return createAgentConnection(options).client;
}
