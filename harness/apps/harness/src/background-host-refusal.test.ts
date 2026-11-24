/**
 * **host 拒絕派出背景子代理時，日誌帶 dsh `SubagentError` 的碼**（[#1046](https://github.com/DemianLi/nexus-agent/issues/1046)）。
 *
 * 修之前 `background-delegation.ts` 的 `catch` 只把 `BackgroundSubagentError` 的訊息交給 `toolRefusal`，`tool/result`
 * 沒有 `error`，追溯時只能解析給模型看的中文。dsh 同類拒絕是 `SubagentError`（`HarnessError`），註冊表取 `{ name, code }`
 * 寫進 `tool/result`，見 `background-subagents.ts` 的 `backgroundRefusalInfo`。
 *
 * **只有名額滿了這一種有產品路徑**：`closed` 在 `subagent` 工具這條路上沒有生產者（收線先清掉 delegation 的 host 才關它），
 * 翻譯表由 `background-subagents.test.ts` 釘。
 *
 * **全走產品組裝**：`createNexusAgent({ backgroundSubagents: { maxActive: 1 } })`＋腳本模型＋`ThreadPump`＋`attachSession`，
 * 日誌經 `attachSessionPersistence` 落到 JSONL，再用離線掃描那一份讀法讀回來。root 同一則回覆派兩個背景子代理，第一個卡在
 * `hold` 上佔住名額，第二個被拒。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { TOOL_ERROR_PREFIX, attachSessionPersistence, fromLoggedMessage } from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionEventMap } from '@nexus/core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { formatScanReport, readSessionLogs, scanSessionLog } from './eval/session-scan.js';
import { createJsonlSessionStore } from './jsonl-session-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

let dir: string;
let reported: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-background-refusal-'));
  reported = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const resultOf = (events: readonly SessionEvent[], callId: string) =>
  events.find(
    (event) =>
      event.type === 'tool/result' &&
      (event.data as SessionEventMap['tool/result']).callId === callId,
  )?.data as SessionEventMap['tool/result'] | undefined;

it('名額滿了：被拒的那一顆記 SubagentError／ACTIVATION_LIMIT_REACHED，訊息照舊可讀；掃描只報這一次', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker: PluginEntry = {
    plugin: {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          model: new ScriptedChatModel({
            turns: [
              { content: '', toolCalls: [{ name: 'hold', id: 'hold-call', args: {} }] },
              { content: '甲做完' },
            ],
          }) as never,
        });
        registry.tools.register(
          tool(async () => (await held, '放行了'), {
            name: 'hold',
            description: '等放行。',
            schema: z.object({}),
          }),
        );
      },
    },
  };
  const store = createJsonlSessionStore({ rootDir: join(dir, 'logs') });
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        {
          content: '委派兩個。',
          toolCalls: [
            {
              name: 'subagent',
              id: 'call-a',
              args: { description: '甲', subagent_type: 'worker', run_in_background: true },
            },
            {
              name: 'subagent',
              id: 'call-b',
              args: { description: '乙', subagent_type: 'worker', run_in_background: true },
            },
          ],
        },
        { content: '根收尾' },
        { content: '收到結算' },
        { content: '再收一次' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [worker],
    backend: new ContainedFilesystemBackend({
      rootDir: join(dir, 'workspace'),
      mode: 'workspace-write',
    }),
    backgroundSubagents: { maxActive: 1 },
    onInvariantViolation: (error) => reported.push(`不變量：${error.message}`),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'refusal-root');
  const detach = built.attachSession(pump.sessions);
  const persistence = attachSessionPersistence(pump.sessions, store);
  let subagentSessions: number;
  try {
    await pump.submit({ kind: 'message', text: '委派' });
    await pump.whenIdle();

    const rootEvents = pump.sessions.root.events;
    // 第一顆派出去了（沒有碼、不是錯）。
    const accepted = resultOf(rootEvents, 'call-a');
    expect(accepted?.isError).toBe(false);
    expect(accepted?.error).toBeUndefined();
    // 第二顆：碼照 dsh，給模型的那一句照舊。
    const refused = resultOf(rootEvents, 'call-b')!;
    const { message, ...data } = refused;
    expect(data).toEqual({
      callId: 'call-b',
      isError: true,
      error: { name: 'SubagentError', code: 'ACTIVATION_LIMIT_REACHED' },
    });
    expect(fromLoggedMessage(message!).text).toBe(
      `${TOOL_ERROR_PREFIX}背景子代理已達並存上限 1（現在有 1 個在跑）；等其中一個做完再派。`,
    );

    // 被拒的沒有開日誌；放行第一個，等它收尾再收線。
    const subagents = () => pump.sessions.list().filter((each) => each.address.kind === 'subagent');
    subagentSessions = subagents().length;
    release();
    await until(() =>
      subagents().every((each) => each.log.events.some((event) => event.type === 'turn/end')),
    );
    await pump.whenIdle();
  } finally {
    release();
    await persistence.dispose();
    detach();
    await built.dispose();
  }
  expect(subagentSessions).toBe(1);

  const { logs, unreadable } = await readSessionLogs([store.directory]);
  expect(unreadable).toEqual([]);
  const scans = logs.map((log) => scanSessionLog(log));
  expect(scans).toHaveLength(2);
  expect(scans.find((scan) => scan.parentSession === undefined)?.errors).toEqual({
    ACTIVATION_LIMIT_REACHED: 1,
  });
  expect(scans.find((scan) => scan.parentSession !== undefined)?.errors).toEqual({});
  const text = formatScanReport(scans, [], { threshold: 5 }).join('\n');
  expect(text).toContain('工具錯誤 ACTIVATION_LIMIT_REACHED×1');
  expect(reported).toEqual([]);
}, 30000);
