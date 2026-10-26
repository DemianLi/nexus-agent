/**
 * plugin 本身：預設組怎麼決定、目錄長什麼樣、掛在真的 Loader 上之後註冊了什麼、會話參與者與 `/permission` 對日誌做了什麼。
 * 組裝在產品上的行為（`--sandbox`、續接、必掛名單、wire）在 `apps/harness/src/permission-presets.test.ts`；掛上樹之後的接縫
 * （參與者折進 thread 的位置、冷復活、逐條 thread）在 `apps/harness/src/permission-presets-on-tree.test.ts`。
 *
 * **測試檔不受 SDK lint 管**（`PLUGIN_LINT_IGNORES`），所以這裡可以 import `@nexus/core` 造日誌與跑參與者；`src/index.ts` 不行。
 */

import { createCommandsProvider } from '@nexus/commands/provider';
import { createSessionRunner, SessionLog, SessionRegistry } from '@nexus/core';
import type { FsService, SessionAddress } from '@nexus/core';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { createFsLookupProvider } from '@nexus/fs/provider';
import {
  PERMISSION_PRESETS_CONTRACT_VERSION,
  permissionPresetsToken,
} from '@nexus/permission-presets';
import type { PermissionPresetsService, PermissionSeed } from '@nexus/permission-presets';
import { createProjectionsProvider } from '@nexus/projections/provider';
import { checkConformance, checkSharedAcrossThreads } from '@nexus/sdk';
import type { ThreadStep } from '@nexus/sdk';
import { createSessionLookupProvider } from '@nexus/session/provider';
import { afterEach, describe, expect, it } from 'vitest';

import * as permissionPresets from './index.js';
import { buildCatalog, isSandboxWider, narrowingOf, startPresets } from './index.js';
import { DEFAULT_PRESETS } from './presets.js';
import type { PresetTable } from './presets.js';

const FRESH: PermissionSeed = { fresh: true, sandboxExplicit: false };
const RESUMED: PermissionSeed = { fresh: false, sandboxExplicit: false };

/** 部署方用 patch 加回全開之後的表（#1621：出廠不給）。值照 dsh base 出廠的第三組。 */
const WITH_FULL_ACCESS: PresetTable = {
  ...DEFAULT_PRESETS,
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
};

describe('startPresets：預設組怎麼決定、兩顆旋鈕接日誌之前該有什麼值', () => {
  it('沒設 defaultPreset：由起始的兩顆值推；值原樣', () => {
    const started = startPresets(DEFAULT_PRESETS, undefined, {
      seed: FRESH,
      sandbox: 'read-only',
      approval: 'ask',
    });
    expect([started.sandbox, started.approval]).toEqual(['read-only', 'ask']);
    expect(started.catalog.defaultPreset).toBe('read-only');
  });

  it('設了 defaultPreset 的新會話：兩顆旋鈕都設到那一組', () => {
    const started = startPresets(WITH_FULL_ACCESS, 'danger-full-access', {
      seed: FRESH,
      sandbox: 'workspace-write',
      approval: 'ask',
    });
    expect([started.sandbox, started.approval]).toEqual(['danger-full-access', 'never']);
    expect(started.catalog.defaultPreset).toBe('danger-full-access');
  });

  it('續接不套 defaultPreset：保留日誌裡的值，目錄的預設組仍是設定的那一組', () => {
    const started = startPresets(WITH_FULL_ACCESS, 'danger-full-access', {
      seed: RESUMED,
      sandbox: 'read-only',
      approval: 'ask',
    });
    expect([started.sandbox, started.approval]).toEqual(['read-only', 'ask']);
    expect(started.catalog.defaultPreset).toBe('danger-full-access');
  });

  it('defaultPreset 與明確給的 --sandbox 矛盾：報錯；沒明確給就以 defaultPreset 為準；同一組不矛盾', () => {
    const explicit: PermissionSeed = { fresh: true, sandboxExplicit: true };
    expect(() =>
      startPresets(DEFAULT_PRESETS, 'read-only', {
        seed: explicit,
        sandbox: 'danger-full-access',
        approval: 'never',
      }),
    ).toThrow('互相矛盾');
    expect(
      startPresets(DEFAULT_PRESETS, 'read-only', {
        seed: explicit,
        sandbox: 'read-only',
        approval: 'ask',
      }).catalog.defaultPreset,
    ).toBe('read-only');
    const implicit = startPresets(DEFAULT_PRESETS, 'read-only', {
      seed: FRESH,
      sandbox: 'workspace-write',
      approval: 'ask',
    });
    expect([implicit.sandbox, implicit.approval]).toEqual(['read-only', 'ask']);
  });

  it('起始值對不上任何一組又沒設 defaultPreset：新會話報錯，續接放行（拿表裡第一組當目錄預設）', () => {
    const table = { only: { sandbox: 'read-only', approval: 'ask' } } as const;
    expect(() =>
      startPresets(table, undefined, { seed: FRESH, sandbox: 'workspace-write', approval: 'ask' }),
    ).toThrow('對不上組合表裡任何一組');
    const resumed = startPresets(table, undefined, {
      seed: RESUMED,
      sandbox: 'workspace-write',
      approval: 'ask',
    });
    expect(resumed.catalog.defaultPreset).toBe('only');
    // 比表裡唯一一組寬：續接會收回到它（#1621 第 2 步）。
    expect(resumed.narrowed?.preset).toBe('only');
  });

  it('不改傳進來的值：回傳的是新物件，呼叫端自己決定要不要切旋鈕', () => {
    const request = { seed: FRESH, sandbox: 'workspace-write', approval: 'ask' } as const;
    const started = startPresets(WITH_FULL_ACCESS, 'danger-full-access', request);
    expect(request.sandbox).toBe('workspace-write');
    expect(started.sandbox).toBe('danger-full-access');
  });
});

describe('narrowingOf：續接時要不要收回、收到哪一組（#1621 第 2 步）', () => {
  const full = { sandbox: 'danger-full-access', approval: 'never' } as const;

  it('比表裡每一組都寬：收到沙箱最寬的那一組（出廠表就是 workspace-write），帶來源與目標兩顆旋鈕', () => {
    expect(narrowingOf(DEFAULT_PRESETS, undefined, full)).toEqual({
      preset: 'workspace-write',
      fromSandbox: 'danger-full-access',
      fromApproval: 'never',
      toSandbox: 'workspace-write',
      toApproval: 'ask',
    });
  });

  it('設了 defaultPreset：收到那一組，不是最寬的', () => {
    expect(narrowingOf(DEFAULT_PRESETS, 'read-only', full)?.preset).toBe('read-only');
  });

  it('表裡有全開（部署方加回）：不比每一組都寬，不收', () => {
    expect(narrowingOf(WITH_FULL_ACCESS, undefined, full)).toBeUndefined();
  });

  it('比最寬那一組窄（read-only 從表裡刪掉、停在 read-only）：不收——收成 workspace-write 就是放寬', () => {
    const table = { 'workspace-write': DEFAULT_PRESETS['workspace-write'] } as PresetTable;
    expect(
      narrowingOf(table, undefined, { sandbox: 'read-only', approval: 'ask' }),
    ).toBeUndefined();
  });

  it('同寬不收：停在 workspace-write 的一般日誌', () => {
    expect(
      narrowingOf(DEFAULT_PRESETS, undefined, { sandbox: 'workspace-write', approval: 'ask' }),
    ).toBeUndefined();
  });

  it('同寬的幾組取先宣告的', () => {
    const table: PresetTable = {
      first: { sandbox: 'workspace-write', approval: 'never' },
      second: { sandbox: 'workspace-write', approval: 'ask' },
    };
    expect(narrowingOf(table, undefined, full)?.preset).toBe('first');
  });

  it('續接進 startPresets：回的 sandbox／approval 仍是日誌原值，收回的描述放在 narrowed', () => {
    const started = startPresets(DEFAULT_PRESETS, undefined, {
      seed: RESUMED,
      ...full,
    });
    expect([started.sandbox, started.approval]).toEqual(['danger-full-access', 'never']);
    expect(started.narrowed?.preset).toBe('workspace-write');
    expect(started.catalog.defaultPreset).toBe('workspace-write');
    // 新會話永遠不收：起始值就是要用的值。
    expect(
      startPresets(DEFAULT_PRESETS, 'workspace-write', { seed: FRESH, ...full }).narrowed,
    ).toBeUndefined();
  });

  it('isSandboxWider：嚴格偏序，自己不比自己寬', () => {
    expect(isSandboxWider('danger-full-access', 'workspace-write')).toBe(true);
    expect(isSandboxWider('workspace-write', 'read-only')).toBe(true);
    expect(isSandboxWider('workspace-write', 'workspace-write')).toBe(false);
    expect(isSandboxWider('read-only', 'danger-full-access')).toBe(false);
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

interface Mounted {
  readonly root: Context;
  readonly sessions: ReadonlyMap<string, SessionRegistry>;
  readonly service: PermissionPresetsService | undefined;
  readonly commands: ReturnType<typeof createCommandsProvider>;
  readonly projections: ReturnType<typeof createProjectionsProvider>;
  readonly lookup: ReturnType<typeof createSessionLookupProvider>;
  /** 以某條 thread 的身分打 `/permission <input>`：回命令的結果。 */
  readonly command: (thread: string, input: string) => { kind: string; text: string };
  /** 把已登記的參與者裝到某一份日誌上（宿主折進 thread 的那一步，這裡手動做）。 */
  readonly join: (
    thread: string,
    options?: { address?: SessionAddress; log?: SessionLog },
  ) => () => void;
  /** 那一列起不來時的錯誤訊息；起得來是 `undefined`。 */
  readonly failure: () => Promise<string | undefined>;
}

const opened: Context[] = [];
afterEach(async () => {
  for (const root of opened.splice(0)) await root.fiber.dispose();
});

/**
 * 一把 fs 把手：`workspaceRoot()` 回給定的根（fold 當下才會填的那一格，這裡直接給；`settleFsService` 不對外）。
 * 根給空字串＝這條 thread 沒有圍堵（`hasWorkspace()` 是 false、沒有根）：#1775 落盤關掉的新 thread，行程級有圍堵、這條沒有。
 */
function fsHandleWithRoot(root: string): FsService {
  return {
    backend: () => undefined,
    offWorkspacePrefixes: () => [],
    hasWorkspace: () => root !== '',
    workspaceRoot: () => (root === '' ? undefined : root),
    sharedWorkspacePrefix: () => undefined,
    skillSources: () => [],
  };
}

/**
 * 掛一次：每條 thread 一張註冊表，共用同一份提供者。
 *
 * `workspaceRoot`：`null` = 沒有圍堵（`hasContainment()` 是 false，一條 thread 的把手都不登記）；字串 = 每條 thread 的根都是它；
 * 物件 = 逐條 thread 的根（鍵是 thread id，缺的 thread 沒有登記把手）。#1774 起可寫根是逐條 thread 的，行程級只剩「有沒有圍堵」。
 */
async function mountFor(
  threads: readonly string[],
  config: unknown = {},
  workspaceRoot: string | null | Readonly<Record<string, string>> = '/workspace',
  /** 行程級的 `hasContainment()`；省略＝有根就是有圍堵（`workspaceRoot` 不是 `null`）。 */
  containment: boolean = workspaceRoot !== null,
): Promise<Mounted> {
  const sessions = new Map(threads.map((thread) => [thread, new SessionRegistry(thread)]));
  const commands = createCommandsProvider();
  const projections = createProjectionsProvider();
  const lookup = createSessionLookupProvider(() => ({ kind: 'not-attached' }));
  const rootOf = (thread: string): string | undefined =>
    workspaceRoot === null
      ? undefined
      : typeof workspaceRoot === 'string'
        ? workspaceRoot
        : workspaceRoot[thread];
  const fs = createFsLookupProvider(
    () => ({ kind: 'not-attached' }),
    (thread) => {
      const root = rootOf(thread);
      return root === undefined ? undefined : fsHandleWithRoot(root);
    },
    containment,
  );
  const root = new Context();
  opened.push(root);
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, {
    fs: fs.Provider,
    commands: commands.Provider,
    projections: projections.Provider,
    'session-lookup': lookup.Provider,
    'permission-presets': permissionPresets,
  });
  const create = (options: { id: string; name: string; config?: unknown }) =>
    root.loader.create(options as never, null);
  await create({ id: 'fs', name: 'cordis:fs' });
  await create({ id: 'commands', name: 'cordis:commands' });
  await create({ id: 'projections', name: 'cordis:projections' });
  await create({ id: 'session-lookup', name: 'cordis:session-lookup' });
  await create({ id: 'permission-presets-row', name: 'cordis:permission-presets', config });
  await root.loader.await();
  const service = root.get(permissionPresetsToken.name) as PermissionPresetsService | undefined;
  return {
    root,
    sessions,
    service,
    commands,
    projections,
    lookup,
    command: (thread, input) => {
      const entry = commands.entries().find((item) => item.definition.name === 'permission');
      const log = sessions.get(thread)?.root;
      if (entry === undefined || log === undefined) throw new Error('命令或 thread 不存在');
      return entry.definition.handler({
        commandId: `cmd-${thread}`,
        rawInput: input,
        attachments: [],
        signal: new AbortController().signal,
        sessionLog: log,
        steer: () => undefined,
      }) as { kind: string; text: string };
    },
    join: (thread, options = {}) => {
      const registry = sessions.get(thread);
      if (registry === undefined) throw new Error('thread 不存在');
      return createSessionRunner({
        address: options.address ?? { kind: 'root' },
        log: options.log ?? registry.root,
        rootLog: registry.root,
        installers: lookup.participants().map((entry) => ({
          value: entry.participant,
          origin: { id: entry.source, name: 'permission-presets' },
        })),
      });
    },
    failure: async () => {
      const fiber = root.loader.resolve('permission-presets-row').fiber?.ctx.fiber;
      if (fiber === undefined) return '沒有 fiber';
      return fiber.await().then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    },
  };
}

const kinds = (log: SessionLog, type: string): unknown[] =>
  log.events.filter((event) => event.type === type).map((event) => event.data);

describe('一致性套件：真的提供者、真的 Loader', () => {
  it('permission-presets 全格通過：manifest、匯出形式、載入→卸載後命令／投影／參與者都撤掉、缺提供者停在 PENDING', async () => {
    let latestCommands = createCommandsProvider();
    let latestProjections = createProjectionsProvider();
    let latestLookup = createSessionLookupProvider(() => ({ kind: 'not-attached' }));
    const failures = await checkConformance({
      row: 'permission-presets',
      module: permissionPresets,
      config: {},
      providers: {
        // 有圍堵，插件才真的註冊東西；沒有的話「卸載後撤乾淨」是空話。
        fs: () =>
          createFsLookupProvider(
            () => ({ kind: 'not-attached' }),
            () => undefined,
            true,
          ).Provider,
        commands: () => {
          latestCommands = createCommandsProvider();
          return latestCommands.Provider;
        },
        projections: () => {
          latestProjections = createProjectionsProvider();
          return latestProjections.Provider;
        },
        sessionLookup: () => {
          latestLookup = createSessionLookupProvider(() => ({ kind: 'not-attached' }));
          return latestLookup.Provider;
        },
      },
      residue: () =>
        latestCommands.registrations() +
        latestProjections.registrations() +
        latestLookup.registrations(),
    });
    expect(failures).toEqual([]);
  });

  it('manifest：提供 permissionPresets（1.1.0），消費 fs／commands／projections／sessionLookup；沒有 default 匯出', () => {
    expect(permissionPresets.manifest.provides).toEqual([
      { token: 'permissionPresets', version: PERMISSION_PRESETS_CONTRACT_VERSION },
    ]);
    expect(permissionPresets.manifest.consumes).toEqual([
      { token: 'fs', range: '^2.0.0' },
      { token: 'commands', range: '^1.0.0' },
      { token: 'projections', range: '^1.0.0' },
      { token: 'sessionLookup', range: '^1.1.0' },
    ]);
    expect(permissionPresets.name).toBe('permission-presets');
    expect('default' in permissionPresets).toBe(false);
  });
});

describe('掛上之後', () => {
  it('沒有圍堵（沒有工作區根）：什麼都不註冊——沒有命令、沒有投影、沒有參與者、沒有目錄服務', async () => {
    const run = await mountFor(['t'], {}, null);
    expect(await run.failure()).toBeUndefined();
    expect(run.service).toBeUndefined();
    expect(run.commands.registrations()).toBe(0);
    expect(run.projections.registrations()).toBe(0);
    expect(run.lookup.registrations()).toBe(0);
  });

  it('有圍堵：註冊 /permission、permissions 投影、一位參與者與 permissionPresets 服務，歸屬是這一列', async () => {
    const run = await mountFor(['t']);
    expect(await run.failure()).toBeUndefined();
    expect(run.commands.entries().map((entry) => [entry.definition.name, entry.source])).toEqual([
      ['permission', 'permission-presets-row'],
    ]);
    expect(run.projections.entries().map((entry) => entry.unit.key)).toEqual(['permissions']);
    expect(run.lookup.participants().map((entry) => entry.source)).toEqual([
      'permission-presets-row',
    ]);
    expect((run.service as { provider?: string } | undefined)?.provider).toBe(
      'permission-presets-row',
    );
    expect(
      run.service?.start({ seed: FRESH, sandbox: 'workspace-write', approval: 'ask' }),
    ).toMatchObject({
      sandbox: 'workspace-write',
      approval: 'ask',
      catalog: { defaultPreset: 'workspace-write' },
    });
  });

  it('壞設定在掛載當下就拋，那一列起不來、什麼都沒註冊：空表、保留字 custom、defaultPreset 不在表裡', async () => {
    const cases: [object, string][] = [
      [{ presets: {} }, '空的'],
      [
        {
          presets: { custom: { sandbox: 'read-only', approval: 'ask' } },
          defaultPreset: 'custom',
        },
        '保留字',
      ],
      [{ defaultPreset: 'nope' }, 'nope'],
    ];
    for (const [config, message] of cases) {
      const run = await mountFor(['t'], config);
      expect(await run.failure()).toContain(message);
      expect(run.service).toBeUndefined();
      expect(run.commands.registrations()).toBe(0);
      expect(run.lookup.registrations()).toBe(0);
    }
  });

  it('narrowDelegated（#1739，1.2.0）：比表裡每一組都寬才收；目標只看表與設定，核准不外送；表裡有全開不收', async () => {
    const shipped = await mountFor(['t']);
    expect(shipped.service?.narrowDelegated('danger-full-access')).toStrictEqual({
      preset: 'workspace-write',
      fromSandbox: 'danger-full-access',
      toSandbox: 'workspace-write',
    });
    expect(shipped.service?.narrowDelegated('workspace-write')).toBeUndefined();
    expect(shipped.service?.narrowDelegated('read-only')).toBeUndefined();
    // 設了 defaultPreset 且它不是最寬的一組：收到它（不是 workspace-write）。
    const readOnlyDefault = await mountFor(['t'], { defaultPreset: 'read-only' });
    expect(readOnlyDefault.service?.narrowDelegated('danger-full-access')).toStrictEqual({
      preset: 'read-only',
      fromSandbox: 'danger-full-access',
      toSandbox: 'read-only',
    });
    // 部署方加回全開：不比每一組都寬，不收。
    const withFull = await mountFor(['t'], WITH_FULL_ACCESS_CONFIG);
    expect(withFull.service?.narrowDelegated('danger-full-access')).toBeUndefined();
  });

  it('設定不同的兩次掛載各算各的表：服務不共用', async () => {
    const small = await mountFor(['t'], {
      presets: { a: { sandbox: 'read-only', approval: 'ask' } },
    });
    const big = await mountFor(['t']);
    expect(
      small.service?.start({ seed: RESUMED, sandbox: 'read-only', approval: 'ask' }).catalog
        .options,
    ).toHaveLength(1);
    expect(
      big.service?.start({ seed: RESUMED, sandbox: 'read-only', approval: 'ask' }).catalog.options,
    ).toHaveLength(2);
  });

  it('提供者那一列卸載之後，宿主手上的服務快照仍可呼叫（方法不碰 this.ctx）', async () => {
    const run = await mountFor(['t']);
    const grabbed = run.service;
    await run.root.loader.resolve('permission-presets-row').fiber?.ctx.fiber.dispose();
    expect(
      grabbed?.start({ seed: FRESH, sandbox: 'read-only', approval: 'ask' }).catalog.defaultPreset,
    ).toBe('read-only');
  });
});

describe('會話參與者', () => {
  it('root 新會話：日誌上已有兩顆旋鈕的起始值（前面的參與者寫的）、還沒有組名 → 釘一顆 permission/preset', async () => {
    const run = await mountFor(['t']);
    const log = run.sessions.get('t')!.root;
    log.append('approval/policy', { policy: 'ask' });
    log.append('sandbox/mode', { mode: 'read-only' });
    run.join('t');
    expect(kinds(log, 'permission/preset')).toEqual([{ preset: 'read-only' }]);
  });

  it('日誌上已經有組名（續接、空轉的重接）：什麼都不寫', async () => {
    const run = await mountFor(['t']);
    const log = run.sessions.get('t')!.root;
    log.append('sandbox/mode', { mode: 'read-only' });
    log.append('approval/policy', { policy: 'ask' });
    log.append('permission/preset', { preset: 'read-only' });
    const before = log.events.length;
    run.join('t');
    expect(log.events).toHaveLength(before);
  });

  it('對不上任何一組（custom）：不釘', async () => {
    const run = await mountFor(['t']);
    const log = run.sessions.get('t')!.root;
    log.append('sandbox/mode', { mode: 'read-only' });
    log.append('approval/policy', { policy: 'never' });
    run.join('t');
    expect(kinds(log, 'permission/preset')).toEqual([]);
  });

  describe('子代理：組名只在父代理是全開時帶下去', () => {
    const subagent: SessionAddress = { kind: 'subagent', runId: 'run-1' };

    async function child(
      options: {
        delegated?: 'read-only' | 'workspace-write' | 'danger-full-access';
        approval?: 'ask' | 'never';
        /** 子代理日誌是不是從上一個行程 seed 回來的（背景子代理冷復活）。 */
        seeded?: boolean;
      } = {},
    ) {
      const run = await mountFor(['t'], WITH_FULL_ACCESS_CONFIG);
      const root = run.sessions.get('t')!.root;
      if (options.approval !== undefined)
        root.append('approval/policy', { policy: options.approval });
      // 子代理日誌：先有上一個行程留下的（seed），再由 sandbox-policy 的參與者在委派當下寫 `source: 'delegation'`（排在前面）。
      const seedLog = new SessionLog('child-first-life');
      if (options.seeded === true && options.delegated !== undefined) {
        seedLog.append('sandbox/mode', { mode: options.delegated, source: 'delegation' });
      }
      const log =
        options.seeded === true
          ? new SessionLog('child', { seed: seedLog.events })
          : new SessionLog('child');
      return { run, root, log };
    }

    it('這一次接上時委派的沙箱是全開、父代理的核准是 never → 寫 permission/preset danger-full-access', async () => {
      const { run, log } = await child({ approval: 'never' });
      // 前面的參與者（sandbox-policy）在委派當下寫的那一顆，在 permission-presets 的參與者之前。
      log.append('sandbox/mode', { mode: 'danger-full-access', source: 'delegation' });
      run.join('t', { address: subagent, log });
      expect(kinds(log, 'permission/preset')).toEqual([{ preset: 'danger-full-access' }]);
    });

    it('委派的沙箱不是全開，或父代理的核准還是 ask（推不出全開那一組）→ 不寫', async () => {
      const notFull = await child({ approval: 'never' });
      notFull.log.append('sandbox/mode', { mode: 'workspace-write', source: 'delegation' });
      notFull.run.join('t', { address: subagent, log: notFull.log });
      expect(kinds(notFull.log, 'permission/preset')).toEqual([]);

      const asks = await child({ approval: 'ask' });
      asks.log.append('sandbox/mode', { mode: 'danger-full-access', source: 'delegation' });
      asks.run.join('t', { address: subagent, log: asks.log });
      expect(kinds(asks.log, 'permission/preset')).toEqual([]);
    });

    it('不在委派裡被開的子代理日誌（沒有 delegation 那一顆）→ 不寫', async () => {
      const { run, log } = await child({ approval: 'never' });
      run.join('t', { address: subagent, log });
      expect(kinds(log, 'permission/preset')).toEqual([]);
    });

    it('冷復活（R2）：seed 裡上一個行程留下的 delegation 事件不算數——這一次接上沒有人重新寫，就不寫', async () => {
      const { run, log } = await child({
        approval: 'never',
        delegated: 'danger-full-access',
        seeded: true,
      });
      // 前提：那一顆舊事件確實在日誌裡，而且在 `session/end-seed` 之前。
      const types = log.events.map((event) => event.type);
      expect(types).toEqual(['sandbox/mode', 'session/end-seed']);
      run.join('t', { address: subagent, log });
      expect(kinds(log, 'permission/preset')).toEqual([]);
    });

    it('冷復活之後又在委派當下重新寫了一顆（end-seed 之後）→ 這一顆算數', async () => {
      const { run, log } = await child({
        approval: 'never',
        delegated: 'workspace-write',
        seeded: true,
      });
      log.append('sandbox/mode', { mode: 'danger-full-access', source: 'delegation' });
      run.join('t', { address: subagent, log });
      expect(kinds(log, 'permission/preset')).toEqual([{ preset: 'danger-full-access' }]);
    });
  });
});

/** 組合表含全開那一組的設定（子代理的測試要推得出 `danger-full-access`）。 */
const WITH_FULL_ACCESS_CONFIG = { presets: WITH_FULL_ACCESS };

describe('/permission', () => {
  /** 一條接好的 thread：旋鈕的起始值與組名都已經在日誌上（前面的參與者與這一位寫的）。 */
  async function ready(
    config: unknown = {},
    start: {
      mode: 'read-only' | 'workspace-write' | 'danger-full-access';
      policy: 'ask' | 'never';
    } = {
      mode: 'workspace-write',
      policy: 'ask',
    },
  ) {
    const run = await mountFor(['t'], config);
    const log = run.sessions.get('t')!.root;
    log.append('approval/policy', { policy: start.policy });
    log.append('sandbox/mode', { mode: start.mode });
    run.join('t');
    return { run, log };
  }

  it('不帶引數：報現況與可寫根，列出切得過去的', async () => {
    const { run } = await ready();
    const result = run.command('t', '');
    expect(result.kind).toBe('success');
    expect(result.text).toBe(
      '目前的權限組合：workspace-write（檔案政策 workspace-write、核准 ask）。\n可寫根 "/workspace"。\n切得過去的：read-only、workspace-write。',
    );
  });

  it('不帶引數報的是這條 thread 的可寫根：A 報 /x、B 報 /y；兩條都在同一個提供者底下（#1774）', async () => {
    const run = await mountFor(['a', 'b'], {}, { a: '/x', b: '/y' });
    for (const thread of ['a', 'b']) {
      const log = run.sessions.get(thread)!.root;
      log.append('approval/policy', { policy: 'ask' });
      log.append('sandbox/mode', { mode: 'workspace-write' });
      run.join(thread);
    }
    expect(run.command('a', '').text).toContain('可寫根 "/x"。');
    expect(run.command('b', '').text).toContain('可寫根 "/y"。');
    expect(run.command('b', '').text).not.toContain('/x');
  });

  it('這條 thread 沒有登記把手：明說查不到，不拿別條 thread 的根充數（fs 是安全邊界，#1482）', async () => {
    const run = await mountFor(['a', 'b'], {}, { a: '/x' });
    const log = run.sessions.get('b')!.root;
    log.append('approval/policy', { policy: 'ask' });
    log.append('sandbox/mode', { mode: 'workspace-write' });
    run.join('b');
    const text = run.command('b', '').text;
    expect(text).toContain('可寫根：查不到這條 thread 的可寫根。');
    expect(text).not.toContain('/x');
  });

  it('有沒有圍堵是行程級：hasContainment() 是 false 就不註冊 /permission，即使有 thread 登記了把手（#1774）', async () => {
    // 真的登記一條 thread 的把手（`a` 有根 `/x`），行程級的 hasContainment() 卻是 false：標題後半句才量得到（#1785 第 3 點）。
    const run = await mountFor(['a'], {}, { a: '/x' }, false);
    expect(run.commands.entries().some((item) => item.definition.name === 'permission')).toBe(
      false,
    );
  });

  it('行程級有圍堵、這條 thread 沒有（#1775 落盤關掉的新 thread）：/permission 不適用，不寫任何事件', async () => {
    const run = await mountFor(['a', 'b'], {}, { a: '/x', b: '' });
    for (const thread of ['a', 'b']) {
      run.sessions.get(thread)!.root.append('approval/policy', { policy: 'ask' });
      run.sessions.get(thread)!.root.append('sandbox/mode', { mode: 'workspace-write' });
      run.join(thread);
    }
    const before = run.sessions.get('b')!.root.events.length;
    for (const input of ['', 'read-only']) {
      const result = run.command('b', input);
      expect(result.kind).toBe('error');
      expect(result.text).toContain('不適用');
    }
    expect(run.sessions.get('b')!.root.events.length).toBe(before);
    // 另一條有圍堵的 thread 照常。
    expect(run.command('a', '').text).toContain('可寫根 "/x"。');
  });

  it('行程級有圍堵、這條 thread 沒有：參與者也不往它的日誌釘或收回 permission/preset（#1775）', async () => {
    const run = await mountFor(['a', 'b'], {}, { a: '/x', b: '' });
    for (const thread of ['a', 'b']) {
      run.sessions.get(thread)!.root.append('approval/policy', { policy: 'ask' });
      run.sessions.get(thread)!.root.append('sandbox/mode', { mode: 'workspace-write' });
      run.sessions.get(thread)!.root.append('sandbox/mode', { mode: 'danger-full-access' });
      run.join(thread);
    }
    // 對照：有圍堵的 a 被收回（出廠表沒有全開）；沒有圍堵的 b 一顆都沒有，日誌只剩上面寫進去的三顆。
    expect(kinds(run.sessions.get('a')!.root, 'permission/preset')).not.toEqual([]);
    expect(kinds(run.sessions.get('b')!.root, 'permission/preset')).toEqual([]);
    expect(run.sessions.get('b')!.root.events).toHaveLength(3);
  });

  it('對不上任何一組：顯示 custom 與兩顆旋鈕的值', async () => {
    const { run } = await ready({}, { mode: 'read-only', policy: 'never' });
    expect(run.command('t', '').text).toContain(
      '目前的權限組合：custom（檔案政策 read-only、核准 never，對不上任何一組）。',
    );
  });

  it('切到不同的一組：先記意圖，再只寫真的不同的那顆旋鈕（核准沒變就不寫）', async () => {
    const { run, log } = await ready();
    const before = log.events.length;
    const result = run.command('t', 'read-only');
    expect(result).toEqual({
      kind: 'success',
      text: '權限組合從 workspace-write 換成 read-only（檔案政策 read-only、核准 ask）。',
    });
    expect(log.events.slice(before).map((event) => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'read-only' }],
      ['sandbox/mode', { mode: 'read-only' }],
    ]);
  });

  it('兩顆都不同：順序是 permission/preset → sandbox/mode → approval/policy', async () => {
    const { run, log } = await ready(WITH_FULL_ACCESS_CONFIG);
    const before = log.events.length;
    run.command('t', 'danger-full-access');
    expect(log.events.slice(before).map((event) => event.type)).toEqual([
      'permission/preset',
      'sandbox/mode',
      'approval/policy',
    ]);
  });

  it('切到同一組：什麼都不寫；不認得的名字（含 custom）：回 error、什麼都不寫', async () => {
    const { run, log } = await ready();
    const before = log.events.length;
    expect(run.command('t', 'workspace-write')).toEqual({
      kind: 'success',
      text: '本來就是 workspace-write，沒有變。',
    });
    expect(run.command('t', 'nope')).toEqual({
      kind: 'error',
      text: '/permission 認不得 "nope"。認得的是 read-only、workspace-write。',
    });
    expect(run.command('t', 'custom').kind).toBe('error');
    expect(log.events).toHaveLength(before);
  });

  it('回覆裡沒有「這次切換沒有完整記進日誌」那句——切換就是寫日誌，沒有「沒接上」這回事（#1491 Q1：拿掉 UNRECORDED_NOTE）', async () => {
    const { run } = await ready();
    expect(run.command('t', 'read-only').text).not.toContain('沒有完整記進');
  });
});

describe('套一次、服務兩條 thread', () => {
  const STEPS: ThreadStep<string>[] = [
    { thread: 'thread-a', input: 'read-only' },
    { thread: 'thread-b', input: '' },
    { thread: 'thread-b', input: 'read-only' },
    { thread: 'thread-a', input: '' },
  ];

  it('共用一份與各自一份相同：每條 thread 的日誌只有自己寫的，現況只看自己的日誌', async () => {
    const failures = await checkSharedAcrossThreads({
      name: 'permission-presets',
      steps: STEPS,
      mount: async (threads) => {
        const run = await mountFor(threads);
        for (const thread of threads) {
          const log = run.sessions.get(thread)!.root;
          log.append('approval/policy', { policy: 'ask' });
          log.append('sandbox/mode', { mode: 'workspace-write' });
          run.join(thread);
        }
        return run;
      },
      call: (run, thread, input) =>
        Promise.resolve({
          answer: run.command(thread, input),
          written: run.sessions.get(thread)!.root.events.map((event) => event.type),
        }),
    });
    expect(failures).toEqual([]);
  });

  it('一條切了、另一條不動', async () => {
    const run = await mountFor(['thread-a', 'thread-b']);
    for (const thread of ['thread-a', 'thread-b']) {
      const log = run.sessions.get(thread)!.root;
      log.append('approval/policy', { policy: 'ask' });
      log.append('sandbox/mode', { mode: 'workspace-write' });
      run.join(thread);
    }
    run.command('thread-a', 'read-only');
    expect(run.command('thread-b', '').text).toContain('目前的權限組合：workspace-write');
    expect(kinds(run.sessions.get('thread-b')!.root, 'sandbox/mode')).toEqual([
      { mode: 'workspace-write' },
    ]);
  });
});
