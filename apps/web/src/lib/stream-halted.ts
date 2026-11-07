/**
 * 下行斷了、但重連多半沒用，要停止自動重連、等人按的時候用的錯誤型別（[#2343](https://github.com/DemianLi/nexus-agent/issues/2343)）。
 *
 * 開線或抽下行時拋 {@link StreamHaltedError}，`hooks/use-conversation.ts` 就走停住的那條路：狀態列講 `text`，旁邊的按鈕寫
 * `actionLabel`，按了才重開；`online`／`offline` 不重排。看不懂的資料（`WireProtocolError`，#1601）走同一條路，文案是
 * `THREAD_PROTOCOL_ERROR_TEXT`、按鈕是 {@link RECONNECT_ACTION_LABEL}。
 *
 * @module
 */

/** 斷線時狀態列那顆按鈕的預設字。 */
export const RECONNECT_ACTION_LABEL = '立刻重連';

/** 停止自動重連，狀態列講 `text`、按鈕寫 `actionLabel`。 */
export class StreamHaltedError extends Error {
  constructor(
    readonly text: string,
    readonly actionLabel: string,
  ) {
    super(`下行停止自動重連：${text}`);
    this.name = 'StreamHaltedError';
  }
}
