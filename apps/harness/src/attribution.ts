/**
 * 送到模型端點的每個請求自報家門：`User-Agent` 是 `nexus-agent/<版號> (+<repo 網址>)`（#1562）。
 *
 * 照 dsh `packages/llm/llm/src/attribution.ts:1-68`：身分是 `{ product, version, url }` 三格，渲染成
 * `product/version (+url)`（RFC 9110 §10.1.5 的產品加註解寫法）。**只放公開的產品事實**：不含秘密、本機路徑、session id、
 * 提示文字或逐使用者的識別，也不隨請求改變——所以這一份是模組層的常數，`userAgent()` 只讀這三格。
 *
 * 版號取自 `apps/harness/package.json`（{@link HARNESS_VERSION}，#1502 的同一份讀法，不手抄）：dsh 讀套件自己的 manifest
 * 是同一個做法（`attribution.ts:12-16`）。manifest 今天是 `0.0.0`，發版時 `release:bump` 寫進去，所以出貨的產物送的是發版的版號。
 *
 * 白標（部署傳自己的身分）**不做**：dsh 留了傳入自己的身分的參數（`attribution.ts:34-39`），等真有部署要用再加。
 *
 * @module
 */

import { HARNESS_VERSION } from './harness-version.js';

/** 一份公開的產品身分，欄位同 dsh 的 `AppIdentity`。 */
export interface AppIdentity {
  /** `User-Agent` 的產品記號（小寫、連字號）。 */
  readonly product: string;
  /** 產品版號，取自套件的 manifest，不手抄。 */
  readonly version: string;
  /** 產品的 repo 首頁，放在 `User-Agent` 的註解裡。 */
  readonly url: string;
}

/** 這個 harness 自己的身分：每個送往模型端點的請求都帶它。 */
export const APP_IDENTITY: AppIdentity = {
  product: 'nexus-agent',
  version: HARNESS_VERSION,
  url: 'https://github.com/DemianLi/nexus-agent',
};

/**
 * 標準的 `User-Agent` 值：`product/version (+url)`。
 *
 * @param identity - 要渲染的身分，預設是 {@link APP_IDENTITY}。
 * @returns 可直接送的標頭值。
 */
export function userAgent(identity: AppIdentity = APP_IDENTITY): string {
  return `${identity.product}/${identity.version} (+${identity.url})`;
}
