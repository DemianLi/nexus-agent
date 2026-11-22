/**
 * `history_read`、`history_search` 的工具層（[#2777](https://github.com/DemianLi/nexus-agent/issues/2777)）：讀的是哪一份日誌、
 * 沒有日誌時回什麼、參數不對時回什麼。怎麼從日誌推回那幾段在 `@nexus/core` 的 `history-recall.test.ts`；
 * 續接之後讀得回來在 `history-recall-resume.test.ts`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { SessionLog, toLoggedMessage } from '@nexus/core';
import type { SessionLookup } from '@nexus/core';
import type { ToolExec } from '@nexus/tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { EMBED_READ_ONLY_TOOLS } from './embed-profile.js';
import { createHistoryReadTool, createHistorySearchTool } from './history-recall-tools.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

// 工具只把 `exec` 交給查找；其餘欄位這裡用不到。
const exec = (agent: ToolExec['agent'] = { kind: 'root' }): ToolExec =>
  ({ callId: 'call_1', threadId: 't', agent, signal: undefined }) as unknown as ToolExec;

/** 一份摘要過一次的日誌：`said` 那一句在被摘掉的那一段裡。 */
function summarizedLog(id: string, said: string): SessionLog {
  const log = new SessionLog(id);
  log.append('turn/start', { kind: 'message', text: said });
  log.append('assistant/message', { message: toLoggedMessage(new AIMessage('好')) });
  log.append('turn/end', {});
  log.append('turn/start', { kind: 'message', text: '下一句' });
  log.append('compaction/summary', {
    cutoffIndex: 2,
    messagesBefore: 3,
    filePath: null,
    summary: toLoggedMessage(
      new HumanMessage({
        content: 'Here is a summary of the conversation to date:\n\n摘要',
        additional_kwargs: { lc_source: 'summarization' },
      }),
    ),
    beforeCall: true,
  });
  return log;
}

const found = (log: SessionLog): SessionLookup => ({
  kind: 'ok',
  address: { kind: 'root' } as Extract<SessionLookup, { kind: 'ok' }>['address'],
  log,
});

describe('讀的是這次呼叫自己的那份日誌', () => {
  const root = summarizedLog('root', 'root 說過 alpha-771');
  const child = summarizedLog('child', '子代理說過 beta-902');
  // 查找照呼叫者分到各自的日誌。
  const lookup = (call: ToolExec): SessionLookup =>
    found(call.agent?.kind === 'subagent' ? child : root);

  it('root 的呼叫讀到 root 被摘掉的那一段，讀不到子代理的', async () => {
    const result = await createHistorySearchTool(lookup).execute({ query: 'alpha-771' }, exec());
    expect(result.ok).toBe(true);
    expect(result.content).toContain('1 match for');
    const other = await createHistorySearchTool(lookup).execute({ query: 'beta-902' }, exec());
    expect(other.content).toContain('No matches for "beta-902"');
  });

  it('子代理的呼叫讀到它自己被摘掉的那一段，讀不到 root 的', async () => {
    const asChild = exec({ kind: 'subagent', runId: 'run_1' });
    const segment = child.events.find((event) => event.type === 'compaction/summary')!.seq;
    const read = await createHistoryReadTool(lookup).execute({ segment }, asChild);
    expect(read.ok).toBe(true);
    expect(read.content).toContain('User: 子代理說過 beta-902');
    expect(read.content).not.toContain('alpha-771');
  });
});

describe('讀不到的時候回一句，不拋', () => {
  it('沒接上日誌', async () => {
    const result = await createHistoryReadTool(() => ({ kind: 'not-attached' })).execute(
      { entry: 1 },
      exec(),
    );
    expect(result).toEqual({
      ok: false,
      content:
        'This conversation has no session log attached, so summarized messages cannot be read back.',
    });
  });

  it('認不出是誰的呼叫', async () => {
    const result = await createHistorySearchTool(() => ({ kind: 'unknown-caller' })).execute(
      { query: 'x' },
      exec(),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('Cannot tell which session this call belongs to');
  });

  it.each([
    [{ entry: 0 }, '"entry" must be an integer of 1 or greater.'],
    [{ entry: 1.5 }, '"entry" must be an integer of 1 or greater.'],
    [{ entry: 1, offset: -1 }, '"offset" must be an integer of 0 or greater.'],
  ])('數字不對 %j：不查日誌就回絕', async (args, message) => {
    const lookup = (): SessionLookup => {
      throw new Error('不該查到日誌');
    };
    await expect(createHistoryReadTool(lookup).execute(args, exec())).resolves.toEqual({
      ok: false,
      content: message,
    });
  });

  it('多給認不得的鍵：回絕', async () => {
    const result = await createHistoryReadTool(() => ({ kind: 'not-attached' })).execute(
      { entry: 1, pattern: 'x' },
      exec(),
    );
    expect(result.ok).toBe(false);
  });
});

describe('組裝', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexus-history-recall-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function toolResult(summarization: false | undefined): Promise<ToolMessage | undefined> {
    const model = new ScriptedChatModel({
      turns: [
        { content: '', toolCalls: [{ name: 'history_read', args: { entry: 1 } }] },
        { content: '好' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: dir }),
      checkpointer: new MemorySaver(),
      plugins: [],
      ...(summarization === false ? { summarization } : {}),
    });
    try {
      const state = (await agent.invoke(toAgentInvocation('讀回來'), {
        configurable: { thread_id: 'bare' },
      })) as { messages: readonly unknown[] };
      return state.messages.find((message): message is ToolMessage =>
        ToolMessage.isInstance(message),
      );
    } finally {
      await dispose();
    }
  }

  it('沒接日誌的組裝：工具在，呼叫它得到「沒有日誌」那一句', async () => {
    const result = await toolResult(undefined);
    expect(result?.name).toBe('history_read');
    expect(result?.text).toContain('no session log attached');
  });

  it('摘要關掉的組裝：呼叫它得不到「沒有日誌」那一句（工具沒掛）', async () => {
    const result = await toolResult(false);
    expect(result?.text).not.toContain('no session log attached');
  });

  it('兩個工具都在 embed 的唯讀白名單裡', () => {
    expect(EMBED_READ_ONLY_TOOLS).toContain('history_read');
    expect(EMBED_READ_ONLY_TOOLS).toContain('history_search');
  });
});
