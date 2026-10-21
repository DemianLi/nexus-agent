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
 * - **第一次就連不上**：寫了 `failOnStartupError: true` 就拋、池裡不留；沒寫就照 dsh 在背景重試（`supervisor.ts`），連上之後
 *   開的 thread 拿得到工具，連上之前組好的照偏離 2 拿不到。
 * - **放棄重連之後**（Q5 (b)）：下一次取用替這一份重開一個監督者、重新起算預算；開著的 thread 握著舊的那個，照舊隱藏工具。
 * - **同一份設定同時取用只連一次**：建立中的那一份同步放進表裡，後來的等同一個 promise。
 * - 重連進度寫進建池時給的日誌（serve 的伺服器日誌），不綁在哪一條 thread 上。
 *
 * **前提**：同一台 server 由整台 serve、跨使用者共用一份連線。server 記在連線上的狀態不再一條 thread 一份；部署方要保證它沒有
 * 連線級狀態，或自己隔開（#1678 第 ⑤ 條）。
 *
 * @module
 */

import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { clientOptions, connectGeneration } from './connection.js';
import type { Generation } from './connection.js';
import type { McpConfig } from './index.js';
import { Supervisor } from './supervisor.js';

/** 宿主交連線池的服務名。 */
export const MCP_POOL_SERVICE = 'mcp:pool';

/** 池裡的一份：一個監督者，與第一次就連不上時的那個錯誤。 */
export interface SharedConnection {
  /** 診斷訊息的前綴，例如 `mcp-client(github)`。 */
  readonly label: string;
  readonly supervisor: Supervisor<Generation>;
  /** 第一次就連不上時的錯誤；連上過就是 `undefined`。 */
  readonly startupError: unknown;
}

/** 建池的選項。 */
export interface McpConnectionPoolOptions {
  /** 重連進度、放棄、關閉確認不到，都寫在這裡（serve 給伺服器日誌）。 */
  log(message: string): void;
}

/**
 * 池的鍵：設定拿掉 `approval`、鍵排序之後的字串，加實際的 elicitation 旗標。
 *
 * - **拿掉 `approval`**：它只決定每份註冊表的核准閘門，跟連線無關。放進鍵的話，只改核准宣告也會多起一個活到重啟的子行程。
 * - **elicitation 旗標是實際的那一個**（設定開著、而且這次組裝有人可以回答）：它是握手時宣告給 server 的 client 能力，旗標
 *   不同的組裝不能共用一條連線（Q3 (a)）。
 */
export function poolKey(config: McpConfig, elicitation: boolean): string {
  const { approval: _approval, ...connection } = config;
  return `${stableStringify(connection)}\0elicitation=${String(elicitation)}`;
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
  /** 鍵 → 目前那一份（建立中的也在）。 */
  private readonly entries = new Map<string, Promise<SharedConnection>>();
  /** 建過的每一份，含被重開取代的：關池時全部收。 */
  private readonly opened: SharedConnection[] = [];
  private closing: Promise<void> | undefined;

  constructor(options: McpConnectionPoolOptions) {
    this.options = options;
  }

  /**
   * 取這份設定的那一份連線；沒有就建，已放棄重連就重開。
   *
   * @throws 第一次就連不上而且寫了 `failOnStartupError: true`（池裡不留這一份）；池已經關了。
   */
  acquire(config: McpConfig, elicitation: boolean): Promise<SharedConnection> {
    if (this.closing !== undefined) return Promise.reject(new Error('MCP 連線池已經關了'));
    const key = poolKey(config, elicitation);
    const existing = this.entries.get(key);
    if (existing === undefined) return this.open(key, config, elicitation);
    return existing.then((shared) => {
      if (!shared.supervisor.gaveUp) return shared;
      // 同時來的另一次取用已經重開了：拿它那一份。
      if (this.entries.get(key) !== existing) return this.acquire(config, elicitation);
      return this.open(key, config, elicitation);
    });
  }

  /** 收掉池裡每一份（含被重開取代的），每一份的期限照監督者的 `GENERATION_CLOSE_TIMEOUT_MS`。冪等。 */
  close(): Promise<void> {
    this.closing ??= (async () => {
      await Promise.allSettled([...this.entries.values()]);
      await Promise.all(this.opened.map((shared) => shared.supervisor.dispose()));
    })();
    return this.closing;
  }

  /** 建一份並**同步**放進表裡，同時來的取用等同一次連線。建失敗就從表裡拿掉，下一次取用重新建。 */
  private open(key: string, config: McpConfig, elicitation: boolean): Promise<SharedConnection> {
    const creating = this.create(config, elicitation);
    this.entries.set(key, creating);
    creating.catch(() => {
      if (this.entries.get(key) === creating) this.entries.delete(key);
    });
    return creating;
  }

  private async create(config: McpConfig, elicitation: boolean): Promise<SharedConnection> {
    const { serverName } = config;
    const label = `mcp-client(${serverName})`;
    const client = new MultiServerMCPClient(clientOptions(config, elicitation));
    const { log } = this.options;
    let first: Generation | undefined;
    let startupError: unknown;
    try {
      first = await connectGeneration(client, config);
    } catch (error) {
      // 連到一半的東西先收掉：背景重試的每一次也是先 `close()` 再連。
      await client.close().catch(() => {});
      if (config.failOnStartupError) throw error;
      startupError = error;
    }
    const supervisor = new Supervisor<Generation>(
      {
        label,
        policy: config.reconnect,
        // 同 plugin 自己連的那條：把整個 adapter client 收掉再重新列工具，新子行程、新的 SDK client。
        async connect() {
          await client.close();
          return connectGeneration(client, config);
        },
        close: () => client.close(),
        closed: (generation) => generation.closed,
        release: () => client.close(),
        watch(generation, onDown) {
          generation.onDown = onDown;
        },
        report: log,
        error: log,
      },
      first,
    );
    const shared: SharedConnection = { label, supervisor, startupError };
    this.opened.push(shared);
    return shared;
  }
}
