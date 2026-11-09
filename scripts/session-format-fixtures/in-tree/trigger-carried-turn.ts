/**
 * 格式 28 以前的夾具觸發（[#1597](https://github.com/DemianLi/nexus-agent/issues/1597)）：用**那一版自己的** `SessionLog`、
 * JSONL 後端與協調器，寫被那一版續接過的會話。那時候續接只補一顆 `session/end-seed`，當掉的那一輪留著開，
 * end-seed **後面**的事件要靠今天的讀方把那一輪帶過去，才過得了讀盤的關係驗證。模型與工具事件的相對順序照同一版 CLI
 * 寫出來的那一輪（`model/start`、`assistant/message`、`model/end`、`tool/call`；CLI 在 `model/end` 後多記的
 * `context/measure` 不寫），寫到下面各條的停點就落盤收掉。
 *
 * - `crashed-in-model-resumed`：死在模型呼叫中途（`model/start` 沒有結尾），被同一版續接過一次就停了。
 * - `crashed-in-tool-resumed`：死在工具跑到一半（`tool/call` 沒有結果），被同一版續接過一次就停了。
 * - `resumed-new-turn`：死在工具跑到一半，被同一版續接，接著跑了新的一輪——新的 `turn/start` 落在還開著的那一輪後面。
 * - `paused-resumed`：停在核准點（`tool/call` → `interrupt/raised` → `turn/end`，呼叫沒配到結果、輪已收），被同一版續接過一次。
 *
 * 由 `scripts/session-format-fixtures/generate.ts` 複製進那個 tag 的 `apps/harness/src/` 再跑，**不在今天的樹裡編**。
 * 用法：tsx __session-format-trigger-carried-turn.ts <run 目錄>
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

/** 開一份新會話，`write` 往日誌裡記，記完落盤收掉。 */
async function written(id: string, write: (log: SessionLog) => void): Promise<void> {
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
  write(log);
  await coordinator.dispose();
}

/** 同一版的續接：帶 seed 開日誌，寫一顆 `session/end-seed`；`write` 再往後記，記完落盤收掉。 */
async function resumed(id: string, write: (log: SessionLog) => void = () => {}): Promise<void> {
  const stored = await store.resume(id);
  const log = new SessionLog(id, { seed: stored.events });
  const coordinator = new SessionPersistenceCoordinator({
    log,
    stored: stored.stored,
    storedCount: stored.events.length,
  });
  write(log);
  await coordinator.dispose();
}

/** 模型回一則要回聲一次的訊息，記下那顆 `tool/call`。 */
function callEcho(log: SessionLog, callId: string): void {
  log.append('model/start', {});
  log.append('assistant/message', {
    message: toLoggedMessage(
      new AIMessage({
        content: '先回聲一次。',
        tool_calls: [{ id: callId, name: 'echo', args: { message: '夾具' }, type: 'tool_call' }],
      }),
    ),
  });
  log.append('model/end', {});
  log.append('tool/call', {
    callId,
    name: 'echo',
    arguments: JSON.stringify({ message: '夾具' }),
  });
}

await written('crashed-in-model-resumed', (log) => {
  log.append('turn/start', { kind: 'message', text: '幫我回聲一次' });
  log.append('model/start', {});
});
await resumed('crashed-in-model-resumed');

await written('crashed-in-tool-resumed', (log) => {
  log.append('turn/start', { kind: 'message', text: '幫我回聲一次' });
  callEcho(log, 'crashed-in-tool-resumed-call');
});
await resumed('crashed-in-tool-resumed');

await written('resumed-new-turn', (log) => {
  log.append('turn/start', { kind: 'message', text: '幫我回聲一次' });
  callEcho(log, 'resumed-new-turn-call');
});
await resumed('resumed-new-turn', (log) => {
  log.append('turn/start', { kind: 'message', text: '再說一次' });
  log.append('model/start', {});
  log.append('assistant/message', {
    message: toLoggedMessage(new AIMessage({ content: '好。' })),
  });
  log.append('model/end', {});
  log.append('turn/end', {});
});

await written('paused-resumed', (log) => {
  log.append('turn/start', { kind: 'message', text: '幫我回聲一次' });
  callEcho(log, 'paused-resumed-call');
  log.append('interrupt/raised', { interruptId: 'paused-resumed-interrupt' });
  log.append('turn/end', {});
});
await resumed('paused-resumed');

console.log(
  '寫了 crashed-in-model-resumed、crashed-in-tool-resumed、resumed-new-turn 與 paused-resumed。',
);
