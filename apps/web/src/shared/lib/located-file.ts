import type { WirePresentedFile } from '@nexus/wire';

/**
 * 一個宣告交付的檔案，連同它在讀檔路由上的座標（[#452](https://github.com/DemianLi/nexus-agent/issues/452)）。
 *
 * **座標掛在每個檔案上，不掛在卡片上**：一張交付卡是同一輪多顆交付事件合併出來的，卡裡的檔案可能
 * 來自不同的 `seq`。隔壁改動卡那種「卡片一個 `seq`、位置用列表位置」的形狀（`ChangesCard`）在這裡
 * 表達不出來。
 */
export interface LocatedFile extends WirePresentedFile {
  /** 宣告它那顆 `deliverables/presented` 在 root 日誌裡的 `seq`。 */
  readonly seq: number;
  /**
   * 它在**那次宣告**的 `files` 裡的位置。
   *
   * **不是它在這張卡裡的位置**——合併之後兩者會分岔，而讀檔路由收的是前者。畫列表時不要拿 `map` 的
   * 那個索引頂替它。
   */
  readonly index: number;
}
