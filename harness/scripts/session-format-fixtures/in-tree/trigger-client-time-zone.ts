/**
 * 格式 49 起的夾具觸發：用**那一版自己的** `SessionLog`、JSONL 後端與協調器寫一條帶 `clientTimeZone` 的會話，一輪開頭那句
 * 記在 `turn/start`，輪中插話記在 `user/message` 的來源。`client_time_zone` 只有 `run.start` 帶得進來，CLI 一輪碰不到，
 * 所以由這支補寫。
 *
 * 由 `scripts/session-format-fixtures/generate.ts` 複製進那一版的 `apps/harness/src/` 再跑，**不在今天的樹裡編**。
 * 用法：tsx __session-format-trigger-client-time-zone.ts <run 目錄>
 */

import { SESSION_LOG_FORMAT_VERSION, SessionLog, SessionPersistenceCoordinator } from '@nexus/core';
import { openJsonlSessionStore } from './jsonl-session-store.js';

const directory = process.argv[2];
if (directory === undefined) throw new Error('要給 run 目錄。');

const id = 'client-time-zone';
const clientTimeZone = 'Asia/Taipei';
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
log.append('turn/start', { kind: 'message', text: '現在幾點', clientTimeZone });
log.append('model/start', {});
log.append('user/message', {
  message: {
    type: 'human',
    data: {
      content: '順便看一下明天',
      additional_kwargs: {},
      response_metadata: {},
      id: 'fixture-steer',
    },
  },
  source: { kind: 'user', clientTimeZone },
});
log.append('model/end', {});
log.append('turn/end', {});
await coordinator.dispose();
console.log('寫了 client-time-zone。');
