/**
 * **收尾時間窗內，會開新一輪的命令回 `server_closing`**——[#1787](https://github.com/DemianLi/nexus-agent/issues/1787) 第 3 點。
 *
 * 真的 `createWireHandler`＋wire client＋假 agent（數「上游被打幾次」＝假 agent 的 `streamEvents` 被叫幾次）。時間窗在 `serve.ts` 的
 * `close()` 開始時由 `handler.stopAdmission()` 打開，這一檔直接叫它；`serve.ts` 那條線在 `serve-ops-endpoints.test.ts`。
 *
 * 突變（各自單獨做，做完還原，結果記在 PR）：
 *
 * 1. `run.start` 熱 thread 的 `if (admissionStopped) return serverClosing(…)` 拿掉 → 「已開的 thread」「去重排在拒絕之前」紅。
 * 2. 冷 thread 的那道（`!threads.has(threadId)`）移到 `threadOrError` 之後 → 「冷 thread」紅（`createAgent` 計數 1）。
 * 3. 准入 `await` 之後的第二次檢查拿掉 → 「准入的 await 回來之後」紅（上游被打 1 次、收據沒放回）。
 * 4. 去重那一段移到拒絕之後（先擋再認人）→ 「去重排在拒絕之前」紅。
 * 5. 整條 `/wire` 都擋（`run.cancel` 也回 `server_closing`）→ 「只擋新一輪」紅。
 * 6. `acceptSteer` 不查旗標 → 「slash.run 的 steer」紅。
 * 7. `stopAdmission` 變成 no-op → 所有「窗內」那幾格紅。
 *
 * **沒有測的一件**：被拒時附件收據放回去（`outcome.restore()`）。收據表是 handler 閉包裡的記憶體表、沒有對外的讀口，而窗內准入不會再開，
 * 放回去的收據在這台 serve 的剩餘壽命裡沒有人會再用（重啟之後表是空的），所以沒有可觀察的行為可以釘；寫在 PR 內文，靠讀程式碼把關。
 *
 * **零憑證、零外部連線**：附件根放 `/var/tmp`，模型是假 agent。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createRegistry } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { createWireClient, SERVER_CLOSING } from '@nexus/wire';
import type { PromptAttachment } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AttachmentStore, attachmentsRootOf } from './attachment-store.js';
import { loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { PNG_7X5 } from './image-fixtures.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { IdleSweepingWireHandler } from './wire-handler.js';

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const COMPLETED = {
  type: 'event',
  seq: 0,
  method: 'lifecycle',
  params: { namespace: [], timestamp: 0, data: { event: 'completed', graph_name: 'root' } },
};

const IMAGE: PromptAttachment = {
  type: 'image',
  mediaType: 'image/png',
  data: PNG_7X5,
  name: 's.png',
};

/** `saveImage` 可以卡在一道閘上：讓「准入的 `await`」跨過 `stopAdmission()`。 */
class GatedStore extends AttachmentStore {
  hold: Promise<void> | undefined;
  override async saveImage(...args: Parameters<AttachmentStore['saveImage']>) {
    if (this.hold !== undefined) await this.hold;
    return super.saveImage(...args);
  }
}

let home: string;
let store: GatedStore;
beforeEach(async () => {
  home = await mkdtemp(join('/var/tmp', 'nexus-server-closing-'));
  store = new GatedStore(attachmentsRootOf(home));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const opened: IdleSweepingWireHandler[] = [];
afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
});

/** 一台 handler＋client。`upstream()` 是假 agent 被叫的次數；`created()` 是 `createAgent` 被叫的次數。 */
function rig() {
  let ran = 0;
  let created = 0;
  const sends: string[] = [];
  let log: (() => readonly SessionEvent[]) | undefined;
  const agent = {
    streamEvents: async () => {
      ran += 1;
      return (async function* () {
        yield COMPLETED;
      })();
    },
    getState: async () => ({ values: {} }),
    updateState: async () => ({}),
  } as unknown as PumpAgent;

  const registry = createRegistry();
  registry.enter({ id: 'closing-test#0', name: 'closing-test' });
  // `steer`：會開一輪的命令；`plain`：不開輪的命令。
  registry.commands.register({
    name: 'steer',
    description: '送一句話',
    handler: ({ steer }) => {
      steer('命令送的話');
      return { kind: 'success' };
    },
  });
  registry.commands.register({
    name: 'plain',
    description: '不開輪',
    handler: () => ({ kind: 'success', text: '好了' }),
  });

  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    attachments: store,
    createAgent: async () => {
      created += 1;
      return {
        agent,
        commands: registry.commands,
        dispose: async () => {},
        attachSessions: (sessions) => {
          log = () => sessions.root.events;
          return {
            detach: async () => {},
            background: {
              sendFromUser: async (_runId: string, text: string) => {
                sends.push(text);
              },
              interrupt: () => undefined,
            } as never,
          };
        },
      };
    },
  });
  opened.push(handler);
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    handler.handle(loopbackRequest(input as string, init));
  const client = createWireClient({ baseUrl: 'http://closing.test', fetch });
  return {
    handler,
    client,
    upstream: () => ran,
    created: () => created,
    sends: () => sends,
    log: () => log?.() ?? [],
    turnStarts: () => (log?.() ?? []).filter((event) => event.type === 'turn/start'),
  };
}

const CLOSING = { type: 'error', error: SERVER_CLOSING };

describe('窗內：run.start 回 server_closing', () => {
  it('已開的 thread：回 server_closing、HTTP 200，上游 0 次，日誌沒有那個 request_id', async () => {
    const r = rig();
    const thread = 'closing-hot';
    expect(await r.client.runStart(thread, '窗前')).toMatchObject({ type: 'success' });
    await until(() => r.upstream() === 1);

    r.handler.stopAdmission();
    const refused = await r.client.runStart(thread, '窗內', { requestId: 'req-window' });
    expect(refused).toMatchObject(CLOSING);
    // 訊息是寫給使用者看的：說這句話沒有送出，並指出下一步。
    expect((refused as { message: string }).message).toContain('沒有送出');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.upstream()).toBe(1);
    expect(r.turnStarts()).toHaveLength(1);
    expect(JSON.stringify(r.log())).not.toContain('req-window');
  });

  it('冷 thread（記憶體裡沒有）：回 server_closing，createAgent 0 次', async () => {
    const r = rig();
    r.handler.stopAdmission();
    expect(await r.client.runStart('closing-cold', '窗內')).toMatchObject(CLOSING);
    expect(r.created()).toBe(0);
    expect(r.upstream()).toBe(0);
  });

  it('去重排在拒絕之前：窗前收過的 request_id 窗內重送，拿回原本的 run_id', async () => {
    const r = rig();
    const thread = 'closing-dedupe';
    const first = await r.client.runStart(thread, '窗前', { requestId: 'req-1' });
    expect(first).toMatchObject({ type: 'success' });
    await until(() => r.upstream() === 1);

    r.handler.stopAdmission();
    const again = await r.client.runStart(thread, '窗前', { requestId: 'req-1' });
    expect(again).toMatchObject({ type: 'success' });
    expect((again as { result: { run_id: string } }).result.run_id).toBe(
      (first as { result: { run_id: string } }).result.run_id,
    );
    // 新的編號照拒。
    expect(await r.client.runStart(thread, '窗內', { requestId: 'req-2' })).toMatchObject(CLOSING);
    expect(r.upstream()).toBe(1);
  });

  it('准入的 await 回來之後再查一次：上游 0 次、日誌沒有那一句', async () => {
    const r = rig();
    const thread = 'closing-admit';
    // 先開 thread（熱的），第一次檢查會過。
    expect(await r.client.runStart(thread, '窗前')).toMatchObject({ type: 'success' });
    await until(() => r.upstream() === 1);

    const release = gate();
    store.hold = release.opened;
    const pending = r.client.runStart(thread, '附圖', {
      attachments: [IMAGE],
      requestId: 'req-image',
    });
    // 請求卡在 `saveImage`（准入的 await）裡；這時時間窗開始。
    await new Promise((resolve) => setTimeout(resolve, 30));
    r.handler.stopAdmission();
    release.open();
    expect(await pending).toMatchObject(CLOSING);
    expect(r.upstream()).toBe(1);
    expect(r.turnStarts()).toHaveLength(1);
    expect(JSON.stringify(r.log())).not.toContain('req-image');
  });
});

describe('窗內：subagent.send 與 slash.run', () => {
  it('subagent.send：熱的與冷的都回 server_closing，沒有投遞、冷的不建 agent', async () => {
    const r = rig();
    const thread = 'closing-subagent';
    expect(await r.client.runStart(thread, '開 thread')).toMatchObject({ type: 'success' });
    await until(() => r.upstream() === 1);
    // 對照組：窗前投遞得進去。
    expect(await r.client.subagentSend(thread, 'bg-1', '窗前的話')).toMatchObject({
      type: 'success',
    });
    expect(r.sends()).toEqual(['窗前的話']);

    r.handler.stopAdmission();
    expect(await r.client.subagentSend(thread, 'bg-1', '窗內的話')).toMatchObject(CLOSING);
    expect(r.sends()).toEqual(['窗前的話']);

    const created = r.created();
    expect(await r.client.subagentSend('closing-subagent-cold', 'bg-1', '窗內的話')).toMatchObject(
      CLOSING,
    );
    expect(r.created()).toBe(created);
  });

  it('slash.run 的 steer：回 server_closing、不開輪；不 steer 的命令照常', async () => {
    const r = rig();
    const thread = 'closing-slash';
    // 窗前：steer 命令開得了一輪。
    expect(await r.client.slashRun(thread, '/steer')).toMatchObject({ kind: 'success' });
    await until(() => r.upstream() === 1);

    r.handler.stopAdmission();
    const refused = await r.client.slashRun(thread, '/steer');
    expect(refused).toMatchObject({ kind: 'rejected', code: SERVER_CLOSING });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.upstream()).toBe(1);
    expect(r.turnStarts()).toHaveLength(1);
    // 命令落定成 error（日誌一對 command/run、command/done），沒有第二個 turn/start。
    const done = r.log().filter((event) => event.type === 'command/done');
    expect(done.at(-1)?.data).toMatchObject({ kind: 'error' });
    // 不 steer 的命令不開輪，窗內照常。
    expect(await r.client.slashRun(thread, '/plain')).toMatchObject({
      kind: 'success',
      text: '好了',
    });
  });
});

describe('窗內：只擋新一輪', () => {
  it('run.cancel 停得掉正在跑的那一輪；讀取照常；窗前 run.start 與 stopAdmission 前都成功', async () => {
    const hold = gate();
    let ran = 0;
    const agent = {
      streamEvents: async () => {
        ran += 1;
        return (async function* () {
          await hold.opened;
          yield COMPLETED;
        })();
      },
      getState: async () => ({ values: {} }),
      updateState: async () => ({}),
    } as unknown as PumpAgent;
    let log: (() => readonly SessionEvent[]) | undefined;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => ({
        agent,
        commands: createRegistry().commands,
        dispose: async () => {},
        attachSessions: (sessions) => {
          log = () => sessions.root.events;
          return { detach: async () => {} };
        },
      }),
    });
    opened.push(handler);
    const client = createWireClient({
      baseUrl: 'http://closing.test',
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });

    // 對照組：stopAdmission 之前，run.start 照常成功。
    const thread = 'closing-cancel';
    expect(await client.runStart(thread, '跑著')).toMatchObject({ type: 'success' });
    await until(() => ran === 1);

    handler.stopAdmission();
    expect(await client.runCancel(thread)).toMatchObject({ type: 'success' });
    hold.open();
    await until(() => (log?.() ?? []).some((event) => event.type === 'turn/end'));
    // 讀取照常（斜線清單是 thread 上的讀取）。
    expect(await client.slashList(thread)).toMatchObject({ kind: 'ok' });
  });

  it('沒有人呼叫 stopAdmission：一切照舊（對照組）', async () => {
    const r = rig();
    expect(await r.client.runStart('closing-control', '嗨')).toMatchObject({ type: 'success' });
    await until(() => r.upstream() === 1);
    expect(await r.client.slashRun('closing-control', '/plain')).toMatchObject({
      kind: 'success',
    });
  });
});
