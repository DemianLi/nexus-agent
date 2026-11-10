/**
 * MCP 那一列引用的憑證，值長什麼樣才代入（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)）。
 *
 * 規則比模型 key（`api-key.ts`，#1541）寬：MCP 的憑證不只是 API key，也可能是資料庫密碼，中間的空白與非 ASCII 字元是正當的。
 * 只擋放進去會出事的：
 *
 * - 兩條路都修掉頭尾空白與換行（YAML `|` 區塊值帶出的尾端換行），修完是空的就拒絕。
 * - `env`：NUL。環境變數是 C 字串，NUL 之後的部分會被截掉。
 * - `header`：Node http 驗 header 值的規則（`validateHeaderValue`），允許 tab、0x20–0x7E、0x80–0xFF。
 *   要在這裡先擋，是因為 MCP 的 HTTP transport 走 `fetch`，undici 的 `Headers` 遇到 CR、LF、NUL 拋的錯會原樣帶出整個值。
 *
 * 拒絕訊息只講名字與來源層，不含值的任何片段。
 *
 * @module
 */

import type { McpCredentialUse } from '@nexus/plugin-mcp';

import { describeOrigin, InvalidCredentialError } from './api-key.js';
import type { ResolvedCredential } from './credentials.js';

/** Node http 收的 header 值字元；`fetch` 收的範圍不同，這裡取兩者都收得下的。 */
const HEADER_VALUE = /^[\t\x20-\x7E\x80-\xFF]*$/u;

/**
 * 收下一把要交給 MCP server 的憑證，或拒收。
 *
 * @param name - 憑證名，訊息指名它。
 * @param hit - 憑證服務解析到的那一筆。
 * @param use - 代入到環境變數還是 header。
 * @returns 修過頭尾的值。
 * @throws {@link InvalidCredentialError}：修完是空的，或含有 `use` 放不下的字元。訊息不含值的任何片段。
 */
export function assertUsableMcpCredential(
  name: string,
  hit: ResolvedCredential,
  use: McpCredentialUse,
): string {
  const value = hit.value.trim();
  const from = `${name}（來自${describeOrigin(hit.source, hit.path)}）`;
  if (value.length === 0) {
    throw new InvalidCredentialError(`${from}是空白的。請把它改成憑證本身，或把那一行拿掉。`);
  }
  if (use === 'env' && value.includes('\0')) {
    throw new InvalidCredentialError(`${from}含有 NUL 字元，放不進環境變數。`);
  }
  if (use === 'header' && !HEADER_VALUE.test(value)) {
    throw new InvalidCredentialError(
      `${from}含有 HTTP header 放不下的字元（換行、NUL 等控制字元，或 U+00FF 之後的字元）。`,
    );
  }
  return value;
}
