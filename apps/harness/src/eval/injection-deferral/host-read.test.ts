/**
 * `host-read` 候選的替身模型測試（[#2934](https://github.com/DemianLi/nexus-agent/issues/2934)）：宿主在第一個模型請求之前替模型讀一次，
 * 模型眼前出現一次 `read_file` 的呼叫與結果。
 */

import { hookStepOf } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { HumanMessage } from '@langchain/core/messages';
import { withScriptedModel } from '../../fixtures.js';
import type { ScriptedChatModel, ScriptedTurn } from '../../scripted-model.js';
import { DEFERRAL_MARKER, DEFERRAL_TASK } from './fixture.js';
import type { DeferralCase } from './fixture.js';
import { HOST_READ_ID_PREFIX, createHostReadMiddleware } from './host-read.js';
import { runDeferralCase } from './runner.js';

const scripted = (turns: readonly ScriptedTurn[]) => ({
  live: false,
  plugins: (shipped: Parameters<typeof withScriptedModel>[0]) => withScriptedModel(shipped, turns),
});

interface Message {
  readonly type: string;
  readonly text: string;
  readonly toolCalls: readonly { id?: string; name: string; args: Record<string, unknown> }[];
  readonly toolCallId?: string;
}

/** 跑一格，回每一次模型請求裡的訊息（不含系統訊息與時間讀數）。 */
async function requestsOf(testCase: DeferralCase, turns: readonly ScriptedTurn[]) {
  let model: ScriptedChatModel | undefined;
  const run = await runDeferralCase(testCase, {
    ...scripted(turns),
    onModel: (used) => {
      model = used as ScriptedChatModel;
    },
  });
  const requests: Message[][] = (model?.prompts ?? []).map((prompt) =>
    prompt
      .filter((message) => message.type !== 'system' && !message.text.startsWith('Time sampled'))
      .map((message) => {
        const calls = (message as { tool_calls?: Message['toolCalls'] }).tool_calls ?? [];
        const id = (message as { tool_call_id?: string }).tool_call_id;
        return {
          type: message.type,
          text: message.text,
          toolCalls: calls,
          ...(id !== undefined && { toolCallId: id }),
        };
      }),
  );
  return { run, requests };
}

const cell = (
  file: 'large' | 'small',
  arm: 'deferred' | 'inline',
  position: 'head' | 'tail',
  variant?: 'host-read',
): DeferralCase => ({ file, arm, position, ...(variant !== undefined && { variant }) });

const readOf = (args: Record<string, unknown>): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name: 'read_file', args }],
});

describe('host-read', () => {
  it('小檔、規則在檔頭：第一個請求依序是使用者那句、宿主的 read_file 呼叫、它的結果；規則在第一頁，模型沒自己讀', async () => {
    const { run, requests } = await requestsOf(cell('small', 'deferred', 'head', 'host-read'), [
      { content: 'ok' },
    ]);
    const first = requests[0] ?? [];
    expect(first.map((message) => message.type)).toEqual(['human', 'ai', 'tool']);
    expect(first[0]?.text).toBe(DEFERRAL_TASK);
    expect(first[1]?.toolCalls).toEqual([
      {
        id: `${HOST_READ_ID_PREFIX}1`,
        name: 'read_file',
        args: { file_path: '/AGENTS.md' },
        type: 'tool_call',
      },
    ]);
    expect(first[2]?.toolCallId).toBe(`${HOST_READ_ID_PREFIX}1`);
    expect(first[2]?.text).toContain(DEFERRAL_MARKER);
    expect(first[2]?.text).toContain('     1\t# 專案規矩');
    expect(first[2]?.text.endsWith('(End of file - total 33 lines)')).toBe(true);
    // 使用者訊息裡沒有指標，也沒有指示那一則。
    expect(
      first.some(
        (message) => message.type === 'human' && message.text.includes('<system-reminder>'),
      ),
    ).toBe(false);
    expect(run).toMatchObject({
      deferred: true,
      ruleInjected: true,
      readCalls: 0,
      ruleRead: false,
      requests: 1,
    });
  }, 60000);

  it('大檔、規則在檔尾：第一頁沒有規則、結尾有續讀提示；模型自己帶 offset 再讀才算一次、讀到規則', async () => {
    const { run, requests } = await requestsOf(cell('large', 'deferred', 'tail', 'host-read'), [
      readOf({ file_path: '/AGENTS.md', offset: 747 }),
      { content: `檔名如下。\n核可編號 ${DEFERRAL_MARKER}` },
    ]);
    const hostPage = requests[0]?.[2]?.text ?? '';
    expect(hostPage).not.toContain(DEFERRAL_MARKER);
    expect(
      hostPage.endsWith('(Output capped. Showing lines 1-747. Use offset=747 to continue.)'),
    ).toBe(true);
    expect(Buffer.byteLength(hostPage, 'utf8')).toBeLessThan(51_200 + 8000);
    expect(requests[1]?.at(-1)?.text).toContain(DEFERRAL_MARKER);
    expect(run).toMatchObject({
      deferred: true,
      ruleInjected: false,
      readCalls: 1,
      ruleRead: true,
      followed: true,
      requests: 2,
    });
  }, 60000);

  it('大檔、規則在檔尾、模型不續讀：規則不在請求裡、算沒讀', async () => {
    const { run } = await requestsOf(cell('large', 'deferred', 'tail', 'host-read'), [
      { content: '檔名如下。' },
    ]);
    expect(run).toMatchObject({
      ruleInjected: false,
      readCalls: 0,
      ruleRead: false,
      followed: false,
    });
  }, 60000);

  it('宿主讀回的字串，逐字等於模型自己叫真的 read_file 得到的（小檔與大檔第一頁）', async () => {
    for (const [file, position] of [
      ['small', 'head'],
      ['large', 'tail'],
    ] as const) {
      const host = await requestsOf(cell(file, 'deferred', position, 'host-read'), [
        { content: 'ok' },
      ]);
      const own = await requestsOf(cell(file, 'deferred', position), [
        readOf({ file_path: '/AGENTS.md' }),
        { content: 'ok' },
      ]);
      const hostText = host.requests[0]?.[2]?.text;
      const ownText = own.requests[1]?.at(-1)?.text;
      expect(hostText, `${file}/${position}`).toBeDefined();
      expect(hostText, `${file}/${position}`).toBe(ownText);
    }
  }, 120000);

  it('放得下時沒有宿主的讀：請求裡沒有那次呼叫，規則隨指示那一則進來', async () => {
    const { run, requests } = await requestsOf(cell('large', 'inline', 'head', 'host-read'), [
      { content: 'ok' },
    ]);
    const first = requests[0] ?? [];
    expect(first.some((message) => message.toolCalls.length > 0 || message.type === 'tool')).toBe(
      false,
    );
    expect(run).toMatchObject({ deferred: false, ruleInjected: true, readCalls: 0 });
  }, 60000);
});

describe('host-read 的 middleware', () => {
  /** 一個放得下 backend 讀檔的最小 registry：只有這顆 middleware 用得到的格子。 */
  function harness(content: string) {
    const backend = { read: async () => ({ content }) };
    const handle = {
      backend: () => backend,
      sharedWorkspacePrefix: () => undefined,
    };
    const registry = {
      middleware: {},
      services: { get: (name: string) => (name === 'fs' ? handle : undefined) },
      sessions: { forCall: () => ({ kind: 'not-attached' as const }) },
    };
    return { registry };
  }

  it('同一條 thread 第二次 invoke 不再讀：判準在 state 的訊息上', async () => {
    const { registry } = harness('x'.repeat(5000));
    const middleware = createHostReadMiddleware(registry as never, {
      maxBytes: 1024,
      maxSourceBytes: 1_048_576,
    });
    const step = hookStepOf(middleware, 'beforeAgent')?.step;
    expect(step).toBeDefined();
    const runtime = {
      configurable: { thread_id: 't', checkpoint_ns: 'AgentInstructionsMiddleware.before_agent:1' },
    };
    const first = (await step?.({ messages: [new HumanMessage('hi')] }, runtime)) as
      { messages: { type: string }[] } | undefined;
    expect(first?.messages.map((message) => message.type)).toEqual(['ai', 'tool']);
    const second = await step?.(
      { messages: [new HumanMessage('hi'), ...(first?.messages ?? [])] },
      runtime,
    );
    expect(second).toBeUndefined();
  });
});
