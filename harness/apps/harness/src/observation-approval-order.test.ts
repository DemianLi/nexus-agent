/**
 * 要核准的寫檔，核准閘門先問、先讀後改後擋：沒讀過的檔照樣先出核准卡，策略的拒絕排在核准之後
 * （[#2416](https://github.com/DemianLi/nexus-agent/issues/2416)）。
 *
 * 看的是會話日誌：`approval/asked` 出現在那次呼叫的 `tool/result` 之前，而且那則結果的碼是核准的，不是 `FS_NOT_OBSERVED`。
 * 磁碟上的檔不變。
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import {
  ApprovalPolicyController,
  approvalGatePlugin,
  createHostServicesPlugin,
} from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const ORIGINAL = '原本的內容';

/** 每次 `write_file` 都要核准。 */
const ASK_WRITE: PluginEntry = {
  plugin: {
    name: 'ask-write',
    apply(registry) {
      registry.approvals.gate((exec, next) =>
        exec.name === 'write_file' ? { kind: 'ask', reason: '寫檔要核准' } : next(),
      );
    },
  },
};

describe('要核准的寫檔：核准卡先出', () => {
  it('沒讀過的既有檔：日誌先有 approval/asked，結果的碼是核准的', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-approval-order-'));
    await writeFile(join(root, 'notes.md'), ORIGINAL);
    const controller = new ApprovalPolicyController('never');
    const built = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          {
            content: '',
            toolCalls: [{ name: 'write_file', args: { file_path: '/notes.md', content: '蓋掉' } }],
          },
          { content: '好了。' },
        ],
      }),
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      checkpointer: new MemorySaver(),
      plugins: [
        createHostServicesPlugin({ approvalPolicy: controller }),
        { plugin: approvalGatePlugin },
        ASK_WRITE,
      ],
      approvals: { policy: controller.source },
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'approval-order');
    const detach = built.attachSession(pump.sessions);
    try {
      await pump.submit({ kind: 'message', text: '動手。' });
      await pump.whenIdle();
      const main = pump.sessions.list().find((session) => session.address.kind !== 'subagent');
      const events = main?.log.events ?? [];
      const types = events.map((event) => event.type);
      const asked = types.indexOf('approval/asked');
      const result = types.indexOf('tool/result');
      expect(asked).toBeGreaterThanOrEqual(0);
      expect(result).toBeGreaterThan(asked);
      const error = (events[result]?.data as { error?: { name?: string; code?: string } }).error;
      expect(error?.name).toBe('ApprovalDenied');
      expect(error?.code).not.toBe('FS_NOT_OBSERVED');
      expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(ORIGINAL);
    } finally {
      detach();
      await built.dispose();
    }
  });
});
