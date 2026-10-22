/**
 * 收圖與讀圖多的兩道檢查走得到產品路徑（[#1566](https://github.com/DemianLi/nexus-agent/issues/1566)）：真的 `createWireHandler`＋真的
 * wire client＋真的 `AttachmentStore`。機制本身（`admitImages`、`AttachmentStore.readImage`）各有自己的測試；這裡釘的是**接線**：
 * 拿掉 wire 那一側對它們的呼叫，這幾條會紅。
 *
 * - `run.start` 帶一張單邊超過 8192 的圖：`invalid_argument`，訊息帶上限，日誌一個字不動。
 * - 讀圖路由碰到「日誌記的寬高、媒體類型與位元組對不上」的參照：`unknown_error`，不把位元組交給畫面。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，附件根放 `/var/tmp`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import type { SessionLog } from '@nexus/core';
import { createWireClient } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { AttachmentStore, attachmentsRootOf } from './attachment-store.js';
import { loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { GIF_7X5, PNG_7X5 } from './image-fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://image-checks.test';
const THREAD = 'image-checks';

let home: string;
let store: AttachmentStore;

beforeEach(async () => {
  home = await mkdtemp(join('/var/tmp', 'nexus-imgchk-'));
  store = new AttachmentStore(attachmentsRootOf(home));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function connect() {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: [{ content: '收到。' }] }),
    checkpointer: new MemorySaver(),
    plugins: [],
    attachments: store,
  });
  let root: SessionLog | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    attachments: store,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      dispose: built.dispose,
      attachSessions: (sessions, backgroundPort) => {
        root = sessions.root;
        return composeAttachSessions(built)(sessions, backgroundPort);
      },
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  return {
    handler,
    client,
    log: () => {
      if (root === undefined) throw new Error('這條 thread 還沒建起來');
      return root;
    },
  };
}

/** 只有 PNG 簽名與 IHDR 的檔頭：收圖只讀檔頭，造得出真檔造不出來的寬高。同 `image-intake.test.ts`。 */
function pngHeader(width: number, height: number): string {
  const out = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out);
  out.writeUInt32BE(13, 8);
  out.write('IHDR', 12, 'ascii');
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt8(8, 24);
  out.writeUInt8(2, 25);
  return out.toString('base64');
}

describe('收圖：單邊上限（照 dsh DEFAULT_MAX_IMAGE_DIMENSION）', () => {
  it('8193×1 的圖：run.start 回 invalid_argument、訊息帶 8192，日誌不動；8192×1 照收', async () => {
    const c = await connect();
    try {
      // 先讓 thread 建起來，才看得到「日誌不動」。
      const opened = await c.client.uploadFile(THREAD, new Uint8Array([1]), 'x.txt');
      expect(opened.kind).toBe('ok');
      const before = c.log().events.length;
      const rejected = await c.client.runStart(THREAD, '這張', {
        attachments: [{ type: 'image', mediaType: 'image/png', data: pngHeader(8193, 1) }],
      });
      expect(rejected).toMatchObject({ type: 'error', error: 'invalid_argument' });
      expect(JSON.stringify(rejected)).toContain('8192');
      expect(c.log().events.length).toBe(before);

      expect(
        await c.client.runStart(THREAD, '這張', {
          attachments: [{ type: 'image', mediaType: 'image/png', data: pngHeader(8192, 1) }],
        }),
      ).toMatchObject({ type: 'success' });
    } finally {
      await c.handler.close();
    }
  });
});

describe('讀圖：檔頭要對得上日誌記的參照（照 dsh readImageFile）', () => {
  it('日誌引用的參照寫著 PNG 7×5、位元組其實是 GIF：unknown_error，不回位元組；對得上的照讀', async () => {
    const c = await connect();
    try {
      const opened = await c.client.uploadFile(THREAD, new Uint8Array([1]), 'x.txt');
      expect(opened.kind).toBe('ok');
      // 儲存本身不驗內容（收圖的檢查在 wire 那一側），所以造得出「參照與位元組對不上」的物件；雜湊照樣對得上。
      const facts = { mediaType: 'image/png', width: 7, height: 5 } as const;
      const mislabeled = await store.saveImage({ data: Buffer.from(GIF_7X5, 'base64'), ...facts });
      const honest = await store.saveImage({ data: Buffer.from(PNG_7X5, 'base64'), ...facts });
      c.log().append('turn/start', {
        kind: 'message',
        text: '圖',
        attachments: [
          { type: 'image', ...mislabeled },
          { type: 'image', ...honest },
        ],
      } as never);

      const outcome = await c.client.readAttachment(THREAD, mislabeled.attachmentId);
      expect(outcome).toMatchObject({ kind: 'rejected', code: 'unknown_error' });
      expect(JSON.stringify(outcome)).toContain('檔頭對不上');
      expect(JSON.stringify(outcome)).not.toContain(GIF_7X5);

      expect(await c.client.readAttachment(THREAD, honest.attachmentId)).toMatchObject({
        kind: 'ok',
        result: { data: PNG_7X5 },
      });
    } finally {
      await c.handler.close();
    }
  });
});
