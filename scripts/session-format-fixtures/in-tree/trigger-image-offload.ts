/**
 * 圖片額度省略記在 `model/start` 之後的夾具觸發（[#2354](https://github.com/DemianLi/nexus-agent/issues/2354)）：用**那一版自己的**組裝跑一次超額。
 * 那一版的 `image/offload` 由 adapter 拋 `IMAGE_OFFLOAD_REQUIRED`、上層接住之後才記，落在那次呼叫的 `model/start` **之後**；
 * CLI 一輪碰不到圖片額度，所以由這支補寫。
 *
 * 真的 `createNexusAgent`＋`ThreadPump`，模型是腳本（`ScriptedChatModel`，額度 `maxImages: 1`），零憑證、零外部連線。
 * 三輪：第一句帶一張圖、第二句帶第二張（超額，省略第一張）、第三句沒圖。跑完把 pump 那一份日誌**照原樣的順序與內容**
 * 用那一版的 `SessionLog`、JSONL 後端與協調器寫出來（時間戳是寫出的當下）。
 *
 * 由 `scripts/session-format-fixtures/generate.ts` 複製進那一版的 `apps/harness/src/` 再跑，**不在今天的樹裡編**。
 * 用法：tsx __session-format-trigger-image-offload.ts <run 目錄>
 */

import { MemorySaver } from '@langchain/langgraph';
import { SESSION_LOG_FORMAT_VERSION, SessionLog, SessionPersistenceCoordinator } from '@nexus/core';
import type { AttachmentRef, SessionEvent } from '@nexus/core';

import { createNexusAgent } from './agent-factory.js';
import { openJsonlSessionStore } from './jsonl-session-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const directory = process.argv[2];
if (directory === undefined) throw new Error('要給 run 目錄。');

const imageRef = (letter: string, name: string): AttachmentRef => ({
  type: 'image',
  attachmentId: `sha256:${letter.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 90,
  width: 3,
  height: 2,
  name,
});

const model = new ScriptedChatModel({
  turns: [{ content: '看到一張' }, { content: '看到第二張' }, { content: '好' }],
  imageBudget: { maxImages: 1 },
});
const built = await createNexusAgent({
  model,
  checkpointer: new MemorySaver(),
  summarization: false,
  observationPolicy: false,
  plugins: [],
  // 有型錄（`modelLimits`）才掛圖片省略的兩顆 middleware；額度本身在腳本模型上。
  modelLimits: () => ({ contextWindow: 32_768, maxOutputTokens: 4096 }),
});
const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'image-offload');
const detach = built.attachSession(pump.sessions);
await pump.submit({
  kind: 'message',
  text: '看這張',
  id: 'm1',
  attachments: [imageRef('a', 'one.png')],
});
await pump.whenIdle();
await pump.submit({
  kind: 'message',
  text: '再看這張',
  id: 'm2',
  attachments: [imageRef('b', 'two.png')],
});
await pump.whenIdle();
await pump.submit({ kind: 'message', text: '只是問個問題', id: 'm3' });
await pump.whenIdle();
const events: readonly SessionEvent[] = [...pump.sessionLog.events];
pump.close();
detach();
await built.dispose();

const offloads = events.filter((event) => event.type === 'image/offload');
if (offloads.length !== 1)
  throw new Error(`該記一筆 image/offload，記了 ${String(offloads.length)} 筆。`);
if (model.rejectedImageRequests !== 1) {
  throw new Error(`那一版該由 adapter 擋一次，擋了 ${String(model.rejectedImageRequests)} 次。`);
}

const id = 'image-offload';
const log = new SessionLog(id);
const coordinator = new SessionPersistenceCoordinator({
  log,
  stored: openJsonlSessionStore({ directory }).create({
    version: SESSION_LOG_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd: process.cwd(),
  }),
});
for (const event of events) log.append(event.type, event.data as never);
await coordinator.dispose();
console.log('寫了 image-offload。');
