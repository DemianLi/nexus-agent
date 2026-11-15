/**
 * serve 正在收尾、不收新的一輪（`server_closing`，[#1787](https://github.com/DemianLi/nexus-agent/issues/1787)）時，
 * 給使用者看的那一句（[#1995](https://github.com/DemianLi/nexus-agent/issues/1995)）。
 *
 * **不顯示 server 的 message**：那句給管理者與接 wire 的人看。這句只寫一份，`run.start`、`slash.run`、`subagent.send` 三條路共用。
 *
 * @module
 */

import { SERVER_CLOSING } from '@nexus/wire';

/** 講的是話或命令都適用，所以不說「這句話」。 */
export const SERVER_CLOSING_TEXT = '伺服器正在重新啟動，這次沒有送出。請稍後再送一次。';

/** 錯誤碼是「serve 正在收尾」就回 {@link SERVER_CLOSING_TEXT}，其他情況回 `undefined`（照各處自己的講法）。 */
export function serverClosingText(code: string | undefined): string | undefined {
  return code === SERVER_CLOSING ? SERVER_CLOSING_TEXT : undefined;
}
