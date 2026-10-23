/**
 * `skill-catalog.ts` 的值表、掃描與 backend 視圖（[#1574](https://github.com/DemianLi/nexus-agent/issues/1574) 刀 1）。
 *
 * 值表與拋錯形狀逐條對 dsh `skill-filesystem/src/index.ts:1007-1044`（`687f282e`）。視圖量的是基座實際看到的 `ls`，
 * 以及包過與沒包的 skills 中介層交出的 system prompt（含掃描不完整的那幾種）；產品路徑（樹、子代理）在 harness 的 `skills.test.ts`。
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createSkillsMiddleware, FilesystemBackend } from 'deepagents';
import type { BackendProtocolV2, BackendRuntime, FileDownloadResponse, LsResult } from 'deepagents';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sourceKwargs } from './message-source.js';
import { REPEAT_REMINDER_MARKER } from './repeat-reminder.js';
import {
  isHumanSpeech,
  modelVisibleSkillsBackend,
  parseSkillInvocation,
  renderSkillInvocation,
  scanSkills,
} from './skill-catalog.js';
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

    const { skills, complete } = await scanSkills(backendAt(root), ['/base/', '/proj/']);

    expect(complete).toBe(true);

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
    const { skills } = await scanSkills(backendAt(root), ['/solo/deploy']);
    expect(skills.map((skill) => [skill.path, skill.invocation.modelInvocable])).toEqual([
      ['/solo/deploy/SKILL.md', false],
    ]);
  });

  it('讀不到勝出的那一份：回不完整，順位較低的同名技能頂上來（交給消費端判斷）', async () => {
    const root = await workspace({ 'base/deploy': '', 'proj/deploy': '' });
    const inner = new FlakyBackend(root, {
      download: { '/proj/deploy/SKILL.md': 'permission_denied' },
    });

    const { skills, complete } = await scanSkills(inner, ['/base/', '/proj/']);

    expect(complete).toBe(false);
    expect(skills.map((skill) => skill.path)).toEqual(['/base/deploy/SKILL.md']);
  });
});

describe('renderSkillInvocation：逐字照 dsh renderSkillContent', () => {
  it('directory 形狀的資源說明、正文原樣、名字與路徑跳脫', () => {
    expect(
      renderSkillInvocation({
        name: 'a"<b',
        path: '/skills/x<y>&z/SKILL.md',
        body: '照做 <raw> & 不跳脫',
      }),
    ).toBe(
      [
        '<skill_content name="a&quot;&lt;b">',
        '<skill_resources>',
        'Base directory for this skill: /skills/x&lt;y&gt;&amp;z',
        'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
        '</skill_resources>',
        '',
        '<skill_instructions>',
        '照做 <raw> & 不跳脫',
        '</skill_instructions>',
        '</skill_content>',
      ].join('\n'),
    );
  });
});

/** 解開視圖：它一律是工廠，基座也是這樣在 `beforeAgent` 裡解開的。 */
async function viewOf(
  backend: Parameters<typeof modelVisibleSkillsBackend>[0],
  sources: string[],
  onScan?: (complete: boolean) => void,
): Promise<BackendProtocolV2> {
  return modelVisibleSkillsBackend(
    backend,
    sources,
    onScan,
  )({} as BackendRuntime) as Promise<BackendProtocolV2>;
}

/**
 * 某幾個路徑第一次讀或列的時候出錯、之後正常的 backend。`ls` 給的是那一次要回的 `LsResult`（`{ error }` 或安靜的空列表）。
 */
class FlakyBackend extends FilesystemBackend {
  readonly calls = { ls: 0, downloadFiles: 0 };

  constructor(
    root: string,
    private readonly failOnce: {
      readonly ls?: Record<string, LsResult>;
      readonly download?: Record<string, FileDownloadResponse['error']>;
    },
  ) {
    super({ rootDir: root, virtualMode: true });
  }

  override async ls(path: string): Promise<LsResult> {
    this.calls.ls += 1;
    const once = this.failOnce.ls?.[path];
    if (once !== undefined) {
      delete this.failOnce.ls![path];
      return once;
    }
    return super.ls(path);
  }

  override async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    this.calls.downloadFiles += 1;
    return Promise.all(
      paths.map(async (path) => {
        const once = this.failOnce.download?.[path];
        if (once !== undefined) {
          delete this.failOnce.download![path];
          return { path, content: null, error: once };
        }
        return (await super.downloadFiles([path]))[0]!;
      }),
    );
  }
}

describe('modelVisibleSkillsBackend：基座的 ls 看不到的那幾個目錄', () => {
  it('一律交出工廠', () => {
    expect(typeof modelVisibleSkillsBackend(new FilesystemBackend(), ['/skills/'])).toBe(
      'function',
    );
  });

  it('沒有旗標的技能：ls 跟沒包時一樣', async () => {
    const root = await workspace({ 'skills/alpha': '', 'skills/beta': 'user-invocable: false\n' });
    const inner = backendAt(root);
    const view = await viewOf(inner, ['/skills/']);
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
    const view = await viewOf(backendAt(root), ['/skills/']);
    expect(await listed(view, '/skills/')).toEqual(['normal']);
  });

  it('同名勝出的那一份只給人叫：所有來源裡同名的目錄一起拿掉', async () => {
    const root = await workspace({
      'base/deploy': '',
      'base/normal': '',
      'proj/deploy': 'disable-model-invocation: true\n',
    });
    const view = await viewOf(backendAt(root), ['/base/', '/proj/']);
    expect(await listed(view, '/base/')).toEqual(['normal']);
    expect(await listed(view, '/proj/')).toEqual([]);
  });

  it('只給人叫的那一份輸了同名決勝：不拿掉，模型看到的是勝出那一份', async () => {
    const root = await workspace({
      'base/deploy': 'disable-model-invocation: true\n',
      'proj/deploy': '',
    });
    const view = await viewOf(backendAt(root), ['/base/', '/proj/']);
    expect(await listed(view, '/base/')).toEqual(['deploy']);
    expect(await listed(view, '/proj/')).toEqual(['deploy']);
  });

  it('不合規的不參與決勝：順位較低的同名合規技能照列', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = await workspace({
      'base/deploy': '',
      'proj/deploy': 'user-invocable: null\n',
    });
    const view = await viewOf(backendAt(root), ['/base/', '/proj/']);
    expect(await listed(view, '/base/')).toEqual(['deploy']);
    expect(await listed(view, '/proj/')).toEqual([]);
  });

  it('來源本身是單一技能而且只給人叫：回空清單', async () => {
    const root = await workspace({ 'solo/deploy': 'disable-model-invocation: yes\n' });
    const view = await viewOf(backendAt(root), ['/solo/deploy']);
    expect((await view.ls('/solo/deploy/')).files).toEqual([]);
  });

  it('工廠進、工廠出：解開之後同樣過濾', async () => {
    const root = await workspace({
      'skills/deploy': 'disable-model-invocation: true\n',
      'skills/normal': '',
    });
    const view = await viewOf(() => backendAt(root), ['/skills/']);
    expect(await listed(view, '/skills/')).toEqual(['normal']);
  });

  it('基座的 ls 與讀 SKILL.md 由掃描的快照回應，不再碰 inner', async () => {
    const root = await workspace({ 'skills/alpha': '', 'skills/beta': '' });
    const inner = new FlakyBackend(root, {});
    const view = await viewOf(inner, ['/skills/']);
    await view.ls('/skills/');
    const afterScan = { ...inner.calls };
    expect(afterScan).toEqual({ ls: 1, downloadFiles: 2 });
    await view.ls('/skills/');
    await view.downloadFiles!(['/skills/alpha/SKILL.md']);
    expect(inner.calls).toEqual(afterScan);
  });
});

/**
 * 包過與沒包的中介層交出的 system prompt。驗收 3：沒有旗標時逐位元組相同（把「沒寫旗標」也當隱藏就紅）；
 * 對照組：有旗標時兩邊確實不同，證明這一條比的是同一個面。
 */
describe('skills 中介層交給模型的 system prompt', () => {
  interface Hooks {
    beforeAgent: (state: unknown, runtime: unknown) => Promise<unknown>;
    wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => unknown;
  }

  function build(
    factory: typeof createSkillsMiddleware,
    backend: FilesystemBackend,
    sources: string[],
  ): Hooks {
    return factory({ backend, sources }) as unknown as Hooks;
  }

  const ours = createSkillsMiddlewareQuietWhenEmpty as unknown as typeof createSkillsMiddleware;

  /** 跑一次 invoke 的 `beforeAgent`，再跑一次模型呼叫，交回模型看到的 system prompt。 */
  async function invoke(middleware: Hooks): Promise<string> {
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
    const wrapped = await invoke(build(ours, backendAt(root), sources));
    const base = await invoke(build(createSkillsMiddleware, backendAt(root), sources));
    expect(wrapped).toContain('**alpha**');
    expect(wrapped).toContain('**beta**');
    expect(wrapped).toBe(base);
  });

  it('對照：有只給人叫的技能時，基座列出它、包過的不列', async () => {
    const root = await workspace({
      'skills/deploy': 'disable-model-invocation: true\n',
      'skills/normal': '',
    });
    const wrapped = await invoke(build(ours, backendAt(root), ['/skills/']));
    const base = await invoke(build(createSkillsMiddleware, backendAt(root), ['/skills/']));
    expect(base).toContain('**deploy**');
    expect(wrapped).not.toContain('**deploy**');
    expect(wrapped).toContain('**normal**');
  });

  /**
   * 讀失敗不是「不存在」：那份叫什麼名字不知道，同名決勝做不了。順位較高的 `proj/deploy` 只給人叫，讀它那一次出錯；
   * 只跳過它的話，`base/deploy` 會頂上來列給模型。照 dsh 整份目錄不發、不接任何字。
   *
   * 第二次 invoke 量的是「整份不發」不能只做在 wrapper 那一道：基座載到非空的清單就凍住，不完整那一次要是讓它載到
   * `base/deploy`，下一次它就不重掃、直接印出來。
   */
  it('讀 SKILL.md 遇到「不存在」以外的錯誤：這一次整份不給模型、一個字都不加，下一次照實重掃', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = await workspace({
      'base/deploy': '',
      'base/normal': '',
      'proj/deploy': 'disable-model-invocation: true\n',
    });
    const backend = new FlakyBackend(root, {
      download: { '/proj/deploy/SKILL.md': 'permission_denied' },
    });
    const middleware = build(ours, backend, ['/base/', '/proj/']);
    expect(await invoke(middleware)).toBe('系統。');
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining('/proj/deploy/SKILL.md 讀不到：permission_denied'),
    ]);
    const second = await invoke(middleware);
    expect(second).toContain('**normal**');
    expect(second).not.toContain('**deploy**');
  });

  it('列來源遇到錯誤：這一次整份不給模型、一個字都不加', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = await workspace({
      'base/deploy': '',
      'base/normal': '',
      'proj/deploy': 'disable-model-invocation: true\n',
    });
    const backend = new FlakyBackend(root, { ls: { '/proj/': { error: '暫時失敗' } } });
    expect(await invoke(build(ours, backend, ['/base/', '/proj/']))).toBe('系統。');
  });

  /**
   * `FilesystemBackend.ls` 把錯誤吞成空列表，這一側看不出失敗。基座拿到的是同一份快照，所以它也看到空的，
   * 不會自己列到、讀到那份只給人叫的 `proj/deploy`（基座不讀旗標，讀到就列）。
   */
  it('掃描那次安靜地列到空的：基座看到的也是空的，不會自己列出只給人叫的那一份', async () => {
    const root = await workspace({
      'base/normal': '',
      'proj/deploy': 'disable-model-invocation: true\n',
    });
    const backend = new FlakyBackend(root, { ls: { '/proj/': { files: [] } } });
    const prompt = await invoke(build(ours, backend, ['/base/', '/proj/']));
    expect(prompt).toContain('**normal**');
    expect(prompt).not.toContain('/proj/deploy/SKILL.md');
  });

  it('不完整的那一次不凍住：下一次 invoke 重掃，完整了就照常列', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = await workspace({
      'skills/deploy': 'disable-model-invocation: true\n',
      'skills/normal': '',
    });
    const backend = new FlakyBackend(root, {
      download: { '/skills/normal/SKILL.md': 'invalid_path' },
    });
    const middleware = build(ours, backend, ['/skills/']);
    expect(await invoke(middleware)).toBe('系統。');
    const second = await invoke(middleware);
    expect(second).toContain('**normal**');
    expect(second).not.toContain('**deploy**');
  });

  it('不存在不算錯：沒有 SKILL.md 的目錄照基座跳過，其他技能照列', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = await workspace({ 'skills/normal': '' });
    await mkdir(join(root, 'skills', 'notes'), { recursive: true });
    const wrapped = await invoke(build(ours, backendAt(root), ['/skills/']));
    const base = await invoke(build(createSkillsMiddleware, backendAt(root), ['/skills/']));
    expect(wrapped).toContain('**normal**');
    expect(wrapped).toBe(base);
    expect(warn).not.toHaveBeenCalled();
  });

  it('沒有 downloadFiles 的 backend：read 說 not found 的算不存在，其他錯誤算不完整', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = await workspace({ 'skills/normal': '' });
    await mkdir(join(root, 'skills', 'notes'), { recursive: true });
    const readOnly = (fail?: string): FilesystemBackend => {
      const inner = backendAt(root);
      return {
        ls: (path: string) => inner.ls(path),
        read: async (path: string, offset?: number, limit?: number) =>
          fail !== undefined && path === '/skills/normal/SKILL.md'
            ? { error: fail }
            : inner.read(path, offset, limit),
      } as unknown as FilesystemBackend;
    };
    expect(await invoke(build(ours, readOnly(), ['/skills/']))).toContain('**normal**');
    expect(await invoke(build(ours, readOnly('EACCES: permission denied'), ['/skills/']))).toBe(
      '系統。',
    );
  });
});

describe('isHumanSpeech：/名字 叫用只掃人講的話（#1574）', () => {
  it.each([
    ['沒有來源的人話', new HumanMessage('hi /deploy'), true],
    [
      '來源是 user（插話）',
      new HumanMessage({ content: 'x', additional_kwargs: sourceKwargs({ kind: 'user' }) }),
      true,
    ],
    [
      '外掛注入',
      new HumanMessage({
        content: 'x',
        additional_kwargs: sourceKwargs({ kind: 'plugin', plugin: 'P' }),
      }),
      false,
    ],
    [
      '重複提醒（沒有來源）',
      new HumanMessage({
        content: 'x',
        additional_kwargs: { [REPEAT_REMINDER_MARKER]: { tool: 't', count: 5 } },
      }),
      false,
    ],
    [
      '基座的摘要訊息（沒有來源）',
      new HumanMessage({ content: 'x', additional_kwargs: { lc_source: 'summarization' } }),
      false,
    ],
    ['模型回覆', new AIMessage('hi /deploy'), false],
  ])('%s → %s', (_label, message, expected) => {
    expect(isHumanSpeech(message)).toBe(expected);
  });
});
