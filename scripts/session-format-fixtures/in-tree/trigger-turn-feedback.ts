/**
 * 格式 8／9 的夾具觸發：在 CLI 寫出的那條會話上，用**那一版自己的**評分服務對第一輪評一次分（目標是輪，
 * 格式 10 以前的形狀），讓今天 `currentMessageFeedback` 對 `turn` 目標的那支分支有東西讀。
 *
 * 走法照那時候的 serve：續接（store 的 `resume`，帶 seed 開日誌會寫一顆 `session/end-seed`）、交評分服務寫、
 * 協調器落盤。
 *
 * 由 `scripts/session-format-fixtures/generate.ts` 複製進那個 tag 的 `apps/harness/src/` 再跑，**不在今天的樹裡編**。
 * 用法：tsx __session-format-trigger.ts <run 目錄>
 */

import { SessionLog, SessionPersistenceCoordinator } from '@nexus/core';
import { createFeedbackService } from '@nexus/plugin-feedback';
import { openJsonlSessionStore } from './jsonl-session-store.js';

const directory = process.argv[2];
if (directory === undefined) throw new Error('要給 run 目錄。');

const store = openJsonlSessionStore({ directory });
const resumed = await store.resume('cli');
const log = new SessionLog('cli', { seed: resumed.events });
const coordinator = new SessionPersistenceCoordinator({
  log,
  stored: resumed.stored,
  storedCount: resumed.events.length,
});
const first = resumed.events.find((event) => event.type === 'turn/start');
if (first === undefined) throw new Error('CLI 寫的那條會話沒有 turn/start。');
const result = createFeedbackService({ maxNoteBytes: 4096 }).put(log, {
  turn: first.seq,
  rating: 'negative',
  note: '夾具：以輪為目標的評分',
  category: 'task-result',
  ifVersion: null,
});
if (!result.ok) throw new Error(`評分寫不進去：${JSON.stringify(result.error)}`);
await coordinator.dispose();
console.log(`評了第 ${String(first.seq)} 顆 turn/start 那一輪。`);
