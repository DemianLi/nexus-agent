/**
 * 路由自己的檔案政策是寫死的，但 rg 上不上 OS 沙箱要跟著會話（#1946）：沒有 Landlock 的主機用 `danger-full-access` 時，路由的根
 * 一存在，搜 `/` 就會走到路由，路由回 sandbox-unavailable 會讓基座整筆回 error。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages';

import { MemorySaver } from '@langchain/langgraph';

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { AttachmentStore } from './attachment-store.js';
import { shippedPluginsWithFullAccess, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import type { SandboxMode } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { stashSessionDirName } from './tool-result-stash.js';

vi.mock('./tool-launcher.js', async (importActual) => {
  const actual = await importActual<typeof import('./tool-launcher.js')>();
  const { directToolLauncher } = await import('./tool-process.js');
  const launcher = actual.selectToolLauncher('darwin', undefined, directToolLauncher);
  return { ...actual, productToolLauncher: () => launcher };
});

describe('沒有沙箱後端的主機上，搜 / 碰到路由', () => {
  let base: string;
  let root: string;
  let stashRoot: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'nexus-route-mode-'));
    root = join(base, 'ws');
    stashRoot = join(base, 'stash');
    await mkdir(root);
    await writeFile(join(root, 'a.txt'), 'needle\n');
    const session = join(stashRoot, stashSessionDirName('route-mode'));
    await mkdir(session, { recursive: true, mode: 0o700 });
    await writeFile(join(session, 'old.txt'), 'needle\n');
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  async function searchAll(sandbox: SandboxMode, tool: 'grep' | 'glob' = 'grep'): Promise<string> {
    const built = await createCliAgent(
      {
        live: false,
        workspace: root,
        sandbox,
        toolResultStash: { rootDir: stashRoot, session: 'route-mode' },
      },
      withScriptedModel(await shippedPluginsWithFullAccess(), [
        {
          content: '',
          toolCalls: [
            tool === 'grep'
              ? { name: 'grep', args: { pattern: 'needle', path: '/' } }
              : { name: 'glob', args: { pattern: '**/*.txt', path: '/' } },
          ],
        },
        { content: '收工。' },
      ]),
      root,
    );
    const detach = built.attachSession(built.sessions);
    try {
      const state = (await built.agent.invoke(toAgentInvocation('搜尋'), {
        configurable: { thread_id: 'route-mode' },
      })) as { messages: BaseMessage[] };
      const tool = state.messages.find((message) => message instanceof ToolMessage);
      return String(tool?.content);
    } finally {
      detach();
      await built.dispose();
    }
  }

  it('會話是 danger-full-access：退路成立，工作區與暫存的結果都在', async () => {
    for (const tool of ['grep', 'glob'] as const) {
      const result = await searchAll('danger-full-access', tool);
      expect(result).toContain('a.txt');
      expect(result).toContain('old.txt');
      expect(result).not.toContain('SANDBOX_UNAVAILABLE');
    }
  });

  it('會話是 read-only：照 fail-closed', async () => {
    expect(await searchAll('read-only')).toContain('SANDBOX_UNAVAILABLE');
    expect(await searchAll('read-only', 'glob')).toContain('SANDBOX_UNAVAILABLE');
  });

  describe('三條路由都跟著 toolMode', () => {
    const search = async (
      name: 'grep' | 'glob',
      args: Record<string, string>,
      mode: SandboxMode,
    ): Promise<string> => {
      const shared = join(base, 'shared');
      await mkdir(shared);
      await writeFile(join(shared, 'shared.txt'), 'needle\n');
      const store = new AttachmentStore(join(base, 'attachments'));
      const saved = await store.save({ data: Buffer.from('needle\n'), name: 'att.txt' });
      const model = new ScriptedChatModel({
        turns: [{ content: '', toolCalls: [{ name, args }] }, { content: '好' }],
      });
      const built = await createNexusAgent({
        model,
        checkpointer: new MemorySaver(),
        plugins: [],
        toolMode: () => mode,
        attachments: store,
        sharedWorkspace: { rootDir: shared },
        toolResultStash: { rootDir: stashRoot, session: 'route-mode' },
        summarization: false,
        observationPolicy: false,
      });
      const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'routes');
      const detach = built.attachSession(pump.sessions);
      try {
        await pump.submit({
          kind: 'message',
          text: '搜',
          attachments: [{ type: 'file', ...saved }],
        });
        await pump.whenIdle();
        const prompt = model.prompts[1] as readonly BaseMessage[];
        return prompt
          .filter((message) => message.getType() === 'tool')
          .map((message) => JSON.stringify(message.content))
          .join('\n');
      } finally {
        pump.close();
        detach();
        await built.dispose();
      }
    };

    it('grep：全開時暫存、附件、共用區的結果都在', async () => {
      const result = await search('grep', { pattern: 'needle', path: '/' }, 'danger-full-access');
      expect(result).toContain('old.txt');
      expect(result).toContain('att.txt');
      expect(result).toContain('shared.txt');
    });

    it('glob：全開時暫存、附件、共用區的結果都在', async () => {
      const result = await search('glob', { pattern: '**/*.txt', path: '/' }, 'danger-full-access');
      expect(result).toContain('old.txt');
      expect(result).toContain('att.txt');
      expect(result).toContain('shared.txt');
    });

    it('grep：非全開照 fail-closed', async () => {
      const result = await search('grep', { pattern: 'needle', path: '/' }, 'read-only');
      expect(result).toContain('SANDBOX_UNAVAILABLE');
    });
  });
});
