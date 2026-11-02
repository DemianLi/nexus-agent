/**
 * 具名權限組合上線的形狀（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）。
 *
 * **這一份只是契約**：型別、method 名字、client 方法。server 端還沒實作，`permission.catalog`
 * 一律回 `not_supported`，`permissions` 這個投影也還不會送；web 據前者把選單藏起來。
 *
 * 照 dsh 的 `permission-presets`（`packages/interaction/permission-presets/src/{types,index}.ts`，`5badb150`）：
 *
 * - **目錄**（`permission.catalog`）：`{ options, defaultOptions, defaultPreset }`，`options` 是目前可選的組，
 *   依宣告順序；每一組是 `{ value, name, description? }`。這份是整台共用的，與會話歷史無關。
 * - **目前是哪一組**：會話投影 `permissions`，整份值就是 `{ currentValue }`。值是 `options` 裡的某個 `value`，或
 *   {@link CUSTOM_PRESET}（沙箱與核准的實際值對不上任何一組，**只能顯示、不是切換目標**）。投影缺席＝這個組裝沒有權限組合，
 *   client 藏起選單。載體是泛用的插件投影通道（`projection.ts`，#1026）：key 是 {@link PERMISSIONS_PROJECTION_KEY}，
 *   讀 `ConversationState.projections.permissions.view`，不另開 frame 與折疊欄位——dsh 的 `permissions` 也是走它的 `sessionProjections`。
 * - **切換**不另開 RPC：dsh 的網頁選單送出的就是 `/permission <組名>` 那一行斜線命令（`index.ts:252-254`），這裡照做，
 *   走既有的 `slash.run`。不帶參數的 `/permission` 回報目前那一組與可選的組。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **目錄掛在 thread 底下**（`permission.catalog`）：理由同 `model-selection.ts` 的偏離 2。
 * 2. **沒有 `auto` 這一組與目錄變動通知**：dsh 的 `auto` 是選配、出廠沒開的一組，目錄靠 payload-free 的事件通知變動；我們
 *    出廠的目錄在啟動時就定了，沒有執行期增減，所以不需要。哪天有了再加。
 *
 * @module
 */

/** 這個檔定義的 method：目錄只有一支讀取。 */
export const PERMISSION_METHODS = ['permission.catalog'] as const;

export type PermissionMethod = (typeof PERMISSION_METHODS)[number];

export function isPermissionMethod(value: unknown): value is PermissionMethod {
  return typeof value === 'string' && (PERMISSION_METHODS as readonly string[]).includes(value);
}

/**
 * 沙箱與核准的實際值對不上任何一組時，{@link PermissionSelection.currentValue} 的值。只能顯示，不是切換目標，
 * 也不會出現在目錄裡（設定裡不能用這個名字，同 dsh）。
 */
export const CUSTOM_PRESET = 'custom';

/** 目錄裡的一組。 */
export interface PresetOption {
  /** 穩定的值：`/permission` 收的組名。 */
  readonly value: string;
  /** 畫面上的名字。 */
  readonly name: string;
  /** 一句話說這一組是什麼意思；設定裡沒寫就沒有。 */
  readonly description?: string;
}

/** 整台共用的目錄，同 dsh 的 `PermissionCatalog`。 */
export interface PermissionCatalog {
  /** 目前可選的組，依宣告順序。 */
  readonly options: readonly PresetOption[];
  /** 可以當新會話預設的組。 */
  readonly defaultOptions: readonly PresetOption[];
  /** 沒選過的會話用的組。 */
  readonly defaultPreset: string;
}

export interface PermissionCatalogCommand {
  readonly id: number;
  readonly method: 'permission.catalog';
  readonly params: Record<string, never>;
}

export type PermissionCommand = PermissionCatalogCommand;

export type PermissionCatalogResult = {
  readonly ok: true;
  readonly value: { readonly catalog: PermissionCatalog };
};

/** 投影的 key（`ConversationState.projections` 的鍵）：這條會話目前是哪一組權限。 */
export const PERMISSIONS_PROJECTION_KEY = 'permissions';

/** 投影 {@link PERMISSIONS_PROJECTION_KEY} 的 `view`：整份值（後到的取代先到的），同 dsh 的 `PermissionSelection`。 */
export interface PermissionSelection {
  /** 現在的有效值：目錄裡的一個 `value`，或 {@link CUSTOM_PRESET}。 */
  readonly currentValue: string;
}
