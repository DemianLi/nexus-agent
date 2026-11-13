/**
 * `@nexus/host-bridge`：對話行程連宿主的客戶端（[#2569](https://github.com/DemianLi/nexus-agent/issues/2569)），與一對裡組合行程跟葉子之間那條橋的編解碼
 * （[#2583](https://github.com/DemianLi/nexus-agent/issues/2583)）。
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
  PAIR_ATTACH_METHOD,
  PAIR_ENVELOPE_BYTES,
  PAIR_HELLO_TIMEOUT_MS,
  PAIR_MAX_CALLS,
  PAIR_MAX_CHUNK_BYTES,
  PAIR_MAX_FRAME,
  PAIR_MAX_ID,
  PAIR_METHOD_ECHO_BYTES,
  PAIR_OUTBOX_LIMIT_BYTES,
  PAIR_OUTBOX_PAUSE_BYTES,
  PAIR_PROTOCOL_VERSION,
  PAIR_REJECT_CODES,
  PAIR_STALL_TIMEOUT_MS,
  PairFrameReader,
  PairProtocolError,
  decodePairMessage,
  encodePairMessage,
  type PairCallRef,
  type PairMessage,
  type PairRejectCode,
  type PairSide,
} from './pair-protocol.js';
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
