/**
 * 記在記憶體的嵌入稽核（`embed-login.test.ts`、`embed-session.test.ts`、`embed-stream-revoke.test.ts` 共用）：處理器的測試看它記了什麼，不碰檔案。
 *
 * @module
 */

import type {
  AccessRecord,
  EmbedAudit,
  ExchangeRecord,
  RedeemRecord,
  StreamRecord,
  UnattributedEvent,
} from './embed-audit.js';

/** `failNextWrite` 讓下一筆一筆一行的寫入失敗；`holdNextWrite` 讓下一筆停在落盤中，叫 `release` 才寫進去。 */
export function memoryAudit() {
  const records: ExchangeRecord[] = [];
  const redeems: RedeemRecord[] = [];
  const streams: StreamRecord[] = [];
  const accesses: AccessRecord[] = [];
  const unattributed: UnattributedEvent[] = [];
  let failNext = false;
  let hold: { readonly gate: Promise<void>; held: boolean } | undefined;
  function write<T>(list: T[], record: T): Promise<void> {
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error('disk full'));
    }
    if (hold !== undefined && !hold.held) {
      hold.held = true;
      return hold.gate.then(() => {
        list.push(record);
      });
    }
    list.push(record);
    return Promise.resolve();
  }
  const audit: EmbedAudit = {
    recordExchange: (record) => write(records, record),
    recordRedeem: (record) => write(redeems, record),
    recordStream: (record) => write(streams, record),
    recordAccess: (record) => write(accesses, record),
    recordUnauthenticated(event = 'exchange') {
      unattributed.push(event);
    },
    close: () => Promise.resolve(),
  };
  return {
    audit,
    records,
    redeems,
    streams,
    accesses,
    unattributed,
    unauthenticatedCount: () => unattributed.filter((event) => event === 'exchange').length,
    failNextWrite: () => {
      failNext = true;
    },
    holdNextWrite: () => {
      let release!: () => void;
      const current = {
        gate: new Promise<void>((resolve) => {
          release = resolve;
        }),
        held: false,
      };
      hold = current;
      return {
        /** 那一筆已經進來、停在落盤中就是 `true`；`release` 之後仍是 `true`。 */
        held: () => current.held,
        release: () => {
          hold = undefined;
          release();
        },
      };
    },
  };
}
