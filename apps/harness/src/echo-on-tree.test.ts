/**
 * echo 在 Cordis 樹上（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416) PR 2）：驗收 C、D、E、F、H 與並發、
 * 寫回三路徑、`resolveEntryModule` 的判別。量的是產品路徑——真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹）、
 * 真的寫入口 `changePlugin`、真的 `createCliAgent`；不手搭 `ctx.plugin`。
 *
 * 「這一條 thread 有沒有 echo」看的是模型**實際收到**的工具（`ScriptedChatModel.boundTools`），不是清單長什麼樣。
 */

import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { ECHO_TOOL_NAME } from './echo.fixture.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { changePlugin } from './plugin-change.js';
import {
  isBridgeEntry,
  loadDefaultPlugins,
  loadPluginConfig,
  resolveEntryModule,
  shippedConfigPath,
} from './plugin-config.js';
import { journalPathOf, readJournalText } from './plugin-journal.fixture.js';
import type { ScriptedChatModel } from './scripted-model.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-echo-tree-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

function newRoot(): CordisRoot {
  const root = createCordisRoot();
  roots.push(root);
  return root;
}

/** 一條 thread 的組裝：讀清單（帶樹，臨界區）→ 組 agent → 打一輪讓模型綁工具 → 交回綁了什麼。 */
async function openThread(root: CordisRoot, env: NodeJS.ProcessEnv, thread: string) {
  const loaded = await loadDefaultPlugins({ env }, { tree: root.tree });
  const built = await createCliAgent({ live: false }, loaded.plugins);
  await built.agent.invoke(toAgentInvocation('看一下。'), { configurable: { thread_id: thread } });
  const names = (built.model as ScriptedChatModel).boundTools.map(
    (tool) => (tool as { name: string }).name,
  );
  return { loaded, built, names };
}

const rowOf = (loaded: Awaited<ReturnType<typeof loadDefaultPlugins>>, id: string) =>
  loaded.plugins.find((entry) => loaded.rows.get(entry)?.id === id);

describe('D：清單沒變，echo 經樹進來，跟沒上樹之前模型收到的一樣', () => {
  it('出貨清單上的 echo 是橋接列，位置、id、名字都沒變', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env }, { tree: root.tree });
    const echo = rowOf(loaded, 'echo');
    expect(echo).toBeDefined();
    expect(echo !== undefined && isBridgeEntry(echo)).toBe(true);
    expect(echo?.plugin.name).toBe('echo');
    expect(loaded.dropped).toEqual([]);
  });

  it('樹上有 echo 那一列，登記處裡就是它登記的那一個工具', async () => {
    const { env } = home();
    const root = newRoot();
    const thread = await openThread(root, env, 't1');
    expect(thread.names).toContain(ECHO_TOOL_NAME);
    await thread.built.dispose();
    const tree = await root.tree.context();
    const row = tree.loader.resolve('include:echo');
    expect(row.fiber?.ctx.fiber.state).toBe(2);
  });

  it('沒有樹的呼叫端（手搭清單、shippedPlugins）拿到同一個工具，走的是同一條路', async () => {
    const detached = await loadPluginConfig({});
    const built = await createCliAgent({ live: false }, detached.plugins);
    await built.agent.invoke(toAgentInvocation('看一下。'), { configurable: { thread_id: 'd' } });
    const names = (built.model as ScriptedChatModel).boundTools.map(
      (tool) => (tool as { name: string }).name,
    );
    expect(names).toContain(ECHO_TOOL_NAME);
    await built.dispose();
  });

  it('樹與沒有樹，模型收到的工具名單與順序一樣', async () => {
    const { env } = home();
    const root = newRoot();
    const onTree = await openThread(root, env, 'a');
    const detached = await loadPluginConfig({ shippedLayers: [] });
    const built = await createCliAgent({ live: false }, detached.plugins);
    await built.agent.invoke(toAgentInvocation('看一下。'), { configurable: { thread_id: 'b' } });
    const names = (built.model as ScriptedChatModel).boundTools.map(
      (tool) => (tool as { name: string }).name,
    );
    expect(onTree.names).toEqual(names);
    await onTree.built.dispose();
    await built.dispose();
  });
});

describe('E：寫入口停用 echo', () => {
  it('journal 多一行；下一條 thread 沒有 echo；開著的 thread 照樣叫得到；再啟用回來；cordis.yml 沒被寫', async () => {
    const { dir, env } = home();
    const shipped = readFileSync(shippedConfigPath(), 'utf8');
    const root = newRoot();
    const first = await openThread(root, env, 'open');
    expect(first.names).toContain(ECHO_TOOL_NAME);
    const filesBefore = readdirSync(dir).sort();
    const linesBefore = readJournalText(dir).split('\n').filter(Boolean).length;

    await changePlugin({ op: 'disable', id: 'echo' }, { env });
    expect(readJournalText(dir).split('\n').filter(Boolean).length).toBe(linesBefore + 1);

    // 寫入之後**立刻**開的 thread 就看到新值：不靠等待時間的運氣。
    const second = await openThread(root, env, 'after-disable');
    expect(second.names).not.toContain(ECHO_TOOL_NAME);
    // 樹上那一列也卸了。
    const tree = await root.tree.context();
    expect(tree.loader.resolve('include:echo').fiber?.ctx.fiber.state).toBe(4);

    // 開著的那一條：舊工具物件是閉包了設定值的純函式，照樣能跑。
    const echo = (first.built.model as ScriptedChatModel).boundTools.find(
      (tool) => (tool as { name: string }).name === ECHO_TOOL_NAME,
    ) as { invoke(input: unknown): Promise<unknown> } | undefined;
    await expect(echo?.invoke({ message: '嗨' })).resolves.toBe('回聲：嗨');

    await changePlugin({ op: 'enable', id: 'echo' }, { env });
    const third = await openThread(root, env, 'after-enable');
    expect(third.names).toContain(ECHO_TOOL_NAME);

    // 沒有任何檔被 Include 寫：出貨檔一個位元組沒變，home 只多紀錄與快照那一類（沒有 tmp、沒有 cordis.yml 副本）。
    expect(readFileSync(shippedConfigPath(), 'utf8')).toBe(shipped);
    const extra = readdirSync(dir).filter((name) => !filesBefore.includes(name));
    expect(
      extra.every((name) => name === 'plugin-journal.jsonl' || name.startsWith('.plugin-')),
    ).toBe(true);
    expect(readdirSync(dir).some((name) => name.endsWith('.tmp'))).toBe(false);
    await first.built.dispose();
    await second.built.dispose();
    await third.built.dispose();
  }, 60000);
});

describe('F：改前綴', () => {
  it('下一條 thread 是新值，開著的是舊值；寫入之後立刻開的 thread 就是新值', async () => {
    const { env } = home();
    const root = newRoot();
    const first = await openThread(root, env, 'open');
    const call = async (thread: Awaited<ReturnType<typeof openThread>>) => {
      const echo = (thread.built.model as ScriptedChatModel).boundTools.find(
        (tool) => (tool as { name: string }).name === ECHO_TOOL_NAME,
      ) as { invoke(input: unknown): Promise<unknown> };
      return echo.invoke({ message: '嗨' });
    };
    await expect(call(first)).resolves.toBe('回聲：嗨');

    await changePlugin({ op: 'config-set', id: 'echo', config: { prefix: '聽到了' } }, { env });
    const second = await openThread(root, env, 'after');
    await expect(call(second)).resolves.toBe('聽到了：嗨');
    await expect(call(first)).resolves.toBe('回聲：嗨');

    await changePlugin({ op: 'config-reset', id: 'echo' }, { env });
    const third = await openThread(root, env, 'reset');
    await expect(call(third)).resolves.toBe('回聲：嗨');
    for (const thread of [first, second, third]) await thread.built.dispose();
  }, 60000);
});

describe('並發：兩條 thread 同時組裝，中間夾著清單變更', () => {
  it('每一條拿到的 echo 設定，全是舊的或全是新的，沒有一條是半新半舊', async () => {
    const { env } = home();
    const root = newRoot();
    // 先暖一次，讓兩次讀清單都落在同一棵已經收斂的樹上。
    await (await openThread(root, env, 'warm')).built.dispose();

    const prefixOf = async (thread: Awaited<ReturnType<typeof openThread>>) => {
      const echo = (thread.built.model as ScriptedChatModel).boundTools.find(
        (tool) => (tool as { name: string }).name === ECHO_TOOL_NAME,
      ) as { invoke(input: unknown): Promise<string> } | undefined;
      return echo === undefined ? '(沒有 echo)' : echo.invoke({ message: 'x' });
    };

    // 交錯：A 讀清單的同時，寫入口把前綴改了，B 在改了之後讀。兩條各自等 `run` 的臨界區。
    const results = await Promise.all([
      openThread(root, env, 'A'),
      changePlugin({ op: 'config-set', id: 'echo', config: { prefix: '新' } }, { env }),
      openThread(root, env, 'B'),
    ]);
    const [a, , b] = results;
    const seenA = await prefixOf(a);
    const seenB = await prefixOf(b);
    expect(['回聲：x', '新：x']).toContain(seenA);
    expect(['回聲：x', '新：x']).toContain(seenB);
    // 寫入之後再開的 thread 一定是新值。
    const c = await openThread(root, env, 'C');
    await expect(prefixOf(c)).resolves.toBe('新：x');
    for (const thread of [a, b, c]) await thread.built.dispose();
  }, 60000);
});

describe('並發：同時讀不同的清單，每一份拿到的工具跟自己讀到的相符', () => {
  it('N 條各帶不同前綴的清單同時進臨界區，各自取到的工具前綴就是自己清單上的那個', async () => {
    const { dir, env } = home();
    const root = newRoot();
    const prefixes = ['甲', '乙', '丙', '丁', '戊'];
    const overlays = prefixes.map((prefix, index) => {
      const file = join(dir, `overlay-${String(index)}.yml`);
      writeFileSync(file, `- id: echo\n  config:\n    prefix: ${prefix}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      return file;
    });
    const loads = await Promise.all(
      overlays.map((file) =>
        loadDefaultPlugins({ env, patches: [file], warn: () => {} }, { tree: root.tree }),
      ),
    );
    for (const [index, loaded] of loads.entries()) {
      const echo = rowOf(loaded, 'echo');
      const captured: { name: string; invoke(input: unknown): Promise<string> }[] = [];
      await echo?.plugin.apply(
        {
          tools: { register: (tool: never) => captured.push(tool) },
        } as never,
        undefined as never,
      );
      expect(captured.map((tool) => tool.name)).toEqual([ECHO_TOOL_NAME]);
      await expect(captured[0]?.invoke({ message: 'x' })).resolves.toBe(
        `${prefixes[index] ?? ''}：x`,
      );
    }
  }, 60000);
});

describe('H：快照與列分類對 echo 的描述', () => {
  it('樹上的 echo 在快照裡是啟用、掉了的階段不變', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env }, { tree: root.tree });
    const row = loaded.rows.get(rowOf(loaded, 'echo') as never);
    expect(row).toEqual({ id: 'echo', module: '@nexus/plugin-echo' });
    expect(loaded.ids).toContain('echo');
  });
});

describe('寫回三路徑：Include 不寫檔', () => {
  it('停用、改設定、再還原之後，出貨檔位元組不變、home 沒有多出 cordis.yml 或 tmp', async () => {
    const { dir, env } = home();
    const shippedBefore = readFileSync(shippedConfigPath(), 'utf8');
    const root = newRoot();
    await (await openThread(root, env, 'a')).built.dispose();
    for (const change of [
      { op: 'disable', id: 'echo' },
      { op: 'enable', id: 'echo' },
      { op: 'config-set', id: 'echo', config: { prefix: 'x' } },
      { op: 'config-reset', id: 'echo' },
    ] as const) {
      await changePlugin(change, { env });
      await (await openThread(root, env, `t-${change.op}`)).built.dispose();
    }
    expect(readFileSync(shippedConfigPath(), 'utf8')).toBe(shippedBefore);
    expect(readdirSync(dir).filter((name) => /cordis\.ya?ml|\.tmp$/u.test(name))).toEqual([]);
  }, 60000);
});

describe('resolveEntryModule 的判別', () => {
  function writeModule(name: string, source: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-echo-mod-'));
    chmodSync(dir, 0o700);
    temporary.push(dir);
    const path = join(dir, name);
    writeFileSync(path, source, { mode: 0o600 });
    chmodSync(path, 0o600);
    return `file://${path}`;
  }

  it('有 manifest 具名匯出：橋接列（即使還有 default）', async () => {
    const specifier = writeModule(
      'fn.mjs',
      `import { z } from 'zod';
export const name = 'fn-plugin';
export const Config = z.strictObject({});
export const manifest = { id: 'fn-plugin', version: '1.0.0', owner: 't', provides: [], consumes: [], config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [] };
export function apply() {}
export default { name: 'legacy-face', apply() {} };
`,
    );
    const entry = await resolveEntryModule({ id: 'fn', name: specifier });
    expect(isBridgeEntry(entry)).toBe(true);
    expect(entry.plugin.name).toBe('fn-plugin');
  });

  it('沒有 manifest：照舊是 NexusPlugin', async () => {
    const specifier = writeModule('legacy.mjs', `export default { name: 'legacy', apply() {} };\n`);
    const entry = await resolveEntryModule({ id: 'legacy', name: specifier });
    expect(isBridgeEntry(entry)).toBe(false);
    expect(entry.plugin.name).toBe('legacy');
  });

  it('A：manifest 缺必填欄位，那一列掉在模組那一步，訊息指名欄位', async () => {
    const specifier = writeModule(
      'bad.mjs',
      `export const name = 'bad';
export const manifest = { id: 'bad', version: '1.0.0' };
export function apply() {}
`,
    );
    await expect(resolveEntryModule({ id: 'bad', name: specifier })).rejects.toThrow(
      /缺少必填欄位.*owner/u,
    );
  });
});

describe('journalPathOf', () => {
  it('寫入口寫的是 home 底下那一份紀錄', async () => {
    const { dir, env } = home();
    await changePlugin({ op: 'disable', id: 'echo' }, { env });
    expect(readJournalText(dir)).toContain('"id":"echo"');
    expect(journalPathOf(dir).startsWith(dir)).toBe(true);
  });
});
