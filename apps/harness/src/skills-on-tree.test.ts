/**
 * skills 在 Cordis 樹上，技能來源接縫上樹（[#1446](https://github.com/DemianLi/nexus-agent/issues/1446)）：驗收 B、D、E、F、G。
 * 量的是產品路徑——真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹）、真的寫入口 `changePlugin`、真的
 * `createCliAgent`；不手搭 `ctx.plugin`。
 *
 * 「這一條 thread 有哪些技能來源」看的是送給模型的 system prompt（技能清單進的是 prompt，這是產品上唯一看得到的面），
 * 不是清單長什麼樣。驗收 C（行為不變的 golden）是一次性錄製，不在這個檔，做法與數字寫在 PR 內文。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BaseMessage } from '@langchain/core/messages';
import { manifest as skillsManifest } from '@nexus/plugin-skills';
import { effectiveReload } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { changePlugin } from './plugin-change.js';
import { isBridgeEntry, loadDefaultPlugins } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { classOfRow } from './plugin-row-classes.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import type { ScriptedChatModel } from './scripted-model.js';
import { auditStartupEntries } from './startup-audit.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'nexus-skills-tree-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

function newRoot(): CordisRoot {
  const root = createCordisRoot({ workspaceRoot: tmpdir() });
  roots.push(root);
  return root;
}

const warnNothing = (): void => {};
const ID = 'skills';

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = scratch();
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

/** 工作區：`{ '<來源目錄>': { '<skill 名>': '<description>' } }`，每個 skill 是 `<來源目錄>/<名字>/SKILL.md`。 */
function workspace(layout: Record<string, Record<string, string>>): string {
  const root = scratch('nexus-skills-ws-');
  for (const [dir, skills] of Object.entries(layout)) {
    for (const [name, description] of Object.entries(skills)) {
      mkdirSync(join(root, dir, name), { recursive: true });
      writeFileSync(
        join(root, dir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\n---\n\n正文：${name}。\n`,
      );
    }
  }
  return root;
}

/** 一份 `--patch` 覆蓋層。 */
function overlay(dir: string, body: string, name = 'overlay.yml'): string {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** 一條 thread：讀清單（帶樹，臨界區）→ 組 agent（有工作區就用它的 backend）。 */
async function openThread(
  root: CordisRoot,
  env: NodeJS.ProcessEnv,
  options: { workspace?: string; patches?: string[] } = {},
) {
  const loaded = await loadDefaultPlugins(
    { env, warn: warnNothing, ...(options.patches && { patches: options.patches }) },
    { tree: root.tree },
  );
  return assemble(loaded, options.workspace);
}

async function assemble(loaded: LoadedPluginConfig, workspaceRoot?: string) {
  const built = await createCliAgent(
    workspaceRoot === undefined ? { live: false } : { live: false, workspace: workspaceRoot },
    loaded.plugins,
    workspaceRoot,
  );
  return {
    loaded,
    built,
    /** 打一輪，交回模型這一輪收到的 system prompt。 */
    async prompt(): Promise<string> {
      await built.agent.invoke(toAgentInvocation('嗨。'), {
        configurable: { thread_id: `t-${Math.random().toString(36).slice(2)}` },
      });
      const messages = (built.model as ScriptedChatModel).lastPrompt as readonly BaseMessage[];
      return messages
        .filter((message) => message.getType() === 'system')
        .map((message) => message.text)
        .join('\n');
    },
  };
}

describe('B：出貨清單上的 skills 經樹進來，位置與名字不變', () => {
  it('是橋接列、樹上那一列 ACTIVE、沒有掉列；啟動稽核過；快照上是 mounted', async () => {
    const { env } = home();
    const root = newRoot();
    const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
    expect(entry).toBeDefined();
    expect(entry !== undefined && isBridgeEntry(entry)).toBe(true);
    expect(entry?.plugin.name).toBe('skills');
    expect(loaded.dropped).toEqual([]);
    expect(loaded.rows.get(entry as never)).toEqual({ id: ID, module: '@nexus/plugin-skills' });
    expect(() => auditStartupEntries(loaded, { live: false })).not.toThrow();

    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(2);
    // 技能來源登記處是樹上一列，起來了；它是必掛的列（跟工具、投影登記處一樣）。
    expect(tree.loader.resolve('skill-sources').fiber?.ctx.fiber.state).toBe(2);

    const source = {
      entries: loaded.entries,
      ids: loaded.ids,
      plugins: loaded.plugins,
      rows: loaded.rows,
      drops: loaded.dropped.map(({ id, stage }) => ({ id, stage })),
    };
    const snapshot = buildPluginSnapshot({
      running: source,
      saved: source,
      generatedAt: new Date(0),
    });
    expect(snapshot.rows.find((row) => row.id === ID)).toMatchObject({
      module: '@nexus/plugin-skills',
      running: { state: 'mounted' },
      saved: { state: 'mounted' },
      sync: 'same',
    });
  }, 60000);

  it('經樹進來的 thread 列得出工作區的 skill；沒有樹的呼叫端（手搭清單）同一份清單也一樣', async () => {
    const { env } = home();
    const ws = workspace({ skills: { 'web-research': '上網查資料。' } });
    const thread = await openThread(newRoot(), env, { workspace: ws });
    const prompt = await thread.prompt();
    expect(prompt).toContain('## Skills System');
    expect(prompt).toContain('web-research');
    expect(prompt).toContain('/skills/web-research/SKILL.md');
    await thread.built.dispose();
  }, 60000);

  it('reload 分類：manifest 宣告的不比宿主的分類寬；快照上停用後是「下一條 thread」那一類', async () => {
    const host = {
      config: classOfRow(ID, '@nexus/plugin-skills') === 'startup-read' ? 'restart' : 'next-thread',
    } as const;
    expect(effectiveReload(skillsManifest.reload, host)).toEqual({
      code: 'restart',
      config: 'next-thread',
    });

    const { env } = home();
    const running = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: newRoot().tree });
    await changePlugin({ op: 'disable', id: ID }, { env });
    const saved = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: newRoot().tree });
    const pick = (loaded: LoadedPluginConfig) => ({
      entries: loaded.entries,
      ids: loaded.ids,
      plugins: loaded.plugins,
      rows: loaded.rows,
      drops: loaded.dropped.map(({ id, stage }) => ({ id, stage })),
    });
    const snapshot = buildPluginSnapshot({
      running: pick(running),
      saved: pick(saved),
      generatedAt: new Date(0),
    });
    expect(snapshot.rows.find((row) => row.id === ID)).toMatchObject({
      running: { state: 'mounted' },
      saved: { state: 'disabled' },
      sync: 'next-thread',
    });
  }, 60000);
});

describe('D：樹上那一列停用或改 sources，開著的 thread 照舊，下一條才看到新的', () => {
  it('停用：寫入之後立刻開的 thread 沒有技能清單；開著的那條照舊有；再啟用又有', async () => {
    const { env } = home();
    const ws = workspace({ skills: { 'web-research': '上網查資料。' } });
    const root = newRoot();
    const first = await openThread(root, env, { workspace: ws });

    await changePlugin({ op: 'disable', id: ID }, { env });
    const second = await openThread(root, env, { workspace: ws });
    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(4);

    // 開著的那條：組裝當下那一份已經在它的 registry 裡，樹上那一列卸了它也不變（決議 §3-2 第 6 條）。
    expect(await first.prompt()).toContain('web-research');
    expect(await second.prompt()).not.toContain('web-research');

    await changePlugin({ op: 'enable', id: ID }, { env });
    const third = await openThread(root, env, { workspace: ws });
    expect(await third.prompt()).toContain('web-research');
    for (const thread of [first, second, third]) await thread.built.dispose();
  }, 90000);

  it('改 sources：下一條 thread 用新的來源，開著的那條照舊；改回去又是原本的', async () => {
    const { env } = home();
    const ws = workspace({ skills: { alpha: '原本的。' }, extra: { beta: '新來源的。' } });
    const root = newRoot();
    const first = await openThread(root, env, { workspace: ws });

    await changePlugin(
      { op: 'config-set', id: ID, config: { sources: ['/skills/', '/extra/'] } },
      { env },
    );
    const second = await openThread(root, env, { workspace: ws });
    const secondPrompt = await second.prompt();
    expect(secondPrompt).toContain('alpha');
    expect(secondPrompt).toContain('beta');
    const firstPrompt = await first.prompt();
    expect(firstPrompt).toContain('alpha');
    expect(firstPrompt).not.toContain('beta');

    await changePlugin({ op: 'config-reset', id: ID }, { env });
    const third = await openThread(root, env, { workspace: ws });
    const thirdPrompt = await third.prompt();
    expect(thirdPrompt).toContain('alpha');
    expect(thirdPrompt).not.toContain('beta');
    for (const thread of [first, second, third]) await thread.built.dispose();
  }, 90000);
});

describe('E：寫錯的路徑在讀清單那一步就掉，掉列訊息帶列 id', () => {
  it.each([
    ['skills', '不是絕對路徑'],
    ['~/skills', '以 "~" 開頭'],
    ['/a/../b', '".."'],
  ])(
    'sources 寫 %s：那一列掉在 apply，訊息帶列 id 與路徑，其餘的列照常起來',
    async (path, hint) => {
      const { dir, env } = home();
      const patch = overlay(dir, `- id: ${ID}\n  config:\n    sources:\n      - '${path}'\n`);
      const loaded = await loadDefaultPlugins(
        { env, patches: [patch], warn: warnNothing },
        { tree: newRoot().tree },
      );
      const drop = loaded.dropped.find((candidate) => candidate.id === ID);
      expect(drop?.stage).toBe('apply');
      expect(drop?.message).toContain(`include:${ID}`);
      expect(drop?.message).toContain(path);
      expect(drop?.message).toContain(hint);
      expect(loaded.dropped.filter((candidate) => candidate.id !== ID)).toEqual([]);
      // 掉了不是讓這條 thread 建不起來：skills 不是必掛的列，組得起來，只是沒有技能清單。
      const thread = await assemble(loaded);
      expect(await thread.prompt()).not.toContain('Skills System');
      await thread.built.dispose();
    },
    60000,
  );
});

describe('F：兩列登記同一個目錄（Q3 (a)）', () => {
  /** 在 skills 後面再插一列同一個套件、同一個目錄。 */
  const TWIN = (path: string) =>
    `- insert:\n    - id: twin-skills\n      name: '@nexus/plugin-skills'\n      config:\n        sources:\n          - '${path}'\n`;

  it('後登記的那一列掉在 apply，訊息指名兩邊；先登記的照舊，這條 thread 組得起來', async () => {
    const { dir, env } = home();
    const ws = workspace({ skills: { alpha: '原本的。' } });
    const loaded = await loadDefaultPlugins(
      { env, patches: [overlay(dir, TWIN('/skills'))], warn: warnNothing },
      { tree: newRoot().tree },
    );
    const drop = loaded.dropped.find((candidate) => candidate.id === 'twin-skills');
    expect(drop?.stage).toBe('apply');
    expect(drop?.message).toContain('include:skills');
    expect(drop?.message).toContain('include:twin-skills');
    expect(loaded.dropped.find((candidate) => candidate.id === ID)).toBeUndefined();
    const thread = await assemble(loaded, ws);
    expect(await thread.prompt()).toContain('alpha');
    await thread.built.dispose();
  }, 60000);

  it('不同的目錄不衝突：兩列各給各的來源，兩邊的 skill 都在', async () => {
    const { dir, env } = home();
    const ws = workspace({ skills: { alpha: '甲。' }, more: { beta: '乙。' } });
    const thread = await openThread(newRoot(), env, {
      workspace: ws,
      patches: [overlay(dir, TWIN('/more/'))],
    });
    expect(thread.loaded.dropped).toEqual([]);
    const prompt = await thread.prompt();
    expect(prompt).toContain('alpha');
    expect(prompt).toContain('beta');
    await thread.built.dispose();
  }, 60000);

  it('同一列改設定重掛：不會被自己舊的那一份判成重名（跨多次寫入，包含「同目錄還在、順序換了」）', async () => {
    const { env } = home();
    const ws = workspace({ skills: { alpha: '甲。' }, more: { beta: '乙。' } });
    const root = newRoot();
    const open = async () => {
      const thread = await openThread(root, env, { workspace: ws });
      const dropped = thread.loaded.dropped;
      const prompt = await thread.prompt();
      await thread.built.dispose();
      return { dropped, prompt };
    };
    await open();
    // 同一個目錄還在、再多一個。
    await changePlugin(
      { op: 'config-set', id: ID, config: { sources: ['/skills/', '/more/'] } },
      { env },
    );
    const added = await open();
    expect(added.dropped).toEqual([]);
    expect(added.prompt).toContain('beta');
    // 順序換過、同一個目錄結尾斜線寫法不同：還是同一列、同一組目錄。
    await changePlugin(
      { op: 'config-set', id: ID, config: { sources: ['/more', '/skills'] } },
      { env },
    );
    const reordered = await open();
    expect(reordered.dropped).toEqual([]);
    expect(reordered.prompt).toContain('alpha');
    expect(reordered.prompt).toContain('beta');
    // 再寫一次一模一樣的設定（同值，不重掛）與改回預設。
    await changePlugin({ op: 'config-reset', id: ID }, { env });
    const reset = await open();
    expect(reset.dropped).toEqual([]);
    expect(reset.prompt).toContain('alpha');
    expect(reset.prompt).not.toContain('beta');
  }, 120000);
});

describe('G：多個 sources 的優先序跟遷移前一樣（後面的來源贏過前面的同名 skill）', () => {
  it('同一列的 sources 依序：後面的贏', async () => {
    const { dir, env } = home();
    const ws = workspace({
      base: { shared: '基底版本。', only_base: '只在基底。' },
      proj: { shared: '專案版本。' },
    });
    const patch = overlay(
      dir,
      `- id: ${ID}\n  config:\n    sources:\n      - '/base/'\n      - '/proj/'\n`,
    );
    const thread = await openThread(newRoot(), env, { workspace: ws, patches: [patch] });
    const prompt = await thread.prompt();
    expect(prompt).toContain('專案版本。');
    expect(prompt).not.toContain('基底版本。');
    expect(prompt).toContain('只在基底。');
    await thread.built.dispose();

    // 對調：現在 /base/ 在後面，贏的是它。
    const swapped = overlay(
      dir,
      `- id: ${ID}\n  config:\n    sources:\n      - '/proj/'\n      - '/base/'\n`,
      'swapped.yml',
    );
    const second = await openThread(newRoot(), env, { workspace: ws, patches: [swapped] });
    const swappedPrompt = await second.prompt();
    expect(swappedPrompt).toContain('基底版本。');
    expect(swappedPrompt).not.toContain('專案版本。');
    await second.built.dispose();
  }, 90000);

  it('跨兩列：清單上靠後的那一列贏；停掉靠後那一列，贏的換回前面的', async () => {
    const { dir, env } = home();
    const ws = workspace({ skills: { shared: '前面那一列。' }, late: { shared: '後面那一列。' } });
    const twin =
      `- insert:\n    - id: late-skills\n      name: '@nexus/plugin-skills'\n` +
      `      config:\n        sources:\n          - '/late/'\n`;
    const root = newRoot();
    const both = await openThread(root, env, {
      workspace: ws,
      patches: [overlay(dir, twin, 'both.yml')],
    });
    expect(both.loaded.dropped).toEqual([]);
    const bothPrompt = await both.prompt();
    expect(bothPrompt).toContain('後面那一列。');
    expect(bothPrompt).not.toContain('前面那一列。');
    await both.built.dispose();

    const off = await openThread(root, env, {
      workspace: ws,
      patches: [overlay(dir, `${twin}- id: late-skills\n  disabled: true\n`, 'off.yml')],
    });
    const offPrompt = await off.prompt();
    expect(offPrompt).toContain('前面那一列。');
    expect(offPrompt).not.toContain('後面那一列。');
    await off.built.dispose();
  }, 90000);
});
