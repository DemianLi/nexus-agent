/**
 * 經宿主連 MCP server（#3000 E4b）：每條對話行程不自己連，向宿主的 `mcp/client` 服務 `open` 一份綁定、再用 `call` 送請求，
 * 宿主整台共用一份連線。協議與切塊見 `docs/host-mcp.md`。
 *
 * 這一層只做一件事：**長得像 SDK 的 `Client`**（{@link HostMcpClient}），交給 {@link attemptsOn} 的 `open` 縫。下游的
 * `connectGeneration`、`toolCallOf`、`Supervisor`、資源來源都不知道連線在宿主那邊。
 *
 * **兩層重連，各管各的**：宿主自己對 MCP server 退避重連（空窗裡的呼叫回 `server is disconnected`，綁定不變、不通知這一側）；
 * 綁定沒了（宿主的 `open` 呼叫結束，包括宿主連線斷了）之後，這一側在宿主連線回來（`onReady`）或下一次呼叫進來時重新 `open`，同一時間只有一個（單飛）。所以這個 client 只在自己 `close()` 時呼叫 `onclose`（SDK 的 client 也是；
 * TS 的 `Supervisor` 靠它確認這一代關掉了），宿主重起、server 掉線都不呼叫，`Supervisor` 不會因此重連，也不吃那一列的 `reconnect` 設定。
 *
 * 重新 `open` 之前的呼叫：等當前綁定最多 {@link DEFAULT_REBIND_WAIT_MS}，到了回 `server is disconnected`；
 * 送出去之後宿主連線斷了的（`host_lost`），結果不明、不重送。
 *
 * 取代 SDK 替我們做的事，逐項：逾時取消（工具逾時由宿主算；這一側只在有傳 `timeout` 時，送出後 `timeout` 加 W 到期送取消、丟 `REQUEST_TIMEOUT`）、`outputSchema` 驗證
 * （照 `toolDefinition`，每次呼叫都驗）、`resources/list` 翻頁（呼叫端逐頁走，這裡原樣轉）、掉線分類（宿主自己重連，這一側不分類）、
 * 探活（宿主那一側，這裡的 `listTools` 回開時的清單）、`taskSupport`（宿主的清單沒有 `execution`，宿主路徑上擋不到 `taskSupport: 'required'`，已知差異，見 `docs/host-mcp.md`〈跟 TS 的差距〉）。
 *
 * @module
 */

import { fromJsonSchema, isInputRequiredResult } from '@modelcontextprotocol/client';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/client/_shims';

/** 宿主交連線的服務名。 */
export const MCP_HOST_SERVICE = 'mcp/client';

/** 重新 `open` 之前的呼叫最多等多久（毫秒）。蓋住一次宿主重起：監督行程第一次重起等 1 秒，對話行程重連間隔封頂 1 秒。正式值待 #3032。 */
export const DEFAULT_REBIND_WAIT_MS = 5_000;

/** 重新 `open` 失敗之後，等綁定的呼叫隔多久再試（毫秒）。 */
const REBIND_RETRY_MS = 50;

/** 一份宿主的 `open`／`call` 呼叫選項。 */
export interface HostCallOptionsLike {
  readonly signal?: AbortSignal;
  /** 串流的方法每推一塊叫一次。 */
  readonly onChunk?: (chunk: unknown) => void;
  /** 呼叫編號配好、送出之前叫一次：`call` 的 `open` 欄位要指到 `open` 那一個的編號。 */
  readonly onId?: (id: number) => void;
}

/**
 * 宿主門面（`@nexus/host-bridge` 的 `HostBridge`）在這一層用到的部分。結構型別：外掛不相依 host-bridge 套件。
 * 沒有宿主時服務表上掛的是一律回 `host_absent` 的門面；走不走宿主看 `MCP_HOST_ROW_SERVICE` 有沒有掛。錯誤用 `code` 分：`host_lost`（送出去之後斷線）、`host_unavailable`／`host_absent`（沒送出去）。
 */
export interface HostCaller {
  call(
    service: string,
    method: string,
    payload: unknown,
    options?: HostCallOptionsLike,
  ): Promise<unknown>;
  onReady(listener: () => void): () => void;
}

/** 宿主 `open` 的文件：工具、帶出處標頭的指引、連不上時的原因。 */
interface OpenDocument {
  readonly tools: readonly Tool[];
  readonly instructions: string;
  readonly warning: string | null;
}

/** 拼塊時核對的摘要。 */
interface Summary {
  readonly chunks: number;
  readonly bytes: number;
}

/** 字串塊拼回一份文字，並核對塊數與位元組數。 */
export class Reassembly {
  readonly #pieces: string[] = [];

  push(chunk: unknown): void {
    if (typeof chunk !== 'string') throw new Error('宿主送來的塊不是字串');
    this.#pieces.push(chunk);
  }

  /** @throws 塊數或 UTF-8 位元組數與 `summary` 對不上（缺塊）。 */
  text(summary: Summary): string {
    const text = this.#pieces.join('');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (this.#pieces.length !== summary.chunks || bytes !== summary.bytes) {
      throw new Error(
        `宿主的結果拼不回：收到 ${String(this.#pieces.length)} 塊 ${String(bytes)} 位元組，宣告 ${String(summary.chunks)} 塊 ${String(summary.bytes)} 位元組`,
      );
    }
    return text;
  }
}

function isSummary(value: unknown): value is Summary {
  if (typeof value !== 'object' || value === null) return false;
  const { chunks, bytes } = value as Record<string, unknown>;
  return Number.isSafeInteger(chunks) && Number.isSafeInteger(bytes);
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

/** 請求逾時：`isRequestTimeout` 認 `code`。 */
function timeoutError(ms: number): Error {
  return Object.assign(new Error(`Request timed out after ${String(ms)} ms`), {
    code: 'REQUEST_TIMEOUT',
    name: 'TimeoutError',
  });
}

/** 宿主回的帶出處標頭的指引去掉標頭，還給 `instructionsOf`（它會再加一次）。 */
function rawInstructions(attributed: string, serverName: string): string | undefined {
  if (attributed === '') return undefined;
  const header = `### MCP server: ${serverName}\n\n`;
  return attributed.startsWith(header) ? attributed.slice(header.length) : attributed;
}

/** {@link HostMcpClient.open} 的選項。 */
export interface HostOpenOptions {
  /** 宿主 `open` 收的 `server`：{@link McpHostRowBuilder} 的成品。 */
  readonly server: { readonly serverName: string } & Readonly<Record<string, unknown>>;
  /** 要宣告反問能力的旗標，原樣給宿主；宿主路徑上反問的 `_meta` 由宿主一家帶，這一側不送。 */
  readonly elicitation: boolean;
  /** 一次呼叫送出之前最多等多久（毫秒，單一期限，等綁定與等宿主連線都算在裡面），預設 {@link DEFAULT_REBIND_WAIT_MS}；送出之後，它是保險計時比工具逾時多等的那一段。 */
  readonly rebindWaitMs?: number;
  /** 重新 `open` 失敗等記錄。 */
  readonly log?: (message: string) => void;
}

/** SDK 的 `callTool` 選項裡這一層讀的那幾個。 */
interface CallOptions {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
  readonly toolDefinition?: Tool;
  readonly allowInputRequired?: boolean;
}

/** W 到期時 abort 的 reason，據此回 `server is disconnected`。錯誤文字不含 `Not connected` 之類 {@link isConnectionLost} 認的字：宿主那邊的 server 照舊由宿主重連，這一側不算掉線。 */
const DEADLINE = Symbol('rebind-deadline');

/**
 * 宿主回的錯文字裡 {@link isConnectionLost} 會認成「這一代斷了」的幾句（server 層的 JSON-RPC 錯誤原樣帶來），換成認不得的寫法：
 * 連線在宿主那邊，這一側的監督者不該為它重連。
 */
function neutralized(error: unknown, depth = 0): unknown {
  if (typeof error === 'string') return neutralText(error);
  if (!(error instanceof Error) || depth >= 5) return error;
  const message = neutralText(error.message);
  // `isConnectionLost` 沿 `cause` 往下找，所以整條 cause 鏈都要換。
  const cause = neutralized(error.cause, depth + 1);
  if (message === error.message && cause === error.cause) return error;
  return Object.assign(new Error(message, { cause }), {
    ...(codeOf(error) !== undefined && { code: codeOf(error) }),
  });
}

function neutralText(text: string): string {
  return text
    .replace(/\bNot connected\b/gu, 'not connected')
    .replace(/\bConnection closed\b/gu, 'connection closed')
    .replace(/MCP error -32000/gu, 'MCP error (-32000)');
}

/** 長得像 SDK `Client`、底下是宿主綁定的連線。結構上夠 {@link attemptsOn} 與 {@link toolCallOf} 用。 */
export class HostMcpClient {
  /** 只在自己 `close()` 時叫一次；宿主重起、server 掉線都不叫（宿主自己重連，這一側的重新 `open` 不算掉線）。 */
  onclose?: () => void;

  readonly #caller: HostCaller;
  readonly #options: HostOpenOptions;
  readonly #abort = new AbortController();
  readonly #unsubscribe: () => void;
  readonly #waiters = new Set<() => void>();
  /** 第一次 `open` 的清單；之後重新 `open` 回的不蓋它（宿主可能回空清單加 `warning`）。 */
  #document: OpenDocument | undefined;
  /** 當前綁定的呼叫編號；空窗（還沒綁、宿主斷線）是 `undefined`。 */
  #bound: number | undefined;
  /** 已經失效的綁定編號：宿主對它們回「沒有已經 ready 的綁定」時，當作沒送出、改送新的。 */
  readonly #stale = new Set<number>();
  /** 重新 `open` 的單飛：同一時間只有一個。 */
  #rebinding: Promise<void> | undefined;
  #attempts = 0;
  #closed = false;

  private constructor(caller: HostCaller, options: HostOpenOptions) {
    this.#caller = caller;
    this.#options = options;
    this.#unsubscribe = caller.onReady(() => {
      // 第一次的 open 由 `open` 自己發；這裡只管之後宿主重連回來。
      if (this.#document !== undefined) this.#ensureBinding();
    });
  }

  /**
   * 向宿主 `open` 這一台，等 `ready`。
   *
   * @throws 宿主取用失敗（`failOnStartupError`）、連不上而帶 `warning`，或拼不回清單；訊息是宿主給的。
   */
  static async open(caller: HostCaller, options: HostOpenOptions): Promise<HostMcpClient> {
    const client = new HostMcpClient(caller, options);
    try {
      client.#document = await client.#openOnce();
    } catch (error) {
      client.#unsubscribe();
      throw error;
    }
    if (client.#document.warning !== null) {
      const warning = client.#document.warning;
      await client.close();
      throw new Error(warning);
    }
    return client;
  }

  /** 發一次 `open`，ready 時回清單；ready 之後的結局（斷線、取消）在背景處理，只清自己那一次的綁定。 */
  #openOnce(): Promise<OpenDocument> {
    const attempt = ++this.#attempts;
    return new Promise<OpenDocument>((resolve, reject) => {
      const text = new Reassembly();
      let id: number | undefined;
      let ready = false;
      const lose = (error: unknown): void => {
        if (this.#bound !== undefined && this.#bound === id) {
          this.#stale.add(this.#bound);
          this.#bound = undefined;
        }
        if (!ready) {
          reject(error);
          return;
        }
        // ready 之後綁定沒了：下一次呼叫或宿主連線回來（onReady）會經 `#ensureBinding` 重新 open。自己關的不記。
        if (!this.#closed) {
          this.#options.log?.(
            `宿主的綁定沒了：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      this.#caller
        .call(
          MCP_HOST_SERVICE,
          'open',
          { server: this.#options.server, elicitation: this.#options.elicitation },
          {
            signal: this.#abort.signal,
            onId: (value) => {
              id = value;
            },
            onChunk: (chunk) => {
              if (typeof chunk === 'string') {
                text.push(chunk);
                return;
              }
              const summary = (chunk as { ready?: unknown } | null)?.ready;
              if (!isSummary(summary)) throw new Error('宿主 open 送來認不得的塊');
              const document = JSON.parse(text.text(summary)) as OpenDocument;
              ready = true;
              if (attempt === this.#attempts) {
                if (this.#bound !== undefined) this.#stale.add(this.#bound);
                this.#bound = id;
              }
              this.#wake();
              resolve(document);
            },
          },
        )
        .then(
          () => {
            // open 不收尾；收尾了就是綁定沒了。
            lose(new Error('宿主的 open 呼叫結束了'));
          },
          (error: unknown) => {
            lose(error);
          },
        );
    });
  }

  /** 重新 `open` 的唯一入口，單飛。失敗只記錄、綁定留空，下一次呼叫再經這裡試一次。 */
  #ensureBinding(): void {
    if (this.#closed || this.#bound !== undefined || this.#rebinding !== undefined) return;
    const flight: Promise<void> = this.#openOnce().then(
      () => undefined,
      (error: unknown) => {
        this.#options.log?.(
          `重新向宿主 open 失敗：${error instanceof Error ? error.message : String(error)}`,
        );
        // 還在等綁定的呼叫過一會兒經同一個入口再試一次（算在它自己的 W 裡）；隔一下，不在失敗得很快時空轉。
        setTimeout(() => {
          this.#wake();
        }, REBIND_RETRY_MS).unref();
      },
    );
    this.#rebinding = flight;
    void flight.finally(() => {
      if (this.#rebinding === flight) this.#rebinding = undefined;
    });
  }

  #wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }

  /** 等到有綁定；`signal` 中止或關了回 `undefined`。 */
  #awaitBound(signal: AbortSignal): Promise<number | undefined> {
    this.#ensureBinding();
    if (this.#bound !== undefined) return Promise.resolve(this.#bound);
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish);
        this.#waiters.delete(check);
        resolve(this.#bound);
      };
      const check = (): void => {
        if (this.#bound !== undefined || this.#closed) finish();
        else this.#ensureBinding();
      };
      this.#waiters.add(check);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  /**
   * 送一次請求到宿主那一份連線，拼回結果。
   *
   * 單一期限 W 從呼叫進來算一次：等綁定、等宿主連線（門面自己的 5 秒）都在裡面，到了就以自己的 `signal` 中止、不送出，回 `server is disconnected`。
   * 送出之後（`onId` 叫過）W 不再計，工具逾時由宿主算（`toolCallTimeoutMs`），這裡只留一個比它晚 W 的保險計時。
   */
  async #request(method: string, params: unknown, options: CallOptions = {}): Promise<unknown> {
    const waitMs = this.#options.rebindWaitMs ?? DEFAULT_REBIND_WAIT_MS;
    const abort = new AbortController();
    const forward = (): void => {
      abort.abort(options.signal?.reason);
    };
    if (options.signal?.aborted === true) forward();
    options.signal?.addEventListener('abort', forward, { once: true });
    const started = Date.now();
    let deadline: NodeJS.Timeout | undefined;
    /** W 的計時（從呼叫進來起算）；「沒送出去」重試時重新掛上剩下的那一段。 */
    const armDeadline = (): void => {
      deadline = setTimeout(
        () => {
          abort.abort(DEADLINE);
        },
        Math.max(0, waitMs - (Date.now() - started)),
      );
    };
    armDeadline();
    let safety: NodeJS.Timeout | undefined;
    let safetyFired = false;
    const sent = (): void => {
      clearTimeout(deadline);
      clearTimeout(safety);
      if (options.timeout !== undefined) {
        safety = setTimeout(() => {
          safetyFired = true;
          abort.abort();
        }, options.timeout + waitMs);
      }
    };
    const disconnected = (): Error => new Error(`${this.#label()}: server is disconnected`);
    try {
      for (;;) {
        const open = await this.#awaitBound(abort.signal);
        if (abort.signal.aborted) {
          if (abort.signal.reason === DEADLINE) throw disconnected();
          throw safetyFired ? timeoutError(options.timeout ?? 0) : abortError(options.signal);
        }
        if (open === undefined) throw disconnected();
        // 編號在送出的這一刻才取、之後到 `call` 之間沒有 await：綁定結算過的編號不會被送出去。
        const current = this.#bound;
        if (current === undefined) continue;
        const text = new Reassembly();
        let summary: unknown;
        try {
          summary = await this.#caller.call(
            MCP_HOST_SERVICE,
            'call',
            { open: current, method, params: JSON.stringify(params) },
            { signal: abort.signal, onChunk: (chunk) => text.push(chunk), onId: sent },
          );
        } catch (error) {
          if (abort.signal.aborted) {
            if (abort.signal.reason === DEADLINE) throw disconnected();
            throw safetyFired ? timeoutError(options.timeout ?? 0) : abortError(options.signal);
          }
          const code = codeOf(error);
          // 沒送出去（宿主還沒連上）：在 W 內重試。
          if (code === 'host_unavailable') {
            await new Promise((resolve) => setTimeout(resolve, 20));
            continue;
          }
          // 對已失效的編號回「沒有已經 ready 的綁定」：沒送進 server，改送新綁定；對當前編號的是真錯。
          if (code === 'BadPayload' && this.#stale.has(current) && this.#bound !== current) {
            // 沒送出去：撤掉送出時掛的保險計時，W 接著算剩下的。
            clearTimeout(safety);
            safety = undefined;
            armDeadline();
            continue;
          }
          if (code === 'host_lost') {
            throw new Error(
              `${this.#label()}: the host connection dropped while this call was running; the result is unknown and the call was not retried`,
              { cause: error },
            );
          }
          throw neutralized(error);
        }
        if (!isSummary(summary)) throw new Error('宿主 call 的收尾不是塊數與位元組數');
        const result = JSON.parse(text.text(summary)) as unknown;
        return result;
      }
    } finally {
      clearTimeout(deadline);
      clearTimeout(safety);
      options.signal?.removeEventListener('abort', forward);
    }
  }

  #label(): string {
    return `mcp-client(${this.#options.server.serverName})`;
  }

  getInstructions(): string | undefined {
    return rawInstructions(this.#document?.instructions ?? '', this.#options.server.serverName);
  }

  /** 宿主不告訴這一側協定世代：inBand 只決定怎麼收結果（多輪反問），用的是送給 `open` 的那個 `elicitation`。 */
  getProtocolEra(): 'modern' | 'legacy' {
    return this.#options.elicitation ? 'modern' : 'legacy';
  }

  getServerCapabilities(): undefined {
    return undefined;
  }

  listen(): Promise<void> {
    return Promise.resolve();
  }

  /** 開的時候宿主給的整份清單；沒有下一頁。 */
  listTools(): Promise<{ tools: readonly Tool[] }> {
    return Promise.resolve({ tools: this.#document?.tools ?? [] });
  }

  /**
   * 呼叫一個工具。宿主路徑上 `_meta` 由宿主帶，這裡拿掉。
   *
   * @throws 等不到綁定、W 到期或已經 `close`：`server is disconnected`；送出之後宿主連線斷了：結果不明、不重送；
   * 送出後 `timeout` 加 W 到期：`REQUEST_TIMEOUT`；`structuredContent` 不合 `outputSchema`：丟錯。
   */
  async callTool(params: unknown, options: CallOptions = {}): Promise<unknown> {
    // 宿主路徑上 `_meta`（反問能力）由宿主一家帶；`toolCallOf` 照舊寫的，這裡拿掉。
    const { _meta: _ignored, ...forwarded } = (params ?? {}) as Record<string, unknown>;
    const result = (await this.#request('tools/call', forwarded, options)) as Record<
      string,
      unknown
    >;
    return await validatedOutput(result, options);
  }

  listResources(params?: { cursor: string }, options?: CallOptions): Promise<unknown> {
    return this.#request('resources/list', params ?? {}, options);
  }

  listResourceTemplates(params?: { cursor: string }, options?: CallOptions): Promise<unknown> {
    return this.#request('resources/templates/list', params ?? {}, options);
  }

  readResource(params: { uri: string }, options?: CallOptions): Promise<unknown> {
    return this.#request('resources/read', params, options);
  }

  /** 放掉綁定：取消 open 呼叫（宿主放掉綁定、連線留在池裡）、取消 `onReady` 登記、等綁定的呼叫立刻結算，第一次關時叫一次 `onclose`。冪等，不拋。 */
  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#unsubscribe();
      this.#abort.abort();
      this.#wake();
      this.onclose?.();
    }
    return Promise.resolve();
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

/**
 * 照 `toolDefinition.outputSchema` 驗 `structuredContent`，同 SDK 對一般呼叫做的：沒有 schema、`isError`、還在問人（`input_required`）都不驗。
 * 宿主送回的是原文，這一層每次都要驗。
 */
async function validatedOutput(
  result: Record<string, unknown>,
  options: CallOptions,
): Promise<unknown> {
  const schema = options.toolDefinition?.outputSchema;
  if (
    schema === undefined ||
    result.isError === true ||
    isInputRequiredResult(result as unknown as CallToolResult)
  ) {
    return result;
  }
  if (result.structuredContent === undefined) {
    throw new Error(
      `Tool ${options.toolDefinition?.name ?? ''} has an output schema but did not return structured content`,
    );
  }
  const validator = fromJsonSchema(schema as never, new DefaultJsonSchemaValidator()) as {
    '~standard': { validate: (value: unknown) => unknown };
  };
  const checked = (await validator['~standard'].validate(result.structuredContent)) as {
    issues?: readonly { message: string }[];
  };
  if (checked.issues !== undefined) {
    throw new Error(
      `Structured content does not match the tool's output schema: ${checked.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return result;
}
