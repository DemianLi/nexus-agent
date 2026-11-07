/**
 * `tools.threadSource`（#2533）的宿主那一側：樹上的函式插件登記一個逐條 thread 的來源，宿主組 thread 時叫它。
 *
 * 量具是暫存目錄裡的函式插件夾具：來源登記一個工具、一位閘門、一格 `admit`、一個 `onDispose`，依設定讀一個宿主服務或在最後拋錯。
 * 出貨清單上還沒有用這一格的插件，所以只能用夾具。走的是產品的路：真的 {@link PluginTree}、真的 `loadPluginConfig`、真的 `loadPlugins`。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHostServicesPlugin, loadPlugins } from '@nexus/core';
import type { InternalPluginRegistry, PluginEntry } from '@nexus/core';
import { MCP_CREDENTIALS_SERVICE } from '@nexus/plugin-mcp';
import { MemorySaver } from '@langchain/langgraph';
import { afterEach, describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { shippedPlugins } from './fixtures.js';

import { loadPluginConfig } from './plugin-config.js';
import { PluginTree } from './plugin-tree.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ThreadServiceGrants } from './thread-service-grants.js';

const temporary: string[] = [];
const trees: PluginTree[] = [];

afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REASON = '故意在 threadSource 裡壞掉';
const HIDDEN = 'hidden-tool';
const CREDENTIALS = { token: 'credentials-for-test' };

let seed = 0;

interface Probe {
  readonly dir: string;
  /** `cordis.yml` 的 `name`。 */
  readonly specifier: string;
  /** 來源記下的事，照發生順序。 */
  log(): readonly ProbeEvent[];
  /** 最後一次交給來源的 `thread`。 */
  lastThread(): {
    register(tool: unknown): unknown;
    section(section: unknown): unknown;
    logger: { warn(message: string): void };
  };
}

type ProbeEvent =
  | { readonly kind: 'source'; readonly row: string; readonly shared: object }
  | { readonly kind: 'read'; readonly value: unknown }
  | { readonly kind: 'dispose'; readonly row: string };

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-thread-source-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

/** 一顆夾具插件。設定：`tool` 工具名、`declare` 宣告的服務、`read` 要讀的服務、`fail` 最後拋錯、`second` 再登記第二個來源（`fail` 是它拋錯）、`section` 登記一段系統提示詞（文字取自 `sectionText`，叫工具就換成 `after`）。 */
function probe(dir: string, file = 'probe.mjs'): Probe {
  seed += 1;
  const key = `__threadSource2533_${String(Date.now())}_${String(seed)}`;
  const module = join(dir, file);
  writeFileSync(
    module,
    `import { z } from 'zod';
export const name = 'probe';
export const inject = { tools: { range: '^2.6.0' } };
export const Config = z.strictObject({
  tool: z.string(),
  declare: z.array(z.string()).optional(),
  read: z.string().optional(),
  fail: z.boolean().optional(),
  second: z.enum(['ok', 'fail']).optional(),
  section: z.boolean().optional(),
});
export const manifest = {
  id: 'probe', version: '1.0.0', owner: 't',
  provides: [], consumes: [{ token: 'tools', range: '^2.6.0' }],
  config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [],
};
export function apply(ctx, config) {
  const log = (globalThis[${JSON.stringify(key)}] ??= { events: [], thread: undefined, sectionText: 'before' });
  ctx.tools.threadSource(async (thread) => {
    log.thread = thread;
    log.events.push({ kind: 'source', row: config.tool, shared: thread.shared });
    if (config.read !== undefined) log.events.push({ kind: 'read', value: thread.services.get(config.read) });
    thread.register({
      name: config.tool,
      description: '夾具的工具',
      parameters: z.toJSONSchema(z.strictObject({}), { io: 'input' }),
      execute: async () => { log.sectionText = 'after'; return { ok: true, content: 'ok' }; },
    });
    thread.gate((_exec, next) => next());
    thread.admit({ admits: (name) => name !== ${JSON.stringify(HIDDEN)} });
    if (config.section === true) thread.section({ name: 'probe:section', order: 2000, text: () => '段：' + log.sectionText });
    thread.onDispose(() => { log.events.push({ kind: 'dispose', row: config.tool }); });
    await Promise.resolve();
    if (config.fail === true) throw new Error(${JSON.stringify(REASON)});
  }, config.declare === undefined ? undefined : { services: config.declare });
  if (config.second !== undefined) {
    ctx.tools.threadSource(async (thread) => {
      thread.onDispose(() => { log.events.push({ kind: 'dispose', row: config.tool + '#2' }); });
      await Promise.resolve();
      if (config.second === 'fail') throw new Error(${JSON.stringify(REASON)});
    });
  }
}
`,
    { mode: 0o600 },
  );
  chmodSync(module, 0o600);
  const state = () =>
    (globalThis as Record<string, unknown>)[key] as
      { events: ProbeEvent[]; thread: ReturnType<Probe['lastThread']> } | undefined;
  return {
    dir,
    specifier: `file://${module}`,
    log: () => state()?.events ?? [],
    lastThread: () => {
      const thread = state()?.thread;
      if (thread === undefined) throw new Error('來源還沒被叫過');
      return thread;
    },
  };
}

interface Row {
  readonly id: string;
  readonly specifier: string;
  readonly config: Record<string, unknown>;
}

function shippedOf(dir: string, rows: readonly Row[]): string {
  const path = join(dir, 'cordis.yml');
  const text = rows
    .map(
      (row) =>
        `- id: ${row.id}\n  name: '${row.specifier}'\n  config: ${JSON.stringify(row.config)}\n`,
    )
    .join('');
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** 讀清單（有樹或沒有樹），交回折進 thread 的條目與讀清單時掉的列。 */
async function compose(
  dir: string,
  rows: readonly Row[],
  options: { readonly grants?: ThreadServiceGrants; readonly detached?: boolean } = {},
) {
  const shipped = shippedOf(dir, rows);
  let tree: PluginTree | undefined;
  if (options.detached !== true) {
    tree = new PluginTree(
      options.grants === undefined ? {} : { threadServiceGrants: options.grants },
    );
    trees.push(tree);
  }
  const loaded = await loadPluginConfig(
    { shipped, overlays: [], warn: () => {} },
    tree === undefined ? {} : { tree },
  );
  const host = createHostServicesPlugin({ [MCP_CREDENTIALS_SERVICE]: CREDENTIALS as never });
  const plugins: PluginEntry[] = [host, ...loaded.plugins];
  return { loaded, plugins };
}

/** 叫 `admit` 那一格的 middleware 一次，交回往內交的請求。 */
function throughAdmit(registry: InternalPluginRegistry, name: string, tools: readonly unknown[]) {
  const found = registry.middleware.list().find((entry) => entry.value.middleware?.name === name);
  if (found === undefined) throw new Error(`沒有 ${name} 這一格`);
  const wrap = found.value.middleware?.wrapModelCall as unknown as (
    request: { tools: readonly unknown[] },
    handler: (request: unknown) => unknown,
  ) => unknown;
  const request = { tools };
  let seen: unknown;
  wrap(request, (next) => {
    seen = next;
    return undefined;
  });
  return { request, seen: seen as { tools: readonly unknown[] } };
}

describe('tools.threadSource', () => {
  it.each([
    ['有樹', false],
    ['沒有樹', true],
  ] as const)(
    '%s：來源走一遍 register、gate、admit、onDispose',
    async (_label, detached) => {
      const dir = scratch();
      const p = probe(dir);
      const { loaded, plugins } = await compose(
        dir,
        [{ id: 'probe', specifier: p.specifier, config: { tool: 'probe-tool' } }],
        { detached },
      );
      expect(loaded.dropped).toEqual([]);
      const result = await loadPlugins(plugins);
      const registry = result.registry;

      expect(registry.tools.resolve('probe-tool')?.origin.id).toBe('probe');
      expect(registry.approvals.listeners().map((entry) => entry.origin.id)).toEqual(['probe']);

      // 一個名字都沒拿掉：請求原樣往內交。拿掉了：換成放行的那幾個。
      const kept = throughAdmit(registry, 'probe:admit:1', [{ name: 'a' }, { name: 'b' }]);
      expect(kept.seen).toBe(kept.request);
      const hidden = throughAdmit(registry, 'probe:admit:1', [{ name: 'a' }, { name: HIDDEN }]);
      expect(hidden.seen.tools).toEqual([{ name: 'a' }]);

      expect(() => p.lastThread().register({})).toThrow(/已經 resolve/);
      expect(() => p.lastThread().section({ name: 'late', order: 2000, text: '' })).toThrow(
        /已經 resolve/,
      );
      expect(() => p.lastThread().logger.warn('之後的警告')).not.toThrow();

      expect(p.log().filter((event) => event.kind === 'dispose')).toEqual([]);
      await result.dispose();
      expect(p.log().filter((event) => event.kind === 'dispose')).toEqual([
        { kind: 'dispose', row: 'probe-tool' },
      ]);
    },
    60000,
  );

  it('沒宣告就讀 MCP_CREDENTIALS_SERVICE：被拒，整次組裝失敗', async () => {
    const dir = scratch();
    const p = probe(dir);
    const { plugins } = await compose(dir, [
      {
        id: 'probe',
        specifier: p.specifier,
        config: { tool: 'probe-tool', read: MCP_CREDENTIALS_SERVICE },
      },
    ]);
    await expect(loadPlugins(plugins)).rejects.toThrow(
      `沒有在 tools.threadSource() 宣告要讀宿主服務 ${MCP_CREDENTIALS_SERVICE}`,
    );
    expect(p.log().some((event) => event.kind === 'read')).toBe(false);
  }, 60000);

  it.each([
    ['有樹', false],
    ['沒有樹', true],
  ] as const)(
    '%s：宣告了授權表上沒給這顆插件的服務，登記當下就拋，那一列起不來',
    async (_label, detached) => {
      const dir = scratch();
      const p = probe(dir);
      const rows = [
        {
          id: 'probe',
          specifier: p.specifier,
          config: { tool: 'probe-tool', declare: [MCP_CREDENTIALS_SERVICE] },
        },
      ];
      const message = `宣告要讀的宿主服務 ${MCP_CREDENTIALS_SERVICE} 沒有授權給這顆插件`;
      if (detached) {
        const { plugins } = await compose(dir, rows, { detached });
        await expect(loadPlugins(plugins)).rejects.toThrow(message);
      } else {
        const { loaded } = await compose(dir, rows);
        expect(loaded.dropped.map(({ id, stage }) => ({ id, stage }))).toEqual([
          { id: 'probe', stage: 'apply' },
        ]);
        expect(loaded.dropped[0]?.message).toContain(message);
      }
      expect(p.log()).toEqual([]);
    },
    60000,
  );

  it('宣告了、授權表也給了：讀得到宿主服務', async () => {
    const dir = scratch();
    const p = probe(dir);
    const { loaded, plugins } = await compose(
      dir,
      [
        {
          id: 'probe',
          specifier: p.specifier,
          config: {
            tool: 'probe-tool',
            declare: [MCP_CREDENTIALS_SERVICE],
            read: MCP_CREDENTIALS_SERVICE,
          },
        },
      ],
      { grants: new Map([[p.specifier, [MCP_CREDENTIALS_SERVICE]]]) },
    );
    expect(loaded.dropped).toEqual([]);
    await (await loadPlugins(plugins)).dispose();
    expect(p.log().filter((event) => event.kind === 'read')).toEqual([
      { kind: 'read', value: CREDENTIALS },
    ]);
  }, 60000);

  it('shared：同一顆插件的兩列拿到同一份，不同插件拿到不同份，下一條 thread 是新的一份', async () => {
    const dir = scratch();
    const first = probe(dir, 'first.mjs');
    const second = probe(dir, 'second.mjs');
    const { plugins } = await compose(dir, [
      { id: 'a1', specifier: first.specifier, config: { tool: 'a1-tool' } },
      { id: 'a2', specifier: first.specifier, config: { tool: 'a2-tool' } },
      { id: 'b1', specifier: second.specifier, config: { tool: 'b1-tool' } },
    ]);
    const thread1 = await loadPlugins(plugins);
    const thread2 = await loadPlugins(plugins);
    const sharedOf = (p: Probe, row: string) =>
      p
        .log()
        .filter(
          (event): event is Extract<ProbeEvent, { kind: 'source' }> =>
            event.kind === 'source' && event.row === row,
        )
        .map((event) => event.shared);
    const [a1First, a1Second] = sharedOf(first, 'a1-tool');
    const [a2First] = sharedOf(first, 'a2-tool');
    const [b1First] = sharedOf(second, 'b1-tool');
    expect(a1First).toBe(a2First);
    expect(a1First).not.toBe(b1First);
    expect(a1First).not.toBe(a1Second);
    await thread1.dispose();
    await thread2.dispose();
  }, 60000);

  it('來源 reject：預設模式整次組裝失敗、訊息同相容層那一列的 apply 拋錯；已登記的 onDispose 先跑完、只跑一次', async () => {
    const dir = scratch();
    const p = probe(dir);
    const { plugins } = await compose(dir, [
      { id: 'probe', specifier: p.specifier, config: { tool: 'probe-tool', fail: true } },
    ]);
    await expect(loadPlugins(plugins)).rejects.toThrow(
      `probe (probe) 的 apply 失敗，它註冊的東西已全數撤銷 — ${REASON}`,
    );
    expect(p.log().filter((event) => event.kind === 'dispose')).toEqual([
      { kind: 'dispose', row: 'probe-tool' },
    ]);
  }, 60000);

  it('同一列兩個來源、第二個 reject：第一個已 resolve 的 onDispose 也跑，兩個各一次、反序', async () => {
    const dir = scratch();
    const p = probe(dir);
    const { plugins } = await compose(dir, [
      { id: 'probe', specifier: p.specifier, config: { tool: 'probe-tool', second: 'fail' } },
    ]);
    await expect(loadPlugins(plugins)).rejects.toThrow(REASON);
    expect(p.log().filter((event) => event.kind === 'dispose')).toEqual([
      { kind: 'dispose', row: 'probe-tool#2' },
      { kind: 'dispose', row: 'probe-tool' },
    ]);
  }, 60000);

  it('同一列兩個來源都 resolve：thread 收掉時兩個的 onDispose 反序各跑一次', async () => {
    const dir = scratch();
    const p = probe(dir);
    const { plugins } = await compose(dir, [
      { id: 'probe', specifier: p.specifier, config: { tool: 'probe-tool', second: 'ok' } },
    ]);
    const result = await loadPlugins(plugins);
    expect(p.log().filter((event) => event.kind === 'dispose')).toEqual([]);
    await result.dispose();
    expect(p.log().filter((event) => event.kind === 'dispose')).toEqual([
      { kind: 'dispose', row: 'probe-tool#2' },
      { kind: 'dispose', row: 'probe-tool' },
    ]);
  }, 60000);

  it('來源 reject：逐列掉模式只掉那一列，登記撤掉、別列照樣掛著', async () => {
    const dir = scratch();
    const bad = probe(dir, 'bad.mjs');
    const good = probe(dir, 'good.mjs');
    const { plugins } = await compose(dir, [
      {
        id: 'bad',
        specifier: bad.specifier,
        config: { tool: 'bad-tool', fail: true, section: true },
      },
      { id: 'good', specifier: good.specifier, config: { tool: 'good-tool' } },
    ]);
    const result = await loadPlugins(plugins, undefined, { perEntry: true });
    expect(result.dropped.map(({ origin, stage }) => ({ id: origin.id, stage }))).toEqual([
      { id: 'bad', stage: 'apply' },
    ]);
    expect(result.dropped[0]?.message).toContain(REASON);
    expect(result.registry.tools.resolve('bad-tool')).toBeUndefined();
    expect(
      result.registry.middleware
        .list()
        .some((entry) => entry.value.middleware?.name === 'bad:admit:1'),
    ).toBe(false);
    expect(result.registry.prompt.sections().map((section) => section.name)).not.toContain(
      'probe:section',
    );
    expect(result.registry.tools.resolve('good-tool')?.origin.id).toBe('good');
    expect(bad.log().filter((event) => event.kind === 'dispose')).toHaveLength(1);
    await result.dispose();
    expect(bad.log().filter((event) => event.kind === 'dispose')).toHaveLength(1);
    expect(good.log().filter((event) => event.kind === 'dispose')).toHaveLength(1);
  }, 60000);
  it('section：同一條 thread 兩次模型呼叫之間文字變了，系統提示詞裡那一段跟著變', async () => {
    const dir = scratch();
    const p = probe(dir);
    const { loaded } = await compose(
      dir,
      [{ id: 'probe', specifier: p.specifier, config: { tool: 'probe-tool', section: true } }],
      { detached: true },
    );
    const model = new ScriptedChatModel({
      turns: [
        { content: '叫工具。', toolCalls: [{ name: 'probe-tool', args: {} }] },
        { content: '收工。' },
      ],
    });
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [...(await shippedPlugins()), ...loaded.plugins],
    });
    try {
      await (
        built.agent as unknown as {
          invoke: (input: unknown, config: unknown) => Promise<unknown>;
        }
      ).invoke(
        { messages: [{ role: 'user', content: '開工' }] },
        { configurable: { thread_id: 'thread-section' }, recursionLimit: 20 },
      );
      const systems = model.prompts.map(
        (prompt) => prompt.find((message) => message.getType() === 'system')?.text ?? '',
      );
      expect(systems).toHaveLength(2);
      expect(systems[0]).toContain('段：before');
      expect(systems[0]).not.toContain('段：after');
      expect(systems[1]).toContain('段：after');
      expect(systems[1]).not.toContain('段：before');
    } finally {
      await built.dispose();
    }
  }, 60000);

  it('section：同一條 thread 上兩列登記同名的段，整次組裝失敗', async () => {
    const dir = scratch();
    const p = probe(dir);
    const { plugins } = await compose(dir, [
      { id: 'a', specifier: p.specifier, config: { tool: 'a-tool', section: true } },
      { id: 'b', specifier: p.specifier, config: { tool: 'b-tool', section: true } },
    ]);
    await expect(loadPlugins(plugins)).rejects.toThrow(/"probe:section" 已經登記過了/);
  }, 60000);
});
