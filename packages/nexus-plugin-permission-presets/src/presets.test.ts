/**
 * 組合表與推導：純函式，不碰日誌也不碰控制器。
 *
 * 出廠三組的名字與值是照 dsh 一字不差抄的（`packages/bundle/base/cordis.patch.yml:252-261`），web 的「全開」確認認的就是
 * `danger-full-access` 這個名字——所以它們被釘在這裡，改動要有人明著來改這一條。
 */

import { describe, expect, it } from 'vitest';

import {
  CUSTOM_PRESET,
  DEFAULT_PRESETS,
  derivePreset,
  permissionPresetsConfigSchema,
  specOf,
} from './presets.js';
import type { PresetTable } from './presets.js';

describe('出廠三組', () => {
  it('名字、值與順序照 dsh', () => {
    expect(
      Object.entries(DEFAULT_PRESETS).map(([name, spec]) => [name, spec.sandbox, spec.approval]),
    ).toEqual([
      ['read-only', 'read-only', 'ask'],
      ['workspace-write', 'workspace-write', 'ask'],
      ['danger-full-access', 'danger-full-access', 'never'],
    ]);
  });

  it('每一組都有說明；`custom` 不在表裡', () => {
    for (const spec of Object.values(DEFAULT_PRESETS)) expect(spec.description).toBeTruthy();
    expect(Object.hasOwn(DEFAULT_PRESETS, CUSTOM_PRESET)).toBe(false);
  });
});

describe('derivePreset：現在是哪一組是推導出來的', () => {
  it('實際值對上哪一組就是哪一組，與日誌記的名字無關', () => {
    expect(
      derivePreset(DEFAULT_PRESETS, { preset: null, sandbox: 'read-only', approval: 'ask' }),
    ).toBe('read-only');
    expect(
      derivePreset(DEFAULT_PRESETS, {
        preset: 'read-only',
        sandbox: 'danger-full-access',
        approval: 'never',
      }),
    ).toBe('danger-full-access');
  });

  it('只動了其中一顆旋鈕就對不上任何一組：custom', () => {
    // 全開沙箱但核准改回 ask：兩顆旋鈕各自切過，不是任何一組。
    expect(
      derivePreset(DEFAULT_PRESETS, {
        preset: 'danger-full-access',
        sandbox: 'danger-full-access',
        approval: 'ask',
      }),
    ).toBe(CUSTOM_PRESET);
    expect(
      derivePreset(DEFAULT_PRESETS, { preset: null, sandbox: 'read-only', approval: 'never' }),
    ).toBe(CUSTOM_PRESET);
  });

  it('日誌還沒有事件的格子用出廠假設補（workspace-write＋ask）', () => {
    expect(derivePreset(DEFAULT_PRESETS, { preset: null, sandbox: null, approval: null })).toBe(
      'workspace-write',
    );
  });

  it('兩組捆著同樣的一對值：使用者選的那一組贏，否則表裡先宣告的贏', () => {
    const twins: PresetTable = {
      a: { sandbox: 'read-only', approval: 'ask' },
      b: { sandbox: 'read-only', approval: 'ask' },
    };
    const knobs = { sandbox: 'read-only', approval: 'ask' } as const;
    expect(derivePreset(twins, { preset: 'b', ...knobs })).toBe('b');
    expect(derivePreset(twins, { preset: null, ...knobs })).toBe('a');
    // 記著的那一組已經對不上了就不算數。
    expect(derivePreset(twins, { preset: 'b', sandbox: 'workspace-write', approval: 'ask' })).toBe(
      CUSTOM_PRESET,
    );
  });

  it('日誌或使用者給的名字不會落到原型上（constructor、__proto__）', () => {
    for (const name of ['constructor', '__proto__', 'toString']) {
      expect(specOf(DEFAULT_PRESETS, name)).toBeUndefined();
      expect(
        derivePreset(DEFAULT_PRESETS, { preset: name, sandbox: 'read-only', approval: 'ask' }),
      ).toBe('read-only');
    }
  });
});

describe('設定的形狀', () => {
  it('省略 presets 就是出廠三組，而且是各自的一份拷貝（改了不影響別的組裝）', () => {
    const first = permissionPresetsConfigSchema.parse({});
    const second = permissionPresetsConfigSchema.parse({});
    expect(Object.keys(first.presets)).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ]);
    expect(first.presets).not.toBe(second.presets);
  });

  it('一組不講清楚兩個值就不收（沒有預設值）；多出來的欄位也不收', () => {
    expect(
      permissionPresetsConfigSchema.safeParse({ presets: { a: { sandbox: 'read-only' } } }).success,
    ).toBe(false);
    expect(
      permissionPresetsConfigSchema.safeParse({ presets: { a: { approval: 'ask' } } }).success,
    ).toBe(false);
    expect(
      permissionPresetsConfigSchema.safeParse({
        presets: { a: { sandbox: 'read-only', approval: 'ask', extra: 1 } },
      }).success,
    ).toBe(false);
    expect(
      permissionPresetsConfigSchema.safeParse({
        presets: { a: { sandbox: 'nope', approval: 'ask' } },
      }).success,
    ).toBe(false);
  });

  it('presets 是整份替換：給了就只有給的那些', () => {
    const parsed = permissionPresetsConfigSchema.parse({
      presets: { only: { sandbox: 'read-only', approval: 'never' } },
    });
    expect(Object.keys(parsed.presets)).toEqual(['only']);
  });
});
