/**
 * 格式 14 的夾具觸發：用**那一版自己的** `SessionLog`、JSONL 後端與協調器，各寫一條停在一輪中間的會話，讓今天續接時的
 * 補結（`interruptedTurnClosers`）有東西補。事件的順序照同一版 CLI 寫出來的那一輪（`model/start`、`assistant/message`、
 * `model/end`、`tool/call`），在工具跑到一半時落盤後就收掉——行程死在那裡的樣子。
 *
 * - `crashed`：死了之後沒有人接過。
 * - `crashed-resumed`：死了之後被同一版續接過一次（store 的 `resume`，帶 seed 開日誌寫一顆 `session/end-seed`），
 *   又沒有新的一輪就停了——格式 33 以前續接只補 end-seed，開著的那一輪留在 end-seed 前面。
 *
 * 由 `scripts/session-format-fixtures/generate.ts` 複製進那個 tag 的 `apps/harness/src/` 再跑，**不在今天的樹裡編**。
 * 用法：tsx __session-format-trigger.ts <run 目錄>
 */

import { AIMessage } from '@langchain/core/messages';
import {
  SESSION_LOG_FORMAT_VERSION,
  SessionLog,
  SessionPersistenceCoordinator,
  toLoggedMessage,
} from '@nexus/core';
import { openJsonlSessionStore } from './jsonl-session-store.js';

const directory = process.argv[2];
if (directory === undefined) throw new Error('要給 run 目錄。');
const store = openJsonlSessionStore({ directory });

async function crash(id: string): Promise<void> {
  const log = new SessionLog(id);
  const coordinator = new SessionPersistenceCoordinator({
    log,
    stored: store.create({
      version: SESSION_LOG_FORMAT_VERSION,
      id,
      createdAt: Date.now(),
      cwd: process.cwd(),
    }),
  });
  log.append('turn/start', { kind: 'message', text: '幫我回聲一次' });
  log.append('model/start', {});
  log.append('assistant/message', {
    message: toLoggedMessage(
      new AIMessage({
        content: '先回聲一次。',
        tool_calls: [
          { id: `${id}-call`, name: 'echo', args: { message: '夾具' }, type: 'tool_call' },
        ],
      }),
    ),
  });
  log.append('model/end', {});
  log.append('tool/call', {
    callId: `${id}-call`,
    name: 'echo',
    arguments: JSON.stringify({ message: '夾具' }),
  });
  await coordinator.dispose();
}

await crash('crashed');
await crash('crashed-resumed');

const resumed = await store.resume('crashed-resumed');
const log = new SessionLog('crashed-resumed', { seed: resumed.events });
await new SessionPersistenceCoordinator({
  log,
  stored: resumed.stored,
  storedCount: resumed.events.length,
}).dispose();
console.log('寫了 crashed 與 crashed-resumed。');
