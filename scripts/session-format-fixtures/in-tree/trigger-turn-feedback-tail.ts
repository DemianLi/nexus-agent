/**
 * 格式 9 的夾具觸發：以輪為目標的評分，兩種都要有。用的全是**那一版自己的** store、`SessionLog`、評分服務與
 * `toLoggedMessage`。
 *
 * - 第一輪：CLI 那一輪。假模型的回覆沒有 id，今天 `currentMessageFeedback` 找不到那一輪的回覆，走退路、照輪記。
 * - 第二輪：這支補寫一輪，回覆帶 id、有文字。今天把對這一輪的評分改寫成對那則回覆（`messageId`），格式 10 的分支
 *   要的就是這一條。
 *
 * 格式 8 沒有 `assistant/message`（那一版的日誌不記回覆），接不出帶 id 的回覆，所以 v8 只跑 `trigger-turn-feedback.ts`。
 *
 * 由 `scripts/session-format-fixtures/generate.ts` 複製進那個 tag 的 `apps/harness/src/` 再跑，**不在今天的樹裡編**。
 * 用法：tsx __session-format-trigger.ts <run 目錄>
 */

import { AIMessage } from '@langchain/core/messages';
import { SessionLog, SessionPersistenceCoordinator, toLoggedMessage } from '@nexus/core';
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
const feedback = createFeedbackService({ maxNoteBytes: 4096 });
const rate = (turn: number, rating: 'negative' | 'positive', note: string): void => {
  const result = feedback.put(log, {
    turn,
    rating,
    note,
    category: 'task-result',
    ifVersion: null,
  });
  if (!result.ok) throw new Error(`評分寫不進去：${JSON.stringify(result.error)}`);
};

const first = resumed.events.find((event) => event.type === 'turn/start');
if (first === undefined) throw new Error('CLI 寫的那條會話沒有 turn/start。');
rate(first.seq, 'negative', '夾具：以輪為目標、那一輪的回覆沒有 id');

const second = log.append('turn/start', { kind: 'message', text: '再說一次' });
log.append('assistant/message', {
  message: toLoggedMessage(new AIMessage({ id: 'fixture-reply', content: '好，再說一次。' })),
});
log.append('turn/end', {});
rate(second.seq, 'positive', '夾具：以輪為目標、那一輪的回覆帶 id');

await coordinator.dispose();
console.log(`評了第 ${String(first.seq)}、${String(second.seq)} 顆 turn/start 那兩輪。`);
