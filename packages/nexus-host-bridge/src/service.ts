/**
 * TS 插件呼叫宿主服務的入口。
 *
 * {@link HostBridge} 是組裝時就在的門面：對話行程在組裝之前建它，拿到監督行程給的 token、連上宿主之後才 {@link HostBridgeHandle.attach}
 * 那條連線。所以插件在 `apply` 當下就讀得到它，依賴關係不跟著連線起落；沒連上時呼叫照「宿主不在」那一族結算（`errors.ts`）。
 *
 * 每個 Rust 服務在 TS 這邊用 {@link defineHostService} 給一個具名的把手，名字就是宿主那邊 `Cx::expose` 的服務名。
 * 兩邊名字對不上，到呼叫時以 `unknown_service`／`unknown_method` 發現。
 *
 * @module
 */

import type { HostCallOptions, HostClient, HostEvent } from './client.js';
import { HostCallError } from './errors.js';
import type { Json } from './protocol.js';

/** 門面在 Cordis 服務表上的名字。 */
export const HOST_BRIDGE_SERVICE = 'hostBridge';

/** 有宿主時，呼叫等連線 ready 最多等多久（毫秒）。 */
export const DEFAULT_HOST_WAIT_MS = 5_000;

export interface HostBridge {
  /**
   * 呼叫宿主上的服務。沒 ready 時先等，最多等到建門面時給的上限。
   *
   * @returns 宿主回的 `ok`。
   * @throws {@link HostCallError}：沒有宿主是 `host_absent`；等到上限還沒連上是 `host_unavailable`；其餘照 {@link HostClient.call}。
   */
  call(service: string, method: string, payload: Json, options?: HostCallOptions): Promise<Json>;
  /**
   * 每次連上宿主（包括重連之後）叫一次；已經 ready 的話登記當下也叫一次。綁定跟著連線走，重連後要重新登記的東西放在這裡。
   * 回傳的函式取消登記。
   */
  onReady(listener: () => void): () => void;
  /** 收 `service` 推來的事件；回傳的函式取消登記。 */
  onEvent(service: string, listener: (topic: string, payload: Json) => void): () => void;
}

/** 對話行程手上的那一面：組裝時交出 {@link HostBridgeHandle.bridge}，連上之後 {@link HostBridgeHandle.attach}。 */
export interface HostBridgeHandle {
  readonly bridge: HostBridge;
  /** 接上宿主連線。只能接一次；接了之後連線的重連由 {@link HostClient} 自己管。 */
  attach(client: HostClient): void;
}

export interface HostBridgeOptions {
  /** 呼叫等連線 ready 的上限（毫秒），預設 {@link DEFAULT_HOST_WAIT_MS}。 */
  readonly waitMs?: number;
}

/** 沒有宿主的門面：每個呼叫都以 `host_absent` 結算，`onReady` 永遠不叫。單行程模式與 CLI 用它。 */
export const ABSENT_HOST_BRIDGE: HostBridge = {
  call: () => Promise.reject(new HostCallError('host_absent', '這個行程沒有宿主')),
  onReady: () => () => undefined,
  onEvent: () => () => undefined,
};

/** 另寫成函式：`await` 之後狀態可能變了，不能沿用 `await` 之前的型別收窄。 */
function stillConnecting(client: HostClient): boolean {
  return client.state === 'connecting';
}

/** 建一個等連線接上來的門面。 */
export function createHostBridge(options: HostBridgeOptions = {}): HostBridgeHandle {
  const waitMs = options.waitMs ?? DEFAULT_HOST_WAIT_MS;
  let client: HostClient | undefined;
  const attached: (() => void)[] = [];
  const readyListeners = new Set<() => void>();
  const eventListeners = new Map<string, Set<(topic: string, payload: Json) => void>>();

  const onEvent = (event: HostEvent) => {
    for (const listener of [...(eventListeners.get(event.service) ?? [])]) {
      listener(event.topic, event.payload);
    }
  };

  /** 等到接上或到時限：接上回那條連線，沒接上回 `undefined`。 */
  const waitAttached = (deadline: number): Promise<HostClient | undefined> => {
    if (client !== undefined) return Promise.resolve(client);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        const index = attached.indexOf(done);
        if (index !== -1) attached.splice(index, 1);
        resolve(client);
      };
      const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
      timer.unref();
      attached.push(done);
    });
  };

  const bridge: HostBridge = {
    async call(service, method, payload, callOptions) {
      const deadline = Date.now() + waitMs;
      const connection = await waitAttached(deadline);
      if (connection === undefined) {
        throw new HostCallError('host_unavailable', `等了 ${String(waitMs)} 毫秒還沒連上宿主`);
      }
      // 到時限還在連就是 host_unavailable；等的期間 close 了，交給 call 回 host_absent。
      if (
        connection.state === 'connecting' &&
        !(await connection.waitReady(Math.max(0, deadline - Date.now()))) &&
        stillConnecting(connection)
      ) {
        throw new HostCallError('host_unavailable', `等了 ${String(waitMs)} 毫秒還沒連上宿主`);
      }
      return connection.call(service, method, payload, callOptions);
    },
    onReady(listener) {
      readyListeners.add(listener);
      if (client?.state === 'ready') listener();
      return () => readyListeners.delete(listener);
    },
    onEvent(service, listener) {
      const listeners = eventListeners.get(service) ?? new Set();
      listeners.add(listener);
      eventListeners.set(service, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) eventListeners.delete(service);
      };
    },
  };

  return {
    bridge,
    attach(connection) {
      if (client !== undefined) throw new Error('宿主連線已經接過了');
      client = connection;
      connection.onEvent(onEvent);
      connection.onReady(() => {
        for (const listener of [...readyListeners]) listener();
      });
      if (connection.state === 'ready') for (const listener of [...readyListeners]) listener();
      for (const done of [...attached]) done();
    },
  };
}

/** 一個宿主服務的具名把手：方法名與資料由呼叫端給，服務名固定。 */
export interface HostService {
  readonly name: string;
  call(method: string, payload: Json, options?: HostCallOptions): Promise<Json>;
  onEvent(listener: (topic: string, payload: Json) => void): () => void;
}

/**
 * 給宿主上名叫 `name` 的服務一個把手。在模組層定義，插件 `apply` 時拿 {@link HOST_BRIDGE_SERVICE} 讀到的門面接上：
 *
 * ```ts
 * const pool = defineHostService('mcp-pool');
 * // apply 裡，bridge 是照 HOST_BRIDGE_SERVICE 讀到的門面：
 * await pool(bridge).call('connect', { … });
 * ```
 */
export function defineHostService(name: string): (bridge: HostBridge) => HostService {
  return (bridge) => ({
    name,
    call: (method, payload, options) => bridge.call(name, method, payload, options),
    onEvent: (listener) => bridge.onEvent(name, listener),
  });
}
