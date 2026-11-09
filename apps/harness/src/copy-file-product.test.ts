/**
 * `copy_file` 走產品組裝（[#2289](https://github.com/DemianLi/nexus-agent/issues/2289)）：`createNexusAgent`＋腳本模型＋`ThreadPump`，
 * backend 是組裝點真的組出來的那幾層 composite（工作區、`/shared/` 共用區、`/attachments/` 附件、工具結果暫存、會話歷史），
 * 路由由 `@nexus/core` 的 `copyFileOf` 穿過去。量模型拿到的句子、磁碟、會話日誌那一筆 `tool/result` 的 `meta`。
 *
 * - 跨路由：共用區與附件當來源，複製進工作區；共用區、附件、會話歷史當目的地都被拒。
 * - `permissions` 規則照產品的 fold 擋。
 * - 子代理的 `copy_file`：`meta` 只落在子代理自己的日誌，root 那一份沒有（改動摘要照樣帶 `copiedFrom`，在 `workspace-changes.test.ts`）。
 *
 * 升級詢問在 `sandbox-escalation.test.ts`（產品的控制器建在組裝點裡，那一檔有現成的組法）。
 *
 * **零憑證、零外部連線**：模型是腳本，儲存放 `/var/tmp`。
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { AttachmentRef, PluginEntry, SessionEvent } from '@nexus/core';
import { GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { AttachmentStore, attachmentsRootOf, ATTACHMENTS_PREFIX } from './attachment-store.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

let base: string;
let workspace: string;
let shared: string;
let store: AttachmentStore;

beforeEach(async () => {
  base = await mkdtemp(join('/var/tmp', 'nexus-copy-product-'));
  workspace = join(base, 'workspace');
  shared = join(base, 'shared');
  await mkdir(workspace);
  await mkdir(shared);
  store = new AttachmentStore(attachmentsRootOf(join(base, 'home')));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const copy = (from: string, to: string): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name: 'copy_file', args: { source_path: from, destination_path: to } }],
});

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/** 產品把工具拋出的錯包成這一句交給模型。 */
const FAILED = 'Error: 工具 copy_file 執行失敗：';

const exists = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => undefined)) !== undefined;

/** 擋 `/secret/**` 與 `/shared/secret/**` 的部署規則。 */
const vault: PluginEntry = {
  plugin: {
    name: 'vault',
    apply: (registry) => void registry.permissions.deny(['/secret/**', '/shared/secret/**']),
  },
};

interface Run {
  /** root 這一輪模型拿到的每一則工具結果的文字，依出現順序。 */
  readonly texts: string[];
  /** root 日誌上每一筆 `tool/result` 的 `meta`。 */
  readonly rootMetas: unknown[];
  /** 子代理日誌上每一筆 `tool/result` 的 `meta`。 */
  readonly subagentMetas: unknown[];
}

/** 一輪：root 照腳本跑完，回模型拿到的工具結果與兩邊日誌的 `meta`。 */
async function run(
  turns: readonly ScriptedTurn[],
  options: { attachments?: readonly AttachmentRef[]; plugins?: PluginEntry[] } = {},
): Promise<Run> {
  const model = new ScriptedChatModel({ turns: [...turns, { content: '好了。' }] });
  const built = await createNexusAgent({
    model,
    backend: new ContainedFilesystemBackend({ rootDir: workspace, mode: 'workspace-write' }),
    sharedWorkspace: { rootDir: shared },
    attachments: store,
    checkpointer: new MemorySaver(),
    plugins: options.plugins ?? [],
    summarization: false,
    observationPolicy: false,
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'copy-product');
  const detach = built.attachSession(pump.sessions);
  try {
    await pump.submit({
      kind: 'message',
      text: '複製。',
      attachments: [...(options.attachments ?? [])],
    });
    await pump.whenIdle();
    const last = model.prompts.at(-1) as readonly BaseMessage[];
    const metas = (events: readonly SessionEvent[]): unknown[] =>
      events.flatMap((event) => (event.type === 'tool/result' ? [event.data.meta] : []));
    const entries = pump.sessions.list();
    return {
      texts: last.filter((m) => m.getType() === 'tool').map((m) => m.text),
      rootMetas: metas(entries.find((entry) => entry.address.kind === 'root')?.log.events ?? []),
      subagentMetas: entries
        .filter((entry) => entry.address.kind !== 'root')
        .flatMap((entry) => metas(entry.log.events)),
    };
  } finally {
    pump.close();
    detach();
    await built.dispose();
  }
}

describe('copy_file：產品組裝', () => {
  it('工作區內：照位元組複製，tool/result 的 meta 記來源、目的地、位元組數、sha256', async () => {
    const bytes = Buffer.from([0x20, 0x20, 0xb4, 0xfa, 0x0d, 0x0a]);
    await writeFile(join(workspace, 'a.bin'), bytes);
    const { texts, rootMetas } = await run([copy('/a.bin', '/b.bin')]);
    expect(texts).toEqual([`Copied /a.bin to /b.bin (6 bytes, sha256 ${sha256(bytes)})`]);
    expect(await readFile(join(workspace, 'b.bin'))).toEqual(bytes);
    expect(rootMetas).toEqual([
      {
        operation: 'copy',
        source: '/a.bin',
        destination: '/b.bin',
        bytes: 6,
        sha256: sha256(bytes),
      },
    ]);
  });

  it('跨路由：/shared/ 的檔複製進工作區', async () => {
    await writeFile(join(shared, 'input.txt'), '  縮排\n\t第二行\n');
    const { texts, rootMetas } = await run([copy('/shared/input.txt', '/output.txt')]);
    expect(texts[0]).toMatch(/^Copied \/shared\/input\.txt to \/output\.txt /u);
    expect(await readFile(join(workspace, 'output.txt'), 'utf8')).toBe('  縮排\n\t第二行\n');
    expect(rootMetas[0]).toMatchObject({ source: '/shared/input.txt', destination: '/output.txt' });
  });

  it('跨路由：這條 thread 引用過的附件複製得進工作區，沒引用過的跟不存在一樣', async () => {
    const save = async (text: string, name: string) => {
      const saved = await store.save({ data: Buffer.from(text), name });
      return { ref: { type: 'file' as const, ...saved }, path: store.modelPathOf(saved) };
    };
    const mine = await save('MINE\n', 'mine.txt');
    const other = await save('OTHER\n', 'other.txt');
    expect(mine.path.startsWith(`${ATTACHMENTS_PREFIX}/`)).toBe(true);
    const { texts } = await run([copy(mine.path, '/mine.txt'), copy(other.path, '/other.txt')], {
      attachments: [mine.ref],
    });
    expect(texts[0]).toMatch(/^Copied /u);
    expect(await readFile(join(workspace, 'mine.txt'), 'utf8')).toBe('MINE\n');
    expect(texts[1]).toBe(
      `${FAILED}Error copying '${other.path}': ENOENT: no such file or directory`,
    );
    expect(await exists(join(workspace, 'other.txt'))).toBe(false);
  });

  it('唯讀的路由當目的地：/shared/ 與附件被 fence 擋，會話歷史回 core 的固定句；磁碟都不動', async () => {
    await writeFile(join(workspace, 'a.txt'), 'x');
    const { texts } = await run([
      copy('/a.txt', '/shared/a.txt'),
      copy('/a.txt', `${ATTACHMENTS_PREFIX}/a.txt`),
      copy('/a.txt', '/conversation_history/a.txt'),
    ]);
    expect(texts[0]).toContain('[containment] 拒絕 copy');
    expect(texts[0]).toContain('唯讀');
    expect(texts[1]).toContain('[containment] 拒絕 copy');
    expect(texts[2]).toBe(
      `${FAILED}Error copying to '/conversation_history/a.txt': this location does not accept copied files`,
    );
    expect(await exists(join(shared, 'a.txt'))).toBe(false);
  });

  it('目的地已存在：拒絕、原檔不動，模型拿到換路徑或改用 edit_file 的指引', async () => {
    await writeFile(join(workspace, 'a.txt'), '新');
    await writeFile(join(workspace, 'b.txt'), '舊');
    const { texts, rootMetas } = await run([copy('/a.txt', '/b.txt')]);
    expect(texts).toEqual([
      `${FAILED}Cannot copy to /b.txt because it already exists. Choose a new path, or use edit_file to change the existing file.`,
    ]);
    expect(await readFile(join(workspace, 'b.txt'), 'utf8')).toBe('舊');
    expect(rootMetas).toEqual([undefined]);
  });

  it('permissions 規則：被擋的來源、被擋的目的地、共用區裡被擋的來源都拒絕', async () => {
    await mkdir(join(workspace, 'secret'));
    await writeFile(join(workspace, 'secret', 'key.txt'), 'KEY');
    await writeFile(join(workspace, 'a.txt'), 'x');
    await mkdir(join(shared, 'secret'));
    await writeFile(join(shared, 'secret', 'key.txt'), 'KEY');
    const { texts } = await run(
      [
        copy('/secret/key.txt', '/out.txt'),
        copy('/a.txt', '/secret/new.txt'),
        copy('/shared/secret/key.txt', '/out2.txt'),
      ],
      { plugins: [vault] },
    );
    expect(texts).toEqual([
      `${FAILED}permission denied for read on /secret/key.txt`,
      `${FAILED}permission denied for write on /secret/new.txt`,
      `${FAILED}permission denied for read on /shared/secret/key.txt`,
    ]);
    expect(await exists(join(workspace, 'out.txt'))).toBe(false);
    expect(await exists(join(workspace, 'secret', 'new.txt'))).toBe(false);
    expect(await exists(join(workspace, 'out2.txt'))).toBe(false);
  });

  it('子代理的 copy_file：檔照樣複製，meta 只在子代理的日誌，root 那一份沒有', async () => {
    await writeFile(join(workspace, 'a.txt'), 'x');
    const { rootMetas, subagentMetas } = await run([
      {
        content: '委派。',
        toolCalls: [
          {
            name: 'task',
            args: {
              description: '複製 a.txt 到 b.txt',
              subagent_type: GENERAL_PURPOSE_SUBAGENT.name,
            },
          },
        ],
      },
      copy('/a.txt', '/b.txt'),
      { content: '複製好了。' },
    ]);
    expect(await readFile(join(workspace, 'b.txt'), 'utf8')).toBe('x');
    expect(subagentMetas).toContainEqual({
      operation: 'copy',
      source: '/a.txt',
      destination: '/b.txt',
      bytes: 1,
      sha256: sha256('x'),
    });
    expect(
      rootMetas.some((meta) => (meta as { operation?: unknown } | undefined)?.operation === 'copy'),
    ).toBe(false);
  });
});
