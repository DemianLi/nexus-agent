/**
 * 權限組合（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）在**產品組裝**上的驗收：起始值怎麼來、
 * `/permission` 切得動兩顆旋鈕並留下痕跡、續接不被重新套預設、該起不來的時候起不來、wire 的目錄送得出去。
 *
 * 元件本身的行為（組合表、推導、折疊）在 `@nexus/plugin-permission-presets` 的測試裡；這一份只問「接在產品上之後」：
 * 手搭一個 plugin 去驗，驗不到 `--sandbox`、續接與必掛名單那幾條線有沒有接上。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import type { SessionEvent } from '@nexus/core';
import { createWireClient, PERMISSIONS_PROJECTION_KEY } from '@nexus/wire';
import { createDeepAgent, StateBackend } from 'deepagents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import {
  emptyCommandPoint,
  loopbackRequest,
  noSessions,
  shippedPlugins,
  TEST_BROWSER_AUTH,
} from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const shipped = await shippedPlugins();

const noSteer = (): void => undefined;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-permission-presets-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 一份日誌上某一種事件的 data，依序。 */
function dataOf(events: readonly SessionEvent[], type: string): unknown[] {
  return events.filter((event) => event.type === type).map((event) => event.data);
}

/** 把 `permissions` 投影折一遍，回目前那一組。 */
function currentPreset(
  projections: { list(): readonly { key: string }[] },
  events: readonly SessionEvent[],
): unknown {
  const unit = projections
    .list()
    .find((candidate) => candidate.key === PERMISSIONS_PROJECTION_KEY) as
    | {
        init(): unknown;
        apply(state: unknown, event: SessionEvent): unknown;
        view(state: unknown): { currentValue: string };
      }
    | undefined;
  if (unit === undefined) return undefined;
  return unit.view(events.reduce((state, event) => unit.apply(state, event), unit.init()))
    .currentValue;
}

/** 把出貨清單上 `permission-presets` 那一列的設定換掉。 */
function withPresetsConfig(config: object) {
  return shipped.map((entry) => (entry.id === 'permission-presets' ? { ...entry, config } : entry));
}

describe('新會話的起始組合由 --sandbox 推', () => {
  it.each([
    [undefined, 'ask', 'workspace-write'],
    ['workspace-write', 'ask', 'workspace-write'],
    ['read-only', 'ask', 'read-only'],
    // **行為改變**：以前 `--sandbox danger-full-access` 只放寬檔案、核准照舊會問；現在連核准也是 `never`。
    ['danger-full-access', 'never', 'danger-full-access'],
  ] as const)(
    '--sandbox %s → 核准 %s、組合 %s，三顆事件都釘進日誌',
    async (sandbox, approval, preset) => {
      const built = await createCliAgent(
        { live: false, workspace: root, ...(sandbox !== undefined && { sandbox }) },
        shipped,
        root,
      );
      const detach = built.attachSession(built.sessions);
      try {
        expect(dataOf(built.sessionLog.events, 'approval/policy')).toEqual([{ policy: approval }]);
        expect(dataOf(built.sessionLog.events, 'permission/preset')).toEqual([{ preset }]);
        expect(currentPreset(built.projections, built.sessionLog.events)).toBe(preset);
      } finally {
        detach();
        await built.dispose();
      }
    },
  );
});

describe('`/permission` 是切換的唯一入口', () => {
  it('切到全開：兩顆旋鈕各記一顆、意圖先記，投影跟著換；再切回去也一樣', async () => {
    const built = await createCliAgent({ live: false, workspace: root }, shipped, root);
    const detach = built.attachSession(built.sessions);
    const signal = new AbortController().signal;
    const run = async (rawInput: string) =>
      built.commands.find('permission')?.handler({
        commandId: rawInput,
        rawInput,
        signal,
        sessionLog: built.sessionLog,
        attachments: [],
        steer: noSteer,
      });
    try {
      const before = built.sessionLog.events.length;
      const switched = await run(' danger-full-access');
      expect(switched?.kind).toBe('success');
      expect(switched?.text).toContain('從 workspace-write 換成 danger-full-access');
      expect(switched?.text).not.toContain('沒有完整記進');
      // 順序：先記意圖，再動旋鈕（dsh `apply`）。
      expect(built.sessionLog.events.slice(before).map((event) => event.type)).toEqual([
        'permission/preset',
        'sandbox/mode',
        'approval/policy',
      ]);
      expect(currentPreset(built.projections, built.sessionLog.events)).toBe('danger-full-access');

      const after = built.sessionLog.events.length;
      const back = await run('workspace-write');
      expect(back?.text).toContain('從 danger-full-access 換成 workspace-write');
      expect(dataOf(built.sessionLog.events.slice(after), 'sandbox/mode')).toEqual([
        { mode: 'workspace-write' },
      ]);
      expect(dataOf(built.sessionLog.events.slice(after), 'approval/policy')).toEqual([
        { policy: 'ask' },
      ]);
      expect(currentPreset(built.projections, built.sessionLog.events)).toBe('workspace-write');
    } finally {
      detach();
      await built.dispose();
    }
  });

  it('只動真的不同的那顆旋鈕：workspace-write → read-only 核准不動，沒有多餘的 approval/policy', async () => {
    const built = await createCliAgent({ live: false, workspace: root }, shipped, root);
    const detach = built.attachSession(built.sessions);
    try {
      const before = built.sessionLog.events.length;
      await built.commands.find('permission')?.handler({
        commandId: 'c',
        rawInput: 'read-only',
        signal: new AbortController().signal,
        sessionLog: built.sessionLog,
        attachments: [],
        steer: noSteer,
      });
      const added = built.sessionLog.events.slice(before).map((event) => event.type);
      expect(added).toEqual(['permission/preset', 'sandbox/mode']);
    } finally {
      detach();
      await built.dispose();
    }
  });

  it('不認得的名字、`custom` 都被拒絕，旋鈕不動；沒有 `/sandbox`', async () => {
    const built = await createCliAgent({ live: false, workspace: root }, shipped, root);
    const detach = built.attachSession(built.sessions);
    try {
      const before = built.sessionLog.events.length;
      for (const rawInput of ['bogus', 'custom']) {
        const result = await built.commands.find('permission')?.handler({
          commandId: rawInput,
          rawInput,
          signal: new AbortController().signal,
          sessionLog: built.sessionLog,
          attachments: [],
          steer: noSteer,
        });
        expect(result?.kind).toBe('error');
      }
      expect(built.sessionLog.events).toHaveLength(before);
      expect(built.commands.find('sandbox')).toBeUndefined();
    } finally {
      detach();
      await built.dispose();
    }
  });
});

describe('續接不重新套預設', () => {
  it('日誌記著全開沙箱、沒記核准（#437 以前的日誌）：核准照 `ask` 起算，不被推成 `never`', async () => {
    // 兩條產品路徑的續接把 `approvalPolicy` 給滿（記著的，沒記就 `ask`）；這裡照那個形狀呼叫。
    const built = await createCliAgent(
      { live: false, workspace: root, sandbox: 'danger-full-access', approvalPolicy: 'ask' },
      shipped,
      root,
    );
    const detach = built.attachSession(built.sessions);
    try {
      // 全開沙箱配 `ask` 對不上任何一組，續接保留日誌裡的值：顯示 `custom`，也**沒有**起不來。
      expect(currentPreset(built.projections, built.sessionLog.events)).toBe('custom');
      expect(dataOf(built.sessionLog.events, 'approval/policy')).toEqual([{ policy: 'ask' }]);
      // custom 不是切換目標，也不釘進日誌。
      expect(dataOf(built.sessionLog.events, 'permission/preset')).toEqual([]);
    } finally {
      detach();
      await built.dispose();
    }
  });
});

describe('該起不來的時候起不來', () => {
  it.each(['disabled', 'absent'] as const)(
    '有 --workspace 而 permission-presets 那一列%s：起不來，訊息指名是哪一列',
    async (mode) => {
      const plugins =
        mode === 'disabled'
          ? shipped.map((entry) =>
              entry.id === 'permission-presets' ? { ...entry, disabled: true as const } : entry,
            )
          : shipped.filter((entry) => entry.id !== 'permission-presets');
      await expect(createCliAgent({ live: false, workspace: root }, plugins, root)).rejects.toThrow(
        'permission-presets',
      );
    },
  );

  it('沒有 --workspace：整列不註冊任何東西，起得來，也沒有 `permissions` 投影', async () => {
    const built = await createCliAgent({ live: false }, shipped, root);
    try {
      expect(built.commands.find('permission')).toBeUndefined();
      expect(built.permissionPresets).toBeUndefined();
      expect(built.projections.list().some((unit) => unit.key === PERMISSIONS_PROJECTION_KEY)).toBe(
        false,
      );
    } finally {
      await built.dispose();
    }
  });

  it('`defaultPreset` 與明確給的 --sandbox 矛盾：起不來，不悄悄讓其中一個蓋掉另一個', async () => {
    await expect(
      createCliAgent(
        { live: false, workspace: root, sandbox: 'danger-full-access' },
        withPresetsConfig({ defaultPreset: 'read-only' }),
        root,
      ),
    ).rejects.toThrow('互相矛盾');
  });

  it('表被改成對不上起始值、又沒設 defaultPreset：新會話起不來', async () => {
    await expect(
      createCliAgent(
        { live: false, workspace: root },
        withPresetsConfig({
          presets: { 'read-only': { sandbox: 'read-only', approval: 'ask' } },
        }),
        root,
      ),
    ).rejects.toThrow('對不上組合表裡任何一組');
  });

  it('`defaultPreset` 套在沒給 --sandbox 的新會話：兩顆旋鈕都被設到那一組', async () => {
    const built = await createCliAgent(
      { live: false, workspace: root },
      withPresetsConfig({ defaultPreset: 'read-only' }),
      root,
    );
    const detach = built.attachSession(built.sessions);
    try {
      expect(dataOf(built.sessionLog.events, 'sandbox/mode')).toEqual([{ mode: 'read-only' }]);
      expect(currentPreset(built.projections, built.sessionLog.events)).toBe('read-only');
    } finally {
      detach();
      await built.dispose();
    }
  });
});

describe('wire 的 permission.catalog', () => {
  /** 一個把 `permissionPresets` 交給 wire 的最小組裝：目錄從產品組裝來。 */
  async function connect() {
    const built = await createCliAgent({ live: false, workspace: root }, shipped, root);
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => ({
        agent: createDeepAgent({
          model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
          backend: new StateBackend(),
          checkpointer: new MemorySaver(),
        }) as unknown as PumpAgent,
        attachSessions: noSessions,
        commands: emptyCommandPoint(),
        dispose: async () => undefined,
        ...(built.permissionPresets !== undefined && {
          permissionPresets: built.permissionPresets,
        }),
      }),
    });
    const client = createWireClient({
      baseUrl: 'http://wire.test',
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    return { built, handler, client };
  }

  it('送出出廠三組，依宣告順序，預設組是 workspace-write', async () => {
    const { built, handler, client } = await connect();
    try {
      const outcome = await client.permissionCatalog('t');
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      const { catalog } = outcome.result.value;
      expect(catalog.options.map((option) => option.value)).toEqual([
        'read-only',
        'workspace-write',
        'danger-full-access',
      ]);
      expect(catalog.defaultPreset).toBe('workspace-write');
      expect(catalog.defaultOptions).toEqual(catalog.options);
      // 每一組都有畫面上的名字與說明；`custom` 不在目錄裡（不是切換目標）。
      for (const option of catalog.options) {
        expect(option.name).not.toBe('');
        expect(option.description).toBeDefined();
      }
      expect(catalog.options.map((option) => option.value)).not.toContain('custom');
    } finally {
      await handler.close();
      await built.dispose();
    }
  });
});
