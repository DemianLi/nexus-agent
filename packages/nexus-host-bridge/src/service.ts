/**
 * TS 插件呼叫宿主服務的入口。
 *
 * {@link HostBridge} 是組裝時就在的門面：對話行程在組裝之前建它，拿到監督行程給的 token、建好連線（還沒 ready）時才
 * {@link HostBridgeHandle.attach} 那條連線。所以插件在 `apply` 當下就讀得到它，依賴關係不跟著連線起落；沒連上時呼叫照「宿主不在」那一族結算（`errors.ts`）。
 *
 * 每個 Rust 服務在 TS 這邊用 {@link defineHostService} 給一個具名的把手，名字就是宿主那邊 `Cx::expose` 的服務名。
 * 兩邊名字對不上，到呼叫時以 `unknown_service`／`unknown_method` 發現。
 *
 * @module
 */

import type { HostCallOptions, HostClient, HostEvent } from './client.js';
import { HostCallError } from './errors.js';
import type { Json } from './protocol.js';

/** 門面在插件服務表（`registry.services`）上的名字。 */
export const HOST_BRIDGE_SERVICE = 'hostBridge';

/** 有宿主時，呼叫等連線 ready 最多等多久（毫秒）。 */
export const DEFAULT_HOST_WAIT_MS = 5_000;

export interface HostBridge {
  /**
   * 呼叫宿主上的服務。沒 ready 時先等，最多等到建門面時給的上限；等的期間 `signal` 中止就以 `cancelled` 結算，不送出。
   *
   * @returns 宿主回的 `ok`。
   * @throws {@link HostCallError}：沒有宿主是 `host_absent`；等到上限還沒連上是 `host_unavailable`；其餘照 {@link HostClient.call}。
   */
  call(service: string, method: string, payload: Json, options?: HostCallOptions): Promise<Json>;
  /**
   * 每次連上宿主（包括重連之後）叫一次；已經 ready 的話登記當下也叫一次。綁定跟著連線走，重連後要重新登記的東西放在這裡。
   * 回傳的函式取消登記。listener 丟錯不影響其他 listener：連上時那一次由連線記一行 log，登記當下那一次拋給登記的人。
   */
  onReady(listener: () => void): () => void;
  /** 收 `service` 推來的事件；回傳的函式取消登記。listener 丟錯不影響其他 listener，由連線記一行 log。 */
  onEvent(service: string, listener: (topic: string, payload: Json) => void): () => void;
}

/** 對話行程手上的那一面：組裝時交出 {@link HostBridgeHandle.bridge}，連上之後 {@link HostBridgeHandle.attach}。 */
export interface HostBridgeHandle {
  readonly bridge: HostBridge;
  /**
   * 接上宿主連線。只能接一次，第二次丟錯；接了之後連線的重連由 {@link HostClient} 自己管。
   * 接上時連線已經 ready 的，`onReady` 的 listener 當下叫一次，丟的錯在全部叫完之後拋給呼叫端。
   */
  attach(client: HostClient): void;
}

export interface HostBridgeOptions {
  /** 呼叫等連線 ready 的上限（毫秒），預設 {@link DEFAULT_HOST_WAIT_MS}。 */
  readonly waitMs?: number;
}

/** 沒有宿主的門面：每個呼叫都以 `host_absent` 結算，`onReady` 永遠不叫。組裝點沒拿到門面時交它：單行程 serve、CLI，以及 serve 起動時的試組。 */
export const ABSENT_HOST_BRIDGE: HostBridge = {
  call: () => Promise.reject(new HostCallError('host_absent', '這個行程沒有宿主')),
  onReady: () => () => undefined,
  onEvent: () => () => undefined,
};

/** 每個 listener 都叫到；丟的錯在全部叫完之後再拋，一個就原樣、多個包成 `AggregateError`。 */
function fanOut<L>(listeners: Iterable<L>, invoke: (listener: L) => void): void {
  const errors: unknown[] = [];
  for (const listener of [...listeners]) {
    try {
      invoke(listener);
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, `${String(errors.length)} 個 listener 丟了錯`);
}

/** `promise` 與 `signal` 先到的那一個：中止就以 `cancelled` 結算。 */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(new HostCallError('cancelled', '送出之前就取消了'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new HostCallError('cancelled', '等宿主連線時取消了'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/** 建一個等連線接上來的門面。 */
export function createHostBridge(options: HostBridgeOptions = {}): HostBridgeHandle {
  const waitMs = options.waitMs ?? DEFAULT_HOST_WAIT_MS;
  let client: HostClient | undefined;
  const attached: (() => void)[] = [];
  const readyListeners = new Set<() => void>();
  const eventListeners = new Map<string, Set<(topic: string, payload: Json) => void>>();

  const onEvent = (event: HostEvent) => {
    fanOut(eventListeners.get(event.service) ?? [], (listener) => {
      listener(event.topic, event.payload);
    });
  };
  const fireReady = () => {
    fanOut(readyListeners, (listener) => {
      listener();
    });
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
      const signal = callOptions?.signal;
      const deadline = Date.now() + waitMs;
      const connection = await unlessAborted(waitAttached(deadline), signal);
      if (connection === undefined) {
        throw new HostCallError('host_unavailable', `等了 ${String(waitMs)} 毫秒還沒連上宿主`);
      }
      // 到時限還在連就是 host_unavailable；等的期間 close 了，交給 call 回 host_absent。
      const ready = await unlessAborted(
        connection.waitReady(Math.max(0, deadline - Date.now())),
        signal,
      );
      if (!ready && connection.state === 'connecting') {
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
      connection.onReady(fireReady);
      for (const done of [...attached]) done();
      if (connection.state === 'ready') fireReady();
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
 * const service = defineHostService('<服務名>');
 * // apply 裡，bridge 是照 HOST_BRIDGE_SERVICE 讀到的門面：
 * await service(bridge).call('<方法名>', { … });
 * ```
 */
export function defineHostService(name: string): (bridge: HostBridge) => HostService {
  return (bridge) => ({
    name,
    call: (method, payload, options) => bridge.call(name, method, payload, options),
    onEvent: (listener) => bridge.onEvent(name, listener),
  });
}
