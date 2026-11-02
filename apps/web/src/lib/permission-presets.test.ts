import type { PermissionCatalog } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  CUSTOM_PRESET_LABEL,
  DANGER_PRESET,
  currentPreset,
  parsePermissionView,
  permissionLine,
  permissionLocked,
  permissionSeatText,
} from '@/lib/permission-presets';

const CATALOG: PermissionCatalog = {
  options: [
    { value: 'read-only', name: '唯讀' },
    { value: DANGER_PRESET, name: '全開' },
  ],
  defaultOptions: [{ value: 'read-only', name: '唯讀' }],
  defaultPreset: 'read-only',
};

describe('parsePermissionView', () => {
  it('收 { currentValue }', () => {
    expect(parsePermissionView({ version: 1, view: { currentValue: 'read-only' } })).toBe(
      'read-only',
    );
  });

  it.each([
    ['沒收到', undefined],
    ['失敗的投影', { version: 1, view: null, failed: true as const }],
    ['不是物件', { version: 1, view: 'read-only' }],
    ['缺 currentValue', { version: 1, view: {} }],
    ['空字串', { version: 1, view: { currentValue: '' } }],
    ['不是字串', { version: 1, view: { currentValue: 3 } }],
  ])('形狀不對就當沒收到：%s', (_case, projection) => {
    expect(parsePermissionView(projection)).toBeUndefined();
  });
});

describe('座位文字', () => {
  it('組名；custom 寫「自訂」；目錄沒有的值（組被刪了）原樣寫', () => {
    expect(permissionSeatText(CATALOG, 'read-only')).toBe('唯讀');
    expect(permissionSeatText(CATALOG, 'custom')).toBe(CUSTOM_PRESET_LABEL);
    expect(permissionSeatText(CATALOG, 'workspace-write')).toBe('workspace-write');
  });

  it('currentPreset：custom 與目錄外的值都沒有對應的一組', () => {
    expect(currentPreset(CATALOG, 'read-only')?.name).toBe('唯讀');
    expect(currentPreset(CATALOG, 'custom')).toBeUndefined();
    expect(currentPreset(CATALOG, 'gone')).toBeUndefined();
  });
});

describe('切換', () => {
  it('送的是 /permission <組名>', () => {
    expect(permissionLine('read-only')).toBe('/permission read-only');
  });

  it('全開的組名照 dsh', () => {
    expect(DANGER_PRESET).toBe('danger-full-access');
  });

  it('斷線與一輪沒收尾時鎖住，各有各的原因；否則能切', () => {
    expect(permissionLocked(true, false)).toBeUndefined();
    expect(permissionLocked(true, true)).toBe('這一輪結束後才能切換。');
    expect(permissionLocked(false, false)).toBe('連線中斷，連上之後才能切換。');
    expect(permissionLocked(false, true)).toBe('連線中斷，連上之後才能切換。');
  });
});
