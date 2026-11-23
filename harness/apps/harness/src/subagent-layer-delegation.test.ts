/**
 * **子代理那一層叫 `subagent`：落到「沒有這顆工具」，不派孫代理**（[#1045](https://github.com/DemianLi/nexus-agent/issues/1045)）。
 *
 * `background-delegation.ts` 那顆 middleware 是 plugin 以 `prepend` 掛的，同一份實例也進了每個子代理的疊（#327）。
 * 它只在看到 `task` 的那一層（root）把 `subagent` 加進模型視野，子代理的模型看不到這顆工具；可是修之前它的
 * `wrapToolCall` 只比工具名，子代理幻覺出來的 `subagent` 呼叫照樣被接手：前景拿 root 那一份 `task` 派出巢狀的孫代理，
 * 背景把孫代理掛到 root 的 host 上（root 的子代理目錄多一條指向 root 日誌裡不存在的呼叫），日誌一律記成功、沒有碼。
 *
 * 照 dsh：派得出去的就是這個 agent 看得到的（`packages/core/tools/src/index.ts:1230-1252`，派發與 schema 用同一份逐 agent
 * 視圖），看不到的呼叫在派發那一步拋 `ToolNotFoundError`（`:1578-1579`，`5badb15`）。我們這側由最內層把基座的「沒有這顆
 * 工具」標成 `UNKNOWN_TOOL`（#1024，`packages/nexus-core/src/invalid-tool-args.ts`）。
 *
 * **全走產品組裝**：`createNexusAgent({ backgroundSubagents })`＋腳本模型＋`ThreadPump`＋`attachSession`，日誌經
 * `attachSessionPersistence` 落到 JSONL，再用離線掃描那一份讀法讀回來。子代理兩種（前景、背景）× 它發的呼叫兩種
 * （`run_in_background` 為 false、true），四格各跑一次。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { attachSessionPersistence, subagentLinks } from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionEventMap, SessionRegistry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  dir = await mkdtemp(join(tmpdir(), 'nexus-subagent-layer-'));
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

const CASES = [
  { label: '前景子代理發前景呼叫', rootBackground: false, childBackground: false },
  { label: '前景子代理發背景呼叫', rootBackground: false, childBackground: true },
  { label: '背景子代理發前景呼叫', rootBackground: true, childBackground: false },
  { label: '背景子代理發背景呼叫', rootBackground: true, childBackground: true },
] as const;
type Case = (typeof CASES)[number];

/**
 * worker 的模型：第一輪叫 `subagent`（它看不到的那顆），之後每輪收尾。**孫代理被派出去的話也用這一份腳本**，
 * 會吃掉後面的輪，所以多備幾輪：判準不靠「哪一輪說了什麼」，靠日誌上的碼與會話份數。
 */
function workerPlugin(entry: Case): PluginEntry {
  return {
    plugin: {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          model: new ScriptedChatModel({
            turns: [
              {
                content: '',
                toolCalls: [
                  {
                    name: 'subagent',
                    id: 'child-call',
                    args: {
                      description: '再派一個',
                      subagent_type: 'worker',
                      run_in_background: entry.childBackground,
                    },
                  },
                ],
              },
              { content: '做完一' },
              { content: '做完二' },
              { content: '做完三' },
            ],
          }) as never,
        });
      },
    },
  };
}

/** 呼叫 `child-call` 的那一份：就是被 root 派出去的子代理。 */
function childLog(sessions: SessionRegistry): readonly SessionEvent[] | undefined {
  return sessions
    .list()
    .find((each) =>
      each.log.events.some(
        (event) =>
          event.type === 'tool/call' &&
          (event.data as SessionEventMap['tool/call']).callId === 'child-call',
      ),
    )?.log.events;
}

/**
 * 子代理收尾了：`child-call` 的結果之後有一則 assistant 訊息。前景的孫代理在子代理那次呼叫裡跑、背景的在接受那一刻
 * 同步啟動，所以等到這裡，修之前那條路一定已經走過了——不用固定秒數，負向斷言才不會假綠。
 */
function childSettled(sessions: SessionRegistry): boolean {
  const events = childLog(sessions);
  if (events === undefined) return false;
  const result = events.findIndex(
    (event) =>
      event.type === 'tool/result' &&
      (event.data as SessionEventMap['tool/result']).callId === 'child-call',
  );
  return result >= 0 && events.slice(result).some((event) => event.type === 'assistant/message');
}

describe.each(CASES)('$label', (entry) => {
  it('子代理那份記 UNKNOWN_TOOL，沒有孫代理，root 的目錄只有自己派的那一條；掃描只報那一次未知工具', async () => {
    const store = createJsonlSessionStore({ rootDir: join(dir, 'logs') });
    const built = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          {
            content: '委派。',
            toolCalls: [
              {
                name: 'subagent',
                id: 'root-call',
                args: {
                  description: '幹活',
                  subagent_type: 'worker',
                  run_in_background: entry.rootBackground,
                },
              },
            ],
          },
          { content: '根收尾' },
          // 背景那條在結算之後還會排一輪續行。
          { content: '收到結算' },
          { content: '再收一次' },
        ],
      }),
      checkpointer: new MemorySaver(),
      plugins: [workerPlugin(entry)],
      backend: new ContainedFilesystemBackend({
        rootDir: join(dir, 'workspace'),
        mode: 'workspace-write',
      }),
      backgroundSubagents: {},
      onInvariantViolation: (error) => reported.push(`不變量：${error.message}`),
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'layer-root');
    const detach = built.attachSession(pump.sessions);
    const persistence = attachSessionPersistence(pump.sessions, store);
    let subagentSessions: number;
    try {
      await pump.submit({ kind: 'message', text: '委派' });
      await pump.whenIdle();
      await until(() => childSettled(pump.sessions));
      await pump.whenIdle();

      // 子代理那份：呼叫記了，結果是未知工具的碼（名字與碼同 #1024 給基座的「沒有這顆工具」標的那一組）。
      const events = childLog(pump.sessions)!;
      const result = events.find(
        (event) =>
          event.type === 'tool/result' &&
          (event.data as SessionEventMap['tool/result']).callId === 'child-call',
      );
      const { message: _message, ...data } = result!.data as SessionEventMap['tool/result'];
      expect(data).toEqual({
        callId: 'child-call',
        isError: true,
        error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
      });
      subagentSessions = pump.sessions
        .list()
        .filter((each) => each.address.kind === 'subagent').length;
    } finally {
      await persistence.dispose();
      detach();
      await built.dispose();
    }
    // 沒有孫代理：子代理的會話只有 root 派的那一份（巢狀的 `tools:…|tools:…` 或第二個背景編號都會多一份）。
    expect(subagentSessions).toBe(1);

    const { logs, unreadable } = await readSessionLogs([store.directory]);
    expect(unreadable).toEqual([]);
    const root = logs.find((log) => log.header.parentSession === undefined)!;
    // root 的子代理目錄只有它自己派的那一條：背景孫代理掛到 root 的 host 上時，這裡會多一條指向 `child-call`。
    expect(subagentLinks(root.events).map((link) => link.callId)).toEqual(['root-call']);

    const scans = logs.map((log) => scanSessionLog(log));
    const child = scans.find((scan) => scan.parentSession !== undefined);
    expect(scans).toHaveLength(2);
    expect(child?.errors).toEqual({ UNKNOWN_TOOL: 1 });
    expect(scans.find((scan) => scan.parentSession === undefined)?.errors).toEqual({});
    const text = formatScanReport(scans, [], { threshold: 5 }).join('\n');
    expect(text).toContain('工具錯誤 UNKNOWN_TOOL×1');
    expect(text).not.toContain('child-call');
    expect(reported).toEqual([]);
  }, 30000);
});
