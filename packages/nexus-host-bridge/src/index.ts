/**
 * `@nexus/host-bridge`：對話行程連宿主的客戶端（[#2569](https://github.com/DemianLi/nexus-agent/issues/2569)）。
 *
 * @module
 */

export {
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_BACKOFF_MS,
  HostClient,
  type HostClientOptions,
  type HostConnectionState,
} from './client.js';
export {
  FrameReader,
  HostProtocolError,
  MAX_FRAME,
  PROTOCOL_VERSION,
  decodeHostMessage,
  encodeClientMessage,
  frame,
  type ClientMessage,
  type HostMessage,
} from './protocol.js';
