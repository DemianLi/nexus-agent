/**
 * `@nexus/host-bridge`：對話行程連宿主的客戶端（[#2569](https://github.com/DemianLi/nexus-agent/issues/2569)）。
 *
 * @module
 */

export {
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_BACKOFF_MS,
  HostClient,
  type HostCallOptions,
  type HostClientOptions,
  type HostConnectionState,
  type HostEvent,
} from './client.js';
export {
  HOST_ABSENCE_CODES,
  HostCallError,
  type HostAbsenceCode,
  type HostCallErrorCode,
} from './errors.js';
export {
  FrameReader,
  HOST_ERROR_CODES,
  HostProtocolError,
  MAX_DEPTH,
  MAX_FRAME,
  MAX_ID,
  PROTOCOL_VERSION,
  decodeHostMessage,
  encodeClientMessage,
  frame,
  type ClientMessage,
  type HostErrorCode,
  type HostMessage,
  type Json,
  type Side,
} from './protocol.js';
export {
  ABSENT_HOST_BRIDGE,
  DEFAULT_HOST_WAIT_MS,
  HOST_BRIDGE_SERVICE,
  createHostBridge,
  defineHostService,
  type HostBridge,
  type HostBridgeHandle,
  type HostBridgeOptions,
  type HostService,
} from './service.js';
