/**
 * 網頁裡產 UUID 一律走這裡（[#1548](https://github.com/DemianLi/nexus-agent/issues/1548)）：thread id、`run.start` 的請求編號都是。
 *
 * 照 dsh `packages/util/crypto/src/index.ts` 的 `randomUUID` 與 `packages/client/connection/src/client/random-uuid.ts`
 * 的 `randomUuid`（`687f282e`）：用 `crypto.getRandomValues` 自己排，不用 `crypto.randomUUID`。後者只在安全環境（HTTPS、
 * localhost）有，內網用 IP 開的 `http://` 頁面上它是 `undefined`，首次載入就會拋錯、整頁起不來（做法從
 * [#1335](https://github.com/DemianLi/nexus-agent/issues/1335) 的請求編號搬過來）。`apps/web/eslint.config.js` 的
 * `no-restricted-properties` 擋 `crypto.randomUUID`，把人導到這裡。
 *
 * **放在 `apps/web` 而不是照 dsh 開一個共用套件**：今天要它的只有網頁（harness 跑在 Node 上，`crypto.randomUUID` 一定有）。
 * 哪天 `@nexus/wire` 也要產 UUID，再照 dsh 搬進共用套件。
 *
 * @module
 */

/**
 * 一個新的 UUID v4（RFC 9562 §5.4）：36 個字元的小寫字串。
 *
 * @returns 版本位元是 4、變體位元是 `10` 的 UUID。
 */
export function randomUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
