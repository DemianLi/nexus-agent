/**
 * 下行 `custom` frame 的**名字→酬載表**（[#685](https://github.com/DemianLi/nexus-agent/issues/685)）。
 *
 * `custom` 這個 channel 上只走 pump 從日誌合成的 domain 事件（見 `protocol.ts` 的 `WIRE_CHANNELS`），`data` 是
 * `{ name, payload }`。哪些名字、各帶什麼酬載，**只寫在這一張表上**：生產端（harness 的即時與歷史兩條路）只收
 * {@link CustomFrameData}，讀的一端（`conversation.ts` 的 `reduceCustom`）對 {@link CustomFrameName} 窮舉分派。表上多一格
 * 而折疊器沒補分支，`@nexus/wire` 當場編不過；生產端送一個表上沒有的名字、或酬載形狀不對，harness 當場編不過。
 *
 * ## 照 dsh
 *
 * dsh 的投影值有一張可宣告合併的表 `SessionProjectionMap`，各領域套件合進自己的 key
 * （`packages/session/session-projection/src/types.ts:17`；收件匣在 `packages/core/agent/src/types.ts:64-67` 合進
 * `inbox: InboxWireState`），生產端的 `wire.view` 必須回傳 `SessionProjectionMap[K]`
 * （`packages/session/session-projection/src/index.ts:73-84`），讀的一端也用同一張表定型
 * （`packages/api/session-controller/src/client/sessions/projection-store.ts:39`）。以上對 dsh `c1b47e4`，卡上引的
 * `477b4f4` 同內容。
 *
 * 這張表同形：**每個領域檔在自己的常數旁合進那一格**（`declare module './custom-frame.js'`），這裡只放空的
 * interface。所以名字清單不在任何散文裡手列——要知道今天有哪些，看這張表合併之後的鍵。
 *
 * **窮舉是 dsh 沒有的額外防線**：dsh 逐 key 讀，我們只有一個折疊器把所有名字分派出去，所以在那裡加一道
 * 編譯期的「每一格都有人接」。形狀不變。執行期的酬載驗證仍由各個 `reduceX` 做，本表不碰那一軸。
 *
 * @module
 */

/**
 * 名字→酬載。空的：每一格由它的領域檔用宣告合併加進來，見檔頭。
 *
 * 新增一種 `custom` frame：在領域檔裡宣告常數與酬載型別，然後
 *
 * ```ts
 * declare module './custom-frame.js' {
 *   interface CustomFramePayloads {
 *     [NEW_NAME]: NewPayload;
 *   }
 * }
 * ```
 *
 * 再到 `conversation.ts` 的折疊器補那一格的分支（不補編不過）。
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 宣告合併的表，空是刻意的，見上。
export interface CustomFramePayloads {}

/** 表上的名字。 */
export type CustomFrameName = keyof CustomFramePayloads;

/** 一顆 `custom` frame 的 `data`：表上的一個名字配上它那一格的酬載。 */
export type CustomFrameData = {
  readonly [K in CustomFrameName]: { readonly name: K; readonly payload: CustomFramePayloads[K] };
}[CustomFrameName];
