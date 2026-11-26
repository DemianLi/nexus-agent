/**
 * 沙箱升級在人答了核准之後再判一次（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）：人看卡片的那段時間裡格子或核准政策
 * 換了，答核准也照換過的那一格回絕、不發 grant，兩個 loop 結局一樣。`langgraph` 接回時本體整個重跑、自然再判；`native` 在行程內等，
 * 由工具本體在答覆之後補判。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command, MemorySaver } from '@langchain/langgraph';
import {
  ApprovalPolicyController,
  createHostServicesPlugin,
  deriveApprovalChannel,
} from '@nexus/core';
import {
  CONTAINED_FILESYSTEM,
  nonWideningRefusal,
  SANDBOX_ESCALATION_TOOL_NAME,
  SandboxModeController,
  unaskedRefusal,
} from '@nexus/plugin-sandbox-policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { shippedPlugins } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

const LOOPS = ['langgraph', 'native'] as const;

const sandboxPolicyRow = (await shippedPlugins()).find((entry) => entry.id === 'sandbox-policy');
if (sandboxPolicyRow === undefined) throw new Error('出貨清單上沒有 sandbox-policy 那一列');

const TURNS: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [{ name: 'write_file', args: { file_path: '/note.txt', content: '寫了' } }],
  },
  {
    content: '',
    toolCalls: [
      {
        name: SANDBOX_ESCALATION_TOOL_NAME,
        args: {
          file_path: '/note.txt',
          sandbox_permissions: 'workspace-write',
          justification: '使用者要這個檔',
        },
      },
    ],
  },
  { content: '收工。' },
];

interface StreamEvent {
  readonly method: string;
  readonly params: { readonly namespace?: readonly string[]; readonly data?: { values?: unknown } };
}

interface Streaming {
  streamEvents(input: unknown, config: object): Promise<AsyncIterable<StreamEvent> & Projections>;
  getState(
    config: object,
  ): Promise<{ values: { messages?: readonly { content: unknown; getType?: () => string }[] } }>;
}

/** langchain 在 v3 run 物件上掛的每顆工具呼叫投影；`langgraph` 那條才有，沒人讀的 rejection 標成已處理（#346）。 */
interface Projections {
  readonly toolCalls?: AsyncIterable<{ readonly output: Promise<unknown> }>;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-escalation-recheck-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Built {
  readonly controller: SandboxModeController;
  readonly approvalPolicy: ApprovalPolicyController;
  drain(input: unknown): Promise<StreamEvent[]>;
  toolTexts(): Promise<string[]>;
  dispose(): Promise<void>;
}

async function assemble(loop: (typeof LOOPS)[number]): Promise<Built> {
  const controller = new SandboxModeController('read-only');
  const approvalPolicy = new ApprovalPolicyController('ask');
  const backend = new ContainedFilesystemBackend({
    rootDir: root,
    mode: controller.source,
    grants: controller,
  });
  const { agent, dispose } = await createNexusAgent({
    model: new ScriptedChatModel({ turns: TURNS }),
    backend,
    plugins: [
      createHostServicesPlugin({
        backend,
        approvalPolicy,
        channel: deriveApprovalChannel({ awaitsAnswer: true }),
        fsContainment: CONTAINED_FILESYSTEM,
        sandboxPolicy: { controller, rootDir: root },
      }),
      sandboxPolicyRow!,
    ],
    checkpointer: new MemorySaver(),
    agentLoop: loop,
  });
  const streaming = agent as unknown as Streaming;
  const options = { version: 'v3', configurable: { thread_id: 't' } };
  const drain = async (input: unknown): Promise<StreamEvent[]> => {
    const events: StreamEvent[] = [];
    const run = await streaming.streamEvents(input, options);
    const ignore = (): void => undefined;
    if (run.toolCalls !== undefined) {
      void (async () => {
        for await (const call of run.toolCalls!) call.output.catch(ignore);
      })().catch(ignore);
    }
    for await (const event of run) events.push(event);
    return events;
  };
  const toolTexts = async (): Promise<string[]> =>
    ((await streaming.getState(options)).values.messages ?? [])
      .filter((message) => message.getType?.() === 'tool')
      .map((message) => String(message.content));
  return { controller, approvalPolicy, drain, toolTexts, dispose };
}

/** 一段事件交出的 root 那一層中斷 id。 */
function interruptIds(events: readonly StreamEvent[]): string[] {
  return events
    .filter((event) => event.method === 'updates' && (event.params.namespace ?? []).length === 0)
    .flatMap((event) => {
      const values = event.params.data?.values;
      return Array.isArray(values)
        ? values.flatMap((value: { id?: unknown }) =>
            typeof value.id === 'string' ? [value.id] : [],
          )
        : [];
    });
}

describe.each(LOOPS)('%s：沙箱升級答了核准之後再判一次', (loop) => {
  it.each([
    [
      '格子換成 workspace-write：不加寬了，照不加寬回絕',
      (built: Built): void => void built.controller.switchTo('workspace-write'),
      nonWideningRefusal('workspace-write', 'workspace-write'),
    ],
    [
      '核准政策切到 never：照政策回絕',
      (built: Built): void => void built.approvalPolicy.switchTo('never'),
      unaskedRefusal('approval-never', 'workspace-write'),
    ],
  ] as const)('%s，不發 grant', async (_name, change, refusal) => {
    const built = await assemble(loop);
    try {
      const [id] = interruptIds(
        await built.drain({ messages: [{ role: 'user', content: '動手。' }] }),
      );
      expect(id).toBeDefined();

      change(built);
      await built.drain(new Command({ resume: { [id!]: { decisions: [{ type: 'approve' }] } } }));
      const texts = await built.toolTexts();
      expect(texts).toHaveLength(2);
      expect(texts[1]).toContain(refusal);
      expect(built.controller.peekGrant()).toBeUndefined();
    } finally {
      await built.dispose();
    }
  });
});
