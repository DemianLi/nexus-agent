/**
 * 對話行程連宿主（[#2569](https://github.com/DemianLi/nexus-agent/issues/2569)）：監督行程有起宿主時，在對話行程的 argv 多帶
 * `--host-socket <路徑>`（就是宿主 bind 的那一個），token 則在控制通道的 `hello` 裡給。兩樣都到了才連，連線本身交給 `@nexus/host-bridge`。
 *
 * TS 插件經 `@nexus/host-bridge` 的門面（`hostBridge` 服務）呼叫宿主服務：有 `--host-socket` 時組裝之前就建好門面
 * （{@link createConversationHostBridge}），拿到 token 建連線時由 {@link connectHost} 接上（不等 ready）；沒有就是一律回 `host_absent` 的那一個。
 * 宿主死了、重起了，客戶端自己重連，對話不受影響；斷線時在跑的呼叫以 `host_lost` 結算。
 *
 * @module
 */

import { HostClient, createHostBridge, type HostBridgeHandle } from '@nexus/host-bridge';

/** 拆出 `--host-socket <path>`，其餘原樣回傳；沒帶就是沒有宿主。帶了卻少了路徑（或下一個是旗標）就拋。 */
export function parseHostSocketArg(argv: readonly string[]): {
  readonly hostSocket: string | undefined;
  readonly rest: readonly string[];
} {
  const index = argv.indexOf('--host-socket');
  if (index === -1) return { hostSocket: undefined, rest: argv };
  const hostSocket = argv[index + 1];
  if (hostSocket === undefined || hostSocket.startsWith('--')) {
    throw new Error('--host-socket 要一個路徑');
  }
  return { hostSocket, rest: [...argv.slice(0, index), ...argv.slice(index + 2)] };
}

/** 有 `--host-socket` 就建一個等連線接上來的門面，沒有就回 `undefined`（組裝點改交沒有宿主的那一個）。 */
export function createConversationHostBridge(
  hostSocket: string | undefined,
): HostBridgeHandle | undefined {
  return hostSocket === undefined ? undefined : createHostBridge();
}

export interface ConnectHostOptions {
  readonly hostSocket: string | undefined;
  readonly token: string;
  readonly log: (line: string) => void;
  /** 組裝之前建好的門面；建好 `HostClient` 就接上去，不等 ready。 */
  readonly bridge?: HostBridgeHandle | undefined;
}

/** 有 `--host-socket` 就連宿主（有門面就接上），沒有就回 `undefined`。 */
export function connectHost(options: ConnectHostOptions): HostClient | undefined {
  if (options.hostSocket === undefined) return undefined;
  const client = new HostClient({
    socketPath: options.hostSocket,
    token: options.token,
    log: options.log,
  });
  options.bridge?.attach(client);
  return client;
}
