import { vi } from 'vitest';

/** UUID v4 的形狀：第 13 碼是版本 `4`，第 17 碼是變體 `[89ab]`。 */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * 造一個非安全環境（內網用 IP 開的 `http://` 頁面）：全域的 `crypto` 換成只有 `getRandomValues` 的物件，`randomUUID` 不存在
 * （#1335、#1548）。還原交給呼叫端的 `vi.unstubAllGlobals()`。
 */
export function stubInsecureCrypto(): void {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
}
