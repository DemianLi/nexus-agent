import type { PermissionCatalog, PresetOption, WireProjection } from '@nexus/wire';
import { CUSTOM_PRESET } from '@nexus/wire';

/**
 * 權限座背後的純邏輯（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）：目前是哪一組、座位上寫什麼、
 * 切換送哪一行。契約見 `packages/nexus-wire/src/permission-presets.ts`。
 *
 * @module
 */

/**
 * 切過去要先確認的那一組：dsh 的 `danger-full-access`（沙箱全開、不再問人）。web 只認這個組名，不認「看起來危險」
 * 的描述；部署的人把組刪掉就沒有這一列，沒有要確認的東西。
 */
export const DANGER_PRESET = 'danger-full-access';

/** 沙箱與核准的實際值對不上任何一組時，座位上寫的字。 */
export const CUSTOM_PRESET_LABEL = '自訂';

/** 投影（key `permissions`）的整份值：`{ currentValue }`，形狀不對就當沒收到。 */
export function parsePermissionView(projection: WireProjection | undefined): string | undefined {
  const view: unknown = projection?.view;
  if (typeof view !== 'object' || view === null) return undefined;
  const value = (view as Record<string, unknown>).currentValue;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 目錄裡對得上目前值的那一組；`custom` 或目錄沒有（組被刪了）就是 `undefined`。 */
export function currentPreset(
  catalog: PermissionCatalog,
  currentValue: string,
): PresetOption | undefined {
  return catalog.options.find((option) => option.value === currentValue);
}

/** 座位上寫的字：組名；`custom` 寫「自訂」；目錄沒有的值原樣寫。 */
export function permissionSeatText(catalog: PermissionCatalog, currentValue: string): string {
  if (currentValue === CUSTOM_PRESET) return CUSTOM_PRESET_LABEL;
  return currentPreset(catalog, currentValue)?.name ?? currentValue;
}

/** 切換就是送這一行斜線命令（dsh 的網頁選單也是）。 */
export function permissionLine(value: string): string {
  return `/permission ${value}`;
}

/** 現在能不能切：斜線命令一輪沒收尾時伺服器擋，斷線時送不出去。回 `undefined` 就是能；否則是講給人聽的原因。 */
export function permissionLocked(connected: boolean, busy: boolean): string | undefined {
  if (!connected) return '連線中斷，連上之後才能切換。';
  if (busy) return '這一輪結束後才能切換。';
  return undefined;
}
