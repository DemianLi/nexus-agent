/**
 * `skill.list` 走完 wire（[#1574](https://github.com/DemianLi/nexus-agent/issues/1574) N0929，驗收紅燈 1、3）。
 *
 * 真的 `runServe`（出貨清單、每條 thread 的組裝、wire handler），模型換成腳本提供者，工作區用 `workspaceRootOf` 固定成暫存目錄
 * （不配私有根，`/skills/` 就是工作區底下的 `skills/`）。量的是 HTTP 上的原始回應，不經 client 的逐格重建——
 * 「不帶正文」要在線上就成立，不是 client 替伺服器丟掉。
 *
 * **零憑證、零外部連線**。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import { commandPath, createWireClient, SKILL_METHODS } from '@nexus/wire';
import { createDeepAgent, StateBackend } from 'deepagents';
import { afterEach, describe, expect, it } from 'vitest';

import {
  emptyCommandPoint,
  exchangeServeToken,
  fetchWithCookie,
  loopbackRequest,
  noSessions,
  TEST_BROWSER_AUTH,
} from './fixtures.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { SkillCatalog } from './skill-catalog-wire.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const temporary: string[] = [];
const serves: ScriptedServe[] = [];

afterEach(async () => {
  for (const serve of serves.splice(0)) await serve.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 工作區：`<dir>/<名字>/SKILL.md`（`dir` 預設 `skills`），frontmatter 可以多帶幾行。 */
function workspace(
  skills: Record<string, string>,
  more: Record<string, Record<string, string>> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-skill-list-ws-'));
  chmodSync(root, 0o700);
  temporary.push(root);
  const layout = Object.entries({ skills, ...more }).flatMap(([dir, entries]) =>
    Object.entries(entries).map(([name, frontmatter]) => [dir, name, frontmatter] as const),
  );
  for (const [dir, name, frontmatter] of layout) {
    mkdirSync(join(root, dir, name), { recursive: true });
    writeFileSync(
      join(root, dir, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} 的說明。\n${frontmatter}---\n\n${name} 的正文。\n`,
    );
  }
  return root;
}

/** 名字故意不照字母序寫進來：`normal` 先、`deploy` 後，排序要在伺服器端做。 */
const STANDARD = {
  normal: 'whenToUse: 平常用。\n',
  deploy: 'disable-model-invocation: true\n',
  'model-only': 'user-invocable: false\n',
};

/**
 * 起一台 serve，回打 `skill.list` 拿原始 JSON 的函式；伺服器日誌（含 warn）收進 `lines`。
 * 給了 `ws` 就是 `--workspace`，預設把每條 thread 的可寫根固定成它（`productPlacer: true` 改走產品路徑的 placer）。
 */
async function serveOn(
  ws: string | undefined,
  extraRows = '',
  options: { readonly productPlacer?: boolean } = {},
) {
  const lines: string[] = [];
  const serve = await startScriptedServe([{ content: '好。' }], {
    ...(ws !== undefined && { workspace: ws }),
    ...(ws !== undefined && options.productPlacer !== true && { workspaceRootOf: () => ws }),
    extraRows,
    log: (line) => void lines.push(line),
  });
  serves.push(serve);
  const fetch = fetchWithCookie(await exchangeServeToken(serve.running.authenticatedUrl));
  const list = async (threadId: string): Promise<unknown> => {
    const response = await fetch(
      new URL(commandPath(threadId, 'skill.list'), serve.running.url).toString(),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1, method: 'skill.list' }),
      },
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  return { list, lines };
}

it('SKILL_METHODS 只有 skill.list', () => {
  expect([...SKILL_METHODS]).toEqual(['skill.list']);
});

describe('紅燈 1：只列人叫得到的、依名字排序、不帶正文', () => {
  it('normal／deploy（只給人叫）／model-only（user-invocable: false）：回 [deploy, normal]，沒有 model-only，每列沒有正文', async () => {
    const ws = workspace(STANDARD);
    const { list } = await serveOn(ws);
    // 新開的 thread、一句話都還沒說：打 `/` 多半發生在第一句之前。
    const raw = (await list('t-fresh')) as { type: string; result: { skills: unknown[] } };
    expect(raw.type).toBe('success');
    expect(raw.result.skills).toStrictEqual([
      {
        name: 'deploy',
        path: '/skills/deploy/SKILL.md',
        description: 'deploy 的說明。',
        modelInvocable: false,
      },
      {
        name: 'normal',
        path: '/skills/normal/SKILL.md',
        description: 'normal 的說明。',
        whenToUse: '平常用。',
        modelInvocable: true,
      },
    ]);
    expect(JSON.stringify(raw)).not.toContain('的正文。');
  }, 60000);

  it('兩個來源：第一次出現是 [zeta, alpha]，回的是依名字排過的 [alpha, zeta]', async () => {
    // 同一個目錄底下 `ls` 回來本來就是字母序，量不到排序；跨來源時第一次出現的順序才跟名字序不同。
    const late =
      `- insert:\n    - id: late-skills\n      name: '@nexus/plugin-skills'\n` +
      `      config:\n        sources:\n          - '/late/'\n`;
    const { list } = await serveOn(workspace({ zeta: '' }, { late: { alpha: '' } }), late);
    const raw = (await list('t-two')) as { result: { skills: { name: string }[] } };
    expect(raw.result.skills.map((skill) => skill.name)).toEqual(['alpha', 'zeta']);
  }, 60000);
});

describe('產品路徑的 placer（不給 workspaceRootOf）', () => {
  it('新 thread、一句話都還沒說：列的是 `--workspace/skills/`，路徑在 `/shared/skills/` 底下', async () => {
    // 新 thread 配私有根、`--workspace` 退成唯讀的 `/shared`（#1775，`docs/operations.md`〈私有根〉）。出廠來源 `/skills/` 在這種 thread 上
    // 換成 `/shared/skills/`（[#1928](https://github.com/DemianLi/nexus-agent/issues/1928)），模型清單與 `/名字` 見 `skills-shared-workspace.test.ts`。
    const { list, lines } = await serveOn(workspace(STANDARD), '', { productPlacer: true });
    const raw = (await list('t-placer')) as {
      type: string;
      result: { skills: { name: string; path: string }[] };
    };
    expect(raw.type).toBe('success');
    expect(raw.result.skills.map((skill) => [skill.name, skill.path])).toEqual([
      ['deploy', '/shared/skills/deploy/SKILL.md'],
      ['normal', '/shared/skills/normal/SKILL.md'],
    ]);
    expect(lines.join('\n')).not.toContain('[技能]');
  }, 60000);
});

/**
 * 沒有磁碟根的 thread：墊底是只在圖內讀得到的記憶體 FS，`/skills/` 在那上面等於「這個來源沒有檔案提供者」——回空、**不 warn**
 * （issuecomment-6361790065）。路由到磁碟的來源（`/shared/skills/`）照常讀；給了 `--workspace` 的新 thread 有共用區，
 * 出廠的 `/skills/` 換成 `/shared/skills/`（#1928），不落在墊底那一格。
 */
describe('沒有磁碟根：圖內才讀得到的來源不掃、不 warn', () => {
  const sharedSkills =
    `- insert:\n    - id: shared-skills\n      name: '@nexus/plugin-skills'\n` +
    `      config:\n        sources:\n          - '/shared/skills/'\n`;
  const noPersistence = '- id: session-persistence\n  disabled: true\n';

  it('serve 沒給 --workspace：{ skills: [] }，不 warn', async () => {
    const { list, lines } = await serveOn(undefined);
    expect(await list('t-no-ws')).toMatchObject({ type: 'success', result: { skills: [] } });
    expect(lines.join('\n')).not.toContain('[技能]');
  }, 60000);

  it('有 --workspace、落盤關掉：私有根在記憶體，出廠的 /skills/ 換到共用區（磁碟）照常列，不 warn', async () => {
    const { list, lines } = await serveOn(workspace(STANDARD), noPersistence, {
      productPlacer: true,
    });
    const raw = (await list('t-no-log')) as {
      result: { skills: { name: string; path: string }[] };
    };
    expect(raw.result.skills.map((skill) => [skill.name, skill.path])).toEqual([
      ['deploy', '/shared/skills/deploy/SKILL.md'],
      ['normal', '/shared/skills/normal/SKILL.md'],
    ]);
    expect(lines.join('\n')).not.toContain('[技能]');
  }, 60000);

  it('落盤關掉、另加 /shared/skills/：出廠的 /skills/ 也換成 /shared/skills/，重複的只掃一次，每份只列一次，不 warn', async () => {
    const { list, lines } = await serveOn(workspace(STANDARD), `${noPersistence}${sharedSkills}`, {
      productPlacer: true,
    });
    const raw = (await list('t-shared')) as {
      result: { skills: { name: string; path: string }[] };
    };
    expect(raw.result.skills.map((skill) => [skill.name, skill.path])).toEqual([
      ['deploy', '/shared/skills/deploy/SKILL.md'],
      ['normal', '/shared/skills/normal/SKILL.md'],
    ]);
    expect(lines.join('\n')).not.toContain('[技能]');
  }, 60000);
});

describe('紅燈 3：沒掛、掛了沒有、掃描不完整，三種分得出來', () => {
  it('停掉 skills 那一列：not_supported', async () => {
    const { list } = await serveOn(workspace(STANDARD), '- id: skills\n  disabled: true\n');
    expect(await list('t-off')).toMatchObject({ type: 'error', error: 'not_supported' });
  }, 60000);

  it('掛了但工作區沒有技能：{ skills: [] }，不 warn', async () => {
    const { list, lines } = await serveOn(workspace({}));
    expect(await list('t-empty')).toMatchObject({ type: 'success', result: { skills: [] } });
    expect(lines.join('\n')).not.toContain('[技能]');
  }, 60000);

  // root 讀得到 0o000 的檔，量不到「讀不到」（同 `fs-tool-errors.test.ts`）。
  it.skipIf(process.getuid?.() === 0)(
    '掃描不完整（有一份讀不到）：{ skills: [] }，記一行 warn',
    async () => {
      const ws = workspace(STANDARD);
      chmodSync(join(ws, 'skills', 'model-only', 'SKILL.md'), 0o000);
      const { list, lines } = await serveOn(ws);
      expect(await list('t-flaky')).toMatchObject({ type: 'success', result: { skills: [] } });
      expect(lines.join('\n')).toContain(
        '[技能] thread "t-flaky" 技能清單這一次是空的：掃描不完整',
      );
    },
    60000,
  );
});

describe('清單本身拋錯', () => {
  it('unknown_error，原因進日誌，不上線（#2230）', async () => {
    const skillCatalog: SkillCatalog = async () => {
      throw new Error('磁碟不見了');
    };
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
        skillCatalog,
        dispose: async () => undefined,
      }),
    });
    try {
      const client = createWireClient({
        baseUrl: 'http://skill.test',
        fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
      });
      expect(await client.skillList('t')).toEqual({
        kind: 'rejected',
        code: 'unknown_error',
        message: '技能清單讀不出來，原因記在 serve 的日誌',
      });
    } finally {
      await handler.close();
    }
  });
});
