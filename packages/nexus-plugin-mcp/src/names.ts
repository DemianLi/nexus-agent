/**
 * 模型面的工具名：`mcp__<serverName>__<rawName>`。
 *
 * 形狀照 dsh 的 `mcp-client`——「每個 MCP 工具有兩個名字：走 `tools/call` 上線的
 * raw name，與註冊給模型看的 public name」。這個前綴不是我們發明的，Claude Code 與
 * Codex 用的是同一個。`@langchain/mcp-adapters` 的 `MultiServerMCPClient` 預設
 * （`additionalToolNamePrefix: "mcp"` ＋ `prefixToolNameWithServerName: true`）拼出來
 * 正好就是它，所以常見情況下這裡什麼都不必改。
 *
 * 要補的是 adapter **沒有**做的那一半：正規化。它只是把字串接起來
 * （`dist/tools.js:439`），而供應商的 function name 契約是 64 字元的
 * `[A-Za-z0-9_-]`——一個名字太長或帶了句點的 MCP server 會讓整輪對話在供應商那端
 * 被退回，而且錯誤訊息不會指向這裡。
 */

import { createHash } from 'node:crypto';

/** `serverName` 的合法形狀，照 dsh：`[A-Za-z0-9_-]{1,32}`。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 供應商的 function name 契約：64 字元的 `[A-Za-z0-9_-]`。 */
const MAX_TOOL_NAME_LENGTH = 64;

/** 被換字或截斷時補在後面的指紋長度。 */
const FINGERPRINT_LENGTH = 12;

/**
 * 拼出一個工具的 public name。
 *
 * **是 `(serverName, rawName)` 的純函式**：連線順序、重新同步、別台 server 都不會讓
 * 同一個工具改名。名字被換字或截斷時補一段 12 位十六進位指紋，所以兩個原本會被壓成
 * 同一個名字的工具不會併成一個——那會讓模型呼叫到另一個工具，而且沒有任何錯誤。
 *
 * @param serverName - 這一台 server 的命名空間。
 * @param rawName - server 自己公告的工具名，也是 `tools/call` 上線的那個。
 * @returns 註冊給模型看的名字。
 */
export function publicToolName(serverName: string, rawName: string): string {
  const candidate = `mcp__${serverName}__${rawName}`;
  const replaced = candidate.replace(/[^A-Za-z0-9_-]/g, '_');
  if (replaced === candidate && candidate.length <= MAX_TOOL_NAME_LENGTH) return candidate;

  const fingerprint = createHash('sha256')
    .update(`${serverName} ${rawName}`)
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
  const suffix = `_${fingerprint}`;
  return `${replaced.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}
