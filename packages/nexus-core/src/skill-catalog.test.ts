/**
 * `skill-catalog.ts` 的值表、掃描與 backend 視圖（[#1574](https://github.com/DemianLi/nexus-agent/issues/1574) 刀 1）。
 *
 * 值表與拋錯形狀逐條對 dsh `skill-filesystem/src/index.ts:1007-1044`（`687f282e`）。視圖量的是基座實際看到的 `ls`，
 * 以及包過與沒包的 skills 中介層交出的 system prompt；產品路徑（樹、子代理）在 harness 的 `skills.test.ts`。
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SystemMessage } from '@langchain/core/messages';
import { createSkillsMiddleware, FilesystemBackend } from 'deepagents';
import type { BackendProtocolV2, LsResult } from 'deepagents';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { modelVisibleSkillsBackend, parseSkillInvocation, scanSkills } from './skill-catalog.js';
import { createSkillsMiddlewareQuietWhenEmpty } from './skills-middleware.js';

/** `{ '<來源>/<目錄>': '<frontmatter 多出來的幾行>' }`，`name` 取目錄名。 */
async function workspace(layout: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-skill-catalog-'));
  for (const [path, extra] of Object.entries(layout)) {
    const name = path.split('/').pop()!;
    await mkdir(join(root, path), { recursive: true });
    await writeFile(
      join(root, path, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${path} 的說明。\n${extra}---\n\n${path} 的正文。\n`,
    );
  }
  return root;
}

function backendAt(root: string): FilesystemBackend {
  return new FilesystemBackend({ rootDir: root, virtualMode: true });
}

/** 視圖的 `ls` 列出來的目錄名。 */
async function listed(backend: BackendProtocolV2, path: string): Promise<string[]> {
  const result: LsResult = await backend.ls(path);
  return (result.files ?? []).map((info) => info.path.replace(/\/$/, '').split('/').pop()!).sort();
}

function invalidWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes('不收'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseSkillInvocation：值表照 dsh', () => {
  it('沒寫旗標：模型與人都叫得到', () => {
    expect(parseSkillInvocation({ name: 'a', description: 'b' })).toEqual({
      modelInvocable: true,
      userInvocable: true,
    });
  });

  it.each([
    [true, true],
    [false, false],
    [1, true],
    ['1', true],
    [0, false],
    ['0', false],
    ['true', true],
    ['YES', true],
    ['On', true],
    ['false', false],
    ['no', false],
    ['OFF', false],
  ] as const)('disable-model-invocation: %j → 停用 %j', (value, disabled) => {
    expect(parseSkillInvocation({ 'disable-model-invocation': value }).modelInvocable).toBe(
      !disabled,
    );
    expect(parseSkillInvocation({ 'user-invocable': value }).userInvocable).toBe(disabled);
  });

  it.each([['maybe'], [null], [2], ['2'], [''], [[]], [{}]])(
    '不在值表上的 %j 拋 TypeError，兩個鍵都一樣',
    (value) => {
      expect(() => parseSkillInvocation({ 'disable-model-invocation': value })).toThrow(TypeError);
      expect(() => parseSkillInvocation({ 'user-invocable': value })).toThrow(TypeError);
    },
  );

  it.each([
    ['disableModelInvocation', 'disable-model-invocation'],
    ['modelInvocable', 'disable-model-invocation'],
    ['userInvocable', 'user-invocable'],
  ])('舊鍵 %s 拋 Error（不是 TypeError），叫人改用 %s', (legacy, canonical) => {
    let thrown: unknown;
    try {
      parseSkillInvocation({ [legacy]: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain(canonical);
  });
});

describe('scanSkills', () => {
  it('同名後者贏；旗標不合規的整份不收、不參與決勝，並帶路徑 warn 一行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = await workspace({
      'base/alpha': '',
      'base/beta': 'user-invocable: false\n',
      'proj/alpha': 'disable-model-invocation: true\n',
      'proj/beta': 'user-invocable: maybe\n',
    });

    const skills = await scanSkills(backendAt(root), ['/base/', '/proj/']);

    expect(skills.map((skill) => [skill.name, skill.path, skill.invocation])).toEqual([
      ['alpha', '/proj/alpha/SKILL.md', { modelInvocable: false, userInvocable: true }],
      // proj/beta 不合規、不成為候選，所以 base 那份留著。
      ['beta', '/base/beta/SKILL.md', { modelInvocable: true, userInvocable: false }],
    ]);
    expect(skills[0]!.body).toBe('proj/alpha 的正文。');
    expect(invalidWarnings(warn)).toEqual([expect.stringContaining('/proj/beta/SKILL.md')]);
  });

  it('來源本身是單一技能', async () => {
    const root = await workspace({ 'solo/deploy': 'disable-model-invocation: on\n' });
    const skills = await scanSkills(backendAt(root), ['/solo/deploy']);
    expect(skills.map((skill) => [skill.path, skill.invocation.modelInvocable])).toEqual([
      ['/solo/deploy/SKILL.md', false],
    ]);
  });
});

describe('modelVisibleSkillsBackend：基座的 ls 看不到的那幾個目錄', () => {
  it('沒有旗標的技能：ls 跟沒包時一樣', async () => {
    const root = await workspace({ 'skills/alpha': '', 'skills/beta': 'user-invocable: false\n' });
    const inner = backendAt(root);
    const view = modelVisibleSkillsBackend(inner, ['/skills/']) as BackendProtocolV2;
    expect(await view.ls('/skills/')).toEqual(await inner.ls('/skills/'));
  });

  it('只給人叫的、不合規的拿掉；其餘照列', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = await workspace({
      'skills/deploy': 'disable-model-invocation: true\n',
      'skills/normal': '',
      'skills/maybe': 'disable-model-invocation: maybe\n',
      'skills/legacy': 'disableModelInvocation: true\n',
    });
    const view = modelVisibleSkillsBackend(backendAt(root), ['/skills/']) as BackendProtocolV2;
    expect(await listed(view, '/skills/')).toEqual(['normal']);
  });

  it('同名勝出的那一份只給人叫：所有來源裡同名的目錄一起拿掉', async () => {
    const root = await workspace({
      'base/deploy': '',
      'base/normal': '',
      'proj/deploy': 'disable-model-invocation: true\n',
    });
    const view = modelVisibleSkillsBackend(backendAt(root), [
      '/base/',
      '/proj/',
    ]) as BackendProtocolV2;
    expect(await listed(view, '/base/')).toEqual(['normal']);
    expect(await listed(view, '/proj/')).toEqual([]);
  });

  it('只給人叫的那一份輸了同名決勝：不拿掉，模型看到的是勝出那一份', async () => {
    const root = await workspace({
      'base/deploy': 'disable-model-invocation: true\n',
      'proj/deploy': '',
    });
    const view = modelVisibleSkillsBackend(backendAt(root), [
      '/base/',
      '/proj/',
    ]) as BackendProtocolV2;
    expect(await listed(view, '/base/')).toEqual(['deploy']);
    expect(await listed(view, '/proj/')).toEqual(['deploy']);
  });

  it('不合規的不參與決勝：順位較低的同名合規技能照列', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = await workspace({
      'base/deploy': '',
      'proj/deploy': 'user-invocable: null\n',
    });
    const view = modelVisibleSkillsBackend(backendAt(root), [
      '/base/',
      '/proj/',
    ]) as BackendProtocolV2;
    expect(await listed(view, '/base/')).toEqual(['deploy']);
    expect(await listed(view, '/proj/')).toEqual([]);
  });

  it('來源本身是單一技能而且只給人叫：回空清單', async () => {
    const root = await workspace({ 'solo/deploy': 'disable-model-invocation: yes\n' });
    const view = modelVisibleSkillsBackend(backendAt(root), ['/solo/deploy']) as BackendProtocolV2;
    expect((await view.ls('/solo/deploy/')).files).toEqual([]);
  });

  it('工廠：解開之後同樣過濾', async () => {
    const root = await workspace({
      'skills/deploy': 'disable-model-invocation: true\n',
      'skills/normal': '',
    });
    const factory = modelVisibleSkillsBackend(() => backendAt(root), ['/skills/']);
    expect(typeof factory).toBe('function');
    const resolved = await (factory as (runtime: never) => Promise<BackendProtocolV2>)({} as never);
    expect(await listed(resolved, '/skills/')).toEqual(['normal']);
  });
});

/**
 * 包過與沒包的中介層交出的 system prompt。驗收 3：沒有旗標時逐位元組相同（把「沒寫旗標」也當隱藏就紅）；
 * 對照組：有旗標時兩邊確實不同，證明這一條比的是同一個面。
 */
describe('skills 中介層交給模型的 system prompt', () => {
  async function promptOf(
    build: typeof createSkillsMiddleware,
    root: string,
    sources: string[],
  ): Promise<string> {
    const middleware = build({ backend: backendAt(root), sources }) as unknown as {
      beforeAgent: (state: unknown, runtime: unknown) => Promise<unknown>;
      wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => unknown;
    };
    const update = (await middleware.beforeAgent({}, {})) as Record<string, unknown> | undefined;
    let seen: SystemMessage | undefined;
    await middleware.wrapModelCall(
      { systemMessage: new SystemMessage('系統。'), state: { ...update } },
      (request) => {
        seen = (request as { systemMessage: SystemMessage }).systemMessage;
        return undefined;
      },
    );
    return seen!.text;
  }

  it('沒有旗標的技能：跟直接用基座的逐位元組相同', async () => {
    const root = await workspace({
      'base/alpha': '',
      'base/beta': 'user-invocable: false\n',
      'proj/alpha': '',
    });
    const sources = ['/base/', '/proj/'];
    const ours = await promptOf(
      createSkillsMiddlewareQuietWhenEmpty as unknown as typeof createSkillsMiddleware,
      root,
      sources,
    );
    const base = await promptOf(createSkillsMiddleware, root, sources);
    expect(ours).toContain('**alpha**');
    expect(ours).toContain('**beta**');
    expect(ours).toBe(base);
  });

  it('對照：有只給人叫的技能時，基座列出它、包過的不列', async () => {
    const root = await workspace({
      'skills/deploy': 'disable-model-invocation: true\n',
      'skills/normal': '',
    });
    const ours = await promptOf(
      createSkillsMiddlewareQuietWhenEmpty as unknown as typeof createSkillsMiddleware,
      root,
      ['/skills/'],
    );
    const base = await promptOf(createSkillsMiddleware, root, ['/skills/']);
    expect(base).toContain('**deploy**');
    expect(ours).not.toContain('**deploy**');
    expect(ours).toContain('**normal**');
  });
});
