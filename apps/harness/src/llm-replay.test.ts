/**
 * 重放模型（#1556 C077）：在真的 serve 上吐回錄好的訊息，落盤的那一則要跟錄的逐欄相同。
 *
 * 「推得回同一則」是整個 snapshot 層的前提：重放出來的日誌跟夾具比，比得過的前提是重放模型吐出去、經 LangChain 組成一則、
 * 再由記錄器落盤的那一則，跟夾具裡那一則一樣。真模型才有的幾格（推理區塊、`response_metadata`、用量細項、供應商的訊息 id）
 * 腳本模型造不出來，所以這裡手寫一則五樣都齊的（形狀照 serve 的真模型日誌），走真的 serve。
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LoggedMessage, SessionEvent } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { TIME_CONTEXT_OFF_PATCH_ROWS, foldTurn, serveClient } from './fixtures.js';
import { projectKey, sessionPathsIn } from './jsonl-session-store.js';
import { ReplayChatModel } from './llm-replay.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/**
 * 一則五樣都齊的回覆：推理、內文、工具呼叫、用量（含細項）、結束原因與模型名。形狀照 serve 走真模型落盤的那種
 * （nemotron-3-super，`~/.nexus-agent-evidence/2026-10-06-live-1103/logs/p1103-11.jsonl`）：content 是標準區塊，
 * `response_metadata` 帶 `output_version: v1`、兩格 `null`。
 */
function reply(options: {
  id: string;
  blocks: readonly Record<string, unknown>[];
  finishReason: string;
  input: number;
  output: number;
}): LoggedMessage {
  const toolCalls = options.blocks.filter((block) => block.type === 'tool_call');
  return {
    type: 'ai',
    data: {
      id: options.id,
      content: options.blocks,
      usage_metadata: {
        input_tokens: options.input,
        output_tokens: options.output,
        total_tokens: options.input + options.output,
        input_token_details: { cache_read: 4336 },
        output_token_details: { reasoning: 45 },
      },
      response_metadata: {
        output_version: 'v1',
        model_provider: 'openai',
        model_name: 'nvidia/nemotron-3-super-120b-a12b',
        system_fingerprint: null,
        service_tier: null,
        finish_reason: options.finishReason,
      },
      tool_calls: toolCalls,
      invalid_tool_calls: [],
      content_blocks: options.blocks,
      additional_kwargs: {},
    },
  } as unknown as LoggedMessage;
}

function toolReply(): LoggedMessage {
  return reply({
    id: 'chatcmpl-replay-0',
    blocks: [
      { type: 'reasoning', reasoning: '使用者要回聲，叫 echo。' },
      { type: 'text', text: '先回聲一次。' },
      { type: 'tool_call', id: 'call_replay_0', name: 'echo', args: { message: '重放' } },
    ],
    finishReason: 'tool_use',
    input: 5543,
    output: 133,
  });
}

function finalReply(): LoggedMessage {
  return reply({
    id: 'chatcmpl-replay-1',
    blocks: [
      { type: 'reasoning', reasoning: '工具成功，收尾。' },
      { type: 'text', text: '回聲回來了。' },
    ],
    finishReason: 'stop',
    input: 5621,
    output: 74,
  });
}

function replayPatch(script: readonly LoggedMessage[]): string {
  return `- insert:
    - id: replay
      name: '#settings/replay-model'
      config: ${JSON.stringify({ script })}
- id: agent-default-model
  config:
    provider: replay
${TIME_CONTEXT_OFF_PATCH_ROWS}`;
}

/** 落盤那幾則回覆的 `data`。 */
async function loggedReplies(root: string, threadId: string): Promise<Record<string, unknown>[]> {
  const { log } = sessionPathsIn(join(root, projectKey(process.cwd())), threadId);
  const events = (await readFile(log, 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as SessionEvent);
  return events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => (event as SessionEvent<'assistant/message'>).data.message.data as Record<string, unknown>);
}

describe('ReplayChatModel', () => {
  it('在真的 serve 上吐回的回覆，落盤的跟錄的逐欄相同', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-replay-'));
    const patch = join(dir, 'replay.patch.yml');
    const script = [toolReply(), finalReply()];
    await writeFile(patch, replayPatch(script), 'utf8');
    const root = join(dir, 'sessions');
    running = (await runServe({
      argv: ['--port', '0', '--patch', patch, '--session-log', root],
      log: () => undefined,
      env: {},
    })) as RunningServe;

    const client = await serveClient(running);
    const events = await client.openEvents('replay');
    await client.runStart('replay', '回聲一次。');
    await foldTurn(events);
    await events.return?.(undefined);
    await running.close();
    running = undefined;

    expect(await loggedReplies(root, 'replay')).toEqual(script.map((logged) => logged.data));
  }, 60_000);

  it('多叫一次就拋，訊息講錄了幾次', async () => {
    const model = new ReplayChatModel({ script: [finalReply()] });
    await model.invoke('第一次');
    expect(model.consumed).toBe(1);
    await expect(model.invoke('第二次')).rejects.toThrow(
      '重放腳本只錄了 1 次模型呼叫，這一次是第 2 次',
    );
  });
});
