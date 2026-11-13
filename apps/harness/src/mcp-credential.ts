/**
 * MCP 那一列引用的憑證，值長什麼樣才代入（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)）。
 *
 * 規則比模型 key（`api-key.ts`，#1541）寬：MCP 的憑證不只是 API key，也可能是資料庫密碼，中間的空白與非 ASCII 字元是正當的。
 * 只擋放進去會出事的：
 *
 * - 兩條路都修掉頭尾空白與換行（YAML `|` 區塊值帶出的尾端換行），修完是空的就拒絕。
 * - 修完少於 8 個 code point 的拒絕（#2570）：宿主會在送回對話行程的文字裡遮掉憑證值（這裡的遮蔽在 #2669），太短的值偶然撞上正常內容的機率高，
 *   遮了會把成功的結果改壞。短的非秘密值（帳號、埠號）改寫成設定裡的字面值；宿主今天分不出憑證與字面值，字面值也會收、夠長的也遮（過渡，見 `docs/credentials-file.md`〈MCP 憑證值的遮蔽〉）。
 * - `env`：NUL。`child_process.spawn` 遇到含 NUL 的 env 值會拋 `ERR_INVALID_ARG_VALUE`，訊息帶出整個值。
 * - `header`：Node http 驗 header 值的規則（`validateHeaderValue`），允許 tab、0x20–0x7E、0x80–0xFF。
 *   要在這裡先擋，是因為 MCP 的 HTTP transport 走 `fetch`，undici 的 `Headers` 遇到 CR、LF、NUL 拋的錯會原樣帶出整個值。
 *
 * 拒絕訊息只講名字與來源層，不含值的任何片段。Rust 宿主照同一條規則（`native/sandbox-spawner/host/src/mcp/redact.rs` 的 `check_value`），
 * 兩邊跑同一份樣本 `credentials-vectors.json` 的 `mcpValue`。
 *
 * @module
 */

import type { McpCredentialUse } from '@nexus/plugin-mcp';

import { describeOrigin, InvalidCredentialError } from './api-key.js';
import type { ResolvedCredential } from './credentials.js';

/** 憑證值修剪後至少要有幾個 code point。同宿主的 `MIN_VALUE_CODE_POINTS`。 */
export const MIN_MCP_CREDENTIAL_CODE_POINTS = 8;

/** Node http 收的 header 值字元；`fetch` 收的範圍不同，這裡取兩者都收得下的。 */
const HEADER_VALUE = /^[\t\x20-\x7E\x80-\xFF]*$/u;

/**
 * 收下一把要交給 MCP server 的憑證，或拒收。
 *
 * @param name - 憑證名，訊息指名它。
 * @param hit - 憑證服務解析到的那一筆。
 * @param use - 代入到環境變數還是 header。
 * @returns 修過頭尾的值。
 * @throws {@link InvalidCredentialError}：修完是空的、含有 `use` 放不下的字元，或不到 {@link MIN_MCP_CREDENTIAL_CODE_POINTS} 個 code point。訊息不含值的任何片段。
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
  if (false as boolean && [...value].length < MIN_MCP_CREDENTIAL_CODE_POINTS) {
    throw new InvalidCredentialError(
      `${from}修掉頭尾空白之後不到 ${MIN_MCP_CREDENTIAL_CODE_POINTS} 個字元。太短的值在回應裡偶然撞上的機率高，遮蔽會把正常內容一起遮掉；請換成較長的憑證，或把它改寫成字面值。`,
    );
  }
  return value;
}
