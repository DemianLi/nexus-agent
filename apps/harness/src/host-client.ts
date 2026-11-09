/**
 * 對話行程連宿主（[#2569](https://github.com/DemianLi/nexus-agent/issues/2569)）：監督行程有起宿主時，在對話行程的 argv 多帶
 * `--host-socket <路徑>`（就是宿主 bind 的那一個），token 則在控制通道的 `hello` 裡給。兩樣都到了才連，連線本身交給 `@nexus/host-bridge`。
 *
 * 宿主目前不提供服務，連上之後什麼都不送；宿主死了、重起了，客戶端自己重連，對話不受影響。
 *
 * @module
 */

import { HostClient } from '@nexus/host-bridge';

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

export interface ConnectHostOptions {
  readonly hostSocket: string | undefined;
  readonly token: string;
  readonly log: (line: string) => void;
}

/** 有 `--host-socket` 就連宿主，沒有就回 `undefined`。 */
export function connectHost(options: ConnectHostOptions): HostClient | undefined {
  if (options.hostSocket === undefined) return undefined;
  return new HostClient({ socketPath: options.hostSocket, token: options.token, log: options.log });
}
