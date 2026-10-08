/** plugin 本身：預設組怎麼決定、目錄長什麼樣、載入時的硬相依。組裝在產品上的行為在 `apps/harness/src/permission-presets.test.ts`。 */

import { ApprovalPolicyController, createHostServicesPlugin, loadPlugins } from '@nexus/core';
import { CONTAINED_FILESYSTEM, SandboxModeController } from '@nexus/plugin-sandbox-policy';
import { describe, expect, it } from 'vitest';

import {
  buildCatalog,
  createPermissionPresetsPlugin,
  PERMISSION_PRESETS_SERVICE,
  resolveDefaultPreset,
} from './index.js';
import type { PermissionSeed } from './index.js';
import { DEFAULT_PRESETS } from './presets.js';

const FRESH: PermissionSeed = { fresh: true, sandboxExplicit: false };
const RESUMED: PermissionSeed = { fresh: false, sandboxExplicit: false };

function knobs(
  sandbox: ConstructorParameters<typeof SandboxModeController>[0],
  approval: 'ask' | 'never',
) {
  return {
    sandbox: new SandboxModeController(sandbox),
    approval: new ApprovalPolicyController(approval),
  };
}

describe('resolveDefaultPreset', () => {
  it('沒設 defaultPreset：由起始的兩顆值推；不動旋鈕', () => {
    const k = knobs('read-only', 'ask');
    expect(
      resolveDefaultPreset({ table: DEFAULT_PRESETS, configured: undefined, seed: FRESH, ...k }),
    ).toBe('read-only');
    expect([k.sandbox.current, k.approval.current]).toEqual(['read-only', 'ask']);
  });

  it('設了 defaultPreset 的新會話：兩顆旋鈕都設到那一組', () => {
    const k = knobs('workspace-write', 'ask');
    expect(
      resolveDefaultPreset({
        table: DEFAULT_PRESETS,
        configured: 'danger-full-access',
        seed: FRESH,
        ...k,
      }),
    ).toBe('danger-full-access');
    expect([k.sandbox.current, k.approval.current]).toEqual(['danger-full-access', 'never']);
  });

  it('續接不套 defaultPreset：保留日誌裡的值', () => {
    const k = knobs('read-only', 'ask');
    resolveDefaultPreset({
      table: DEFAULT_PRESETS,
      configured: 'danger-full-access',
      seed: RESUMED,
      ...k,
    });
    expect([k.sandbox.current, k.approval.current]).toEqual(['read-only', 'ask']);
  });

  it('defaultPreset 不在表裡：報錯並列出有哪些', () => {
    expect(() =>
      resolveDefaultPreset({
        table: DEFAULT_PRESETS,
        configured: 'nope',
        seed: FRESH,
        ...knobs('read-only', 'ask'),
      }),
    ).toThrow(/nope.*read-only、workspace-write、danger-full-access/s);
  });

  it('defaultPreset 與明確給的 --sandbox 矛盾：報錯；沒明確給就以 defaultPreset 為準', () => {
    const explicit: PermissionSeed = { fresh: true, sandboxExplicit: true };
    expect(() =>
      resolveDefaultPreset({
        table: DEFAULT_PRESETS,
        configured: 'read-only',
        seed: explicit,
        ...knobs('danger-full-access', 'never'),
      }),
    ).toThrow('互相矛盾');
    // 同一組、不矛盾就放行。
    expect(
      resolveDefaultPreset({
        table: DEFAULT_PRESETS,
        configured: 'read-only',
        seed: explicit,
        ...knobs('read-only', 'ask'),
      }),
    ).toBe('read-only');
  });

  it('起始值對不上任何一組又沒設 defaultPreset：新會話報錯，續接放行（拿表裡第一組當目錄預設）', () => {
    const table = { only: { sandbox: 'read-only', approval: 'ask' } } as const;
    expect(() =>
      resolveDefaultPreset({
        table,
        configured: undefined,
        seed: FRESH,
        ...knobs('workspace-write', 'ask'),
      }),
    ).toThrow('對不上組合表裡任何一組');
    expect(
      resolveDefaultPreset({
        table,
        configured: undefined,
        seed: RESUMED,
        ...knobs('workspace-write', 'ask'),
      }),
    ).toBe('only');
  });
});

describe('目錄', () => {
  it('依宣告順序，每一組帶 value／name／description；沒寫名字就用鍵，沒寫說明就沒有這一格', () => {
    const catalog = buildCatalog(
      {
        a: { sandbox: 'read-only', approval: 'ask', name: '甲', description: '說明' },
        b: { sandbox: 'workspace-write', approval: 'ask' },
      },
      'b',
    );
    expect(catalog.options).toEqual([
      { value: 'a', name: '甲', description: '說明' },
      { value: 'b', name: 'b' },
    ]);
    expect(catalog.defaultOptions).toEqual(catalog.options);
    expect(catalog.defaultPreset).toBe('b');
    expect(Object.hasOwn(catalog.options[1] as object, 'description')).toBe(false);
  });
});

describe('載入', () => {
  const fenced = (
    sandbox = new SandboxModeController('workspace-write'),
    approval = new ApprovalPolicyController('ask'),
  ) =>
    createHostServicesPlugin({
      fsContainment: CONTAINED_FILESYSTEM,
      sandboxPolicy: { controller: sandbox, rootDir: '/workspace' },
      approvalPolicy: approval,
    });

  it('沒有圍堵：什麼都不註冊（沒有命令、沒有投影、沒有目錄服務）', async () => {
    const { registry } = await loadPlugins([createPermissionPresetsPlugin()]);
    expect(registry.commands.find('permission')).toBeUndefined();
    expect(registry.projections.list()).toHaveLength(0);
    expect(registry.services.get(PERMISSION_PRESETS_SERVICE)).toBeUndefined();
  });

  it('有圍堵：註冊 /permission、permissions 投影與目錄服務', async () => {
    const { registry } = await loadPlugins([fenced(), createPermissionPresetsPlugin()]);
    expect(registry.commands.find('permission')).toBeDefined();
    expect(registry.projections.list().map((unit) => unit.key)).toEqual(['permissions']);
    expect(registry.services.use(PERMISSION_PRESETS_SERVICE).catalog().defaultPreset).toBe(
      'workspace-write',
    );
  });

  it('有圍堵卻沒有核准旋鈕：載入失敗，訊息指名服務', async () => {
    const noApproval = createHostServicesPlugin({
      fsContainment: CONTAINED_FILESYSTEM,
      sandboxPolicy: {
        controller: new SandboxModeController('workspace-write'),
        rootDir: '/workspace',
      },
    });
    await expect(loadPlugins([noApproval, createPermissionPresetsPlugin()])).rejects.toThrow(
      'approvalPolicy',
    );
  });

  it('壞設定載入就拋：空表、用了保留字 custom', async () => {
    await expect(
      loadPlugins([fenced(), createPermissionPresetsPlugin({ presets: {} })]),
    ).rejects.toThrow('空的');
    await expect(
      loadPlugins([
        fenced(),
        createPermissionPresetsPlugin({
          presets: { custom: { sandbox: 'read-only', approval: 'ask' } },
          defaultPreset: 'custom',
        }),
      ]),
    ).rejects.toThrow('保留字');
  });
});
