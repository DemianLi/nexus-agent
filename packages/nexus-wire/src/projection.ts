/**
 * 插件投影的 `custom` frame（[#1026](https://github.com/DemianLi/nexus-agent/issues/1026)，設計見
 * `.docs/session-projections-design.md`）。
 *
 * 跟 `todos`、`plan`、`title` 那幾格不同：那些每一種一個名字、一個折疊分支、`ConversationState` 上一個欄位；這一格是
 * **泛用的槽**——所有插件註冊的投影共用同一種 frame、同一個折疊分支、`ConversationState.projections` 上的一格，
 * 以 `key` 區分。新增一個投影不必動 `conversation.ts`。
 *
 * ## 整份值，不是 diff
 *
 * 照 dsh 的 `{type:'projection', sessionId, key, value, seq}`（`packages/api/session-controller/src/types.ts:570-581`，
 * `5badb15`）：值整份取代。往前翻頁不動它（它是「現在」的事）。
 *
 * ## 對 #1018 Q1 A 的讀法
 *
 * 卡文是「每種投影一個有名字的 `custom` frame」。這裡讀成「每種投影有自己的 `key`，共用同一種 frame 與同一個槽」：
 * 名字進 `CUSTOM_REDUCERS` 的鍵就是逐種分支，與「不必改 `conversation.ts`」的驗收衝突。
 *
 * ## `version` 與 `failed`
 *
 * `version` 是單元宣告的 `stateVersion`（折疊語意＋view 形狀的版本）：web 的渲染器按 `(key, version)` 選，不認得的版本不渲染。
 * `failed: true` 表示該單元的折疊拋過、已被停用，`view` 一律是 `null`；web 看到就藏起該面板（不顯示過期的值）。
 *
 * @module
 */

/**
 * 投影 key 的格式。**與 `@nexus/core` 的 `PROJECTION_KEY_PATTERN` 逐字相同**（`projection.test.ts` 釘住）：
 * wire 只 import core 的型別、不 import 它的值（web 會打包這個套件），所以複製一份而不是引用。
 */
export const PROJECTION_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** `custom` 事件的 `data.name`：某個插件投影現在是這樣。 */
export const PROJECTION = 'projection';

/** {@link PROJECTION} 的 `payload`：一個投影的整個值。 */
export interface ProjectionPayload {
  /** 投影的 key，註冊表內唯一（`@nexus/core` 的 `PROJECTION_KEY_PATTERN`）。 */
  readonly key: string;
  /** 單元宣告的 `stateVersion`，非負整數。 */
  readonly version: number;
  /** 純 JSON 的整份值；`failed` 時是 `null`。 */
  readonly view: unknown;
  /** 該單元的折疊拋過、已停用。有這一格時 `view` 一定是 `null`。 */
  readonly failed?: true;
  /**
   * 這是**哪一個子代理自己的日誌**折出來的值（它的 `runId`，[#1028](https://github.com/DemianLi/nexus-agent/issues/1028)）；
   * 省略 ＝ root 的。單元要宣告 `children` 才會有子代理的值；落在 `ConversationState.subagentProjections[session][key]`，
   * 不碰 root 那一格。
   */
  readonly session?: string;
}

/** `ConversationState.projections` 上一格：{@link ProjectionPayload} 去掉 `key`（key 是它的鍵）。 */
export interface WireProjection {
  readonly version: number;
  readonly view: unknown;
  readonly failed?: true;
}

// 名字→酬載表（#685）上屬於這個檔的格子，見 `custom-frame.ts`。
declare module './custom-frame.js' {
  interface CustomFramePayloads {
    [PROJECTION]: ProjectionPayload;
  }
}
