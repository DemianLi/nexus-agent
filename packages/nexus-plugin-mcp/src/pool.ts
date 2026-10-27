/**
 * 宿主的 MCP 連線池（[#1677](https://github.com/DemianLi/nexus-agent/issues/1677)）：**一份設定一份連線**，整個行程的組裝共用。
 *
 * serve 每條 thread 組一次 agent；沒有池的話每次組裝各連一次，一列 stdio 的 MCP 就是每條 thread 一個子行程。照 dsh 的全域
 * 實例（一台 server 一份連線、活到 Host 結束），serve 建一份池、經 {@link MCP_POOL_SERVICE} 交給每次組裝，plugin 拿到就向池
 * 取用。**池是選配的**：CLI 不提供，plugin 拿不到就照舊每次組裝自己連（同 #1418 的「可選，缺席就退回」）。
 *
 * ## 規則
 *
 * - **鍵是整份設定加實際的 elicitation 旗標**，`approval` 除外（{@link poolKey}）。改了那一列的設定，下一條 thread 連到新的
 *   一份，開著的 thread 照舊用舊的。
 * - **舊的一份留到 serve 結束**（demian 2026-10-20 拍板 A′）：不數使用者、不回收，池只在 {@link McpConnectionPool.close} 關。
 *   代價是重啟之前出現過幾種設定版本，就最多有幾個子行程。
 * - **監督者一建立就擁有第一次連線**（照 dsh `connection.ts:346` 的 `settling = connectGeneration(true)`）：表裡同步放進那一份，
 *   同一份設定同時取用只連一次。
 * - **建立那一份的取用等第一次連線落定**（照 dsh 的 `await connection.ready`，`index.ts:199`）：寫了 `failOnStartupError: true`
 *   就拋、池裡不留；沒寫就照 dsh 在背景重試（`supervisor.ts`），連上之後開的 thread 拿得到工具。
 * - **其餘的取用最多等 {@link FIRST_CONNECT_WAIT_MS}**：握手卡住時要等 SDK 的請求逾時才收（#1820 重審用新協定、不回 initialize
 *   的夾具量到 60.3 秒），不讓同一把鍵上之後的每一次組裝都跟著卡住。到期就照「連不上」處理這一份組裝：警告、沒有工具
 *   （`failOnStartupError: true` 就拋），連線照樣在背景繼續。偏離見下。
 * - **斷線空窗裡組的 thread 照最近一代的工具清單登記**（照 dsh：`generationDown` 只清 client，工具登記到放棄才撤，
 *   `connection.ts:180-185`、`:226-232`）：委派讀的是目前這一代，空窗期呼叫回 `server is disconnected`，重連之後同一條 thread
 *   叫得動。
 * - **放棄重連之後**（Q5 (b)）：下一次取用替這一份重開一個監督者、重新起算預算；開著的 thread 握著舊的那個，照舊隱藏工具。
 * - 重連進度寫進建池時給的日誌（serve 的伺服器日誌），不綁在哪一條 thread 上；dsh 是 error 級的那幾句走 `error`。
 *
 * **偏離登記：其餘取用的等待上限**（理由 1）。dsh 的 agent 建立不等 MCP 連線：工具是之後才同步上去的（`syncTools`）。我們的工具在
 * 組裝那一刻就定了（`supervisor.ts` 檔頭偏離 2），不等就一支都拿不到，所以等一段；但等的是別人起的那一次，不能無限期。
 * {@link FIRST_CONNECT_WAIT_MS} 是一次正常握手的好幾倍（PM 審查實測 708 ms 連上），又遠短於 SDK 的請求逾時。
 *
 * **前提**：同一台 server 由整台 serve、跨使用者共用一份連線。server 記在連線上的狀態不再一條 thread 一份；部署方要保證它沒有
 * 連線級狀態，或自己隔開（#1678 第 ⑤ 條）。
 *
 * @module
 */

import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { clientOptions, connectGeneration } from './connection.js';
import { credentialFingerprint } from './credentials.js';
import type { ResolvedCredentials } from './credentials.js';
import type { Generation, Listed } from './connection.js';
import type { McpConfig } from './index.js';
import { Supervisor } from './supervisor.js';

/** 宿主交連線池的服務名。 */
export const MCP_POOL_SERVICE = 'mcp:pool';

/** 不是建立那一份的取用，最多等第一次連線多久（毫秒），見檔頭的偏離。 */
export const FIRST_CONNECT_WAIT_MS = 5_000;

/** 池裡的一份：一個監督者，與它最近一代列出的工具。 */
export interface SharedConnection {
  /** 診斷訊息的前綴，例如 `mcp-client(github)`。 */
  readonly label: string;
  readonly supervisor: Supervisor<Generation>;
  /** 目前這一代的工具清單；斷線空窗裡是最近一代的；一代都還沒連上是 `undefined`。 */
  listed(): Listed | undefined;
}

/** 一次取用拿到的東西。 */
export interface Acquired {
  readonly shared: SharedConnection;
  /** 第一次連線失敗或等到期限還沒落定時的錯誤；連上過就是 `undefined`。 */
  readonly error: unknown;
}

/** 建池的選項。 */
export interface McpConnectionPoolOptions {
  /** 重連進度、放棄，都寫在這裡（serve 給伺服器日誌）。 */
  log(message: string): void;
  /** dsh 是 error 級的那幾句：關閉確認不到。省略即寫進 {@link log}。 */
  error?(message: string): void;
}

/**
 * 池的鍵：設定拿掉 `approval`、鍵排序之後的字串，加實際的 elicitation 旗標。
 *
 * - **拿掉 `approval`**：它只決定每份註冊表的核准閘門，跟連線無關。放進鍵的話，只改核准宣告也會多起一個活到重啟的子行程。
 * - **elicitation 旗標是實際的那一個**（設定開著、而且這次組裝有人可以回答）：它是握手時宣告給 server 的 client 能力，旗標
 *   不同的組裝不能共用一條連線（Q3 (a)）。
 * - **憑證引用放名字（在設定裡）加代入值的指紋**（[#1989](https://github.com/DemianLi/nexus-agent/issues/1989)）：值換了，下一次
 *   取用連新的一份，舊的照上面「舊的一份留到 serve 結束」留著。指紋是行程內隨機金鑰的 HMAC，鍵裡沒有值。
 */
export function poolKey(
  config: McpConfig,
  elicitation: boolean,
  credentials: ResolvedCredentials = new Map(),
): string {
  const { approval: _approval, ...connection } = config;
  const key = `${stableStringify(connection)}\0elicitation=${String(elicitation)}`;
  const fingerprint = credentialFingerprint(credentials);
  return fingerprint === '' ? key : `${key}\0credentials=${fingerprint}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 行程級的 MCP 連線池，見檔頭。 */
export class McpConnectionPool {
  private readonly options: McpConnectionPoolOptions;
  /** 鍵 → 目前那一份（還在連第一次的也在）。 */
  private readonly entries = new Map<string, SharedConnection>();
  /** 建過的每一份，含被重開取代的：關池時全部收。 */
  private readonly opened: SharedConnection[] = [];
  private closing: Promise<void> | undefined;

  constructor(options: McpConnectionPoolOptions) {
    this.options = options;
  }

  /**
   * 取這份設定的那一份連線；沒有就建，已放棄重連就重開。建立那一份的取用等第一次連線落定，其餘最多等
   * {@link FIRST_CONNECT_WAIT_MS}。**找表與建立之間沒有 `await`**，同時來的取用不會各建一份。
   *
   * @param credentials - 這一列已解析的憑證（名字 → 值）。值不同就是另一份連線；鍵裡只放名字與值的指紋。
   * @throws 第一次就連不上（或等到期限還沒連上）而且寫了 `failOnStartupError: true`；池已經關了。
   */
  async acquire(
    config: McpConfig,
    elicitation: boolean,
    credentials: ResolvedCredentials = new Map(),
  ): Promise<Acquired> {
    if (this.closing !== undefined) throw new Error('MCP 連線池已經關了');
    const key = poolKey(config, elicitation, credentials);
    const existing = this.entries.get(key);
    if (existing === undefined || existing.supervisor.gaveUp) {
      const shared = this.open(key, config, elicitation, credentials);
      const outcome = await shared.supervisor.ready;
      if (outcome.ok) return { shared, error: undefined };
      if (config.failOnStartupError) {
        if (this.entries.get(key) === shared) this.entries.delete(key);
        await shared.supervisor.dispose();
        throw outcome.error;
      }
      return { shared, error: outcome.error };
    }
    const outcome = await within(existing.supervisor.ready, FIRST_CONNECT_WAIT_MS);
    const error =
      outcome === undefined
        ? new Error(
            `${existing.label}: still connecting after ${String(FIRST_CONNECT_WAIT_MS)}ms — this assembly goes without its tools; the connection keeps trying in the background`,
          )
        : outcome.ok
          ? undefined
          : outcome.error;
    if (error !== undefined && config.failOnStartupError) throw error;
    return { shared: existing, error };
  }

  /**
   * 收掉池裡每一份（含被重開取代的、還在連第一次的），每一份的期限照監督者的 `GENERATION_CLOSE_TIMEOUT_MS`、同時收。
   * **不等第一次連線**：監督者的 dispose 自己把那一次算進期限。冪等。
   */
  close(): Promise<void> {
    this.closing ??= Promise.all(this.opened.map((shared) => shared.supervisor.dispose())).then(
      () => {},
    );
    return this.closing;
  }

  /** 建一份並**同步**放進表裡；第一次連線交給監督者。 */
  private open(
    key: string,
    config: McpConfig,
    elicitation: boolean,
    credentials: ResolvedCredentials,
  ): SharedConnection {
    const { serverName } = config;
    const label = `mcp-client(${serverName})`;
    const client = new MultiServerMCPClient(clientOptions(config, elicitation, credentials));
    const { log } = this.options;
    const error = this.options.error ?? log;
    let last: Listed | undefined;
    // 這一次嘗試開的子行程真的關掉時落定；每次 connect 先重設成已落定，握手就失敗（拿不到 SDK client）的嘗試就沒有東西可等。
    let attemptClosed: Promise<void> = Promise.resolve();
    const track = (closed: Promise<void>): void => {
      attemptClosed = closed;
    };
    const supervisor = new Supervisor<Generation>(
      {
        label,
        policy: config.reconnect,
        // 同 plugin 自己連的那條：把整個 adapter client 收掉再重新列工具，新子行程、新的 SDK client。
        async connect() {
          await client.close();
          attemptClosed = Promise.resolve();
          return connectGeneration(client, config, track);
        },
        // 失敗的嘗試當場收掉整個 adapter client，再等這次開的子行程真的關掉（#1835）。
        async abandon() {
          // hook 契約是不拋；收不乾淨的由監督者的期限與 dispose 的 `release` 接手。
          await client.close().catch(() => {});
          await attemptClosed;
        },
        close: () => client.close(),
        closed: (generation) => generation.closed,
        // dispose 最後把整個 adapter 收掉：被期限丟下、還在握手的嘗試，或 abandon 沒收乾淨的殘留，連一次都沒連上的也算。
        release: () => client.close(),
        watch(generation, onDown) {
          // 每採用一代都會走到這裡：記下它的工具清單，斷線空窗裡組的 thread 照它登記（檔頭）。
          last = generation.listed;
          generation.onDown = onDown;
        },
        report: log,
        error,
      },
      connectGeneration(client, config, track),
      // `failOnStartupError` 那一列第一次就連不上不在背景重試：建立那一份的取用拋出去、收掉這一份（同 dsh 讓那一列失敗）。
      { retryFirstFailure: !config.failOnStartupError },
    );
    const shared: SharedConnection = {
      label,
      supervisor,
      listed: () => supervisor.current()?.listed ?? last,
    };
    this.entries.set(key, shared);
    this.opened.push(shared);
    return shared;
  }
}

/** `work` 在 `ms` 內落定就回它的值，逾時回 `undefined`。計時器 `unref`、落定就清掉。 */
function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(undefined);
    }, ms);
    timeout.unref();
    void work.then((value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}
