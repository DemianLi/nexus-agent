/**
 * 格式 8 的夾具觸發：用**那一版自己的** `SessionLog`、JSONL 後端與協調器寫一條帶 `compaction/summary` 的會話。那一版的這顆事件
 * 沒有 `summary`（摘要本文從 9 起才進日誌），今天推模型歷史時對它回 `summary-missing`。
 *
 * 那一版的 CLI 換不了摘要門檻（只有整份換掉的 `--plugins`），假模型那一輪碰不到摘要，所以由這支補寫。事件放在任何
 * `tool/result` 與 `turn/end` 之前：今天的推法逐顆判，排在前面的那一種先回，放後面就被別的理由蓋掉。
 *
 * 由 `scripts/session-format-fixtures/generate.ts` 複製進那個 tag 的 `apps/harness/src/` 再跑，**不在今天的樹裡編**。
 * 用法：tsx __session-format-trigger.ts <run 目錄>
 */

import { SESSION_LOG_FORMAT_VERSION, SessionLog, SessionPersistenceCoordinator } from '@nexus/core';
import { openJsonlSessionStore } from './jsonl-session-store.js';

const directory = process.argv[2];
if (directory === undefined) throw new Error('要給 run 目錄。');

const id = 'compacted';
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
log.append('turn/start', { kind: 'message', text: '幫我整理一下' });
log.append('model/start', {});
log.append('model/end', {});
log.append('compaction/summary', {
  cutoffIndex: 0,
  messagesBefore: 1,
  filePath: '/conversation_history/compacted.md',
});
log.append('turn/end', {});
await coordinator.dispose();
console.log('寫了 compacted。');
