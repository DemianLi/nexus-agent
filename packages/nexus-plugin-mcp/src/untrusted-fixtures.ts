/**
 * 測試素材：MCP 工具結果與資源結果本文前面那一行「外部內容」前綴（[#1768](https://github.com/DemianLi/nexus-agent/issues/1768)）的拆法。
 *
 * 不是在測前綴本身的測試（它們直接比 `EXTERNAL_MCP_CONTENT_NOTICE`，見 `untrusted-mark.test.ts`），而是在量別的事、需要拿到
 * server 回的原文去 `JSON.parse` 或逐字比的測試用：先確認前綴真的在，再把它拿掉。**前綴不在就拋**，所以拿掉 `untrusted-mark.ts`
 * 的標記，這些測試也會紅，不會悄悄變成沒有檢查。
 *
 * 不進 `index.ts` 的匯出——它是測試素材。
 */

import { EXTERNAL_MCP_CONTENT_NOTICE } from '@nexus/core';

/** 拿掉開頭的前綴（含後面的換行）；開頭不是前綴就拋。 */
export function withoutNotice(text: string): string {
  const prefix = `${EXTERNAL_MCP_CONTENT_NOTICE}\n`;
  if (!text.startsWith(prefix)) {
    throw new Error(`結果的開頭不是外部內容前綴：${JSON.stringify(text.slice(0, 80))}`);
  }
  return text.slice(prefix.length);
}

/** 資源結果是 `MCP server: <name>\n<前綴>\n<本文>`（出處行在前）：拿掉前綴那一行，其餘原樣。 */
export function withoutResourceNotice(text: string): string {
  const lineEnd = text.indexOf('\n');
  const rest = text.slice(lineEnd + 1);
  return `${text.slice(0, lineEnd + 1)}${withoutNotice(rest)}`;
}
