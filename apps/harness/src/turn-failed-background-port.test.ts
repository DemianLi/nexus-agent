/**
 * `wire-handler` 把背景子代理的失敗通知接到 `onTurnFailed`（[#1536](https://github.com/DemianLi/nexus-agent/issues/1536)）。
 *
 * 子代理那一側（`background-subagents.test.ts`）只知道 run id 與 seq；補上**主對話的 thread id** 是 `wire-handler` 接 port 時做的事。
 * 這一檔用一個捕捉 port 的 `attachSessions`，叫它的 `onTurnFailed`，看外面的回呼收到什麼。拿掉 `wire-handler` 那段展開（或不補
 * `threadId`），這一檔紅。
 */

import { createDeepAgent, StateBackend } from 'deepagents';
import { afterEach, describe, expect, it } from 'vitest';

import {
  emptyCommandPoint,
  fetchWithCookie,
  TEST_BROWSER_AUTH,
  testSessionCookie,
} from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { AttachSessions } from './session-attach.js';
import type { PumpAgent, TurnFailedReport } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import { startWireServer } from './wire-server.js';
import type { WireServer } from './wire-server.js';

let running: WireServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('背景子代理的失敗通知', () => {
  it('port.onTurnFailed 帶上這條 thread 的 id 再轉給外面的回呼；沒掛回呼時 port 上就沒有這一格', async () => {
    const agent = createDeepAgent({
      model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
      tools: [],
      backend: new StateBackend(),
    }) as unknown as PumpAgent;

    const received: TurnFailedReport[] = [];
    const ports: Parameters<AttachSessions>[1][] = [];
    const attachSessions: AttachSessions = (_sessions, port) => {
      ports.push(port);
      return { detach: async () => {} };
    };
    const make = (onTurnFailed?: (report: TurnFailedReport) => void) =>
      createWireHandler({
        auth: TEST_BROWSER_AUTH,
        createAgent: async () => ({
          agent,
          attachSessions,
          commands: emptyCommandPoint(),
          dispose: async () => undefined,
        }),
        ...(onTurnFailed !== undefined && { onTurnFailed }),
      });

    // 掛了回呼：開一條 thread（開線就建 pump、接 port），叫 port 的 onTurnFailed。
    const handler = make((report) => void received.push(report));
    running = await startWireServer({ handler });
    const open = async (threadId: string) => {
      const response = await fetchWithCookie(testSessionCookie(new URL(running!.url).host))(
        `${running!.url}/threads/${threadId}/stream`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channels: ['lifecycle'] }),
        },
      );
      await (response.body as ReadableStream<Uint8Array>).getReader().cancel();
    };
    await open('t-bg');
    const port = ports.at(-1);
    expect(port?.onTurnFailed).toBeTypeOf('function');
    port!.onTurnFailed!({
      runId: 'bg-1',
      sessionId: 't-bg/bg-1',
      seq: 7,
      code: 'SERVER',
      status: 502,
      requestId: 'gw-sub',
    });
    expect(received).toEqual([
      {
        threadId: 't-bg',
        runId: 'bg-1',
        sessionId: 't-bg/bg-1',
        seq: 7,
        code: 'SERVER',
        status: 502,
        requestId: 'gw-sub',
      },
    ]);
    await handler.close();
    await running.close();
    running = undefined;

    // 沒掛回呼：port 上沒有 onTurnFailed（子代理那邊就不會多一條沒人收的路）。
    const bare = make();
    running = await startWireServer({ handler: bare });
    await open('t-bare');
    expect(ports.at(-1)?.onTurnFailed).toBeUndefined();
    await bare.close();
  });
});
