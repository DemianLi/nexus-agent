/**
 * 對話行程啟動時的試組用的宿主門面（#3000）。
 *
 * 試組在 `runServe` 裡、先於對話行程拿到宿主 token，真的門面此時還沒接上連線；MCP 列若在試組裡向宿主 `open`，會等門面的 5 秒才失敗，
 * 拖過監督行程等對話行程起來的時限，整條 thread 起不來。試組只驗設定與組裝，不需要連線：`mcp/client` 的 `open` 在這裡當場回一份空清單，
 * 列的設定照樣經 `MCP_HOST_ROW_SERVICE` 驗過；其他服務一律當宿主不在。真正的連線在 thread 組裝時才向真的宿主 `open`。
 *
 * @module
 */

import { ABSENT_HOST_BRIDGE } from '@nexus/host-bridge';
import type { HostBridge } from '@nexus/host-bridge';

const EMPTY_OPEN = JSON.stringify({ tools: [], instructions: '', warning: null });

/** 試組用的門面，見檔頭。 */
export const TRIAL_HOST_BRIDGE: HostBridge = {
  call(service, method, payload, options) {
    if (service !== 'mcp/client' || method !== 'open') {
      return ABSENT_HOST_BRIDGE.call(service, method, payload, options);
    }
    options?.onId?.(0);
    options?.onChunk?.(EMPTY_OPEN);
    options?.onChunk?.({ ready: { chunks: 1, bytes: Buffer.byteLength(EMPTY_OPEN, 'utf8') } });
    // open 不收尾：掛著，直到呼叫端取消。
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        reject(new Error('試組的 open 取消了'));
      });
    });
  },
  onReady: ABSENT_HOST_BRIDGE.onReady,
  onEvent: ABSENT_HOST_BRIDGE.onEvent,
};
