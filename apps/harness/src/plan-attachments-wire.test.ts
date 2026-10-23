/**
 * **`/plan` 收附件走完產品路徑**（[#1607](https://github.com/DemianLi/nexus-agent/issues/1607) 驗收 1–3，照 dsh `plan-mode` 的
 * `input: { hint: '[off|message]', attachments: true }`）。
 *
 * 真 handler＋真 client＋真執行器＋出貨清單（`plan-mode` 那一列）＋附件儲存；模型是腳本。
 *
 * 1. `/plan 看這份` ＋檔案：`command/done` 成功；`plan/mode` 在 `command/done` 之前；接著那一輪 `turn/start` 帶同一份附件與那句話。
 * 2. 只有附件、沒有字的 `/plan`：同樣開模式、起一輪，`turn/start` 的字是空的、附件在。
 * 3. `/plan off` ＋附件：error，不寫新的 `plan/mode`、不起輪；收據沒被用掉（同一份再用一次成功）。
 *
 * **零憑證、零外部連線**：附件根放 `/var/tmp`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { SessionEvent, SessionRegistry } from '@nexus/core';
import { PLAN_COMMAND_NAME, PLAN_OFF_ATTACHMENTS_MESSAGE } from '@nexus/plugin-plan-mode';
import { createWireClient } from '@nexus/wire';
import type { PromptAttachment } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { AttachmentStore, attachmentsRootOf } from './attachment-store.js';
import {
  loopbackRequest,
  shippedPlugins,
  TEST_BROWSER_AUTH,
  withScriptedModel,
  withoutTimeContext,
} from './fixtures.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const shipped = withoutTimeContext(await shippedPlugins());
const THREAD = 'plan-attachments';

let home: string;
let store: AttachmentStore;

beforeEach(async () => {
  home = await mkdtemp(join('/var/tmp', 'nexus-planatt-'));
  store = new AttachmentStore(attachmentsRootOf(home));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function connect() {
  const built = await createCliAgent(
    { live: false, attachments: store },
    withScriptedModel(shipped, [{ content: '收到。' }, { content: '再收到。' }]),
  );
  let registry: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    attachments: store,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      dispose: built.dispose,
      attachSessions: (sessions, backgroundPort) => {
        registry = sessions;
        return built.attachSessions(sessions, backgroundPort);
      },
    }),
  });
  const client = createWireClient({
    baseUrl: 'http://plan-attachments.test',
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const events = (): readonly SessionEvent[] => registry?.root.events ?? [];
  return { client, handler, events };
}

async function upload(
  client: Awaited<ReturnType<typeof connect>>['client'],
): Promise<PromptAttachment> {
  const outcome = await client.uploadFile(THREAD, new TextEncoder().encode('規格 v2'), '規格.txt');
  if (outcome.kind !== 'ok') throw new Error('上傳沒成功');
  return { type: 'file', receiptId: outcome.receipt.receiptId };
}

async function turnsEnded(events: () => readonly SessionEvent[], count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (events().filter((e) => e.type === 'turn/end' || e.type === 'turn/failed').length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等不到這一輪收尾');
}

const types = (events: readonly SessionEvent[], pattern: RegExp): string[] =>
  events.map((event) => event.type).filter((type) => pattern.test(type));

describe('/plan 收附件', () => {
  it('/plan <字> ＋檔案：成功；plan/mode 在 command/done 之前；那一輪 turn/start 帶同一份附件', async () => {
    const { client, handler, events } = await connect();
    try {
      const file = await upload(client);
      const result = await client.slashRun(THREAD, `/${PLAN_COMMAND_NAME} 看這份`, [file]);
      expect(result).toMatchObject({ kind: 'success' });
      await turnsEnded(events, 1);

      expect(types(events(), /^(command\/|plan\/mode|turn\/start)/u)).toEqual([
        'command/run',
        'plan/mode',
        'command/done',
        'turn/start',
      ]);
      const start = events().find((e) => e.type === 'turn/start');
      expect(start?.data).toMatchObject({
        kind: 'message',
        text: '看這份',
        attachments: [{ type: 'file', name: '規格.txt' }],
      });
    } finally {
      await handler.close();
    }
  });

  it('只有附件、沒有字的 /plan：照樣開模式、起一輪，字是空的、附件在', async () => {
    const { client, handler, events } = await connect();
    try {
      const file = await upload(client);
      const result = await client.slashRun(THREAD, `/${PLAN_COMMAND_NAME}`, [file]);
      expect(result).toMatchObject({ kind: 'success' });
      await turnsEnded(events, 1);

      expect(types(events(), /^(command\/|plan\/mode|turn\/start)/u)).toEqual([
        'command/run',
        'plan/mode',
        'command/done',
        'turn/start',
      ]);
      expect(events().find((e) => e.type === 'turn/start')?.data).toMatchObject({
        kind: 'message',
        text: '',
        attachments: [{ type: 'file', name: '規格.txt' }],
      });
    } finally {
      await handler.close();
    }
  });

  it('/plan off ＋附件：error，不寫新的 plan/mode、不起輪，收據沒用掉', async () => {
    const { client, handler, events } = await connect();
    try {
      const file = await upload(client);
      await client.slashRun(THREAD, `/${PLAN_COMMAND_NAME}`);
      const before = types(events(), /^(plan\/mode|turn\/start)/u);
      expect(before).toEqual(['plan/mode']);

      const refused = await client.slashRun(THREAD, `/${PLAN_COMMAND_NAME} off`, [file]);
      expect(refused).toMatchObject({ kind: 'error', text: PLAN_OFF_ATTACHMENTS_MESSAGE });
      expect(types(events(), /^(plan\/mode|turn\/start)/u)).toEqual(before);

      // 收據還在：同一份再用一次（這回不帶 off）成功。
      const again = await client.slashRun(THREAD, `/${PLAN_COMMAND_NAME} 補一句`, [file]);
      expect(again).toMatchObject({ kind: 'success' });
    } finally {
      await handler.close();
    }
  });
});
