/**
 * 經宿主連 MCP server（#3000 E4b）：每條對話行程不再自己連，向宿主的 `mcp/client` 服務 `open` 一份綁定、再用 `call` 送請求，
 * 宿主整台共用一份連線。協議與切塊見 `docs/host-mcp.md`。
 *
 * 這一層只做一件事：**長得像 SDK 的 `Client`**（{@link HostMcpClient}），交給 {@link attemptsOn} 的 `open` 縫。下游的
 * `connectGeneration`、`toolCallOf`、`Supervisor`、資源來源都不知道連線在宿主那邊。
 *
 * **兩層重連，各管各的**：宿主自己對 MCP server 退避重連（空窗裡的呼叫回 `server is disconnected`，綁定不變、不通知這一側）；
 * 這一側只在「宿主連線斷了又連上」（`onReady`）時重新 `open`。所以這個 client 從不呼叫 `onclose`，TS 的 `Supervisor` 不會因此重連，
 * 也不吃那一列的 `reconnect` 設定。
 *
 * 重新 `open` 之前的呼叫：等當前綁定最多 {@link DEFAULT_REBIND_WAIT_MS}，到了回 `server is disconnected`；
 * 送出去之後宿主連線斷了的（`host_lost`），結果不明、不重送。
 *
 * 取代 SDK 替我們做的事，逐項：逾時取消（{@link HostMcpClient.callTool} 的 `timeout`，到了送取消）、`outputSchema` 驗證
 * （照 `toolDefinition`，每次呼叫都驗）、`resources/list` 翻頁（呼叫端逐頁走，這裡原樣轉）、掉線分類（宿主自己重連，這一側不分類）、
 * 探活（宿主那一側，這裡的 `listTools` 回開時的清單）、`taskSupport`（宿主拿不到這一欄，`connectGeneration` 照舊在列工具後擋）。
 *
 * @module
 */

import { fromJsonSchema, isInputRequiredResult } from '@modelcontextprotocol/client';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/client/_shims';

/** 宿主交連線的服務名。 */
export const MCP_HOST_SERVICE = 'mcp/client';

/** 重新 `open` 之前的呼叫最多等多久（毫秒）。對話行程重連宿主的上限是 1 秒，重起一次空窗通常在這之內。 */
export const DEFAULT_REBIND_WAIT_MS = 5_000;

/** 一份宿主的 `open`／`call` 呼叫選項。 */
export interface HostCallOptionsLike {
  readonly signal?: AbortSignal;
  /** 串流的方法每推一塊叫一次。 */
  readonly onChunk?: (chunk: unknown) => void;
  /** 呼叫編號配好、送出之前叫一次：`call` 的 `open` 欄位要指到 `open` 那一個的編號。 */
  readonly onId?: (id: number) => void;
}

/**
 * 宿主門面（`@nexus/host-bridge` 的 `HostBridge`）在這一層用到的部分。結構型別：外掛不相依 host-bridge 套件，
 * 沒有宿主時插件服務表上也沒有它。錯誤用 `code` 分：`host_lost`（送出去之後斷線）、`host_unavailable`／`host_absent`（沒送出去）。
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
  /** 宿主 `open` 收的 `server`：{@link McpHostRow} 的成品。 */
  readonly server: { readonly serverName: string } & Readonly<Record<string, unknown>>;
  /** 要宣告反問能力的旗標，原樣給宿主。 */
  readonly elicitation: boolean;
  /** 重新 `open` 之前的呼叫最多等多久，預設 {@link DEFAULT_REBIND_WAIT_MS}。 */
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

/** 長得像 SDK `Client`、底下是宿主綁定的連線。結構上夠 {@link attemptsOn} 與 {@link toolCallOf} 用。 */
export class HostMcpClient {
  /** 從不叫：宿主自己重連，這一側的重新 `open` 不算掉線。 */
  onclose?: () => void;

  readonly #caller: HostCaller;
  readonly #options: HostOpenOptions;
  readonly #abort = new AbortController();
  readonly #unsubscribe: () => void;
  readonly #waiters = new Set<() => void>();
  #document: OpenDocument | undefined;
  /** 當前綁定的呼叫編號；空窗（還沒綁、宿主斷線）是 `undefined`。 */
  #bound: number | undefined;
  #opening = false;
  #closed = false;

  private constructor(caller: HostCaller, options: HostOpenOptions) {
    this.#caller = caller;
    this.#options = options;
    this.#unsubscribe = caller.onReady(() => {
      // 第一次的 open 由 `open` 自己發；這裡只管之後宿主重連回來的重新 open。
      if (this.#document !== undefined) this.#rebind();
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

  /** 發一次 `open`，回清單；`ready` 之後的結局（斷線、取消）在背景處理。 */
  #openOnce(): Promise<OpenDocument> {
    this.#opening = true;
    return new Promise<OpenDocument>((resolve, reject) => {
      const text = new Reassembly();
      let id: number | undefined;
      let ready = false;
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
              this.#bound = id;
              this.#opening = false;
              this.#wake();
              resolve(document);
            },
          },
        )
        .then(
          () => {
            // open 不收尾；收尾了就是綁定沒了。
            this.#lose(ready, reject, new Error('宿主的 open 呼叫結束了'));
          },
          (error: unknown) => {
            this.#lose(ready, reject, error);
          },
        );
    });
  }

  #lose(ready: boolean, reject: (error: unknown) => void, error: unknown): void {
    this.#bound = undefined;
    this.#opening = false;
    if (!ready) {
      reject(error);
      return;
    }
    // ready 之後綁定沒了：等宿主連線回來（onReady）再重新 open。取消是自己關的，不用記。
    if (!this.#closed) {
      this.#options.log?.(
        `宿主的綁定沒了：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #rebind(): void {
    if (this.#closed || this.#opening || this.#bound !== undefined) return;
    this.#openOnce().then(
      () => undefined,
      (error: unknown) => {
        // 重新 open 失敗（宿主那邊 server 還沒好、取用錯誤）：等下一次 onReady，空窗裡的呼叫到期回斷線。
        this.#options.log?.(
          `重新向宿主 open 失敗：${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }

  #wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }

  /** 等到有綁定；到 `waitMs` 或 `signal` 中止回 `undefined`。 */
  #awaitBound(signal: AbortSignal | undefined): Promise<number | undefined> {
    if (this.#bound !== undefined) return Promise.resolve(this.#bound);
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        this.#waiters.delete(check);
        resolve(this.#bound);
      };
      const check = (): void => {
        if (this.#bound !== undefined || this.#closed) finish();
      };
      const timer = setTimeout(finish, this.#options.rebindWaitMs ?? DEFAULT_REBIND_WAIT_MS);
      timer.unref();
      this.#waiters.add(check);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  /** 送一次請求到宿主那一份連線，拼回結果。 */
  async #request(method: string, params: unknown, options: CallOptions = {}): Promise<unknown> {
    const abort = new AbortController();
    const forward = (): void => {
      abort.abort(options.signal?.reason);
    };
    if (options.signal?.aborted === true) forward();
    options.signal?.addEventListener('abort', forward, { once: true });
    let timedOut = false;
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            abort.abort();
          }, options.timeout);
    try {
      for (;;) {
        const open = await this.#awaitBound(abort.signal);
        if (abort.signal.aborted)
          throw timedOut ? timeoutError(options.timeout ?? 0) : abortError(options.signal);
        if (open === undefined) throw new Error(`${this.#label()}: server is disconnected`);
        const text = new Reassembly();
        let summary: unknown;
        try {
          summary = await this.#caller.call(
            MCP_HOST_SERVICE,
            'call',
            { open, method, params: JSON.stringify(params) },
            { signal: abort.signal, onChunk: (chunk) => text.push(chunk) },
          );
        } catch (error) {
          if (abort.signal.aborted)
            throw timedOut ? timeoutError(options.timeout ?? 0) : abortError(options.signal);
          // 沒送出去（宿主還沒連上）：照等待額度重試；送出去之後斷線不重送。
          if (codeOf(error) === 'host_unavailable') {
            this.#bound = undefined;
            continue;
          }
          if (codeOf(error) === 'host_lost') {
            throw new Error(
              `${this.#label()}: the host connection dropped while this call was running; the result is unknown and the call was not retried`,
              { cause: error },
            );
          }
          throw error;
        }
        if (!isSummary(summary)) throw new Error('宿主 call 的收尾不是塊數與位元組數');
        return JSON.parse(text.text(summary));
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', forward);
    }
  }

  #label(): string {
    return `mcp-client(${this.#options.server.serverName})`;
  }

  getInstructions(): string | undefined {
    return rawInstructions(this.#document?.instructions ?? '', this.#options.server.serverName);
  }

  /** 宿主不告訴這一側協定世代：有反問旗標就照新協定帶 `_meta`（宿主對舊協定不加，這一側帶了的 server 照舊忽略）。 */
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

  async callTool(params: unknown, options: CallOptions = {}): Promise<unknown> {
    const result = (await this.#request('tools/call', params, options)) as Record<string, unknown>;
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

  /** 放掉綁定（取消 open 呼叫，宿主那邊放掉綁定、連線留在池裡）。冪等，不拋。 */
  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#unsubscribe();
      this.#abort.abort();
      this.#wake();
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
