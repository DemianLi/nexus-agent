/**
 * 嵌入的對話框，下行被 serve 以 401 擋下（[#2490](https://github.com/DemianLi/nexus-agent/issues/2490)）時用的錯誤型別與文案。
 *
 * 401 只在給了 `onUnauthorized` 的連線（嵌入版）上變成 {@link StreamUnauthorizedError}（`lib/agent.ts`）；獨立頁面是一般的 `Error`，
 * 照一般斷線退避重試。什麼時候重開見 `hooks/use-conversation.ts` 的 `signIns`。
 *
 * @module
 */

/** 不提 cookie、票或 401 這些詞；宿主頁換到票就自己接回來，使用者能做的只有找管理者。 */
export const EMBED_UNAUTHORIZED_TEXT = '你目前沒有使用這個對話框的權限。如有需要，請洽系統管理者。';

/** 嵌入版的下行回 401。 */
export class StreamUnauthorizedError extends Error {
  constructor() {
    super('下行被拒：401');
    this.name = 'StreamUnauthorizedError';
  }
}
